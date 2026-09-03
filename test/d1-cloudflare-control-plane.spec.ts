import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
	createD1CloudflareConnectionStore,
	createD1CloudflareOAuthStateStore,
	ensureCloudflareControlPlaneSchema,
} from "../src/d1-cloudflare-control-plane";
import { ensureSchema } from "../src/schema";

type TestEnv = { DB: D1Database };
const testEnv = env as TestEnv;

class OpaqueStateVault {
	readonly values = new Map<string, object>();
	readonly retired = new Set<string>();
	retireThrows = false;

	async seal(material: object) {
		const ref = `state_ref_${crypto.randomUUID()}`;
		this.values.set(ref, structuredClone(material));
		return ref;
	}

	async withMaterial<T>(ref: string, operation: (material: object) => Promise<T>) {
		const material = this.values.get(ref);
		if (!material) throw new Error("state_material_unavailable");
		return operation(structuredClone(material));
	}

	async retire(ref: string) {
		if (this.retireThrows) throw new Error("retirement_unavailable");
		this.values.delete(ref);
		this.retired.add(ref);
	}
}

describe("D1 Cloudflare control-plane stores", () => {
	beforeEach(async () => {
		await ensureSchema(testEnv.DB);
		await ensureCloudflareControlPlaneSchema(testEnv.DB);
	});

	it("stores only an opaque vault reference for OAuth state and consumes the exact user/session/redirect binding once", async () => {
		const vault = new OpaqueStateVault();
		const store = createD1CloudflareOAuthStateStore({
			db: testEnv.DB,
			vault,
		});
		const verifier = crypto.randomUUID().replaceAll("-", "");
		const state = {
			id: crypto.randomUUID(),
			userId: `user_${crypto.randomUUID()}`,
			sessionId: crypto.randomUUID(),
			redirectUri: "https://shiplet.example/api/cloudflare/oauth/callback",
			expectedAccountId: `account_${crypto.randomUUID()}`,
			requestedScopes: ["workers.scripts.write"],
			codeVerifier: verifier,
			expiresAt: Date.now() + 60_000,
		};
		await store.put(state);

		const persisted = await testEnv.DB.prepare(
			`SELECT user_id, session_binding_digest, redirect_uri_digest,
			 secret_ref, consumed_on FROM cloudflare_oauth_state_refs WHERE id = ?`,
		)
			.bind(state.id)
			.first<Record<string, unknown>>();
		expect(persisted).toMatchObject({ user_id: state.userId, consumed_on: null });
		expect(JSON.stringify(persisted)).not.toContain(verifier);
		expect(JSON.stringify(persisted)).not.toContain(state.sessionId);
		expect(JSON.stringify(persisted)).not.toContain(state.redirectUri);

		const candidate = await store.get(state.id);
		expect(candidate).toMatchObject({ id: state.id, userId: state.userId });
		expect(Boolean(candidate && candidate.codeVerifier === verifier)).toBe(true);
		expect(
			await store.consumeBound({
				id: state.id,
				userId: state.userId,
				sessionId: crypto.randomUUID(),
				redirectUri: state.redirectUri,
			}),
		).toBeNull();
		const consumed = await store.consumeBound({
			id: state.id,
			userId: state.userId,
			sessionId: state.sessionId,
			redirectUri: state.redirectUri,
		});
		expect(Boolean(consumed && consumed.codeVerifier === verifier)).toBe(true);
		expect(
			await store.consumeBound({
				id: state.id,
				userId: state.userId,
				sessionId: state.sessionId,
				redirectUri: state.redirectUri,
			}),
		).toBeNull();
		expect(vault.values.size).toBe(0);
		expect(vault.retired.size).toBe(1);
	});

	it("retains only an opaque cleanup reference when consumed OAuth state retirement is unavailable", async () => {
		const vault = new OpaqueStateVault();
		vault.retireThrows = true;
		const store = createD1CloudflareOAuthStateStore({ db: testEnv.DB, vault });
		const state = {
			id: crypto.randomUUID(),
			userId: `user_${crypto.randomUUID()}`,
			sessionId: crypto.randomUUID(),
			redirectUri: "https://shiplet.example/api/cloudflare/oauth/callback",
			requestedScopes: ["workers.scripts.write"],
			codeVerifier: crypto.randomUUID().replaceAll("-", ""),
			expiresAt: Date.now() + 60_000,
		};
		await store.put(state);
		expect(
			await store.consumeBound({
				id: state.id,
				userId: state.userId,
				sessionId: state.sessionId,
				redirectUri: state.redirectUri,
			}),
		).toMatchObject({ id: state.id });
		const persisted = await testEnv.DB.prepare(
			`SELECT secret_ref, consumed_on FROM cloudflare_oauth_state_refs
			 WHERE id = ?`,
		)
			.bind(state.id)
			.first<{ secret_ref: string | null; consumed_on: string | null }>();
		expect(persisted?.consumed_on).toBeTruthy();
		expect(persisted?.secret_ref).toMatch(/^state_ref_/);
		expect(
			await store.consumeBound({
				id: state.id,
				userId: state.userId,
				sessionId: state.sessionId,
				redirectUri: state.redirectUri,
			}),
		).toBeNull();
	});

	it("persists public connection metadata, uses generation CAS, serializes refresh reservations, and never returns vault refs publicly", async () => {
		const store = createD1CloudflareConnectionStore({
			db: testEnv.DB,
			now: () => 1_800_000_000_000,
		});
		const userId = `user_${crypto.randomUUID()}`;
		const connection = await store.create({
			userId,
			accountId: `account_${crypto.randomUUID()}`,
			accountLabel: "Owned Cloudflare account",
			scopes: ["workers.scripts.read", "workers.scripts.write"],
			credentialRef: `vault_ref_${crypto.randomUUID()}`,
			expiresAt: 1_900_000_000_000,
			generation: 1,
		});
		const publicConnections = await store.listPublicForUser(userId);
		expect(publicConnections).toEqual([
			expect.objectContaining({
				id: connection.id,
				status: "active",
				generation: 1,
			}),
		]);
		expect(JSON.stringify(publicConnections)).not.toContain("credentialRef");
		expect(JSON.stringify(publicConnections)).not.toContain(connection.credentialRef);

		expect(
			await store.compareAndSwapCredential({
				id: connection.id,
				expectedCredentialRef: connection.credentialRef,
				nextCredentialRef: `vault_ref_${crypto.randomUUID()}`,
				expiresAt: 1_950_000_000_000,
				refreshedAt: 1_800_000_000_001,
				expectedGeneration: 1,
				nextGeneration: 2,
			}),
		).toBe(true);
		expect(
			await store.compareAndSwapCredential({
				id: connection.id,
				expectedCredentialRef: connection.credentialRef,
				nextCredentialRef: `vault_ref_${crypto.randomUUID()}`,
				expiresAt: 1_960_000_000_000,
				refreshedAt: 1_800_000_000_002,
				expectedGeneration: 1,
				nextGeneration: 2,
			}),
		).toBe(false);

		const [first, second] = await Promise.all([
			store.reserveRefresh({
				connectionId: connection.id,
				idempotencyKey: crypto.randomUUID(),
			}),
			store.reserveRefresh({
				connectionId: connection.id,
				idempotencyKey: crypto.randomUUID(),
			}),
		]);
		expect([first.ok, second.ok].sort()).toEqual([false, true]);
		await store.releaseRefresh({ connectionId: connection.id });
		expect(
			(
				await store.reserveRefresh({
					connectionId: connection.id,
					idempotencyKey: crypto.randomUUID(),
				})
			).ok,
		).toBe(true);
	});

	it("keeps the control-plane audit outbox immutable and rejects credential-shaped event fields", async () => {
		const store = createD1CloudflareConnectionStore({
			db: testEnv.DB,
			now: () => 1_800_000_000_000,
		});
		const id = await store.recordAuditEvent({
			eventKind: "cloudflare.oauth.connected",
			actorKind: "human",
			actorId: `user_${crypto.randomUUID()}`,
			connectionId: `connection_${crypto.randomUUID()}`,
			accountId: `account_${crypto.randomUUID()}`,
			outcome: "success",
			occurredAt: 1_800_000_000_000,
		});
		expect(await store.markAuditDelivered({ id })).toBe(true);
		await expect(
			testEnv.DB.prepare(
				"UPDATE cloudflare_control_audit_outbox SET event_json = '{}' WHERE id = ?",
			)
				.bind(id)
				.run(),
		).rejects.toThrow(/immutable/i);
		await expect(
			store.recordAuditEvent({
				eventKind: "cloudflare.oauth.connected",
				accessToken: crypto.randomUUID(),
			}),
		).rejects.toThrow(/audit_event_invalid/i);
	});
});
