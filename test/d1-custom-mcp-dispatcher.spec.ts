import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { AuthorizedCapabilityInvocation } from "../src/capability-broker";
import {
  createD1CustomMcpCapabilityDispatcher,
  ensureD1CustomMcpDispatcherSchema,
} from "../src/d1-custom-mcp-dispatcher";
import app from "../src/index";

const NOW = 1_900_000_000_000;

type TestMutationAuthority = {
  approvalRequestId: string;
  shipletId: string;
  revisionId: string;
  activationGeneration: number;
  actor: AuthorizedCapabilityInvocation["actor"];
  action: string;
  resource: string;
  expiresAt: number;
  dispatchLeaseExpiresAt: number;
  state: "dispatching";
};

async function seedShiplet(label: string) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `user_${label}_${suffix}`;
  const organizationId = `org_${label}_${suffix}`;
  const shipletId = `project_${label}_${suffix}`;
  const revisionId = `revision_${label}_${suffix}`;
  const createdOn = new Date(NOW).toISOString();
  await (env as Env).DB.batch([
    (env as Env).DB.prepare(
      `INSERT INTO users (id, email, created_on, updated_on)
			 VALUES (?, ?, ?, ?)`,
    ).bind(userId, `${label}-${suffix}@example.invalid`, createdOn, createdOn),
    (env as Env).DB.prepare(
      `INSERT INTO organizations (id, name, created_by_user_id, created_on)
			 VALUES (?, ?, ?, ?)`,
    ).bind(organizationId, `Organization ${label}`, userId, createdOn),
    (env as Env).DB.prepare(
      `INSERT INTO projects (
			 id, organization_id, owner_user_id, name, subdomain, source_type,
			 script_content, visibility, created_on, modified_on
			) VALUES (?, ?, ?, ?, ?, 'static', '', 'private', ?, ?)`,
    ).bind(
      shipletId,
      organizationId,
      userId,
      `Shiplet ${label}`,
      `mcp-${label}-${suffix.slice(0, 12)}`,
      createdOn,
      createdOn,
    ),
    (env as Env).DB.prepare(
      `INSERT INTO shiplet_revisions (
			 id, project_id, parent_revision_id, package_json, package_digest,
			 content_digest, runtime_compatibility, validation_report_json,
			 created_by_actor_kind, created_by_actor_id, created_on
			) VALUES (?, ?, NULL, '{}', ?, ?, 'shiplet.runtime/v1', '{}',
			 'human', ?, ?)`,
    ).bind(
      revisionId,
      shipletId,
      `sha256:${"1".repeat(64)}`,
      `sha256:${"2".repeat(64)}`,
      userId,
      createdOn,
    ),
    (env as Env).DB.prepare(
      `INSERT INTO shiplet_revision_seals (revision_id, sealed_on) VALUES (?, ?)`,
    ).bind(revisionId, createdOn),
  ]);
  await (env as Env).DB.prepare(
    `UPDATE projects
		 SET active_revision_id = ?, active_revision_generation = 1
		 WHERE id = ?`,
  )
    .bind(revisionId, shipletId)
    .run();
  return {
    userId,
    organizationId,
    shipletId,
    revisionId,
    activationGeneration: 1,
    createdOn,
  };
}

async function digest(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `sha256:${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function authorization(input: {
  shipletId: string;
  revisionId: string;
  action: string;
  resource: string;
  payload: unknown;
}): AuthorizedCapabilityInvocation {
  return Object.freeze({
    actor: Object.freeze({ kind: "agent" as const, id: "agent_custom_mcp" }),
    shipletId: input.shipletId,
    revisionId: input.revisionId,
    action: input.action,
    resource: input.resource,
    requestId: `request_${crypto.randomUUID()}`,
    input: input.payload,
  });
}

function dispatchInput(
  authorized: AuthorizedCapabilityInvocation,
  overrides: Partial<{
    stateNamespace: string;
    allowedResources: readonly string[];
    deadlineAt: number;
    signal: AbortSignal;
    mutationAuthority: TestMutationAuthority;
  }> = {},
) {
  return {
    authorized,
    stateNamespace:
      overrides.stateNamespace ??
      `shiplet:${authorized.shipletId}:revision:${authorized.revisionId}`,
    egressPolicy: {
      allowedResources: overrides.allowedResources ?? [],
    },
    invocationId: `invocation_${crypto.randomUUID()}`,
    deadlineAt: overrides.deadlineAt ?? NOW + 1_000,
    signal: overrides.signal ?? new AbortController().signal,
    ...(overrides.mutationAuthority
      ? { mutationAuthority: overrides.mutationAuthority }
      : {}),
  };
}

async function approvedMutation(
  input: Parameters<typeof authorization>[0],
  rowOverrides: Partial<{
    status: "dispatching" | "revoked";
    expiresAt: number;
    revokedAt: number | null;
  }> = {},
): Promise<{
  authorized: AuthorizedCapabilityInvocation;
  mutationAuthority: TestMutationAuthority;
  approvalRequestId: string;
}> {
  const authorized = authorization(input);
  const approvalRequestId = `mcp_approval_${crypto.randomUUID()}`;
  const expiresAt = NOW + 30_000;
  const rowExpiresAt = rowOverrides.expiresAt ?? expiresAt;
  const rowStatus = rowOverrides.status ?? "dispatching";
  const revokedAt = rowOverrides.revokedAt ?? null;
  const dispatchLeaseExpiresAt = NOW + 5_000;
  const opaqueDigest = await digest(crypto.randomUUID());
  await (env as Env).DB.prepare(
    `INSERT INTO shiplet_custom_mcp_approvals (
		id, binding_digest, confirmation_nonce_digest, project_id, revision_id,
		activation_generation, actor_kind, actor_id,
		invoker_actor_kind, invoker_actor_id, tool_name,
		parent_request_id, child_request_id, tool_input_digest,
		declared_capabilities_digest, capability, resource,
		action_summary, change_summary, resource_summary, effect,
		review_target_json, review_input_json,
		capability_input_digest, grant_id, grant_generation,
		approval_digest, issuance_idempotency_key,
		expires_at_ms, status, confirmed_at_ms, claimed_at_ms,
		dispatch_started_at_ms, dispatch_lease_expires_at_ms, revoked_at_ms,
		created_at_ms
	) VALUES (
		?, ?, NULL, ?, ?, 1, 'human', 'user_dispatch_approver', ?, ?,
		'test.custom-mcp.mutation', 'test_parent', ?, ?, ?, ?, ?,
		'Test mutation', 'Test exact mutation', 'Test resource', 'mutation',
		?, ?, ?, 'grant_test', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
	)`,
  )
    .bind(
      approvalRequestId,
      opaqueDigest,
      input.shipletId,
      input.revisionId,
      authorized.actor.kind,
      authorized.actor.id,
      authorized.requestId,
      opaqueDigest,
      opaqueDigest,
      await digest(input.action),
      await digest(input.resource),
      JSON.stringify({ capability: input.action, resource: input.resource }),
      JSON.stringify(input.payload),
      opaqueDigest,
      opaqueDigest,
      `issuance_${crypto.randomUUID()}`,
      rowExpiresAt,
      rowStatus,
      NOW,
      NOW,
      NOW,
      dispatchLeaseExpiresAt,
      revokedAt,
      NOW,
    )
    .run();
  return {
    authorized,
    approvalRequestId,
    mutationAuthority: Object.freeze({
      approvalRequestId,
      shipletId: input.shipletId,
      revisionId: input.revisionId,
      activationGeneration: 1,
      actor: authorized.actor,
      action: input.action,
      resource: input.resource,
      expiresAt,
      dispatchLeaseExpiresAt,
      state: "dispatching",
    }),
  };
}

function databaseWithReadRace(input: {
  db: D1Database;
  matches(query: string): boolean;
  beforeRead(): Promise<void>;
}): D1Database {
  let fired = false;
  const wrapStatement = (
    statement: D1PreparedStatement,
    matched: boolean,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) =>
            wrapStatement(target.bind(...values), matched);
        }
        if (property === "first") {
          return async (...values: unknown[]) => {
            if (matched && !fired) {
              fired = true;
              await input.beforeRead();
            }
            return values.length === 0
              ? target.first()
              : target.first(String(values[0]));
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(input.db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) =>
          wrapStatement(target.prepare(query), input.matches(query));
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("D1 custom MCP capability dispatcher", () => {
  beforeAll(async () => {
    await app.fetch(new Request("http://localhost/health"), env as Env);
    await ensureD1CustomMcpDispatcherSchema((env as Env).DB);
  });

  it("Given revision-scoped state, When an exact read capability runs, Then only that namespace is returned", async () => {
    const own = await seedShiplet("state_a");
    const sibling = await seedShiplet("state_b");
    await (env as Env).DB.batch([
      (env as Env).DB.prepare(
        `INSERT INTO shiplet_mcp_state (namespace, state_key, value_json, updated_on)
				 VALUES (?, 'review-summary', ?, ?)`,
      ).bind(
        `shiplet:${own.shipletId}:revision:${own.revisionId}`,
        JSON.stringify({ open: 2 }),
        own.createdOn,
      ),
      (env as Env).DB.prepare(
        `INSERT INTO shiplet_mcp_state (namespace, state_key, value_json, updated_on)
				 VALUES (?, 'review-summary', ?, ?)`,
      ).bind(
        `shiplet:${sibling.shipletId}:revision:${sibling.revisionId}`,
        JSON.stringify({ private: true }),
        sibling.createdOn,
      ),
    ]);
    const dispatcher = createD1CustomMcpCapabilityDispatcher({
      db: (env as Env).DB,
      now: () => NOW,
    });
    const authorized = authorization({
      shipletId: own.shipletId,
      revisionId: own.revisionId,
      action: "state.read:review",
      resource: "state:review",
      payload: { key: "review-summary" },
    });

    await expect(
      dispatcher.dispatch(dispatchInput(authorized)),
    ).resolves.toMatchObject({
      status: "committed",
      journalId: expect.stringMatching(/^mcp_dispatch_/),
      value: { key: "review-summary", value: { open: 2 } },
    });
    await expect(
      dispatcher.dispatch(
        dispatchInput(
          authorization({
            shipletId: own.shipletId,
            revisionId: own.revisionId,
            action: "state.read:review",
            resource: "state:review",
            payload: { key: "review-summary" },
          }),
          {
            stateNamespace: `shiplet:${sibling.shipletId}:revision:${sibling.revisionId}`,
          },
        ),
      ),
    ).resolves.toMatchObject({ status: "aborted" });
  });

  it("Given an active revision is archived, When a capability reaches the effect boundary, Then no package read executes", async () => {
    const own = await seedShiplet("archived_effect");
    await (env as Env).DB.prepare(
      "UPDATE projects SET archived_on = ? WHERE id = ?",
    )
      .bind(new Date(NOW).toISOString(), own.shipletId)
      .run();
    const dispatcher = createD1CustomMcpCapabilityDispatcher({
      db: (env as Env).DB,
      now: () => NOW,
    });

    await expect(
      dispatcher.dispatch(
        dispatchInput(
          authorization({
            shipletId: own.shipletId,
            revisionId: own.revisionId,
            action: "state.read:review",
            resource: "state:review",
            payload: { key: "review-summary" },
          }),
        ),
      ),
    ).resolves.toMatchObject({ status: "aborted" });
  });

  it("Given exact trusted approval, When custom MCP writes private state, Then only the active revision namespace changes and the immutable journal commits", async () => {
    const own = await seedShiplet("state_write_a");
    const sibling = await seedShiplet("state_write_b");
    const dispatcher = createD1CustomMcpCapabilityDispatcher({
      db: (env as Env).DB,
      now: () => NOW,
    });
    const approved = await approvedMutation({
      shipletId: own.shipletId,
      revisionId: own.revisionId,
      action: "state.write",
      resource: "state:private",
      payload: {
        operation: "set",
        key: "application-preferences",
        value: { theme: "midnight", reviewerCount: 3 },
      },
    });

    await expect(
      dispatcher.dispatch(
        dispatchInput(approved.authorized, {
          mutationAuthority: approved.mutationAuthority,
        }),
      ),
    ).resolves.toMatchObject({
      status: "committed",
      value: {
        operation: "set",
        key: "application-preferences",
        valueBytes: expect.any(Number),
      },
    });

    const ownNamespace = `shiplet:${own.shipletId}:revision:${own.revisionId}`;
    const siblingNamespace = `shiplet:${sibling.shipletId}:revision:${sibling.revisionId}`;
    await expect(
      (env as Env).DB.prepare(
        `SELECT value_json FROM shiplet_mcp_state
         WHERE namespace = ? AND state_key = ?`,
      )
        .bind(ownNamespace, "application-preferences")
        .first<{ value_json: string }>(),
    ).resolves.toEqual({
      value_json: JSON.stringify({ theme: "midnight", reviewerCount: 3 }),
    });
    await expect(
      (env as Env).DB.prepare(
        `SELECT value_json FROM shiplet_mcp_state
         WHERE namespace = ? AND state_key = ?`,
      )
        .bind(siblingNamespace, "application-preferences")
        .first(),
    ).resolves.toBeNull();
    const journal = await (env as Env).DB.prepare(
      `SELECT status, action, resource, state_namespace
       FROM shiplet_mcp_capability_dispatches WHERE request_id = ?`,
    )
      .bind(approved.authorized.requestId)
      .first<Record<string, unknown>>();
    expect(journal).toMatchObject({
      status: "committed",
      action: "state.write",
      resource: "state:private",
      state_namespace: ownNamespace,
    });
    await expect(
      (env as Env).DB.prepare(
        `DELETE FROM shiplet_mcp_capability_dispatches WHERE request_id = ?`,
      )
        .bind(approved.authorized.requestId)
        .run(),
    ).rejects.toThrow(/immutable/i);
  });

  it("Given missing approval, a sibling namespace, or exhausted state quota, When state.write runs, Then every write fails closed without changing prior state", async () => {
    const own = await seedShiplet("state_write_denied_a");
    const sibling = await seedShiplet("state_write_denied_b");
    const namespace = `shiplet:${own.shipletId}:revision:${own.revisionId}`;
    const dispatcher = createD1CustomMcpCapabilityDispatcher({
      db: (env as Env).DB,
      now: () => NOW,
    });
    const unapproved = authorization({
      shipletId: own.shipletId,
      revisionId: own.revisionId,
      action: "state.write",
      resource: "state:private",
      payload: { operation: "set", key: "denied", value: true },
    });
    await expect(
      dispatcher.dispatch(dispatchInput(unapproved)),
    ).resolves.toMatchObject({ status: "aborted" });

    const siblingBound = await approvedMutation({
      shipletId: own.shipletId,
      revisionId: own.revisionId,
      action: "state.write",
      resource: "state:private",
      payload: { operation: "set", key: "sibling-probe", value: true },
    });
    await expect(
      dispatcher.dispatch(
        dispatchInput(siblingBound.authorized, {
          mutationAuthority: siblingBound.mutationAuthority,
          stateNamespace: `shiplet:${sibling.shipletId}:revision:${sibling.revisionId}`,
        }),
      ),
    ).resolves.toMatchObject({ status: "aborted" });

    const inserts: D1PreparedStatement[] = [];
    for (let index = 0; index < 128; index += 1) {
      inserts.push(
        (env as Env).DB.prepare(
          `INSERT INTO shiplet_mcp_state
           (namespace, state_key, value_json, updated_on)
           VALUES (?, ?, 'null', ?)`,
        ).bind(namespace, `quota-${index}`, own.createdOn),
      );
    }
    await (env as Env).DB.batch(inserts);
    const overQuota = await approvedMutation({
      shipletId: own.shipletId,
      revisionId: own.revisionId,
      action: "state.write",
      resource: "state:private",
      payload: { operation: "set", key: "quota-overflow", value: "blocked" },
    });
    await expect(
      dispatcher.dispatch(
        dispatchInput(overQuota.authorized, {
          mutationAuthority: overQuota.mutationAuthority,
        }),
      ),
    ).resolves.toMatchObject({ status: "aborted" });
    await expect(
      (env as Env).DB.prepare(
        `SELECT COUNT(*) AS count FROM shiplet_mcp_state WHERE namespace = ?`,
      )
        .bind(namespace)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 128 });
    await expect(
      (env as Env).DB.prepare(
        `SELECT COUNT(*) AS count FROM shiplet_mcp_state
         WHERE namespace = ? AND state_key IN ('denied','sibling-probe','quota-overflow')`,
      )
        .bind(namespace)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });

  it("Given generation-one read authority, When promotion wins after scope resolution but before each concrete D1 read, Then no stale state or feedback is returned", async () => {
    const own = await seedShiplet("read_generation_race");
    const namespace = `shiplet:${own.shipletId}:revision:${own.revisionId}`;
    const feedbackId = `review_${crypto.randomUUID()}`;
    await (env as Env).DB.batch([
      (env as Env).DB.prepare(
        `INSERT INTO shiplet_mcp_state (
			 namespace, state_key, value_json, updated_on
		 ) VALUES (?, 'race-value', ?, ?)`,
      ).bind(
        namespace,
        JSON.stringify({ note: "stale state must stay private" }),
        own.createdOn,
      ),
      (env as Env).DB.prepare(
        `INSERT INTO review_feedback (
			 id, project_id, organization_id, ticket_number, client_feedback_id,
			 comment, status, page_url, pathname, page_url_key, screenshot_mode,
			 source, created_on, updated_on
		 ) VALUES (?, ?, ?, 1, ?, 'stale feedback must stay private', 'New',
			 'https://example.invalid/review', '/review', 'example.invalid/review',
			 'page', 'api', ?, ?)`,
      ).bind(
        feedbackId,
        own.shipletId,
        own.organizationId,
        `client_${crypto.randomUUID()}`,
        own.createdOn,
        own.createdOn,
      ),
    ]);
    let statePromotionObserved = false;
    const stateDispatcher = createD1CustomMcpCapabilityDispatcher({
      db: databaseWithReadRace({
        db: (env as Env).DB,
        matches: (query) => query.includes("shiplet_mcp_state"),
        async beforeRead() {
          statePromotionObserved = true;
          await (env as Env).DB.prepare(
            `UPDATE projects SET active_revision_generation = 2 WHERE id = ?`,
          )
            .bind(own.shipletId)
            .run();
        },
      }),
      now: () => NOW,
    });
    const stateResult = await stateDispatcher.dispatch(
      dispatchInput(
        authorization({
          shipletId: own.shipletId,
          revisionId: own.revisionId,
          action: "state.read:review",
          resource: "state:review",
          payload: { key: "race-value" },
        }),
      ),
    );
    expect(statePromotionObserved).toBe(true);
    expect(stateResult).toMatchObject({ status: "aborted" });
    expect(JSON.stringify(stateResult)).not.toContain(
      "stale state must stay private",
    );

    await (env as Env).DB.prepare(
      `UPDATE projects SET active_revision_generation = 1 WHERE id = ?`,
    )
      .bind(own.shipletId)
      .run();
    let feedbackPromotionObserved = false;
    const feedbackDispatcher = createD1CustomMcpCapabilityDispatcher({
      db: databaseWithReadRace({
        db: (env as Env).DB,
        matches: (query) => query.includes("review_feedback"),
        async beforeRead() {
          feedbackPromotionObserved = true;
          await (env as Env).DB.prepare(
            `UPDATE projects SET active_revision_generation = 2 WHERE id = ?`,
          )
            .bind(own.shipletId)
            .run();
        },
      }),
      now: () => NOW,
    });
    const feedbackResult = await feedbackDispatcher.dispatch(
      dispatchInput(
        authorization({
          shipletId: own.shipletId,
          revisionId: own.revisionId,
          action: "review.feedback.read",
          resource: "review:feedback",
          payload: { operation: "get", feedbackId },
        }),
      ),
    );
    expect(feedbackPromotionObserved).toBe(true);
    expect(feedbackResult).toMatchObject({ status: "aborted" });
    expect(JSON.stringify(feedbackResult)).not.toContain(
      "stale feedback must stay private",
    );
  });

  it("Given a custom workflow event, When its mutation capability commits, Then the canonical envelope is immutable and agent-attributed", async () => {
    const own = await seedShiplet("workflow");
    const dispatcher = createD1CustomMcpCapabilityDispatcher({
      db: (env as Env).DB,
      now: () => NOW,
    });
    const approved = await approvedMutation({
      shipletId: own.shipletId,
      revisionId: own.revisionId,
      action: "workflow.event:create",
      resource: "workflow:events",
      payload: {
        eventKind: "custom.reviewed",
        summary: "Design review completed",
        canonicalStatusCategory: "resolved",
        customPayload: { rubric: "accessibility", score: 94 },
      },
    });

    const result = await dispatcher.dispatch(
      dispatchInput(approved.authorized, {
        mutationAuthority: approved.mutationAuthority,
      }),
    );
    expect(result).toMatchObject({
      status: "committed",
      value: {
        eventId: expect.stringMatching(/^event_/),
        shipletId: own.shipletId,
        revisionId: own.revisionId,
        actorKind: "agent",
        actorId: "agent_custom_mcp",
      },
    });
    const eventId = String(
      (result as { value: { eventId: string } }).value.eventId,
    );
    await expect(
      (env as Env).DB.prepare(
        "UPDATE shiplet_events SET summary = 'changed' WHERE id = ?",
      )
        .bind(eventId)
        .run(),
    ).rejects.toThrow(/immutable/i);
  });

  it("Given no exact still-dispatching approval, When a mutation reaches D1, Then zero business rows commit", async () => {
    const own = await seedShiplet("approval_required");
    const dispatcher = createD1CustomMcpCapabilityDispatcher({
      db: (env as Env).DB,
      now: () => NOW,
    });
    const authorized = authorization({
      shipletId: own.shipletId,
      revisionId: own.revisionId,
      action: "workflow.event:create",
      resource: "workflow:events",
      payload: {
        eventKind: "custom.reviewed",
        summary: "Must require an exact approval",
        canonicalStatusCategory: "resolved",
        customPayload: {},
      },
    });

    await expect(
      dispatcher.dispatch(dispatchInput(authorized)),
    ).resolves.toMatchObject({ status: "aborted" });
    await expect(
      (env as Env).DB.prepare(
        `SELECT COUNT(*) AS count FROM shiplet_events
		 WHERE project_id = ? AND summary = ?`,
      )
        .bind(own.shipletId, "Must require an exact approval")
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });

  it("Given stale, expired, revoked, or non-dispatching approval state, When D1 predicates the mutation, Then every business insert affects zero rows", async () => {
    for (const scenario of [
      { label: "expired", overrides: { expiresAt: NOW - 1 } },
      { label: "revoked", overrides: { revokedAt: NOW } },
      {
        label: "not_dispatching",
        overrides: { status: "revoked" as const, revokedAt: NOW },
      },
      { label: "stale_activation", overrides: {} },
    ]) {
      const own = await seedShiplet(`authority_${scenario.label}`);
      const approved = await approvedMutation(
        {
          shipletId: own.shipletId,
          revisionId: own.revisionId,
          action: "workflow.event:create",
          resource: "workflow:events",
          payload: {
            eventKind: "custom.reviewed",
            summary: `Must reject ${scenario.label} authority`,
            canonicalStatusCategory: "resolved",
            customPayload: {},
          },
        },
        scenario.overrides,
      );
      if (scenario.label === "stale_activation") {
        await (env as Env).DB.prepare(
          `UPDATE projects SET active_revision_generation = 2 WHERE id = ?`,
        )
          .bind(own.shipletId)
          .run();
      }
      const dispatcher = createD1CustomMcpCapabilityDispatcher({
        db: (env as Env).DB,
        now: () => NOW,
      });

      await expect(
        dispatcher.dispatch(
          dispatchInput(approved.authorized, {
            mutationAuthority: approved.mutationAuthority,
          }),
        ),
      ).resolves.toMatchObject({ status: "aborted" });
      await expect(
        (env as Env).DB.prepare(
          `SELECT COUNT(*) AS count FROM shiplet_events
			 WHERE project_id = ? AND summary = ?`,
        )
          .bind(own.shipletId, `Must reject ${scenario.label} authority`)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
    }
  });

  it("Given sibling feedback, When read or write capabilities guess its ID, Then both fail closed while own feedback remains usable", async () => {
    const own = await seedShiplet("feedback_a");
    const sibling = await seedShiplet("feedback_b");
    const ownFeedbackId = `review_${crypto.randomUUID()}`;
    const siblingFeedbackId = `review_${crypto.randomUUID()}`;
    const insert = (scope: typeof own, id: string, ticket: number) =>
      (env as Env).DB.prepare(
        `INSERT INTO review_feedback (
				 id, project_id, organization_id, ticket_number, client_feedback_id,
				 comment, status, page_url, pathname, page_url_key, screenshot_mode,
				 source, created_on, updated_on
				) VALUES (?, ?, ?, ?, ?, 'Check the empty state', 'New',
				 'https://example.invalid/review', '/review', 'example.invalid/review',
				 'page', 'api', ?, ?)`,
      ).bind(
        id,
        scope.shipletId,
        scope.organizationId,
        ticket,
        `client_${crypto.randomUUID()}`,
        scope.createdOn,
        scope.createdOn,
      );
    await (env as Env).DB.batch([
      insert(own, ownFeedbackId, 1),
      insert(sibling, siblingFeedbackId, 1),
    ]);
    const dispatcher = createD1CustomMcpCapabilityDispatcher({
      db: (env as Env).DB,
      now: () => NOW,
    });

    const read = await dispatcher.dispatch(
      dispatchInput(
        authorization({
          shipletId: own.shipletId,
          revisionId: own.revisionId,
          action: "review.feedback.read",
          resource: "review:feedback",
          payload: { operation: "get", feedbackId: siblingFeedbackId },
        }),
      ),
    );
    expect(read).toMatchObject({
      status: "committed",
      value: { feedback: null },
    });

    const deniedApproval = await approvedMutation({
      shipletId: own.shipletId,
      revisionId: own.revisionId,
      action: "review.feedback.write",
      resource: "review:feedback",
      payload: {
        operation: "set_status",
        feedbackId: siblingFeedbackId,
        status: "Done",
      },
    });
    const deniedWrite = await dispatcher.dispatch(
      dispatchInput(deniedApproval.authorized, {
        mutationAuthority: deniedApproval.mutationAuthority,
      }),
    );
    expect(deniedWrite).toMatchObject({ status: "aborted" });

    const ownApproval = await approvedMutation({
      shipletId: own.shipletId,
      revisionId: own.revisionId,
      action: "review.feedback.write",
      resource: "review:feedback",
      payload: {
        operation: "set_status",
        feedbackId: ownFeedbackId,
        status: "Done",
      },
    });
    const write = await dispatcher.dispatch(
      dispatchInput(ownApproval.authorized, {
        mutationAuthority: ownApproval.mutationAuthority,
      }),
    );
    expect(write).toMatchObject({
      status: "committed",
      value: { feedbackId: ownFeedbackId, status: "Done" },
    });
    const stored = await (env as Env).DB.prepare(
      "SELECT status FROM review_feedback WHERE id = ? AND project_id = ?",
    )
      .bind(ownFeedbackId, own.shipletId)
      .first<{ status: string }>();
    expect(stored?.status).toBe("Done");
    const event = await (env as Env).DB.prepare(
      `SELECT actor_kind, actor_id, revision_id FROM shiplet_events
			 WHERE project_id = ? AND event_kind = 'review.status-changed'
			 ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(own.shipletId)
      .first<Record<string, unknown>>();
    expect(event).toMatchObject({
      actor_kind: "agent",
      actor_id: "agent_custom_mcp",
      revision_id: own.revisionId,
    });
  });

  it("Given denied egress, wrong resources, expiry, or cancellation, When dispatch runs, Then no effect commits and a bounded journal remains", async () => {
    const own = await seedShiplet("denials");
    const dispatcher = createD1CustomMcpCapabilityDispatcher({
      db: (env as Env).DB,
      now: () => NOW,
    });
    const egress = authorization({
      shipletId: own.shipletId,
      revisionId: own.revisionId,
      action: "egress.fetch",
      resource: "https://example.invalid/resource",
      payload: { method: "GET" },
    });
    await expect(
      dispatcher.dispatch(dispatchInput(egress)),
    ).resolves.toMatchObject({
      status: "aborted",
    });
    const wrongResource = authorization({
      shipletId: own.shipletId,
      revisionId: own.revisionId,
      action: "state.read:review",
      resource: "state:another-shiplet",
      payload: { key: "anything" },
    });
    await expect(
      dispatcher.dispatch(dispatchInput(wrongResource)),
    ).resolves.toMatchObject({ status: "aborted" });
    await expect(
      dispatcher.dispatch(
        dispatchInput(
          authorization({
            shipletId: own.shipletId,
            revisionId: own.revisionId,
            action: "state.read:review",
            resource: "state:another-shiplet",
            payload: { key: "anything" },
          }),
          { deadlineAt: NOW },
        ),
      ),
    ).resolves.toMatchObject({ status: "aborted" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      dispatcher.dispatch(
        dispatchInput(
          authorization({
            shipletId: own.shipletId,
            revisionId: own.revisionId,
            action: "state.read:review",
            resource: "state:another-shiplet",
            payload: { key: "anything" },
          }),
          { signal: controller.signal },
        ),
      ),
    ).resolves.toMatchObject({ status: "aborted" });
    const rows = await (env as Env).DB.prepare(
      `SELECT status, LENGTH(result_json) AS result_bytes
			 FROM shiplet_mcp_capability_dispatches WHERE project_id = ?`,
    )
      .bind(own.shipletId)
      .all<{ status: string; result_bytes: number }>();
    expect(rows.results).toHaveLength(4);
    expect(rows.results.every((row) => row.status === "aborted")).toBe(true);
    expect(rows.results.every((row) => row.result_bytes < 1024)).toBe(true);
  });
});
