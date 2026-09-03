import {
  attestD1CredentialContinuity,
  initializeD1CredentialContinuity,
} from "./d1-vault";

const BACKLOG_BOUND = 101;
const REQUIRED_TABLES = Object.freeze([
  "encrypted_records",
  "oauth_flows",
  "oauth_start_reservations",
  "cloudflare_oauth_state_refs",
  "cloudflare_connections",
  "cloudflare_refresh_reservations",
  "grant_consumptions",
  "temporary_grant_consumptions",
  "temporary_deployments",
  "backend_redirects",
  "temporary_provider_operations",
  "oauth_provider_exchange_recoveries",
  "cloudflare_control_audit_outbox",
  "control_audit_outbox",
  "credential_continuity",
  "support_reconciliation_runs",
  "managed_deployment_operations",
  "managed_platform_connection_reservations",
  "managed_platform_connection_retirements",
  "managed_platform_operation_leases",
]);

type BacklogCounts = {
  cleanup_pending: number;
  revocation_pending: number;
  temporary_ambiguous: number;
  temporary_ambiguity_expired: number;
};

type ReconciliationRow = {
  status: "running" | "success" | "failure";
  started_at: number;
  completed_at: number | null;
  error_code: string | null;
};

function validClock(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function boundedBacklogs(db: D1Database): Promise<BacklogCounts> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM (
          SELECT 1 FROM temporary_provider_operations
          WHERE state = 'cleanup_pending'
          UNION ALL
          SELECT 1 FROM oauth_provider_exchange_recoveries
          WHERE status IN ('staged', 'cleaning')
          LIMIT ${BACKLOG_BOUND}
        )) AS cleanup_pending,
        (SELECT COUNT(*) FROM (
          SELECT 1 FROM cloudflare_connections AS connection
          JOIN encrypted_records AS credential
            ON credential.id = connection.credential_ref
          WHERE connection.status = 'revoked'
            AND credential.status IN ('active', 'cleanup')
          LIMIT ${BACKLOG_BOUND}
        )) AS revocation_pending,
        (SELECT COUNT(*) FROM (
          SELECT 1 FROM temporary_provider_operations
          WHERE state = 'provisioning' LIMIT ${BACKLOG_BOUND}
        )) AS temporary_ambiguous,
        (SELECT COUNT(*) FROM (
          SELECT 1 FROM temporary_provider_operations
          WHERE state = 'ambiguity_expired' LIMIT ${BACKLOG_BOUND}
        )) AS temporary_ambiguity_expired`,
    )
    .first<BacklogCounts>();
  if (
    !row ||
    Object.values(row).some(
      (value) =>
        !Number.isSafeInteger(value) || value < 0 || value > BACKLOG_BOUND,
    )
  ) {
    throw new Error("support_health_backlog_invalid");
  }
  return row;
}

async function schemaReady(db: D1Database) {
  const placeholders = REQUIRED_TABLES.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name IN (${placeholders})`,
    )
    .bind(...REQUIRED_TABLES)
    .first<{ count: number }>();
  return result?.count === REQUIRED_TABLES.length;
}

export async function runD1SupportReconciliation<Result>(input: {
  db: D1Database;
  encodedKey: string;
  now: number;
  reconcile(): Result | PromiseLike<Result>;
}) {
  if (!validClock(input.now)) {
    throw new TypeError("support_reconciliation_clock_invalid");
  }
  const continuity = await initializeD1CredentialContinuity({
    db: input.db,
    encodedKey: input.encodedKey,
    now: input.now,
  });
  if (!continuity.ok) {
    throw new Error("credential_continuity_unavailable");
  }
  const runId = `support_reconciliation_${crypto.randomUUID()}`;
  await input.db
    .prepare(
      `INSERT INTO support_reconciliation_runs (
        run_id, status, started_at, completed_at, error_code,
        cleanup_pending, revocation_pending, temporary_ambiguous,
        temporary_ambiguity_expired
      ) VALUES (?, 'running', ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
    )
    .bind(runId, input.now)
    .run();
  try {
    const result = await input.reconcile();
    const backlog = await boundedBacklogs(input.db);
    const completed = await input.db
      .prepare(
        `UPDATE support_reconciliation_runs
         SET status = 'success', completed_at = ?,
           cleanup_pending = ?, revocation_pending = ?,
           temporary_ambiguous = ?, temporary_ambiguity_expired = ?
         WHERE run_id = ? AND status = 'running'`,
      )
      .bind(
        input.now,
        backlog.cleanup_pending,
        backlog.revocation_pending,
        backlog.temporary_ambiguous,
        backlog.temporary_ambiguity_expired,
        runId,
      )
      .run();
    if (completed.meta.changes !== 1) {
      throw new Error("support_reconciliation_record_failed");
    }
    return result;
  } catch (error) {
    try {
      await input.db
        .prepare(
          `UPDATE support_reconciliation_runs
           SET status = 'failure', completed_at = ?,
             error_code = 'scheduled_reconciliation_failed'
           WHERE run_id = ? AND status = 'running'`,
        )
        .bind(input.now, runId)
        .run();
    } catch {
      // The original failure remains authoritative. Health will treat a stale
      // running record as degraded rather than inventing success.
    }
    throw error;
  }
}

export async function readD1SupportHealth(input: {
  db: D1Database;
  encodedKey: string;
  now: number;
  maxFreshnessMs: number;
  release: { versionId: string; versionTag: string };
}) {
  if (
    !validClock(input.now) ||
    !Number.isSafeInteger(input.maxFreshnessMs) ||
    input.maxFreshnessMs < 60_000 ||
    input.maxFreshnessMs > 86_400_000
  ) {
    throw new TypeError("support_health_request_invalid");
  }
  let ready = false;
  let continuity: "verified" | "unavailable" = "unavailable";
  let backlog: BacklogCounts = {
    cleanup_pending: BACKLOG_BOUND,
    revocation_pending: BACKLOG_BOUND,
    temporary_ambiguous: BACKLOG_BOUND,
    temporary_ambiguity_expired: BACKLOG_BOUND,
  };
  let reconciliation: ReconciliationRow | null = null;
  try {
    ready = await schemaReady(input.db);
    if (ready) {
      const attestation = await attestD1CredentialContinuity(input);
      continuity = attestation.ok ? "verified" : "unavailable";
      backlog = await boundedBacklogs(input.db);
      reconciliation = await input.db
        .prepare(
          `SELECT status, started_at, completed_at, error_code
           FROM support_reconciliation_runs
           ORDER BY started_at DESC, run_id DESC LIMIT 1`,
        )
        .first<ReconciliationRow>();
    }
  } catch {
    ready = false;
    continuity = "unavailable";
  }
  const reconciliationFresh =
    reconciliation?.status === "success" &&
    reconciliation.completed_at !== null &&
    reconciliation.completed_at <= input.now &&
    input.now - reconciliation.completed_at <= input.maxFreshnessMs;
  const degraded =
    !ready ||
    continuity !== "verified" ||
    !reconciliationFresh ||
    Object.values(backlog).some((count) => count > 0);
  return Object.freeze({
    schemaVersion: "shiplet.support-health/v1" as const,
    status: degraded ? ("degraded" as const) : ("healthy" as const),
    schemaReady: ready,
    credentialContinuity: continuity,
    reconciliation: Object.freeze({
      status: reconciliation?.status ?? ("missing" as const),
      fresh: reconciliationFresh,
      completedAt: reconciliation?.completed_at ?? null,
    }),
    backlog: Object.freeze({
      cleanupPending: backlog.cleanup_pending,
      revocationPending: backlog.revocation_pending,
      temporaryAmbiguous: backlog.temporary_ambiguous,
      temporaryAmbiguityExpired: backlog.temporary_ambiguity_expired,
      boundedAt: BACKLOG_BOUND,
    }),
    release: Object.freeze({ ...input.release }),
  });
}

export type SupportHealthAttestation = Awaited<
  ReturnType<typeof readD1SupportHealth>
>;
