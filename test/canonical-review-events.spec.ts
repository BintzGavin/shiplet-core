import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
	createCanonicalEventStore,
	ensureCanonicalEventSchema,
} from "../src/canonical-review-events";
import { ensureSchema } from "../src/schema";

type TestEnv = { DB: D1Database };
const testEnv = env as TestEnv;

function id(prefix: string) {
	return `${prefix}_${crypto.randomUUID()}`;
}

async function insertProject(projectId: string) {
	const now = new Date().toISOString();
	await testEnv.DB.prepare(
		`INSERT INTO projects (
			id, name, subdomain, script_content, visibility, created_on, modified_on
		) VALUES (?, ?, ?, '', 'private', ?, ?)`,
	)
		.bind(projectId, projectId, id("events"), now, now)
		.run();
}

describe("canonical review event envelope", () => {
	beforeEach(async () => {
		await ensureSchema(testEnv.DB);
		await ensureCanonicalEventSchema(testEnv.DB);
	});

	it("records arbitrary workflow content in a bounded canonical envelope", async () => {
		const shipletId = id("project_event");
		const revisionId = id("revision_event");
		await insertProject(shipletId);
		const store = createCanonicalEventStore({
			db: testEnv.DB,
			resolveAuthority: async () => ({
				allowed: true as const,
				actor: { kind: "agent" as const, id: "agent_reviewer" },
			}),
			revisionBelongsToShiplet: async (candidateRevision, candidateShiplet) =>
				candidateRevision === revisionId && candidateShiplet === shipletId,
			now: () => new Date("2026-08-05T18:00:00.000Z"),
		});

		const event = await store.record({
			authorityHandle: "grant_event_a",
			shipletId,
			revisionId,
			eventKind: "workflow.approval-requested",
			summary: "Legal review requested",
			canonicalStatusCategory: "in_progress",
			customPayload: {
				status: "Waiting on counsel",
				fields: { jurisdiction: "US-IL", urgency: 3 },
			},
			occurredAt: "2026-08-05T17:59:00.000Z",
		});

		expect(event).toMatchObject({
			shipletId,
			revisionId,
			actorKind: "agent",
			actorId: "agent_reviewer",
			eventKind: "workflow.approval-requested",
			summary: "Legal review requested",
			canonicalStatusCategory: "in_progress",
			occurredAt: "2026-08-05T17:59:00.000Z",
			createdAt: "2026-08-05T18:00:00.000Z",
		});
		expect(event.eventId).toMatch(/^event_/);
		expect(event.customPayload).toEqual({
			status: "Waiting on counsel",
			fields: { jurisdiction: "US-IL", urgency: 3 },
		});
		expect(Object.isFrozen(event.customPayload)).toBe(true);
		expect(JSON.stringify(event)).not.toContain("grant_event_a");
	});

	it("rejects sibling revision guesses before writing", async () => {
		const shipletA = id("project_a");
		const shipletB = id("project_b");
		await insertProject(shipletA);
		await insertProject(shipletB);
		let authorityCalls = 0;
		const store = createCanonicalEventStore({
			db: testEnv.DB,
			resolveAuthority: async () => {
				authorityCalls += 1;
				return {
					allowed: true as const,
					actor: { kind: "human" as const, id: "user_a" },
				};
			},
			revisionBelongsToShiplet: async (_revisionId, shipletId) =>
				shipletId === shipletB,
		});

		await expect(
			store.record({
				authorityHandle: "grant_a",
				shipletId: shipletA,
				revisionId: "revision_b",
				eventKind: "workflow.status-changed",
				summary: "Crossed boundary",
				canonicalStatusCategory: "open",
				customPayload: {},
			}),
		).rejects.toMatchObject({ code: "revision_scope_mismatch" });
		expect(authorityCalls).toBe(0);
		const count = await testEnv.DB.prepare(
			"SELECT COUNT(*) AS count FROM shiplet_events WHERE project_id = ?",
		)
			.bind(shipletA)
			.first<{ count: number }>();
		expect(count?.count).toBe(0);
	});

	it("uses only the kernel-resolved actor and fails closed on denial", async () => {
		const shipletId = id("project_denied");
		await insertProject(shipletId);
		const store = createCanonicalEventStore({
			db: testEnv.DB,
			resolveAuthority: async ({ authorityHandle, eventKind }) => {
				expect(authorityHandle).toBe("revoked_grant");
				expect(eventKind).toBe("review.comment-created");
				return { allowed: false as const, reason: "revoked" as const };
			},
			revisionBelongsToShiplet: async () => true,
		});
		await expect(
			store.record({
				authorityHandle: "revoked_grant",
				shipletId,
				revisionId: "revision_denied",
				eventKind: "review.comment-created",
				summary: "Must not persist",
				canonicalStatusCategory: "open",
				customPayload: {},
			}),
		).rejects.toMatchObject({ code: "authority_denied" });
	});

	it.each(["token", "oauthToken", "authorization", "claim_url", "password"])(
		"rejects credential-shaped custom payload key %s",
		async (key) => {
			const shipletId = id("project_secret");
			await insertProject(shipletId);
			const store = createCanonicalEventStore({
				db: testEnv.DB,
				resolveAuthority: async () => ({
					allowed: true as const,
					actor: { kind: "shiplet" as const, id: shipletId },
				}),
				revisionBelongsToShiplet: async () => true,
			});
			await expect(
				store.record({
					authorityHandle: "grant_secret",
					shipletId,
					revisionId: "revision_secret",
					eventKind: "workflow.custom",
					summary: "Credential attempt",
					canonicalStatusCategory: "unknown",
					customPayload: { [key]: "must-not-persist" },
				}),
			).rejects.toMatchObject({ code: "forbidden_payload_key" });
		},
	);

	it("enforces envelope and custom payload limits before authority", async () => {
		const shipletId = id("project_limits");
		await insertProject(shipletId);
		let authorityCalls = 0;
		const store = createCanonicalEventStore({
			db: testEnv.DB,
			resolveAuthority: async () => {
				authorityCalls += 1;
				return {
					allowed: true as const,
					actor: { kind: "system" as const, id: "kernel" },
				};
			},
			revisionBelongsToShiplet: async () => true,
		});
		await expect(
			store.record({
				authorityHandle: "grant_limits",
				shipletId,
				revisionId: "revision_limits",
				eventKind: "workflow.custom",
				summary: "Too large",
				canonicalStatusCategory: "unknown",
				customPayload: { value: "x".repeat(70_000) },
			}),
		).rejects.toMatchObject({ code: "payload_too_large" });
		expect(authorityCalls).toBe(0);
	});

	it("makes the canonical event history immutable and Shiplet-scoped", async () => {
		const shipletId = id("project_immutable");
		await insertProject(shipletId);
		const store = createCanonicalEventStore({
			db: testEnv.DB,
			resolveAuthority: async () => ({
				allowed: true as const,
				actor: { kind: "human" as const, id: "user_owner" },
			}),
			revisionBelongsToShiplet: async () => true,
		});
		const event = await store.record({
			authorityHandle: "grant_immutable",
			shipletId,
			revisionId: "revision_immutable",
			eventKind: "review.comment-created",
			summary: "Keep forever",
			canonicalStatusCategory: "open",
			customPayload: { commentId: "comment_a" },
		});
		await expect(
			testEnv.DB.prepare("UPDATE shiplet_events SET summary = 'changed' WHERE id = ?")
				.bind(event.eventId)
				.run(),
		).rejects.toThrow();
		await expect(
			testEnv.DB.prepare("DELETE FROM shiplet_events WHERE id = ?")
				.bind(event.eventId)
				.run(),
		).rejects.toThrow();
		const listed = await store.list({ shipletId, limit: 10 });
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ eventId: event.eventId, summary: "Keep forever" });
	});
});
