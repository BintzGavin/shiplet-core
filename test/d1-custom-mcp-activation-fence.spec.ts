import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
	createCapabilityBroker,
	type AtomicCapabilityUse,
	type CapabilityGrant,
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
const ACTOR = { kind: "human" as const, id: "user_activation_fence" };
const SHIPLET_A = "shiplet_activation_fence_a";
const SHIPLET_B = "shiplet_activation_fence_b";
const REVISION_A1 = "revision_activation_fence_a1";
const REVISION_A2 = "revision_activation_fence_a2";
const REVISION_B1 = "revision_activation_fence_b1";

type ActivationFenceInput = {
	activationFence: {
		revisionId: string;
		generation: number;
	};
};

async function seedShiplet(
	shipletId: string,
	revisionIds: readonly string[],
	activeRevisionId: string,
	activeRevisionGeneration: number,
) {
	const now = new Date(NOW).toISOString();
	await testEnv.DB.prepare(
		`INSERT OR IGNORE INTO projects (
			id, name, subdomain, script_content, visibility, created_on, modified_on,
			active_revision_id, active_revision_generation
		) VALUES (?, ?, ?, '', 'private', ?, ?, NULL, 0)`,
	)
		.bind(
			shipletId,
			shipletId,
			`${shipletId}-${crypto.randomUUID()}`,
			now,
			now,
		)
		.run();
	for (const [index, revisionId] of revisionIds.entries()) {
		await testEnv.DB.prepare(
			`INSERT OR IGNORE INTO shiplet_revisions (
				id, project_id, parent_revision_id, package_json, package_digest,
				runtime_compatibility, validation_report_json,
				created_by_actor_kind, created_by_actor_id, created_on
			) VALUES (?, ?, ?, '{}', ?, 'shiplet-runtime/v1', '{}', 'human', ?, ?)`,
		)
			.bind(
				revisionId,
				shipletId,
				index === 0 ? null : revisionIds[index - 1],
				`sha256:${String(index + 1).repeat(64)}`,
				ACTOR.id,
				now,
			)
			.run();
	}
	await activate(shipletId, activeRevisionId, activeRevisionGeneration);
}

async function activate(
	shipletId: string,
	revisionId: string,
	generation: number,
) {
	await testEnv.DB.prepare(
		`UPDATE projects
		 SET active_revision_id = ?, active_revision_generation = ?
		 WHERE id = ?`,
	)
		.bind(revisionId, generation, shipletId)
		.run();
}

function fencedGrantInput(
	revisionId: string,
	generation: number,
	overrides: Record<string, unknown> = {},
) {
	return {
		actor: ACTOR,
		shipletId: SHIPLET_A,
		revisionId,
		action: "mcp.custom.invoke:summarize-review",
		resource: "mcp-tool:shiplet.activation-fence.summarize-review",
		effect: "read" as const,
		approval: "none" as const,
		expiresAt: NOW + 60_000,
		activationFence: { revisionId, generation },
		...overrides,
	};
}

function atomicUse(
	grant: CapabilityGrant,
	opaqueHandle: string,
	requestId: string,
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
		inputDigest: `sha256:${"a".repeat(64)}`,
		requestId,
		now: NOW,
	};
}

beforeEach(async () => {
	await ensureSchema(testEnv.DB);
	await ensureRevisionSchema(testEnv.DB);
	await ensureCapabilityKernelSchema(testEnv.DB);
	await seedShiplet(SHIPLET_A, [REVISION_A1, REVISION_A2], REVISION_A1, 1);
	await seedShiplet(SHIPLET_B, [REVISION_B1], REVISION_B1, 1);
});

/**
 * Given custom MCP authority is requested for an immutable revision,
 * when the kernel issues its opaque capability,
 * then issuance is one atomic D1 check against the exact active revision and
 * activation generation rather than a mere revision-membership check.
 */
describe("D1 custom MCP activation fence", () => {
	it("issues only for the exact active revision and generation", async () => {
		const kernel = createD1CapabilityKernel({ db: testEnv.DB, now: () => NOW });

		await expect(
			kernel.issueGrant(fencedGrantInput(REVISION_A2, 1)),
		).rejects.toThrow("Capability grant scope does not exist");
		await expect(
			kernel.issueGrant(fencedGrantInput(REVISION_A1, 2)),
		).rejects.toThrow("Capability grant scope does not exist");
		await expect(
			kernel.issueGrant({
				...fencedGrantInput(REVISION_A1, 1),
				activationFence: { revisionId: REVISION_B1, generation: 1 },
			} as ReturnType<typeof fencedGrantInput> & ActivationFenceInput),
		).rejects.toThrow("Invalid capability grant");

		const issued = await kernel.issueGrant(fencedGrantInput(REVISION_A1, 1));
		const row = await testEnv.DB.prepare(
			`SELECT activation_revision_id, activation_generation
			 FROM shiplet_broker_grants WHERE id = ?`,
		)
			.bind(issued.grantId)
			.first<{
				activation_revision_id: string | null;
				activation_generation: number | null;
			}>();
		expect(row).toEqual({
			activation_revision_id: REVISION_A1,
			activation_generation: 1,
		});
	});

	/**
	 * Given an exact fenced grant has already been issued,
	 * when promotion or rollback changes the activation generation before claim,
	 * then the atomic claim fails before a use record (and therefore an effect)
	 * can be committed. A rollback to the same revision does not revive the grant.
	 */
	it("fails closed at claim after promotion and after rollback to the same revision", async () => {
		const kernel = createD1CapabilityKernel({ db: testEnv.DB, now: () => NOW });
		const issued = await kernel.issueGrant(fencedGrantInput(REVISION_A1, 1));
		const grant = (await kernel.resolveOpaqueHandle(
			issued.opaqueHandle,
		)) as CapabilityGrant;

		await activate(SHIPLET_A, REVISION_A2, 2);
		expect(
			await kernel.revalidateAndClaim(
				atomicUse(grant, issued.opaqueHandle, "request_after_promotion"),
			),
		).toEqual({ ok: false, reason: "scope_mismatch" });

		await activate(SHIPLET_A, REVISION_A1, 3);
		expect(
			await kernel.revalidateAndClaim(
				atomicUse(grant, issued.opaqueHandle, "request_after_rollback"),
			),
		).toEqual({ ok: false, reason: "scope_mismatch" });

		const staleUses = await testEnv.DB.prepare(
			"SELECT COUNT(*) AS count FROM shiplet_broker_uses WHERE grant_id = ?",
		)
			.bind(issued.grantId)
			.first<{ count: number }>();
		expect(staleUses?.count).toBe(0);

		const current = await kernel.issueGrant(fencedGrantInput(REVISION_A1, 3));
		const currentGrant = (await kernel.resolveOpaqueHandle(
			current.opaqueHandle,
		)) as CapabilityGrant;
		expect(
			await kernel.revalidateAndClaim(
				atomicUse(currentGrant, current.opaqueHandle, "request_current"),
			),
		).toEqual({ ok: true });
	});

	/**
	 * Given callers can guess sibling/historical scope or race activation,
	 * revocation, and expiry,
	 * when they invoke through the trusted broker,
	 * then every closed denial has the same public shape and a sanitized durable
	 * audit record without handles, approvals, credentials, or raw input.
	 */
	it("makes scope, activation, revocation, and expiry denials publicly indistinguishable and audited", async () => {
		let now = NOW;
		const kernel = createD1CapabilityKernel({ db: testEnv.DB, now: () => now });
		const stale = await kernel.issueGrant(fencedGrantInput(REVISION_A1, 1));
		const revoked = await kernel.issueGrant(fencedGrantInput(REVISION_A1, 1));
		const expired = await kernel.issueGrant(
			fencedGrantInput(REVISION_A1, 1, { expiresAt: NOW + 1_000 }),
		);
		const staleGrant = (await kernel.resolveOpaqueHandle(
			stale.opaqueHandle,
		)) as CapabilityGrant;
		const revokedGrant = (await kernel.resolveOpaqueHandle(
			revoked.opaqueHandle,
		)) as CapabilityGrant;
		const expiredGrant = (await kernel.resolveOpaqueHandle(
			expired.opaqueHandle,
		)) as CapabilityGrant;
		await kernel.revokeGrant({
			shipletId: SHIPLET_A,
			grantId: revoked.grantId,
			expectedGeneration: revoked.generation,
		});
		await activate(SHIPLET_A, REVISION_A2, 2);
		now = NOW + 2_000;

		const broker = createCapabilityBroker({
			now: () => now,
			limits: { maxInputBytes: 4_096, maxMetadataFieldBytes: 1_024 },
			grants: kernel,
			approvals: kernel,
			validateActionPayload: () => true,
			audit: (event) => kernel.audit(event),
		});
		const invoke = (
			grant: CapabilityGrant,
			opaqueHandle: string,
			requestId: string,
			overrides: Partial<{
				shipletId: string;
				revisionId: string;
			}> = {},
		) =>
			broker.invoke(
				{
					opaqueHandle,
					trustedActor: ACTOR,
					request: {
						requestId,
						shipletId: overrides.shipletId ?? grant.shipletId,
						revisionId: overrides.revisionId ?? grant.revisionId,
						action: grant.action,
						resource: grant.resource,
						input: { body: "untrusted-payload-marker" },
					},
				},
				async () => {
					throw new Error("denied capability reached its effect");
				},
			);

		const denials = await Promise.all([
			invoke(staleGrant, stale.opaqueHandle, "request_stale_activation"),
			invoke(revokedGrant, revoked.opaqueHandle, "request_revoked"),
			invoke(expiredGrant, expired.opaqueHandle, "request_expired"),
			invoke(staleGrant, stale.opaqueHandle, "request_sibling_guess", {
				shipletId: SHIPLET_B,
				revisionId: REVISION_B1,
			}),
			invoke(staleGrant, stale.opaqueHandle, "request_historical_guess", {
				revisionId: REVISION_A2,
			}),
		]);
		expect(denials).toEqual(
			Array.from({ length: 5 }, () => ({
				ok: false,
				code: "capability_denied",
			})),
		);

		const audits = await testEnv.DB.prepare(
			`SELECT payload_json FROM shiplet_audit_events
			 WHERE event_kind = 'capability.completion'
				AND status_category = 'rejected'
				AND actor_id = ?
			 ORDER BY recorded_on`,
		)
			.bind(ACTOR.id)
			.all<{ payload_json: string }>();
		expect(audits.results).toHaveLength(5);
		for (const row of audits.results) {
			const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
			expect(Object.keys(payload)).not.toEqual(
				expect.arrayContaining([
					"opaqueHandle",
					"approvalId",
					"credential",
					"input",
				]),
			);
			expect(row.payload_json).not.toContain("untrusted-payload-marker");
		}
	});
});
