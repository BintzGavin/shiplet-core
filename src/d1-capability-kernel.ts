import type {
  AtomicCapabilityUse,
  AtomicCapabilityUseResult,
  CapabilityActor,
  CapabilityApproval,
  CapabilityAuditEvent,
  CapabilityEffect,
  CapabilityGrant,
  CapabilityGrantStore,
  TrustedApprovalBinding,
  TrustedApprovalVerifier,
} from "./capability-broker";

type GrantRow = {
  id: string;
  handle_digest: string;
  generation: number;
  project_id: string;
  revision_id: string;
  activation_revision_id: string | null;
  activation_generation: number | null;
  actor_kind: CapabilityActor["kind"];
  actor_id: string;
  action: string;
  resource: string;
  effect: CapabilityEffect;
  approval: CapabilityApproval;
  expires_at_ms: number;
  revoked_at_ms: number | null;
};

export interface D1CapabilityKernelOptions {
  db: D1Database;
  now: () => number;
}

export interface IssueCapabilityGrantInput {
  actor: CapabilityActor;
  shipletId: string;
  revisionId: string;
  action: string;
  resource: string;
  effect: CapabilityEffect;
  approval: CapabilityApproval;
  expiresAt: number;
  /**
   * Opt-in fence for authority that is valid only while this exact immutable
   * revision remains active at the observed activation generation.
   */
  activationFence?: {
    revisionId: string;
    generation: number;
  };
}

export interface IssuedCapabilityGrant {
  grantId: string;
  generation: number;
  opaqueHandle: string;
}

export interface IssueTrustedApprovalInput {
  binding: TrustedApprovalBinding;
  expiresAt: number;
}

export interface IssuedTrustedApproval {
  approvalId: string;
}

export interface AuthoritativeCapabilityGrantResolution {
  grant: CapabilityGrant;
  activationFence: { revisionId: string; generation: number };
}

export interface AtomicDispatchAuthorityResolution {
  authorized: true;
  activationFence: { revisionId: string; generation: number };
  grant: CapabilityGrant;
  approval: {
    digest: string;
    expiresAt: number;
    revokedAt: null;
  };
}

export interface D1CapabilityKernel
  extends CapabilityGrantStore, TrustedApprovalVerifier {
  issueGrant(input: IssueCapabilityGrantInput): Promise<IssuedCapabilityGrant>;
  issueTrustedApproval(
    input: IssueTrustedApprovalInput,
  ): Promise<IssuedTrustedApproval>;
  issueTrustedApprovalIdempotent(
    input: IssueTrustedApprovalInput & { idempotencyKey: string },
  ): Promise<IssuedTrustedApproval>;
  resolveGrantAuthority(input: {
    grantId: string;
    grantGeneration: number;
    expected: {
      actor: CapabilityActor;
      shipletId: string;
      revisionId: string;
      activationGeneration: number;
      action: string;
      resource: string;
    };
  }): Promise<AuthoritativeCapabilityGrantResolution | null>;
  resolveTrustedApprovalDigest(input: {
    approvalDigest: string;
    binding: TrustedApprovalBinding;
    idempotencyKey: string;
  }): Promise<{ active: true } | null>;
  resolveDispatchAuthorityAtomically(input: {
    now: number;
    actor: CapabilityActor;
    shipletId: string;
    revisionId: string;
    activationGeneration: number;
    grantId: string;
    grantGeneration: number;
    approvalDigest: string;
    binding: TrustedApprovalBinding;
    idempotencyKey: string;
  }): Promise<AtomicDispatchAuthorityResolution | null>;
  revokeTrustedApproval(input: {
    approvalDigest: string;
    idempotencyKey: string;
  }): Promise<{ ok: true } | { ok: false }>;
  compensateTrustedApproval(input: {
    approvalId: string;
    binding: TrustedApprovalBinding;
    idempotencyKey: string;
  }): Promise<{ ok: true } | { ok: false }>;
  reconcileTrustedApprovalIssuance(input: {
    idempotencyKey: string;
  }): Promise<{ status: "compensated" } | { status: "pending" }>;
  revokeGrant(input: {
    shipletId: string;
    grantId: string;
    expectedGeneration: number;
  }): Promise<boolean>;
  audit(event: CapabilityAuditEvent): Promise<void>;
}

const MAX_ID_BYTES = 256;
const MAX_ACTION_BYTES = 256;
const MAX_RESOURCE_BYTES = 1_024;
const MAX_AUDIT_PAYLOAD_BYTES = 8_192;

function isActor(value: unknown): value is CapabilityActor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actor = value as Partial<CapabilityActor>;
  return (
    (actor.kind === "human" ||
      actor.kind === "agent" ||
      actor.kind === "shiplet" ||
      actor.kind === "system") &&
    isBoundedString(actor.id, MAX_ID_BYTES)
  );
}

function isBoundedString(
  value: unknown,
  maximumBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

function assertClock(now: number): void {
  if (!Number.isFinite(now) || now < 0) {
    throw new TypeError("Capability kernel clock is unavailable");
  }
}

function assertExpiry(expiresAt: number, now: number): void {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new TypeError("Capability expiry must be finite and in the future");
  }
}

function randomOpaque(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}_${btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")}`;
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function bindingJson(binding: TrustedApprovalBinding): string {
  return JSON.stringify({
    requestId: binding.requestId,
    actor: { kind: binding.actor.kind, id: binding.actor.id },
    grantId: binding.grantId,
    grantGeneration: binding.grantGeneration,
    shipletId: binding.shipletId,
    revisionId: binding.revisionId,
    action: binding.action,
    resource: binding.resource,
    effect: binding.effect,
    approvalPolicy: binding.approvalPolicy,
    inputDigest: binding.inputDigest,
  });
}

function assertBinding(binding: TrustedApprovalBinding): void {
  if (
    !isBoundedString(binding.requestId, MAX_ID_BYTES) ||
    !isActor(binding.actor) ||
    !isBoundedString(binding.grantId, MAX_ID_BYTES) ||
    !Number.isSafeInteger(binding.grantGeneration) ||
    binding.grantGeneration <= 0 ||
    !isBoundedString(binding.shipletId, MAX_ID_BYTES) ||
    !isBoundedString(binding.revisionId, MAX_ID_BYTES) ||
    !isBoundedString(binding.action, MAX_ACTION_BYTES) ||
    !isBoundedString(binding.resource, MAX_RESOURCE_BYTES) ||
    (binding.effect !== "read" && binding.effect !== "mutation") ||
    binding.approvalPolicy !== "trusted-human" ||
    !/^sha256:[a-f0-9]{64}$/.test(binding.inputDigest)
  ) {
    throw new TypeError("Invalid trusted approval binding");
  }
}

function grantFromRow(row: GrantRow): CapabilityGrant {
  return Object.freeze({
    id: row.id,
    generation: row.generation,
    actor: Object.freeze({ kind: row.actor_kind, id: row.actor_id }),
    shipletId: row.project_id,
    revisionId: row.revision_id,
    action: row.action,
    resource: row.resource,
    effect: row.effect,
    approval: row.approval,
    expiresAt: row.expires_at_ms,
    revokedAt: row.revoked_at_ms,
  });
}

function useMatchesGrant(attempt: AtomicCapabilityUse, row: GrantRow): boolean {
  return (
    attempt.grantId === row.id &&
    attempt.grantGeneration === row.generation &&
    attempt.actor.kind === row.actor_kind &&
    attempt.actor.id === row.actor_id &&
    attempt.shipletId === row.project_id &&
    attempt.revisionId === row.revision_id &&
    attempt.action === row.action &&
    attempt.resource === row.resource &&
    attempt.effect === row.effect &&
    attempt.approvalPolicy === row.approval
  );
}

function bindingFromUse(attempt: AtomicCapabilityUse): TrustedApprovalBinding {
  return {
    requestId: attempt.requestId,
    actor: attempt.actor,
    grantId: attempt.grantId,
    grantGeneration: attempt.grantGeneration,
    shipletId: attempt.shipletId,
    revisionId: attempt.revisionId,
    action: attempt.action,
    resource: attempt.resource,
    effect: attempt.effect,
    approvalPolicy: "trusted-human",
    inputDigest: attempt.inputDigest,
  };
}

async function addCapabilityColumnIfMissing(
  db: D1Database,
  column: string,
  ddl: string,
): Promise<void> {
  const columns = await db
    .prepare("PRAGMA table_info(shiplet_broker_grants)")
    .all<{ name: string }>();
  if (!columns.results.some((candidate) => candidate.name === column)) {
    await db
      .prepare(`ALTER TABLE shiplet_broker_grants ADD COLUMN ${ddl}`)
      .run();
  }
}

export async function ensureCapabilityKernelSchema(
  db: D1Database,
): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_broker_grants (
				id TEXT PRIMARY KEY,
				handle_digest TEXT NOT NULL UNIQUE,
				generation INTEGER NOT NULL,
				project_id TEXT NOT NULL,
				revision_id TEXT NOT NULL,
				activation_revision_id TEXT,
				activation_generation INTEGER,
				actor_kind TEXT NOT NULL,
				actor_id TEXT NOT NULL,
				action TEXT NOT NULL,
				resource TEXT NOT NULL,
				effect TEXT NOT NULL,
				approval TEXT NOT NULL,
				expires_at_ms REAL NOT NULL,
				revoked_at_ms REAL,
				created_on TEXT NOT NULL,
				UNIQUE (project_id, id),
				FOREIGN KEY (project_id) REFERENCES projects(id),
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_broker_approvals (
				id TEXT PRIMARY KEY,
				approval_digest TEXT NOT NULL UNIQUE,
				binding_digest TEXT NOT NULL,
				project_id TEXT NOT NULL,
				revision_id TEXT NOT NULL,
				grant_id TEXT NOT NULL,
				grant_generation INTEGER NOT NULL,
				expires_at_ms REAL NOT NULL,
				revoked_at_ms REAL,
				issuance_idempotency_key TEXT,
				created_on TEXT NOT NULL,
				FOREIGN KEY (project_id, grant_id)
					REFERENCES shiplet_broker_grants(project_id, id),
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_broker_uses (
				project_id TEXT NOT NULL,
				revision_id TEXT NOT NULL,
				grant_id TEXT NOT NULL,
				grant_generation INTEGER NOT NULL,
				request_id TEXT NOT NULL,
				input_digest TEXT NOT NULL,
				approval_digest TEXT,
				used_at_ms REAL NOT NULL,
				PRIMARY KEY (project_id, grant_id, grant_generation, request_id),
				FOREIGN KEY (project_id, grant_id)
					REFERENCES shiplet_broker_grants(project_id, id),
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_shiplet_broker_grants_scope
			 ON shiplet_broker_grants(project_id, revision_id, revoked_at_ms)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_shiplet_broker_approvals_scope
			 ON shiplet_broker_approvals(project_id, grant_id, expires_at_ms)`,
    ),
  ]);
  await addCapabilityColumnIfMissing(
    db,
    "activation_revision_id",
    "activation_revision_id TEXT",
  );
  await addCapabilityColumnIfMissing(
    db,
    "activation_generation",
    "activation_generation INTEGER",
  );
  const approvalColumns = await db
    .prepare("PRAGMA table_info(shiplet_broker_approvals)")
    .all<{ name: string }>();
  if (
    !approvalColumns.results.some(
      (column) => column.name === "issuance_idempotency_key",
    )
  ) {
    await db
      .prepare(
        "ALTER TABLE shiplet_broker_approvals ADD COLUMN issuance_idempotency_key TEXT",
      )
      .run();
  }
  await db
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_shiplet_broker_approval_issuance
			 ON shiplet_broker_approvals(issuance_idempotency_key)
			 WHERE issuance_idempotency_key IS NOT NULL`,
    )
    .run();
  await db.batch([
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_broker_grant_scope_immutable
			 BEFORE UPDATE ON shiplet_broker_grants
			 WHEN OLD.id IS NOT NEW.id
				OR OLD.handle_digest IS NOT NEW.handle_digest
				OR OLD.generation IS NOT NEW.generation
				OR OLD.project_id IS NOT NEW.project_id
				OR OLD.revision_id IS NOT NEW.revision_id
				OR OLD.activation_revision_id IS NOT NEW.activation_revision_id
				OR OLD.activation_generation IS NOT NEW.activation_generation
				OR OLD.actor_kind IS NOT NEW.actor_kind
				OR OLD.actor_id IS NOT NEW.actor_id
				OR OLD.action IS NOT NEW.action
				OR OLD.resource IS NOT NEW.resource
				OR OLD.effect IS NOT NEW.effect
				OR OLD.approval IS NOT NEW.approval
				OR OLD.expires_at_ms IS NOT NEW.expires_at_ms
				OR OLD.created_on IS NOT NEW.created_on
				OR (
					OLD.revoked_at_ms IS NOT NEW.revoked_at_ms
					AND (OLD.revoked_at_ms IS NOT NULL OR NEW.revoked_at_ms IS NULL)
				)
			 BEGIN SELECT RAISE(ABORT, 'shiplet_broker_grant_immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_broker_grant_no_delete
			 BEFORE DELETE ON shiplet_broker_grants
			 BEGIN SELECT RAISE(ABORT, 'shiplet_broker_grant_immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_broker_approval_binding_immutable
			 BEFORE UPDATE ON shiplet_broker_approvals
			 WHEN OLD.id IS NOT NEW.id
				OR OLD.approval_digest IS NOT NEW.approval_digest
				OR OLD.binding_digest IS NOT NEW.binding_digest
				OR OLD.project_id IS NOT NEW.project_id
				OR OLD.revision_id IS NOT NEW.revision_id
				OR OLD.grant_id IS NOT NEW.grant_id
				OR OLD.grant_generation IS NOT NEW.grant_generation
				OR OLD.expires_at_ms IS NOT NEW.expires_at_ms
				OR OLD.issuance_idempotency_key IS NOT NEW.issuance_idempotency_key
				OR OLD.created_on IS NOT NEW.created_on
				OR (
					OLD.revoked_at_ms IS NOT NEW.revoked_at_ms
					AND (OLD.revoked_at_ms IS NOT NULL OR NEW.revoked_at_ms IS NULL)
				)
			 BEGIN SELECT RAISE(ABORT, 'shiplet_broker_approval_immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_broker_approval_no_delete
			 BEFORE DELETE ON shiplet_broker_approvals
			 BEGIN SELECT RAISE(ABORT, 'shiplet_broker_approval_immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_broker_use_no_update
			 BEFORE UPDATE ON shiplet_broker_uses
			 BEGIN SELECT RAISE(ABORT, 'shiplet_broker_use_immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_broker_use_no_delete
			 BEFORE DELETE ON shiplet_broker_uses
			 BEGIN SELECT RAISE(ABORT, 'shiplet_broker_use_immutable'); END`,
    ),
  ]);
}

export function createD1CapabilityKernel(
  options: D1CapabilityKernelOptions,
): D1CapabilityKernel {
  const { db } = options;

  const currentTime = (): number => {
    const value = options.now();
    assertClock(value);
    return value;
  };

  const resolveByHandle = async (
    opaqueHandle: string,
  ): Promise<GrantRow | null> => {
    if (!isBoundedString(opaqueHandle, MAX_ID_BYTES)) return null;
    return db
      .prepare("SELECT * FROM shiplet_broker_grants WHERE handle_digest = ?")
      .bind(await digest(opaqueHandle))
      .first<GrantRow>();
  };

  const issueApproval = async (
    input: IssueTrustedApprovalInput,
    idempotencyKey: string | null,
  ): Promise<IssuedTrustedApproval> => {
    const now = currentTime();
    assertExpiry(input.expiresAt, now);
    assertBinding(input.binding);
    if (
      idempotencyKey !== null &&
      (!isBoundedString(idempotencyKey, MAX_ID_BYTES) ||
        !idempotencyKey.startsWith("mcp-approval-issuance:"))
    ) {
      throw new TypeError("Invalid trusted approval idempotency key");
    }
    const approvalId = randomOpaque("approval");
    const approvalDigest = await digest(approvalId);
    const bindingDigest = await digest(bindingJson(input.binding));
    const id = `approval_record_${crypto.randomUUID()}`;
    const result = await db
      .prepare(
        `INSERT INTO shiplet_broker_approvals (
					id, approval_digest, binding_digest, project_id, revision_id,
					grant_id, grant_generation, expires_at_ms, revoked_at_ms,
					issuance_idempotency_key, created_on
				) SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
				 FROM shiplet_broker_grants
				 WHERE id = ? AND project_id = ? AND revision_id = ?
					AND generation = ? AND actor_kind = ? AND actor_id = ?
					AND action = ? AND resource = ? AND effect = ?
					AND approval = 'trusted-human' AND revoked_at_ms IS NULL
					AND expires_at_ms > ?`,
      )
      .bind(
        id,
        approvalDigest,
        bindingDigest,
        input.binding.shipletId,
        input.binding.revisionId,
        input.binding.grantId,
        input.binding.grantGeneration,
        input.expiresAt,
        idempotencyKey,
        new Date(now).toISOString(),
        input.binding.grantId,
        input.binding.shipletId,
        input.binding.revisionId,
        input.binding.grantGeneration,
        input.binding.actor.kind,
        input.binding.actor.id,
        input.binding.action,
        input.binding.resource,
        input.binding.effect,
        now,
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error("Trusted approval grant is unavailable");
    }
    return Object.freeze({ approvalId });
  };

  return Object.freeze({
    async issueGrant(
      input: IssueCapabilityGrantInput,
    ): Promise<IssuedCapabilityGrant> {
      const now = currentTime();
      assertExpiry(input.expiresAt, now);
      const activationRevisionId = input.activationFence?.revisionId ?? null;
      const activationGeneration = input.activationFence?.generation ?? null;
      if (
        !isActor(input.actor) ||
        !isBoundedString(input.shipletId, MAX_ID_BYTES) ||
        !isBoundedString(input.revisionId, MAX_ID_BYTES) ||
        !isBoundedString(input.action, MAX_ACTION_BYTES) ||
        !isBoundedString(input.resource, MAX_RESOURCE_BYTES) ||
        (input.effect !== "read" && input.effect !== "mutation") ||
        (input.approval !== "none" && input.approval !== "trusted-human") ||
        (input.effect === "mutation" && input.approval !== "trusted-human") ||
        (input.activationFence !== undefined &&
          (!isBoundedString(activationRevisionId, MAX_ID_BYTES) ||
            activationRevisionId !== input.revisionId ||
            !Number.isSafeInteger(activationGeneration) ||
            (activationGeneration as number) <= 0))
      ) {
        throw new TypeError("Invalid capability grant");
      }
      const grantId = `grant_${crypto.randomUUID()}`;
      const opaqueHandle = randomOpaque("cap");
      const result = await db
        .prepare(
          `INSERT INTO shiplet_broker_grants (
						id, handle_digest, generation, project_id, revision_id,
						activation_revision_id, activation_generation,
						actor_kind, actor_id, action, resource, effect, approval,
						expires_at_ms, revoked_at_ms, created_on
					) SELECT ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
					 FROM shiplet_revisions revision
					 JOIN projects project ON project.id = revision.project_id
					 WHERE revision.id = ? AND revision.project_id = ?
						AND (
							? IS NULL OR (
								project.active_revision_id = ?
								AND project.active_revision_generation = ?
							)
						)`,
        )
        .bind(
          grantId,
          await digest(opaqueHandle),
          input.shipletId,
          input.revisionId,
          activationRevisionId,
          activationGeneration,
          input.actor.kind,
          input.actor.id,
          input.action,
          input.resource,
          input.effect,
          input.approval,
          input.expiresAt,
          new Date(now).toISOString(),
          input.revisionId,
          input.shipletId,
          activationRevisionId,
          activationRevisionId,
          activationGeneration,
        )
        .run();
      if (result.meta.changes !== 1) {
        throw new Error("Capability grant scope does not exist");
      }
      return Object.freeze({ grantId, generation: 1, opaqueHandle });
    },

    async resolveOpaqueHandle(handle: string): Promise<CapabilityGrant | null> {
      const row = await resolveByHandle(handle);
      return row ? grantFromRow(row) : null;
    },

    async issueTrustedApproval(
      input: IssueTrustedApprovalInput,
    ): Promise<IssuedTrustedApproval> {
      return issueApproval(input, null);
    },

    async issueTrustedApprovalIdempotent(
      input: IssueTrustedApprovalInput & { idempotencyKey: string },
    ) {
      return issueApproval(input, input.idempotencyKey);
    },

    async resolveGrantAuthority(input: {
      grantId: string;
      grantGeneration: number;
      expected: {
        actor: CapabilityActor;
        shipletId: string;
        revisionId: string;
        activationGeneration: number;
        action: string;
        resource: string;
      };
    }) {
      let now: number;
      try {
        now = currentTime();
      } catch {
        return null;
      }
      if (
        !isBoundedString(input?.grantId, MAX_ID_BYTES) ||
        !Number.isSafeInteger(input.grantGeneration) ||
        input.grantGeneration <= 0 ||
        !isActor(input.expected?.actor) ||
        !isBoundedString(input.expected.shipletId, MAX_ID_BYTES) ||
        !isBoundedString(input.expected.revisionId, MAX_ID_BYTES) ||
        !Number.isSafeInteger(input.expected.activationGeneration) ||
        input.expected.activationGeneration <= 0 ||
        !isBoundedString(input.expected.action, MAX_ACTION_BYTES) ||
        !isBoundedString(input.expected.resource, MAX_RESOURCE_BYTES)
      ) {
        return null;
      }
      const row = await db
        .prepare(
          `SELECT grant.* FROM shiplet_broker_grants grant
					 JOIN projects project ON project.id = grant.project_id
					 WHERE grant.id = ? AND grant.generation = ?
					 AND grant.project_id = ? AND grant.revision_id = ?
					 AND grant.actor_kind = ? AND grant.actor_id = ?
					 AND grant.action = ? AND grant.resource = ?
					 AND grant.effect = 'mutation' AND grant.approval = 'trusted-human'
					 AND grant.activation_revision_id = grant.revision_id
					 AND grant.activation_generation = ?
					 AND project.active_revision_id = grant.activation_revision_id
					 AND project.active_revision_generation = grant.activation_generation
					 AND grant.revoked_at_ms IS NULL AND grant.expires_at_ms > ? LIMIT 1`,
        )
        .bind(
          input.grantId,
          input.grantGeneration,
          input.expected.shipletId,
          input.expected.revisionId,
          input.expected.actor.kind,
          input.expected.actor.id,
          input.expected.action,
          input.expected.resource,
          input.expected.activationGeneration,
          now,
        )
        .first<GrantRow>();
      return row
        ? Object.freeze({
            grant: grantFromRow(row),
            activationFence: Object.freeze({
              revisionId: row.activation_revision_id as string,
              generation: row.activation_generation as number,
            }),
          })
        : null;
    },

    async resolveTrustedApprovalDigest(input: {
      approvalDigest: string;
      binding: TrustedApprovalBinding;
      idempotencyKey: string;
    }) {
      let now: number;
      try {
        now = currentTime();
        assertBinding(input.binding);
      } catch {
        return null;
      }
      if (
        !/^sha256:[a-f0-9]{64}$/.test(input.approvalDigest) ||
        !isBoundedString(input.idempotencyKey, MAX_ID_BYTES)
      ) {
        return null;
      }
      const row = await db
        .prepare(
          `SELECT approval.id FROM shiplet_broker_approvals approval
					 JOIN shiplet_broker_grants grant ON grant.id = approval.grant_id
					 JOIN projects project ON project.id = grant.project_id
					 WHERE approval.approval_digest = ? AND approval.binding_digest = ?
					 AND approval.issuance_idempotency_key = ?
					 AND approval.project_id = ? AND approval.revision_id = ?
					 AND approval.grant_id = ? AND approval.grant_generation = ?
					 AND approval.revoked_at_ms IS NULL AND approval.expires_at_ms > ?
					 AND grant.revoked_at_ms IS NULL AND grant.expires_at_ms > ?
					 AND grant.activation_revision_id = grant.revision_id
					 AND project.active_revision_id = grant.activation_revision_id
					 AND project.active_revision_generation = grant.activation_generation
					 LIMIT 1`,
        )
        .bind(
          input.approvalDigest.slice("sha256:".length),
          await digest(bindingJson(input.binding)),
          input.idempotencyKey,
          input.binding.shipletId,
          input.binding.revisionId,
          input.binding.grantId,
          input.binding.grantGeneration,
          now,
          now,
        )
        .first<{ id: string }>();
      return row ? { active: true as const } : null;
    },

    async resolveDispatchAuthorityAtomically(input: {
      now: number;
      actor: CapabilityActor;
      shipletId: string;
      revisionId: string;
      activationGeneration: number;
      grantId: string;
      grantGeneration: number;
      approvalDigest: string;
      binding: TrustedApprovalBinding;
      idempotencyKey: string;
    }) {
      let now: number;
      try {
        now = currentTime();
        assertClock(input.now);
        assertBinding(input.binding);
      } catch {
        return null;
      }
      if (
        !isActor(input.actor) ||
        !isBoundedString(input.shipletId, MAX_ID_BYTES) ||
        !isBoundedString(input.revisionId, MAX_ID_BYTES) ||
        !Number.isSafeInteger(input.activationGeneration) ||
        input.activationGeneration <= 0 ||
        !isBoundedString(input.grantId, MAX_ID_BYTES) ||
        !Number.isSafeInteger(input.grantGeneration) ||
        input.grantGeneration <= 0 ||
        !/^sha256:[a-f0-9]{64}$/.test(input.approvalDigest) ||
        !isBoundedString(input.idempotencyKey, MAX_ID_BYTES) ||
        !input.idempotencyKey.startsWith("mcp-approval-issuance:") ||
        input.binding.actor.kind !== input.actor.kind ||
        input.binding.actor.id !== input.actor.id ||
        input.binding.shipletId !== input.shipletId ||
        input.binding.revisionId !== input.revisionId ||
        input.binding.grantId !== input.grantId ||
        input.binding.grantGeneration !== input.grantGeneration ||
        input.binding.effect !== "mutation" ||
        input.binding.approvalPolicy !== "trusted-human"
      ) {
        return null;
      }
      const row = await db
        .prepare(
          `SELECT grant.*,
					 approval.expires_at_ms AS approval_expires_at_ms
			 FROM shiplet_broker_approvals approval
			 JOIN shiplet_broker_grants grant ON grant.id = approval.grant_id
			 JOIN projects project ON project.id = grant.project_id
			 WHERE approval.approval_digest = ? AND approval.binding_digest = ?
			 AND approval.issuance_idempotency_key = ?
			 AND approval.project_id = ? AND approval.revision_id = ?
			 AND approval.grant_id = ? AND approval.grant_generation = ?
			 AND approval.revoked_at_ms IS NULL AND approval.expires_at_ms > ?
			 AND grant.id = ? AND grant.generation = ?
			 AND grant.project_id = ? AND grant.revision_id = ?
			 AND grant.actor_kind = ? AND grant.actor_id = ?
			 AND grant.action = ? AND grant.resource = ?
			 AND grant.effect = 'mutation' AND grant.approval = 'trusted-human'
			 AND grant.activation_revision_id = grant.revision_id
			 AND grant.activation_generation = ?
			 AND project.active_revision_id = grant.activation_revision_id
			 AND project.active_revision_generation = grant.activation_generation
			 AND grant.revoked_at_ms IS NULL AND grant.expires_at_ms > ?
			 LIMIT 1`,
        )
        .bind(
          input.approvalDigest.slice("sha256:".length),
          await digest(bindingJson(input.binding)),
          input.idempotencyKey,
          input.shipletId,
          input.revisionId,
          input.grantId,
          input.grantGeneration,
          now,
          input.grantId,
          input.grantGeneration,
          input.shipletId,
          input.revisionId,
          input.actor.kind,
          input.actor.id,
          input.binding.action,
          input.binding.resource,
          input.activationGeneration,
          now,
        )
        .first<GrantRow & { approval_expires_at_ms: number }>();
      if (!row) return null;
      return Object.freeze({
        authorized: true as const,
        activationFence: Object.freeze({
          revisionId: row.activation_revision_id as string,
          generation: row.activation_generation as number,
        }),
        grant: grantFromRow(row),
        approval: Object.freeze({
          digest: input.approvalDigest,
          expiresAt: row.approval_expires_at_ms,
          revokedAt: null,
        }),
      });
    },

    async revokeTrustedApproval(input: {
      approvalDigest: string;
      idempotencyKey: string;
    }) {
      let now: number;
      try {
        now = currentTime();
      } catch {
        return { ok: false as const };
      }
      if (
        !/^sha256:[a-f0-9]{64}$/.test(input.approvalDigest) ||
        !isBoundedString(input.idempotencyKey, MAX_ID_BYTES) ||
        !input.idempotencyKey.startsWith("mcp-approval-issuance:")
      ) {
        return { ok: false as const };
      }
      const approvalDigest = input.approvalDigest.slice("sha256:".length);
      const changed = await db
        .prepare(
          `UPDATE shiplet_broker_approvals SET revoked_at_ms = ?
			 WHERE approval_digest = ? AND issuance_idempotency_key = ?
			 AND revoked_at_ms IS NULL`,
        )
        .bind(now, approvalDigest, input.idempotencyKey)
        .run();
      if (changed.meta.changes === 1) return { ok: true as const };
      const existing = await db
        .prepare(
          `SELECT 1 AS found FROM shiplet_broker_approvals
			 WHERE approval_digest = ? AND issuance_idempotency_key = ?
			 AND revoked_at_ms IS NOT NULL`,
        )
        .bind(approvalDigest, input.idempotencyKey)
        .first<{ found: number }>();
      return existing ? { ok: true as const } : { ok: false as const };
    },

    async compensateTrustedApproval(input: {
      approvalId: string;
      binding: TrustedApprovalBinding;
      idempotencyKey: string;
    }) {
      let now: number;
      try {
        now = currentTime();
        assertBinding(input.binding);
      } catch {
        return { ok: false as const };
      }
      if (
        !isBoundedString(input.approvalId, MAX_ID_BYTES) ||
        !isBoundedString(input.idempotencyKey, MAX_ID_BYTES)
      ) {
        return { ok: false as const };
      }
      const approvalDigest = await digest(input.approvalId);
      const bindingDigest = await digest(bindingJson(input.binding));
      const changed = await db
        .prepare(
          `UPDATE shiplet_broker_approvals SET revoked_at_ms = ?
					 WHERE approval_digest = ? AND binding_digest = ?
					 AND issuance_idempotency_key = ? AND revoked_at_ms IS NULL`,
        )
        .bind(now, approvalDigest, bindingDigest, input.idempotencyKey)
        .run();
      if (changed.meta.changes === 1) return { ok: true as const };
      const existing = await db
        .prepare(
          `SELECT 1 AS found FROM shiplet_broker_approvals
					 WHERE approval_digest = ? AND binding_digest = ?
					 AND issuance_idempotency_key = ? AND revoked_at_ms IS NOT NULL`,
        )
        .bind(approvalDigest, bindingDigest, input.idempotencyKey)
        .first<{ found: number }>();
      return existing ? { ok: true as const } : { ok: false as const };
    },

    async reconcileTrustedApprovalIssuance(input: { idempotencyKey: string }) {
      let now: number;
      try {
        now = currentTime();
      } catch {
        return { status: "pending" as const };
      }
      if (!isBoundedString(input.idempotencyKey, MAX_ID_BYTES)) {
        return { status: "pending" as const };
      }
      await db
        .prepare(
          `UPDATE shiplet_broker_approvals SET revoked_at_ms = ?
					 WHERE issuance_idempotency_key = ? AND revoked_at_ms IS NULL`,
        )
        .bind(now, input.idempotencyKey)
        .run();
      const row = await db
        .prepare(
          `SELECT 1 AS found FROM shiplet_broker_approvals
					 WHERE issuance_idempotency_key = ? AND revoked_at_ms IS NOT NULL`,
        )
        .bind(input.idempotencyKey)
        .first<{ found: number }>();
      return row
        ? { status: "compensated" as const }
        : { status: "pending" as const };
    },

    async verifyTrustedApproval(
      approvalId: string,
      expectedBinding: TrustedApprovalBinding,
    ): Promise<boolean> {
      let now: number;
      try {
        now = currentTime();
        assertBinding(expectedBinding);
      } catch {
        return false;
      }
      if (!isBoundedString(approvalId, MAX_ID_BYTES)) return false;
      const row = await db
        .prepare(
          `SELECT id FROM shiplet_broker_approvals
					 WHERE approval_digest = ? AND binding_digest = ?
						AND project_id = ? AND revision_id = ? AND grant_id = ?
						AND grant_generation = ? AND revoked_at_ms IS NULL
						AND expires_at_ms > ?`,
        )
        .bind(
          await digest(approvalId),
          await digest(bindingJson(expectedBinding)),
          expectedBinding.shipletId,
          expectedBinding.revisionId,
          expectedBinding.grantId,
          expectedBinding.grantGeneration,
          now,
        )
        .first<{ id: string }>();
      return row !== null;
    },

    async revalidateAndClaim(
      attempt: AtomicCapabilityUse,
    ): Promise<AtomicCapabilityUseResult> {
      let now: number;
      try {
        now = currentTime();
      } catch {
        return { ok: false, reason: "expired" };
      }
      const row = await resolveByHandle(attempt.opaqueHandle);
      if (!row || row.id !== attempt.grantId) {
        return { ok: false, reason: "capability_not_found" };
      }
      if (!useMatchesGrant(attempt, row)) {
        return { ok: false, reason: "scope_mismatch" };
      }
      if (row.revoked_at_ms !== null) return { ok: false, reason: "revoked" };
      if (!Number.isFinite(row.expires_at_ms) || now >= row.expires_at_ms) {
        return { ok: false, reason: "expired" };
      }
      if (
        !isBoundedString(attempt.requestId, MAX_ID_BYTES) ||
        !/^sha256:[a-f0-9]{64}$/.test(attempt.inputDigest)
      ) {
        return { ok: false, reason: "scope_mismatch" };
      }
      let approvalDigest: string | null = null;
      let approvalBindingDigest: string | null = null;
      if (row.approval === "trusted-human") {
        if (!isBoundedString(attempt.approvalId, MAX_ID_BYTES)) {
          return { ok: false, reason: "scope_mismatch" };
        }
        const binding = bindingFromUse(attempt);
        try {
          assertBinding(binding);
        } catch {
          return { ok: false, reason: "scope_mismatch" };
        }
        approvalDigest = await digest(attempt.approvalId);
        approvalBindingDigest = await digest(bindingJson(binding));
      }

      const handleDigest = await digest(attempt.opaqueHandle);
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO shiplet_broker_uses (
						project_id, revision_id, grant_id, grant_generation, request_id,
						input_digest, approval_digest, used_at_ms
					) SELECT g.project_id, g.revision_id, g.id, g.generation, ?, ?, ?, ?
					 FROM shiplet_broker_grants g
					 JOIN projects p ON p.id = g.project_id
					 WHERE g.id = ? AND g.handle_digest = ? AND g.project_id = ?
						AND g.revision_id = ? AND g.generation = ?
						AND g.actor_kind = ? AND g.actor_id = ? AND g.action = ?
						AND g.resource = ? AND g.effect = ? AND g.approval = ?
						AND g.revoked_at_ms IS NULL AND g.expires_at_ms > ?
						AND (
							(g.activation_revision_id IS NULL
								AND g.activation_generation IS NULL)
							OR (
								g.activation_revision_id = g.revision_id
								AND p.active_revision_id = g.activation_revision_id
								AND p.active_revision_generation = g.activation_generation
							)
						)
						AND (
							g.approval = 'none' OR EXISTS (
								SELECT 1 FROM shiplet_broker_approvals a
								 WHERE a.approval_digest = ? AND a.binding_digest = ?
									AND a.project_id = g.project_id AND a.revision_id = g.revision_id
									AND a.grant_id = g.id AND a.grant_generation = g.generation
									AND a.revoked_at_ms IS NULL AND a.expires_at_ms > ?
							)
						)`,
        )
        .bind(
          attempt.requestId,
          attempt.inputDigest,
          approvalDigest,
          now,
          row.id,
          handleDigest,
          attempt.shipletId,
          attempt.revisionId,
          attempt.grantGeneration,
          attempt.actor.kind,
          attempt.actor.id,
          attempt.action,
          attempt.resource,
          attempt.effect,
          attempt.approvalPolicy,
          now,
          approvalDigest,
          approvalBindingDigest,
          now,
        )
        .run();
      if (result.meta.changes === 1) return { ok: true };

      const replay = await db
        .prepare(
          `SELECT 1 AS found FROM shiplet_broker_uses
					 WHERE project_id = ? AND grant_id = ? AND grant_generation = ?
						AND request_id = ?`,
        )
        .bind(
          attempt.shipletId,
          attempt.grantId,
          attempt.grantGeneration,
          attempt.requestId,
        )
        .first<{ found: number }>();
      if (replay) return { ok: false, reason: "replayed" };
      const current = await resolveByHandle(attempt.opaqueHandle);
      if (!current) return { ok: false, reason: "capability_not_found" };
      if (current.revoked_at_ms !== null)
        return { ok: false, reason: "revoked" };
      if (
        !Number.isFinite(current.expires_at_ms) ||
        now >= current.expires_at_ms
      ) {
        return { ok: false, reason: "expired" };
      }
      return { ok: false, reason: "scope_mismatch" };
    },

    async revokeGrant(input: {
      shipletId: string;
      grantId: string;
      expectedGeneration: number;
    }): Promise<boolean> {
      const now = currentTime();
      if (
        !isBoundedString(input.shipletId, MAX_ID_BYTES) ||
        !isBoundedString(input.grantId, MAX_ID_BYTES) ||
        !Number.isSafeInteger(input.expectedGeneration) ||
        input.expectedGeneration <= 0
      ) {
        return false;
      }
      const result = await db
        .prepare(
          `UPDATE shiplet_broker_grants SET revoked_at_ms = ?
					 WHERE id = ? AND project_id = ? AND generation = ?
						AND revoked_at_ms IS NULL`,
        )
        .bind(now, input.grantId, input.shipletId, input.expectedGeneration)
        .run();
      return result.meta.changes === 1;
    },

    async audit(event: CapabilityAuditEvent): Promise<void> {
      const now = currentTime();
      if (
        !isActor(event.actor) ||
        !isBoundedString(event.shipletId, MAX_ID_BYTES) ||
        !isBoundedString(event.revisionId, MAX_ID_BYTES) ||
        !isBoundedString(event.requestId, MAX_ID_BYTES) ||
        !isBoundedString(event.action, MAX_ACTION_BYTES) ||
        !isBoundedString(event.resource, MAX_RESOURCE_BYTES) ||
        !isBoundedString(event.correlationId, 1_024)
      ) {
        throw new TypeError("Invalid capability audit event");
      }
      const payload = JSON.stringify({
        phase: event.phase,
        correlationId: event.correlationId,
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.grantId ? { grantId: event.grantId } : {}),
        grantGeneration: event.grantGeneration,
        effect: event.effect,
        ...(event.inputDigest ? { inputDigest: event.inputDigest } : {}),
        ...(event.approvalPolicy
          ? { approvalPolicy: event.approvalPolicy, approvalPresent: true }
          : {}),
        requestId: event.requestId,
        action: event.action,
        resource: event.resource,
      });
      if (
        new TextEncoder().encode(payload).byteLength > MAX_AUDIT_PAYLOAD_BYTES
      ) {
        throw new TypeError("Capability audit payload exceeds its limit");
      }
      const result = await db
        .prepare(
          `INSERT INTO shiplet_audit_events (
						id, project_id, revision_id, deployment_id, actor_kind, actor_id,
						event_kind, summary, status_category, payload_json,
						occurred_on, recorded_on
					) SELECT ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?
					 WHERE EXISTS (
						SELECT 1 FROM shiplet_revisions
						 WHERE id = ? AND project_id = ?
					 )`,
        )
        .bind(
          `audit_${crypto.randomUUID()}`,
          event.shipletId,
          event.revisionId,
          event.actor.kind,
          event.actor.id,
          `capability.${event.phase}`,
          `Capability ${event.outcome}: ${event.action}`,
          event.outcome === "allowed"
            ? "approved"
            : event.outcome === "denied"
              ? "rejected"
              : "failed",
          payload,
          new Date(now).toISOString(),
          new Date(now).toISOString(),
          event.revisionId,
          event.shipletId,
        )
        .run();
      if (result.meta.changes !== 1) {
        throw new Error("Capability audit scope does not exist");
      }
    },
  });
}
