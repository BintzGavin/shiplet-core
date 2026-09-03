import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  AtomicCapabilityUse,
  CapabilityAuditEvent,
  CapabilityGrant,
  TrustedApprovalBinding,
} from "../src/capability-broker";
import {
  createD1CapabilityKernel,
  ensureCapabilityKernelSchema,
} from "../src/d1-capability-kernel";
import { ensureSchema } from "../src/schema";
import { ensureRevisionSchema } from "../src/self-owned/revisions";

type TestEnv = { DB: D1Database };

const testEnv = env as TestEnv;
const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const ACTOR = { kind: "human" as const, id: "user_capability_a" };

async function seedShiplet(shipletId: string, revisionId: string) {
  const now = new Date(NOW).toISOString();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT OR IGNORE INTO projects (
				id, name, subdomain, script_content, visibility, created_on, modified_on
			) VALUES (?, ?, ?, '', 'private', ?, ?)`,
    ).bind(
      shipletId,
      shipletId,
      `${shipletId}-${crypto.randomUUID()}`,
      now,
      now,
    ),
    testEnv.DB.prepare(
      `INSERT OR IGNORE INTO shiplet_revisions (
				id, project_id, parent_revision_id, package_json, package_digest,
				runtime_compatibility, validation_report_json,
				created_by_actor_kind, created_by_actor_id, created_on
			) VALUES (?, ?, NULL, '{}', ?, 'shiplet-runtime/v1', '{}', 'human', ?, ?)`,
    ).bind(revisionId, shipletId, `sha256:${"0".repeat(64)}`, ACTOR.id, now),
  ]);
}

function approvalBinding(grant: CapabilityGrant): TrustedApprovalBinding {
  return {
    requestId: "request_capability_1",
    actor: grant.actor,
    grantId: grant.id,
    grantGeneration: grant.generation,
    shipletId: grant.shipletId,
    revisionId: grant.revisionId,
    action: grant.action,
    resource: grant.resource,
    effect: grant.effect,
    approvalPolicy: "trusted-human",
    inputDigest: `sha256:${"1".repeat(64)}`,
  };
}

function atomicUse(
  grant: CapabilityGrant,
  opaqueHandle: string,
  overrides: Partial<AtomicCapabilityUse> = {},
): AtomicCapabilityUse {
  return {
    opaqueHandle,
    grantId: grant.id,
    grantGeneration: grant.generation,
    actor: grant.actor,
    shipletId: grant.shipletId,
    revisionId: grant.revisionId,
    action: grant.action,
    resource: grant.resource,
    effect: grant.effect,
    approvalPolicy: grant.approval,
    approvalId: null,
    inputDigest: `sha256:${"1".repeat(64)}`,
    requestId: "request_capability_1",
    now: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  await ensureSchema(testEnv.DB);
  await ensureRevisionSchema(testEnv.DB);
  await ensureCapabilityKernelSchema(testEnv.DB);
  await seedShiplet("shiplet_capability_a", "revision_capability_a1");
  await seedShiplet("shiplet_capability_b", "revision_capability_b1");
});

describe("D1 capability kernel", () => {
  it("provides fail-closed authoritative approval lifecycle operations without returning stored authority", async () => {
    await testEnv.DB.prepare(
      `UPDATE projects SET active_revision_id = ?, active_revision_generation = 1
			 WHERE id = ?`,
    )
      .bind("revision_capability_a1", "shiplet_capability_a")
      .run();
    const kernel = createD1CapabilityKernel({ db: testEnv.DB, now: () => NOW });
    const issued = await kernel.issueGrant({
      actor: ACTOR,
      shipletId: "shiplet_capability_a",
      revisionId: "revision_capability_a1",
      activationFence: {
        revisionId: "revision_capability_a1",
        generation: 1,
      },
      action: "workflow.event:create",
      resource: "workflow:events",
      effect: "mutation",
      approval: "trusted-human",
      expiresAt: NOW + 60_000,
    });
    const grant = await kernel.resolveGrantAuthority({
      grantId: issued.grantId,
      grantGeneration: issued.generation,
      expected: {
        actor: ACTOR,
        shipletId: "shiplet_capability_a",
        revisionId: "revision_capability_a1",
        activationGeneration: 1,
        action: "workflow.event:create",
        resource: "workflow:events",
      },
    });
    expect(grant).toMatchObject({
      grant: { id: issued.grantId, revokedAt: null },
      activationFence: { revisionId: "revision_capability_a1", generation: 1 },
    });
    const binding = approvalBinding(grant!.grant);
    const approval = await kernel.issueTrustedApprovalIdempotent({
      binding,
      expiresAt: NOW + 30_000,
      idempotencyKey: "mcp-approval-issuance:approval_request_a",
    });
    await expect(
      kernel.issueTrustedApprovalIdempotent({
        binding,
        expiresAt: NOW + 30_000,
        idempotencyKey: "mcp-approval-issuance:approval_request_a",
      }),
    ).rejects.toThrow();
    const approvalDigest = `sha256:${Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(approval.approvalId),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")}`;
    expect(
      await kernel.resolveTrustedApprovalDigest({
        approvalDigest,
        binding,
        idempotencyKey: "mcp-approval-issuance:approval_request_a",
      }),
    ).toEqual({ active: true });
    expect(
      await kernel.resolveDispatchAuthorityAtomically({
        now: NOW,
        actor: ACTOR,
        shipletId: "shiplet_capability_a",
        revisionId: "revision_capability_a1",
        activationGeneration: 1,
        grantId: issued.grantId,
        grantGeneration: issued.generation,
        approvalDigest,
        binding,
        idempotencyKey: "mcp-approval-issuance:approval_request_a",
      }),
    ).toMatchObject({
      authorized: true,
      activationFence: {
        revisionId: "revision_capability_a1",
        generation: 1,
      },
      grant: { id: issued.grantId, revokedAt: null },
      approval: { digest: approvalDigest, revokedAt: null },
    });
    expect(
      await kernel.resolveDispatchAuthorityAtomically({
        now: NOW,
        actor: { kind: "agent", id: "agent_other" },
        shipletId: "shiplet_capability_a",
        revisionId: "revision_capability_a1",
        activationGeneration: 1,
        grantId: issued.grantId,
        grantGeneration: issued.generation,
        approvalDigest,
        binding,
        idempotencyKey: "mcp-approval-issuance:approval_request_a",
      }),
    ).toBeNull();
    expect(
      await kernel.revokeTrustedApproval({
        approvalDigest,
        idempotencyKey: "mcp-approval-issuance:approval_request_a",
      }),
    ).toEqual({ ok: true });
    expect(
      await kernel.resolveDispatchAuthorityAtomically({
        now: NOW,
        actor: ACTOR,
        shipletId: "shiplet_capability_a",
        revisionId: "revision_capability_a1",
        activationGeneration: 1,
        grantId: issued.grantId,
        grantGeneration: issued.generation,
        approvalDigest,
        binding,
        idempotencyKey: "mcp-approval-issuance:approval_request_a",
      }),
    ).toBeNull();
    expect(
      await kernel.compensateTrustedApproval({
        approvalId: approval.approvalId,
        binding,
        idempotencyKey: "mcp-approval-issuance:approval_request_a",
      }),
    ).toEqual({ ok: true });
    expect(
      await kernel.resolveTrustedApprovalDigest({
        approvalDigest,
        binding,
        idempotencyKey: "mcp-approval-issuance:approval_request_a",
      }),
    ).toBeNull();
  });

  it("persists only a digest of the opaque grant handle and resolves it inside the kernel", async () => {
    const kernel = createD1CapabilityKernel({ db: testEnv.DB, now: () => NOW });
    const issued = await kernel.issueGrant({
      actor: ACTOR,
      shipletId: "shiplet_capability_a",
      revisionId: "revision_capability_a1",
      action: "review.feedback.create",
      resource: "feedback:thread_a",
      effect: "mutation",
      approval: "trusted-human",
      expiresAt: NOW + 60_000,
    });

    const persisted = await testEnv.DB.prepare(
      "SELECT * FROM shiplet_broker_grants WHERE id = ?",
    )
      .bind(issued.grantId)
      .first<Record<string, unknown>>();
    expect(persisted).not.toBeNull();
    expect(JSON.stringify(persisted)).not.toContain(issued.opaqueHandle);
    expect(await kernel.resolveOpaqueHandle(issued.opaqueHandle)).toMatchObject(
      {
        id: issued.grantId,
        shipletId: "shiplet_capability_a",
        revisionId: "revision_capability_a1",
      },
    );
  });

  it("fails closed when sibling IDs, revisions, resources, or opaque handles are guessed", async () => {
    const kernel = createD1CapabilityKernel({ db: testEnv.DB, now: () => NOW });
    const issued = await kernel.issueGrant({
      actor: ACTOR,
      shipletId: "shiplet_capability_a",
      revisionId: "revision_capability_a1",
      action: "state.read",
      resource: "state:shiplet_capability_a",
      effect: "read",
      approval: "none",
      expiresAt: NOW + 60_000,
    });
    const grant = (await kernel.resolveOpaqueHandle(
      issued.opaqueHandle,
    )) as CapabilityGrant;

    expect(await kernel.resolveOpaqueHandle(issued.grantId)).toBeNull();
    expect(
      await kernel.revalidateAndClaim(
        atomicUse(grant, issued.opaqueHandle, {
          shipletId: "shiplet_capability_b",
          revisionId: "revision_capability_b1",
          resource: "state:shiplet_capability_b",
        }),
      ),
    ).toEqual({ ok: false, reason: "scope_mismatch" });
  });

  it("claims a request exactly once under concurrent mutation attempts", async () => {
    const kernel = createD1CapabilityKernel({ db: testEnv.DB, now: () => NOW });
    const issued = await kernel.issueGrant({
      actor: ACTOR,
      shipletId: "shiplet_capability_a",
      revisionId: "revision_capability_a1",
      action: "review.feedback.create",
      resource: "feedback:thread_a",
      effect: "mutation",
      approval: "trusted-human",
      expiresAt: NOW + 60_000,
    });
    const grant = (await kernel.resolveOpaqueHandle(
      issued.opaqueHandle,
    )) as CapabilityGrant;
    const binding = approvalBinding(grant);
    const approval = await kernel.issueTrustedApproval({
      binding,
      expiresAt: NOW + 30_000,
    });
    const use = atomicUse(grant, issued.opaqueHandle, {
      approvalId: approval.approvalId,
    });

    expect(
      await kernel.verifyTrustedApproval(approval.approvalId, binding),
    ).toBe(true);
    const results = await Promise.all([
      kernel.revalidateAndClaim(use),
      kernel.revalidateAndClaim(use),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "replayed" },
    ]);
  });

  it("binds trusted approval to every actor, scope, generation, request, and input field", async () => {
    const kernel = createD1CapabilityKernel({ db: testEnv.DB, now: () => NOW });
    const issued = await kernel.issueGrant({
      actor: ACTOR,
      shipletId: "shiplet_capability_a",
      revisionId: "revision_capability_a1",
      action: "review.feedback.create",
      resource: "feedback:thread_a",
      effect: "mutation",
      approval: "trusted-human",
      expiresAt: NOW + 60_000,
    });
    const grant = (await kernel.resolveOpaqueHandle(
      issued.opaqueHandle,
    )) as CapabilityGrant;
    const binding = approvalBinding(grant);
    const approval = await kernel.issueTrustedApproval({
      binding,
      expiresAt: NOW + 30_000,
    });

    for (const mismatch of [
      { requestId: "request_other" },
      { actor: { kind: "human" as const, id: "user_other" } },
      { grantGeneration: 2 },
      { shipletId: "shiplet_capability_b" },
      { revisionId: "revision_capability_b1" },
      { action: "review.feedback.delete" },
      { resource: "feedback:thread_b" },
      { inputDigest: `sha256:${"2".repeat(64)}` },
    ]) {
      expect(
        await kernel.verifyTrustedApproval(approval.approvalId, {
          ...binding,
          ...mismatch,
        }),
      ).toBe(false);
    }
    expect(
      await kernel.verifyTrustedApproval(approval.approvalId, binding),
    ).toBe(true);
  });

  it("fails closed after revocation, generation mismatch, expiry, or malformed time", async () => {
    let now = NOW;
    const kernel = createD1CapabilityKernel({ db: testEnv.DB, now: () => now });
    const issued = await kernel.issueGrant({
      actor: ACTOR,
      shipletId: "shiplet_capability_a",
      revisionId: "revision_capability_a1",
      action: "state.read",
      resource: "state:shiplet_capability_a",
      effect: "read",
      approval: "none",
      expiresAt: NOW + 1_000,
    });
    const grant = (await kernel.resolveOpaqueHandle(
      issued.opaqueHandle,
    )) as CapabilityGrant;

    expect(
      await kernel.revalidateAndClaim(
        atomicUse(grant, issued.opaqueHandle, { grantGeneration: 2 }),
      ),
    ).toEqual({ ok: false, reason: "scope_mismatch" });
    now = NOW + 1_000;
    expect(
      await kernel.revalidateAndClaim(atomicUse(grant, issued.opaqueHandle)),
    ).toEqual({ ok: false, reason: "expired" });
    now = Number.NaN;
    expect(
      await kernel.revalidateAndClaim(atomicUse(grant, issued.opaqueHandle)),
    ).toEqual({ ok: false, reason: "expired" });
    now = NOW;
    expect(
      await kernel.revokeGrant({
        shipletId: grant.shipletId,
        grantId: grant.id,
        expectedGeneration: grant.generation,
      }),
    ).toBe(true);
    expect(
      await kernel.revalidateAndClaim(
        atomicUse(grant, issued.opaqueHandle, {
          requestId: "request_after_revoke",
        }),
      ),
    ).toEqual({ ok: false, reason: "revoked" });
  });

  it("persists immutable, bounded audit evidence without opaque approvals or handles", async () => {
    const kernel = createD1CapabilityKernel({ db: testEnv.DB, now: () => NOW });
    const event: CapabilityAuditEvent = {
      outcome: "allowed",
      phase: "intent",
      correlationId: "capability:grant_a:request_a",
      grantId: "grant_a",
      grantGeneration: 1,
      effect: "mutation",
      inputDigest: `sha256:${"1".repeat(64)}`,
      approvalPolicy: "trusted-human",
      approvalId: "opaque_approval_must_not_persist",
      requestId: "request_a",
      actor: ACTOR,
      shipletId: "shiplet_capability_a",
      revisionId: "revision_capability_a1",
      action: "review.feedback.create",
      resource: "feedback:thread_a",
    };

    await kernel.audit(event);
    const row = await testEnv.DB.prepare(
      `SELECT id, payload_json FROM shiplet_audit_events
			 WHERE project_id = ? AND event_kind = 'capability.intent'`,
    )
      .bind(event.shipletId)
      .first<{ id: string; payload_json: string }>();
    expect(row).not.toBeNull();
    expect(row?.payload_json).not.toContain(event.approvalId as string);
    await expect(
      testEnv.DB.prepare(
        "UPDATE shiplet_audit_events SET summary = 'tampered' WHERE id = ?",
      )
        .bind(row?.id)
        .run(),
    ).rejects.toThrow();
  });

  it("makes capability scope, approval binding, and claimed-use evidence database-immutable", async () => {
    const kernel = createD1CapabilityKernel({ db: testEnv.DB, now: () => NOW });
    const issued = await kernel.issueGrant({
      actor: ACTOR,
      shipletId: "shiplet_capability_a",
      revisionId: "revision_capability_a1",
      action: "review.feedback.create",
      resource: "feedback:thread_a",
      effect: "mutation",
      approval: "trusted-human",
      expiresAt: NOW + 60_000,
    });
    const grant = (await kernel.resolveOpaqueHandle(
      issued.opaqueHandle,
    )) as CapabilityGrant;
    const binding = approvalBinding(grant);
    const approval = await kernel.issueTrustedApproval({
      binding,
      expiresAt: NOW + 30_000,
    });

    await expect(
      testEnv.DB.prepare(
        "UPDATE shiplet_broker_grants SET project_id = ? WHERE id = ?",
      )
        .bind("shiplet_capability_b", grant.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      testEnv.DB.prepare("DELETE FROM shiplet_broker_grants WHERE id = ?")
        .bind(grant.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      testEnv.DB.prepare(
        "UPDATE shiplet_broker_approvals SET binding_digest = ? WHERE grant_id = ?",
      )
        .bind("0".repeat(64), grant.id)
        .run(),
    ).rejects.toThrow();

    expect(
      await kernel.revalidateAndClaim(
        atomicUse(grant, issued.opaqueHandle, {
          approvalId: approval.approvalId,
        }),
      ),
    ).toEqual({ ok: true });
    await expect(
      testEnv.DB.prepare(
        "UPDATE shiplet_broker_uses SET input_digest = ? WHERE grant_id = ?",
      )
        .bind(`sha256:${"2".repeat(64)}`, grant.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      testEnv.DB.prepare("DELETE FROM shiplet_broker_uses WHERE grant_id = ?")
        .bind(grant.id)
        .run(),
    ).rejects.toThrow();
  });
});
