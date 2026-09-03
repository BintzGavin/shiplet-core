import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  beginD1TemporaryProvisioning,
  markD1TemporaryAmbiguityExpired,
  reserveD1TemporaryProviderOperation,
} from "../src/cloudflare-support/d1-temporary-operations";
import { initializeD1CredentialContinuity } from "../src/cloudflare-support/d1-vault";
import {
  readD1SupportHealth,
  runD1SupportReconciliation,
} from "../src/cloudflare-support/support-health";
import {
  normalizeSupportHealthAttestation,
  verifySupportHealthAttestation,
} from "../src/cloudflare-support/service-contract";
// @ts-expect-error Vite supplies migration source text.
import migration1 from "../workers/cloudflare-control-plane/migrations/0001_control_plane.sql?raw";
// @ts-expect-error Vite supplies migration source text.
import migration2 from "../workers/cloudflare-control-plane/migrations/0002_oauth_support_release.sql?raw";
// @ts-expect-error Vite supplies migration source text.
import migration3 from "../workers/cloudflare-control-plane/migrations/0003_temporary_recovery.sql?raw";
// @ts-expect-error Vite supplies migration source text.
import migration4 from "../workers/cloudflare-control-plane/migrations/0004_oauth_finalization_delivery.sql?raw";
// @ts-expect-error Vite supplies migration source text.
import migration5 from "../workers/cloudflare-control-plane/migrations/0005_oauth_exchange_recovery.sql?raw";
// @ts-expect-error Vite supplies migration source text.
import migration6 from "../workers/cloudflare-control-plane/migrations/0006_oauth_crash_consistency.sql?raw";
// @ts-expect-error Vite supplies migration source text.
import migration7 from "../workers/cloudflare-control-plane/migrations/0007_support_health.sql?raw";
// @ts-expect-error Vite supplies migration source text.
import migration8 from "../workers/cloudflare-control-plane/migrations/0008_managed_deployment_broker.sql?raw";
// @ts-expect-error Vite supplies migration source text.
import migration9 from "../workers/cloudflare-control-plane/migrations/0009_managed_platform_connection_reservation.sql?raw";
// @ts-expect-error Vite supplies migration source text.
import migration10 from "../workers/cloudflare-control-plane/migrations/0010_managed_platform_connection_retirement.sql?raw";

type TestEnv = { DB: D1Database };
const testEnv = env as TestEnv;
const NOW = 1_800_000_000_000;
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_TAG = "shiplet-support-health-fixture";

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
  if (current.some((line) => line.trim()))
    throw new Error("migration_incomplete");
  return statements;
}

async function resetSchema() {
  const tables = await testEnv.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
  ).all<{ name: string }>();
  const triggers = await testEnv.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'",
  ).all<{ name: string }>();
  for (const trigger of triggers.results) {
    await testEnv.DB.exec(`DROP TRIGGER IF EXISTS ${trigger.name};`);
  }
  for (const table of tables.results) {
    await testEnv.DB.exec(`DROP TABLE IF EXISTS ${table.name};`);
  }
  for (const migration of [
    migration1,
    migration2,
    migration3,
    migration4,
    migration5,
    migration6,
    migration7,
    migration8,
    migration9,
    migration10,
  ]) {
    for (const statement of migrationStatements(migration)) {
      await testEnv.DB.prepare(statement).run();
    }
  }
}

function binding() {
  return {
    operationId: "temporary_health_operation",
    operationKind: "temporary.deployment.create" as const,
    userId: "user_health",
    shipletId: "shiplet_health",
    targetId: "target_health",
    revisionId: "revision_health",
    packageDigest: `sha256:${"a".repeat(64)}`,
    scriptName: "shiplet-health",
    requestDigest: `sha256:${"b".repeat(64)}`,
  };
}

describe("non-secret support health", () => {
  beforeEach(resetSchema);

  it("Given a fresh control plane, When scheduled reconciliation is the first request, Then continuity is initialized before the run is recorded", async () => {
    const key = ephemeralKey();

    await expect(
      runD1SupportReconciliation({
        db: testEnv.DB,
        encodedKey: key,
        now: NOW,
        reconcile: async () => {
          const continuity = await initializeD1CredentialContinuity({
            db: testEnv.DB,
            encodedKey: key,
            now: NOW,
          });
          if (!continuity.ok) {
            throw new Error("credential_continuity_unavailable");
          }
        },
      }),
    ).resolves.toBeUndefined();
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM credential_continuity",
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await testEnv.DB.prepare(
        "SELECT status FROM support_reconciliation_runs ORDER BY started_at DESC LIMIT 1",
      ).first<{ status: string }>(),
    ).toEqual({ status: "success" });
  });

  it("Given current schema and credential continuity, When scheduled reconciliation succeeds, Then health attests freshness and zero bounded backlogs in addition to the release", async () => {
    const key = ephemeralKey();
    await initializeD1CredentialContinuity({
      db: testEnv.DB,
      encodedKey: key,
      now: NOW,
    });
    await runD1SupportReconciliation({
      db: testEnv.DB,
      encodedKey: key,
      now: NOW + 1,
      reconcile: async () => undefined,
    });

    const health = await readD1SupportHealth({
      db: testEnv.DB,
      encodedKey: key,
      now: NOW + 2,
      maxFreshnessMs: 15 * 60_000,
      release: { versionId: VERSION_ID, versionTag: VERSION_TAG },
    });

    expect(health).toMatchObject({
      schemaVersion: "shiplet.support-health/v1",
      status: "healthy",
      schemaReady: true,
      credentialContinuity: "verified",
      reconciliation: { status: "success", fresh: true },
      backlog: {
        cleanupPending: 0,
        revocationPending: 0,
        temporaryAmbiguous: 0,
        temporaryAmbiguityExpired: 0,
        boundedAt: 101,
      },
      release: { versionId: VERSION_ID, versionTag: VERSION_TAG },
    });
    expect(
      verifySupportHealthAttestation(health, {
        versionId: VERSION_ID,
        versionTag: VERSION_TAG,
      }),
    ).toEqual({ ok: true });
    expect(
      verifySupportHealthAttestation(
        { versionId: VERSION_ID, versionTag: VERSION_TAG },
        { versionId: VERSION_ID, versionTag: VERSION_TAG },
      ),
    ).toEqual({ ok: false, reason: "support_health_mismatch" });
  });

  it.each([
    "managed_platform_connection_retirements",
    "managed_platform_operation_leases",
  ])(
    "Given current managed-authority table %s is absent, When health is read, Then schema readiness fails closed",
    async (table) => {
      const key = ephemeralKey();
      const initialized = await initializeD1CredentialContinuity({
        db: testEnv.DB,
        encodedKey: key,
        now: NOW,
      });
      expect(initialized.ok).toBe(true);
      await runD1SupportReconciliation({
        db: testEnv.DB,
        encodedKey: key,
        now: NOW + 1,
        reconcile: async () => undefined,
      });
      await testEnv.DB.exec(`DROP TABLE ${table};`);

      await expect(
        readD1SupportHealth({
          db: testEnv.DB,
          encodedKey: key,
          now: NOW + 2,
          maxFreshnessMs: 15 * 60_000,
          release: { versionId: VERSION_ID, versionTag: VERSION_TAG },
        }),
      ).resolves.toMatchObject({
        status: "degraded",
        schemaReady: false,
        credentialContinuity: "unavailable",
      });
    },
  );

  it("Given an unknown-effect temporary provisioning response loss, When its fence reaches terminal expiry, Then durable health remains degraded and preserves both ambiguity aggregates", async () => {
    const key = ephemeralKey();
    await initializeD1CredentialContinuity({
      db: testEnv.DB,
      encodedKey: key,
      now: NOW,
    });
    await runD1SupportReconciliation({
      db: testEnv.DB,
      encodedKey: key,
      now: NOW,
      reconcile: async () => undefined,
    });
    await reserveD1TemporaryProviderOperation({
      db: testEnv.DB,
      binding: binding(),
      now: NOW,
      ambiguityExpiresAt: NOW + 30_000,
    });
    await beginD1TemporaryProvisioning({
      db: testEnv.DB,
      binding: binding(),
      now: NOW + 1,
    });

    const ambiguous = await readD1SupportHealth({
      db: testEnv.DB,
      encodedKey: key,
      now: NOW + 2,
      maxFreshnessMs: 15 * 60_000,
      release: { versionId: VERSION_ID, versionTag: VERSION_TAG },
    });
    expect(ambiguous).toMatchObject({
      status: "degraded",
      backlog: { temporaryAmbiguous: 1, temporaryAmbiguityExpired: 0 },
    });
    expect(
      normalizeSupportHealthAttestation(ambiguous, {
        versionId: VERSION_ID,
        versionTag: VERSION_TAG,
      }),
    ).toEqual({ ok: true, health: ambiguous });
    expect(
      normalizeSupportHealthAttestation(
        { ...ambiguous, providerDetail: "must not cross the RPC boundary" },
        { versionId: VERSION_ID, versionTag: VERSION_TAG },
      ),
    ).toEqual({ ok: false, reason: "support_health_mismatch" });
    expect(
      normalizeSupportHealthAttestation(
        {
          ...ambiguous,
          backlog: { ...ambiguous.backlog, temporaryAmbiguous: 102 },
        },
        { versionId: VERSION_ID, versionTag: VERSION_TAG },
      ),
    ).toEqual({ ok: false, reason: "support_health_mismatch" });

    await markD1TemporaryAmbiguityExpired({
      db: testEnv.DB,
      binding: binding(),
      now: NOW + 30_000,
    });
    const expired = await readD1SupportHealth({
      db: testEnv.DB,
      encodedKey: key,
      now: NOW + 30_001,
      maxFreshnessMs: 15 * 60_000,
      release: { versionId: VERSION_ID, versionTag: VERSION_TAG },
    });
    expect(expired).toMatchObject({
      status: "degraded",
      backlog: { temporaryAmbiguous: 0, temporaryAmbiguityExpired: 1 },
    });
    expect(
      await testEnv.DB.prepare(
        "SELECT state FROM temporary_provider_operations WHERE operation_id = ?",
      )
        .bind(binding().operationId)
        .first<{ state: string }>(),
    ).toEqual({ state: "ambiguity_expired" });
  });

  it("Given scheduled reconciliation throws, When the run closes, Then a fixed non-secret failure is durable and health is degraded", async () => {
    const key = ephemeralKey();
    await initializeD1CredentialContinuity({
      db: testEnv.DB,
      encodedKey: key,
      now: NOW,
    });

    await expect(
      runD1SupportReconciliation({
        db: testEnv.DB,
        encodedKey: key,
        now: NOW + 1,
        reconcile: async () => {
          throw new Error("provider-specific detail must not persist");
        },
      }),
    ).rejects.toThrow("provider-specific detail must not persist");
    expect(
      await testEnv.DB.prepare(
        `SELECT status, error_code FROM support_reconciliation_runs
         ORDER BY started_at DESC LIMIT 1`,
      ).first<{ status: string; error_code: string | null }>(),
    ).toEqual({
      status: "failure",
      error_code: "scheduled_reconciliation_failed",
    });
    expect(
      await readD1SupportHealth({
        db: testEnv.DB,
        encodedKey: key,
        now: NOW + 2,
        maxFreshnessMs: 15 * 60_000,
        release: { versionId: VERSION_ID, versionTag: VERSION_TAG },
      }),
    ).toMatchObject({
      status: "degraded",
      reconciliation: { status: "failure", fresh: false },
    });
  });
});
