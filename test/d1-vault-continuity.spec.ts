import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  attestD1CredentialContinuity,
  initializeD1CredentialContinuity,
} from "../src/cloudflare-support/d1-vault";
// @ts-expect-error Vite supplies additive migration source text.
import supportHealthMigration from "../workers/cloudflare-control-plane/migrations/0007_support_health.sql?raw";
// @ts-expect-error Vite supplies additive migration source text.
import managedDeploymentMigration from "../workers/cloudflare-control-plane/migrations/0008_managed_deployment_broker.sql?raw";
// @ts-expect-error Vite supplies additive migration source text.
import managedPlatformReservationMigration from "../workers/cloudflare-control-plane/migrations/0009_managed_platform_connection_reservation.sql?raw";
// @ts-expect-error Vite supplies additive migration source text.
import managedPlatformRetirementMigration from "../workers/cloudflare-control-plane/migrations/0010_managed_platform_connection_retirement.sql?raw";

type TestEnv = { DB: D1Database };
const testEnv = env as TestEnv;
const SENSITIVE_TABLES = [
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
] as const;

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function ephemeralKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function migrationStatements(source: string) {
  const statements: string[] = [];
  let current: string[] = [];
  let trigger = false;
  for (const line of source.split(/\r?\n/)) {
    if (!current.length && !line.trim()) continue;
    current.push(line);
    if (/^CREATE TRIGGER\b/i.test(line.trim())) trigger = true;
    if (
      (!trigger && line.trim().endsWith(";")) ||
      (trigger && line.trim().toUpperCase() === "END;")
    ) {
      statements.push(current.join("\n"));
      current = [];
      trigger = false;
    }
  }
  if (current.some((line) => line.trim())) throw new Error("migration_incomplete");
  return statements;
}

async function resetSchema() {
  await testEnv.DB.exec(
    [
      "DROP TABLE IF EXISTS credential_continuity",
      "DROP TABLE IF EXISTS support_reconciliation_runs",
      "DROP TABLE IF EXISTS managed_deployment_operations",
      "DROP TABLE IF EXISTS managed_platform_connection_reservations",
      "DROP TABLE IF EXISTS managed_platform_connection_retirements",
      ...SENSITIVE_TABLES.map((table) => `DROP TABLE IF EXISTS ${table}`),
    ]
      .map((statement) => `${statement};`)
      .join("\n"),
  );
  await testEnv.DB.exec(
    SENSITIVE_TABLES.map(
      (table) => `CREATE TABLE ${table} (id TEXT PRIMARY KEY)`,
    )
      .map((statement) => `${statement};`)
      .join("\n"),
  );
  for (const migration of [
    supportHealthMigration,
    managedDeploymentMigration,
    managedPlatformReservationMigration,
    managedPlatformRetirementMigration,
  ]) {
    for (const statement of migrationStatements(migration)) {
      await testEnv.DB.prepare(statement).run();
    }
  }
}

describe("D1 credential-root continuity", () => {
  beforeEach(resetSchema);

  it("Given an empty first install, When continuity is initialized atomically, Then only ciphertext can attest the same root and a replacement key fails closed", async () => {
    const currentKey = ephemeralKey();
    const replacementKey = ephemeralKey();

    await expect(
      initializeD1CredentialContinuity({
        db: testEnv.DB,
        encodedKey: currentKey,
        now: 1_800_000_000_000,
      }),
    ).resolves.toEqual({ ok: true, initialized: true });
    await expect(
      attestD1CredentialContinuity({
        db: testEnv.DB,
        encodedKey: currentKey,
      }),
    ).resolves.toEqual({ ok: true });

    const persisted = await testEnv.DB.prepare(
      "SELECT sentinel_id, purpose, nonce, ciphertext FROM credential_continuity",
    ).first<Record<string, unknown>>();
    expect(JSON.stringify(persisted)).not.toContain(currentKey);
    expect(JSON.stringify(persisted)).not.toContain("shiplet.credential-continuity/v1");

    await expect(
      initializeD1CredentialContinuity({
        db: testEnv.DB,
        encodedKey: replacementKey,
        now: 1_800_000_000_001,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "credential_continuity_unavailable",
    });
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM credential_continuity",
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("Given pre-existing sensitive state and no sentinel, When initialization is attempted, Then it refuses to invent continuity", async () => {
    const key = ephemeralKey();
    await testEnv.DB.prepare(
      "INSERT INTO encrypted_records (id) VALUES ('prior_sensitive_record')",
    ).run();

    await expect(
      initializeD1CredentialContinuity({
        db: testEnv.DB,
        encodedKey: key,
        now: 1_800_000_000_000,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "credential_continuity_missing_with_state",
    });
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM credential_continuity",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("Given reconciliation history and no sentinel, When initialization is attempted, Then it refuses to invent continuity", async () => {
    const key = ephemeralKey();
    await testEnv.DB.prepare(
      `INSERT INTO support_reconciliation_runs (
        run_id, status, started_at, completed_at, error_code,
        cleanup_pending, revocation_pending, temporary_ambiguous,
        temporary_ambiguity_expired
      ) VALUES ('prior_reconciliation', 'success', 1, 2, NULL, 0, 0, 0, 0)`,
    ).run();

    await expect(
      initializeD1CredentialContinuity({
        db: testEnv.DB,
        encodedKey: key,
        now: 1_800_000_000_000,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "credential_continuity_missing_with_state",
    });
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM credential_continuity",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("Given malformed or undecryptable continuity ciphertext, When health attests the root, Then it fails without replacing evidence", async () => {
    const key = ephemeralKey();
    await testEnv.DB.prepare(
      `INSERT INTO credential_continuity (
        sentinel_id, purpose, nonce, ciphertext, created_on
      ) VALUES ('credential-root-v1', 'credential_continuity',
        'malformed', 'malformed', '2026-08-08T00:00:00.000Z')`,
    ).run();

    await expect(
      attestD1CredentialContinuity({ db: testEnv.DB, encodedKey: key }),
    ).resolves.toEqual({
      ok: false,
      reason: "credential_continuity_unavailable",
    });
    expect(
      await testEnv.DB.prepare(
        "SELECT nonce || '|' || ciphertext AS evidence FROM credential_continuity",
      ).first<{ evidence: string }>(),
    ).toEqual({ evidence: "malformed|malformed" });
  });
});
