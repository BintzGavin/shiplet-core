import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deliverD1PreparedTemporaryClaim,
  expireD1TemporaryClaimRecords,
  prepareD1TemporaryClaimDelivery,
  redeemD1TemporaryClaimRedirect,
} from "../src/cloudflare-support/d1-temporary-operations";

type TestEnv = { DB: D1Database };
const testEnv = env as TestEnv;
const NOW = 1_800_000_000_000;
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const REQUEST_DIGEST = `sha256:${"b".repeat(64)}`;

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    deploymentId: "temporary_deployment_A",
    operationId: "deployment_journal_temporary_A",
    deliveryEventId: "event_temporary_claim_A",
    userId: "user_A",
    shipletId: "shiplet_A",
    targetId: "target_A",
    revisionId: "revision_A",
    handleDigest: "c".repeat(64),
    handleRef: "vault_redirect_handle_A",
    expiresAt: NOW + 600_000,
    now: NOW,
    ...overrides,
  };
}

async function seedDeployment(input: {
  id?: string;
  operationId?: string | null;
  shipletId?: string | null;
} = {}) {
  await testEnv.DB.prepare(
    `INSERT INTO temporary_deployments (
       id, user_id, shiplet_id, target_id, revision_id, package_digest,
       account_id, script_name, request_digest, provider_deployment_id,
       provider_version_id, workers_dev_url, authorization_ref, claim_ref,
       account_expires_at, claim_expires_at, status, created_on,
       claim_delivered_on, cleaned_on, operation_id, delivery_event_id,
       delivery_started_on
     ) VALUES (?, 'user_A', ?, 'target_A', 'revision_A', ?,
       'temporary_account_A', 'shiplet-preview-a', ?, 'provider_A',
       'version_A', 'https://shiplet-preview-a.workers.dev/',
       'vault_authority_A', 'vault_claim_A', ?, ?, 'active', ?, NULL, NULL,
       ?, NULL, NULL)`,
  )
    .bind(
      input.id ?? "temporary_deployment_A",
      input.shipletId === undefined ? "shiplet_A" : input.shipletId,
      PACKAGE_DIGEST,
      REQUEST_DIGEST,
      NOW + 3_600_000,
      NOW + 600_000,
      new Date(NOW).toISOString(),
      input.operationId === undefined
        ? "deployment_journal_temporary_A"
        : input.operationId,
    )
    .run();
}

describe("temporary claim delivery recovery", () => {
  beforeEach(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare("DROP TABLE IF EXISTS encrypted_records"),
      testEnv.DB.prepare("DROP TABLE IF EXISTS cloudflare_connections"),
      testEnv.DB.prepare("DROP TABLE IF EXISTS backend_redirects"),
      testEnv.DB.prepare("DROP TABLE IF EXISTS temporary_deployments"),
      testEnv.DB.prepare(
        `CREATE TABLE encrypted_records (
          id TEXT PRIMARY KEY,
          purpose TEXT NOT NULL,
          nonce TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          status TEXT NOT NULL,
          expires_at INTEGER,
          created_on TEXT NOT NULL,
          retired_on TEXT
        )`,
      ),
      testEnv.DB.prepare(
        `CREATE TABLE cloudflare_connections (
          id TEXT PRIMARY KEY,
          credential_ref TEXT NOT NULL
        )`,
      ),
      testEnv.DB.prepare(
        `CREATE TABLE temporary_deployments (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          shiplet_id TEXT,
          target_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          package_digest TEXT NOT NULL,
          account_id TEXT NOT NULL,
          script_name TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          provider_deployment_id TEXT NOT NULL UNIQUE,
          provider_version_id TEXT NOT NULL,
          workers_dev_url TEXT NOT NULL,
          authorization_ref TEXT,
          claim_ref TEXT,
          account_expires_at INTEGER NOT NULL,
          claim_expires_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'claim_delivered', 'expired', 'cleaned')),
          created_on TEXT NOT NULL,
          claim_delivered_on TEXT,
          cleaned_on TEXT,
          operation_id TEXT,
          delivery_event_id TEXT,
          delivery_started_on TEXT
        )`,
      ),
      testEnv.DB.prepare(
        `CREATE TABLE backend_redirects (
          handle_digest TEXT PRIMARY KEY,
          temporary_deployment_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_on TEXT,
          created_on TEXT NOT NULL,
          delivery_event_id TEXT,
          handle_ref TEXT,
          FOREIGN KEY (temporary_deployment_id) REFERENCES temporary_deployments(id)
        )`,
      ),
      testEnv.DB.prepare(
        `CREATE UNIQUE INDEX idx_test_delivery_event
         ON backend_redirects(delivery_event_id)
         WHERE delivery_event_id IS NOT NULL`,
      ),
    ]);
  });

  it("persists a stable encrypted handle and event before invoking the kernel callback", async () => {
    // Given an exact, non-legacy temporary deployment and an encrypted handle ref.
    await seedDeployment();
    const timeline: string[] = [];
    const prepared = await prepareD1TemporaryClaimDelivery({
      db: testEnv.DB,
      delivery: delivery(),
    });

    // When the trusted kernel marks the same event delivered.
    const result = await deliverD1PreparedTemporaryClaim({
      prepared,
      markDelivered: async (event) => {
        timeline.push(`kernel:${event.deliveryEventId}`);
        const stored = await testEnv.DB.prepare(
          `SELECT handle_ref, delivery_event_id FROM backend_redirects
           WHERE temporary_deployment_id = ?`,
        )
          .bind("temporary_deployment_A")
          .first<Record<string, unknown>>();
        expect(stored).toEqual({
          handle_ref: "vault_redirect_handle_A",
          delivery_event_id: "event_temporary_claim_A",
        });
        return true;
      },
      openRedirectHandle: async (ref) => {
        timeline.push(`vault:${ref}`);
        return "claim_delivery_stable_A";
      },
      digest: async (value) =>
        value === "claim_delivery_stable_A" ? "c".repeat(64) : "wrong",
    });

    // Then the browser gets only the opaque redirect handle, and every support
    // write was already durable before the kernel callback.
    expect(result).toEqual({
      ok: true,
      redirect: {
        kind: "trusted_backend_redirect",
        opaqueHandle: "claim_delivery_stable_A",
      },
    });
    expect(timeline).toEqual([
      "kernel:event_temporary_claim_A",
      "vault:vault_redirect_handle_A",
    ]);
    const deployment = await testEnv.DB.prepare(
      `SELECT status, delivery_event_id, delivery_started_on
       FROM temporary_deployments WHERE id = ?`,
    )
      .bind("temporary_deployment_A")
      .first<Record<string, unknown>>();
    expect(deployment).toEqual({
      status: "claim_delivered",
      delivery_event_id: "event_temporary_claim_A",
      delivery_started_on: new Date(NOW).toISOString(),
    });
  });

  it("resumes the exact same event and encrypted handle after an ambiguous kernel callback", async () => {
    // Given claim delivery prepared before the first callback attempt.
    await seedDeployment();
    const first = await prepareD1TemporaryClaimDelivery({
      db: testEnv.DB,
      delivery: delivery(),
    });
    await expect(
      deliverD1PreparedTemporaryClaim({
        prepared: first,
        markDelivered: async () => false,
        openRedirectHandle: vi.fn(),
        digest: vi.fn(),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "claim_delivery_conflict",
    });

    // When the request retries with exactly the same event and binding.
    const replay = await prepareD1TemporaryClaimDelivery({
      db: testEnv.DB,
      delivery: delivery({ now: NOW + 1 }),
    });
    const delivered = await deliverD1PreparedTemporaryClaim({
      prepared: replay,
      markDelivered: async (event) =>
        event.deliveryEventId === "event_temporary_claim_A",
      openRedirectHandle: async () => "claim_delivery_stable_A",
      digest: async () => "c".repeat(64),
    });

    // Then it reuses the original encrypted handle instead of minting a second
    // redirect or event.
    expect(replay).toMatchObject({
      ok: true,
      replay: true,
      delivery: {
        deliveryEventId: "event_temporary_claim_A",
        handleRef: "vault_redirect_handle_A",
        handleDigest: "c".repeat(64),
      },
    });
    expect(delivered).toMatchObject({
      ok: true,
      redirect: { opaqueHandle: "claim_delivery_stable_A" },
    });
    const redirects = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM backend_redirects",
    ).first<{ count: number }>();
    expect(redirects?.count).toBe(1);
  });

  it("replays the same event and handle when the kernel commits but its response is lost", async () => {
    await seedDeployment();
    const first = await prepareD1TemporaryClaimDelivery({
      db: testEnv.DB,
      delivery: delivery(),
    });
    let committedEventId: string | null = null;
    let auditWrites = 0;
    await expect(
      deliverD1PreparedTemporaryClaim({
        prepared: first,
        markDelivered: async (event) => {
          committedEventId = event.deliveryEventId;
          auditWrites += 1;
          throw new Error("callback response lost");
        },
        openRedirectHandle: vi.fn(),
        digest: vi.fn(),
      }),
    ).rejects.toThrow("callback response lost");

    const replay = await prepareD1TemporaryClaimDelivery({
      db: testEnv.DB,
      delivery: delivery({ now: NOW + 1 }),
    });
    const delivered = await deliverD1PreparedTemporaryClaim({
      prepared: replay,
      markDelivered: async (event) => {
        if (event.deliveryEventId !== committedEventId) return false;
        return true;
      },
      openRedirectHandle: async () => "claim_delivery_stable_A",
      digest: async () => "c".repeat(64),
    });

    expect(replay).toMatchObject({
      ok: true,
      replay: true,
      delivery: {
        deliveryEventId: "event_temporary_claim_A",
        handleRef: "vault_redirect_handle_A",
      },
    });
    expect(delivered).toMatchObject({
      ok: true,
      redirect: { opaqueHandle: "claim_delivery_stable_A" },
    });
    expect(auditWrites).toBe(1);
  });

  it.each([
    ["wrong Shiplet", { shipletId: "shiplet_B" }],
    ["wrong operation", { operationId: "deployment_journal_sibling" }],
    ["wrong event", { deliveryEventId: "event_sibling" }],
    ["wrong handle", { handleRef: "vault_redirect_handle_B" }],
  ])("fails closed when a prepared delivery is replayed with %s", async (_label, change) => {
    // Given one delivery has already been durably prepared.
    await seedDeployment();
    await prepareD1TemporaryClaimDelivery({
      db: testEnv.DB,
      delivery: delivery(),
    });

    // When an attacker changes any event or scope binding, then no handle is returned.
    await expect(
      prepareD1TemporaryClaimDelivery({
        db: testEnv.DB,
        delivery: delivery({ ...change, now: NOW + 1 }),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "temporary_claim_binding_conflict",
    });
  });

  it("keeps legacy rows with null Shiplet or operation identity claim-ineligible", async () => {
    // Given a pre-migration temporary deployment whose exact kernel identity is absent.
    await seedDeployment({ shipletId: null, operationId: null });

    // When claim delivery is attempted, it fails closed; automated expiry and
    // cleanup may still operate on the legacy provider record separately.
    await expect(
      prepareD1TemporaryClaimDelivery({
        db: testEnv.DB,
        delivery: delivery(),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "temporary_claim_binding_conflict",
    });
    const row = await testEnv.DB.prepare(
      "SELECT status, authorization_ref FROM temporary_deployments WHERE id = ?",
    )
      .bind("temporary_deployment_A")
      .first<Record<string, unknown>>();
    expect(row).toEqual({
      status: "active",
      authorization_ref: "vault_authority_A",
    });
  });

  it("opens the claim before consuming and leaves the exact prepared redirect retryable when opening fails", async () => {
    await seedDeployment();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO encrypted_records
          (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
         VALUES (?, 'temporary_claim', 'nonce-a', 'cipher-a', 'active', ?, ?, NULL)`,
      ).bind("vault_claim_A", NOW + 600_000, new Date(NOW).toISOString()),
      testEnv.DB.prepare(
        `INSERT INTO encrypted_records
          (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
         VALUES (?, 'temporary_redirect_handle', 'nonce-b', 'cipher-b', 'active', ?, ?, NULL)`,
      ).bind(
        "vault_redirect_handle_A",
        NOW + 600_000,
        new Date(NOW).toISOString(),
      ),
    ]);
    await prepareD1TemporaryClaimDelivery({
      db: testEnv.DB,
      delivery: delivery(),
    });

    await expect(
      redeemD1TemporaryClaimRedirect({
        db: testEnv.DB,
        opaqueHandle: "claim_delivery_stable_A",
        now: NOW + 1,
        digest: async () => "c".repeat(64),
        openClaim: async () => {
          throw new Error("vault unavailable");
        },
      }),
    ).rejects.toThrow("vault unavailable");

    expect(
      await testEnv.DB.prepare(
        `SELECT redirect.consumed_on, deployment.claim_ref
         FROM backend_redirects redirect
         JOIN temporary_deployments deployment
           ON deployment.id = redirect.temporary_deployment_id
         WHERE redirect.handle_digest = ?`,
      )
        .bind("c".repeat(64))
        .first<Record<string, unknown>>(),
    ).toEqual({ consumed_on: null, claim_ref: "vault_claim_A" });
  });

  it("replays the exact actor-bound redirect after a committed response is lost", async () => {
    await seedDeployment();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO encrypted_records
          (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
         VALUES (?, 'temporary_claim', 'nonce-a', 'cipher-a', 'active', ?, ?, NULL)`,
      ).bind("vault_claim_A", NOW + 600_000, new Date(NOW).toISOString()),
      testEnv.DB.prepare(
        `INSERT INTO encrypted_records
          (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
         VALUES (?, 'temporary_redirect_handle', 'nonce-b', 'cipher-b', 'active', ?, ?, NULL)`,
      ).bind(
        "vault_redirect_handle_A",
        NOW + 600_000,
        new Date(NOW).toISOString(),
      ),
    ]);
    await prepareD1TemporaryClaimDelivery({
      db: testEnv.DB,
      delivery: delivery(),
    });
    const redeem = () =>
      redeemD1TemporaryClaimRedirect({
        db: testEnv.DB,
        opaqueHandle: "claim_delivery_stable_A",
        now: NOW + 1,
        digest: async () => "c".repeat(64),
        openClaim: async (claimRef) => {
          expect(claimRef).toBe("vault_claim_A");
          return "https://dash.cloudflare.com/claim/example";
        },
      });

    const outcomes = await Promise.all([redeem(), redeem()]);

    expect(outcomes).toEqual([
      "https://dash.cloudflare.com/claim/example",
      "https://dash.cloudflare.com/claim/example",
    ]);
    await expect(redeem()).resolves.toBe(
      "https://dash.cloudflare.com/claim/example",
    );
    expect(
      await testEnv.DB.prepare(
        `SELECT redirect.consumed_on, deployment.claim_ref
         FROM backend_redirects redirect
         JOIN temporary_deployments deployment
           ON deployment.id = redirect.temporary_deployment_id
         WHERE redirect.handle_digest = ?`,
      )
        .bind("c".repeat(64))
        .first<Record<string, unknown>>(),
    ).toEqual({
      consumed_on: new Date(NOW + 1).toISOString(),
      claim_ref: "vault_claim_A",
    });
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM encrypted_records
         WHERE id IN ('vault_claim_A', 'vault_redirect_handle_A')`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 2 });

    await expireD1TemporaryClaimRecords({
      db: testEnv.DB,
      now: NOW + 600_000,
    });
    expect(
      await testEnv.DB.prepare(
        `SELECT status, claim_ref FROM temporary_deployments
         WHERE id = 'temporary_deployment_A'`,
      ).first<Record<string, unknown>>(),
    ).toEqual({ status: "expired", claim_ref: null });
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM backend_redirects`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM encrypted_records
         WHERE id IN ('vault_claim_A', 'vault_redirect_handle_A')`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("fails closed without burning the redirect when either exact encrypted record is missing", async () => {
    await seedDeployment();
    await testEnv.DB.prepare(
      `INSERT INTO encrypted_records
        (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
       VALUES (?, 'temporary_claim', 'nonce-a', 'cipher-a', 'active', ?, ?, NULL)`,
    )
      .bind("vault_claim_A", NOW + 600_000, new Date(NOW).toISOString())
      .run();
    await prepareD1TemporaryClaimDelivery({
      db: testEnv.DB,
      delivery: delivery(),
    });

    await expect(
      redeemD1TemporaryClaimRedirect({
        db: testEnv.DB,
        opaqueHandle: "claim_delivery_stable_A",
        now: NOW + 1,
        digest: async () => "c".repeat(64),
        openClaim: async () => "https://dash.cloudflare.com/claim/example",
      }),
    ).resolves.toBeNull();
    expect(
      await testEnv.DB.prepare(
        `SELECT redirect.consumed_on, deployment.claim_ref
         FROM backend_redirects redirect
         JOIN temporary_deployments deployment
           ON deployment.id = redirect.temporary_deployment_id
         WHERE redirect.handle_digest = ?`,
      )
        .bind("c".repeat(64))
        .first<Record<string, unknown>>(),
    ).toEqual({ consumed_on: null, claim_ref: "vault_claim_A" });
  });
});
