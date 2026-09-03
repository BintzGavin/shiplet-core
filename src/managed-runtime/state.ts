const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const STATE_NAMESPACE = /^state-[A-Za-z0-9_-]{43}$/;
const STATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const STATE_ENDPOINT = "https://shiplet-state.invalid/v1";
const MAX_REQUEST_BYTES = 40 * 1024;
const MAX_VALUE_BYTES = 32 * 1024;
const NAMESPACE_QUOTA_BYTES = 256 * 1024;
const NAMESPACE_ENTRY_LIMIT = 128;
const MAX_SEQUENCE = 64;

export type ManagedRuntimeStatePermission = "read" | "write";
export type ManagedRuntimeStateMode = "none" | "read" | "write" | "read_write";

export type ManagedRuntimeStateRequestContext = Readonly<{
  schemaVersion: "shiplet.managed-state-context/v1";
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  activationGeneration: number;
  stateNamespace: string;
  stateMode: ManagedRuntimeStateMode;
  invocationKind: "active" | "preview";
  invocationId: string;
  actor: Readonly<{
    kind: "human" | "agent" | "shiplet" | "system";
    id: string;
  }>;
}>;

type RuntimeDatabase = Pick<D1Database, "prepare" | "batch">;

type StateRevisionRow = {
  shiplet_id: string;
  revision_id: string;
  package_digest: string;
  state_scope_namespace: string | null;
  state_permissions_json: string;
  stage_status: string;
};

type StateEntryRow = {
  authorized: number;
  value_json: string | null;
  version: number | null;
};

type StateAuthority = Readonly<{
  sql: string;
  bindings: readonly (string | number)[];
}>;

type StateRequest =
  | Readonly<{
      schemaVersion: "shiplet.managed-state-request/v1";
      operation: "get" | "delete";
      sequence: number;
      key: string;
    }>
  | Readonly<{
      schemaVersion: "shiplet.managed-state-request/v1";
      operation: "put";
      sequence: number;
      key: string;
      value: unknown;
      valueJson: string;
      valueBytes: number;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function exactPermissions(
  value: unknown,
): readonly ManagedRuntimeStatePermission[] | null {
  if (!Array.isArray(value) || value.length > 2) return null;
  if (value.some((item) => item !== "read" && item !== "write")) return null;
  const normalized = [...new Set(value)].sort();
  if (
    normalized.length !== value.length ||
    normalized.join(",") !== value.join(",")
  ) {
    return null;
  }
  return Object.freeze(normalized as ManagedRuntimeStatePermission[]);
}

export function managedRuntimeStatePermissions(
  requestedCapabilities: readonly string[],
): readonly ManagedRuntimeStatePermission[] {
  const result: ManagedRuntimeStatePermission[] = [];
  if (
    requestedCapabilities.includes("state.read") ||
    requestedCapabilities.includes("state.read:review")
  ) {
    result.push("read");
  }
  if (requestedCapabilities.includes("state.write")) result.push("write");
  return Object.freeze(result);
}

export function extractManagedRuntimeStatePermissions(
  modules: readonly Readonly<{
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
  }>[],
  mainModule: string,
) {
  if (mainModule !== "__shiplet_runtime.mjs") {
    throw new TypeError("managed_state_declaration_invalid");
  }
  const wrapper = modules.find((module) => module.name === mainModule);
  if (!wrapper || wrapper.encoding === "base64") {
    throw new TypeError("managed_state_declaration_invalid");
  }
  const matches = [
    ...wrapper.content.matchAll(
      /^const STATE_PERMISSIONS = Object\.freeze\((\[[^\n]*\])\);$/gm,
    ),
  ];
  if (matches.length !== 1) {
    throw new TypeError("managed_state_declaration_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0]![1]!);
  } catch {
    throw new TypeError("managed_state_declaration_invalid");
  }
  const permissions = exactPermissions(parsed);
  if (!permissions) throw new TypeError("managed_state_declaration_invalid");
  return permissions;
}

export function managedRuntimeStateMode(
  permissions: readonly ManagedRuntimeStatePermission[],
  invocationKind: "active" | "preview",
): ManagedRuntimeStateMode {
  const exact = exactPermissions(permissions);
  if (!exact) throw new TypeError("managed_state_permissions_invalid");
  const read = exact.includes("read");
  const write = invocationKind === "active" && exact.includes("write");
  return read && write
    ? "read_write"
    : read
      ? "read"
      : write
        ? "write"
        : "none";
}

async function digest(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function response(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function denied(status = 403, code = "managed_state_denied") {
  return response(
    {
      schemaVersion: "shiplet.managed-state-response/v1",
      ok: false,
      code,
    },
    status,
  );
}

async function readBounded(request: Request) {
  const declared = request.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)
  ) {
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  if (length === 0) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function parseRequest(request: Request): Promise<StateRequest | null> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (
    url.href !== STATE_ENDPOINT ||
    request.method !== "POST" ||
    request.headers.get("content-type")?.toLowerCase() !== "application/json"
  ) {
    return null;
  }
  const bytes = await readBounded(request);
  if (!bytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== "shiplet.managed-state-request/v1" ||
    (value.operation !== "get" &&
      value.operation !== "put" &&
      value.operation !== "delete") ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) <= 0 ||
    (value.sequence as number) > MAX_SEQUENCE ||
    typeof value.key !== "string" ||
    !STATE_KEY.test(value.key)
  ) {
    return null;
  }
  if (value.operation === "put") {
    if (
      !exactKeys(value, [
        "schemaVersion",
        "operation",
        "sequence",
        "key",
        "value",
      ])
    ) {
      return null;
    }
    let valueJson: string | undefined;
    try {
      valueJson = JSON.stringify(value.value);
    } catch {
      return null;
    }
    if (valueJson === undefined) return null;
    const valueBytes = new TextEncoder().encode(valueJson).byteLength;
    if (valueBytes === 0 || valueBytes > MAX_VALUE_BYTES) {
      return Object.freeze({
        schemaVersion: value.schemaVersion,
        operation: value.operation,
        sequence: value.sequence as number,
        key: value.key,
        value: value.value,
        valueJson,
        valueBytes,
      });
    }
    return Object.freeze({
      schemaVersion: value.schemaVersion,
      operation: value.operation,
      sequence: value.sequence as number,
      key: value.key,
      value: value.value,
      valueJson,
      valueBytes,
    });
  }
  if (!exactKeys(value, ["schemaVersion", "operation", "sequence", "key"])) {
    return null;
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    operation: value.operation,
    sequence: value.sequence as number,
    key: value.key,
  });
}

function validContext(value: ManagedRuntimeStateRequestContext) {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "schemaVersion",
      "shipletId",
      "revisionId",
      "packageDigest",
      "activationGeneration",
      "stateNamespace",
      "stateMode",
      "invocationKind",
      "invocationId",
      "actor",
    ]) &&
    value.schemaVersion === "shiplet.managed-state-context/v1" &&
    IDENTIFIER.test(value.shipletId) &&
    IDENTIFIER.test(value.revisionId) &&
    PACKAGE_DIGEST.test(value.packageDigest) &&
    Number.isSafeInteger(value.activationGeneration) &&
    value.activationGeneration > 0 &&
    STATE_NAMESPACE.test(value.stateNamespace) &&
    ["none", "read", "write", "read_write"].includes(value.stateMode) &&
    (value.invocationKind === "active" || value.invocationKind === "preview") &&
    IDENTIFIER.test(value.invocationId) &&
    isRecord(value.actor) &&
    exactKeys(value.actor, ["kind", "id"]) &&
    value.actor.kind === "shiplet" &&
    value.actor.id === value.shipletId
  );
}

function parseStoredPermissions(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  return exactPermissions(parsed);
}

function modeAllowed(
  mode: ManagedRuntimeStateMode,
  permissions: readonly ManagedRuntimeStatePermission[],
  invocationKind: "active" | "preview",
) {
  const read = permissions.includes("read");
  const write = invocationKind === "active" && permissions.includes("write");
  return (
    mode ===
    (read && write ? "read_write" : read ? "read" : write ? "write" : "none")
  );
}

async function authorizedContext(
  db: RuntimeDatabase,
  context: ManagedRuntimeStateRequestContext,
) {
  if (!validContext(context) || context.stateMode === "none") return false;
  const revision = await db
    .prepare(
      `SELECT shiplet_id, revision_id, package_digest, state_scope_namespace,
              state_permissions_json, stage_status
       FROM managed_revisions
       WHERE shiplet_id = ? AND revision_id = ? AND stage_status = 'validated'`,
    )
    .bind(context.shipletId, context.revisionId)
    .first<StateRevisionRow>();
  const permissions = revision
    ? parseStoredPermissions(revision.state_permissions_json)
    : null;
  if (
    !revision ||
    revision.shiplet_id !== context.shipletId ||
    revision.revision_id !== context.revisionId ||
    revision.package_digest !== context.packageDigest ||
    revision.state_scope_namespace !== context.stateNamespace ||
    !permissions ||
    !modeAllowed(context.stateMode, permissions, context.invocationKind)
  ) {
    return false;
  }
  const namespace = await db
    .prepare(
      `SELECT shiplet_id FROM managed_runtime_state_namespaces
       WHERE state_namespace = ? AND scope_kind = 'shiplet'`,
    )
    .bind(context.stateNamespace)
    .first<{ shiplet_id: string }>();
  if (namespace?.shiplet_id !== context.shipletId) return false;
  if (context.invocationKind === "preview") {
    return context.activationGeneration === 1 && context.stateMode === "read";
  }
  const authority = exactStateAuthority(
    context,
    context.stateMode === "write" ? "write" : "read",
  );
  const active = await db
    .prepare(`SELECT 1 AS authorized WHERE ${authority.sql}`)
    .bind(...authority.bindings)
    .first<{ authorized: number }>();
  return active?.authorized === 1;
}

function canRead(mode: ManagedRuntimeStateMode) {
  return mode === "read" || mode === "read_write";
}

function canWrite(mode: ManagedRuntimeStateMode) {
  return mode === "write" || mode === "read_write";
}

function exactStateAuthority(
  context: ManagedRuntimeStateRequestContext,
  effect: "read" | "write",
): StateAuthority {
  const permissions =
    effect === "read"
      ? `r.state_permissions_json IN ('["read"]', '["read","write"]')`
      : `r.state_permissions_json IN ('["write"]', '["read","write"]')`;
  const activation =
    context.invocationKind === "active"
      ? `AND EXISTS (
           SELECT 1 FROM managed_activations a
           WHERE a.shiplet_id = r.shiplet_id
             AND (
               (
                 a.revision_id = r.revision_id
                 AND a.package_digest = r.package_digest
                 AND a.generation = ?
               )
               OR (
                 a.operation_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1 FROM managed_activation_history history
                   WHERE history.id = a.operation_id
                     AND history.shiplet_id = a.shiplet_id
                     AND history.to_revision_id = a.revision_id
                     AND history.to_generation = a.generation
                     AND history.from_revision_id = r.revision_id
                     AND history.from_generation = ?
                 )
                 AND EXISTS (
                   SELECT 1 FROM managed_revisions candidate
                   WHERE candidate.shiplet_id = a.shiplet_id
                     AND candidate.revision_id = a.revision_id
                     AND candidate.package_digest = a.package_digest
                     AND candidate.script_name = a.script_name
                     AND candidate.stage_status = 'validated'
                 )
               )
             )
         )`
      : `AND ? = 1`;
  return Object.freeze({
    sql: `EXISTS (
      SELECT 1
      FROM managed_revisions r
      JOIN managed_runtime_state_namespaces n
        ON n.state_namespace = r.state_scope_namespace
       AND n.shiplet_id = r.shiplet_id
       AND n.scope_kind = 'shiplet'
      WHERE r.shiplet_id = ?
        AND r.revision_id = ?
        AND r.package_digest = ?
        AND r.state_scope_namespace = ?
        AND r.stage_status = 'validated'
        AND ${permissions}
        ${activation}
    )`,
    bindings: Object.freeze([
      context.shipletId,
      context.revisionId,
      context.packageDigest,
      context.stateNamespace,
      context.activationGeneration,
      ...(context.invocationKind === "active"
        ? [context.activationGeneration]
        : []),
    ]),
  });
}

async function operationRecord(input: {
  context: ManagedRuntimeStateRequestContext;
  request: StateRequest;
  outcome: "applied" | "hit" | "missing";
}) {
  const effect = input.request.operation === "get" ? "read" : "write";
  return Object.freeze({
    id: `state_${await digest(
      [
        input.context.invocationId,
        String(input.request.sequence),
        input.request.operation,
        input.request.key,
      ].join("\u0000"),
    )}`,
    keyDigest: await digest(input.request.key),
    effect,
    outcome: input.outcome,
  });
}

function conditionalAuditStatement(
  db: RuntimeDatabase,
  input: {
    context: ManagedRuntimeStateRequestContext;
    request: StateRequest;
    operation: Awaited<ReturnType<typeof operationRecord>>;
    occurredOn: string;
    authority: StateAuthority;
    outcome: "put" | "get" | "delete";
  },
) {
  const dynamicOutcome = input.outcome !== "put";
  const outcomeSql = dynamicOutcome
    ? `CASE WHEN EXISTS (
         SELECT 1 FROM managed_runtime_state_entries
         WHERE state_namespace = ? AND state_key = ?
       ) THEN '${input.outcome === "get" ? "hit" : "applied"}' ELSE 'missing' END`
    : `'applied'`;
  const correlatedPut =
    input.outcome === "put"
      ? `AND EXISTS (
           SELECT 1 FROM managed_runtime_state_entries
           WHERE state_namespace = ? AND state_key = ?
             AND last_operation_id = ?
         )`
      : "";
  return db
    .prepare(
      `INSERT INTO managed_runtime_state_operations (
         id, invocation_id, sequence, state_namespace, actor_kind, actor_id,
         shiplet_id, revision_id, package_digest, activation_generation,
         invocation_kind, effect, operation, outcome, key_digest, occurred_on
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${outcomeSql}, ?, ?
         WHERE ${input.authority.sql}
         ${correlatedPut}`,
    )
    .bind(
      input.operation.id,
      input.context.invocationId,
      input.request.sequence,
      input.context.stateNamespace,
      input.context.actor.kind,
      input.context.actor.id,
      input.context.shipletId,
      input.context.revisionId,
      input.context.packageDigest,
      input.context.activationGeneration,
      input.context.invocationKind,
      input.operation.effect,
      input.request.operation,
      ...(dynamicOutcome
        ? [input.context.stateNamespace, input.request.key]
        : []),
      input.operation.keyDigest,
      input.occurredOn,
      ...input.authority.bindings,
      ...(input.outcome === "put"
        ? [input.context.stateNamespace, input.request.key, input.operation.id]
        : []),
    );
}

function authorizedEntryStatement(
  db: RuntimeDatabase,
  context: ManagedRuntimeStateRequestContext,
  key: string,
  authority: StateAuthority,
) {
  return db
    .prepare(
      `SELECT 1 AS authorized, entry.value_json, entry.version
       FROM (SELECT 1 WHERE ${authority.sql}) exact_authority
       LEFT JOIN managed_runtime_state_entries entry
         ON entry.state_namespace = ? AND entry.state_key = ?`,
    )
    .bind(...authority.bindings, context.stateNamespace, key);
}

async function replayed(
  db: RuntimeDatabase,
  context: ManagedRuntimeStateRequestContext,
  sequence: number,
) {
  const row = await db
    .prepare(
      `SELECT id FROM managed_runtime_state_operations
       WHERE invocation_id = ? AND sequence = ?`,
    )
    .bind(context.invocationId, sequence)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function ensureManagedRuntimeStateNamespace(input: {
  db: RuntimeDatabase;
  stateNamespace: string;
  shipletId: string;
}) {
  if (
    !STATE_NAMESPACE.test(input.stateNamespace) ||
    !IDENTIFIER.test(input.shipletId)
  ) {
    throw new TypeError("managed_state_namespace_invalid");
  }
  const now = new Date().toISOString();
  await input.db
    .prepare(
      `INSERT INTO managed_runtime_state_namespaces (
         state_namespace, shiplet_id, scope_kind, quota_bytes, entry_limit,
         bytes_used, entry_count, created_on, updated_on
       ) VALUES (?, ?, 'shiplet', ?, ?, 0, 0, ?, ?)
       ON CONFLICT(state_namespace) DO NOTHING`,
    )
    .bind(
      input.stateNamespace,
      input.shipletId,
      NAMESPACE_QUOTA_BYTES,
      NAMESPACE_ENTRY_LIMIT,
      now,
      now,
    )
    .run();
  const exact = await input.db
    .prepare(
      `SELECT shiplet_id, scope_kind, quota_bytes, entry_limit
       FROM managed_runtime_state_namespaces WHERE state_namespace = ?`,
    )
    .bind(input.stateNamespace)
    .first<{
      shiplet_id: string;
      scope_kind: string;
      quota_bytes: number;
      entry_limit: number;
    }>();
  if (
    exact?.shiplet_id !== input.shipletId ||
    exact.scope_kind !== "shiplet" ||
    exact.quota_bytes !== NAMESPACE_QUOTA_BYTES ||
    exact.entry_limit !== NAMESPACE_ENTRY_LIMIT
  ) {
    throw new Error("managed_state_namespace_conflict");
  }
  return Object.freeze({ ok: true as const });
}

export async function handleManagedRuntimeStateRequest(input: {
  db: RuntimeDatabase;
  request: Request;
  context: ManagedRuntimeStateRequestContext;
}) {
  if (!(input.request instanceof Request)) return denied();
  const stateRequest = await parseRequest(input.request);
  if (!stateRequest) return denied();
  if (
    stateRequest.operation === "put" &&
    stateRequest.valueBytes > MAX_VALUE_BYTES
  ) {
    return denied(413, "managed_state_value_too_large");
  }
  if (!(await authorizedContext(input.db, input.context))) return denied();
  if (
    (stateRequest.operation === "get" && !canRead(input.context.stateMode)) ||
    (stateRequest.operation !== "get" && !canWrite(input.context.stateMode))
  ) {
    return denied();
  }
  if (await replayed(input.db, input.context, stateRequest.sequence)) {
    return denied(409, "managed_state_replay");
  }
  const now = new Date().toISOString();
  if (stateRequest.operation === "get") {
    const authority = exactStateAuthority(input.context, "read");
    const operation = await operationRecord({
      context: input.context,
      request: stateRequest,
      outcome: "missing",
    });
    try {
      const results = await input.db.batch([
        authorizedEntryStatement(
          input.db,
          input.context,
          stateRequest.key,
          authority,
        ),
        conditionalAuditStatement(input.db, {
          context: input.context,
          request: stateRequest,
          operation,
          occurredOn: now,
          authority,
          outcome: "get",
        }),
      ]);
      const entry = results[0]?.results[0] as StateEntryRow | undefined;
      if (!entry || results[1]?.meta.changes !== 1) {
        return denied();
      }
      const found = typeof entry.value_json === "string";
      return response({
        schemaVersion: "shiplet.managed-state-response/v1",
        ok: true,
        operation: "get",
        found,
        ...(found
          ? {
              value: JSON.parse(entry.value_json as string) as unknown,
              version: entry.version,
            }
          : {}),
      });
    } catch {
      if (await replayed(input.db, input.context, stateRequest.sequence)) {
        return denied(409, "managed_state_replay");
      }
      return denied(503, "managed_state_unavailable");
    }
  }

  if (stateRequest.operation === "put") {
    const authority = exactStateAuthority(input.context, "write");
    const operation = await operationRecord({
      context: input.context,
      request: stateRequest,
      outcome: "applied",
    });
    try {
      const results = await input.db.batch([
        input.db
          .prepare(
            `INSERT INTO managed_runtime_state_entries (
               state_namespace, state_key, value_json, value_bytes, version,
               updated_on, last_operation_id
             ) SELECT ?, ?, ?, ?, 1, ?, ?
               WHERE ${authority.sql}
             ON CONFLICT(state_namespace, state_key) DO UPDATE SET
               value_json = excluded.value_json,
               value_bytes = excluded.value_bytes,
               version = managed_runtime_state_entries.version + 1,
               updated_on = excluded.updated_on,
               last_operation_id = excluded.last_operation_id
             RETURNING version`,
          )
          .bind(
            input.context.stateNamespace,
            stateRequest.key,
            stateRequest.valueJson,
            stateRequest.valueBytes,
            now,
            operation.id,
            ...authority.bindings,
          ),
        conditionalAuditStatement(input.db, {
          context: input.context,
          request: stateRequest,
          operation,
          occurredOn: now,
          authority,
          outcome: "put",
        }),
      ]);
      const version = (
        results[0]?.results[0] as { version?: unknown } | undefined
      )?.version;
      if (results[0]?.results.length === 0 && results[1]?.meta.changes === 0) {
        return denied();
      }
      if (!Number.isSafeInteger(version) || (version as number) <= 0) {
        throw new Error("managed_state_result_invalid");
      }
      if (results[1]?.meta.changes !== 1) {
        throw new Error("managed_state_audit_invalid");
      }
      return response({
        schemaVersion: "shiplet.managed-state-response/v1",
        ok: true,
        operation: "put",
        version,
      });
    } catch (error) {
      if (await replayed(input.db, input.context, stateRequest.sequence)) {
        return denied(409, "managed_state_replay");
      }
      if (
        error instanceof Error &&
        /managed runtime state quota exceeded/i.test(error.message)
      ) {
        return denied(429, "managed_state_quota_exceeded");
      }
      return denied(503, "managed_state_unavailable");
    }
  }

  const authority = exactStateAuthority(input.context, "write");
  const operation = await operationRecord({
    context: input.context,
    request: stateRequest,
    outcome: "missing",
  });
  try {
    const results = await input.db.batch([
      authorizedEntryStatement(
        input.db,
        input.context,
        stateRequest.key,
        authority,
      ),
      conditionalAuditStatement(input.db, {
        context: input.context,
        request: stateRequest,
        operation,
        occurredOn: now,
        authority,
        outcome: "delete",
      }),
      input.db
        .prepare(
          `DELETE FROM managed_runtime_state_entries
           WHERE state_namespace = ? AND state_key = ?
             AND ${authority.sql}
           RETURNING version`,
        )
        .bind(
          input.context.stateNamespace,
          stateRequest.key,
          ...authority.bindings,
        ),
    ]);
    const entry = results[0]?.results[0] as StateEntryRow | undefined;
    if (!entry || results[1]?.meta.changes !== 1) {
      return denied();
    }
    const deleted = results[2]?.results.length === 1;
    return response({
      schemaVersion: "shiplet.managed-state-response/v1",
      ok: true,
      operation: "delete",
      deleted,
    });
  } catch {
    if (await replayed(input.db, input.context, stateRequest.sequence)) {
      return denied(409, "managed_state_replay");
    }
    return denied(503, "managed_state_unavailable");
  }
}
