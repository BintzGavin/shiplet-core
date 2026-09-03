import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginD1TemporaryProvisioning,
  beginD1TemporaryWorkerDeployment,
  ensureD1TemporaryProviderOperationSchema,
  listD1RecoverableTemporaryProviderOperations,
  reconcileD1TemporaryProviderOperations,
  recordD1TemporaryAccountReady,
  recordD1TemporaryDeploymentActive,
  recoverD1TemporaryStaticDeployment,
  reserveD1TemporaryProviderOperation,
  type D1TemporaryProviderOperationBinding,
} from "../src/cloudflare-support/d1-temporary-operations";

type TestEnv = { DB: D1Database };
const testEnv = env as TestEnv;
const NOW = 1_800_000_000_000;
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const REQUEST_DIGEST = `sha256:${"b".repeat(64)}`;

function binding(
  overrides: Partial<D1TemporaryProviderOperationBinding> = {},
): D1TemporaryProviderOperationBinding {
  return {
    operationId: "deployment_journal_recovery_A",
    operationKind: "temporary.deployment.create",
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

async function seedAccountReady(
  scoped = binding(),
  input: { active?: boolean; persistDeployment?: boolean } = {},
) {
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
      accountId: `temporary_account_${scoped.targetId}`,
      authorizationRef: `vault_authority_${scoped.targetId}`,
      claimRef: `vault_claim_${scoped.targetId}`,
      accountExpiresAt: NOW + 3_600_000,
      claimExpiresAt: NOW + 600_000,
    },
  });
  await testEnv.DB.batch(
    ["authority", "claim"].map((kind) =>
      testEnv.DB.prepare(
        `INSERT INTO encrypted_records
          (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
         VALUES (?, ?, 'nonce', 'cipher', 'active', ?, ?, NULL)`,
      ).bind(
        `vault_${kind}_${scoped.targetId}`,
        kind === "authority" ? "temporary_authority" : "temporary_claim",
        NOW + 600_000,
        new Date(NOW).toISOString(),
      ),
    ),
  );
  if (input.active) {
    await beginD1TemporaryWorkerDeployment({
      db: testEnv.DB,
      binding: scoped,
      now: NOW + 3,
    });
    await recordD1TemporaryDeploymentActive({
      db: testEnv.DB,
      binding: scoped,
      now: NOW + 4,
      deployment: {
        providerDeploymentId: `provider_deployment_${scoped.targetId}`,
        providerVersionId: `provider_version_${scoped.targetId}`,
        workersDevUrl: `https://${scoped.scriptName}.workers.dev/`,
        serializedBodyBytes: 512,
      },
    });
  }
  if (input.persistDeployment) {
    await testEnv.DB.prepare(
      `INSERT INTO temporary_deployments (
        id, user_id, shiplet_id, target_id, revision_id, package_digest,
        account_id, script_name, request_digest, provider_deployment_id,
        provider_version_id, workers_dev_url, authorization_ref, claim_ref,
        account_expires_at, claim_expires_at, status, created_on,
        claim_delivered_on, cleaned_on, operation_id, delivery_event_id,
        delivery_started_on
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active',
        ?, NULL, NULL, ?, NULL, NULL)`,
    )
      .bind(
        `temporary_${scoped.targetId}`,
        scoped.userId,
        scoped.shipletId,
        scoped.targetId,
        scoped.revisionId,
        scoped.packageDigest,
        `temporary_account_${scoped.targetId}`,
        scoped.scriptName,
        scoped.requestDigest,
        `provider_deployment_${scoped.targetId}`,
        `provider_version_${scoped.targetId}`,
        `https://${scoped.scriptName}.workers.dev/`,
        `vault_authority_${scoped.targetId}`,
        `vault_claim_${scoped.targetId}`,
        NOW + 3_600_000,
        NOW + 600_000,
        new Date(NOW).toISOString(),
        scoped.operationId,
      )
      .run();
  }
}

function audit(
  operation: { operationId: string },
  now: number,
) {
  return {
    id: `recovery_audit_${operation.operationId}`,
    eventJson: JSON.stringify({
      eventKind: "cloudflare.temporary_deployment.cleaned",
      operationId: operation.operationId,
    }),
    createdOn: new Date(now).toISOString(),
  };
}

describe("temporary provider-operation scheduled recovery", () => {
  beforeEach(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare("DROP TABLE IF EXISTS temporary_provider_operations"),
      testEnv.DB.prepare("DROP TABLE IF EXISTS temporary_deployments"),
      testEnv.DB.prepare("DROP TABLE IF EXISTS encrypted_records"),
      testEnv.DB.prepare("DROP TABLE IF EXISTS control_audit_outbox"),
      testEnv.DB.prepare(
        `CREATE TABLE temporary_deployments (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, shiplet_id TEXT,
          target_id TEXT NOT NULL, revision_id TEXT NOT NULL,
          package_digest TEXT NOT NULL, account_id TEXT NOT NULL,
          script_name TEXT NOT NULL, request_digest TEXT NOT NULL,
          provider_deployment_id TEXT NOT NULL, provider_version_id TEXT NOT NULL,
          workers_dev_url TEXT NOT NULL, authorization_ref TEXT, claim_ref TEXT,
          account_expires_at INTEGER NOT NULL, claim_expires_at INTEGER NOT NULL,
          status TEXT NOT NULL, created_on TEXT NOT NULL, claim_delivered_on TEXT,
          cleaned_on TEXT, operation_id TEXT, delivery_event_id TEXT,
          delivery_started_on TEXT
        )`,
      ),
      testEnv.DB.prepare(
        `CREATE TABLE encrypted_records (
          id TEXT PRIMARY KEY, purpose TEXT NOT NULL, nonce TEXT NOT NULL,
          ciphertext TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER,
          created_on TEXT NOT NULL, retired_on TEXT
        )`,
      ),
      testEnv.DB.prepare(
        `CREATE TABLE control_audit_outbox (
          id TEXT PRIMARY KEY, event_json TEXT NOT NULL,
          delivery_status TEXT NOT NULL, created_on TEXT NOT NULL,
          delivered_on TEXT
        )`,
      ),
    ]);
    await ensureD1TemporaryProviderOperationSchema(testEnv.DB);
  });

  it("recovers an accepted Worker upload by exact inspection without uploading twice", async () => {
    let durableState: "account_ready" | "deploying" = "account_ready";
    let providerCommitted = false;
    const upload = vi.fn(async () => {
      providerCommitted = true;
      throw new Error("provider response lost");
    });
    const inspect = vi.fn(async () =>
      providerCommitted
        ? {
            ok: true as const,
            deployment: {
              providerDeploymentId: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
              providerVersionId: "282bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
              workersDevUrl: "https://shiplet-preview-a.workers.dev/",
              serializedBodyBytes: 512,
            },
          }
        : {
            ok: false as const,
            reason: "temporary_deployment_unproven" as const,
          },
    );
    const checkpoint = vi.fn(async (deployment) => deployment);

    await expect(
      recoverD1TemporaryStaticDeployment({
        state: durableState,
        begin: async () => {
          durableState = "deploying";
        },
        upload,
        inspect,
        checkpoint,
      }),
    ).rejects.toThrow("provider response lost");
    await expect(
      recoverD1TemporaryStaticDeployment({
        state: durableState,
        begin: async () => {
          throw new Error("deployment already began");
        },
        upload,
        inspect,
        checkpoint,
      }),
    ).resolves.toEqual({
      providerDeploymentId: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
      providerVersionId: "282bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
      workersDevUrl: "https://shiplet-preview-a.workers.dev/",
      serializedBodyBytes: 512,
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  it("checkpoints interrupted work for cleanup before the provider call and resumes after failure", async () => {
    await seedAccountReady();
    const cleanup = vi
      .fn()
      .mockImplementationOnce(async () => {
        const row = await testEnv.DB.prepare(
          `SELECT state, authorization_ref FROM temporary_provider_operations
           WHERE operation_id = ?`,
        )
          .bind(binding().operationId)
          .first<Record<string, unknown>>();
        expect(row).toEqual({
          state: "cleanup_pending",
          authorization_ref: "vault_authority_target_A",
        });
        throw new Error("provider unavailable");
      })
      .mockResolvedValueOnce({ serializedBodyBytes: 0 });

    await expect(
      reconcileD1TemporaryProviderOperations({
        db: testEnv.DB,
        now: NOW + 10,
        limit: 25,
        cleanup,
        audit,
      }),
    ).resolves.toEqual({ examined: 1, cleaned: 0, expired: 0, failed: 1 });
    expect(
      await testEnv.DB.prepare(
        `SELECT state FROM temporary_provider_operations WHERE operation_id = ?`,
      )
        .bind(binding().operationId)
        .first<Record<string, unknown>>(),
    ).toEqual({ state: "cleanup_pending" });
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM encrypted_records",
      ).first<{ count: number }>(),
    ).toEqual({ count: 2 });

    await expect(
      reconcileD1TemporaryProviderOperations({
        db: testEnv.DB,
        now: NOW + 11,
        limit: 25,
        cleanup,
        audit,
      }),
    ).resolves.toEqual({ examined: 1, cleaned: 1, expired: 0, failed: 0 });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(
      await testEnv.DB.prepare(
        `SELECT state FROM temporary_provider_operations WHERE operation_id = ?`,
      )
        .bind(binding().operationId)
        .first<Record<string, unknown>>(),
    ).toEqual({ state: "cleaned" });
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM encrypted_records",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("recovers only orphaned active results while leaving persisted active deployments alone", async () => {
    const orphan = binding();
    const persisted = binding({
      operationId: "deployment_journal_recovery_B",
      targetId: "target_B",
      scriptName: "shiplet-preview-b",
      requestDigest: `sha256:${"c".repeat(64)}`,
    });
    await seedAccountReady(orphan, { active: true });
    await seedAccountReady(persisted, {
      active: true,
      persistDeployment: true,
    });

    await expect(
      listD1RecoverableTemporaryProviderOperations(testEnv.DB, 25),
    ).resolves.toEqual([
      expect.objectContaining({
        operationId: orphan.operationId,
        state: "active",
      }),
    ]);
  });

  it("expires an uncheckpointed provisioning result only after its ambiguity fence", async () => {
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
    const cleanup = vi.fn();

    await expect(
      reconcileD1TemporaryProviderOperations({
        db: testEnv.DB,
        now: NOW + 29_999,
        limit: 25,
        cleanup,
        audit,
      }),
    ).resolves.toEqual({ examined: 1, cleaned: 0, expired: 0, failed: 0 });
    await expect(
      reconcileD1TemporaryProviderOperations({
        db: testEnv.DB,
        now: NOW + 30_000,
        limit: 25,
        cleanup,
        audit,
      }),
    ).resolves.toEqual({ examined: 1, cleaned: 0, expired: 1, failed: 0 });
    expect(cleanup).not.toHaveBeenCalled();
  });
});
