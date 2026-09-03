export type KernelApprovalAction = "revision.promote" | "revision.rollback";

export type KernelApprovalActor = Readonly<{
  kind: "agent" | "human";
  id: string;
}>;

export type KernelApprovalBinding = Readonly<{
  projectId: string;
  revisionId: string;
  action: KernelApprovalAction;
  resourceId: string;
  requestDigest: string;
  agentActorId: string;
  subjectUserId: string;
}>;

export type KernelApprovalRecord = KernelApprovalBinding &
  Readonly<{
    id: string;
    status: "pending" | "approved" | "denied" | "consumed" | "expired";
    createdAt: number;
    expiresAt: number;
    approvedAt: number | null;
    approvedByUserId: string | null;
    consumedAt: number | null;
  }>;

const APPROVAL_TTL_MS = 10 * 60_000;

function exactIdentifier(value: string, label: string, maxBytes = 512) {
  if (
    value.length < 1 ||
    value.length > maxBytes ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new Error(`invalid_${label}`);
  }
  return value;
}

function exactDigest(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid_request_digest");
  return value;
}

function parseRow(row: Record<string, unknown>): KernelApprovalRecord {
  return Object.freeze({
    id: String(row.id),
    projectId: String(row.project_id),
    revisionId: String(row.revision_id),
    action: String(row.action) as KernelApprovalAction,
    resourceId: String(row.resource_id),
    requestDigest: String(row.request_digest),
    agentActorId: String(row.agent_actor_id),
    subjectUserId: String(row.subject_user_id),
    status: String(row.status) as KernelApprovalRecord["status"],
    createdAt: Number(row.created_at_ms),
    expiresAt: Number(row.expires_at_ms),
    approvedAt:
      row.approved_at_ms === null ? null : Number(row.approved_at_ms),
    approvedByUserId:
      row.approved_by_user_id === null
        ? null
        : String(row.approved_by_user_id),
    consumedAt:
      row.consumed_at_ms === null ? null : Number(row.consumed_at_ms),
  });
}

async function ensureKernelApprovalSchema(db: D1Database) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_kernel_approvals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('revision.promote', 'revision.rollback')),
        resource_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        agent_actor_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
        created_at_ms REAL NOT NULL,
        expires_at_ms REAL NOT NULL,
        approved_at_ms REAL,
        approved_by_user_id TEXT,
        consumed_at_ms REAL,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
      )`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_shiplet_kernel_approvals_binding
       ON shiplet_kernel_approvals (
        project_id, action, agent_actor_id, subject_user_id, request_digest,
        created_at_ms DESC
       )`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_kernel_approvals_no_delete
       BEFORE DELETE ON shiplet_kernel_approvals
       BEGIN
        SELECT RAISE(ABORT, 'kernel approval history is immutable');
       END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_kernel_approvals_binding_immutable
       BEFORE UPDATE ON shiplet_kernel_approvals
       WHEN NEW.project_id != OLD.project_id
         OR NEW.revision_id != OLD.revision_id
         OR NEW.action != OLD.action
         OR NEW.resource_id != OLD.resource_id
         OR NEW.request_digest != OLD.request_digest
         OR NEW.agent_actor_id != OLD.agent_actor_id
         OR NEW.subject_user_id != OLD.subject_user_id
         OR NEW.created_at_ms != OLD.created_at_ms
         OR NEW.expires_at_ms != OLD.expires_at_ms
       BEGIN
        SELECT RAISE(ABORT, 'kernel approval binding is immutable');
       END`,
    ),
  ]);
}

function auditStatement(
  db: D1Database,
  input: {
    binding: KernelApprovalBinding;
    actor: KernelApprovalActor;
    eventKind: string;
    summary: string;
    statusCategory: string;
    approvalRequestId: string;
  },
) {
  const timestamp = new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO shiplet_audit_events (
        id, project_id, revision_id, deployment_id, actor_kind, actor_id,
        event_kind, summary, status_category, payload_json, occurred_on,
        recorded_on
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `audit_${crypto.randomUUID()}`,
      input.binding.projectId,
      input.binding.revisionId,
      input.actor.kind,
      input.actor.id,
      input.eventKind,
      input.summary,
      input.statusCategory,
      JSON.stringify({
        approvalRequestId: input.approvalRequestId,
        action: input.binding.action,
        resourceId: input.binding.resourceId,
        requestDigest: input.binding.requestDigest,
      }),
      timestamp,
      timestamp,
    );
}

export function createD1KernelApprovalService(input: {
  db: D1Database;
  now?: () => number;
}) {
  const now = input.now ?? (() => Date.now());

  async function get(id: string) {
    await ensureKernelApprovalSchema(input.db);
    const row = await input.db
      .prepare(`SELECT * FROM shiplet_kernel_approvals WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<Record<string, unknown>>();
    return row ? parseRow(row) : null;
  }

  async function expireIfNecessary(record: KernelApprovalRecord) {
    if (
      record.expiresAt > now() ||
      (record.status !== "pending" && record.status !== "approved")
    ) {
      return record;
    }
    await input.db
      .prepare(
        `UPDATE shiplet_kernel_approvals SET status = 'expired'
         WHERE id = ? AND status IN ('pending', 'approved') AND expires_at_ms <= ?`,
      )
      .bind(record.id, now())
      .run();
    return (await get(record.id))!;
  }

  return Object.freeze({
    async getOrBegin(binding: KernelApprovalBinding) {
      await ensureKernelApprovalSchema(input.db);
      exactIdentifier(binding.projectId, "project_id");
      exactIdentifier(binding.revisionId, "revision_id");
      exactIdentifier(binding.resourceId, "resource_id");
      exactIdentifier(binding.agentActorId, "agent_actor_id", 1_024);
      exactIdentifier(binding.subjectUserId, "subject_user_id");
      exactDigest(binding.requestDigest);

      const existing = await input.db
        .prepare(
          `SELECT * FROM shiplet_kernel_approvals
           WHERE project_id = ? AND action = ? AND agent_actor_id = ?
             AND subject_user_id = ? AND request_digest = ?
             AND status IN ('pending', 'approved') AND expires_at_ms > ?
           ORDER BY created_at_ms DESC LIMIT 1`,
        )
        .bind(
          binding.projectId,
          binding.action,
          binding.agentActorId,
          binding.subjectUserId,
          binding.requestDigest,
          now(),
        )
        .first<Record<string, unknown>>();
      if (existing) return parseRow(existing);

      const id = `mcp_kernel_approval_${crypto.randomUUID()}`;
      const createdAt = now();
      const expiresAt = createdAt + APPROVAL_TTL_MS;
      await input.db.batch([
        input.db
          .prepare(
            `INSERT INTO shiplet_kernel_approvals (
              id, project_id, revision_id, action, resource_id,
              request_digest, agent_actor_id, subject_user_id, status,
              created_at_ms, expires_at_ms, approved_at_ms,
              approved_by_user_id, consumed_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL)`,
          )
          .bind(
            id,
            binding.projectId,
            binding.revisionId,
            binding.action,
            binding.resourceId,
            binding.requestDigest,
            binding.agentActorId,
            binding.subjectUserId,
            createdAt,
            expiresAt,
          ),
        auditStatement(input.db, {
          binding,
          actor: { kind: "agent", id: binding.agentActorId },
          eventKind: "mcp.kernel_approval.requested",
          summary: "Delegated agent requested trusted approval",
          statusCategory: "open",
          approvalRequestId: id,
        }),
      ]);
      return (await get(id))!;
    },

    async read(id: string) {
      const record = await get(id);
      return record ? expireIfNecessary(record) : null;
    },

    async decide(args: {
      id: string;
      subjectUserId: string;
      decision: "approved" | "denied";
    }) {
      const record = await get(args.id);
      if (!record) return null;
      const current = await expireIfNecessary(record);
      if (
        current.status !== "pending" ||
        current.subjectUserId !== args.subjectUserId
      ) {
        return null;
      }
      const decidedAt = now();
      const result = await input.db
        .prepare(
          `UPDATE shiplet_kernel_approvals
           SET status = ?, approved_at_ms = ?, approved_by_user_id = ?
           WHERE id = ? AND status = 'pending' AND subject_user_id = ?
             AND expires_at_ms > ?`,
        )
        .bind(
          args.decision,
          decidedAt,
          args.subjectUserId,
          args.id,
          args.subjectUserId,
          decidedAt,
        )
        .run();
      if (result.meta.changes !== 1) return null;
      await auditStatement(input.db, {
        binding: current,
        actor: { kind: "human", id: args.subjectUserId },
        eventKind:
          args.decision === "approved"
            ? "mcp.kernel_approval.approved"
            : "mcp.kernel_approval.denied",
        summary:
          args.decision === "approved"
            ? "Trusted human approved delegated action"
            : "Trusted human denied delegated action",
        statusCategory: args.decision === "approved" ? "resolved" : "closed",
        approvalRequestId: args.id,
      }).run();
      return get(args.id);
    },

    async claim(binding: KernelApprovalBinding & { id: string }) {
      const record = await get(binding.id);
      if (!record) return null;
      const current = await expireIfNecessary(record);
      const exact =
        current.projectId === binding.projectId &&
        current.revisionId === binding.revisionId &&
        current.action === binding.action &&
        current.resourceId === binding.resourceId &&
        current.requestDigest === binding.requestDigest &&
        current.agentActorId === binding.agentActorId &&
        current.subjectUserId === binding.subjectUserId;
      if (!exact) return null;
      if (current.status === "consumed") {
        return Object.freeze({ record: current, replay: true });
      }
      if (current.status !== "approved" || current.expiresAt <= now()) {
        return null;
      }
      const consumedAt = now();
      const result = await input.db
        .prepare(
          `UPDATE shiplet_kernel_approvals
           SET status = 'consumed', consumed_at_ms = ?
           WHERE id = ? AND status = 'approved' AND expires_at_ms > ?`,
        )
        .bind(consumedAt, binding.id, consumedAt)
        .run();
      if (result.meta.changes !== 1) {
        const raced = await get(binding.id);
        return raced?.status === "consumed" && exact
          ? Object.freeze({ record: raced, replay: true })
          : null;
      }
      await auditStatement(input.db, {
        binding,
        actor: { kind: "agent", id: binding.agentActorId },
        eventKind: "mcp.kernel_approval.consumed",
        summary: "Delegated agent consumed trusted approval",
        statusCategory: "resolved",
        approvalRequestId: binding.id,
      }).run();
      return Object.freeze({ record: (await get(binding.id))!, replay: false });
    },
  });
}
