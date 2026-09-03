import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CapabilityGrant,
  TrustedApprovalBinding,
} from "../src/capability-broker";
import {
  bindCustomMcpMutationApprovalRequest,
  createCustomMcpApprovedMutationDispatcher,
  createCustomMcpApprovalConfirmationRoute,
  createD1CustomMcpApprovalService,
  createCustomMcpTrustedChildApprovalDelegate,
  digestCustomMcpApprovalInput,
  ensureCustomMcpApprovalSchema,
  type CustomMcpMutationApprovalRequest,
} from "../src/custom-mcp-approval";
import {
  createD1CapabilityKernel,
  ensureCapabilityKernelSchema,
} from "../src/d1-capability-kernel";
import { ensureCanonicalEventSchema } from "../src/canonical-review-events";
import {
  createD1CustomMcpCapabilityDispatcher,
  ensureD1CustomMcpDispatcherSchema,
} from "../src/d1-custom-mcp-dispatcher";
import { ensureSchema } from "../src/schema";
import { ensureRevisionSchema } from "../src/self-owned/revisions";

type TestEnv = { DB: D1Database };

const testEnv = env as TestEnv;
const BASE_TIME = Date.parse("2026-08-05T16:00:00.000Z");
const HUMAN = { kind: "human" as const, id: "user_approval_a" };

type Fixture = {
  shipletId: string;
  revisionId: string;
  siblingShipletId: string;
  siblingRevisionId: string;
};

async function seedFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const shipletId = `shiplet_approval_a_${suffix}`;
  const revisionId = `revision_approval_a_${suffix}`;
  const siblingShipletId = `shiplet_approval_b_${suffix}`;
  const siblingRevisionId = `revision_approval_b_${suffix}`;
  const timestamp = new Date(BASE_TIME).toISOString();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO projects (
				id, name, subdomain, script_content, visibility, created_on, modified_on,
				active_revision_id, active_revision_generation
			) VALUES (?, ?, ?, '', 'private', ?, ?, NULL, 0)`,
    ).bind(shipletId, shipletId, `${shipletId}-host`, timestamp, timestamp),
    testEnv.DB.prepare(
      `INSERT INTO projects (
				id, name, subdomain, script_content, visibility, created_on, modified_on,
				active_revision_id, active_revision_generation
			) VALUES (?, ?, ?, '', 'private', ?, ?, NULL, 0)`,
    ).bind(
      siblingShipletId,
      siblingShipletId,
      `${siblingShipletId}-host`,
      timestamp,
      timestamp,
    ),
    testEnv.DB.prepare(
      `INSERT INTO shiplet_revisions (
				id, project_id, parent_revision_id, package_json, package_digest,
				runtime_compatibility, validation_report_json,
				created_by_actor_kind, created_by_actor_id, created_on
			) VALUES (?, ?, NULL, '{}', ?, 'shiplet-runtime/v1', '{}', 'human', ?, ?)`,
    ).bind(
      revisionId,
      shipletId,
      `sha256:${"a".repeat(64)}`,
      HUMAN.id,
      timestamp,
    ),
    testEnv.DB.prepare(
      `INSERT INTO shiplet_revisions (
				id, project_id, parent_revision_id, package_json, package_digest,
				runtime_compatibility, validation_report_json,
				created_by_actor_kind, created_by_actor_id, created_on
			) VALUES (?, ?, NULL, '{}', ?, 'shiplet-runtime/v1', '{}', 'human', ?, ?)`,
    ).bind(
      siblingRevisionId,
      siblingShipletId,
      `sha256:${"b".repeat(64)}`,
      HUMAN.id,
      timestamp,
    ),
  ]);
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `UPDATE projects SET active_revision_id = ?, active_revision_generation = 7
			 WHERE id = ?`,
    ).bind(revisionId, shipletId),
    testEnv.DB.prepare(
      `UPDATE projects SET active_revision_id = ?, active_revision_generation = 4
			 WHERE id = ?`,
    ).bind(siblingRevisionId, siblingShipletId),
  ]);
  return { shipletId, revisionId, siblingShipletId, siblingRevisionId };
}

function approvalRequest(
  fixture: Fixture,
  overrides: Partial<CustomMcpMutationApprovalRequest> = {},
): CustomMcpMutationApprovalRequest {
  return {
    trustedActor: HUMAN,
    shipletId: fixture.shipletId,
    revisionId: fixture.revisionId,
    activationGeneration: 7,
    toolName: `shiplet.${fixture.shipletId}.${fixture.revisionId}.create-comment`,
    parentRequestId: "request_parent_1",
    childRequestId: "request_parent_1:capability:1",
    toolInput: { body: "Ship the safer approval boundary" },
    declaredCapabilities: ["review.feedback.write"],
    capability: "review.feedback.write",
    resource: "feedback:thread_a",
    effect: "mutation",
    capabilityInput: { body: "Approved child effect" },
    ttlMs: 30_000,
    ...overrides,
  };
}

function matchingGrant(
  request: CustomMcpMutationApprovalRequest,
): CapabilityGrant {
  return {
    id: "grant_nested_approval_a",
    generation: 3,
    actor: request.invokerActor ?? request.trustedActor!,
    shipletId: request.shipletId,
    revisionId: request.revisionId,
    action: request.capability,
    resource: request.resource,
    effect: "mutation",
    approval: "trusted-human",
    expiresAt: BASE_TIME + 60_000,
    revokedAt: null,
  };
}

type TestAuthorityState = {
  revokedGrantIds: Set<string>;
  rejectedGrantIds: Set<string>;
  activeApprovalDigests: Set<string>;
  revokedApprovalDigests: Set<string>;
  approvalIdToDigest: Map<string, string>;
  compensationCalls: string[];
  authorityRevocationCalls: string[];
  atomicDispatchChecks: number;
  resolveActiveRevisionCalls: number;
  resolveCapabilityGrantCalls: number;
  denyAtomicDispatch: boolean;
  fabricateAtomicDispatchResolution: boolean;
  failCompensation: boolean;
};

function createAuthorityState(): TestAuthorityState {
  return {
    revokedGrantIds: new Set(),
    rejectedGrantIds: new Set(),
    activeApprovalDigests: new Set(),
    revokedApprovalDigests: new Set(),
    approvalIdToDigest: new Map(),
    compensationCalls: [],
    authorityRevocationCalls: [],
    atomicDispatchChecks: 0,
    resolveActiveRevisionCalls: 0,
    resolveCapabilityGrantCalls: 0,
    denyAtomicDispatch: false,
    fabricateAtomicDispatchResolution: false,
    failCompensation: false,
  };
}

async function testDigest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `sha256:${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function createService(options: {
  fixture: Fixture;
  now?: () => number;
  issuedBindings?: TrustedApprovalBinding[];
  authority?: TestAuthorityState;
  failApprovalDigest?: boolean;
  failIssuanceAfterAuthority?: boolean;
  afterAtomicDispatchAuthorityResolved?: () => Promise<void>;
}) {
  const authority = options.authority ?? createAuthorityState();
  return createD1CustomMcpApprovalService({
    db: testEnv.DB,
    now: options.now ?? (() => BASE_TIME),
    limits: {
      maxApprovalTtlMs: 60_000,
      maxInputBytes: 16_384,
      maxResultBytes: 16_384,
      maxMetadataBytes: 1_024,
      claimLeaseMs: 5_000,
      dispatchLeaseMs: 5_000,
    },
    async resolveActiveRevision(shipletId) {
      authority.resolveActiveRevisionCalls += 1;
      return testEnv.DB.prepare(
        `SELECT active_revision_id AS revisionId,
				        active_revision_generation AS activationGeneration
				 FROM projects WHERE id = ?`,
      )
        .bind(shipletId)
        .first<{ revisionId: string | null; activationGeneration: number }>();
    },
    async issueTrustedApproval(input) {
      options.issuedBindings?.push(input.binding);
      const approvalId = `trusted_approval_${crypto.randomUUID()}`;
      const approvalDigest = await testDigest(approvalId);
      authority.approvalIdToDigest.set(approvalId, approvalDigest);
      authority.activeApprovalDigests.add(approvalDigest);
      if (options.failIssuanceAfterAuthority) {
        throw new Error("injected_uncertain_issuance");
      }
      return { approvalId };
    },
    async resolveCapabilityGrant(input) {
      authority.resolveCapabilityGrantCalls += 1;
      if (
        authority.rejectedGrantIds.has(input.grantId) ||
        authority.revokedGrantIds.has(input.grantId) ||
        input.grantGeneration !== 3
      ) {
        return null;
      }
      return {
        grant: {
          id: input.grantId,
          generation: input.grantGeneration,
          actor: input.expected.actor,
          shipletId: input.expected.shipletId,
          revisionId: input.expected.revisionId,
          action: input.expected.action,
          resource: input.expected.resource,
          effect: "mutation" as const,
          approval: "trusted-human" as const,
          expiresAt: BASE_TIME + 60_000,
          revokedAt: null,
        },
        activationFence: {
          revisionId: input.expected.revisionId,
          generation: input.expected.activationGeneration,
        },
      };
    },
    async resolveDispatchAuthorityAtomically(input: {
      now: number;
      revisionId: string;
      activationGeneration: number;
      grantId: string;
      grantGeneration: number;
      approvalDigest: string;
    }) {
      authority.atomicDispatchChecks += 1;
      if (authority.denyAtomicDispatch) return null;
      if (authority.fabricateAtomicDispatchResolution) {
        return { authorized: true as const } as never;
      }
      if (
        authority.revokedGrantIds.has(input.grantId) ||
        authority.revokedApprovalDigests.has(input.approvalDigest) ||
        !authority.activeApprovalDigests.has(input.approvalDigest)
      ) {
        return null;
      }
      await options.afterAtomicDispatchAuthorityResolved?.();
      return {
        authorized: true as const,
        activationFence: {
          revisionId: input.revisionId,
          generation: input.activationGeneration,
        },
        grant: {
          id: input.grantId,
          generation: input.grantGeneration,
          expiresAt: BASE_TIME + 60_000,
          revokedAt: null,
        },
        approval: {
          digest: input.approvalDigest,
          expiresAt: BASE_TIME + 60_000,
          revokedAt: null,
        },
      };
    },
    async revokeTrustedApproval(input: {
      approvalDigest: string;
      idempotencyKey: string;
    }) {
      authority.authorityRevocationCalls.push(input.idempotencyKey);
      authority.activeApprovalDigests.delete(input.approvalDigest);
      authority.revokedApprovalDigests.add(input.approvalDigest);
      return { ok: true as const };
    },
    async digestTrustedApprovalId(approvalId: string) {
      if (options.failApprovalDigest) {
        throw new Error("injected_approval_digest_failure");
      }
      return testDigest(approvalId);
    },
    async compensateTrustedApproval(input: {
      approvalId: string;
      idempotencyKey: string;
    }) {
      authority.compensationCalls.push(input.idempotencyKey);
      if (authority.failCompensation) return { ok: false as const };
      const digest = authority.approvalIdToDigest.get(input.approvalId);
      if (digest) authority.activeApprovalDigests.delete(digest);
      return { ok: true as const };
    },
    async reconcileTrustedApprovalIssuance(input: { idempotencyKey: string }) {
      authority.compensationCalls.push(`reconcile:${input.idempotencyKey}`);
      authority.activeApprovalDigests.clear();
      return { status: "compensated" as const };
    },
  });
}

beforeEach(async () => {
  await ensureSchema(testEnv.DB);
  await ensureRevisionSchema(testEnv.DB);
  await ensureCapabilityKernelSchema(testEnv.DB);
  await ensureCanonicalEventSchema(testEnv.DB);
  await ensureD1CustomMcpDispatcherSchema(testEnv.DB);
  await ensureCustomMcpApprovalSchema(testEnv.DB);
});

describe("trusted custom MCP human approval ceremony", () => {
  it("Given an exact nested mutation, When MCP retries after trusted same-origin confirmation, Then the pending intent binds atomically to the new exact grant without storing a bearer", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_resumable",
      childRequestId: "request_resumable:capability:1",
    });

    const [first, concurrentRetry] = await Promise.all([
      service.getOrBeginResumable(request),
      service.getOrBeginResumable({
        ...request,
        toolInput: { body: "Ship the safer approval boundary" },
        capabilityInput: { body: "Approved child effect" },
      }),
    ]);
    expect(concurrentRetry).toEqual(first);
    expect(first).toEqual({
      approvalRequestId: expect.stringMatching(/^mcp_approval_/),
      expiresAt: BASE_TIME + 30_000,
      confirmationPath: expect.stringMatching(
        /^\/api\/mcp\/approvals\/mcp_approval_[A-Za-z0-9-]+\/confirm$/,
      ),
    });
    expect(Object.keys(first).sort()).toEqual([
      "approvalRequestId",
      "confirmationPath",
      "expiresAt",
    ]);

    const pending = await testEnv.DB.prepare(
      "SELECT * FROM shiplet_custom_mcp_approvals WHERE id = ?",
    )
      .bind(first.approvalRequestId)
      .first<Record<string, unknown>>();
    expect(pending).toMatchObject({
      status: "pending",
      grant_id: null,
      grant_generation: null,
      confirmation_nonce_digest: null,
    });
    const {
      review_target_json: pendingReviewTarget,
      review_input_json: pendingReviewInput,
      ...pendingOpaque
    } = pending ?? {};
    expect(JSON.parse(String(pendingReviewTarget))).toEqual({
      capability: request.capability,
      resource: request.resource,
    });
    expect(JSON.parse(String(pendingReviewInput))).toEqual(
      request.capabilityInput,
    );
    expect(JSON.stringify(pendingOpaque)).not.toContain(
      "Approved child effect",
    );

    const authenticateHuman = vi.fn(async () => HUMAN);
    const verifySameOriginCsrf = vi.fn(async () => true);
    const route = createCustomMcpApprovalConfirmationRoute({
      service,
      authenticateHuman,
      authorizeApprover: async () => true,
      verifySameOriginCsrf,
    });
    expect(
      await route.confirm({
        approvalRequestId: first.approvalRequestId,
        request: new Request("https://shiplet.test" + first.confirmationPath, {
          method: "POST",
        }),
      }),
    ).toEqual({ ok: true });
    expect(authenticateHuman).toHaveBeenCalledOnce();
    expect(verifySameOriginCsrf).toHaveBeenCalledWith(
      expect.any(Request),
      HUMAN,
    );

    const retryGrant = matchingGrant(request);
    const claimed = await service.claim({ request, grant: retryGrant });
    expect(claimed).toEqual({ ok: true });
    const claimedRow = await testEnv.DB.prepare(
      "SELECT * FROM shiplet_custom_mcp_approvals WHERE id = ?",
    )
      .bind(first.approvalRequestId)
      .first<Record<string, unknown>>();
    expect(claimedRow).toMatchObject({
      status: "claimed",
      grant_id: retryGrant.id,
      grant_generation: retryGrant.generation,
    });
    expect(JSON.stringify(claimed)).not.toMatch(
      /approvalId|authority|bearer|token/i,
    );
    expect(await service.claim({ request, grant: retryGrant })).toEqual({
      ok: false,
      code: "approval_denied",
    });
  });

  it("Given a resumable intent, When confirmation is not an authenticated CSRF-verified POST, Then the route cannot mint trusted approval", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_route_boundary",
      childRequestId: "request_route_boundary:capability:1",
    });
    const pending = await service.getOrBeginResumable(request);

    expect(
      await service.confirmResumableFromTrustedRoute({
        approvalRequestId: pending.approvalRequestId,
        proof: {
          approvalRequestId: pending.approvalRequestId,
          actor: HUMAN,
          csrfVerified: true,
        },
      }),
    ).toEqual({ ok: false, code: "approval_denied" });

    for (const scenario of [
      { method: "GET", actor: HUMAN, csrf: true },
      { method: "POST", actor: null, csrf: true },
      {
        method: "POST",
        actor: { kind: "agent" as const, id: "agent_untrusted" },
        csrf: true,
      },
      { method: "POST", actor: HUMAN, csrf: false },
      {
        method: "POST",
        actor: { kind: "human" as const, id: "user_other" },
        csrf: true,
      },
    ]) {
      const route = createCustomMcpApprovalConfirmationRoute({
        service,
        authenticateHuman: async () => scenario.actor,
        authorizeApprover: async () => true,
        verifySameOriginCsrf: async () => scenario.csrf,
      });
      expect(
        await route.confirm({
          approvalRequestId: pending.approvalRequestId,
          request: new Request(
            "https://shiplet.test" + pending.confirmationPath,
            { method: scenario.method },
          ),
        }),
      ).toEqual({ ok: false, code: "approval_denied" });
    }
    const wrongPathRoute = createCustomMcpApprovalConfirmationRoute({
      service,
      authenticateHuman: async () => HUMAN,
      authorizeApprover: async () => true,
      verifySameOriginCsrf: async () => true,
    });
    expect(
      await wrongPathRoute.confirm({
        approvalRequestId: pending.approvalRequestId,
        request: new Request("https://shiplet.test/api/mcp/approvals/wrong", {
          method: "POST",
        }),
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    expect(
      await service.claim({ request, grant: matchingGrant(request) }),
    ).toEqual({ ok: false, code: "approval_denied" });
  });

  it("revokes pending mutation approvals when their Shiplet is archived before confirmation", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_archived_before_confirmation",
      childRequestId: "request_archived_before_confirmation:capability:1",
    });
    const pending = await service.getOrBeginResumable(request);
    const route = createCustomMcpApprovalConfirmationRoute({
      service,
      authenticateHuman: async () => HUMAN,
      authorizeApprover: async () => true,
      verifySameOriginCsrf: async () => true,
    });
    const confirmationRequest = () =>
      new Request("https://shiplet.test" + pending.confirmationPath, {
        method: "POST",
      });

    await testEnv.DB.prepare(`UPDATE projects SET archived_on = ? WHERE id = ?`)
      .bind(new Date(BASE_TIME).toISOString(), fixture.shipletId)
      .run();
    expect(
      await route.confirm({
        approvalRequestId: pending.approvalRequestId,
        request: confirmationRequest(),
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    await expect(
      testEnv.DB.prepare(
        `SELECT status FROM shiplet_custom_mcp_approvals WHERE id = ?`,
      )
        .bind(pending.approvalRequestId)
        .first<{ status: string }>(),
    ).resolves.toEqual({ status: "revoked" });

    await testEnv.DB.prepare(
      `UPDATE projects SET archived_on = NULL WHERE id = ?`,
    )
      .bind(fixture.shipletId)
      .run();
    expect(
      await route.confirm({
        approvalRequestId: pending.approvalRequestId,
        request: confirmationRequest(),
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    expect(
      await service.claim({ request, grant: matchingGrant(request) }),
    ).toEqual({ ok: false, code: "approval_denied" });

    const legacyRequest = approvalRequest(fixture, {
      parentRequestId: "request_archived_legacy_confirmation",
      childRequestId: "request_archived_legacy_confirmation:capability:1",
    });
    const challenge = await service.legacyNonceCeremony.begin({
      request: legacyRequest,
      grant: matchingGrant(legacyRequest),
    });
    await testEnv.DB.prepare(`UPDATE projects SET archived_on = ? WHERE id = ?`)
      .bind(new Date(BASE_TIME).toISOString(), fixture.shipletId)
      .run();
    expect(
      await service.legacyNonceCeremony.confirm({
        approvalRequestId: challenge.approvalRequestId,
        confirmationNonce: challenge.confirmationNonce,
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    await testEnv.DB.prepare(
      `UPDATE projects SET archived_on = NULL WHERE id = ?`,
    )
      .bind(fixture.shipletId)
      .run();
    expect(
      await service.legacyNonceCeremony.confirm({
        approvalRequestId: challenge.approvalRequestId,
        confirmationNonce: challenge.confirmationNonce,
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
  });

  it("Given a safe pending intent, When its authenticated confirmation page loads, Then exact quoted review data is isolated from the resumable MCP response", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_safe_read_model",
      childRequestId: "request_safe_read_model:capability:1",
      capabilityInput: { body: "never persist this private body" },
      resource: "feedback:private-thread-8675309",
    });
    const pending = await service.getOrBeginResumable(request);
    const route = createCustomMcpApprovalConfirmationRoute({
      service,
      authenticateHuman: async () => HUMAN,
      authorizeApprover: async () => true,
      verifySameOriginCsrf: async () => true,
    });
    const model = await route.read({
      approvalRequestId: pending.approvalRequestId,
      request: new Request("https://shiplet.test" + pending.confirmationPath),
    });
    expect(model).toEqual({
      ok: true,
      approval: {
        approvalRequestId: pending.approvalRequestId,
        actionSummary: "Post or update review feedback",
        changeSummary: "Post or update review feedback",
        resourceSummary: "Review feedback thread (identifier hidden)",
        tool: {
          name: request.toolName,
          trust: "untrusted_package_content",
        },
        invoker: {
          kind: "human",
          label: "Signed-in human requested this change",
        },
        scope: {
          shipletId: fixture.shipletId,
          revisionId: fixture.revisionId,
          activationGeneration: 7,
        },
        review: {
          trust: "untrusted_quoted_data",
          target: {
            capability: request.capability,
            resource: request.resource,
          },
          input: request.capabilityInput,
        },
        expiresAt: pending.expiresAt,
        trust: "trusted_kernel",
      },
    });
    const stored = await testEnv.DB.prepare(
      "SELECT * FROM shiplet_custom_mcp_approvals WHERE id = ?",
    )
      .bind(pending.approvalRequestId)
      .first<Record<string, unknown>>();
    expect(JSON.parse(String(stored?.review_target_json))).toEqual({
      capability: request.capability,
      resource: request.resource,
    });
    expect(JSON.parse(String(stored?.review_input_json))).toEqual(
      request.capabilityInput,
    );
    const {
      review_target_json: _reviewTarget,
      review_input_json: _reviewInput,
      ...opaqueStored
    } = stored ?? {};
    expect(JSON.stringify(opaqueStored)).not.toContain(
      "never persist this private body",
    );
    expect(JSON.stringify(opaqueStored)).not.toContain(
      "private-thread-8675309",
    );
    expect(JSON.stringify(opaqueStored)).not.toContain(request.capability);
    expect(JSON.stringify(pending)).not.toContain(
      "never persist this private body",
    );
    expect(JSON.stringify(pending)).not.toContain("private-thread-8675309");
  });

  it("Given ambiguous secret-bearing keys, claim-like targets, or oversized quoted data, When approval review data is prepared, Then creation is rejected without persistence", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const parentPrefix = `request_unsafe_review_${crypto.randomUUID()}`;
    const before = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM shiplet_custom_mcp_approvals
		 WHERE project_id = ?`,
    )
      .bind(fixture.shipletId)
      .first<{ count: number }>();
    const unsafeInputs = [
      { metadata: { authorization: true } },
      { metadata: { clientSecret: true } },
      { metadata: { claimUrl: true } },
      { metadata: { oauthToken: true } },
      { metadata: { sessionCookie: true } },
    ];
    for (const [index, capabilityInput] of unsafeInputs.entries()) {
      await expect(
        service.getOrBeginResumable(
          approvalRequest(fixture, {
            parentRequestId: `${parentPrefix}_${index}`,
            childRequestId: `${parentPrefix}_${index}:capability:1`,
            capabilityInput,
          }),
        ),
      ).rejects.toThrow();
    }
    await expect(
      service.getOrBeginResumable(
        approvalRequest(fixture, {
          parentRequestId: `${parentPrefix}_claim_target`,
          childRequestId: `${parentPrefix}_claim_target:capability:1`,
          resource: "https://example.invalid/claim/temporary",
        }),
      ),
    ).rejects.toThrow();
    await expect(
      service.getOrBeginResumable(
        approvalRequest(fixture, {
          parentRequestId: `${parentPrefix}_oversized`,
          childRequestId: `${parentPrefix}_oversized:capability:1`,
          capabilityInput: { body: "x".repeat(5_000) },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM shiplet_custom_mcp_approvals
		 WHERE project_id = ?`,
      )
        .bind(fixture.shipletId)
        .first<{ count: number }>(),
    ).resolves.toEqual(before);
  });

  it("Given one confirmed resumable intent, When a retry changes request identity, input, capability, revision, or actor, Then the confirmed authority cannot be claimed", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const original = approvalRequest(fixture, {
      parentRequestId: "request_exact_retry",
      childRequestId: "request_exact_retry:capability:1",
    });
    const pending = await service.getOrBeginResumable(original);
    const route = createCustomMcpApprovalConfirmationRoute({
      service,
      authenticateHuman: async () => HUMAN,
      authorizeApprover: async () => true,
      verifySameOriginCsrf: async () => true,
    });
    await route.confirm({
      approvalRequestId: pending.approvalRequestId,
      request: new Request("https://shiplet.test" + pending.confirmationPath, {
        method: "POST",
      }),
    });

    await expect(
      service.getOrBeginResumable({
        ...original,
        capabilityInput: { body: "changed under reused request IDs" },
      }),
    ).rejects.toThrow();
    const intentCount = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM shiplet_custom_mcp_approvals
       WHERE project_id = ? AND parent_request_id = ? AND child_request_id = ?`,
    )
      .bind(
        fixture.shipletId,
        original.parentRequestId,
        original.childRequestId,
      )
      .first<{ count: number }>();
    expect(intentCount?.count).toBe(1);

    for (const changed of [
      {
        ...original,
        parentRequestId: "request_new",
        childRequestId: "request_new:capability:1",
      },
      { ...original, toolInput: { body: "changed" } },
      { ...original, capabilityInput: { body: "changed" } },
      {
        ...original,
        capability: "review.feedback.delete",
        declaredCapabilities: ["review.feedback.delete"],
      },
      { ...original, revisionId: fixture.siblingRevisionId },
      {
        ...original,
        trustedActor: { kind: "human" as const, id: "user_other" },
      },
    ]) {
      expect(
        await service.claim({
          request: changed,
          grant: matchingGrant(changed),
        }),
      ).toEqual({ ok: false, code: "approval_denied" });
    }
    expect(
      await service.claim({
        request: original,
        grant: matchingGrant(original),
      }),
    ).toEqual(expect.objectContaining({ ok: true }));
  });

  it("Given an exact active mutation request, When the trusted browser confirms it, Then digests and isolated quoted review data persist and the approval can be claimed once", async () => {
    const fixture = await seedFixture();
    const issuedBindings: TrustedApprovalBinding[] = [];
    const service = createService({ fixture, issuedBindings });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_wrong_confirmation",
      childRequestId: "request_wrong_confirmation:capability:1",
    });
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant: matchingGrant(request),
    });

    const persistedBefore = await testEnv.DB.prepare(
      "SELECT * FROM shiplet_custom_mcp_approvals WHERE id = ?",
    )
      .bind(challenge.approvalRequestId)
      .first<Record<string, unknown>>();
    expect(persistedBefore).toMatchObject({
      status: "pending",
      project_id: fixture.shipletId,
      revision_id: fixture.revisionId,
      activation_generation: 7,
      capability: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      effect: "mutation",
    });
    expect(JSON.stringify(persistedBefore)).not.toContain(
      challenge.confirmationNonce,
    );
    const {
      review_target_json: persistedReviewTarget,
      review_input_json: persistedReviewInput,
      ...persistedOpaque
    } = persistedBefore ?? {};
    expect(JSON.parse(String(persistedReviewTarget))).toEqual({
      capability: request.capability,
      resource: request.resource,
    });
    expect(JSON.parse(String(persistedReviewInput))).toEqual(
      request.capabilityInput,
    );
    expect(JSON.stringify(persistedOpaque)).not.toContain(
      "Approved child effect",
    );
    expect(JSON.stringify(persistedOpaque)).not.toContain(
      "review.feedback.write",
    );
    await expect(
      testEnv.DB.prepare(
        `UPDATE shiplet_custom_mcp_approvals SET capability = ? WHERE id = ?`,
      )
        .bind("review.feedback.delete", challenge.approvalRequestId)
        .run(),
    ).rejects.toThrow();
    for (const column of ["review_target_json", "review_input_json"]) {
      await expect(
        testEnv.DB.prepare(
          `UPDATE shiplet_custom_mcp_approvals SET ${column} = '{}' WHERE id = ?`,
        )
          .bind(challenge.approvalRequestId)
          .run(),
        column,
      ).rejects.toThrow();
    }
    await expect(
      testEnv.DB.prepare(
        `UPDATE shiplet_custom_mcp_approvals SET status = 'dispatched'
         WHERE id = ?`,
      )
        .bind(challenge.approvalRequestId)
        .run(),
    ).rejects.toThrow();

    expect(
      await service.legacyNonceCeremony.confirm({
        approvalRequestId: challenge.approvalRequestId,
        confirmationNonce: challenge.confirmationNonce,
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: true });
    const grant = matchingGrant(request);
    const claimed = await service.claim({ request, grant });
    expect(claimed).toEqual({ ok: true });
    if (claimed.ok) {
      const persistedAfter = await testEnv.DB.prepare(
        "SELECT * FROM shiplet_custom_mcp_approvals WHERE id = ?",
      )
        .bind(challenge.approvalRequestId)
        .first<Record<string, unknown>>();
      expect(JSON.stringify(persistedAfter)).not.toMatch(
        /trusted_approval_|authority|bearer/i,
      );
    }
    expect(await service.claim({ request, grant })).toEqual({
      ok: false,
      code: "approval_denied",
    });
    expect(issuedBindings).toEqual([
      expect.objectContaining({
        requestId: request.childRequestId,
        actor: HUMAN,
        grantId: grant.id,
        grantGeneration: grant.generation,
        shipletId: request.shipletId,
        revisionId: request.revisionId,
        action: request.capability,
        resource: request.resource,
        effect: "mutation",
        approvalPolicy: "trusted-human",
        inputDigest: await digestCustomMcpApprovalInput(
          request.capabilityInput,
          16_384,
        ),
      }),
    ]);
  });

  it("Given package arguments or MCP metadata that self-attest approval, When no trusted browser confirms, Then the mutation remains denied", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const request = {
      ...approvalRequest(fixture),
      approved: true,
      trustedApprovalId: "package_supplied_approval",
      _meta: { approval: "granted" },
    } as CustomMcpMutationApprovalRequest;
    await service.legacyNonceCeremony.begin({
      request,
      grant: matchingGrant(request),
    });
    expect(
      await service.claim({ request, grant: matchingGrant(request) }),
    ).toEqual({ ok: false, code: "approval_denied" });
  });

  it("Given the durable capability kernel, When the ceremony claims an approval, Then no authority bearer crosses the service result", async () => {
    const fixture = await seedFixture();
    const request = approvalRequest(fixture, {
      parentRequestId: "request_real_kernel",
      childRequestId: "request_real_kernel:capability:1",
    });
    const kernel = createD1CapabilityKernel({
      db: testEnv.DB,
      now: () => BASE_TIME,
    });
    const issued = await kernel.issueGrant({
      actor: HUMAN,
      shipletId: fixture.shipletId,
      revisionId: fixture.revisionId,
      action: request.capability,
      resource: request.resource,
      effect: "mutation",
      approval: "trusted-human",
      expiresAt: BASE_TIME + 60_000,
      activationFence: {
        revisionId: fixture.revisionId,
        generation: 7,
      },
    });
    const grant = await kernel.resolveOpaqueHandle(issued.opaqueHandle);
    expect(grant).not.toBeNull();
    if (grant === null) return;
    const service = createD1CustomMcpApprovalService({
      db: testEnv.DB,
      now: () => BASE_TIME,
      limits: {
        maxApprovalTtlMs: 60_000,
        maxInputBytes: 16_384,
        maxResultBytes: 16_384,
        maxMetadataBytes: 1_024,
        claimLeaseMs: 5_000,
        dispatchLeaseMs: 5_000,
      },
      async resolveActiveRevision(shipletId) {
        return testEnv.DB.prepare(
          `SELECT active_revision_id AS revisionId,
                  active_revision_generation AS activationGeneration
             FROM projects WHERE id = ?`,
        )
          .bind(shipletId)
          .first<{ revisionId: string | null; activationGeneration: number }>();
      },
      issueTrustedApproval: (input) => kernel.issueTrustedApproval(input),
      async resolveCapabilityGrant(input) {
        return input.grantId === grant.id &&
          input.grantGeneration === grant.generation
          ? {
              grant,
              activationFence: {
                revisionId: fixture.revisionId,
                generation: 7,
              },
            }
          : null;
      },
      async resolveDispatchAuthorityAtomically(input) {
        return {
          authorized: true,
          activationFence: {
            revisionId: input.revisionId,
            generation: input.activationGeneration,
          },
          grant: {
            id: input.grantId,
            generation: input.grantGeneration,
            expiresAt: BASE_TIME + 60_000,
            revokedAt: null,
          },
          approval: {
            digest: input.approvalDigest,
            expiresAt: BASE_TIME + 60_000,
            revokedAt: null,
          },
        };
      },
      async revokeTrustedApproval() {
        return { ok: true };
      },
      async compensateTrustedApproval() {
        return { ok: true };
      },
      async reconcileTrustedApprovalIssuance() {
        return { status: "compensated" };
      },
    });
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant,
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: challenge.approvalRequestId,
      confirmationNonce: challenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    const claimed = await service.claim({ request, grant });
    expect(claimed).toEqual({ ok: true });
    expect(JSON.stringify(claimed)).not.toMatch(
      /approvalId|authority|bearer|token/i,
    );
  });

  it("Given a browser confirmation, When its actor, nonce, expiry, or active generation is wrong, Then confirmation and claim fail closed", async () => {
    const fixture = await seedFixture();
    let now = BASE_TIME;
    const service = createService({ fixture, now: () => now });
    const request = approvalRequest(fixture);
    const wrongActorChallenge = await service.legacyNonceCeremony.begin({
      request,
      grant: matchingGrant(request),
    });
    expect(
      await service.legacyNonceCeremony.confirm({
        approvalRequestId: wrongActorChallenge.approvalRequestId,
        confirmationNonce: wrongActorChallenge.confirmationNonce,
        trustedActor: { kind: "human", id: "user_other" },
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    expect(
      await service.legacyNonceCeremony.confirm({
        approvalRequestId: wrongActorChallenge.approvalRequestId,
        confirmationNonce: "wrong_nonce",
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: false, code: "approval_denied" });

    const staleRequest = approvalRequest(fixture, {
      parentRequestId: "request_stale_generation",
      childRequestId: "request_stale_generation:capability:1",
    });
    const staleChallenge = await service.legacyNonceCeremony.begin({
      request: staleRequest,
      grant: matchingGrant(staleRequest),
    });
    expect(
      await service.legacyNonceCeremony.confirm({
        approvalRequestId: staleChallenge.approvalRequestId,
        confirmationNonce: staleChallenge.confirmationNonce,
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: true });
    await testEnv.DB.prepare(
      `UPDATE projects SET active_revision_generation = 8 WHERE id = ?`,
    )
      .bind(fixture.shipletId)
      .run();
    expect(
      await service.claim({
        request: staleRequest,
        grant: matchingGrant(staleRequest),
      }),
    ).toEqual({ ok: false, code: "approval_denied" });

    await testEnv.DB.prepare(
      `UPDATE projects SET active_revision_generation = 7 WHERE id = ?`,
    )
      .bind(fixture.shipletId)
      .run();
    const expiringRequest = approvalRequest(fixture, {
      parentRequestId: "request_expired",
      childRequestId: "request_expired:capability:1",
      ttlMs: 1,
    });
    const expiredChallenge = await service.legacyNonceCeremony.begin({
      request: expiringRequest,
      grant: matchingGrant(expiringRequest),
    });
    now += 1;
    expect(
      await service.legacyNonceCeremony.confirm({
        approvalRequestId: expiredChallenge.approvalRequestId,
        confirmationNonce: expiredChallenge.confirmationNonce,
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
  });

  it("Given one confirmed request, When any actor, sibling, revision, generation, tool, request, input, resource, effect, grant, or declaration changes, Then it cannot claim authority", async () => {
    const mismatchFactories: Array<
      (
        request: CustomMcpMutationApprovalRequest,
        fixture: Fixture,
      ) => {
        request?: CustomMcpMutationApprovalRequest;
        grant?: CapabilityGrant;
      }
    > = [
      (request) => ({
        request: {
          ...request,
          trustedActor: { kind: "human", id: "user_other" },
        },
      }),
      (request, fixture) => ({
        request: {
          ...request,
          shipletId: fixture.siblingShipletId,
          revisionId: fixture.siblingRevisionId,
          activationGeneration: 4,
        },
      }),
      (request, fixture) => ({
        request: { ...request, revisionId: fixture.siblingRevisionId },
      }),
      (request) => ({
        request: { ...request, activationGeneration: 8 },
      }),
      (request) => ({
        request: { ...request, toolName: `${request.toolName}.x` },
      }),
      (request) => ({
        request: { ...request, parentRequestId: "request_parent_other" },
      }),
      (request) => ({
        request: {
          ...request,
          childRequestId: "request_parent_1:capability:2",
        },
      }),
      (request) => ({
        request: { ...request, toolInput: { body: "different" } },
      }),
      (request) => ({
        request: { ...request, capability: "review.feedback.delete" },
      }),
      (request) => ({
        request: { ...request, declaredCapabilities: [] },
      }),
      (request) => ({ request: { ...request, resource: "feedback:thread_b" } }),
      (request) => ({
        request: { ...request, capabilityInput: { body: "different" } },
      }),
      (request) => ({
        grant: { ...matchingGrant(request), generation: 4 },
      }),
    ];

    for (const makeMismatch of mismatchFactories) {
      const fixture = await seedFixture();
      const service = createService({ fixture });
      const original = approvalRequest(fixture);
      const challenge = await service.legacyNonceCeremony.begin({
        request: original,
        grant: matchingGrant(original),
      });
      expect(
        await service.legacyNonceCeremony.confirm({
          approvalRequestId: challenge.approvalRequestId,
          confirmationNonce: challenge.confirmationNonce,
          trustedActor: HUMAN,
        }),
      ).toEqual({ ok: true });
      const mismatch = makeMismatch(original, fixture);
      const changedRequest = mismatch.request ?? original;
      expect(
        await service.claim({
          request: changedRequest,
          grant: mismatch.grant ?? matchingGrant(changedRequest),
        }),
      ).toEqual({ ok: false, code: "approval_denied" });
    }
  });

  it("Given a confirmed approval, When it is revoked or claimed concurrently, Then revocation closes it and at most one claimant wins", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const revokedRequest = approvalRequest(fixture, {
      parentRequestId: "request_revoke",
      childRequestId: "request_revoke:capability:1",
    });
    const revokedChallenge = await service.legacyNonceCeremony.begin({
      request: revokedRequest,
      grant: matchingGrant(revokedRequest),
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: revokedChallenge.approvalRequestId,
      confirmationNonce: revokedChallenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    expect(
      await service.revoke({
        approvalRequestId: revokedChallenge.approvalRequestId,
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: true });
    expect(
      await service.claim({
        request: revokedRequest,
        grant: matchingGrant(revokedRequest),
      }),
    ).toEqual({ ok: false, code: "approval_denied" });

    const concurrentRequest = approvalRequest(fixture, {
      parentRequestId: "request_concurrent",
      childRequestId: "request_concurrent:capability:1",
    });
    const concurrentChallenge = await service.legacyNonceCeremony.begin({
      request: concurrentRequest,
      grant: matchingGrant(concurrentRequest),
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: concurrentChallenge.approvalRequestId,
      confirmationNonce: concurrentChallenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    const results = await Promise.all([
      service.claim({
        request: concurrentRequest,
        grant: matchingGrant(concurrentRequest),
      }),
      service.claim({
        request: concurrentRequest,
        grant: matchingGrant(concurrentRequest),
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, code: "approval_denied" },
    ]);
  });
});

describe("trusted custom MCP mutation dispatch", () => {
  it("Given trusted invocation context, When the structural delegate and dispatcher integrate with custom MCP, Then untrusted child data cannot widen its capability", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const invocation = {
      trustedActor: HUMAN,
      shipletId: fixture.shipletId,
      revisionId: fixture.revisionId,
      activationGeneration: 7,
      toolName: `shiplet.${fixture.shipletId}.${fixture.revisionId}.create-comment`,
      parentRequestId: "request_adapter",
      toolInput: { body: "Parent tool input" },
      declaredCapabilities: ["review.feedback.write"],
      ttlMs: 30_000,
    };
    const child = {
      actor: HUMAN,
      shipletId: fixture.shipletId,
      revisionId: fixture.revisionId,
      parentRequestId: invocation.parentRequestId,
      childRequestId: `${invocation.parentRequestId}:capability:1`,
      capability: "review.feedback.write",
      resource: "feedback:thread_adapter",
      effect: "mutation" as const,
      input: { body: "Child effect" },
    };
    const request = bindCustomMcpMutationApprovalRequest({
      invocation,
      child,
    });
    const grant = matchingGrant(request);
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant,
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: challenge.approvalRequestId,
      confirmationNonce: challenge.confirmationNonce,
      trustedActor: HUMAN,
    });

    const delegate = createCustomMcpTrustedChildApprovalDelegate({
      service,
      invocation,
      resolveGrant: async () => grant,
    });
    const resolution = await delegate.resolve(child);
    expect(resolution).toEqual({ status: "approved" });
    expect(JSON.stringify(resolution)).not.toMatch(
      /approvalId|authority|bearer|token/i,
    );
    expect(
      await delegate.resolve({
        ...child,
        capability: "review.feedback.delete",
      }),
    ).toEqual({ status: "denied" });

    const effect = vi.fn(async () => ({
      status: "committed" as const,
      journalId: "journal_adapter",
      value: { created: true },
    }));
    const dispatcher = createCustomMcpApprovedMutationDispatcher({
      service,
      invocation,
      effect,
    });
    expect(
      await dispatcher.dispatch({
        authorized: {
          actor: HUMAN,
          shipletId: fixture.shipletId,
          revisionId: fixture.revisionId,
          action: child.capability,
          resource: child.resource,
          requestId: child.childRequestId,
          input: child.input,
        },
      }),
    ).toEqual({
      status: "committed",
      journalId: "journal_adapter",
      value: { created: true },
    });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("Given a claimed exact approval, When the kernel dispatches it, Then the effect gets only a frozen constrained request and immutable intent/completion audits", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const request = approvalRequest(fixture);
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant: matchingGrant(request),
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: challenge.approvalRequestId,
      confirmationNonce: challenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    expect(
      await service.claim({ request, grant: matchingGrant(request) }),
    ).toEqual(expect.objectContaining({ ok: true }));

    const effect = vi.fn(async (constrained) => {
      expect(Object.isFrozen(constrained)).toBe(true);
      expect(constrained).toEqual({
        actor: HUMAN,
        shipletId: fixture.shipletId,
        revisionId: fixture.revisionId,
        activationGeneration: 7,
        toolName: request.toolName,
        parentRequestId: request.parentRequestId,
        requestId: request.childRequestId,
        approval: {
          approvalRequestId: challenge.approvalRequestId,
          activationGeneration: 7,
          expiresAt: BASE_TIME + 30_000,
          dispatchLeaseExpiresAt: BASE_TIME + 5_000,
          state: "dispatching",
        },
        action: request.capability,
        resource: request.resource,
        effect: "mutation",
        input: request.capabilityInput,
      });
      expect(Object.keys(constrained)).not.toContain("trustedApprovalId");
      expect(Object.keys(constrained)).not.toContain("confirmationNonce");
      return {
        status: "committed" as const,
        journalId: "journal_effect_1",
        value: { created: true },
      };
    });
    expect(await service.dispatchApprovedMutation({ request, effect })).toEqual(
      {
        status: "committed",
        journalId: "journal_effect_1",
        value: { created: true },
      },
    );
    expect(effect).toHaveBeenCalledOnce();
    expect(await service.dispatchApprovedMutation({ request, effect })).toEqual(
      {
        status: "aborted",
        journalId: expect.stringMatching(/^approval-denied:/),
      },
    );
    expect(effect).toHaveBeenCalledOnce();

    const audits = await testEnv.DB.prepare(
      `SELECT event_kind, outcome FROM shiplet_custom_mcp_approval_audit
			 WHERE approval_id = ? ORDER BY sequence ASC`,
    )
      .bind(challenge.approvalRequestId)
      .all<{ event_kind: string; outcome: string }>();
    expect(audits.results).toEqual([
      { event_kind: "approval_requested", outcome: "pending" },
      { event_kind: "approval_confirmed", outcome: "allowed" },
      { event_kind: "approval_claimed", outcome: "allowed" },
      { event_kind: "dispatch_intent", outcome: "allowed" },
      { event_kind: "dispatch_completion", outcome: "committed" },
      { event_kind: "dispatch_denied", outcome: "replayed" },
    ]);
    await expect(
      testEnv.DB.prepare(
        `UPDATE shiplet_custom_mcp_approval_audit SET outcome = 'changed'
				 WHERE approval_id = ?`,
      )
        .bind(challenge.approvalRequestId)
        .run(),
    ).rejects.toThrow();
  });

  it("Given atomic authority resolution succeeds, When promotion wins immediately before the concrete D1 mutation, Then no stale-revision event commits", async () => {
    const fixture = await seedFixture();
    const promotedRevisionId = `revision_promoted_${crypto.randomUUID().replaceAll("-", "")}`;
    await testEnv.DB.prepare(
      `INSERT INTO shiplet_revisions (
		id, project_id, parent_revision_id, package_json, package_digest,
		runtime_compatibility, validation_report_json,
		created_by_actor_kind, created_by_actor_id, created_on
	) VALUES (?, ?, ?, '{}', ?, 'shiplet-runtime/v1', '{}', 'human', ?, ?)`,
    )
      .bind(
        promotedRevisionId,
        fixture.shipletId,
        fixture.revisionId,
        `sha256:${"f".repeat(64)}`,
        HUMAN.id,
        new Date(BASE_TIME).toISOString(),
      )
      .run();
    const service = createService({
      fixture,
      async afterAtomicDispatchAuthorityResolved() {
        await testEnv.DB.prepare(
          `UPDATE projects
			 SET active_revision_id = ?, active_revision_generation = 8
			 WHERE id = ? AND active_revision_id = ?
			   AND active_revision_generation = 7`,
        )
          .bind(promotedRevisionId, fixture.shipletId, fixture.revisionId)
          .run();
      },
    });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_activation_race",
      childRequestId: "request_activation_race:capability:1",
      declaredCapabilities: ["workflow.event:create"],
      capability: "workflow.event:create",
      resource: "workflow:events",
      capabilityInput: {
        eventKind: "custom.reviewed",
        summary: "Must not commit after promotion",
        canonicalStatusCategory: "resolved",
        customPayload: { result: "stale" },
      },
    });
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant: matchingGrant(request),
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: challenge.approvalRequestId,
      confirmationNonce: challenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    await expect(
      service.claim({ request, grant: matchingGrant(request) }),
    ).resolves.toEqual({ ok: true });
    const dispatcher = createD1CustomMcpCapabilityDispatcher({
      db: testEnv.DB,
      now: () => BASE_TIME,
    });

    await expect(
      service.dispatchApprovedMutation({
        request,
        effect: (constrained) =>
          dispatcher.dispatch({
            authorized: Object.freeze({
              actor: constrained.actor,
              shipletId: constrained.shipletId,
              revisionId: constrained.revisionId,
              action: constrained.action,
              resource: constrained.resource,
              requestId: constrained.requestId,
              input: constrained.input,
            }),
            stateNamespace: `shiplet:${constrained.shipletId}:revision:${constrained.revisionId}`,
            egressPolicy: { allowedResources: [] },
            invocationId: constrained.parentRequestId,
            deadlineAt: BASE_TIME + 30_000,
            signal: new AbortController().signal,
          }),
      }),
    ).resolves.toMatchObject({ status: "aborted" });
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM shiplet_events
		 WHERE project_id = ? AND summary = ?`,
      )
        .bind(fixture.shipletId, "Must not commit after promotion")
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });

  it("Given a claimed approval, When dispatch input or declared authority changes, Then the effect is never reached", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const request = approvalRequest(fixture);
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant: matchingGrant(request),
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: challenge.approvalRequestId,
      confirmationNonce: challenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    await service.claim({ request, grant: matchingGrant(request) });
    const effect = vi.fn();
    expect(
      await service.dispatchApprovedMutation({
        request: {
          ...request,
          declaredCapabilities: [],
          capability: "review.feedback.delete",
        },
        effect,
      }),
    ).toEqual({
      status: "aborted",
      journalId: expect.stringMatching(/^approval-denied:/),
    });
    expect(effect).not.toHaveBeenCalled();
  });

  it("Given a dispatched or failed effect, When replayed, Then it is not executed twice and failures are audited", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const request = approvalRequest(fixture);
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant: matchingGrant(request),
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: challenge.approvalRequestId,
      confirmationNonce: challenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    await service.claim({ request, grant: matchingGrant(request) });
    const effect = vi.fn(async () => {
      throw new Error("provider detail must not escape");
    });
    expect(await service.dispatchApprovedMutation({ request, effect })).toEqual(
      {
        status: "reconciliation_required",
        journalId: expect.stringMatching(/^approval-reconcile:/),
      },
    );
    expect(await service.dispatchApprovedMutation({ request, effect })).toEqual(
      {
        status: "aborted",
        journalId: expect.stringMatching(/^approval-denied:/),
      },
    );
    expect(effect).toHaveBeenCalledOnce();
    const completion = await testEnv.DB.prepare(
      `SELECT outcome FROM shiplet_custom_mcp_approval_audit
			 WHERE approval_id = ? AND event_kind = 'dispatch_completion'`,
    )
      .bind(challenge.approvalRequestId)
      .first<{ outcome: string }>();
    expect(completion).toEqual({ outcome: "reconciliation_required" });
  });

  it("Given a claimed mutation, When its authoritative grant or approval is revoked before dispatch, Then the effect fails closed", async () => {
    for (const authorityToRevoke of ["grant", "approval"] as const) {
      const fixture = await seedFixture();
      const authority = createAuthorityState();
      const service = createService({ fixture, authority });
      const request = approvalRequest(fixture, {
        parentRequestId: `request_post_claim_${authorityToRevoke}`,
        childRequestId: `request_post_claim_${authorityToRevoke}:capability:1`,
      });
      const grant = matchingGrant(request);
      const challenge = await service.legacyNonceCeremony.begin({
        request,
        grant,
      });
      await service.legacyNonceCeremony.confirm({
        approvalRequestId: challenge.approvalRequestId,
        confirmationNonce: challenge.confirmationNonce,
        trustedActor: HUMAN,
      });
      expect(await service.claim({ request, grant })).toEqual({ ok: true });
      if (authorityToRevoke === "grant") {
        authority.revokedGrantIds.add(grant.id);
      } else {
        const approvalDigest = [...authority.activeApprovalDigests][0];
        expect(approvalDigest).toBeTypeOf("string");
        authority.revokedApprovalDigests.add(approvalDigest);
      }
      const effect = vi.fn();
      expect(
        await service.dispatchApprovedMutation({ request, effect }),
      ).toEqual({
        status: "aborted",
        journalId: expect.stringMatching(/^approval-denied:/),
      });
      expect(effect).not.toHaveBeenCalled();
    }
  });

  it("Given a structurally convincing fabricated or stale grant, When claim resolves authoritative state, Then it cannot mint approval", async () => {
    for (const grant of [
      {
        ...matchingGrant(
          approvalRequest({
            shipletId: "placeholder",
            revisionId: "placeholder_revision",
            siblingShipletId: "sibling",
            siblingRevisionId: "sibling_revision",
          }),
        ),
        id: "grant_fabricated",
      },
      {
        ...matchingGrant(
          approvalRequest({
            shipletId: "placeholder",
            revisionId: "placeholder_revision",
            siblingShipletId: "sibling",
            siblingRevisionId: "sibling_revision",
          }),
        ),
        generation: 2,
      },
    ]) {
      const fixture = await seedFixture();
      const authority = createAuthorityState();
      authority.rejectedGrantIds.add("grant_fabricated");
      const service = createService({ fixture, authority });
      const request = approvalRequest(fixture, {
        parentRequestId: `request_bad_grant_${grant.id}_${grant.generation}`,
        childRequestId: `request_bad_grant_${grant.id}_${grant.generation}:capability:1`,
      });
      const challenge = await service.getOrBeginResumable(request);
      const route = createCustomMcpApprovalConfirmationRoute({
        service,
        authenticateHuman: async () => HUMAN,
        authorizeApprover: async () => true,
        verifySameOriginCsrf: async () => true,
      });
      await route.confirm({
        approvalRequestId: challenge.approvalRequestId,
        request: new Request(
          "https://shiplet.test" + challenge.confirmationPath,
          {
            method: "POST",
          },
        ),
      });
      expect(
        await service.claim({
          request,
          grant: {
            ...grant,
            actor: HUMAN,
            shipletId: fixture.shipletId,
            revisionId: fixture.revisionId,
            action: request.capability,
            resource: request.resource,
          },
        }),
      ).toEqual({ ok: false, code: "approval_denied" });
      expect(authority.activeApprovalDigests.size).toBe(0);
    }
  });

  it("Given authority issuance succeeds but D1 finalization fails, When claim compensates, Then no active approval remains and the retry is terminal", async () => {
    const fixture = await seedFixture();
    const authority = createAuthorityState();
    const service = createService({ fixture, authority });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_finalize_fault",
      childRequestId: "request_finalize_fault:capability:1",
    });
    const grant = matchingGrant(request);
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant,
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: challenge.approvalRequestId,
      confirmationNonce: challenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    await testEnv.DB.prepare(
      `CREATE TRIGGER fail_custom_mcp_claim_finalization
       BEFORE UPDATE OF status ON shiplet_custom_mcp_approvals
       WHEN NEW.status = 'claimed'
       BEGIN
         SELECT RAISE(ABORT, 'injected_claim_finalization_failure');
       END`,
    ).run();
    try {
      expect(await service.claim({ request, grant })).toEqual({
        ok: false,
        code: "approval_denied",
      });
    } finally {
      await testEnv.DB.prepare(
        "DROP TRIGGER fail_custom_mcp_claim_finalization",
      ).run();
    }
    expect(authority.compensationCalls).toHaveLength(1);
    expect(authority.activeApprovalDigests.size).toBe(0);
    const row = await testEnv.DB.prepare(
      "SELECT status FROM shiplet_custom_mcp_approvals WHERE id = ?",
    )
      .bind(challenge.approvalRequestId)
      .first<{ status: string }>();
    expect(row).toEqual({ status: "failed" });
  });

  it("Given finalization and immediate compensation are uncertain, When the idempotent issuance reconciliation runs, Then the intent reaches a safe terminal state", async () => {
    const fixture = await seedFixture();
    const authority = createAuthorityState();
    authority.failCompensation = true;
    const service = createService({ fixture, authority });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_issuance_reconcile",
      childRequestId: "request_issuance_reconcile:capability:1",
    });
    const grant = matchingGrant(request);
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant,
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: challenge.approvalRequestId,
      confirmationNonce: challenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    await testEnv.DB.prepare(
      `CREATE TRIGGER fail_custom_mcp_claim_finalization
       BEFORE UPDATE OF status ON shiplet_custom_mcp_approvals
       WHEN NEW.status = 'claimed'
       BEGIN
         SELECT RAISE(ABORT, 'injected_claim_finalization_failure');
       END`,
    ).run();
    try {
      expect(await service.claim({ request, grant })).toEqual({
        ok: false,
        code: "approval_denied",
      });
    } finally {
      await testEnv.DB.prepare(
        "DROP TRIGGER fail_custom_mcp_claim_finalization",
      ).run();
    }
    expect(
      await service.recoverApprovalIssuance({
        approvalRequestId: challenge.approvalRequestId,
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: true, status: "compensated" });
    const row = await testEnv.DB.prepare(
      "SELECT status FROM shiplet_custom_mcp_approvals WHERE id = ?",
    )
      .bind(challenge.approvalRequestId)
      .first<{ status: string }>();
    expect(row).toEqual({ status: "failed" });
    expect(authority.activeApprovalDigests.size).toBe(0);
    expect(
      authority.compensationCalls.some((entry) =>
        entry.startsWith("reconcile:"),
      ),
    ).toBe(true);
  });

  it("Given a dispatch lease expires while outcome is unknown, When recovery runs, Then it becomes reconciliation-required and is never executed again", async () => {
    const fixture = await seedFixture();
    let now = BASE_TIME;
    const service = createService({ fixture, now: () => now });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_stuck_dispatch",
      childRequestId: "request_stuck_dispatch:capability:1",
    });
    const grant = matchingGrant(request);
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant,
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: challenge.approvalRequestId,
      confirmationNonce: challenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    await service.claim({ request, grant });
    await testEnv.DB.prepare(
      `UPDATE shiplet_custom_mcp_approvals
          SET status = 'dispatching', dispatch_started_at_ms = ?,
              dispatch_lease_expires_at_ms = ?
        WHERE id = ? AND status = 'claimed'`,
    )
      .bind(now, now + 5_000, challenge.approvalRequestId)
      .run();
    now += 5_000;
    expect(
      await service.recoverStuckDispatch({
        approvalRequestId: challenge.approvalRequestId,
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: true, status: "reconciliation_required" });
    const effect = vi.fn();
    expect(await service.dispatchApprovedMutation({ request, effect })).toEqual(
      {
        status: "aborted",
        journalId: expect.stringMatching(/^approval-denied:/),
      },
    );
    expect(effect).not.toHaveBeenCalled();
  });
});

describe("custom MCP approval production hardening", () => {
  it("Given provider-controlled effect output, When dispatch completes, Then only a copied strict bounded data projection crosses the kernel boundary", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_projected_result",
      childRequestId: "request_projected_result:capability:1",
    });
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant: matchingGrant(request),
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: challenge.approvalRequestId,
      confirmationNonce: challenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    await service.claim({ request, grant: matchingGrant(request) });
    const providerValue = { created: true, nested: ["safe"] };
    const providerOutcome = {
      status: "committed" as const,
      journalId: "journal_projected",
      value: providerValue,
    };
    const projected = await service.dispatchApprovedMutation({
      request,
      effect: async () => providerOutcome,
    });
    expect(projected).toEqual(providerOutcome);
    expect(projected).not.toBe(providerOutcome);
    if (projected.status === "committed") {
      expect(projected.value).not.toBe(providerValue);
      expect(Object.isFrozen(projected)).toBe(true);
      expect(Object.isFrozen(projected.value)).toBe(true);
      expect(
        Object.isFrozen((projected.value as { nested: string[] }).nested),
      ).toBe(true);
    }

    const invalidOutcomes = [
      () => ({
        status: "committed" as const,
        journalId: "journal_extra",
        value: { created: true },
        authority: "must-not-cross",
      }),
      () => ({
        status: "committed" as const,
        journalId: "journal_oversized",
        value: { body: "x".repeat(16_385) },
      }),
      () => ({
        status: "committed" as const,
        journalId: "<script>provider-journal</script>",
        value: { created: true },
      }),
    ];
    for (const [index, makeOutcome] of invalidOutcomes.entries()) {
      const invalidFixture = await seedFixture();
      const invalidService = createService({ fixture: invalidFixture });
      const invalidRequest = approvalRequest(invalidFixture, {
        parentRequestId: `request_invalid_projection_${index}`,
        childRequestId: `request_invalid_projection_${index}:capability:1`,
      });
      const invalidChallenge = await invalidService.legacyNonceCeremony.begin({
        request: invalidRequest,
        grant: matchingGrant(invalidRequest),
      });
      await invalidService.legacyNonceCeremony.confirm({
        approvalRequestId: invalidChallenge.approvalRequestId,
        confirmationNonce: invalidChallenge.confirmationNonce,
        trustedActor: HUMAN,
      });
      await invalidService.claim({
        request: invalidRequest,
        grant: matchingGrant(invalidRequest),
      });
      expect(
        await invalidService.dispatchApprovedMutation({
          request: invalidRequest,
          effect: async () => makeOutcome(),
        }),
      ).toEqual({
        status: "reconciliation_required",
        journalId: expect.stringMatching(/^approval-reconcile:/),
      });
    }

    let getterCalls = 0;
    const accessorFixture = await seedFixture();
    const accessorService = createService({ fixture: accessorFixture });
    const accessorRequest = approvalRequest(accessorFixture, {
      parentRequestId: "request_accessor_projection",
      childRequestId: "request_accessor_projection:capability:1",
    });
    const accessorChallenge = await accessorService.legacyNonceCeremony.begin({
      request: accessorRequest,
      grant: matchingGrant(accessorRequest),
    });
    await accessorService.legacyNonceCeremony.confirm({
      approvalRequestId: accessorChallenge.approvalRequestId,
      confirmationNonce: accessorChallenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    await accessorService.claim({
      request: accessorRequest,
      grant: matchingGrant(accessorRequest),
    });
    const accessorOutcome = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorOutcome, "status", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "committed";
      },
    });
    Object.defineProperties(accessorOutcome, {
      journalId: { enumerable: true, value: "journal_accessor" },
      value: { enumerable: true, value: { created: true } },
    });
    expect(
      await accessorService.dispatchApprovedMutation({
        request: accessorRequest,
        effect: async () => accessorOutcome as never,
      }),
    ).toEqual({
      status: "reconciliation_required",
      journalId: expect.stringMatching(/^approval-reconcile:/),
    });
    expect(getterCalls).toBe(0);
  });

  it("Given a claimed mutation, When authority changes or an adapter fabricates a partial answer, Then one atomic current-state check immediately before effect fails closed", async () => {
    for (const mode of ["race", "fabricated"] as const) {
      const fixture = await seedFixture();
      const authority = createAuthorityState();
      const service = createService({ fixture, authority });
      const request = approvalRequest(fixture, {
        parentRequestId: `request_atomic_${mode}`,
        childRequestId: `request_atomic_${mode}:capability:1`,
      });
      const challenge = await service.legacyNonceCeremony.begin({
        request,
        grant: matchingGrant(request),
      });
      await service.legacyNonceCeremony.confirm({
        approvalRequestId: challenge.approvalRequestId,
        confirmationNonce: challenge.confirmationNonce,
        trustedActor: HUMAN,
      });
      await service.claim({ request, grant: matchingGrant(request) });
      const sequentialCounts = {
        active: authority.resolveActiveRevisionCalls,
        grant: authority.resolveCapabilityGrantCalls,
      };
      authority.denyAtomicDispatch = mode === "race";
      authority.fabricateAtomicDispatchResolution = mode === "fabricated";
      const effect = vi.fn();
      expect(
        await service.dispatchApprovedMutation({ request, effect }),
      ).toEqual({
        status: "aborted",
        journalId: expect.stringMatching(/^approval-denied:/),
      });
      expect(effect).not.toHaveBeenCalled();
      expect(authority.atomicDispatchChecks).toBe(1);
      expect(authority.resolveActiveRevisionCalls).toBe(
        sequentialCounts.active,
      );
      expect(authority.resolveCapabilityGrantCalls).toBe(
        sequentialCounts.grant,
      );
    }
  });

  it("Given issuance succeeds but approval sealing fails or the process stalls in claiming, When recovery runs, Then leases prevent live authority from being stranded", async () => {
    const digestFixture = await seedFixture();
    const digestAuthority = createAuthorityState();
    const digestService = createService({
      fixture: digestFixture,
      authority: digestAuthority,
      failApprovalDigest: true,
    });
    const digestRequest = approvalRequest(digestFixture, {
      parentRequestId: "request_digest_failure",
      childRequestId: "request_digest_failure:capability:1",
    });
    const digestChallenge = await digestService.legacyNonceCeremony.begin({
      request: digestRequest,
      grant: matchingGrant(digestRequest),
    });
    await digestService.legacyNonceCeremony.confirm({
      approvalRequestId: digestChallenge.approvalRequestId,
      confirmationNonce: digestChallenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    expect(
      await digestService.claim({
        request: digestRequest,
        grant: matchingGrant(digestRequest),
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    expect(digestAuthority.compensationCalls).toHaveLength(1);
    expect(digestAuthority.activeApprovalDigests.size).toBe(0);

    const stuckFixture = await seedFixture();
    let now = BASE_TIME;
    const stuckAuthority = createAuthorityState();
    const stuckService = createService({
      fixture: stuckFixture,
      authority: stuckAuthority,
      now: () => now,
    });
    const stuckRequest = approvalRequest(stuckFixture, {
      parentRequestId: "request_stuck_claim",
      childRequestId: "request_stuck_claim:capability:1",
    });
    const stuckChallenge = await stuckService.legacyNonceCeremony.begin({
      request: stuckRequest,
      grant: matchingGrant(stuckRequest),
    });
    await stuckService.legacyNonceCeremony.confirm({
      approvalRequestId: stuckChallenge.approvalRequestId,
      confirmationNonce: stuckChallenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    await testEnv.DB.prepare(
      `UPDATE shiplet_custom_mcp_approvals
          SET status = 'claiming', claimed_at_ms = ?,
              claim_lease_expires_at_ms = ?, grant_id = ?, grant_generation = ?
        WHERE id = ? AND status = 'confirmed'`,
    )
      .bind(
        now,
        now + 5_000,
        matchingGrant(stuckRequest).id,
        matchingGrant(stuckRequest).generation,
        stuckChallenge.approvalRequestId,
      )
      .run();
    now += 5_000;
    expect(
      await stuckService.recoverStuckClaim({
        approvalRequestId: stuckChallenge.approvalRequestId,
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: true, status: "compensated" });
    expect(
      await testEnv.DB.prepare(
        `SELECT status, claim_lease_expires_at_ms AS lease
           FROM shiplet_custom_mcp_approvals WHERE id = ?`,
      )
        .bind(stuckChallenge.approvalRequestId)
        .first(),
    ).toEqual({ status: "failed", lease: BASE_TIME + 5_000 });

    const uncertainFixture = await seedFixture();
    let uncertainNow = BASE_TIME;
    const uncertainAuthority = createAuthorityState();
    const uncertainService = createService({
      fixture: uncertainFixture,
      authority: uncertainAuthority,
      now: () => uncertainNow,
      failIssuanceAfterAuthority: true,
    });
    const uncertainRequest = approvalRequest(uncertainFixture, {
      parentRequestId: "request_uncertain_issuance_d1_failure",
      childRequestId: "request_uncertain_issuance_d1_failure:capability:1",
    });
    const uncertainChallenge = await uncertainService.legacyNonceCeremony.begin(
      {
        request: uncertainRequest,
        grant: matchingGrant(uncertainRequest),
      },
    );
    await uncertainService.legacyNonceCeremony.confirm({
      approvalRequestId: uncertainChallenge.approvalRequestId,
      confirmationNonce: uncertainChallenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    await testEnv.DB.prepare(
      `CREATE TRIGGER fail_uncertain_issuance_persistence
       BEFORE UPDATE OF status ON shiplet_custom_mcp_approvals
       WHEN OLD.status = 'claiming' AND NEW.status = 'reconciliation_required'
       BEGIN
         SELECT RAISE(ABORT, 'injected_uncertain_issuance_persistence_failure');
       END`,
    ).run();
    try {
      expect(
        await uncertainService.claim({
          request: uncertainRequest,
          grant: matchingGrant(uncertainRequest),
        }),
      ).toEqual({ ok: false, code: "approval_denied" });
    } finally {
      await testEnv.DB.prepare(
        "DROP TRIGGER fail_uncertain_issuance_persistence",
      ).run();
    }
    expect(uncertainAuthority.activeApprovalDigests.size).toBe(1);
    uncertainNow += 5_000;
    expect(
      await uncertainService.recoverStuckClaim({
        approvalRequestId: uncertainChallenge.approvalRequestId,
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: true, status: "compensated" });
    expect(uncertainAuthority.activeApprovalDigests.size).toBe(0);
  });

  it("Given a claimed approval, When the human revokes it, Then digest-bound authority is revoked and all later dispatch fails", async () => {
    const fixture = await seedFixture();
    const authority = createAuthorityState();
    const service = createService({ fixture, authority });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_revoke_claimed",
      childRequestId: "request_revoke_claimed:capability:1",
    });
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant: matchingGrant(request),
    });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: challenge.approvalRequestId,
      confirmationNonce: challenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    await service.claim({ request, grant: matchingGrant(request) });
    expect(
      await service.revoke({
        approvalRequestId: challenge.approvalRequestId,
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: true });
    expect(authority.authorityRevocationCalls).toHaveLength(1);
    expect(authority.activeApprovalDigests.size).toBe(0);
    const effect = vi.fn();
    expect(await service.dispatchApprovedMutation({ request, effect })).toEqual(
      {
        status: "aborted",
        journalId: expect.stringMatching(/^approval-denied:/),
      },
    );
    expect(effect).not.toHaveBeenCalled();
  });

  it("Given existing approval state, When denied, mismatched, replayed, or revoked attempts occur, Then immutable digest-only audit evidence is durable", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_denial_audit",
      childRequestId: "request_denial_audit:capability:1",
      capabilityInput: { body: "raw denial body must not persist" },
      resource: "feedback:raw-denial-resource",
    });
    const challenge = await service.legacyNonceCeremony.begin({
      request,
      grant: matchingGrant(request),
    });
    expect(
      await service.legacyNonceCeremony.confirm({
        approvalRequestId: challenge.approvalRequestId,
        confirmationNonce: "wrong-confirmation",
        trustedActor: HUMAN,
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    await service.legacyNonceCeremony.confirm({
      approvalRequestId: challenge.approvalRequestId,
      confirmationNonce: challenge.confirmationNonce,
      trustedActor: HUMAN,
    });
    await service.claim({ request, grant: matchingGrant(request) });
    await service.claim({ request, grant: matchingGrant(request) });
    await service.revoke({
      approvalRequestId: challenge.approvalRequestId,
      trustedActor: HUMAN,
    });
    await service.dispatchApprovedMutation({ request, effect: vi.fn() });

    const mismatchRequest = approvalRequest(fixture, {
      parentRequestId: "request_mismatch_audit",
      childRequestId: "request_mismatch_audit:capability:1",
    });
    await service.getOrBeginResumable(mismatchRequest);
    await expect(
      service.getOrBeginResumable({
        ...mismatchRequest,
        capabilityInput: { changed: true },
      }),
    ).rejects.toThrow();

    const audits = await testEnv.DB.prepare(
      `SELECT event_kind, outcome, capability, resource, input_digest
         FROM shiplet_custom_mcp_approval_audit
        WHERE approval_id IN (?, ?)
        ORDER BY sequence`,
    )
      .bind(
        challenge.approvalRequestId,
        (await service.getOrBeginResumable(mismatchRequest)).approvalRequestId,
      )
      .all<Record<string, string>>();
    expect(audits.results.map((entry) => entry.outcome)).toEqual(
      expect.arrayContaining(["denied", "mismatched", "replayed", "revoked"]),
    );
    const serialized = JSON.stringify(audits.results);
    expect(serialized).not.toContain("raw denial body must not persist");
    expect(serialized).not.toContain("raw-denial-resource");
    expect(serialized).not.toContain(request.capability);
    for (const audit of audits.results) {
      expect(audit.capability).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(audit.resource).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(audit.input_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it("Given a known mutation category, When trusted confirmation renders, Then summaries stay redacted while exact target data is visibly quoted as untrusted", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_specific_summary",
      childRequestId: "request_specific_summary:capability:1",
      resource: "feedback:private-thread-8675309",
    });
    const pending = await service.getOrBeginResumable(request);
    const model = await service.readTrustedConfirmation({
      approvalRequestId: pending.approvalRequestId,
      trustedActor: HUMAN,
    });
    expect(model).toEqual({
      ok: true,
      approval: {
        approvalRequestId: pending.approvalRequestId,
        actionSummary: "Post or update review feedback",
        changeSummary: "Post or update review feedback",
        resourceSummary: "Review feedback thread (identifier hidden)",
        tool: {
          name: request.toolName,
          trust: "untrusted_package_content",
        },
        invoker: {
          kind: "human",
          label: "Signed-in human requested this change",
        },
        scope: {
          shipletId: fixture.shipletId,
          revisionId: fixture.revisionId,
          activationGeneration: 7,
        },
        review: {
          trust: "untrusted_quoted_data",
          target: {
            capability: request.capability,
            resource: request.resource,
          },
          input: request.capabilityInput,
        },
        expiresAt: pending.expiresAt,
        trust: "trusted_kernel",
      },
    });
    expect(model.ok && model.approval.resourceSummary).not.toContain(
      "private-thread-8675309",
    );
    expect(model.ok && model.approval.review.target.resource).toBe(
      "feedback:private-thread-8675309",
    );
  });

  it("Given a trusted confirmation route, When the authorized human denies the exact intent, Then it is revoked and cannot later be claimed", async () => {
    const fixture = await seedFixture();
    const service = createService({ fixture });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_trusted_deny",
      childRequestId: "request_trusted_deny:capability:1",
    });
    const pending = await service.getOrBeginResumable(request);
    const route = createCustomMcpApprovalConfirmationRoute({
      service,
      authenticateHuman: async () => HUMAN,
      authorizeApprover: async () => true,
      verifySameOriginCsrf: async () => true,
    });

    await expect(
      service.denyResumableFromTrustedRoute({
        approvalRequestId: pending.approvalRequestId,
        proof: {
          approvalRequestId: pending.approvalRequestId,
          actor: HUMAN,
          decision: "deny",
        },
      }),
    ).resolves.toEqual({ ok: false, code: "approval_denied" });
    const removedMemberRoute = createCustomMcpApprovalConfirmationRoute({
      service,
      authenticateHuman: async () => HUMAN,
      authorizeApprover: async () => false,
      verifySameOriginCsrf: async () => true,
    });
    await expect(
      removedMemberRoute.deny({
        approvalRequestId: pending.approvalRequestId,
        request: new Request(
          `https://shiplet.test${pending.confirmationPath.replace(/\/confirm$/, "/deny")}`,
          { method: "POST" },
        ),
      }),
    ).resolves.toEqual({ ok: false, code: "approval_denied" });
    await expect(
      route.deny({
        approvalRequestId: pending.approvalRequestId,
        request: new Request(
          `https://shiplet.test${pending.confirmationPath.replace(/\/confirm$/, "/deny")}`,
          { method: "POST" },
        ),
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      service.claim({ request, grant: matchingGrant(request) }),
    ).resolves.toEqual({ ok: false, code: "approval_denied" });
    await expect(
      testEnv.DB.prepare(
        `SELECT status FROM shiplet_custom_mcp_approvals WHERE id = ?`,
      )
        .bind(pending.approvalRequestId)
        .first(),
    ).resolves.toEqual({ status: "revoked" });
  });

  it("Given the D1 kernel, When callers select an approval ceremony, Then resumable service APIs carry no nonce and legacy nonce APIs are explicitly isolated", async () => {
    const fixture = await seedFixture();
    const kernel = createService({ fixture });
    expect(kernel).not.toHaveProperty("begin");
    expect(kernel).not.toHaveProperty("confirm");
    expect(kernel.legacyNonceCeremony).toEqual({
      begin: expect.any(Function),
      confirm: expect.any(Function),
    });
    const request = approvalRequest(fixture, {
      parentRequestId: "request_separated_ceremony",
      childRequestId: "request_separated_ceremony:capability:1",
    });
    const resumable = await kernel.getOrBeginResumable(request);
    expect(JSON.stringify(resumable)).not.toMatch(/nonce/i);
    const legacyRequest = approvalRequest(fixture, {
      parentRequestId: "request_separated_legacy_ceremony",
      childRequestId: "request_separated_legacy_ceremony:capability:1",
    });
    const legacy = await kernel.legacyNonceCeremony.begin({
      request: legacyRequest,
      grant: matchingGrant(legacyRequest),
    });
    expect(legacy.confirmationNonce).toMatch(/^mcp_confirmation_/);
  });
});
