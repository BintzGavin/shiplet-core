import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CapabilityGrant,
  TrustedApprovalBinding,
} from "../src/capability-broker";
import {
  bindCustomMcpMutationApprovalRequest,
  createCustomMcpApprovalConfirmationRoute,
  createD1CustomMcpApprovalService,
  ensureCustomMcpApprovalSchema,
  type CustomMcpMutationApprovalRequest,
} from "../src/custom-mcp-approval";
import { ensureSchema } from "../src/schema";
import { ensureRevisionSchema } from "../src/self-owned/revisions";

type TestEnv = { DB: D1Database };

const testEnv = env as TestEnv;
const NOW = Date.parse("2026-08-05T18:00:00.000Z");
const AGENT = { kind: "agent" as const, id: "organization_token_a" };
const HUMAN = { kind: "human" as const, id: "user_token_owner_a" };

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `sha256:${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function seedActiveShiplet(): Promise<{
  shipletId: string;
  revisionId: string;
}> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const shipletId = `shiplet_attribution_${suffix}`;
  const revisionId = `revision_attribution_${suffix}`;
  const timestamp = new Date(NOW).toISOString();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO projects (
		id, name, subdomain, script_content, visibility, created_on, modified_on,
		active_revision_id, active_revision_generation
	) VALUES (?, ?, ?, '', 'private', ?, ?, NULL, 0)`,
    ).bind(shipletId, shipletId, `${shipletId}-host`, timestamp, timestamp),
    testEnv.DB.prepare(
      `INSERT INTO shiplet_revisions (
		id, project_id, parent_revision_id, package_json, package_digest,
		runtime_compatibility, validation_report_json,
		created_by_actor_kind, created_by_actor_id, created_on
	) VALUES (?, ?, NULL, '{}', ?, 'shiplet-runtime/v1', '{}', 'agent', ?, ?)`,
    ).bind(
      revisionId,
      shipletId,
      `sha256:${"c".repeat(64)}`,
      AGENT.id,
      timestamp,
    ),
  ]);
  await testEnv.DB.prepare(
    `UPDATE projects SET active_revision_id = ?, active_revision_generation = 1
	 WHERE id = ?`,
  )
    .bind(revisionId, shipletId)
    .run();
  return { shipletId, revisionId };
}

function attributedInvocation(fixture: {
  shipletId: string;
  revisionId: string;
}) {
  return {
    invokerActor: AGENT,
    trustedApprover: HUMAN,
    shipletId: fixture.shipletId,
    revisionId: fixture.revisionId,
    activationGeneration: 1,
    toolName: `shiplet.${fixture.shipletId}.${fixture.revisionId}.create-comment`,
    parentRequestId: "mcp_request_attribution",
    toolInput: { ticket: 7 },
    declaredCapabilities: ["review.feedback.write"],
    ttlMs: 30_000,
  } as const;
}

function attributedRequest(fixture: {
  shipletId: string;
  revisionId: string;
}): CustomMcpMutationApprovalRequest {
  const invocation = attributedInvocation(fixture);
  return bindCustomMcpMutationApprovalRequest({
    invocation,
    child: {
      actor: AGENT,
      shipletId: fixture.shipletId,
      revisionId: fixture.revisionId,
      parentRequestId: invocation.parentRequestId,
      childRequestId: `${invocation.parentRequestId}:capability:1`,
      capability: "review.feedback.write",
      resource: "feedback:attribution-thread",
      effect: "mutation",
      input: { body: "Agent-authored, human-approved" },
    },
  });
}

function agentGrant(
  request: CustomMcpMutationApprovalRequest,
): CapabilityGrant {
  return {
    id: "grant_agent_attribution",
    generation: 1,
    actor: AGENT,
    shipletId: request.shipletId,
    revisionId: request.revisionId,
    action: request.capability,
    resource: request.resource,
    effect: "mutation",
    approval: "trusted-human",
    expiresAt: NOW + 60_000,
    revokedAt: null,
  };
}

beforeEach(async () => {
  await ensureSchema(testEnv.DB);
  await ensureRevisionSchema(testEnv.DB);
  await ensureCustomMcpApprovalSchema(testEnv.DB);
});

describe("custom MCP invoker and approver attribution", () => {
  it("keeps an agent invoker distinct from the trusted human approver", () => {
    const request = bindCustomMcpMutationApprovalRequest({
      invocation: {
        invokerActor: { kind: "agent", id: "organization_token_a" },
        trustedApprover: { kind: "human", id: "user_token_owner_a" },
        shipletId: "shiplet_a",
        revisionId: "revision_a1",
        activationGeneration: 1,
        toolName: "shiplet.shiplet_a.revision_a1.create-comment",
        parentRequestId: "mcp_request_a",
        toolInput: { ticket: 7 },
        declaredCapabilities: ["review.feedback.write"],
        ttlMs: 30_000,
      },
      child: {
        actor: { kind: "agent", id: "organization_token_a" },
        shipletId: "shiplet_a",
        revisionId: "revision_a1",
        parentRequestId: "mcp_request_a",
        childRequestId: "mcp_request_a:capability:1",
        capability: "review.feedback.write",
        resource: "review:feedback",
        effect: "mutation",
        input: { body: "Agent-authored, human-approved" },
      },
    });

    expect(request).toMatchObject({
      invokerActor: { kind: "agent", id: "organization_token_a" },
      trustedApprover: { kind: "human", id: "user_token_owner_a" },
    });
    expect(Object.prototype.hasOwnProperty.call(request, "trustedActor")).toBe(
      false,
    );
  });

  it("preserves the legacy human request shape so existing binding digests remain resumable", () => {
    const legacyActor = { kind: "human" as const, id: "legacy_human" };
    const request = bindCustomMcpMutationApprovalRequest({
      invocation: {
        trustedActor: legacyActor,
        shipletId: "legacy_shiplet",
        revisionId: "legacy_revision",
        activationGeneration: 1,
        toolName: "legacy_tool",
        parentRequestId: "legacy_parent",
        toolInput: {},
        declaredCapabilities: ["review.feedback.write"],
        ttlMs: 30_000,
      },
      child: {
        actor: legacyActor,
        shipletId: "legacy_shiplet",
        revisionId: "legacy_revision",
        parentRequestId: "legacy_parent",
        childRequestId: "legacy_child",
        capability: "review.feedback.write",
        resource: "feedback:legacy-thread",
        effect: "mutation",
        input: {},
      },
    });

    expect(request).toMatchObject({ trustedActor: legacyActor });
    expect(Object.prototype.hasOwnProperty.call(request, "invokerActor")).toBe(
      false,
    );
    expect(
      Object.prototype.hasOwnProperty.call(request, "trustedApprover"),
    ).toBe(false);
  });

  it("rejects lifecycle timestamp mutation without its exact state transition", async () => {
    const fixture = await seedActiveShiplet();
    const approvalRequestId = `mcp_approval_${crypto.randomUUID()}`;
    const digestValue = "d".repeat(64);
    await testEnv.DB.prepare(
      `INSERT INTO shiplet_custom_mcp_approvals (
        id, binding_digest, confirmation_nonce_digest, project_id, revision_id,
        activation_generation, actor_kind, actor_id, invoker_actor_kind,
        invoker_actor_id, tool_name, parent_request_id, child_request_id,
        tool_input_digest, declared_capabilities_digest, capability, resource,
        action_summary, change_summary, resource_summary, effect,
        review_target_json, review_input_json,
        capability_input_digest,
        grant_id, grant_generation, approval_digest,
        issuance_idempotency_key, expires_at_ms, status, created_at_ms
      ) VALUES (?, ?, NULL, ?, ?, 1, 'human', ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?,
        'Update review feedback', 'Update review feedback',
        'Review feedback thread', 'mutation', ?, ?, ?,
        NULL, NULL, NULL, ?, ?, 'pending', ?)`,
    )
      .bind(
        approvalRequestId,
        digestValue,
        fixture.shipletId,
        fixture.revisionId,
        HUMAN.id,
        AGENT.id,
        `shiplet.${fixture.shipletId}.${fixture.revisionId}.create-comment`,
        "timestamp_integrity_parent",
        "timestamp_integrity_parent:capability:1",
        digestValue,
        digestValue,
        digestValue,
        digestValue,
        JSON.stringify({
          capability: "review.feedback.write",
          resource: "feedback:timestamp-integrity",
        }),
        JSON.stringify({ operation: "set_status", status: "Done" }),
        digestValue,
        `mcp-approval-issuance:${approvalRequestId}`,
        NOW + 30_000,
        NOW,
      )
      .run();

    for (const column of [
      "confirmed_at_ms",
      "claimed_at_ms",
      "claim_lease_expires_at_ms",
      "dispatch_started_at_ms",
      "dispatch_lease_expires_at_ms",
      "dispatch_completed_at_ms",
      "revoked_at_ms",
    ]) {
      await expect(
        testEnv.DB.prepare(
          `UPDATE shiplet_custom_mcp_approvals SET ${column} = ? WHERE id = ?`,
        )
          .bind(NOW + 1, approvalRequestId)
          .run(),
        column,
      ).rejects.toThrow();
    }
  });

  it("allows an agent grant to be confirmed by a distinct human and dispatches and audits as the agent", async () => {
    const fixture = await seedActiveShiplet();
    const request = attributedRequest(fixture);
    const grant = agentGrant(request);
    const issuedBindings: TrustedApprovalBinding[] = [];
    const activeApprovalDigests = new Set<string>();
    const service = createD1CustomMcpApprovalService({
      db: testEnv.DB,
      now: () => NOW,
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
          .first<{
            revisionId: string | null;
            activationGeneration: number;
          }>();
      },
      async resolveCapabilityGrant(input) {
        return input.grantId === grant.id &&
          input.grantGeneration === grant.generation &&
          input.expected.actor.kind === AGENT.kind &&
          input.expected.actor.id === AGENT.id
          ? {
              grant,
              activationFence: {
                revisionId: fixture.revisionId,
                generation: 1,
              },
            }
          : null;
      },
      async issueTrustedApproval(input) {
        issuedBindings.push(input.binding);
        const approvalId = `approval_${crypto.randomUUID()}`;
        activeApprovalDigests.add(await digest(approvalId));
        return { approvalId };
      },
      async resolveDispatchAuthorityAtomically(input) {
        if (
          input.actor.kind !== AGENT.kind ||
          input.actor.id !== AGENT.id ||
          !activeApprovalDigests.has(input.approvalDigest)
        ) {
          return null;
        }
        return {
          authorized: true,
          activationFence: {
            revisionId: fixture.revisionId,
            generation: 1,
          },
          grant: {
            id: grant.id,
            generation: grant.generation,
            expiresAt: grant.expiresAt,
            revokedAt: null,
          },
          approval: {
            digest: input.approvalDigest,
            expiresAt: grant.expiresAt,
            revokedAt: null,
          },
        };
      },
      async revokeTrustedApproval(input) {
        activeApprovalDigests.delete(input.approvalDigest);
        return { ok: true };
      },
      async compensateTrustedApproval(input) {
        activeApprovalDigests.delete(await digest(input.approvalId));
        return { ok: true };
      },
      async reconcileTrustedApprovalIssuance() {
        activeApprovalDigests.clear();
        return { status: "compensated" };
      },
    });

    const pending = await service.getOrBeginResumable(request);
    expect(
      await service.readTrustedConfirmation({
        approvalRequestId: pending.approvalRequestId,
        trustedActor: { kind: "human", id: "user_wrong" },
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    const wrongHumanRoute = createCustomMcpApprovalConfirmationRoute({
      service,
      authenticateHuman: async () => ({ kind: "human", id: "user_wrong" }),
      authorizeApprover: async () => true,
      verifySameOriginCsrf: async () => true,
    });
    expect(
      await wrongHumanRoute.confirm({
        approvalRequestId: pending.approvalRequestId,
        request: new Request(
          "https://shiplet.test" + pending.confirmationPath,
          {
            method: "POST",
          },
        ),
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    const removedMemberRoute = createCustomMcpApprovalConfirmationRoute({
      service,
      authenticateHuman: async () => HUMAN,
      authorizeApprover: async ({ approvalRequestId, actor }) =>
        approvalRequestId === pending.approvalRequestId &&
        actor.id === HUMAN.id &&
        false,
      verifySameOriginCsrf: async () => true,
    });
    expect(
      await removedMemberRoute.read({
        approvalRequestId: pending.approvalRequestId,
        request: new Request("https://shiplet.test" + pending.confirmationPath),
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    expect(
      await removedMemberRoute.confirm({
        approvalRequestId: pending.approvalRequestId,
        request: new Request(
          "https://shiplet.test" + pending.confirmationPath,
          {
            method: "POST",
          },
        ),
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    const trustedRoute = createCustomMcpApprovalConfirmationRoute({
      service,
      authenticateHuman: async () => HUMAN,
      authorizeApprover: async () => true,
      verifySameOriginCsrf: async () => true,
    });
    expect(
      await trustedRoute.read({
        approvalRequestId: pending.approvalRequestId,
        request: new Request("https://shiplet.test" + pending.confirmationPath),
      }),
    ).toMatchObject({
      ok: true,
      approval: {
        changeSummary: "Post or update review feedback",
        tool: {
          name: request.toolName,
          trust: "untrusted_package_content",
        },
        invoker: {
          kind: "agent",
          label: "Authorized agent requested this change",
        },
        scope: {
          shipletId: fixture.shipletId,
          revisionId: fixture.revisionId,
          activationGeneration: 1,
        },
        review: {
          trust: "untrusted_quoted_data",
          target: {
            capability: request.capability,
            resource: request.resource,
          },
          input: request.capabilityInput,
        },
      },
    });
    expect(
      await trustedRoute.confirm({
        approvalRequestId: pending.approvalRequestId,
        request: new Request(
          "https://shiplet.test" + pending.confirmationPath,
          {
            method: "POST",
          },
        ),
      }),
    ).toEqual({ ok: true });
    const wrongAgent = {
      kind: "agent" as const,
      id: "organization_token_wrong",
    };
    expect(
      await service.claim({
        request: { ...request, invokerActor: wrongAgent },
        grant: { ...grant, actor: wrongAgent },
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    expect(
      await service.claim({
        request: {
          ...request,
          trustedApprover: { kind: "human", id: "user_wrong" },
        },
        grant,
      }),
    ).toEqual({ ok: false, code: "approval_denied" });
    await expect(
      service.getOrBeginResumable({
        ...request,
        trustedApprover: { kind: "human", id: AGENT.id },
      }),
    ).rejects.toThrow();
    expect(await service.claim({ request, grant })).toEqual({ ok: true });
    expect(issuedBindings).toEqual([
      expect.objectContaining({ actor: AGENT, grantId: grant.id }),
    ]);

    const effect = vi.fn(async (constrained) => {
      expect(constrained.actor).toEqual(AGENT);
      return {
        status: "committed" as const,
        journalId: "journal_agent_attribution",
        value: { created: true },
      };
    });
    expect(await service.dispatchApprovedMutation({ request, effect })).toEqual(
      {
        status: "committed",
        journalId: "journal_agent_attribution",
        value: { created: true },
      },
    );
    expect(effect).toHaveBeenCalledOnce();

    const row = await testEnv.DB.prepare(
      `SELECT actor_kind, actor_id, invoker_actor_kind, invoker_actor_id
	       FROM shiplet_custom_mcp_approvals WHERE id = ?`,
    )
      .bind(pending.approvalRequestId)
      .first<Record<string, string>>();
    expect(row).toEqual({
      actor_kind: "human",
      actor_id: HUMAN.id,
      invoker_actor_kind: "agent",
      invoker_actor_id: AGENT.id,
    });
    const audits = await testEnv.DB.prepare(
      `SELECT actor_kind, actor_id, approver_kind, approver_id
	       FROM shiplet_custom_mcp_approval_audit WHERE approval_id = ?`,
    )
      .bind(pending.approvalRequestId)
      .all<Record<string, string>>();
    expect(audits.results.length).toBeGreaterThan(0);
    expect(
      audits.results.every(
        (audit) =>
          audit.actor_kind === AGENT.kind &&
          audit.actor_id === AGENT.id &&
          audit.approver_kind === HUMAN.kind &&
          audit.approver_id === HUMAN.id,
      ),
    ).toBe(true);
  });

  it("rejects wrong invokers, wrong approvers, agent self-approval, and package identity substitution", async () => {
    const fixture = await seedActiveShiplet();
    const invocation = attributedInvocation(fixture);
    const child = {
      actor: AGENT,
      shipletId: fixture.shipletId,
      revisionId: fixture.revisionId,
      parentRequestId: invocation.parentRequestId,
      childRequestId: `${invocation.parentRequestId}:capability:1`,
      capability: "review.feedback.write",
      resource: "feedback:attribution-thread",
      effect: "mutation" as const,
      input: { body: "Safe package input" },
      invokerActor: { kind: "agent", id: "package_chosen_agent" },
      trustedApprover: { kind: "human", id: "package_chosen_human" },
    };
    const bound = bindCustomMcpMutationApprovalRequest({ invocation, child });
    expect(bound).toMatchObject({
      invokerActor: AGENT,
      trustedApprover: HUMAN,
    });
    expect(JSON.stringify(bound)).not.toContain("package_chosen_agent");
    expect(JSON.stringify(bound)).not.toContain("package_chosen_human");

    expect(() =>
      bindCustomMcpMutationApprovalRequest({
        invocation,
        child: {
          ...child,
          actor: { kind: "agent", id: "organization_token_wrong" },
        },
      }),
    ).toThrow();
    expect(() =>
      bindCustomMcpMutationApprovalRequest({
        invocation: {
          ...invocation,
          trustedApprover: { kind: "human", id: AGENT.id },
        },
        child,
      }),
    ).toThrow();
    expect(() =>
      bindCustomMcpMutationApprovalRequest({
        invocation: {
          ...invocation,
          trustedApprover: { kind: "agent", id: "agent_self" },
        } as never,
        child,
      }),
    ).toThrow();

    const request = attributedRequest(fixture);
    expect(request).not.toMatchObject({
      trustedApprover: { kind: "human", id: "user_wrong" },
    });
    expect(request).not.toMatchObject({
      invokerActor: { kind: "agent", id: "organization_token_wrong" },
    });
  });

  it("backfills legacy human approval and audit rows without changing their attribution", async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `DROP TABLE IF EXISTS shiplet_custom_mcp_approval_audit`,
      ),
      testEnv.DB.prepare(`DROP TABLE IF EXISTS shiplet_custom_mcp_approvals`),
    ]);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `CREATE TABLE shiplet_custom_mcp_approvals (
		id TEXT PRIMARY KEY,
		binding_digest TEXT NOT NULL UNIQUE,
		confirmation_nonce_digest TEXT UNIQUE,
		project_id TEXT NOT NULL,
		revision_id TEXT NOT NULL,
		activation_generation INTEGER NOT NULL,
		actor_kind TEXT NOT NULL,
		actor_id TEXT NOT NULL,
		tool_name TEXT NOT NULL,
		parent_request_id TEXT NOT NULL,
		child_request_id TEXT NOT NULL,
		tool_input_digest TEXT NOT NULL,
		declared_capabilities_digest TEXT NOT NULL,
		capability TEXT NOT NULL,
		resource TEXT NOT NULL,
		action_summary TEXT NOT NULL,
		resource_summary TEXT NOT NULL,
		effect TEXT NOT NULL,
		capability_input_digest TEXT NOT NULL,
		grant_id TEXT,
		grant_generation INTEGER,
		approval_digest TEXT,
		issuance_idempotency_key TEXT NOT NULL UNIQUE,
		expires_at_ms REAL NOT NULL,
		status TEXT NOT NULL,
		confirmed_at_ms REAL,
		claimed_at_ms REAL,
		dispatch_started_at_ms REAL,
		dispatch_lease_expires_at_ms REAL,
		dispatch_completed_at_ms REAL,
		revoked_at_ms REAL,
		created_at_ms REAL NOT NULL
	)`,
      ),
      testEnv.DB.prepare(
        `CREATE TABLE shiplet_custom_mcp_approval_audit (
		sequence INTEGER PRIMARY KEY AUTOINCREMENT,
		approval_id TEXT NOT NULL,
		project_id TEXT NOT NULL,
		revision_id TEXT NOT NULL,
		actor_kind TEXT NOT NULL,
		actor_id TEXT NOT NULL,
		event_kind TEXT NOT NULL,
		outcome TEXT NOT NULL,
		request_id TEXT NOT NULL,
		tool_name TEXT NOT NULL,
		capability TEXT NOT NULL,
		resource TEXT NOT NULL,
		input_digest TEXT NOT NULL,
		occurred_at_ms REAL NOT NULL
	)`,
      ),
    ]);
    const legacyDigest = `sha256:${"d".repeat(64)}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO shiplet_custom_mcp_approvals (
		id, binding_digest, project_id, revision_id, activation_generation,
		actor_kind, actor_id, tool_name, parent_request_id, child_request_id,
		tool_input_digest, declared_capabilities_digest, capability, resource,
		action_summary, resource_summary, effect, capability_input_digest,
		issuance_idempotency_key, expires_at_ms, status, created_at_ms
	) VALUES (
		'legacy_approval', ?, 'legacy_shiplet', 'legacy_revision', 1,
		'human', 'legacy_human', 'legacy_tool', 'legacy_parent', 'legacy_child',
		?, ?, ?, ?, 'Legacy action', 'Legacy resource', 'mutation', ?,
		'legacy_issuance', ?, 'pending', ?
	)`,
      ).bind(
        legacyDigest,
        legacyDigest,
        legacyDigest,
        legacyDigest,
        legacyDigest,
        legacyDigest,
        NOW + 30_000,
        NOW,
      ),
      testEnv.DB.prepare(
        `INSERT INTO shiplet_custom_mcp_approval_audit (
		approval_id, project_id, revision_id, actor_kind, actor_id,
		event_kind, outcome, request_id, tool_name, capability, resource,
		input_digest, occurred_at_ms
	) VALUES (
		'legacy_approval', 'legacy_shiplet', 'legacy_revision',
		'human', 'legacy_human', 'approval_requested', 'pending',
		'legacy_child', 'legacy_tool', ?, ?, ?, ?
	)`,
      ).bind(legacyDigest, legacyDigest, legacyDigest, NOW),
    ]);

    await ensureCustomMcpApprovalSchema(testEnv.DB);

    expect(
      await testEnv.DB.prepare(
        `SELECT actor_kind, actor_id, invoker_actor_kind, invoker_actor_id,
		        claim_lease_expires_at_ms, review_target_json, review_input_json
		   FROM shiplet_custom_mcp_approvals WHERE id = 'legacy_approval'`,
      ).first(),
    ).toEqual({
      actor_kind: "human",
      actor_id: "legacy_human",
      invoker_actor_kind: "human",
      invoker_actor_id: "legacy_human",
      claim_lease_expires_at_ms: null,
      review_target_json: null,
      review_input_json: null,
    });
    expect(
      await testEnv.DB.prepare(
        `SELECT actor_kind, actor_id, approver_kind, approver_id
		   FROM shiplet_custom_mcp_approval_audit
		  WHERE approval_id = 'legacy_approval'`,
      ).first(),
    ).toEqual({
      actor_kind: "human",
      actor_id: "legacy_human",
      approver_kind: "human",
      approver_id: "legacy_human",
    });
  });
});
