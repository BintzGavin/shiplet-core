import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getD1CloudflareRevocationCredentialStatus,
  listD1PendingCloudflareRevocations,
  reconcileD1CloudflareRevocationForRpc,
} from "../src/cloudflare-support/d1-revocation-index";

type TestEnv = { DB: D1Database };
const testEnv = env as TestEnv;

async function insertFixture(input: {
  connectionId: string;
  connectionStatus: "active" | "revoked";
  credentialStatus: "active" | "cleanup" | "retired";
  revokedAt?: number;
}) {
  const credentialRef = `vault_${crypto.randomUUID()}`;
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO encrypted_records (
         id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on
       ) VALUES (?, 'oauth_credential', 'nonce', 'ciphertext', ?, NULL, ?, NULL)`,
    ).bind(credentialRef, input.credentialStatus, new Date().toISOString()),
    testEnv.DB.prepare(
      `INSERT INTO cloudflare_connections (
         id, user_id, account_id, account_label, scopes_json, credential_ref,
         expires_at, status, revoked_at, generation, created_on, refreshed_at
       ) VALUES (?, ?, ?, 'Fixture', '[]', ?, ?, ?, ?, 1, ?, NULL)`,
    ).bind(
      input.connectionId,
      `user_${input.connectionId}`,
      `account_${input.connectionId}`,
      credentialRef,
      Date.now() + 60_000,
      input.connectionStatus,
      input.revokedAt ?? null,
      new Date().toISOString(),
    ),
  ]);
}

describe("D1 Cloudflare revocation retry index", () => {
  beforeEach(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare("DROP TABLE IF EXISTS cloudflare_connections"),
      testEnv.DB.prepare("DROP TABLE IF EXISTS encrypted_records"),
      testEnv.DB.prepare(
        `CREATE TABLE encrypted_records (
           id TEXT PRIMARY KEY,
           purpose TEXT NOT NULL,
           nonce TEXT NOT NULL,
           ciphertext TEXT NOT NULL,
           status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'cleanup')),
           expires_at INTEGER,
           created_on TEXT NOT NULL,
           retired_on TEXT
         )`,
      ),
      testEnv.DB.prepare(
        `CREATE TABLE cloudflare_connections (
           id TEXT PRIMARY KEY,
           user_id TEXT NOT NULL,
           account_id TEXT NOT NULL,
           account_label TEXT NOT NULL,
           scopes_json TEXT NOT NULL,
           credential_ref TEXT NOT NULL,
           expires_at INTEGER NOT NULL,
           status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
           revoked_at INTEGER,
           generation INTEGER NOT NULL,
           created_on TEXT NOT NULL,
           refreshed_at INTEGER,
           FOREIGN KEY (credential_ref) REFERENCES encrypted_records(id)
         )`,
      ),
    ]);
  });

  it("discovers active vault records owned by revoked connections after cleanup indexing fails", async () => {
    await insertFixture({
      connectionId: "connection_active_record",
      connectionStatus: "revoked",
      credentialStatus: "active",
      revokedAt: 100,
    });
    await insertFixture({
      connectionId: "connection_cleanup_record",
      connectionStatus: "revoked",
      credentialStatus: "cleanup",
      revokedAt: 200,
    });
    await insertFixture({
      connectionId: "connection_still_authorized",
      connectionStatus: "active",
      credentialStatus: "active",
    });
    await insertFixture({
      connectionId: "connection_already_retired",
      connectionStatus: "revoked",
      credentialStatus: "retired",
      revokedAt: 300,
    });

    await expect(
      listD1PendingCloudflareRevocations(testEnv.DB, 25),
    ).resolves.toEqual([
      { connectionId: "connection_active_record" },
      { connectionId: "connection_cleanup_record" },
    ]);
  });

  it("attests an exact owner's retired credential so a reconciled revoke is idempotent", async () => {
    await insertFixture({
      connectionId: "connection_reconciled",
      connectionStatus: "revoked",
      credentialStatus: "retired",
      revokedAt: 100,
    });

    await expect(
      getD1CloudflareRevocationCredentialStatus(
        testEnv.DB,
        "connection_reconciled",
        "user_connection_reconciled",
      ),
    ).resolves.toBe("retired");
    await expect(
      getD1CloudflareRevocationCredentialStatus(
        testEnv.DB,
        "connection_reconciled",
        "user_sibling",
      ),
    ).resolves.toBeNull();
  });

  it("audits before retrying an already-revoked provider grant and attests retirement", async () => {
    await insertFixture({
      connectionId: "connection_rpc_retry",
      connectionStatus: "revoked",
      credentialStatus: "active",
      revokedAt: 100,
    });
    const timeline: string[] = [];

    await expect(
      reconcileD1CloudflareRevocationForRpc({
        db: testEnv.DB,
        connectionId: "connection_rpc_retry",
        userId: "user_connection_rpc_retry",
        now: () => 123_456,
        audit: async (event) => {
          timeline.push(`audit:${String(event.outcome)}`);
        },
        retryRevocationCleanup: async () => {
          timeline.push("provider");
          await testEnv.DB.prepare(
            `UPDATE encrypted_records SET status = 'retired'
             WHERE id = (
               SELECT credential_ref FROM cloudflare_connections WHERE id = ?
             )`,
          )
            .bind("connection_rpc_retry")
            .run();
          return { ok: true as const, status: "cleaned" as const };
        },
      }),
    ).resolves.toEqual({ ok: true });
    expect(timeline).toEqual([
      "audit:retry_started",
      "provider",
      "audit:cleaned",
    ]);
  });
});
