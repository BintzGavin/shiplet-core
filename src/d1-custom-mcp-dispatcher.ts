import type { AuthorizedCapabilityInvocation } from "./capability-broker";
import type {
  CustomMcpCapabilityDispatcher,
  CustomMcpCapabilityDispatchOutcome,
} from "./custom-mcp";
import {
  resolveCustomMcpMutationEffectAuthority,
  type CustomMcpMutationEffectAuthority,
} from "./custom-mcp-approval";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_STATE_VALUE_BYTES = 32 * 1024;
const MAX_STATE_KEYS_PER_NAMESPACE = 128;
const MAX_STATE_BYTES_PER_NAMESPACE = 256 * 1024;
const REVIEW_STATUSES = new Set([
  "New",
  "In Progress",
  "Blocked",
  "Done",
  "Dropped",
]);
const CANONICAL_STATUS_CATEGORIES = new Set([
  "open",
  "in_progress",
  "blocked",
  "resolved",
  "closed",
  "informational",
  "unknown",
]);
const EVENT_KIND = /^[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9-]{0,63}$/;
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  "accesstoken",
  "authorization",
  "authorizationcode",
  "bearer",
  "claim",
  "claimurl",
  "cookie",
  "credential",
  "oauth",
  "oauthtoken",
  "password",
  "refreshtoken",
  "secret",
  "session",
  "token",
]);

type DispatcherInput = Parameters<
  CustomMcpCapabilityDispatcher["dispatch"]
>[0] & {
  /** Trusted-kernel adapter escape hatch; package code cannot call this dispatcher. */
  mutationAuthority?: CustomMcpMutationEffectAuthority;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) return null;
    output[key] = descriptor.value;
  }
  return output;
}

function reviewStatusCategory(status: string) {
  if (status === "New") return "open";
  if (status === "In Progress" || status === "Blocked") return "in_progress";
  if (status === "Done") return "resolved";
  return "closed";
}

async function sha256(value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `sha256:${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function expectedNamespace(authorized: AuthorizedCapabilityInvocation) {
  return `shiplet:${authorized.shipletId}:revision:${authorized.revisionId}`;
}

function boundedJson(value: unknown) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Invalid custom MCP dispatch value");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_RESULT_BYTES) {
    throw new TypeError("Custom MCP dispatch value is too large");
  }
  return serialized;
}

function normalizedPayloadKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeCanonicalCustomPayload(
  value: unknown,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(boundedJson(value));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const visit = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate !== "object") return true;
    if (Array.isArray(candidate)) return candidate.every(visit);
    if (!isRecord(candidate)) return false;
    return Object.entries(candidate).every(
      ([key, child]) =>
        key !== "__proto__" &&
        key !== "constructor" &&
        key !== "prototype" &&
        !FORBIDDEN_PAYLOAD_KEYS.has(normalizedPayloadKey(key)) &&
        visit(child),
    );
  };
  return visit(parsed) ? parsed : null;
}

function validMutationAuthority(
  authority: CustomMcpMutationEffectAuthority | null,
  authorized: AuthorizedCapabilityInvocation,
  now: number,
): authority is CustomMcpMutationEffectAuthority {
  return (
    authority !== null &&
    IDENTIFIER.test(authority.approvalRequestId) &&
    authority.shipletId === authorized.shipletId &&
    authority.revisionId === authorized.revisionId &&
    Number.isSafeInteger(authority.activationGeneration) &&
    authority.activationGeneration > 0 &&
    authority.actor.kind === authorized.actor.kind &&
    authority.actor.id === authorized.actor.id &&
    authority.action === authorized.action &&
    authority.resource === authorized.resource &&
    Number.isFinite(authority.expiresAt) &&
    authority.expiresAt > now &&
    Number.isFinite(authority.dispatchLeaseExpiresAt) &&
    authority.dispatchLeaseExpiresAt > now &&
    authority.state === "dispatching"
  );
}

const MUTATION_AUTHORITY_PREDICATE = `
	approval.id = ?
	AND approval.project_id = ?
	AND approval.revision_id = ?
	AND approval.activation_generation = ?
	AND approval.invoker_actor_kind = ?
	AND approval.invoker_actor_id = ?
	AND approval.capability = ?
	AND approval.resource = ?
	AND approval.status = 'dispatching'
	AND approval.expires_at_ms = ?
	AND approval.expires_at_ms > ?
	AND approval.revoked_at_ms IS NULL
	AND approval.dispatch_started_at_ms IS NOT NULL
	AND approval.dispatch_lease_expires_at_ms = ?
	AND approval.dispatch_lease_expires_at_ms > ?
	AND approval.approval_digest IS NOT NULL
	AND approval.grant_id IS NOT NULL
	AND project.id = approval.project_id
	AND project.archived_on IS NULL
	AND project.active_revision_id = approval.revision_id
	AND project.active_revision_generation = approval.activation_generation`;

async function mutationAuthorityBindings(input: {
  authority: CustomMcpMutationEffectAuthority;
  now: number;
}): Promise<unknown[]> {
  return [
    input.authority.approvalRequestId,
    input.authority.shipletId,
    input.authority.revisionId,
    input.authority.activationGeneration,
    input.authority.actor.kind,
    input.authority.actor.id,
    await sha256(input.authority.action),
    await sha256(input.authority.resource),
    input.authority.expiresAt,
    input.now,
    input.authority.dispatchLeaseExpiresAt,
    input.now,
  ];
}

export async function ensureD1CustomMcpDispatcherSchema(db: D1Database) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_mcp_state (
			 namespace TEXT NOT NULL,
			 state_key TEXT NOT NULL,
			 value_json TEXT NOT NULL,
			 updated_on TEXT NOT NULL,
			 PRIMARY KEY (namespace, state_key)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_mcp_capability_dispatches (
			 id TEXT PRIMARY KEY,
			 project_id TEXT NOT NULL,
			 revision_id TEXT NOT NULL,
			 actor_kind TEXT NOT NULL,
			 actor_id TEXT NOT NULL,
			 request_id TEXT NOT NULL,
			 invocation_id TEXT NOT NULL,
			 action TEXT NOT NULL,
			 resource TEXT NOT NULL,
			 state_namespace TEXT NOT NULL,
			 input_digest TEXT NOT NULL,
			 status TEXT NOT NULL CHECK (status IN (
				'pending','committed','aborted','reconciliation_required'
			 )),
			 result_json TEXT NOT NULL,
			 created_on TEXT NOT NULL,
			 completed_on TEXT,
			 UNIQUE (project_id, revision_id, request_id),
			 FOREIGN KEY (project_id) REFERENCES projects(id),
			 FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_mcp_state_mutation_receipts (
			 journal_id TEXT PRIMARY KEY,
			 project_id TEXT NOT NULL,
			 revision_id TEXT NOT NULL,
			 state_namespace TEXT NOT NULL,
			 state_key TEXT NOT NULL,
			 value_bytes INTEGER NOT NULL,
			 effect_changes INTEGER NOT NULL CHECK (effect_changes = 1),
			 committed_on TEXT NOT NULL,
			 FOREIGN KEY (journal_id)
			  REFERENCES shiplet_mcp_capability_dispatches(id),
			 FOREIGN KEY (project_id) REFERENCES projects(id),
			 FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_mcp_dispatch_binding_immutable
			 BEFORE UPDATE ON shiplet_mcp_capability_dispatches
			 WHEN OLD.status != 'pending'
			 OR NEW.id != OLD.id OR NEW.project_id != OLD.project_id
			 OR NEW.revision_id != OLD.revision_id
			 OR NEW.actor_kind != OLD.actor_kind OR NEW.actor_id != OLD.actor_id
			 OR NEW.request_id != OLD.request_id
			 OR NEW.invocation_id != OLD.invocation_id
			 OR NEW.action != OLD.action OR NEW.resource != OLD.resource
			 OR NEW.state_namespace != OLD.state_namespace
			 OR NEW.input_digest != OLD.input_digest
			 OR NEW.created_on != OLD.created_on
			 OR NEW.status NOT IN ('committed','aborted','reconciliation_required')
			 OR NEW.completed_on IS NULL
			 BEGIN SELECT RAISE(ABORT, 'custom MCP dispatch is immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_mcp_dispatch_no_delete
			 BEFORE DELETE ON shiplet_mcp_capability_dispatches
			 BEGIN SELECT RAISE(ABORT, 'custom MCP dispatch history is immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_mcp_state_receipt_no_update
			 BEFORE UPDATE ON shiplet_mcp_state_mutation_receipts
			 BEGIN SELECT RAISE(ABORT, 'custom MCP state receipt is immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_mcp_state_receipt_no_delete
			 BEFORE DELETE ON shiplet_mcp_state_mutation_receipts
			 BEGIN SELECT RAISE(ABORT, 'custom MCP state receipt is immutable'); END`,
    ),
  ]);
}

export function createD1CustomMcpCapabilityDispatcher(input: {
  db: D1Database;
  now: () => number;
  validateWorkflowEvent?: (input: {
    shipletId: string;
    revisionId: string;
    eventKind: string;
    summary: string;
    customPayload: Record<string, unknown>;
  }) => Promise<
    | {
        ok: true;
        canonicalStatusCategory: string;
        customPayload: Record<string, unknown>;
      }
    | { ok: false; code?: string }
  >;
}): CustomMcpCapabilityDispatcher {
  const currentTime = () => {
    const value = input.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Custom MCP dispatcher clock unavailable");
    }
    return value;
  };

  const finalize = async (
    journalId: string,
    status: "committed" | "aborted" | "reconciliation_required",
    value: unknown,
  ): Promise<CustomMcpCapabilityDispatchOutcome> => {
    const serialized = boundedJson(value);
    const completedOn = new Date(currentTime()).toISOString();
    const changed = await input.db
      .prepare(
        `UPDATE shiplet_mcp_capability_dispatches
				 SET status = ?, result_json = ?, completed_on = ?
				 WHERE id = ? AND status = 'pending'`,
      )
      .bind(status, serialized, completedOn, journalId)
      .run();
    if (changed.meta.changes !== 1) {
      return { status: "reconciliation_required", journalId };
    }
    if (status === "committed") return { status, journalId, value };
    return { status, journalId };
  };

  const dispatch = async (
    request: DispatcherInput,
  ): Promise<CustomMcpCapabilityDispatchOutcome> => {
    const authorized = request.authorized;
    const journalId = `mcp_dispatch_${crypto.randomUUID()}`;
    const now = currentTime();
    const namespace = expectedNamespace(authorized);
    let inputJson: string;
    try {
      inputJson = boundedJson(authorized.input);
    } catch {
      inputJson = "null";
    }
    if (
      !IDENTIFIER.test(authorized.shipletId) ||
      !IDENTIFIER.test(authorized.revisionId) ||
      !IDENTIFIER.test(authorized.actor.id) ||
      !IDENTIFIER.test(authorized.requestId) ||
      !IDENTIFIER.test(request.invocationId)
    ) {
      return { status: "aborted", journalId };
    }
    const scope = await input.db
      .prepare(
        `SELECT project.active_revision_generation AS activation_generation
				   FROM shiplet_revisions revision
				   JOIN projects project ON project.id = revision.project_id
				  WHERE revision.id = ? AND revision.project_id = ?
				    AND project.active_revision_id = revision.id
				    AND project.archived_on IS NULL
				    AND project.active_revision_generation > 0
				  LIMIT 1`,
      )
      .bind(authorized.revisionId, authorized.shipletId)
      .first<{ activation_generation: number }>();
    if (!scope) return { status: "aborted", journalId };
    await input.db
      .prepare(
        `INSERT INTO shiplet_mcp_capability_dispatches (
				 id, project_id, revision_id, actor_kind, actor_id, request_id,
				 invocation_id, action, resource, state_namespace, input_digest,
				 status, result_json, created_on, completed_on
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '{}', ?, NULL)`,
      )
      .bind(
        journalId,
        authorized.shipletId,
        authorized.revisionId,
        authorized.actor.kind,
        authorized.actor.id,
        authorized.requestId,
        request.invocationId,
        authorized.action,
        authorized.resource,
        request.stateNamespace,
        await sha256(inputJson),
        new Date(now).toISOString(),
      )
      .run();

    if (
      request.signal.aborted ||
      !Number.isSafeInteger(request.deadlineAt) ||
      now >= request.deadlineAt ||
      request.stateNamespace !== namespace
    ) {
      return finalize(journalId, "aborted", { code: "capability_denied" });
    }
    const payload = ownDataRecord(authorized.input);
    if (!payload) {
      return finalize(journalId, "aborted", { code: "invalid_input" });
    }

    if (
      authorized.action === "state.read:review" &&
      authorized.resource === "state:review"
    ) {
      if (!STATE_KEY.test(String(payload.key ?? ""))) {
        return finalize(journalId, "aborted", { code: "invalid_input" });
      }
      const key = String(payload.key);
      const row = await input.db
        .prepare(
          `SELECT project.id AS authorized_project_id, state.value_json
					   FROM projects project
					   LEFT JOIN shiplet_mcp_state state
					     ON state.namespace = ? AND state.state_key = ?
					  WHERE project.id = ?
					    AND project.archived_on IS NULL
					    AND project.active_revision_id = ?
					    AND project.active_revision_generation = ?
					  LIMIT 1`,
        )
        .bind(
          namespace,
          key,
          authorized.shipletId,
          authorized.revisionId,
          scope.activation_generation,
        )
        .first<{ authorized_project_id: string; value_json: string | null }>();
      if (row === null) {
        return finalize(journalId, "aborted", { code: "stale_revision" });
      }
      let value: unknown = null;
      if (row.value_json !== null) {
        try {
          value = JSON.parse(row.value_json);
        } catch {
          return finalize(journalId, "reconciliation_required", {
            code: "state_corrupt",
          });
        }
      }
      return finalize(journalId, "committed", { key, value });
    }

    if (
      authorized.action === "state.write" &&
      authorized.resource === "state:private"
    ) {
      const key = String(payload.key ?? "");
      if (payload.operation !== "set" || !STATE_KEY.test(key)) {
        return finalize(journalId, "aborted", { code: "invalid_input" });
      }
      let valueJson: string;
      try {
        valueJson = boundedJson(payload.value);
      } catch {
        return finalize(journalId, "aborted", {
          code: "state_value_too_large",
        });
      }
      const valueBytes = new TextEncoder().encode(valueJson).byteLength;
      if (valueBytes > MAX_STATE_VALUE_BYTES) {
        return finalize(journalId, "aborted", {
          code: "state_value_too_large",
        });
      }
      const mutationNow = currentTime();
      const authority =
        resolveCustomMcpMutationEffectAuthority(authorized.actor) ??
        request.mutationAuthority ??
        null;
      if (
        request.signal.aborted ||
        mutationNow >= request.deadlineAt ||
        !validMutationAuthority(authority, authorized, mutationNow)
      ) {
        return finalize(journalId, "aborted", { code: "capability_denied" });
      }
      const authorityBindings = await mutationAuthorityBindings({
        authority,
        now: mutationNow,
      });
      const completedOn = new Date(mutationNow).toISOString();
      const value = Object.freeze({
        operation: "set" as const,
        key,
        valueBytes,
      });
      try {
        const results = await input.db.batch([
          input.db
            .prepare(
              `INSERT INTO shiplet_mcp_state (
				 namespace, state_key, value_json, updated_on
				) SELECT ?, ?, ?, ?
				   FROM shiplet_custom_mcp_approvals approval
				   JOIN projects project ON project.id = approval.project_id
				  WHERE ${MUTATION_AUTHORITY_PREDICATE}
				    AND (
				      EXISTS (
				       SELECT 1 FROM shiplet_mcp_state
				        WHERE namespace = ? AND state_key = ?
				      )
				      OR (
				       SELECT COUNT(*) FROM shiplet_mcp_state WHERE namespace = ?
				      ) < ?
				    )
				    AND COALESCE((
				      SELECT SUM(CASE WHEN state_key = ? THEN 0
				                      ELSE LENGTH(CAST(value_json AS BLOB)) END)
				        FROM shiplet_mcp_state WHERE namespace = ?
				    ), 0) + ? <= ?
				  ON CONFLICT(namespace, state_key) DO UPDATE SET
				   value_json = excluded.value_json,
				   updated_on = excluded.updated_on`,
            )
            .bind(
              namespace,
              key,
              valueJson,
              completedOn,
              ...authorityBindings,
              namespace,
              key,
              namespace,
              MAX_STATE_KEYS_PER_NAMESPACE,
              key,
              namespace,
              valueBytes,
              MAX_STATE_BYTES_PER_NAMESPACE,
            ),
          input.db
            .prepare(
              `INSERT INTO shiplet_mcp_state_mutation_receipts (
				 journal_id, project_id, revision_id, state_namespace, state_key,
				 value_bytes, effect_changes, committed_on
				) VALUES (?, ?, ?, ?, ?, ?, changes(), ?)`,
            )
            .bind(
              journalId,
              authorized.shipletId,
              authorized.revisionId,
              namespace,
              key,
              valueBytes,
              completedOn,
            ),
          input.db
            .prepare(
              `UPDATE shiplet_mcp_capability_dispatches
				 SET status = 'committed', result_json = ?, completed_on = ?
				 WHERE id = ? AND status = 'pending'
				  AND EXISTS (
				   SELECT 1 FROM shiplet_mcp_state_mutation_receipts receipt
				    WHERE receipt.journal_id = shiplet_mcp_capability_dispatches.id
				     AND receipt.project_id = shiplet_mcp_capability_dispatches.project_id
				     AND receipt.revision_id = shiplet_mcp_capability_dispatches.revision_id
				     AND receipt.state_namespace = shiplet_mcp_capability_dispatches.state_namespace
				  )`,
            )
            .bind(boundedJson(value), completedOn, journalId),
        ]);
        if (
          results[0]?.meta.changes === 1 &&
          results[1]?.meta.changes === 1 &&
          results[2]?.meta.changes === 1
        ) {
          return { status: "committed", journalId, value };
        }
      } catch {
        return finalize(journalId, "aborted", { code: "state_quota_exceeded" });
      }
      return finalize(journalId, "aborted", {
        code: "state_quota_or_capability_denied",
      });
    }

    if (
      authorized.action === "workflow.event:create" &&
      authorized.resource === "workflow:events"
    ) {
      const mutationNow = currentTime();
      const authority =
        resolveCustomMcpMutationEffectAuthority(authorized.actor) ??
        request.mutationAuthority ??
        null;
      const eventKind = payload.eventKind;
      const summary =
        typeof payload.summary === "string" ? payload.summary.trim() : "";
      let category = payload.canonicalStatusCategory;
      let customPayload = safeCanonicalCustomPayload(payload.customPayload);
      if (
        request.signal.aborted ||
        mutationNow >= request.deadlineAt ||
        !validMutationAuthority(authority, authorized, mutationNow) ||
        typeof eventKind !== "string" ||
        !EVENT_KIND.test(eventKind) ||
        summary.length === 0 ||
        new TextEncoder().encode(summary).byteLength > 512 ||
        typeof category !== "string" ||
        !CANONICAL_STATUS_CATEGORIES.has(category) ||
        customPayload === null
      ) {
        return finalize(journalId, "aborted", { code: "invalid_event" });
      }
      if (input.validateWorkflowEvent) {
        const workflowValidation = await input.validateWorkflowEvent({
          shipletId: authorized.shipletId,
          revisionId: authorized.revisionId,
          eventKind,
          summary,
          customPayload,
        });
        if (!workflowValidation.ok) {
          return finalize(journalId, "aborted", {
            code: workflowValidation.code || "workflow_schema_denied",
          });
        }
        category = workflowValidation.canonicalStatusCategory;
        customPayload = workflowValidation.customPayload;
      }
      const legacyCategory =
        category === "blocked"
          ? "in_progress"
          : category === "informational"
            ? "unknown"
            : category;
      const completedOn = new Date(mutationNow).toISOString();
      const eventId = `event_${crypto.randomUUID().replaceAll("-", "")}`;
      const event = Object.freeze({
        eventId,
        shipletId: authorized.shipletId,
        revisionId: authorized.revisionId,
        actorKind: authorized.actor.kind,
        actorId: authorized.actor.id,
        eventKind,
        summary,
        canonicalStatusCategory: category,
        customPayload: Object.freeze(customPayload),
        occurredAt: completedOn,
        createdAt: completedOn,
      });
      const authorityBindings = await mutationAuthorityBindings({
        authority,
        now: mutationNow,
      });
      try {
        const results = await input.db.batch([
          input.db
            .prepare(
              `INSERT INTO shiplet_events (
							 id, project_id, revision_id, actor_kind, actor_id, event_kind,
							 summary, canonical_status_category, canonical_status_category_v2,
							 custom_payload_json,
							 occurred_at, created_at
							) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
							    FROM shiplet_custom_mcp_approvals approval
							    JOIN projects project ON project.id = approval.project_id
							   WHERE ${MUTATION_AUTHORITY_PREDICATE}`,
            )
            .bind(
              eventId,
              authorized.shipletId,
              authorized.revisionId,
              authorized.actor.kind,
              authorized.actor.id,
              eventKind,
              summary,
              legacyCategory,
              category,
              JSON.stringify(customPayload),
              completedOn,
              completedOn,
              ...authorityBindings,
            ),
          input.db
            .prepare(
              `UPDATE shiplet_mcp_capability_dispatches
							 SET status = 'committed', result_json = ?, completed_on = ?
							 WHERE id = ? AND status = 'pending' AND changes() = 1`,
            )
            .bind(boundedJson(event), completedOn, journalId),
        ]);
        if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1) {
          return { status: "committed", journalId, value: event };
        }
      } catch {
        return finalize(journalId, "aborted", {
          code: "write_aborted",
        });
      }
      return finalize(journalId, "aborted", { code: "capability_denied" });
    }

    if (
      authorized.action === "review.feedback.read" &&
      authorized.resource === "review:feedback"
    ) {
      if (payload.operation === "get") {
        const feedbackId = String(payload.feedbackId ?? "");
        if (!IDENTIFIER.test(feedbackId)) {
          return finalize(journalId, "aborted", { code: "invalid_input" });
        }
        const feedback = await input.db
          .prepare(
            `SELECT project.id AS authorized_project_id,
						 feedback.id, feedback.ticket_number, feedback.comment,
						 feedback.status, feedback.page_url,
						 feedback.created_on, feedback.updated_on
						   FROM projects project
						   LEFT JOIN review_feedback feedback
						     ON feedback.id = ? AND feedback.project_id = project.id
						  WHERE project.id = ?
						    AND project.archived_on IS NULL
						    AND project.active_revision_id = ?
						    AND project.active_revision_generation = ?
						  LIMIT 1`,
          )
          .bind(
            feedbackId,
            authorized.shipletId,
            authorized.revisionId,
            scope.activation_generation,
          )
          .first<Record<string, unknown>>();
        if (feedback === null) {
          return finalize(journalId, "aborted", { code: "stale_revision" });
        }
        return finalize(journalId, "committed", {
          feedback: feedback.id
            ? {
                id: feedback.id,
                ticketNumber: feedback.ticket_number,
                comment: feedback.comment,
                status: feedback.status,
                pageUrl: feedback.page_url,
                createdAt: feedback.created_on,
                updatedAt: feedback.updated_on,
              }
            : null,
        });
      }
      return finalize(journalId, "aborted", { code: "invalid_input" });
    }

    if (
      authorized.action === "review.feedback.write" &&
      authorized.resource === "review:feedback"
    ) {
      const feedbackId = String(payload.feedbackId ?? "");
      const status = String(payload.status ?? "");
      if (
        payload.operation !== "set_status" ||
        !IDENTIFIER.test(feedbackId) ||
        !REVIEW_STATUSES.has(status)
      ) {
        return finalize(journalId, "aborted", { code: "invalid_input" });
      }
      const mutationNow = currentTime();
      const authority =
        resolveCustomMcpMutationEffectAuthority(authorized.actor) ??
        request.mutationAuthority ??
        null;
      if (
        request.signal.aborted ||
        mutationNow >= request.deadlineAt ||
        !validMutationAuthority(authority, authorized, mutationNow)
      ) {
        return finalize(journalId, "aborted", { code: "capability_denied" });
      }
      const authorityBindings = await mutationAuthorityBindings({
        authority,
        now: mutationNow,
      });
      const completedOn = new Date(mutationNow).toISOString();
      const eventId = `event_${crypto.randomUUID().replaceAll("-", "")}`;
      const value = { feedbackId, status };
      try {
        const results = await input.db.batch([
          input.db
            .prepare(
              `UPDATE review_feedback SET status = ?, updated_on = ?
							 WHERE id = ? AND project_id = ?
							   AND EXISTS (
								SELECT 1 FROM shiplet_custom_mcp_approvals approval
								JOIN projects project ON project.id = approval.project_id
								WHERE ${MUTATION_AUTHORITY_PREDICATE}
							   )`,
            )
            .bind(
              status,
              completedOn,
              feedbackId,
              authorized.shipletId,
              ...authorityBindings,
            ),
          input.db
            .prepare(
              `INSERT INTO shiplet_events (
							 id, project_id, revision_id, actor_kind, actor_id, event_kind,
							 summary, canonical_status_category, custom_payload_json,
							 occurred_at, created_at
							) SELECT ?, ?, ?, ?, ?, 'review.status-changed',
							 'Review status changed', ?, ?, ?, ?
							    FROM shiplet_custom_mcp_approvals approval
							    JOIN projects project ON project.id = approval.project_id
							   WHERE changes() = 1 AND ${MUTATION_AUTHORITY_PREDICATE}`,
            )
            .bind(
              eventId,
              authorized.shipletId,
              authorized.revisionId,
              authorized.actor.kind,
              authorized.actor.id,
              reviewStatusCategory(status),
              JSON.stringify(value),
              completedOn,
              completedOn,
              ...authorityBindings,
            ),
          input.db
            .prepare(
              `UPDATE shiplet_mcp_capability_dispatches
							 SET status = 'committed', result_json = ?, completed_on = ?
							 WHERE id = ? AND status = 'pending' AND changes() = 1`,
            )
            .bind(boundedJson(value), completedOn, journalId),
        ]);
        if (
          results[0]?.meta.changes === 1 &&
          results[1]?.meta.changes === 1 &&
          results[2]?.meta.changes === 1
        ) {
          return { status: "committed", journalId, value };
        }
      } catch {
        return finalize(journalId, "aborted", {
          code: "write_aborted",
        });
      }
      return finalize(journalId, "aborted", {
        code: "feedback_not_found_or_capability_denied",
      });
    }

    if (authorized.action === "egress.fetch") {
      const allowed = request.egressPolicy.allowedResources.includes(
        authorized.resource,
      );
      return finalize(journalId, "aborted", {
        code: allowed ? "egress_unavailable" : "egress_denied",
      });
    }

    return finalize(journalId, "aborted", { code: "capability_denied" });
  };

  return Object.freeze({ dispatch });
}
