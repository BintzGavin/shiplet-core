import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  beginD1TemporaryProvisioning,
  beginD1TemporaryWorkerDeployment,
  ensureD1TemporaryProviderOperationSchema,
  listD1RecoverableTemporaryProviderOperations,
  markD1TemporaryAmbiguityExpired,
  markD1TemporaryCleanupPending,
  markD1TemporaryOperationCleaned,
  recordD1TemporaryAccountReady,
  recordD1TemporaryDeploymentActive,
  finalizeD1TemporaryCleanup,
  reserveD1TemporaryCleanupWithIntent,
  reserveD1TemporaryProviderOperation,
  reserveD1TemporaryProviderOperationWithIntent,
} from "../src/cloudflare-support/d1-temporary-operations";

type TestEnv = { DB: D1Database };
const testEnv = env as TestEnv;
const NOW = 1_800_000_000_000;
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const REQUEST_DIGEST = `sha256:${"b".repeat(64)}`;

function binding(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "deployment_journal_temporary_A",
    operationKind: "temporary.deployment.create" as const,
    userId: "user_A",
    shipletId: "shiplet_A",
    targetId: "target_A",
    revisionId: "revision_A",
    packageDigest: PACKAGE_DIGEST,
    scriptName: "shiplet-preview-a",
    requestDigest: REQUEST_DIGEST,
    ...overrides,
  };
}

describe("D1 temporary provider-operation recovery", () => {
  beforeEach(async () => {
    await testEnv.DB.prepare(
      "DROP TRIGGER IF EXISTS reject_cleanup_success_audit",
    ).run();
    await testEnv.DB.prepare(
      "DROP TRIGGER IF EXISTS reject_requested_audit",
    ).run();
    await testEnv.DB.prepare(
      "DROP TABLE IF EXISTS temporary_provider_operations",
    ).run();
    await ensureD1TemporaryProviderOperationSchema(testEnv.DB);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `CREATE TABLE IF NOT EXISTS temporary_grant_consumptions (
          grant_digest TEXT PRIMARY KEY, handle_digest TEXT NOT NULL,
          operation TEXT NOT NULL, expires_at INTEGER NOT NULL,
          consumed_on TEXT NOT NULL
        )`,
      ),
      testEnv.DB.prepare(
        `CREATE TABLE IF NOT EXISTS control_audit_outbox (
          id TEXT PRIMARY KEY, event_json TEXT NOT NULL,
          delivery_status TEXT NOT NULL, created_on TEXT NOT NULL,
          delivered_on TEXT
        )`,
      ),
      testEnv.DB.prepare("DELETE FROM temporary_grant_consumptions"),
      testEnv.DB.prepare("DELETE FROM control_audit_outbox"),
    ]);
  });

  async function seedActiveCleanupFixture() {
    await testEnv.DB.batch([
      testEnv.DB.prepare("DROP TABLE IF EXISTS temporary_deployments"),
      testEnv.DB.prepare("DROP TABLE IF EXISTS encrypted_records"),
      testEnv.DB.prepare(
        `CREATE TABLE temporary_deployments (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, shiplet_id TEXT,
          target_id TEXT NOT NULL, revision_id TEXT NOT NULL,
          package_digest TEXT NOT NULL, account_id TEXT NOT NULL,
          script_name TEXT NOT NULL, request_digest TEXT NOT NULL,
          provider_deployment_id TEXT NOT NULL, provider_version_id TEXT NOT NULL,
          workers_dev_url TEXT NOT NULL, authorization_ref TEXT,
          claim_ref TEXT, account_expires_at INTEGER NOT NULL,
          claim_expires_at INTEGER NOT NULL, status TEXT NOT NULL,
          created_on TEXT NOT NULL, claim_delivered_on TEXT, cleaned_on TEXT,
          operation_id TEXT, delivery_event_id TEXT, delivery_started_on TEXT
        )`,
      ),
      testEnv.DB.prepare(
        `CREATE TABLE encrypted_records (
          id TEXT PRIMARY KEY, purpose TEXT NOT NULL, nonce TEXT NOT NULL,
          ciphertext TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER,
          created_on TEXT NOT NULL, retired_on TEXT
        )`,
      ),
    ]);
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
    await recordD1TemporaryAccountReady({
      db: testEnv.DB,
      binding: binding(),
      now: NOW + 2,
      account: {
        accountId: "temporary_account_A",
        authorizationRef: "vault_authority_A",
        claimRef: "vault_claim_A",
        accountExpiresAt: NOW + 3_600_000,
        claimExpiresAt: NOW + 600_000,
      },
    });
    await beginD1TemporaryWorkerDeployment({
      db: testEnv.DB,
      binding: binding(),
      now: NOW + 3,
    });
    await recordD1TemporaryDeploymentActive({
      db: testEnv.DB,
      binding: binding(),
      now: NOW + 4,
      deployment: {
        providerDeploymentId: "provider_deployment_A",
        providerVersionId: "provider_version_A",
        workersDevUrl: "https://shiplet-preview-a.workers.dev/",
        serializedBodyBytes: 512,
      },
    });
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO temporary_deployments (
          id, user_id, shiplet_id, target_id, revision_id, package_digest,
          account_id, script_name, request_digest, provider_deployment_id,
          provider_version_id, workers_dev_url, authorization_ref, claim_ref,
          account_expires_at, claim_expires_at, status, created_on,
          claim_delivered_on, cleaned_on, operation_id, delivery_event_id,
          delivery_started_on
        ) VALUES ('temporary_A', 'user_A', 'shiplet_A', 'target_A',
          'revision_A', ?, 'temporary_account_A', 'shiplet-preview-a', ?,
          'provider_deployment_A', 'provider_version_A',
          'https://shiplet-preview-a.workers.dev/', 'vault_authority_A',
          'vault_claim_A', ?, ?, 'active', ?, NULL, NULL, ?, NULL, NULL)`,
      ).bind(
        PACKAGE_DIGEST,
        REQUEST_DIGEST,
        NOW + 3_600_000,
        NOW + 600_000,
        new Date(NOW).toISOString(),
        binding().operationId,
      ),
      ...["vault_authority_A", "vault_claim_A"].map((id, index) =>
        testEnv.DB.prepare(
          `INSERT INTO encrypted_records
            (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
           VALUES (?, ?, 'nonce', 'cipher', 'active', ?, ?, NULL)`,
        ).bind(
          id,
          index === 0 ? "temporary_authority" : "temporary_claim",
          NOW + 600_000,
          new Date(NOW).toISOString(),
        ),
      ),
    ]);
  }

  it("atomically reserves the provider operation, consumes authority, and records immutable intent before any effect", async () => {
    const reserve = () =>
      reserveD1TemporaryProviderOperationWithIntent({
        db: testEnv.DB,
        binding: binding(),
        now: NOW,
        ambiguityExpiresAt: NOW + 3_600_000,
        grant: {
          grantDigest: "c".repeat(64),
          handleDigest: "d".repeat(64),
          operation: "temporary.deployment.create",
          expiresAt: NOW + 30_000,
          consumedOn: new Date(NOW).toISOString(),
        },
        audit: {
          id: "control_audit_requested_A",
          eventJson: JSON.stringify({
            eventKind: "cloudflare.temporary_deployment.create_requested",
          }),
          createdOn: new Date(NOW).toISOString(),
        },
      });

    await expect(reserve()).resolves.toMatchObject({ ok: true, replay: false });
    await expect(reserve()).resolves.toEqual({
      ok: false,
      reason: "temporary_grant_replayed",
    });
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM temporary_grant_consumptions",
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM control_audit_outbox",
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });

    await testEnv.DB.prepare(
      `CREATE TRIGGER reject_requested_audit BEFORE INSERT ON control_audit_outbox
       BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    ).run();
    await expect(
      reserveD1TemporaryProviderOperationWithIntent({
        db: testEnv.DB,
        binding: binding({
          operationId: "deployment_journal_temporary_B",
          targetId: "target_B",
        }),
        now: NOW,
        ambiguityExpiresAt: NOW + 3_600_000,
        grant: {
          grantDigest: "e".repeat(64),
          handleDigest: "f".repeat(64),
          operation: "temporary.deployment.create",
          expiresAt: NOW + 30_000,
          consumedOn: new Date(NOW).toISOString(),
        },
        audit: {
          id: "control_audit_requested_B",
          eventJson: "{}",
          createdOn: new Date(NOW).toISOString(),
        },
      }),
    ).rejects.toThrow(/audit unavailable/i);
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM temporary_provider_operations
         WHERE operation_id = 'deployment_journal_temporary_B'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("reserves one exact kernel operation and rejects a replay rebound to a sibling Shiplet", async () => {
    // Given an immutable kernel journal identity for one Shiplet.
    const first = await reserveD1TemporaryProviderOperation({
      db: testEnv.DB,
      binding: binding(),
      now: NOW,
      ambiguityExpiresAt: NOW + 30_000,
    });

    // When the same intent is retried, it resumes; a changed scope cannot reuse it.
    const replay = await reserveD1TemporaryProviderOperation({
      db: testEnv.DB,
      binding: binding(),
      now: NOW + 1,
      ambiguityExpiresAt: NOW + 3_600_001,
    });
    const sibling = await reserveD1TemporaryProviderOperation({
      db: testEnv.DB,
      binding: binding({ shipletId: "shiplet_B" }),
      now: NOW + 1,
      ambiguityExpiresAt: NOW + 30_000,
    });

    // Then only the exact intent is recoverable under the original operation ID.
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(replay).toMatchObject({
      ok: true,
      replay: true,
      operation: {
        state: "reserved",
        shipletId: "shiplet_A",
        ambiguityExpiresAt: NOW + 30_000,
      },
    });
    expect(sibling).toEqual({
      ok: false,
      reason: "temporary_operation_binding_conflict",
    });
    await expect(
      testEnv.DB.prepare(
        `UPDATE temporary_provider_operations
         SET shiplet_id = 'shiplet_B'
         WHERE operation_id = 'deployment_journal_temporary_A'`,
      ).run(),
    ).rejects.toThrow(/immutable/i);
  });

  it("uses Cloudflare's full temporary-account lifetime as the maximum ambiguity fence", async () => {
    await expect(
      reserveD1TemporaryProviderOperation({
        db: testEnv.DB,
        binding: binding(),
        now: NOW,
        ambiguityExpiresAt: NOW + 3_600_000,
      }),
    ).resolves.toMatchObject({ ok: true, replay: false });

    await expect(
      reserveD1TemporaryProviderOperation({
        db: testEnv.DB,
        binding: binding({ operationId: "deployment_journal_temporary_B" }),
        now: NOW,
        ambiguityExpiresAt: NOW + 3_600_001,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "temporary_operation_invalid",
    });
  });

  it("Given an account or claim expiry beyond Cloudflare's sixty-minute ceiling, When account readiness is checkpointed, Then persistence is rejected before deployment can begin", async () => {
    for (const [index, account] of [
      {
        accountId: "temporary_account_A",
        authorizationRef: "vault_authority_A",
        claimRef: "vault_claim_A",
        accountExpiresAt: NOW + 2 + 3_600_001,
        claimExpiresAt: NOW + 600_000,
      },
      {
        accountId: "temporary_account_A",
        authorizationRef: "vault_authority_A",
        claimRef: "vault_claim_A",
        accountExpiresAt: NOW + 2 + 3_600_002,
        claimExpiresAt: NOW + 2 + 3_600_001,
      },
    ].entries()) {
      const operationBinding = binding({
        operationId: `deployment_journal_temporary_expiry_${index}`,
        targetId: `target_expiry_${index}`,
      });
      await reserveD1TemporaryProviderOperation({
        db: testEnv.DB,
        binding: operationBinding,
        now: NOW,
        ambiguityExpiresAt: NOW + 30_000,
      });
      await beginD1TemporaryProvisioning({
        db: testEnv.DB,
        binding: operationBinding,
        now: NOW + 1,
      });

      await expect(
        recordD1TemporaryAccountReady({
          db: testEnv.DB,
          binding: operationBinding,
          now: NOW + 2,
          account,
        }),
      ).resolves.toEqual({
        ok: false,
        reason: "temporary_operation_invalid",
      });
      expect(
        await testEnv.DB.prepare(
          "SELECT state FROM temporary_provider_operations WHERE operation_id = ?",
        )
          .bind(operationBinding.operationId)
          .first<{ state: string }>(),
      ).toEqual({ state: "provisioning" });
    }
  });

  it("atomically consumes cleanup authority and checkpoints cleanup before the provider effect", async () => {
    await seedActiveCleanupFixture();
    const reserve = () =>
      reserveD1TemporaryCleanupWithIntent({
        db: testEnv.DB,
        binding: binding(),
        deploymentId: "temporary_A",
        now: NOW + 5,
        grant: {
          grantDigest: "1".repeat(64),
          handleDigest: "2".repeat(64),
          operation: "temporary.deployment.cleanup",
          expiresAt: NOW + 30_000,
          consumedOn: new Date(NOW + 5).toISOString(),
        },
        audit: {
          id: "control_audit_cleanup_requested_A",
          eventJson: JSON.stringify({
            eventKind: "cloudflare.temporary_deployment.cleanup_requested",
          }),
          createdOn: new Date(NOW + 5).toISOString(),
        },
      });

    await expect(reserve()).resolves.toMatchObject({
      ok: true,
      replay: false,
      operation: { state: "cleanup_pending" },
    });
    await expect(reserve()).resolves.toEqual({
      ok: false,
      reason: "temporary_grant_replayed",
    });
    expect(
      await testEnv.DB.prepare(
        `SELECT status, authorization_ref, claim_ref
         FROM temporary_deployments WHERE id = 'temporary_A'`,
      ).first<Record<string, unknown>>(),
    ).toEqual({
      status: "active",
      authorization_ref: "vault_authority_A",
      claim_ref: "vault_claim_A",
    });
    await expect(
      listD1RecoverableTemporaryProviderOperations(testEnv.DB, 25),
    ).resolves.toEqual([
      expect.objectContaining({
        operationId: binding().operationId,
        state: "cleanup_pending",
        authorizationRef: "vault_authority_A",
      }),
    ]);
  });

  it("finalizes cleanup, ref deletion, status, and success audit in one D1 transaction", async () => {
    await seedActiveCleanupFixture();
    await reserveD1TemporaryCleanupWithIntent({
      db: testEnv.DB,
      binding: binding(),
      deploymentId: "temporary_A",
      now: NOW + 5,
      grant: {
        grantDigest: "3".repeat(64),
        handleDigest: "4".repeat(64),
        operation: "temporary.deployment.cleanup",
        expiresAt: NOW + 30_000,
        consumedOn: new Date(NOW + 5).toISOString(),
      },
      audit: {
        id: "control_audit_cleanup_requested_A",
        eventJson: "{}",
        createdOn: new Date(NOW + 5).toISOString(),
      },
    });

    await expect(
      finalizeD1TemporaryCleanup({
        db: testEnv.DB,
        binding: binding(),
        deploymentId: "temporary_A",
        now: NOW + 6,
        audit: {
          id: "control_audit_cleanup_success_A",
          eventJson: JSON.stringify({
            eventKind: "cloudflare.temporary_deployment.cleaned",
          }),
          createdOn: new Date(NOW + 6).toISOString(),
        },
      }),
    ).resolves.toEqual({ ok: true, replay: false });
    await expect(
      finalizeD1TemporaryCleanup({
        db: testEnv.DB,
        binding: binding(),
        deploymentId: "temporary_A",
        now: NOW + 7,
        audit: {
          id: "control_audit_cleanup_success_A",
          eventJson: "{}",
          createdOn: new Date(NOW + 7).toISOString(),
        },
      }),
    ).resolves.toEqual({ ok: true, replay: true });
    expect(
      await testEnv.DB.prepare(
        `SELECT status, authorization_ref, claim_ref, cleaned_on
         FROM temporary_deployments WHERE id = 'temporary_A'`,
      ).first<Record<string, unknown>>(),
    ).toEqual({
      status: "cleaned",
      authorization_ref: null,
      claim_ref: null,
      cleaned_on: new Date(NOW + 6).toISOString(),
    });
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM encrypted_records",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM control_audit_outbox",
      ).first<{ count: number }>(),
    ).toEqual({ count: 2 });
  });

  it("rolls cleanup finalization back when the success audit cannot be recorded", async () => {
    await seedActiveCleanupFixture();
    await reserveD1TemporaryCleanupWithIntent({
      db: testEnv.DB,
      binding: binding(),
      deploymentId: "temporary_A",
      now: NOW + 5,
      grant: {
        grantDigest: "5".repeat(64),
        handleDigest: "6".repeat(64),
        operation: "temporary.deployment.cleanup",
        expiresAt: NOW + 30_000,
        consumedOn: new Date(NOW + 5).toISOString(),
      },
      audit: {
        id: "control_audit_cleanup_requested_A",
        eventJson: "{}",
        createdOn: new Date(NOW + 5).toISOString(),
      },
    });
    await testEnv.DB.prepare(
      `CREATE TRIGGER reject_cleanup_success_audit
       BEFORE INSERT ON control_audit_outbox
       WHEN NEW.id = 'control_audit_cleanup_success_A'
       BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    ).run();

    await expect(
      finalizeD1TemporaryCleanup({
        db: testEnv.DB,
        binding: binding(),
        deploymentId: "temporary_A",
        now: NOW + 6,
        audit: {
          id: "control_audit_cleanup_success_A",
          eventJson: "{}",
          createdOn: new Date(NOW + 6).toISOString(),
        },
      }),
    ).rejects.toThrow(/audit unavailable/i);
    expect(
      await testEnv.DB.prepare(
        `SELECT operation.state, deployment.status,
          deployment.authorization_ref, deployment.claim_ref
         FROM temporary_provider_operations operation
         JOIN temporary_deployments deployment
           ON deployment.operation_id = operation.operation_id
         WHERE operation.operation_id = ?`,
      )
        .bind(binding().operationId)
        .first<Record<string, unknown>>(),
    ).toEqual({
      state: "cleanup_pending",
      status: "active",
      authorization_ref: "vault_authority_A",
      claim_ref: "vault_claim_A",
    });
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM encrypted_records",
      ).first<{ count: number }>(),
    ).toEqual({ count: 2 });
  });

  it("checkpoints account readiness and resumes cleanup after a deployment interruption", async () => {
    // Given a provider operation whose exact authority has been reserved.
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

    // When provider account creation succeeds, its opaque vault references are
    // durably checkpointed before deployment and the operation later needs cleanup.
    await recordD1TemporaryAccountReady({
      db: testEnv.DB,
      binding: binding(),
      now: NOW + 2,
      account: {
        accountId: "temporary_account_A",
        authorizationRef: "vault_authority_A",
        claimRef: "vault_claim_A",
        accountExpiresAt: NOW + 3_600_000,
        claimExpiresAt: NOW + 600_000,
      },
    });
    await beginD1TemporaryWorkerDeployment({
      db: testEnv.DB,
      binding: binding(),
      now: NOW + 3,
    });
    await markD1TemporaryCleanupPending({
      db: testEnv.DB,
      binding: binding(),
      now: NOW + 4,
      reason: "deployment_persistence_failed",
    });

    // Then scheduled recovery sees the exact cleanup work, and completing it is
    // idempotent without losing the provider account reference.
    await expect(
      listD1RecoverableTemporaryProviderOperations(testEnv.DB, 25),
    ).resolves.toEqual([
      expect.objectContaining({
        operationId: "deployment_journal_temporary_A",
        state: "cleanup_pending",
        accountId: "temporary_account_A",
        authorizationRef: "vault_authority_A",
      }),
    ]);
    await expect(
      markD1TemporaryOperationCleaned({
        db: testEnv.DB,
        binding: binding(),
        now: NOW + 5,
      }),
    ).resolves.toMatchObject({ ok: true, state: "cleaned" });
    await expect(
      markD1TemporaryOperationCleaned({
        db: testEnv.DB,
        binding: binding(),
        now: NOW + 6,
      }),
    ).resolves.toMatchObject({ ok: true, state: "cleaned" });
  });

  it("recovers account-ready and deploying checkpoints and preserves an active provider result", async () => {
    // Given three operations interrupted at distinct durable checkpoints.
    for (const suffix of ["account", "deploying", "active"] as const) {
      const scoped = binding({
        operationId: `deployment_journal_${suffix}`,
        targetId: `target_${suffix}`,
        requestDigest: `sha256:${suffix[0]!.repeat(64)}`,
      });
      await reserveD1TemporaryProviderOperation({
        db: testEnv.DB,
        binding: scoped,
        now: NOW,
        ambiguityExpiresAt: NOW + 30_000,
      });
      await beginD1TemporaryProvisioning({
        db: testEnv.DB,
        binding: scoped,
        now: NOW + 1,
      });
      await recordD1TemporaryAccountReady({
        db: testEnv.DB,
        binding: scoped,
        now: NOW + 2,
        account: {
          accountId: `temporary_account_${suffix}`,
          authorizationRef: `vault_authority_${suffix}`,
          claimRef: `vault_claim_${suffix}`,
          accountExpiresAt: NOW + 3_600_000,
          claimExpiresAt: NOW + 600_000,
        },
      });
      if (suffix !== "account") {
        await beginD1TemporaryWorkerDeployment({
          db: testEnv.DB,
          binding: scoped,
          now: NOW + 3,
        });
      }
      if (suffix === "active") {
        await recordD1TemporaryDeploymentActive({
          db: testEnv.DB,
          binding: scoped,
          now: NOW + 4,
          deployment: {
            providerDeploymentId: "temporary_deployment_active",
            providerVersionId: "temporary_version_active",
            workersDevUrl: "https://shiplet-preview-active.workers.dev/",
            serializedBodyBytes: 1024,
          },
        });
      }
    }

    // When recovery scans for unfinished provider effects.
    const recoverable = await listD1RecoverableTemporaryProviderOperations(
      testEnv.DB,
      25,
    );

    // Then account-ready and deploying operations resume, while an active
    // provider result without its public deployment row is recovered as an
    // orphan rather than silently leaked.
    expect(recoverable.map((entry) => entry.state).sort()).toEqual([
      "account_ready",
      "active",
      "deploying",
    ]);
    const active = await testEnv.DB.prepare(
      `SELECT state, provider_deployment_id, provider_version_id, workers_dev_url
       FROM temporary_provider_operations WHERE operation_id = ?`,
    )
      .bind("deployment_journal_active")
      .first<Record<string, unknown>>();
    expect(active).toEqual({
      state: "active",
      provider_deployment_id: "temporary_deployment_active",
      provider_version_id: "temporary_version_active",
      workers_dev_url: "https://shiplet-preview-active.workers.dev/",
    });
  });

  it("expires an ambiguous provisioning effect and rejects illegal resurrection", async () => {
    // Given an operation that may have created a provider account but never
    // checkpointed the result before its ambiguity fence expired.
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

    // When the fence expires, the operation becomes terminal.
    await expect(
      markD1TemporaryAmbiguityExpired({
        db: testEnv.DB,
        binding: binding(),
        now: NOW + 30_000,
      }),
    ).resolves.toMatchObject({ ok: true, state: "ambiguity_expired" });

    // Then it cannot be reclassified as active or cleanup pending.
    await expect(
      testEnv.DB.prepare(
        `UPDATE temporary_provider_operations SET state = 'active'
         WHERE operation_id = 'deployment_journal_temporary_A'`,
      ).run(),
    ).rejects.toThrow(/transition/i);
    await expect(
      markD1TemporaryCleanupPending({
        db: testEnv.DB,
        binding: binding(),
        now: NOW + 30_001,
        reason: "late_retry",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "temporary_operation_transition_conflict",
    });
  });
});
