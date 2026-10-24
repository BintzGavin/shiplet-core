import type { Env } from "./env";
import {
  findWorkOSOrganizationMembership,
  listWorkOSOrganizationMembershipsPage,
} from "./workos";

/**
 * WorkOS owns organization membership. Shiplet keeps a local copy in
 * organization_memberships (and the teams built on it) so authorization never
 * waits on WorkOS. This module takes away local access that WorkOS no longer
 * backs: it drops memberships WorkOS removed or deactivated, together with the
 * person's teams in that organization, and demotes administrators WorkOS
 * demoted. It never adds memberships or promotes anyone; sign-in, invitations
 * and invite links do that.
 *
 * It runs at every sign-in and in the scheduled sweep below. It fails safe:
 * when any WorkOS read fails, or the person has no recorded WorkOS identity,
 * it changes nothing and the next sign-in or sweep tries again. A membership
 * is only removed after two reads agree that WorkOS has none: the person's
 * membership list leaves the organization out, and a lookup scoped to that
 * organization finds nothing either.
 *
 * Explicit per-Shiplet user grants are not workspace membership and are kept.
 * Organization and team grants stop applying on their own, because
 * authorization derives them from the membership rows removed here.
 */

/** People the scheduled sweep reconciles per run. */
export const MEMBERSHIP_SWEEP_BATCH_SIZE = 20;
/**
 * WorkOS requests one sweep run may make. It keeps the run well inside the
 * Workers Free limit of 50 external subrequests per invocation and far below
 * WorkOS rate limits.
 */
export const MEMBERSHIP_SWEEP_WORKOS_REQUEST_BUDGET = 40;
/** WorkOS requests one sign-in may spend on reconciliation. */
const SIGN_IN_WORKOS_REQUEST_BUDGET = 10;
/**
 * Time all of one sign-in's WorkOS reads may take together. Past it the
 * reconciliation gives up like on any other WorkOS failure, so a slow or hung
 * WorkOS never holds up sign-in.
 */
export const SIGN_IN_WORKOS_TIMEOUT_MS = 3_000;
/** Time all of one person's WorkOS reads may take during a sweep. */
export const SWEEP_WORKOS_TIMEOUT_MS = 10_000;
/**
 * Consecutive sweep runs that may stop on the same person's failing WorkOS
 * reads before the sweep passes over them, unchanged, until the next pass.
 */
export const MEMBERSHIP_SWEEP_MAX_CONSECUTIVE_FAILURES = 3;
/** Pages of 100 memberships read per WorkOS identity before giving up. */
const MAX_MEMBERSHIP_PAGES = 10;

const SWEEP_STATE_ID = "organization_memberships";
const ADMINISTRATOR_ROLE_SLUGS = new Set(["admin", "owner"]);

export type MembershipReconcileSource = "sign_in" | "sweep";

export type MembershipReconcileOutcome =
  | {
      status: "reconciled";
      removedOrganizationIds: string[];
      demotedOrganizationIds: string[];
    }
  | {
      status: "skipped";
      reason:
        | "no_local_memberships"
        | "no_workos_identity"
        | "workos_request_budget_exhausted"
        | "workos_read_failed";
      /** True when trying again soon may succeed (outage, rate limit, budget). */
      retryable: boolean;
      detail?: string;
    };

class WorkOSRequestBudgetExhausted extends Error {}

class WorkOSReadFailed extends Error {
  constructor(
    readonly detail: string,
    readonly retryable: boolean,
  ) {
    super(detail);
  }
}

type RequestBudget = { remaining: number };

type ReadLimits = { budget: RequestBudget; deadline: number };

function spend(budget: RequestBudget) {
  if (budget.remaining <= 0) throw new WorkOSRequestBudgetExhausted();
  budget.remaining -= 1;
}

function describeWorkOSError(error: unknown) {
  // WorkOS SDK errors, like thrown Responses, carry the HTTP status.
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status === "number") {
    return {
      detail: `http_${status}`,
      retryable: status === 408 || status === 429 || status >= 500,
    };
  }
  return { detail: "workos_error", retryable: true };
}

async function readWorkOS<T>(limits: ReadLimits, read: () => Promise<T>) {
  spend(limits.budget);
  const remaining = limits.deadline - Date.now();
  if (remaining <= 0) throw new WorkOSReadFailed("timeout", true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new WorkOSReadFailed("timeout", true)),
      remaining,
    );
  });
  try {
    return await Promise.race([read(), timedOut]);
  } catch (error) {
    if (error instanceof WorkOSReadFailed) throw error;
    const { detail, retryable } = describeWorkOSError(error);
    throw new WorkOSReadFailed(detail, retryable);
  } finally {
    clearTimeout(timer);
  }
}

function isAdministratorRole(role: string) {
  return ADMINISTRATOR_ROLE_SLUGS.has(role.trim().toLowerCase());
}

/**
 * Whether WorkOS makes the person an administrator of each organization they
 * belong to, across all their WorkOS identities: true or false, or null when
 * WorkOS reported no role.
 */
async function readWorkOSOrganizations(
  env: Env,
  workosUserIds: string[],
  limits: ReadLimits,
) {
  const organizations = new Map<string, boolean | null>();
  for (const workosUserId of workosUserIds) {
    let after: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_MEMBERSHIP_PAGES) {
        throw new WorkOSReadFailed("too_many_membership_pages", false);
      }
      const result = await readWorkOS(limits, () =>
        listWorkOSOrganizationMembershipsPage(env, {
          userId: workosUserId,
          after,
        }),
      );
      for (const membership of result.memberships) {
        if (membership.userId !== workosUserId) continue;
        if (membership.status !== "active" && membership.status !== "pending") {
          continue;
        }
        const administrator =
          membership.roleSlugs === null
            ? null
            : membership.roleSlugs.some(isAdministratorRole);
        const previous = organizations.get(membership.organizationId);
        organizations.set(
          membership.organizationId,
          previous === true || administrator === true
            ? true
            : previous === null || administrator === null
              ? null
              : false,
        );
      }
      if (!result.after) break;
      after = result.after;
    }
  }
  return organizations;
}

function logMembershipSync(
  level: "info" | "error",
  event: Record<string, unknown>,
) {
  const payload = JSON.stringify({ event: "workos.membership_sync", ...event });
  if (level === "error") console.error(payload);
  else console.info(payload);
}

/**
 * Brings the person's local organization memberships in line with WorkOS.
 * Never throws: a failure is logged and leaves every membership in place.
 */
export async function reconcileWorkOSMembershipsForUser(
  env: Env,
  userId: string,
  options: {
    source: MembershipReconcileSource;
    budget?: RequestBudget;
    /** Time all of this person's WorkOS reads may take together. */
    timeoutMs?: number;
  },
): Promise<MembershipReconcileOutcome> {
  const limits: ReadLimits = {
    budget: options.budget ?? { remaining: SIGN_IN_WORKOS_REQUEST_BUDGET },
    deadline: Date.now() + (options.timeoutMs ?? SIGN_IN_WORKOS_TIMEOUT_MS),
  };
  // Only rows recorded before the WorkOS reads may be removed or demoted, so
  // a membership a concurrent join records after the reads is left alone.
  const readStartedOn = new Date().toISOString();
  try {
    const local = await env.DB.prepare(
      `SELECT organization_id, role FROM organization_memberships
			 WHERE user_id = ?
			 ORDER BY organization_id`,
    )
      .bind(userId)
      .all<{ organization_id: string; role: string }>();
    const localMemberships = local.results || [];
    if (localMemberships.length === 0) {
      return {
        status: "skipped",
        reason: "no_local_memberships",
        retryable: false,
      };
    }

    const identities = await env.DB.prepare(
      `SELECT workos_user_id FROM workos_user_identities
			 WHERE user_id = ?
			 ORDER BY workos_user_id`,
    )
      .bind(userId)
      .all<{ workos_user_id: string }>();
    const workosUserIds = (identities.results || []).map(
      (identity) => identity.workos_user_id,
    );
    if (workosUserIds.length === 0) {
      // Without a WorkOS identity there is nobody to ask WorkOS about. The
      // person's next sign-in records one.
      return {
        status: "skipped",
        reason: "no_workos_identity",
        retryable: false,
      };
    }

    const workosOrganizations = await readWorkOSOrganizations(
      env,
      workosUserIds,
      limits,
    );

    const removedOrganizationIds: string[] = [];
    const demotedOrganizationIds: string[] = [];
    for (const membership of localMemberships) {
      const administrator = workosOrganizations.get(membership.organization_id);
      if (administrator === undefined) {
        // Confirm with a lookup scoped to the organization before removing,
        // so a truncated or blank list never removes anyone on its own.
        let confirmedAbsent = true;
        for (const workosUserId of workosUserIds) {
          const found = await readWorkOS(limits, () =>
            findWorkOSOrganizationMembership(env, {
              organizationId: membership.organization_id,
              userId: workosUserId,
            }),
          );
          if (found) {
            confirmedAbsent = false;
            break;
          }
        }
        if (confirmedAbsent) {
          removedOrganizationIds.push(membership.organization_id);
        } else {
          logMembershipSync("error", {
            outcome: "kept",
            reason: "workos_reads_disagree",
            source: options.source,
          });
        }
      } else if (administrator === false && isAdministratorRole(membership.role)) {
        demotedOrganizationIds.push(membership.organization_id);
      }
    }

    const statements: D1PreparedStatement[] = [];
    for (const organizationId of removedOrganizationIds) {
      statements.push(
        env.DB.prepare(
          `DELETE FROM team_memberships
					 WHERE user_id = ?
					   AND created_on <= ?
					   AND team_id IN (SELECT id FROM teams WHERE organization_id = ?)`,
        ).bind(userId, readStartedOn, organizationId),
        env.DB.prepare(
          `DELETE FROM organization_memberships
					 WHERE organization_id = ? AND user_id = ? AND created_on <= ?`,
        ).bind(organizationId, userId, readStartedOn),
      );
    }
    for (const organizationId of demotedOrganizationIds) {
      statements.push(
        env.DB.prepare(
          `UPDATE organization_memberships
					 SET role = 'member'
					 WHERE organization_id = ?
					   AND user_id = ?
					   AND created_on <= ?
					   AND lower(trim(role)) IN ('admin', 'owner')`,
        ).bind(organizationId, userId, readStartedOn),
      );
    }
    if (statements.length > 0) await env.DB.batch(statements);
    if (removedOrganizationIds.length > 0 || demotedOrganizationIds.length > 0) {
      logMembershipSync("info", {
        outcome: "reconciled",
        source: options.source,
        removed: removedOrganizationIds.length,
        demoted: demotedOrganizationIds.length,
      });
    }
    return {
      status: "reconciled",
      removedOrganizationIds,
      demotedOrganizationIds,
    };
  } catch (error) {
    if (error instanceof WorkOSRequestBudgetExhausted) {
      return {
        status: "skipped",
        reason: "workos_request_budget_exhausted",
        retryable: true,
      };
    }
    const detail =
      error instanceof WorkOSReadFailed ? error.detail : "internal_error";
    const retryable =
      error instanceof WorkOSReadFailed ? error.retryable : true;
    logMembershipSync("error", {
      outcome: "kept",
      reason: "workos_read_failed",
      detail,
      source: options.source,
    });
    return { status: "skipped", reason: "workos_read_failed", retryable, detail };
  }
}

export type MembershipSweepResult = {
  /** People whose reconciliation finished, successfully or not. */
  visited: number;
  /** True when this run reached the last person and the next run starts over. */
  passComplete: boolean;
  /** Why the run stopped before its batch was done, if it did. */
  stoppedReason: string | null;
  cursor: string;
};

/**
 * Reconciles the next batch of people with organization memberships and a
 * WorkOS identity, in user ID order, resuming after the last person the
 * previous run finished. The cursor lives in D1, so runs on any instance
 * share it, and running a batch twice changes nothing more. When WorkOS is
 * unavailable, rate limits, or the request budget runs out, the run stops and
 * the next one resumes with the same person. A person WorkOS refuses for good
 * (any other 4xx) is logged and passed over until the next pass, and so is a
 * person whose reads stopped MEMBERSHIP_SWEEP_MAX_CONSECUTIVE_FAILURES runs in
 * a row; either way nothing about them changes.
 */
export async function sweepWorkOSMemberships(
  env: Env,
  options: { limit?: number; workosRequestBudget?: number } = {},
): Promise<MembershipSweepResult | null> {
  if (env.SHIPLET_AUTH_MODE !== "test" && !env.WORKOS_API_KEY) return null;
  const limit = options.limit ?? MEMBERSHIP_SWEEP_BATCH_SIZE;
  const budget = {
    remaining:
      options.workosRequestBudget ?? MEMBERSHIP_SWEEP_WORKOS_REQUEST_BUDGET,
  };

  const state = await env.DB.prepare(
    `SELECT cursor_user_id, failing_user_id, failure_count
		 FROM workos_membership_sync_state WHERE id = ?`,
  )
    .bind(SWEEP_STATE_ID)
    .first<{
      cursor_user_id: string;
      failing_user_id: string | null;
      failure_count: number;
    }>();
  const startCursor = state?.cursor_user_id ?? "";
  const batch = await env.DB.prepare(
    `SELECT DISTINCT membership.user_id
		 FROM organization_memberships membership
		 WHERE membership.user_id > ?
		   AND EXISTS (
		     SELECT 1 FROM workos_user_identities identity
		     WHERE identity.user_id = membership.user_id
		   )
		 ORDER BY membership.user_id
		 LIMIT ?`,
  )
    .bind(startCursor, limit)
    .all<{ user_id: string }>();
  const userIds = (batch.results || []).map((row) => row.user_id);

  let cursor = startCursor;
  let visited = 0;
  let stoppedReason: string | null = null;
  let failingUserId = state?.failing_user_id ?? null;
  let failureCount = state?.failure_count ?? 0;
  for (const userId of userIds) {
    const outcome = await reconcileWorkOSMembershipsForUser(env, userId, {
      source: "sweep",
      budget,
      timeoutMs: SWEEP_WORKOS_TIMEOUT_MS,
    });
    // A person who needs more requests than a whole run allows would block
    // the sweep forever, so they are passed over instead of retried.
    if (
      outcome.status === "skipped" &&
      outcome.retryable &&
      !(outcome.reason === "workos_request_budget_exhausted" && visited === 0)
    ) {
      stoppedReason = outcome.detail ?? outcome.reason;
      if (outcome.reason === "workos_read_failed") {
        failureCount = failingUserId === userId ? failureCount + 1 : 1;
        failingUserId = userId;
        if (failureCount >= MEMBERSHIP_SWEEP_MAX_CONSECUTIVE_FAILURES) {
          // Pass over this person so everyone after them is still reached.
          logMembershipSync("error", {
            outcome: "passed_over",
            reason: "repeated_workos_read_failures",
            detail: stoppedReason,
            failures: failureCount,
            source: "sweep",
          });
          cursor = userId;
          failingUserId = null;
          failureCount = 0;
        }
      }
      break;
    }
    if (userId === failingUserId) {
      failingUserId = null;
      failureCount = 0;
    }
    cursor = userId;
    visited += 1;
  }
  const passComplete = stoppedReason === null && userIds.length < limit;
  if (passComplete) {
    cursor = "";
    failingUserId = null;
    failureCount = 0;
  }

  await env.DB.prepare(
    `INSERT INTO workos_membership_sync_state
		   (id, cursor_user_id, failing_user_id, failure_count, updated_on)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   cursor_user_id = excluded.cursor_user_id,
		   failing_user_id = excluded.failing_user_id,
		   failure_count = excluded.failure_count,
		   updated_on = excluded.updated_on`,
  )
    .bind(
      SWEEP_STATE_ID,
      cursor,
      failingUserId,
      failureCount,
      new Date().toISOString(),
    )
    .run();
  return { visited, passComplete, stoppedReason, cursor };
}
