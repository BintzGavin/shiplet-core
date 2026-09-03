import { reconcileOAuthRevocationCleanup } from "./revocation-reconciler";

type RevocationCredentialStatus = "active" | "cleanup" | "retired";

export async function listD1PendingCloudflareRevocations(
  db: D1Database,
  limit: number,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("cloudflare_revocation_limit_invalid");
  }
  const rows = await db
    .prepare(
      `SELECT connection.id AS connection_id
       FROM cloudflare_connections AS connection
       JOIN encrypted_records AS credential
         ON credential.id = connection.credential_ref
       WHERE connection.status = 'revoked'
         AND credential.status IN ('active', 'cleanup')
       ORDER BY COALESCE(connection.revoked_at, 0), connection.id
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ connection_id: string }>();
  return rows.results.map((row) => ({ connectionId: row.connection_id }));
}

export async function getD1CloudflareRevocationCredentialStatus(
  db: D1Database,
  connectionId: string,
  userId: string,
): Promise<RevocationCredentialStatus | null> {
  const row = await db
    .prepare(
      `SELECT credential.status
       FROM cloudflare_connections AS connection
       JOIN encrypted_records AS credential
         ON credential.id = connection.credential_ref
       WHERE connection.id = ? AND connection.user_id = ?
         AND connection.status = 'revoked'
         AND credential.purpose = 'oauth_credential'
       LIMIT 1`,
    )
    .bind(connectionId, userId)
    .first<{ status: RevocationCredentialStatus }>();
  return row?.status ?? null;
}

type ReconcilerInput = Parameters<typeof reconcileOAuthRevocationCleanup>[0];

export async function reconcileD1CloudflareRevocationForRpc(input: {
  db: D1Database;
  connectionId: string;
  userId: string;
  retryRevocationCleanup: ReconcilerInput["retryRevocationCleanup"];
  audit: ReconcilerInput["audit"];
  now: ReconcilerInput["now"];
}) {
  const current = await getD1CloudflareRevocationCredentialStatus(
    input.db,
    input.connectionId,
    input.userId,
  );
  if (current === null) {
    return { ok: false as const, reason: "revocation_state_unavailable" };
  }
  if (current === "retired") return { ok: true as const };

  await reconcileOAuthRevocationCleanup({
    listPending: async () => [{ connectionId: input.connectionId }],
    retryRevocationCleanup: input.retryRevocationCleanup,
    audit: input.audit,
    now: input.now,
  });
  const reconciled = await getD1CloudflareRevocationCredentialStatus(
    input.db,
    input.connectionId,
    input.userId,
  );
  return reconciled === "retired"
    ? { ok: true as const }
    : { ok: false as const, reason: "revocation_cleanup_required" };
}
