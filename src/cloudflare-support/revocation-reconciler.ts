const MAX_REVOCATION_CLEANUP_BATCH = 25;

type RetryResult =
  | { ok: true; status: "cleaned" | "expired_cleanup_complete" }
  | { ok: false; reason: string };

type CleanupAuditEvent =
  | Readonly<{
      eventKind: "cloudflare.oauth.revocation_cleanup_requested";
      connectionId: string;
      outcome: "retry_started";
      occurredAt: number;
    }>
  | Readonly<{
      eventKind: "cloudflare.oauth.revocation_cleanup_reconciled";
      connectionId: string;
      outcome: "cleaned" | "expired_cleanup_complete" | "retry_required";
      reason?: string;
      occurredAt: number;
    }>;

const SAFE_RETRY_REASONS = new Set([
  "connection_cleanup_retry_required",
  "connection_not_found",
  "provider_revocation_failed",
]);

export async function reconcileOAuthRevocationCleanup(input: {
  listPending(limit: number): Promise<readonly { connectionId: string }[]>;
  retryRevocationCleanup(input: { connectionId: string }): Promise<RetryResult>;
  audit(event: CleanupAuditEvent): Promise<void>;
  now(): number;
}) {
  const pending = await input.listPending(MAX_REVOCATION_CLEANUP_BATCH);
  let cleaned = 0;

  for (const row of pending.slice(0, MAX_REVOCATION_CLEANUP_BATCH)) {
    await input.audit({
      eventKind: "cloudflare.oauth.revocation_cleanup_requested",
      connectionId: row.connectionId,
      outcome: "retry_started",
      occurredAt: input.now(),
    });
    let event: CleanupAuditEvent;
    try {
      const result = await input.retryRevocationCleanup({
        connectionId: row.connectionId,
      });
      if (result.ok) {
        cleaned += 1;
        event = {
          eventKind: "cloudflare.oauth.revocation_cleanup_reconciled",
          connectionId: row.connectionId,
          outcome: result.status,
          occurredAt: input.now(),
        };
      } else {
        event = {
          eventKind: "cloudflare.oauth.revocation_cleanup_reconciled",
          connectionId: row.connectionId,
          outcome: "retry_required",
          reason: SAFE_RETRY_REASONS.has(result.reason)
            ? result.reason
            : "cleanup_unavailable",
          occurredAt: input.now(),
        };
      }
    } catch {
      event = {
        eventKind: "cloudflare.oauth.revocation_cleanup_reconciled",
        connectionId: row.connectionId,
        outcome: "retry_required",
        reason: "cleanup_unavailable",
        occurredAt: input.now(),
      };
    }
    await input.audit(event);
  }

  return Object.freeze({
    attempted: pending.length,
    cleaned,
    pending: pending.length - cleaned,
  });
}

export { MAX_REVOCATION_CLEANUP_BATCH };
