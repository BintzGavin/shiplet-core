import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createD1DeploymentRepository,
  ensureD1DeploymentRepositorySchema,
} from "../src/d1-deployment-repository";
import app from "../src/index";

async function initialize() {
  await app.fetch(new Request("http://localhost/health"), env as Env);
  await ensureD1DeploymentRepositorySchema((env as Env).DB);
}

async function seedProject(id: string) {
  const now = new Date().toISOString();
  await (env as Env).DB.prepare(
    `INSERT OR IGNORE INTO projects (
		 id, organization_id, owner_user_id, name, subdomain, source_type,
		 script_content, visibility, created_on, modified_on
		) VALUES (?, ?, ?, ?, ?, 'static', '', 'private', ?, ?)`,
  )
    .bind(
      id,
      `org_${id}`,
      `user_${id}`,
      `Project ${id}`,
      `project-${crypto.randomUUID().slice(0, 8)}`,
      now,
      now,
    )
    .run();
}

async function seedRevision(projectId: string, revisionId: string) {
  const createdOn = new Date().toISOString();
  await (env as Env).DB.batch([
    (env as Env).DB.prepare(
      `INSERT INTO shiplet_revisions (
			 id, project_id, parent_revision_id, package_json, package_digest,
			 content_digest, runtime_compatibility, validation_report_json,
			 created_by_actor_kind, created_by_actor_id, created_on
			) VALUES (?, ?, NULL, '{}', ?, ?, 'shiplet.runtime/v1', '{}',
			 'human', ?, ?)`,
    ).bind(
      revisionId,
      projectId,
      `sha256:${"1".repeat(64)}`,
      `sha256:${"2".repeat(64)}`,
      `user_${projectId}`,
      createdOn,
    ),
    (env as Env).DB.prepare(
      "INSERT INTO shiplet_revision_seals (revision_id, sealed_on) VALUES (?, ?)",
    ).bind(revisionId, createdOn),
  ]);
}

async function seedTemporaryTarget(projectId: string, targetId: string) {
  await (env as Env).DB.prepare(
    `INSERT INTO deployment_targets (
		 id, project_id, kind, owner_kind, owner_id, connection_id,
		 provider_account_id, configuration_json, created_on, detached_on
		) VALUES (?, ?, 'temporary_claim', 'human', ?, NULL,
		 'temporary_account', ?, ?, NULL)`,
  )
    .bind(
      targetId,
      projectId,
      `user_${projectId}`,
      JSON.stringify({
        scriptName: `temporary-${crypto.randomUUID()}`,
        status: "connected",
        resourceBindingRefs: [],
      }),
      new Date().toISOString(),
    )
    .run();
}

describe("D1 deployment repository", () => {
  beforeAll(initialize);

  it("scopes targets and resources to one Shiplet and target", async () => {
    const shipletA = `project_${crypto.randomUUID()}`;
    const shipletB = `project_${crypto.randomUUID()}`;
    await seedProject(shipletA);
    await seedProject(shipletB);
    const targetId = `target_${crypto.randomUUID()}`;
    const resourceId = `resource_${crypto.randomUUID()}`;
    await (env as Env).DB.batch([
      (env as Env).DB.prepare(
        `INSERT INTO deployment_targets (
				 id, project_id, kind, owner_kind, owner_id, connection_id,
				 provider_account_id, configuration_json, created_on, detached_on
				) VALUES (?, ?, 'customer_cloudflare', 'human', ?, ?, ?, ?, ?, NULL)`,
      ).bind(
        targetId,
        shipletA,
        `user_${shipletA}`,
        `connection_${crypto.randomUUID()}`,
        `account_${crypto.randomUUID()}`,
        JSON.stringify({
          scriptName: `shiplet-${crypto.randomUUID()}`,
          status: "connected",
          resourceBindingRefs: [resourceId],
        }),
        new Date().toISOString(),
      ),
      (env as Env).DB.prepare(
        `INSERT INTO deployment_target_resources (
				 id, project_id, target_id, name, kind, provider_resource_id,
				 value, visibility
				) VALUES (?, ?, ?, 'STATE', 'd1', ?, NULL, 'private')`,
      ).bind(resourceId, shipletA, targetId, `provider_${crypto.randomUUID()}`),
    ]);
    const repository = createD1DeploymentRepository({
      db: (env as Env).DB,
      now: () => 1_900_000_000_000,
    });
    const target = await repository.getTargetScoped({
      shipletId: shipletA,
      targetId,
    });
    expect(target).toMatchObject({
      id: targetId,
      shipletId: shipletA,
      kind: "customer_cloudflare",
      status: "connected",
      resourceBindingRefs: [resourceId],
    });
    expect(
      await repository.getTargetScoped({ shipletId: shipletB, targetId }),
    ).toBeNull();
    expect(
      await repository.resolveTargetResources({
        shipletId: shipletA,
        targetId,
        resourceRefs: [resourceId],
      }),
    ).toEqual([
      expect.objectContaining({
        id: resourceId,
        shipletId: shipletA,
        targetId,
        name: "STATE",
      }),
    ]);
    expect(
      await repository.resolveTargetResources({
        shipletId: shipletB,
        targetId,
        resourceRefs: [resourceId],
      }),
    ).toBeNull();
  });

  it("reserves one exact target operation, replays the same intent, and rejects altered reuse", async () => {
    const shipletId = `project_${crypto.randomUUID()}`;
    const revisionId = `revision_${crypto.randomUUID()}`;
    const targetId = `target_${crypto.randomUUID()}`;
    await seedProject(shipletId);
    await seedRevision(shipletId, revisionId);
    await (env as Env).DB.prepare(
      `INSERT INTO deployment_targets (
			 id, project_id, kind, owner_kind, owner_id, connection_id,
			 provider_account_id, configuration_json, created_on, detached_on
			) VALUES (?, ?, 'customer_cloudflare', 'human', ?, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        targetId,
        shipletId,
        `user_${shipletId}`,
        `connection_${crypto.randomUUID()}`,
        `account_${crypto.randomUUID()}`,
        JSON.stringify({ scriptName: "isolated-worker", status: "connected" }),
        new Date().toISOString(),
      )
      .run();
    const repository = createD1DeploymentRepository({
      db: (env as Env).DB,
      now: () => 1_900_000_000_000,
    });
    const input = {
      shipletId,
      targetId,
      expectedKnownGoodDeploymentId: null,
      idempotencyKey: `idem_${crypto.randomUUID()}`,
      operation: "deploy" as const,
      revisionId,
      intentDigest: `sha256:${"3".repeat(64)}`,
    };
    const [first, competing] = await Promise.all([
      repository.reserveTargetOperation(input),
      repository.reserveTargetOperation({
        ...input,
        idempotencyKey: `idem_${crypto.randomUUID()}`,
      }),
    ]);
    expect([first, competing].filter((result) => result.ok)).toHaveLength(1);
    const replay = await repository.reserveTargetOperation(input);
    expect(replay).toMatchObject({ ok: true, replay: true });
    const mismatch = await repository.reserveTargetOperation({
      ...input,
      intentDigest: `sha256:${"4".repeat(64)}`,
    });
    expect(mismatch).toEqual({
      ok: false,
      reason: "idempotency_intent_mismatch",
    });
  });

  it("keeps a target durably locked while an ambiguous provider outcome requires reconciliation", async () => {
    const shipletId = `project_${crypto.randomUUID()}`;
    const revisionId = `revision_${crypto.randomUUID()}`;
    const targetId = `target_${crypto.randomUUID()}`;
    await seedProject(shipletId);
    await seedRevision(shipletId, revisionId);
    await (env as Env).DB.prepare(
      `INSERT INTO deployment_targets (
			 id, project_id, kind, owner_kind, owner_id, connection_id,
			 provider_account_id, configuration_json, created_on, detached_on
			) VALUES (?, ?, 'customer_cloudflare', 'human', ?, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        targetId,
        shipletId,
        `user_${shipletId}`,
        `connection_${crypto.randomUUID()}`,
        `account_${crypto.randomUUID()}`,
        JSON.stringify({
          scriptName: "reconciliation-worker",
          status: "connected",
        }),
        new Date().toISOString(),
      )
      .run();
    const repository = createD1DeploymentRepository({
      db: (env as Env).DB,
      now: () => 1_900_000_000_000,
    });
    const firstInput = {
      shipletId,
      targetId,
      expectedKnownGoodDeploymentId: null,
      idempotencyKey: `idem_${crypto.randomUUID()}`,
      operation: "deploy" as const,
      revisionId,
      intentDigest: `sha256:${"7".repeat(64)}`,
    };
    const reserved = await repository.reserveTargetOperation(firstInput);
    if (!reserved.ok) throw new Error("reservation failed");
    await repository.abortTargetOperation({
      journalId: String(reserved.journal.id),
      status: "reconcile_required",
      reason: "provider_promotion_outcome_unknown",
    });

    expect(await repository.reserveTargetOperation(firstInput)).toMatchObject({
      ok: true,
      replay: true,
      journal: { status: "reconcile_required" },
    });
    expect(
      await repository.reserveTargetOperation({
        ...firstInput,
        idempotencyKey: `idem_${crypto.randomUUID()}`,
      }),
    ).toEqual({ ok: false, reason: "operation_in_progress" });

    await repository.abortTargetOperation({
      journalId: String(reserved.journal.id),
      status: "failed",
      reason: "unsafe_reclassification_attempt",
    });
    expect(
      await repository.reserveTargetOperation({
        ...firstInput,
        idempotencyKey: `idem_${crypto.randomUUID()}`,
      }),
    ).toEqual({ ok: false, reason: "operation_in_progress" });

    await repository.markTargetOperationCompensated({
      journalId: String(reserved.journal.id),
    });
    expect(
      await repository.reserveTargetOperation({
        ...firstInput,
        idempotencyKey: `idem_${crypto.randomUUID()}`,
      }),
    ).toMatchObject({ ok: true, replay: false });
  });

  it("uses one target-wide fence across revision promotion and temporary mutation paths", async () => {
    const shipletId = `project_${crypto.randomUUID()}`;
    const revisionId = `revision_${crypto.randomUUID()}`;
    const targetId = `target_${crypto.randomUUID()}`;
    await seedProject(shipletId);
    await seedRevision(shipletId, revisionId);
    await seedTemporaryTarget(shipletId, targetId);
    const repository = createD1DeploymentRepository({
      db: (env as Env).DB,
      now: () => 1_900_000_000_000,
    });
    const promotion = await repository.reserveTargetOperation({
      shipletId,
      targetId,
      expectedKnownGoodDeploymentId: null,
      idempotencyKey: `promotion_${crypto.randomUUID()}`,
      operation: "promotion",
      revisionId,
      intentDigest: `sha256:${"8".repeat(64)}`,
    });
    expect(promotion).toMatchObject({ ok: true, replay: false });
    expect(
      await repository.reserveTargetOperation({
        shipletId,
        targetId,
        expectedKnownGoodDeploymentId: null,
        idempotencyKey: `temporary_${crypto.randomUUID()}`,
        operation: "claim_create",
        revisionId,
        intentDigest: `sha256:${"9".repeat(64)}`,
      }),
    ).toEqual({ ok: false, reason: "operation_in_progress" });
  });

  it("finalizes a known-good deployment only through its exact reserved journal", async () => {
    const shipletId = `project_${crypto.randomUUID()}`;
    const revisionId = `revision_${crypto.randomUUID()}`;
    const targetId = `target_${crypto.randomUUID()}`;
    await seedProject(shipletId);
    await seedRevision(shipletId, revisionId);
    await (env as Env).DB.prepare(
      `INSERT INTO deployment_targets (
			 id, project_id, kind, owner_kind, owner_id, connection_id,
			 provider_account_id, configuration_json, created_on, detached_on
			) VALUES (?, ?, 'customer_cloudflare', 'human', ?, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        targetId,
        shipletId,
        `user_${shipletId}`,
        `connection_${crypto.randomUUID()}`,
        `account_${crypto.randomUUID()}`,
        JSON.stringify({
          scriptName: "known-good-worker",
          status: "connected",
        }),
        new Date().toISOString(),
      )
      .run();
    const repository = createD1DeploymentRepository({
      db: (env as Env).DB,
      now: () => 1_900_000_000_000,
    });
    const reserved = await repository.reserveTargetOperation({
      shipletId,
      targetId,
      expectedKnownGoodDeploymentId: null,
      idempotencyKey: `idem_${crypto.randomUUID()}`,
      operation: "deploy",
      revisionId,
      intentDigest: `sha256:${"5".repeat(64)}`,
    });
    if (!reserved.ok) throw new Error("reservation failed");
    const deploymentId = `deployment_${crypto.randomUUID()}`;
    const finalized = await repository.finalizeTargetOperation({
      journalId: String(reserved.journal.id),
      record: {
        id: deploymentId,
        targetId,
        revisionId,
        providerVersionId: "version-known-good",
        providerDeploymentId: "provider-deployment-known-good",
        status: "known_good",
        supersedesDeploymentId: null,
        deployedAt: 1_900_000_000_000,
      },
      effectEvent: {
        eventId: `effect_${crypto.randomUUID()}`,
        eventKind: "cloudflare.deployment.promoted",
        shipletId,
        targetId,
        revisionId,
        deploymentId,
        actorKind: "human",
        actorId: `user_${shipletId}`,
        outcome: "success",
        occurredAt: 1_900_000_000_000,
      },
    });
    expect(finalized).toBe(true);
    expect(await repository.getKnownGood(targetId)).toMatchObject({
      id: deploymentId,
      targetId,
      revisionId,
      status: "known_good",
    });
    expect(
      await repository.getDeploymentScoped({
        shipletId,
        targetId,
        deploymentId,
      }),
    ).toMatchObject({ id: deploymentId });
    expect(
      await repository.finalizeTargetOperation({
        journalId: String(reserved.journal.id),
        record: { ...(await repository.getKnownGood(targetId))! },
      }),
    ).toBe(false);
    const outbox = await (env as Env).DB.prepare(
      `SELECT journal_id, event_kind, event_json
			 FROM deployment_effect_outbox WHERE journal_id = ?`,
    )
      .bind(String(reserved.journal.id))
      .first<Record<string, unknown>>();
    expect(outbox).toMatchObject({
      journal_id: String(reserved.journal.id),
      event_kind: "cloudflare.deployment.promoted",
    });
    expect(JSON.parse(String(outbox?.event_json))).toMatchObject({
      deploymentId,
      targetId,
      outcome: "success",
    });
    await expect(
      repository.completeTargetOperation?.({
        journalId: String(reserved.journal.id),
        resultDeploymentId: deploymentId,
        status: "finalized",
      }),
    ).resolves.toBe(true);
  });

  it("marks a temporary claim delivered exactly once", async () => {
    const shipletId = `project_${crypto.randomUUID()}`;
    const revisionId = `revision_${crypto.randomUUID()}`;
    const targetId = `target_${crypto.randomUUID()}`;
    await seedProject(shipletId);
    await seedRevision(shipletId, revisionId);
    await seedTemporaryTarget(shipletId, targetId);
    const repository = createD1DeploymentRepository({
      db: (env as Env).DB,
      now: () => 1_900_000_000_000,
    });
    await repository.recordTemporaryClaim({
      operationId: `deployment_journal_${crypto.randomUUID()}`,
      targetId,
      shipletId,
      revisionId,
      status: "awaiting_claim",
      vaultRef: `vault_${crypto.randomUUID()}`,
      expiresAt: 1_900_000_060_000,
      providerDeploymentId: `provider_deployment_${crypto.randomUUID()}`,
      providerVersionId: `provider_version_${crypto.randomUUID()}`,
    });
    const claimRow = await (env as Env).DB.prepare(
      `SELECT claim.shiplet_id, claim.revision_id, claim.status,
			 claim.expires_at_ms, target.owner_id, target.detached_on
			 FROM deployment_temporary_claims claim
			 JOIN deployment_targets target ON target.id = claim.target_id
			 WHERE claim.target_id = ?`,
    )
      .bind(targetId)
      .first<Record<string, unknown>>();
    expect(claimRow).toMatchObject({
      shiplet_id: shipletId,
      revision_id: revisionId,
      status: "awaiting_claim",
      expires_at_ms: 1_900_000_060_000,
      owner_id: `user_${shipletId}`,
      detached_on: null,
    });
    const deliveryEventId = `audit_${crypto.randomUUID()}`;
    const deliver = (eventId: string) =>
      repository.markTemporaryClaimDelivered({
        targetId,
        expectedStatus: "awaiting_claim",
        delivery: {
          eventId,
          shipletId,
          revisionId,
          actor: { kind: "human", id: `user_${shipletId}` },
          occurredAt: 1_900_000_000_000,
        },
      });
    const outcomes = [
      await deliver(deliveryEventId),
      await deliver(deliveryEventId),
      await deliver(`audit_${crypto.randomUUID()}`),
    ];
    const audit = await (env as Env).DB.prepare(
      `SELECT project_id, revision_id, actor_kind, actor_id, event_kind,
			 status_category, payload_json FROM shiplet_audit_events
			 WHERE project_id = ? AND event_kind = 'cloudflare.temporary_claim.delivered'`,
    )
      .bind(shipletId)
      .all<Record<string, unknown>>();
    expect(audit.results).toHaveLength(1);
    expect(outcomes).toEqual([true, true, false]);
    expect(audit.results[0]).toMatchObject({
      project_id: shipletId,
      revision_id: revisionId,
      actor_kind: "human",
      actor_id: `user_${shipletId}`,
      event_kind: "cloudflare.temporary_claim.delivered",
      status_category: "informational",
    });
    expect(JSON.parse(String(audit.results[0].payload_json))).toEqual({
      targetId,
    });
  });

  it("reserves one temporary claim record without allowing replacement by a second claim", async () => {
    const repository = createD1DeploymentRepository({
      db: (env as Env).DB,
      now: () => 1_900_000_000_000,
    });
    const targetId = `target_${crypto.randomUUID()}`;
    const shipletId = `project_${crypto.randomUUID()}`;
    await repository.recordTemporaryClaim({
      operationId: `deployment_journal_${crypto.randomUUID()}`,
      targetId,
      shipletId,
      revisionId: `revision_${crypto.randomUUID()}`,
      status: "awaiting_claim",
      vaultRef: `vault_${crypto.randomUUID()}`,
      expiresAt: 1_900_000_060_000,
      providerDeploymentId: `provider_deployment_${crypto.randomUUID()}`,
      providerVersionId: `provider_version_${crypto.randomUUID()}`,
    });
    await expect(
      repository.recordTemporaryClaim({
        operationId: `deployment_journal_${crypto.randomUUID()}`,
        targetId,
        shipletId,
        revisionId: `revision_${crypto.randomUUID()}`,
        status: "awaiting_claim",
        vaultRef: `vault_${crypto.randomUUID()}`,
        expiresAt: 1_900_000_060_000,
        providerDeploymentId: `provider_deployment_${crypto.randomUUID()}`,
        providerVersionId: `provider_version_${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow("Temporary claim already exists");
    const retained = await repository.getTemporaryClaim!(targetId);
    expect(retained).toMatchObject({
      targetId,
      shipletId,
      status: "awaiting_claim",
    });
  });

  it("durably records a cleanup-retry tuple even when no vault reference or valid expiry exists", async () => {
    const repository = createD1DeploymentRepository({
      db: (env as Env).DB,
      now: () => 1_900_000_000_000,
    });
    const targetId = `target_${crypto.randomUUID()}`;
    const shipletId = `project_${crypto.randomUUID()}`;
    const revisionId = `revision_${crypto.randomUUID()}`;
    await repository.recordTemporaryClaim({
      targetId,
      shipletId,
      revisionId,
      status: "cleanup_retry",
      vaultRef: null,
      expiresAt: null,
      providerDeploymentId: `provider_deployment_${crypto.randomUUID()}`,
      providerVersionId: `provider_version_${crypto.randomUUID()}`,
      providerCleaned: false,
      failureReason: "temporary_provider_expiry_invalid",
    });
    expect(await repository.getTemporaryClaim!(targetId)).toMatchObject({
      targetId,
      shipletId,
      revisionId,
      status: "cleanup_retry",
      vaultRef: null,
      expiresAt: null,
      providerCleaned: false,
      failureReason: "temporary_provider_expiry_invalid",
    });
  });
});
