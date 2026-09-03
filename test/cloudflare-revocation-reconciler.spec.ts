import { describe, expect, it, vi } from "vitest";

import { reconcileOAuthRevocationCleanup } from "../src/cloudflare-support/revocation-reconciler";

describe("Cloudflare OAuth revocation reconciliation", () => {
  it("does not touch provider cleanup until an immutable retry-intent audit succeeds", async () => {
    const retryRevocationCleanup = vi.fn(async () => ({
      ok: true as const,
      status: "cleaned" as const,
    }));
    const audit = vi.fn(async () => {
      throw new Error("audit_unavailable");
    });

    await expect(
      reconcileOAuthRevocationCleanup({
        listPending: async () => [{ connectionId: "connection_pending" }],
        retryRevocationCleanup,
        audit,
        now: () => 123_456,
      }),
    ).rejects.toThrow("audit_unavailable");
    expect(retryRevocationCleanup).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({
      eventKind: "cloudflare.oauth.revocation_cleanup_requested",
      connectionId: "connection_pending",
      outcome: "retry_started",
      occurredAt: 123_456,
    });
  });

  it("bounds durable cleanup retries and audits every terminal attempt without authority material", async () => {
    const listPending = vi.fn(async (limit: number) => {
      expect(limit).toBe(25);
      return [
        { connectionId: "connection_cleaned" },
        { connectionId: "connection_retry" },
        { connectionId: "connection_unavailable" },
      ];
    });
    const retryRevocationCleanup = vi.fn(
      async ({ connectionId }: { connectionId: string }) => {
        if (connectionId === "connection_cleaned") {
          return { ok: true as const, status: "cleaned" as const };
        }
        if (connectionId === "connection_retry") {
          return {
            ok: false as const,
            reason: "provider_revocation_failed" as const,
          };
        }
        throw new Error("provider fixture must be sanitized");
      },
    );
    const audit = vi.fn(async (_event: Record<string, unknown>) => undefined);

    await expect(
      reconcileOAuthRevocationCleanup({
        listPending,
        retryRevocationCleanup,
        audit,
        now: () => 123_456,
      }),
    ).resolves.toEqual({ attempted: 3, cleaned: 1, pending: 2 });

    expect(retryRevocationCleanup).toHaveBeenCalledTimes(3);
    expect(audit.mock.calls.map(([event]) => event)).toEqual([
      {
        eventKind: "cloudflare.oauth.revocation_cleanup_requested",
        connectionId: "connection_cleaned",
        outcome: "retry_started",
        occurredAt: 123_456,
      },
      {
        eventKind: "cloudflare.oauth.revocation_cleanup_reconciled",
        connectionId: "connection_cleaned",
        outcome: "cleaned",
        occurredAt: 123_456,
      },
      {
        eventKind: "cloudflare.oauth.revocation_cleanup_requested",
        connectionId: "connection_retry",
        outcome: "retry_started",
        occurredAt: 123_456,
      },
      {
        eventKind: "cloudflare.oauth.revocation_cleanup_reconciled",
        connectionId: "connection_retry",
        outcome: "retry_required",
        reason: "provider_revocation_failed",
        occurredAt: 123_456,
      },
      {
        eventKind: "cloudflare.oauth.revocation_cleanup_requested",
        connectionId: "connection_unavailable",
        outcome: "retry_started",
        occurredAt: 123_456,
      },
      {
        eventKind: "cloudflare.oauth.revocation_cleanup_reconciled",
        connectionId: "connection_unavailable",
        outcome: "retry_required",
        reason: "cleanup_unavailable",
        occurredAt: 123_456,
      },
    ]);
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(
      /credential|authorization|refresh|provider fixture/i,
    );
  });
});
