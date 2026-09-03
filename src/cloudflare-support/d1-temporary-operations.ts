const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SCRIPT_IDENTIFIER =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RAW_DIGEST = /^[a-f0-9]{64}$/;
const MAX_AMBIGUITY_FENCE_MS = 60 * 60 * 1_000;

export type D1TemporaryProviderOperationState =
  | "reserved"
  | "provisioning"
  | "account_ready"
  | "deploying"
  | "active"
  | "cleanup_pending"
  | "cleaned"
  | "ambiguity_expired";

export type D1TemporaryProviderOperationBinding = {
  operationId: string;
  operationKind: "temporary.deployment.create";
  userId: string;
  shipletId: string;
  targetId: string;
  revisionId: string;
  packageDigest: string;
  scriptName: string;
  requestDigest: string;
};

type TemporaryProviderOperationRow = {
  operation_id: string;
  operation_kind: "temporary.deployment.create";
  user_id: string;
  shiplet_id: string;
  target_id: string;
  revision_id: string;
  package_digest: string;
  script_name: string;
  request_digest: string;
  state: D1TemporaryProviderOperationState;
  account_id: string | null;
  authorization_ref: string | null;
  claim_ref: string | null;
  account_expires_at: number | null;
  claim_expires_at: number | null;
  provider_deployment_id: string | null;
  provider_version_id: string | null;
  workers_dev_url: string | null;
  serialized_body_bytes: number | null;
  failure_reason: string | null;
  ambiguity_expires_at: number;
  created_on: string;
  updated_on: string;
};

export type D1TemporaryProviderOperation = {
  operationId: string;
  operationKind: "temporary.deployment.create";
  userId: string;
  shipletId: string;
  targetId: string;
  revisionId: string;
  packageDigest: string;
  scriptName: string;
  requestDigest: string;
  state: D1TemporaryProviderOperationState;
  accountId: string | null;
  authorizationRef: string | null;
  claimRef: string | null;
  accountExpiresAt: number | null;
  claimExpiresAt: number | null;
  providerDeploymentId: string | null;
  providerVersionId: string | null;
  workersDevUrl: string | null;
  serializedBodyBytes: number | null;
  failureReason: string | null;
  ambiguityExpiresAt: number;
  createdOn: string;
  updatedOn: string;
};

export type D1TemporaryStaticDeploymentResult = Readonly<{
  providerDeploymentId: string;
  providerVersionId: string;
  workersDevUrl: string;
  serializedBodyBytes: number;
}>;

export async function recoverD1TemporaryStaticDeployment<T>(input: {
  state: "account_ready" | "deploying";
  begin(): void | PromiseLike<void>;
  upload(): D1TemporaryStaticDeploymentResult | PromiseLike<D1TemporaryStaticDeploymentResult>;
  inspect():
    | Readonly<{
        ok: true;
        deployment: D1TemporaryStaticDeploymentResult;
      }>
    | Readonly<{ ok: false; reason: "temporary_deployment_unproven" }>
    | PromiseLike<
        | Readonly<{
            ok: true;
            deployment: D1TemporaryStaticDeploymentResult;
          }>
        | Readonly<{ ok: false; reason: "temporary_deployment_unproven" }>
      >;
  checkpoint(
    deployment: D1TemporaryStaticDeploymentResult,
  ): T | PromiseLike<T>;
}) {
  let deployment: D1TemporaryStaticDeploymentResult;
  if (input.state === "account_ready") {
    await input.begin();
    deployment = await input.upload();
  } else {
    const inspected = await input.inspect();
    if (!inspected.ok) throw new Error(inspected.reason);
    deployment = inspected.deployment;
  }
  return input.checkpoint(deployment);
}

function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validBinding(
  binding: D1TemporaryProviderOperationBinding,
): boolean {
  return (
    IDENTIFIER.test(binding.operationId) &&
    binding.operationKind === "temporary.deployment.create" &&
    IDENTIFIER.test(binding.userId) &&
    IDENTIFIER.test(binding.shipletId) &&
    IDENTIFIER.test(binding.targetId) &&
    IDENTIFIER.test(binding.revisionId) &&
    DIGEST.test(binding.packageDigest) &&
    SCRIPT_IDENTIFIER.test(binding.scriptName) &&
    DIGEST.test(binding.requestDigest)
  );
}

function publicOperation(
  row: TemporaryProviderOperationRow,
): D1TemporaryProviderOperation {
  return Object.freeze({
    operationId: row.operation_id,
    operationKind: row.operation_kind,
    userId: row.user_id,
    shipletId: row.shiplet_id,
    targetId: row.target_id,
    revisionId: row.revision_id,
    packageDigest: row.package_digest,
    scriptName: row.script_name,
    requestDigest: row.request_digest,
    state: row.state,
    accountId: row.account_id,
    authorizationRef: row.authorization_ref,
    claimRef: row.claim_ref,
    accountExpiresAt: row.account_expires_at,
    claimExpiresAt: row.claim_expires_at,
    providerDeploymentId: row.provider_deployment_id,
    providerVersionId: row.provider_version_id,
    workersDevUrl: row.workers_dev_url,
    serializedBodyBytes: row.serialized_body_bytes,
    failureReason: row.failure_reason,
    ambiguityExpiresAt: row.ambiguity_expires_at,
    createdOn: row.created_on,
    updatedOn: row.updated_on,
  });
}

function bindingMatches(
  row: TemporaryProviderOperationRow,
  binding: D1TemporaryProviderOperationBinding,
) {
  return (
    row.operation_id === binding.operationId &&
    row.operation_kind === binding.operationKind &&
    row.user_id === binding.userId &&
    row.shiplet_id === binding.shipletId &&
    row.target_id === binding.targetId &&
    row.revision_id === binding.revisionId &&
    row.package_digest === binding.packageDigest &&
    row.script_name === binding.scriptName &&
    row.request_digest === binding.requestDigest
  );
}

async function getOperation(
  db: D1Database,
  operationId: string,
): Promise<TemporaryProviderOperationRow | null> {
  return db
    .prepare(
      `SELECT * FROM temporary_provider_operations WHERE operation_id = ? LIMIT 1`,
    )
    .bind(operationId)
    .first<TemporaryProviderOperationRow>();
}

export async function ensureD1TemporaryProviderOperationSchema(
  db: D1Database,
) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS temporary_provider_operations (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL CHECK (
          operation_kind = 'temporary.deployment.create'
        ),
        user_id TEXT NOT NULL,
        shiplet_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        package_digest TEXT NOT NULL,
        script_name TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'reserved', 'provisioning', 'account_ready', 'deploying', 'active',
          'cleanup_pending', 'cleaned', 'ambiguity_expired'
        )),
        account_id TEXT,
        authorization_ref TEXT,
        claim_ref TEXT,
        account_expires_at INTEGER,
        claim_expires_at INTEGER,
        provider_deployment_id TEXT,
        provider_version_id TEXT,
        workers_dev_url TEXT,
        serialized_body_bytes INTEGER,
        failure_reason TEXT,
        ambiguity_expires_at INTEGER NOT NULL,
        created_on TEXT NOT NULL,
        updated_on TEXT NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_temporary_provider_operations_recovery
       ON temporary_provider_operations(state, updated_on, operation_id)`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS temporary_provider_operation_binding_immutable
       BEFORE UPDATE ON temporary_provider_operations
       WHEN NEW.operation_id != OLD.operation_id
         OR NEW.operation_kind != OLD.operation_kind
         OR NEW.user_id != OLD.user_id
         OR NEW.shiplet_id != OLD.shiplet_id
         OR NEW.target_id != OLD.target_id
         OR NEW.revision_id != OLD.revision_id
         OR NEW.package_digest != OLD.package_digest
         OR NEW.script_name != OLD.script_name
         OR NEW.request_digest != OLD.request_digest
         OR NEW.ambiguity_expires_at != OLD.ambiguity_expires_at
         OR NEW.created_on != OLD.created_on
         OR (OLD.account_id IS NOT NULL AND NEW.account_id IS NOT OLD.account_id)
         OR (OLD.authorization_ref IS NOT NULL AND NEW.authorization_ref IS NOT OLD.authorization_ref)
         OR (OLD.claim_ref IS NOT NULL AND NEW.claim_ref IS NOT OLD.claim_ref)
         OR (OLD.account_expires_at IS NOT NULL AND NEW.account_expires_at IS NOT OLD.account_expires_at)
         OR (OLD.claim_expires_at IS NOT NULL AND NEW.claim_expires_at IS NOT OLD.claim_expires_at)
         OR (OLD.provider_deployment_id IS NOT NULL AND NEW.provider_deployment_id IS NOT OLD.provider_deployment_id)
         OR (OLD.provider_version_id IS NOT NULL AND NEW.provider_version_id IS NOT OLD.provider_version_id)
         OR (OLD.workers_dev_url IS NOT NULL AND NEW.workers_dev_url IS NOT OLD.workers_dev_url)
         OR (OLD.serialized_body_bytes IS NOT NULL AND NEW.serialized_body_bytes IS NOT OLD.serialized_body_bytes)
       BEGIN
         SELECT RAISE(ABORT, 'temporary provider operation binding is immutable');
       END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS temporary_provider_operation_legal_transition
       BEFORE UPDATE OF state ON temporary_provider_operations
       WHEN NEW.state != OLD.state AND NOT (
         (OLD.state = 'reserved' AND NEW.state = 'provisioning')
         OR (OLD.state = 'provisioning' AND NEW.state IN ('account_ready', 'ambiguity_expired'))
         OR (OLD.state = 'account_ready' AND NEW.state IN ('deploying', 'cleanup_pending'))
         OR (OLD.state = 'deploying' AND NEW.state IN ('active', 'cleanup_pending'))
         OR (OLD.state = 'active' AND NEW.state = 'cleanup_pending')
         OR (OLD.state = 'cleanup_pending' AND NEW.state = 'cleaned')
       )
       BEGIN
         SELECT RAISE(ABORT, 'illegal temporary provider operation transition');
       END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS temporary_provider_operation_no_delete
       BEFORE DELETE ON temporary_provider_operations
       BEGIN
         SELECT RAISE(ABORT, 'temporary provider operation history is durable');
       END`,
    ),
  ]);
}

export async function reserveD1TemporaryProviderOperation(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  now: number;
  ambiguityExpiresAt: number;
}) {
  if (
    !validBinding(input.binding) ||
    !validInteger(input.now) ||
    !validInteger(input.ambiguityExpiresAt) ||
    input.ambiguityExpiresAt <= input.now
  ) {
    return { ok: false as const, reason: "temporary_operation_invalid" };
  }
  const existing = await getOperation(input.db, input.binding.operationId);
  if (existing) {
    return bindingMatches(existing, input.binding)
      ? {
          ok: true as const,
          replay: true,
          operation: publicOperation(existing),
        }
      : {
          ok: false as const,
          reason: "temporary_operation_binding_conflict",
        };
  }
  if (input.ambiguityExpiresAt > input.now + MAX_AMBIGUITY_FENCE_MS) {
    return { ok: false as const, reason: "temporary_operation_invalid" };
  }
  const timestamp = new Date(input.now).toISOString();
  const inserted = await input.db
    .prepare(
      `INSERT OR IGNORE INTO temporary_provider_operations (
        operation_id, operation_kind, user_id, shiplet_id, target_id,
        revision_id, package_digest, script_name, request_digest, state,
        account_id, authorization_ref, claim_ref, account_expires_at,
        claim_expires_at, provider_deployment_id, provider_version_id,
        workers_dev_url, serialized_body_bytes, failure_reason,
        ambiguity_expires_at, created_on, updated_on
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    )
    .bind(
      input.binding.operationId,
      input.binding.operationKind,
      input.binding.userId,
      input.binding.shipletId,
      input.binding.targetId,
      input.binding.revisionId,
      input.binding.packageDigest,
      input.binding.scriptName,
      input.binding.requestDigest,
      input.ambiguityExpiresAt,
      timestamp,
      timestamp,
    )
    .run();
  const row = await getOperation(input.db, input.binding.operationId);
  if (!row || !bindingMatches(row, input.binding)) {
    return {
      ok: false as const,
      reason: "temporary_operation_binding_conflict",
    };
  }
  return {
    ok: true as const,
    replay: inserted.meta.changes !== 1,
    operation: publicOperation(row),
  };
}

export async function reserveD1TemporaryProviderOperationWithIntent(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  now: number;
  ambiguityExpiresAt: number;
  grant: {
    grantDigest: string;
    handleDigest: string;
    operation: "temporary.deployment.create";
    expiresAt: number;
    consumedOn: string;
  };
  audit: { id: string; eventJson: string; createdOn: string };
}) {
  if (
    !validBinding(input.binding) ||
    !validInteger(input.now) ||
    !validInteger(input.ambiguityExpiresAt) ||
    input.ambiguityExpiresAt <= input.now ||
    input.ambiguityExpiresAt > input.now + MAX_AMBIGUITY_FENCE_MS ||
    !RAW_DIGEST.test(input.grant.grantDigest) ||
    !RAW_DIGEST.test(input.grant.handleDigest) ||
    input.grant.operation !== "temporary.deployment.create" ||
    !validInteger(input.grant.expiresAt) ||
    input.grant.expiresAt <= input.now ||
    input.grant.expiresAt > input.now + 30_000 ||
    !IDENTIFIER.test(input.audit.id) ||
    new TextEncoder().encode(input.audit.eventJson).byteLength > 16_384 ||
    Number.isNaN(Date.parse(input.grant.consumedOn)) ||
    Number.isNaN(Date.parse(input.audit.createdOn))
  ) {
    return { ok: false as const, reason: "temporary_operation_invalid" };
  }
  const existing = await getOperation(input.db, input.binding.operationId);
  if (existing && !bindingMatches(existing, input.binding)) {
    return {
      ok: false as const,
      reason: "temporary_operation_binding_conflict",
    };
  }
  const timestamp = new Date(input.now).toISOString();
  const statements = [];
  if (!existing) {
    statements.push(
      input.db
        .prepare(
          `INSERT INTO temporary_provider_operations (
            operation_id, operation_kind, user_id, shiplet_id, target_id,
            revision_id, package_digest, script_name, request_digest, state,
            account_id, authorization_ref, claim_ref, account_expires_at,
            claim_expires_at, provider_deployment_id, provider_version_id,
            workers_dev_url, serialized_body_bytes, failure_reason,
            ambiguity_expires_at, created_on, updated_on
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved',
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .bind(
          input.binding.operationId,
          input.binding.operationKind,
          input.binding.userId,
          input.binding.shipletId,
          input.binding.targetId,
          input.binding.revisionId,
          input.binding.packageDigest,
          input.binding.scriptName,
          input.binding.requestDigest,
          input.ambiguityExpiresAt,
          timestamp,
          timestamp,
        ),
    );
  }
  statements.push(
    input.db
      .prepare(
        `INSERT INTO temporary_grant_consumptions (
          grant_digest, handle_digest, operation, expires_at, consumed_on
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        input.grant.grantDigest,
        input.grant.handleDigest,
        input.grant.operation,
        input.grant.expiresAt,
        input.grant.consumedOn,
      ),
    input.db
      .prepare(
        `INSERT INTO control_audit_outbox (
          id, event_json, delivery_status, created_on, delivered_on
        ) VALUES (?, ?, 'pending', ?, NULL)`,
      )
      .bind(input.audit.id, input.audit.eventJson, input.audit.createdOn),
  );
  let results: D1Result[];
  try {
    results = await input.db.batch(statements);
  } catch (error) {
    const consumed = await input.db
      .prepare(
        `SELECT 1 AS consumed FROM temporary_grant_consumptions
         WHERE grant_digest = ? OR handle_digest = ? LIMIT 1`,
      )
      .bind(input.grant.grantDigest, input.grant.handleDigest)
      .first<{ consumed: number }>();
    if (consumed?.consumed === 1) {
      return { ok: false as const, reason: "temporary_grant_replayed" };
    }
    throw error;
  }
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error("temporary_operation_intent_transaction_failed");
  }
  const row = await getOperation(input.db, input.binding.operationId);
  if (!row || !bindingMatches(row, input.binding)) {
    throw new Error("temporary_operation_intent_transaction_failed");
  }
  return {
    ok: true as const,
    replay: Boolean(existing),
    operation: publicOperation(row),
  };
}

async function transitionState(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  now: number;
  from: D1TemporaryProviderOperationState[];
  to: D1TemporaryProviderOperationState;
  assignments?: string;
  values?: unknown[];
  replayMatches?: (row: TemporaryProviderOperationRow) => boolean;
}) {
  if (!validBinding(input.binding) || !validInteger(input.now)) {
    return { ok: false as const, reason: "temporary_operation_invalid" };
  }
  const current = await getOperation(input.db, input.binding.operationId);
  if (!current || !bindingMatches(current, input.binding)) {
    return {
      ok: false as const,
      reason: "temporary_operation_binding_conflict",
    };
  }
  if (current.state === input.to) {
    return !input.replayMatches || input.replayMatches(current)
      ? { ok: true as const, state: input.to }
      : {
          ok: false as const,
          reason: "temporary_operation_binding_conflict",
        };
  }
  if (!input.from.includes(current.state)) {
    return {
      ok: false as const,
      reason: "temporary_operation_transition_conflict",
    };
  }
  const allowed = input.from.map(() => "?").join(", ");
  const update = await input.db
    .prepare(
      `UPDATE temporary_provider_operations
       SET state = ?, updated_on = ?${input.assignments ? `, ${input.assignments}` : ""}
       WHERE operation_id = ? AND state IN (${allowed})`,
    )
    .bind(
      input.to,
      new Date(input.now).toISOString(),
      ...(input.values ?? []),
      input.binding.operationId,
      ...input.from,
    )
    .run();
  if (update.meta.changes === 1) {
    return { ok: true as const, state: input.to };
  }
  const raced = await getOperation(input.db, input.binding.operationId);
  return raced &&
    bindingMatches(raced, input.binding) &&
    raced.state === input.to &&
    (!input.replayMatches || input.replayMatches(raced))
    ? { ok: true as const, state: input.to }
    : {
        ok: false as const,
        reason: "temporary_operation_transition_conflict",
      };
}

export function beginD1TemporaryProvisioning(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  now: number;
}) {
  return transitionState({ ...input, from: ["reserved"], to: "provisioning" });
}

export function recordD1TemporaryAccountReady(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  now: number;
  account: {
    accountId: string;
    authorizationRef: string;
    claimRef: string;
    accountExpiresAt: number;
    claimExpiresAt: number;
  };
}) {
  const account = input.account;
  if (
    !IDENTIFIER.test(account.accountId) ||
    !IDENTIFIER.test(account.authorizationRef) ||
    !IDENTIFIER.test(account.claimRef) ||
    !validInteger(account.accountExpiresAt) ||
    !validInteger(account.claimExpiresAt) ||
    account.accountExpiresAt <= input.now ||
    account.claimExpiresAt <= input.now ||
    account.accountExpiresAt > input.now + MAX_AMBIGUITY_FENCE_MS ||
    account.claimExpiresAt > input.now + MAX_AMBIGUITY_FENCE_MS ||
    account.claimExpiresAt > account.accountExpiresAt
  ) {
    return Promise.resolve({
      ok: false as const,
      reason: "temporary_operation_invalid",
    });
  }
  return transitionState({
    db: input.db,
    binding: input.binding,
    now: input.now,
    from: ["provisioning"],
    to: "account_ready",
    assignments:
      "account_id = ?, authorization_ref = ?, claim_ref = ?, account_expires_at = ?, claim_expires_at = ?",
    values: [
      account.accountId,
      account.authorizationRef,
      account.claimRef,
      account.accountExpiresAt,
      account.claimExpiresAt,
    ],
    replayMatches: (row) =>
      row.account_id === account.accountId &&
      row.authorization_ref === account.authorizationRef &&
      row.claim_ref === account.claimRef &&
      row.account_expires_at === account.accountExpiresAt &&
      row.claim_expires_at === account.claimExpiresAt,
  });
}

export function beginD1TemporaryWorkerDeployment(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  now: number;
}) {
  return transitionState({ ...input, from: ["account_ready"], to: "deploying" });
}

export function recordD1TemporaryDeploymentActive(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  now: number;
  deployment: {
    providerDeploymentId: string;
    providerVersionId: string;
    workersDevUrl: string;
    serializedBodyBytes: number;
  };
}) {
  const deployment = input.deployment;
  let parsed: URL;
  try {
    parsed = new URL(deployment.workersDevUrl);
  } catch {
    return Promise.resolve({
      ok: false as const,
      reason: "temporary_operation_invalid",
    });
  }
  if (
    !IDENTIFIER.test(deployment.providerDeploymentId) ||
    !IDENTIFIER.test(deployment.providerVersionId) ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.toString() !== deployment.workersDevUrl ||
    !validInteger(deployment.serializedBodyBytes)
  ) {
    return Promise.resolve({
      ok: false as const,
      reason: "temporary_operation_invalid",
    });
  }
  return transitionState({
    db: input.db,
    binding: input.binding,
    now: input.now,
    from: ["deploying"],
    to: "active",
    assignments:
      "provider_deployment_id = ?, provider_version_id = ?, workers_dev_url = ?, serialized_body_bytes = ?",
    values: [
      deployment.providerDeploymentId,
      deployment.providerVersionId,
      deployment.workersDevUrl,
      deployment.serializedBodyBytes,
    ],
    replayMatches: (row) =>
      row.provider_deployment_id === deployment.providerDeploymentId &&
      row.provider_version_id === deployment.providerVersionId &&
      row.workers_dev_url === deployment.workersDevUrl &&
      row.serialized_body_bytes === deployment.serializedBodyBytes,
  });
}

export function markD1TemporaryCleanupPending(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  now: number;
  reason: string;
}) {
  if (!IDENTIFIER.test(input.reason)) {
    return Promise.resolve({
      ok: false as const,
      reason: "temporary_operation_invalid",
    });
  }
  return transitionState({
    db: input.db,
    binding: input.binding,
    now: input.now,
    from: ["account_ready", "deploying", "active"],
    to: "cleanup_pending",
    assignments: "failure_reason = ?",
    values: [input.reason],
  });
}

export function markD1TemporaryOperationCleaned(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  now: number;
}) {
  return transitionState({
    ...input,
    from: ["cleanup_pending"],
    to: "cleaned",
  });
}

type TemporaryCleanupDeploymentRow = {
  id: string;
  user_id: string;
  shiplet_id: string | null;
  target_id: string;
  revision_id: string;
  package_digest: string;
  script_name: string;
  request_digest: string;
  provider_deployment_id: string;
  provider_version_id: string;
  authorization_ref: string | null;
  claim_ref: string | null;
  operation_id: string | null;
  status: string;
  cleaned_on: string | null;
};

async function exactCleanupDeployment(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  deploymentId: string;
}) {
  return input.db
    .prepare(
      `SELECT id, user_id, shiplet_id, target_id, revision_id,
        package_digest, script_name, request_digest, provider_deployment_id,
        provider_version_id, authorization_ref, claim_ref, operation_id,
        status, cleaned_on
       FROM temporary_deployments
       WHERE id = ? AND operation_id = ? AND user_id = ? AND shiplet_id = ?
         AND target_id = ? AND revision_id = ? AND package_digest = ?
         AND script_name = ? AND request_digest = ?
       LIMIT 1`,
    )
    .bind(
      input.deploymentId,
      input.binding.operationId,
      input.binding.userId,
      input.binding.shipletId,
      input.binding.targetId,
      input.binding.revisionId,
      input.binding.packageDigest,
      input.binding.scriptName,
      input.binding.requestDigest,
    )
    .first<TemporaryCleanupDeploymentRow>();
}

function validAudit(input: { id: string; eventJson: string; createdOn: string }) {
  return (
    IDENTIFIER.test(input.id) &&
    new TextEncoder().encode(input.eventJson).byteLength <= 16_384 &&
    !Number.isNaN(Date.parse(input.createdOn))
  );
}

export async function reserveD1TemporaryCleanupWithIntent(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  deploymentId: string;
  now: number;
  grant: {
    grantDigest: string;
    handleDigest: string;
    operation: "temporary.deployment.cleanup";
    expiresAt: number;
    consumedOn: string;
  };
  audit: { id: string; eventJson: string; createdOn: string };
}) {
  if (
    !validBinding(input.binding) ||
    !IDENTIFIER.test(input.deploymentId) ||
    !validInteger(input.now) ||
    !RAW_DIGEST.test(input.grant.grantDigest) ||
    !RAW_DIGEST.test(input.grant.handleDigest) ||
    input.grant.operation !== "temporary.deployment.cleanup" ||
    !validInteger(input.grant.expiresAt) ||
    input.grant.expiresAt <= input.now ||
    input.grant.expiresAt > input.now + 30_000 ||
    Number.isNaN(Date.parse(input.grant.consumedOn)) ||
    !validAudit(input.audit)
  ) {
    return { ok: false as const, reason: "temporary_cleanup_invalid" };
  }
  const [operation, deployment] = await Promise.all([
    getOperation(input.db, input.binding.operationId),
    exactCleanupDeployment(input),
  ]);
  const alreadyCleaned =
    operation?.state === "cleaned" &&
    deployment?.status === "cleaned" &&
    deployment.authorization_ref === null &&
    deployment.claim_ref === null;
  if (
    !operation ||
    !bindingMatches(operation, input.binding) ||
    !deployment ||
    operation.provider_deployment_id !== deployment.provider_deployment_id ||
    operation.provider_version_id !== deployment.provider_version_id ||
    (!alreadyCleaned &&
      (deployment.authorization_ref === null ||
        operation.authorization_ref !== deployment.authorization_ref ||
        !["active", "cleanup_pending"].includes(operation.state) ||
        !["active", "claim_delivered", "expired"].includes(deployment.status)))
  ) {
    return { ok: false as const, reason: "temporary_cleanup_binding_conflict" };
  }
  const statements = [];
  if (operation.state === "active") {
    statements.push(
      input.db
        .prepare(
          `UPDATE temporary_provider_operations
           SET state = 'cleanup_pending', failure_reason = 'cleanup_requested',
             updated_on = ?
           WHERE operation_id = ? AND state = 'active'`,
        )
        .bind(new Date(input.now).toISOString(), input.binding.operationId),
    );
  }
  statements.push(
    input.db
      .prepare(
        `INSERT INTO temporary_grant_consumptions (
          grant_digest, handle_digest, operation, expires_at, consumed_on
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        input.grant.grantDigest,
        input.grant.handleDigest,
        input.grant.operation,
        input.grant.expiresAt,
        input.grant.consumedOn,
      ),
    input.db
      .prepare(
        `INSERT INTO control_audit_outbox (
          id, event_json, delivery_status, created_on, delivered_on
        ) VALUES (?, ?, 'pending', ?, NULL)`,
      )
      .bind(input.audit.id, input.audit.eventJson, input.audit.createdOn),
  );
  let results: D1Result[];
  try {
    results = await input.db.batch(statements);
  } catch (error) {
    const consumed = await input.db
      .prepare(
        `SELECT 1 AS consumed FROM temporary_grant_consumptions
         WHERE grant_digest = ? OR handle_digest = ? LIMIT 1`,
      )
      .bind(input.grant.grantDigest, input.grant.handleDigest)
      .first<{ consumed: number }>();
    if (consumed?.consumed === 1) {
      return { ok: false as const, reason: "temporary_grant_replayed" };
    }
    throw error;
  }
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error("temporary_cleanup_intent_transaction_failed");
  }
  const pending = await getOperation(input.db, input.binding.operationId);
  if (
    !pending ||
    !bindingMatches(pending, input.binding) ||
    pending.state !== "cleanup_pending"
  ) {
    throw new Error("temporary_cleanup_intent_transaction_failed");
  }
  return {
    ok: true as const,
    replay: operation.state !== "active",
    operation: publicOperation(pending),
    deployment,
  };
}

export async function finalizeD1TemporaryCleanup(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  deploymentId: string;
  now: number;
  audit: { id: string; eventJson: string; createdOn: string };
}) {
  if (
    !validBinding(input.binding) ||
    !IDENTIFIER.test(input.deploymentId) ||
    !validInteger(input.now) ||
    !validAudit(input.audit)
  ) {
    return { ok: false as const, reason: "temporary_cleanup_invalid" };
  }
  const [operation, deployment] = await Promise.all([
    getOperation(input.db, input.binding.operationId),
    exactCleanupDeployment(input),
  ]);
  if (!operation || !bindingMatches(operation, input.binding) || !deployment) {
    return { ok: false as const, reason: "temporary_cleanup_binding_conflict" };
  }
  if (
    operation.state === "cleaned" &&
    deployment.status === "cleaned" &&
    deployment.authorization_ref === null &&
    deployment.claim_ref === null
  ) {
    return { ok: true as const, replay: true };
  }
  if (
    operation.state !== "cleanup_pending" ||
    deployment.authorization_ref === null ||
    operation.authorization_ref !== deployment.authorization_ref ||
    !["active", "claim_delivered", "expired"].includes(deployment.status)
  ) {
    return { ok: false as const, reason: "temporary_cleanup_binding_conflict" };
  }
  const cleanedOn = new Date(input.now).toISOString();
  const statements = [
    input.db
      .prepare(
        `UPDATE temporary_provider_operations
         SET state = 'cleaned', updated_on = ?
         WHERE operation_id = ? AND state = 'cleanup_pending'`,
      )
      .bind(cleanedOn, input.binding.operationId),
    input.db
      .prepare(
        `UPDATE temporary_deployments
         SET status = 'cleaned', cleaned_on = ?, authorization_ref = NULL,
           claim_ref = NULL
         WHERE id = ? AND operation_id = ?
           AND status IN ('active', 'claim_delivered', 'expired')
           AND authorization_ref = ?`,
      )
      .bind(
        cleanedOn,
        input.deploymentId,
        input.binding.operationId,
        deployment.authorization_ref,
      ),
    input.db
      .prepare(
        `DELETE FROM encrypted_records
         WHERE id = ? AND purpose = 'temporary_authority'`,
      )
      .bind(deployment.authorization_ref),
  ];
  if (deployment.claim_ref !== null) {
    statements.push(
      input.db
        .prepare(
          `DELETE FROM encrypted_records
           WHERE id = ? AND purpose = 'temporary_claim'`,
        )
        .bind(deployment.claim_ref),
    );
  }
  statements.push(
    input.db
      .prepare(
        `INSERT INTO control_audit_outbox (
          id, event_json, delivery_status, created_on, delivered_on
        ) VALUES (?, ?, 'pending', ?, NULL)`,
      )
      .bind(input.audit.id, input.audit.eventJson, input.audit.createdOn),
  );
  const results = await input.db.batch(statements);
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error("temporary_cleanup_finalize_transaction_failed");
  }
  return { ok: true as const, replay: false };
}

export async function markD1TemporaryAmbiguityExpired(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  now: number;
}) {
  const current = await getOperation(input.db, input.binding.operationId);
  if (
    !current ||
    !bindingMatches(current, input.binding) ||
    input.now < current.ambiguity_expires_at
  ) {
    return {
      ok: false as const,
      reason: "temporary_operation_transition_conflict",
    };
  }
  return transitionState({
    ...input,
    from: ["provisioning"],
    to: "ambiguity_expired",
  });
}

export async function listD1RecoverableTemporaryProviderOperations(
  db: D1Database,
  limit: number,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("temporary_operation_recovery_limit_invalid");
  }
  const rows = await db
    .prepare(
      `SELECT * FROM temporary_provider_operations
       WHERE state IN (
         'provisioning', 'account_ready', 'deploying', 'cleanup_pending'
       ) OR (
         state = 'active' AND NOT EXISTS (
           SELECT 1 FROM temporary_deployments
           WHERE temporary_deployments.operation_id =
             temporary_provider_operations.operation_id
         )
       )
       ORDER BY updated_on, operation_id LIMIT ?`,
    )
    .bind(limit)
    .all<TemporaryProviderOperationRow>();
  return rows.results.map(publicOperation);
}

async function finalizeD1TemporaryOrphanCleanup(input: {
  db: D1Database;
  binding: D1TemporaryProviderOperationBinding;
  now: number;
  audit: { id: string; eventJson: string; createdOn: string };
}) {
  if (
    !validBinding(input.binding) ||
    !validInteger(input.now) ||
    !validAudit(input.audit)
  ) {
    return { ok: false as const, reason: "temporary_cleanup_invalid" };
  }
  const operation = await getOperation(input.db, input.binding.operationId);
  const deployment = await input.db
    .prepare(
      `SELECT 1 AS present FROM temporary_deployments
       WHERE operation_id = ? LIMIT 1`,
    )
    .bind(input.binding.operationId)
    .first<{ present: number }>();
  if (
    !operation ||
    !bindingMatches(operation, input.binding) ||
    operation.state !== "cleanup_pending" ||
    !operation.authorization_ref ||
    deployment?.present === 1
  ) {
    return { ok: false as const, reason: "temporary_cleanup_binding_conflict" };
  }
  const timestamp = new Date(input.now).toISOString();
  const statements = [
    input.db
      .prepare(
        `UPDATE temporary_provider_operations
         SET state = 'cleaned', updated_on = ?
         WHERE operation_id = ? AND state = 'cleanup_pending'`,
      )
      .bind(timestamp, input.binding.operationId),
    input.db
      .prepare(
        `DELETE FROM encrypted_records
         WHERE id = ? AND purpose = 'temporary_authority'`,
      )
      .bind(operation.authorization_ref),
  ];
  if (operation.claim_ref) {
    statements.push(
      input.db
        .prepare(
          `DELETE FROM encrypted_records
           WHERE id = ? AND purpose = 'temporary_claim'`,
        )
        .bind(operation.claim_ref),
    );
  }
  statements.push(
    input.db
      .prepare(
        `INSERT INTO control_audit_outbox (
          id, event_json, delivery_status, created_on, delivered_on
        ) VALUES (?, ?, 'pending', ?, NULL)`,
      )
      .bind(input.audit.id, input.audit.eventJson, input.audit.createdOn),
  );
  const results = await input.db.batch(statements);
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error("temporary_cleanup_finalize_transaction_failed");
  }
  return { ok: true as const };
}

export async function reconcileD1TemporaryProviderOperations(input: {
  db: D1Database;
  now: number;
  limit: number;
  cleanup(
    operation: D1TemporaryProviderOperation,
  ): unknown | PromiseLike<unknown>;
  audit(
    operation: D1TemporaryProviderOperation,
    now: number,
  ):
    | { id: string; eventJson: string; createdOn: string }
    | PromiseLike<{ id: string; eventJson: string; createdOn: string }>;
}) {
  if (!validInteger(input.now)) {
    throw new TypeError("temporary_operation_recovery_clock_invalid");
  }
  const operations = await listD1RecoverableTemporaryProviderOperations(
    input.db,
    input.limit,
  );
  const result = {
    examined: operations.length,
    cleaned: 0,
    expired: 0,
    failed: 0,
  };
  for (const operation of operations) {
    const binding: D1TemporaryProviderOperationBinding = {
      operationId: operation.operationId,
      operationKind: operation.operationKind,
      userId: operation.userId,
      shipletId: operation.shipletId,
      targetId: operation.targetId,
      revisionId: operation.revisionId,
      packageDigest: operation.packageDigest,
      scriptName: operation.scriptName,
      requestDigest: operation.requestDigest,
    };
    if (operation.state === "provisioning") {
      if (input.now >= operation.ambiguityExpiresAt) {
        const expired = await markD1TemporaryAmbiguityExpired({
          db: input.db,
          binding,
          now: input.now,
        });
        if (expired.ok) result.expired += 1;
        else result.failed += 1;
      }
      continue;
    }
    let pending = operation;
    if (operation.state !== "cleanup_pending") {
      const marked = await markD1TemporaryCleanupPending({
        db: input.db,
        binding,
        now: input.now,
        reason: "interrupted_provider_effect",
      });
      if (!marked.ok) {
        result.failed += 1;
        continue;
      }
      pending = Object.freeze({ ...operation, state: "cleanup_pending" });
    }
    try {
      await input.cleanup(pending);
      const deployment = await input.db
        .prepare(
          `SELECT id FROM temporary_deployments
           WHERE operation_id = ? LIMIT 1`,
        )
        .bind(operation.operationId)
        .first<{ id: string }>();
      const audit = await input.audit(pending, input.now);
      const finalized = deployment
        ? await finalizeD1TemporaryCleanup({
            db: input.db,
            binding,
            deploymentId: deployment.id,
            now: input.now,
            audit,
          })
        : await finalizeD1TemporaryOrphanCleanup({
            db: input.db,
            binding,
            now: input.now,
            audit,
          });
      if (finalized.ok) result.cleaned += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export type D1TemporaryClaimDeliveryInput = {
  deploymentId: string;
  operationId: string;
  deliveryEventId: string;
  userId: string;
  shipletId: string;
  targetId: string;
  revisionId: string;
  handleDigest: string;
  handleRef: string;
  expiresAt: number;
  now: number;
};

type TemporaryClaimDeliveryRow = {
  id: string;
  user_id: string;
  shiplet_id: string | null;
  target_id: string;
  revision_id: string;
  operation_id: string | null;
  status: string;
  claim_ref: string | null;
  claim_expires_at: number;
  delivery_event_id: string | null;
  delivery_started_on: string | null;
  handle_digest: string | null;
  redirect_user_id: string | null;
  redirect_expires_at: number | null;
  redirect_delivery_event_id: string | null;
  handle_ref: string | null;
};

export type D1PreparedTemporaryClaimDelivery = {
  ok: true;
  replay: boolean;
  delivery: {
    deploymentId: string;
    operationId: string;
    deliveryEventId: string;
    userId: string;
    shipletId: string;
    targetId: string;
    revisionId: string;
    handleDigest: string;
    handleRef: string;
    expiresAt: number;
  };
};

async function claimDeliveryRow(
  db: D1Database,
  deploymentId: string,
): Promise<TemporaryClaimDeliveryRow | null> {
  return db
    .prepare(
      `SELECT deployment.id, deployment.user_id, deployment.shiplet_id,
        deployment.target_id, deployment.revision_id, deployment.operation_id,
        deployment.status, deployment.claim_ref, deployment.claim_expires_at,
        deployment.delivery_event_id, deployment.delivery_started_on,
        redirect.handle_digest, redirect.user_id AS redirect_user_id,
        redirect.expires_at AS redirect_expires_at,
        redirect.delivery_event_id AS redirect_delivery_event_id,
        redirect.handle_ref
       FROM temporary_deployments AS deployment
       LEFT JOIN backend_redirects AS redirect
         ON redirect.temporary_deployment_id = deployment.id
       WHERE deployment.id = ? LIMIT 1`,
    )
    .bind(deploymentId)
    .first<TemporaryClaimDeliveryRow>();
}

function validClaimDelivery(input: D1TemporaryClaimDeliveryInput) {
  return (
    IDENTIFIER.test(input.deploymentId) &&
    IDENTIFIER.test(input.operationId) &&
    IDENTIFIER.test(input.deliveryEventId) &&
    IDENTIFIER.test(input.userId) &&
    IDENTIFIER.test(input.shipletId) &&
    IDENTIFIER.test(input.targetId) &&
    IDENTIFIER.test(input.revisionId) &&
    RAW_DIGEST.test(input.handleDigest) &&
    IDENTIFIER.test(input.handleRef) &&
    validInteger(input.expiresAt) &&
    validInteger(input.now) &&
    input.expiresAt > input.now
  );
}

function claimBindingMatches(
  row: TemporaryClaimDeliveryRow,
  input: D1TemporaryClaimDeliveryInput,
) {
  return (
    row.id === input.deploymentId &&
    row.operation_id === input.operationId &&
    row.user_id === input.userId &&
    row.shiplet_id === input.shipletId &&
    row.target_id === input.targetId &&
    row.revision_id === input.revisionId &&
    row.claim_expires_at === input.expiresAt &&
    row.delivery_event_id === input.deliveryEventId &&
    row.handle_digest === input.handleDigest &&
    row.redirect_user_id === input.userId &&
    row.redirect_expires_at === input.expiresAt &&
    row.redirect_delivery_event_id === input.deliveryEventId &&
    row.handle_ref === input.handleRef &&
    row.status === "claim_delivered" &&
    row.delivery_started_on !== null
  );
}

function publicClaimDelivery(
  input: D1TemporaryClaimDeliveryInput,
  replay: boolean,
): D1PreparedTemporaryClaimDelivery {
  return Object.freeze({
    ok: true as const,
    replay,
    delivery: Object.freeze({
      deploymentId: input.deploymentId,
      operationId: input.operationId,
      deliveryEventId: input.deliveryEventId,
      userId: input.userId,
      shipletId: input.shipletId,
      targetId: input.targetId,
      revisionId: input.revisionId,
      handleDigest: input.handleDigest,
      handleRef: input.handleRef,
      expiresAt: input.expiresAt,
    }),
  });
}

export async function prepareD1TemporaryClaimDelivery(input: {
  db: D1Database;
  delivery: D1TemporaryClaimDeliveryInput;
}): Promise<
  | D1PreparedTemporaryClaimDelivery
  | { ok: false; reason: "temporary_claim_binding_conflict" }
> {
  const delivery = input.delivery;
  if (!validClaimDelivery(delivery)) {
    return { ok: false, reason: "temporary_claim_binding_conflict" };
  }
  const current = await claimDeliveryRow(input.db, delivery.deploymentId);
  if (!current) {
    return { ok: false, reason: "temporary_claim_binding_conflict" };
  }
  if (current.delivery_event_id !== null || current.handle_digest !== null) {
    return claimBindingMatches(current, delivery)
      ? publicClaimDelivery(delivery, true)
      : { ok: false, reason: "temporary_claim_binding_conflict" };
  }
  if (
    current.operation_id !== delivery.operationId ||
    current.user_id !== delivery.userId ||
    current.shiplet_id !== delivery.shipletId ||
    current.target_id !== delivery.targetId ||
    current.revision_id !== delivery.revisionId ||
    current.claim_expires_at !== delivery.expiresAt ||
    current.claim_ref === null ||
    current.status !== "active" ||
    current.claim_expires_at <= delivery.now
  ) {
    return { ok: false, reason: "temporary_claim_binding_conflict" };
  }
  const timestamp = new Date(delivery.now).toISOString();
  try {
    const results = await input.db.batch([
      input.db
        .prepare(
          `UPDATE temporary_deployments
           SET status = 'claim_delivered', claim_delivered_on = ?,
             delivery_event_id = ?, delivery_started_on = ?
           WHERE id = ? AND operation_id = ? AND user_id = ?
             AND shiplet_id = ? AND target_id = ? AND revision_id = ?
             AND claim_expires_at = ? AND claim_ref IS NOT NULL
             AND status = 'active' AND delivery_event_id IS NULL
             AND delivery_started_on IS NULL`,
        )
        .bind(
          timestamp,
          delivery.deliveryEventId,
          timestamp,
          delivery.deploymentId,
          delivery.operationId,
          delivery.userId,
          delivery.shipletId,
          delivery.targetId,
          delivery.revisionId,
          delivery.expiresAt,
        ),
      input.db
        .prepare(
          `INSERT INTO backend_redirects (
            handle_digest, temporary_deployment_id, user_id, expires_at,
            consumed_on, created_on, delivery_event_id, handle_ref
          ) SELECT ?, ?, ?, ?, NULL, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM temporary_deployments
              WHERE id = ? AND operation_id = ? AND user_id = ?
                AND shiplet_id = ? AND target_id = ? AND revision_id = ?
                AND status = 'claim_delivered' AND delivery_event_id = ?
                AND delivery_started_on = ?
            )`,
        )
        .bind(
          delivery.handleDigest,
          delivery.deploymentId,
          delivery.userId,
          delivery.expiresAt,
          timestamp,
          delivery.deliveryEventId,
          delivery.handleRef,
          delivery.deploymentId,
          delivery.operationId,
          delivery.userId,
          delivery.shipletId,
          delivery.targetId,
          delivery.revisionId,
          delivery.deliveryEventId,
          timestamp,
        ),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new Error("temporary_claim_prepare_conflict");
    }
  } catch {
    const raced = await claimDeliveryRow(input.db, delivery.deploymentId);
    return raced && claimBindingMatches(raced, delivery)
      ? publicClaimDelivery(delivery, true)
      : { ok: false, reason: "temporary_claim_binding_conflict" };
  }
  return publicClaimDelivery(delivery, false);
}

export async function deliverD1PreparedTemporaryClaim(input: {
  prepared:
    | D1PreparedTemporaryClaimDelivery
    | { ok: false; reason: "temporary_claim_binding_conflict" };
  markDelivered(event: {
    operationId: string;
    deliveryEventId: string;
    deploymentId: string;
    userId: string;
    shipletId: string;
    targetId: string;
    revisionId: string;
  }): boolean | PromiseLike<boolean>;
  openRedirectHandle(ref: string): string | PromiseLike<string>;
  digest(value: string): string | PromiseLike<string>;
}) {
  if (!input.prepared.ok) return input.prepared;
  const delivery = input.prepared.delivery;
  const delivered = await input.markDelivered({
    operationId: delivery.operationId,
    deliveryEventId: delivery.deliveryEventId,
    deploymentId: delivery.deploymentId,
    userId: delivery.userId,
    shipletId: delivery.shipletId,
    targetId: delivery.targetId,
    revisionId: delivery.revisionId,
  });
  if (!delivered) {
    return { ok: false as const, reason: "claim_delivery_conflict" };
  }
  const opaqueHandle = await input.openRedirectHandle(delivery.handleRef);
  if (
    !IDENTIFIER.test(opaqueHandle) ||
    (await input.digest(opaqueHandle)) !== delivery.handleDigest
  ) {
    return { ok: false as const, reason: "claim_redirect_unavailable" };
  }
  return {
    ok: true as const,
    redirect: {
      kind: "trusted_backend_redirect" as const,
      opaqueHandle,
    },
  };
}

type TemporaryClaimRedemptionRow = {
  deployment_id: string;
  operation_id: string;
  shiplet_id: string;
  claim_ref: string;
  handle_ref: string;
  expires_at: number;
  consumed_on: string | null;
};

export async function expireD1TemporaryClaimRecords(input: {
  db: D1Database;
  now: number;
}) {
  if (!validInteger(input.now)) {
    throw new TypeError("temporary_claim_expiry_invalid");
  }
  const results = await input.db.batch([
    input.db
      .prepare(
        `UPDATE temporary_deployments
         SET status = 'expired', claim_ref = NULL
         WHERE claim_expires_at <= ? AND status IN ('active', 'claim_delivered')`,
      )
      .bind(input.now),
    input.db
      .prepare(`DELETE FROM backend_redirects WHERE expires_at <= ?`)
      .bind(input.now),
    input.db
      .prepare(
        `DELETE FROM encrypted_records
         WHERE expires_at IS NOT NULL AND expires_at <= ?
           AND id NOT IN (
             SELECT credential_ref FROM cloudflare_connections
             UNION SELECT authorization_ref FROM temporary_deployments
               WHERE authorization_ref IS NOT NULL
             UNION SELECT claim_ref FROM temporary_deployments
               WHERE claim_ref IS NOT NULL
           )`,
      )
      .bind(input.now),
  ]);
  return Object.freeze({
    expiredDeployments: results[0]?.meta.changes ?? 0,
    expiredRedirects: results[1]?.meta.changes ?? 0,
    deletedEncryptedRecords: results[2]?.meta.changes ?? 0,
  });
}

export async function redeemD1TemporaryClaimRedirect(input: {
  db: D1Database;
  opaqueHandle: string;
  now: number;
  digest(value: string): string | PromiseLike<string>;
  openClaim(ref: string): string | PromiseLike<string>;
}) {
  if (!IDENTIFIER.test(input.opaqueHandle) || !validInteger(input.now)) {
    return null;
  }
  const handleDigest = await input.digest(input.opaqueHandle);
  if (!RAW_DIGEST.test(handleDigest)) return null;
  const row = await input.db
    .prepare(
      `SELECT redirect.temporary_deployment_id AS deployment_id,
        deployment.operation_id, deployment.shiplet_id, deployment.claim_ref,
        redirect.handle_ref, redirect.expires_at, redirect.consumed_on
       FROM backend_redirects AS redirect
       JOIN temporary_deployments AS deployment
         ON deployment.id = redirect.temporary_deployment_id
       WHERE redirect.handle_digest = ?
         AND redirect.expires_at > ? AND redirect.handle_ref IS NOT NULL
         AND deployment.status = 'claim_delivered'
         AND deployment.operation_id IS NOT NULL
         AND deployment.shiplet_id IS NOT NULL
         AND deployment.claim_ref IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM encrypted_records AS claim_record
           WHERE claim_record.id = deployment.claim_ref
             AND claim_record.purpose = 'temporary_claim'
             AND claim_record.status = 'active'
             AND (claim_record.expires_at IS NULL OR claim_record.expires_at > ?)
         )
         AND EXISTS (
           SELECT 1 FROM encrypted_records AS handle_record
           WHERE handle_record.id = redirect.handle_ref
             AND handle_record.purpose = 'temporary_redirect_handle'
             AND handle_record.status = 'active'
             AND (handle_record.expires_at IS NULL OR handle_record.expires_at > ?)
         )
       LIMIT 1`,
    )
    .bind(handleDigest, input.now, input.now, input.now)
    .first<TemporaryClaimRedemptionRow>();
  if (!row) return null;

  // Opening the encrypted claim is deliberately before the one-shot CAS. A
  // transient vault failure therefore leaves the redirect retryable instead
  // of burning the only browser-visible handle.
  const location = await input.openClaim(row.claim_ref);
  if (typeof location !== "string" || location.length === 0) return null;

  if (row.consumed_on !== null) return location;

  const consumedOn = new Date(input.now).toISOString();
  const consumed = await input.db
    .prepare(
      `UPDATE backend_redirects
       SET consumed_on = ?
       WHERE handle_digest = ? AND consumed_on IS NULL AND expires_at > ?
         AND handle_ref = ? AND temporary_deployment_id = ?
         AND EXISTS (
           SELECT 1 FROM temporary_deployments
           WHERE id = ? AND operation_id = ? AND shiplet_id = ?
             AND status = 'claim_delivered' AND claim_ref = ?
         )
         AND EXISTS (
           SELECT 1 FROM encrypted_records
           WHERE id = ? AND purpose = 'temporary_claim' AND status = 'active'
             AND (expires_at IS NULL OR expires_at > ?)
         )
         AND EXISTS (
           SELECT 1 FROM encrypted_records
           WHERE id = ? AND purpose = 'temporary_redirect_handle'
             AND status = 'active'
             AND (expires_at IS NULL OR expires_at > ?)
         )`,
    )
    .bind(
      consumedOn,
      handleDigest,
      input.now,
      row.handle_ref,
      row.deployment_id,
      row.deployment_id,
      row.operation_id,
      row.shiplet_id,
      row.claim_ref,
      row.claim_ref,
      input.now,
      row.handle_ref,
      input.now,
    )
    .run();
  if (consumed.meta.changes === 1) return location;
  const replay = await input.db
    .prepare(
      `SELECT 1 AS accepted
       FROM backend_redirects AS redirect
       JOIN temporary_deployments AS deployment
         ON deployment.id = redirect.temporary_deployment_id
       WHERE redirect.handle_digest = ? AND redirect.consumed_on IS NOT NULL
         AND redirect.expires_at > ? AND redirect.handle_ref = ?
         AND deployment.id = ? AND deployment.operation_id = ?
         AND deployment.shiplet_id = ? AND deployment.status = 'claim_delivered'
         AND deployment.claim_ref = ?
         AND EXISTS (
           SELECT 1 FROM encrypted_records
           WHERE id = ? AND purpose = 'temporary_claim' AND status = 'active'
             AND (expires_at IS NULL OR expires_at > ?)
         )
         AND EXISTS (
           SELECT 1 FROM encrypted_records
           WHERE id = ? AND purpose = 'temporary_redirect_handle'
             AND status = 'active'
             AND (expires_at IS NULL OR expires_at > ?)
         )
       LIMIT 1`,
    )
    .bind(
      handleDigest,
      input.now,
      row.handle_ref,
      row.deployment_id,
      row.operation_id,
      row.shiplet_id,
      row.claim_ref,
      row.claim_ref,
      input.now,
      row.handle_ref,
      input.now,
    )
    .first<{ accepted: number }>();
  return replay?.accepted === 1 ? location : null;
}
