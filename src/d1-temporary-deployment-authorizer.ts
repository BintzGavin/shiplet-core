import type {
  ProviderAuthorization,
  TemporaryDeploymentAuthorizer,
} from "./deployment-orchestrator";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CREATE_SCOPES = Object.freeze([
  "temporary.accounts.create",
  "temporary.workers.deploy",
]);
const CLEANUP_SCOPES = Object.freeze(["temporary.workers.cleanup"]);

async function sha256(value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactScopes(
  operation: "temporary.deployment.create" | "temporary.deployment.cleanup",
  scopes: readonly string[],
) {
  const expected =
    operation === "temporary.deployment.create"
      ? CREATE_SCOPES
      : CLEANUP_SCOPES;
  return (
    scopes.length === expected.length &&
    scopes.every((scope, index) => scope === expected[index])
  );
}

function validRequest(
  request: Parameters<TemporaryDeploymentAuthorizer["authorize"]>[0],
) {
  return (
    IDENTIFIER.test(request.operationId) &&
    IDENTIFIER.test(request.userId) &&
    IDENTIFIER.test(request.shipletId) &&
    IDENTIFIER.test(request.accountHandle) &&
    IDENTIFIER.test(request.targetId) &&
    IDENTIFIER.test(request.scriptName) &&
    IDENTIFIER.test(request.revisionId) &&
    DIGEST.test(request.packageDigest) &&
    DIGEST.test(request.requestDigest) &&
    exactScopes(request.operation, request.requiredScopes)
  );
}

export async function ensureD1TemporaryDeploymentAuthoritySchema(
  db: D1Database,
) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS cloudflare_temporary_deployment_capabilities (
        id TEXT PRIMARY KEY,
        handle_digest TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        account_handle TEXT NOT NULL,
        project_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        script_name TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        package_digest TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (
          operation IN ('temporary.deployment.create', 'temporary.deployment.cleanup')
        ),
        scopes_json TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
      )`,
    )
    .run();
  const columns = await db
    .prepare("PRAGMA table_info(cloudflare_temporary_deployment_capabilities)")
    .all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "operation_id")) {
    await db
      .prepare(
        "ALTER TABLE cloudflare_temporary_deployment_capabilities ADD COLUMN operation_id TEXT",
      )
      .run();
  }
  await db.batch([
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_cloudflare_temporary_capability_scope_v2
       ON cloudflare_temporary_deployment_capabilities (
        user_id, target_id, revision_id, operation_id, operation, expires_at
       )`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS cloudflare_temporary_capability_immutable_v2
       BEFORE UPDATE ON cloudflare_temporary_deployment_capabilities
       WHEN NEW.id != OLD.id
         OR NEW.handle_digest != OLD.handle_digest
         OR NEW.user_id != OLD.user_id
         OR NEW.account_handle != OLD.account_handle
         OR NEW.project_id != OLD.project_id
         OR NEW.target_id != OLD.target_id
         OR NEW.script_name != OLD.script_name
         OR NEW.revision_id != OLD.revision_id
         OR NEW.package_digest != OLD.package_digest
         OR NEW.operation_id != OLD.operation_id
         OR NEW.operation != OLD.operation
         OR NEW.scopes_json != OLD.scopes_json
         OR NEW.request_digest != OLD.request_digest
         OR NEW.expires_at != OLD.expires_at
         OR NEW.created_at != OLD.created_at
         OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
         OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL)
       BEGIN SELECT RAISE(ABORT, 'temporary deployment capability is immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS cloudflare_temporary_capability_no_delete
       BEFORE DELETE ON cloudflare_temporary_deployment_capabilities
       BEGIN SELECT RAISE(ABORT, 'temporary deployment capability is immutable'); END`,
    ),
  ]);
}

export function createD1TemporaryDeploymentAuthorizer(input: {
  db: D1Database;
  now: () => number;
}): TemporaryDeploymentAuthorizer {
  return Object.freeze({
    async authorize(
      request: Parameters<TemporaryDeploymentAuthorizer["authorize"]>[0],
    ) {
      const now = input.now();
      if (!Number.isSafeInteger(now) || !validRequest(request)) {
        return {
          ok: false as const,
          reason: "temporary_capability_denied",
        };
      }
      const configuration = await input.db
        .prepare(
          `SELECT target.project_id, target.configuration_json,
                  revision.package_digest
           FROM deployment_targets target
           JOIN shiplet_revisions revision
             ON revision.id = ? AND revision.project_id = target.project_id
           JOIN projects project
             ON project.id = target.project_id
           WHERE target.id = ?
             AND target.project_id = ?
             AND target.kind = 'temporary_claim'
             AND target.owner_kind = 'human'
             AND target.owner_id = ?
             AND target.provider_account_id = ?
             AND target.detached_on IS NULL
             AND project.active_revision_id = revision.id
           LIMIT 1`,
        )
        .bind(
          request.revisionId,
          request.targetId,
          request.shipletId,
          request.userId,
          request.accountHandle,
        )
        .first<{
          project_id: string;
          configuration_json: string;
          package_digest: string;
        }>();
      if (!configuration) {
        return {
          ok: false as const,
          reason: "temporary_capability_denied",
        };
      }
      let targetConfiguration: Record<string, unknown>;
      try {
        targetConfiguration = JSON.parse(
          configuration.configuration_json,
        ) as Record<string, unknown>;
      } catch {
        return {
          ok: false as const,
          reason: "temporary_capability_denied",
        };
      }
      if (
        configuration.project_id !== request.shipletId ||
        targetConfiguration.scriptName !== request.scriptName ||
        targetConfiguration.status !== "connected" ||
        request.packageDigest !== `sha256:${configuration.package_digest}`
      ) {
        return {
          ok: false as const,
          reason: "temporary_capability_denied",
        };
      }
      const handle = `temporary_grant_${crypto.randomUUID()}`;
      const expiresAt = now + 30_000;
      const stored = await input.db
        .prepare(
          `INSERT INTO cloudflare_temporary_deployment_capabilities (
            id, handle_digest, user_id, account_handle, project_id, target_id,
            script_name, revision_id, package_digest, operation_id, operation,
            scopes_json, request_digest, expires_at, revoked_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .bind(
          `temporary_capability_${crypto.randomUUID()}`,
          await sha256(handle),
          request.userId,
          request.accountHandle,
          configuration.project_id,
          request.targetId,
          request.scriptName,
          request.revisionId,
          request.packageDigest,
          request.operationId,
          request.operation,
          JSON.stringify([...request.requiredScopes]),
          request.requestDigest,
          expiresAt,
          now,
        )
        .run();
      if (stored.meta.changes !== 1) {
        return {
          ok: false as const,
          reason: "temporary_capability_denied",
        };
      }
      const authorization: ProviderAuthorization = Object.freeze({
        handle,
        userId: request.userId,
        shipletId: request.shipletId,
        accountId: request.accountHandle,
        expiresAt,
        operation: request.operation,
        scopes: Object.freeze([
          ...request.requiredScopes,
        ]) as unknown as string[],
        targetId: request.targetId,
        scriptName: request.scriptName,
        revisionId: request.revisionId,
        packageDigest: request.packageDigest,
        requestDigest: request.requestDigest,
        operationId: request.operationId,
      });
      return Object.freeze({ ok: true as const, authorization });
    },
  });
}
