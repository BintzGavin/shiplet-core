import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	acknowledgeD1OAuthFinalizationDelivery,
	beginD1OAuthStateWithinQuota,
	createOAuthDeliveryReturnResponse,
	prepareD1OAuthFinalizationDelivery,
	reserveD1OAuthProviderExchange,
	readD1OAuthFinalizationDelivery,
	reconcileD1ExpiredOAuthFinalizationDeliveries,
	reconcileD1ExpiredPendingOAuthConnections,
	reserveD1OAuthFinalizationFlow,
} from "../src/cloudflare-support/oauth-finalization-delivery";

const testEnv = env as { DB: D1Database };

async function reserveFlow(input: {
	stateDigest: string;
	shipletId: string;
	userId: string;
	sessionBindingDigest: string;
	expiresAt: number;
	deliveryHandle: string;
	returnKey: string;
	supportVersionId: string;
	supportVersionTag: string;
	createdOn: string;
}) {
	const started = await beginD1OAuthStateWithinQuota({
		db: testEnv.DB,
		shipletId: input.shipletId,
		userId: input.userId,
		sessionBindingDigest: input.sessionBindingDigest,
		expiresAt: input.expiresAt,
		deliveryHandle: input.deliveryHandle,
		returnKey: input.returnKey,
		supportVersionId: input.supportVersionId,
		supportVersionTag: input.supportVersionTag,
		createdOn: input.createdOn,
		begin: async () => ({ authorizationUrl: "https://dash.cloudflare.com/oauth" }),
	});
	if (!started.ok) return started;
	return reserveD1OAuthFinalizationFlow({
		db: testEnv.DB,
		startReservationId: started.reservationId,
		stateDigest: input.stateDigest,
		now: Date.parse(input.createdOn),
	});
}

async function createFlow(input: {
	stateDigest: string;
	shipletId: string;
	userId: string;
	sessionBindingDigest: string;
	expiresAt: number;
	deliveryHandle?: string;
	connectionId?: string;
}) {
	const deliveryHandleDigest = input.deliveryHandle
		? Array.from(
				new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(input.deliveryHandle),
					),
				),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("")
		: null;
	await testEnv.DB.prepare(
		`INSERT INTO oauth_flows (
			state_digest, shiplet_id, user_id, session_binding_digest,
			expires_at, status, connection_id, delivery_handle_digest, created_on
		) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
	)
		.bind(
			input.stateDigest,
			input.shipletId,
			input.userId,
			input.sessionBindingDigest,
			input.expiresAt,
			input.connectionId ?? null,
			deliveryHandleDigest,
			new Date(input.expiresAt - 60_000).toISOString(),
		)
		.run();
}

describe("D1 OAuth finalization delivery", () => {
	it("returns through a same-site top-level GET without putting the delivery handle in the URL", async () => {
		const shipletId = "shiplet_handoff_fixture";
		const returnKey = "F".repeat(22);
		const response = createOAuthDeliveryReturnResponse({
			appOrigin: "https://shiplet.example",
			shipletId,
			status: "connected",
			returnKey,
		});
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(
			`https://shiplet.example/api/cloudflare/oauth/return?status=connected&shipletId=${shipletId}&flow=${returnKey}`,
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("location")).not.toMatch(/delivery|handle/i);
		expect(() =>
			createOAuthDeliveryReturnResponse({
				appOrigin: "https://attacker.example/path",
				shipletId,
				status: "connected",
				returnKey,
			}),
		).toThrow("oauth_delivery_return_invalid");
	});

	beforeEach(async () => {
		await testEnv.DB.batch([
			testEnv.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_start_reservations (
				id TEXT PRIMARY KEY,
				shiplet_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				session_binding_digest TEXT NOT NULL,
				expected_account_id TEXT,
				delivery_handle_digest TEXT NOT NULL UNIQUE,
				return_key TEXT NOT NULL UNIQUE,
				support_version_id TEXT NOT NULL,
				support_version_tag TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
				state_digest TEXT UNIQUE,
				created_on TEXT NOT NULL,
				consumed_on TEXT,
				released_on TEXT
			)`),
			testEnv.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_flows (
				state_digest TEXT PRIMARY KEY,
				shiplet_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				session_binding_digest TEXT NOT NULL,
				expected_account_id TEXT,
				expires_at INTEGER NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'consumed', 'denied')),
				connection_id TEXT,
				created_on TEXT NOT NULL,
				completed_on TEXT,
				consumed_on TEXT,
				delivery_handle_digest TEXT,
				delivery_expires_at INTEGER,
				delivery_result_json TEXT,
				support_version_id TEXT,
				support_version_tag TEXT,
				exchange_started_on TEXT,
				exchange_committed_on TEXT,
				exchange_ambiguity_on TEXT
				,return_key TEXT,
				start_reservation_id TEXT UNIQUE
			)`),
			testEnv.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_flows_delivery_handle
				ON oauth_flows(delivery_handle_digest)
				WHERE delivery_handle_digest IS NOT NULL`),
			testEnv.DB.prepare("DELETE FROM oauth_flows"),
			testEnv.DB.prepare("DELETE FROM oauth_start_reservations"),
		]);
	});

	it("reserves one digest-only browser delivery and predetermined connection before redirect", async () => {
		const stateDigest = "a".repeat(64);
		const sessionBindingDigest = "b".repeat(64);
		const deliveryHandle = "Q".repeat(43);
		const reserved = await reserveFlow({
			stateDigest,
			shipletId: "shiplet_reservation_fixture",
			userId: "user_reservation_fixture",
			sessionBindingDigest,
			expiresAt: Date.now() + 60_000,
			deliveryHandle,
			returnKey: "G".repeat(22),
			supportVersionId: "11111111-1111-4111-8111-111111111111",
			supportVersionTag: "shiplet-reservation-fixture",
			createdOn: new Date().toISOString(),
		});
		expect(reserved).toEqual({
			ok: true,
			connectionId: `cloudflare_connection_${stateDigest.slice(0, 48)}`,
		});
		const row = await testEnv.DB.prepare(
			`SELECT connection_id, delivery_handle_digest, status
			 FROM oauth_flows WHERE state_digest = ?`,
		)
			.bind(stateDigest)
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			connection_id: `cloudflare_connection_${stateDigest.slice(0, 48)}`,
			status: "pending",
		});
		const expectedDeliveryDigest = Array.from(
			new Uint8Array(
				await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(deliveryHandle),
				),
			),
			(byte) => byte.toString(16).padStart(2, "0"),
		).join("");
		expect(row?.delivery_handle_digest).toBe(expectedDeliveryDigest);
		expect(JSON.stringify(row)).not.toContain(deliveryHandle);
		await expect(
			reserveFlow({
				stateDigest,
				shipletId: "shiplet_reservation_fixture",
				userId: "user_reservation_fixture",
				sessionBindingDigest,
				expiresAt: Date.now() + 60_000,
				deliveryHandle,
				returnKey: "H".repeat(22),
				supportVersionId: "11111111-1111-4111-8111-111111111111",
				supportVersionTag: "shiplet-reservation-fixture",
				createdOn: new Date().toISOString(),
			}),
		).resolves.toEqual({
			ok: false,
			reason: "oauth_flow_reservation_conflict",
		});
	});

	it("claims provider exchange once and exposes only the predetermined recovery binding", async () => {
		// Given a pending callback, when exchange begins, then a concurrent or
		// restarted callback cannot exchange the authorization code a second time.
		const stateDigest = "c".repeat(64);
		const now = Date.now();
		const reserved = await reserveFlow({
			stateDigest,
			shipletId: "shiplet_exchange_fixture",
			userId: "user_exchange_fixture",
			sessionBindingDigest: "d".repeat(64),
			expiresAt: now + 60_000,
			deliveryHandle: "K".repeat(43),
			returnKey: "J".repeat(22),
			supportVersionId: "22222222-2222-4222-8222-222222222222",
			supportVersionTag: "shiplet-exchange-fixture",
			createdOn: new Date(now).toISOString(),
		});
		if (!reserved.ok) throw new Error("fixture_reservation_failed");

		await expect(
			reserveD1OAuthProviderExchange({
				db: testEnv.DB,
				stateDigest,
				connectionId: reserved.connectionId,
				now,
				startedOn: new Date(now).toISOString(),
			}),
		).resolves.toEqual({
			ok: true,
			claimed: true,
			connectionId: reserved.connectionId,
		});
		await expect(
			reserveD1OAuthProviderExchange({
				db: testEnv.DB,
				stateDigest,
				connectionId: reserved.connectionId,
				now: now + 1,
				startedOn: new Date(now + 1).toISOString(),
			}),
		).resolves.toEqual({
			ok: true,
			claimed: false,
			connectionId: reserved.connectionId,
		});
		expect(
			await testEnv.DB.prepare(
				"SELECT exchange_started_on FROM oauth_flows WHERE state_digest = ?",
			)
				.bind(stateDigest)
				.first(),
		).toEqual({ exchange_started_on: new Date(now).toISOString() });
	});

	it("replays one exact actor/session/Shiplet result until ACK without persisting the opaque handle", async () => {
		const now = Date.now();
		const actor = `user_${crypto.randomUUID()}`;
		const sessionDigest = `session_${crypto.randomUUID()}`;
		const flowA = {
			stateDigest: `state_${crypto.randomUUID()}`,
			shipletId: `shiplet_${crypto.randomUUID()}`,
			connectionId: `connection_${crypto.randomUUID()}`,
			deliveryHandle: "A".repeat(43),
			deliveryResultJson: JSON.stringify({ id: "connection-a", accountLabel: "A" }),
		};
		const flowB = {
			stateDigest: `state_${crypto.randomUUID()}`,
			shipletId: `shiplet_${crypto.randomUUID()}`,
			connectionId: `connection_${crypto.randomUUID()}`,
			deliveryHandle: "B".repeat(43),
			deliveryResultJson: JSON.stringify({ id: "connection-b", accountLabel: "B" }),
		};
		for (const flow of [flowA, flowB]) {
			await createFlow({
				stateDigest: flow.stateDigest,
				shipletId: flow.shipletId,
				userId: actor,
				sessionBindingDigest: sessionDigest,
				expiresAt: now + 120_000,
				deliveryHandle: flow.deliveryHandle,
				connectionId: flow.connectionId,
			});
			await expect(
				prepareD1OAuthFinalizationDelivery({
					db: testEnv.DB,
					stateDigest: flow.stateDigest,
					shipletId: flow.shipletId,
					connectionId: flow.connectionId,
					deliveryResultJson: flow.deliveryResultJson,
					userId: actor,
					sessionBindingDigest: sessionDigest,
					completedOn: new Date(now).toISOString(),
					deliveryExpiresAt: now + 60_000,
				}),
			).resolves.toEqual({ ok: true });
		}

		const bindingA = {
			db: testEnv.DB,
			shipletId: flowA.shipletId,
			userId: actor,
			sessionBindingDigest: sessionDigest,
			deliveryHandle: flowA.deliveryHandle,
			now,
		};
		const first = await readD1OAuthFinalizationDelivery(bindingA);
		const replay = await readD1OAuthFinalizationDelivery(bindingA);
		expect(first).toEqual(replay);
		expect(first).toMatchObject({
			stateDigest: flowA.stateDigest,
			shipletId: flowA.shipletId,
			connectionId: flowA.connectionId,
			acknowledged: false,
			deliveryResultJson: flowA.deliveryResultJson,
		});
		expect(
			await readD1OAuthFinalizationDelivery({
				...bindingA,
				shipletId: flowB.shipletId,
			}),
		).toBeNull();
		expect(
			await readD1OAuthFinalizationDelivery({
				...bindingA,
				deliveryHandle: flowB.deliveryHandle,
			}),
		).toBeNull();
		const [completedB, completedA] = await Promise.all([
			readD1OAuthFinalizationDelivery({
				...bindingA,
				shipletId: flowB.shipletId,
				deliveryHandle: flowB.deliveryHandle,
			}),
			readD1OAuthFinalizationDelivery(bindingA),
		]);
		expect(completedB).toMatchObject({
			shipletId: flowB.shipletId,
			connectionId: flowB.connectionId,
			deliveryResultJson: flowB.deliveryResultJson,
		});
		expect(completedA).toEqual(first);

		await expect(
			acknowledgeD1OAuthFinalizationDelivery({
				...bindingA,
				connectionId: flowA.connectionId,
				acknowledgedOn: new Date(now + 1).toISOString(),
			}),
		).resolves.toEqual({ ok: true });
		expect(await readD1OAuthFinalizationDelivery(bindingA)).toMatchObject({
			connectionId: flowA.connectionId,
			acknowledged: true,
		});

		const persisted = await testEnv.DB.prepare(
			"SELECT * FROM oauth_flows WHERE state_digest = ?",
		)
			.bind(flowA.stateDigest)
			.first<Record<string, unknown>>();
		expect(JSON.stringify(persisted)).not.toContain(flowA.deliveryHandle);
	});

	it("revokes only expired unacknowledged delivery authority and retries failures", async () => {
		const now = Date.now();
		const actor = `user_${crypto.randomUUID()}`;
		const sessionDigest = `session_${crypto.randomUUID()}`;
		const createExpired = async (suffix: string, acknowledged: boolean) => {
			const flow = {
				stateDigest: `state_${suffix}_${crypto.randomUUID()}`,
				shipletId: `shiplet_${suffix}_${crypto.randomUUID()}`,
				connectionId: `connection_${suffix}_${crypto.randomUUID()}`,
				deliveryHandle: suffix.repeat(43),
				deliveryResultJson: JSON.stringify({ id: `connection-${suffix}` }),
			};
			await createFlow({
				stateDigest: flow.stateDigest,
				shipletId: flow.shipletId,
				userId: actor,
				sessionBindingDigest: sessionDigest,
				expiresAt: now + 60_000,
				deliveryHandle: flow.deliveryHandle,
				connectionId: flow.connectionId,
			});
			await prepareD1OAuthFinalizationDelivery({
				db: testEnv.DB,
				stateDigest: flow.stateDigest,
				shipletId: flow.shipletId,
				connectionId: flow.connectionId,
				deliveryResultJson: flow.deliveryResultJson,
				userId: actor,
				sessionBindingDigest: sessionDigest,
				completedOn: new Date(now - 60_000).toISOString(),
				deliveryExpiresAt: now - 1,
			});
			if (acknowledged) {
				await acknowledgeD1OAuthFinalizationDelivery({
					db: testEnv.DB,
					shipletId: flow.shipletId,
					userId: actor,
					sessionBindingDigest: sessionDigest,
					deliveryHandle: flow.deliveryHandle,
					connectionId: flow.connectionId,
					now: now - 10,
					acknowledgedOn: new Date(now - 10).toISOString(),
				});
			}
			return flow;
		};
		const pending = await createExpired("P", false);
		const acknowledged = await createExpired("K", true);
		const revoke = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: false }));

		await expect(
			reconcileD1ExpiredOAuthFinalizationDeliveries({
				db: testEnv.DB,
				now,
				limit: 25,
				revoke,
			}),
		).resolves.toEqual({ inspected: 1, revoked: 0 });
		expect(revoke).toHaveBeenCalledTimes(1);
		expect(revoke).toHaveBeenCalledWith({
			actor: { kind: "human", id: actor },
			connectionId: pending.connectionId,
		});

		revoke.mockResolvedValueOnce({ ok: true });
		await expect(
			reconcileD1ExpiredOAuthFinalizationDeliveries({
				db: testEnv.DB,
				now,
				limit: 25,
				revoke,
			}),
		).resolves.toEqual({ inspected: 1, revoked: 1 });
		expect(
			await testEnv.DB.prepare(
				"SELECT status FROM oauth_flows WHERE state_digest = ?",
			)
				.bind(pending.stateDigest)
				.first(),
		).toEqual({ status: "denied" });
		expect(
			await testEnv.DB.prepare(
				"SELECT status FROM oauth_flows WHERE state_digest = ?",
			)
				.bind(acknowledged.stateDigest)
				.first(),
		).toEqual({ status: "consumed" });
	});

	it("revokes an expired pending connection left between exchange and delivery preparation", async () => {
		const now = Date.now();
		const actor = `user_${crypto.randomUUID()}`;
		const connectionId = `connection_${crypto.randomUUID()}`;
		const stateDigest = `state_${crypto.randomUUID()}`;
		await createFlow({
			stateDigest,
			shipletId: `shiplet_${crypto.randomUUID()}`,
			userId: actor,
			sessionBindingDigest: `session_${crypto.randomUUID()}`,
			expiresAt: now - 1,
			deliveryHandle: "Z".repeat(43),
			connectionId,
		});
		const revoke = vi.fn(async () => ({ ok: true }));

		await expect(
			reconcileD1ExpiredPendingOAuthConnections({
				db: testEnv.DB,
				now,
				limit: 25,
				loadConnection: async (id) =>
					id === connectionId ? { status: "active" as const } : null,
				revoke,
			}),
		).resolves.toEqual({ inspected: 1, revoked: 1, denied: 1 });
		expect(revoke).toHaveBeenCalledWith({
			actor: { kind: "human", id: actor },
			connectionId,
		});
		expect(
			await testEnv.DB.prepare(
				"SELECT status FROM oauth_flows WHERE state_digest = ?",
			)
				.bind(stateDigest)
				.first(),
		).toEqual({ status: "denied" });
	});

	it("closes an abandoned expired flow but keeps failed orphan cleanup retryable", async () => {
		const now = Date.now();
		const actor = `user_${crypto.randomUUID()}`;
		const abandonedConnectionId = `connection_${crypto.randomUUID()}`;
		const retryConnectionId = `connection_${crypto.randomUUID()}`;
		const abandonedState = `state_${crypto.randomUUID()}`;
		const retryState = `state_${crypto.randomUUID()}`;
		for (const [stateDigest, connectionId, handle] of [
			[abandonedState, abandonedConnectionId, "X".repeat(43)],
			[retryState, retryConnectionId, "Y".repeat(43)],
		] as const) {
			await createFlow({
				stateDigest,
				shipletId: `shiplet_${crypto.randomUUID()}`,
				userId: actor,
				sessionBindingDigest: `session_${crypto.randomUUID()}`,
				expiresAt: now - 1,
				deliveryHandle: handle,
				connectionId,
			});
		}
		const revoke = vi.fn(async () => ({ ok: false }));

		await expect(
			reconcileD1ExpiredPendingOAuthConnections({
				db: testEnv.DB,
				now,
				limit: 25,
				loadConnection: async (id) =>
					id === retryConnectionId ? { status: "active" as const } : null,
				revoke,
			}),
		).resolves.toEqual({ inspected: 2, revoked: 0, denied: 1 });
		expect(revoke).toHaveBeenCalledOnce();
		expect(
			await testEnv.DB.prepare(
				"SELECT status FROM oauth_flows WHERE state_digest = ?",
			)
				.bind(abandonedState)
				.first(),
		).toEqual({ status: "denied" });
		expect(
			await testEnv.DB.prepare(
				"SELECT status FROM oauth_flows WHERE state_digest = ?",
			)
				.bind(retryState)
				.first(),
		).toEqual({ status: "pending" });
	});
});
