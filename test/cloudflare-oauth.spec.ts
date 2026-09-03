import { describe, expect, it } from "vitest";
import { createCloudflareOAuthService } from "../src/cloudflare-oauth";
import scopeContract from "./fixtures/cloudflare/scope-contract.json";

type HumanActor = { kind: "human"; id: string };

type StoredOAuthState = {
	id: string;
	userId: string;
	sessionId: string;
	redirectUri: string;
	expectedAccountId?: string;
	requestedScopes: string[];
	codeVerifier: string;
	expiresAt: number;
};

type CredentialMaterial = Readonly<Record<PropertyKey, unknown>>;

type ConnectionRecord = {
	id: string;
	userId: string;
	accountId: string;
	accountLabel: string;
	scopes: string[];
	credentialRef: string;
	expiresAt: number;
	status: "active" | "revoked";
	revokedAt?: number;
	generation?: number;
};

function runtimeId(prefix: string) {
	return `${prefix}_${crypto.randomUUID()}`;
}

function opaqueCredentialMaterial(): CredentialMaterial {
	return Object.freeze(Object.create(null)) as CredentialMaterial;
}

function base64Url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function s256(value: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return base64Url(new Uint8Array(digest));
}

class MemoryStateStore {
	private readonly records = new Map<string, StoredOAuthState>();

	async put(record: StoredOAuthState) {
		this.records.set(record.id, structuredClone(record));
	}

	async consume(id: string) {
		const record = this.records.get(id);
		this.records.delete(id);
		return record ? structuredClone(record) : null;
	}

	async get(id: string) {
		const record = this.records.get(id);
		return record ? structuredClone(record) : null;
	}

	async consumeBound(input: {
		id: string;
		userId: string;
		sessionId: string;
		redirectUri: string;
	}) {
		const record = this.records.get(input.id);
		if (!record) return null;
		if (
			record.userId !== input.userId ||
			record.sessionId !== input.sessionId ||
			record.redirectUri !== input.redirectUri
		) {
			return null;
		}
		this.records.delete(input.id);
		return structuredClone(record);
	}
}

class MemoryCredentialVault {
	readonly values = new Map<string, CredentialMaterial>();
	readonly revoked = new Set<string>();
	readonly cleanupRetries = new Set<string>();
	readonly rotations: Array<{
		ref: string;
		expectedGeneration?: number;
		material: CredentialMaterial;
	}> = [];
	readonly staged = new Set<string>();
	readonly retired = new Set<string>();
	stageSucceeds = true;
	retireSucceeds = true;
	revokeThrows = false;
	withMaterialThrows = false;

	constructor(readonly timeline: string[] = []) {}

	async seal(material: CredentialMaterial) {
		const ref = runtimeId("vault");
		this.values.set(ref, material);
		return ref;
	}

	async rotate(ref: string, material: CredentialMaterial): Promise<void>;
	async rotate(input: {
		ref: string;
		expectedGeneration: number;
		material: CredentialMaterial;
	}): Promise<void>;
	async rotate(
		refOrInput:
			| string
			| {
					ref: string;
					expectedGeneration: number;
					material: CredentialMaterial;
			  },
		legacyMaterial?: CredentialMaterial,
	): Promise<void> {
		this.timeline.push("vault.rotate_legacy");
		const ref = typeof refOrInput === "string" ? refOrInput : refOrInput.ref;
		const material =
			typeof refOrInput === "string" ? legacyMaterial : refOrInput.material;
		if (!material) throw new Error("credential_material_required");
		if (!this.values.has(ref) || this.revoked.has(ref)) {
			throw new Error("credential_ref_unavailable");
		}
		this.rotations.push({
			ref,
			expectedGeneration:
				typeof refOrInput === "string"
					? undefined
					: refOrInput.expectedGeneration,
			material,
		});
		this.values.set(ref, material);
	}

	async withMaterial<T>(
		ref: string,
		operation: (material: CredentialMaterial) => Promise<T>,
	) {
		if (this.withMaterialThrows) throw new Error("vault_material_unavailable");
		const material = this.values.get(ref);
		if (!material || this.revoked.has(ref)) {
			throw new Error("credential_ref_unavailable");
		}
		return operation(material);
	}

	async revoke(ref: string) {
		this.timeline.push("vault.revoke");
		if (this.revokeThrows) throw new Error("vault_revoke_failed");
		this.revoked.add(ref);
		this.values.delete(ref);
	}

	async retainForCleanup(ref: string) {
		this.cleanupRetries.add(ref);
	}

	async stage(material: CredentialMaterial) {
		this.timeline.push("vault.stage");
		if (!this.stageSucceeds) throw new Error("vault_stage_failed");
		const ref = runtimeId("vault_generation");
		this.values.set(ref, material);
		this.staged.add(ref);
		return { ref };
	}

	async retire(ref: string) {
		this.timeline.push("vault.retire");
		if (!this.retireSucceeds) throw new Error("vault_retire_failed");
		this.values.delete(ref);
		this.retired.add(ref);
		this.cleanupRetries.delete(ref);
	}
}

class MemoryConnectionStore {
	readonly records = new Map<string, ConnectionRecord>();
	readonly refreshReservations = new Set<string>();
	readonly auditOutbox: Array<
		Record<string, unknown> & { id: string; deliveryStatus: "pending" | "delivered" }
	> = [];
	createSucceeds = true;
	failNextRefresh = false;
	refreshCasThrows = false;

	constructor(readonly timeline: string[] = []) {}

	async create(
		record: Omit<ConnectionRecord, "id" | "status"> & {
			id?: string;
			status?: "active";
		},
	) {
		if (!this.createSucceeds) throw new Error("connection_persistence_failed");
		const stored: ConnectionRecord = {
			...structuredClone(record),
			id: record.id ?? runtimeId("connection"),
			status: "active",
			generation: record.generation ?? 1,
		};
		this.records.set(stored.id, stored);
		return structuredClone(stored);
	}

	async get(id: string) {
		const record = this.records.get(id);
		return record ? structuredClone(record) : null;
	}

	async markRefreshed(input: {
		id: string;
		expectedCredentialRef: string;
		expiresAt: number;
		refreshedAt: number;
		expectedGeneration?: number;
		nextGeneration?: number;
	}) {
		this.timeline.push("connection.refresh_legacy");
		if (this.failNextRefresh) {
			this.failNextRefresh = false;
			return false;
		}
		const record = this.records.get(input.id);
		if (
			!record ||
			record.status !== "active" ||
			record.credentialRef !== input.expectedCredentialRef
		) {
			return false;
		}
		record.expiresAt = input.expiresAt;
		if (input.nextGeneration !== undefined) {
			record.generation = input.nextGeneration;
		}
		return true;
	}

	async markRevoked(input: { id: string; revokedAt: number }) {
		const record = this.records.get(input.id);
		if (!record) return false;
		record.status = "revoked";
		record.revokedAt = input.revokedAt;
		return true;
	}

	async reserveRefresh(input: { connectionId: string; idempotencyKey: string }) {
		if (this.refreshReservations.has(input.connectionId)) {
			return { ok: false as const, reason: "refresh_in_progress" as const };
		}
		this.refreshReservations.add(input.connectionId);
		return { ok: true as const, reservationId: runtimeId("refresh") };
	}

	async releaseRefresh(input: { connectionId: string }) {
		this.refreshReservations.delete(input.connectionId);
	}

	async compareAndSwapCredential(input: {
		id: string;
		expectedCredentialRef: string;
		expectedGeneration: number;
		nextCredentialRef: string;
		nextGeneration: number;
		expiresAt: number;
		refreshedAt: number;
	}) {
		this.timeline.push("connection.cas");
		if (this.refreshCasThrows) throw new Error("connection_cas_failed");
		if (this.failNextRefresh) {
			this.failNextRefresh = false;
			return false;
		}
		const record = this.records.get(input.id);
		if (
			!record ||
			record.status !== "active" ||
			record.credentialRef !== input.expectedCredentialRef ||
			(record.generation ?? 1) !== input.expectedGeneration
		) {
			return false;
		}
		record.credentialRef = input.nextCredentialRef;
		record.generation = input.nextGeneration;
		record.expiresAt = input.expiresAt;
		return true;
	}

	async recordAuditEvent(event: Record<string, unknown>) {
		const record = {
			...structuredClone(event),
			id: runtimeId("oauth_audit"),
			deliveryStatus: "pending" as const,
		};
		this.auditOutbox.push(record);
		return record.id;
	}

	async markAuditDelivered(input: { id: string }) {
		const record = this.auditOutbox.find((candidate) => candidate.id === input.id);
		if (!record) return false;
		record.deliveryStatus = "delivered";
		return true;
	}
}

class AsyncGate {
	readonly entered: Promise<void>;
	private signalEntered!: () => void;
	private readonly released: Promise<void>;
	private signalReleased!: () => void;

	constructor() {
		this.entered = new Promise((resolve) => {
			this.signalEntered = resolve;
		});
		this.released = new Promise((resolve) => {
			this.signalReleased = resolve;
		});
	}

	async wait() {
		this.signalEntered();
		await this.released;
	}

	release() {
		this.signalReleased();
	}
}

class FakeCloudflareOAuthProvider {
	readonly authorizeRequests: Array<{
		clientId: string;
		redirectUri: string;
		state: string;
		codeChallenge: string;
		codeChallengeMethod: "S256";
		scopes: string[];
	}> = [];
	readonly exchangeRequests: Array<{
		authorizationCode: string;
		redirectUri: string;
		codeVerifier: string;
	}> = [];
	readonly refreshInputs: CredentialMaterial[] = [];
	readonly revokeInputs: CredentialMaterial[] = [];
	private readonly refreshCountWaiters = new Map<number, () => void>();
	private refreshGate: { call: number; gate: AsyncGate } | null = null;
	accountId = runtimeId("account");
	accountLabel = "Owned account";
	exchangedMaterial = opaqueCredentialMaterial();
	refreshedMaterial = opaqueCredentialMaterial();
	grantedScopes = ["workers_scripts_write"];
	pkceAccepted = true;
	refreshSucceeds = true;
	revocationSucceeds = true;
	exchangeExpiresAt = 20_000;
	refreshExpiresAt = 30_000;

	async createAuthorizationUrl(input: {
		clientId: string;
		redirectUri: string;
		state: string;
		codeChallenge: string;
		codeChallengeMethod: "S256";
		scopes: string[];
	}) {
		this.authorizeRequests.push(structuredClone(input));
		const url = new URL("https://provider.invalid/authorize");
		url.searchParams.set("state", input.state);
		return url;
	}

	async exchangeAuthorization(input: {
		authorizationCode: string;
		redirectUri: string;
		codeVerifier: string;
	}) {
		this.exchangeRequests.push(structuredClone(input));
		if (!this.pkceAccepted) throw new Error("pkce_verification_failed");
		return {
			material: this.exchangedMaterial,
			accountId: this.accountId,
			accountLabel: this.accountLabel,
			scopes: [...this.grantedScopes],
			expiresAt: this.exchangeExpiresAt,
		};
	}

	async refresh(material: CredentialMaterial) {
		this.refreshInputs.push(material);
		this.refreshCountWaiters.get(this.refreshInputs.length)?.();
		if (this.refreshGate?.call === this.refreshInputs.length) {
			await this.refreshGate.gate.wait();
		}
		if (!this.refreshSucceeds) throw new Error("provider_refresh_failed");
		return {
			material:
				this.refreshInputs.length === 1
					? this.refreshedMaterial
					: opaqueCredentialMaterial(),
			expiresAt: this.refreshExpiresAt,
		};
	}

	async revoke(material: CredentialMaterial) {
		this.revokeInputs.push(material);
		if (!this.revocationSucceeds) throw new Error("provider_revoke_failed");
	}

	pauseRefresh(call: number) {
		const gate = new AsyncGate();
		this.refreshGate = { call, gate };
		return gate;
	}

	waitForRefreshCount(count: number) {
		if (this.refreshInputs.length >= count) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.refreshCountWaiters.set(count, resolve);
		});
	}
}

async function setup(options?: {
	allowedScopes?: string[];
	grantTypes?: Array<"authorization_code" | "refresh_token">;
	atomicInitialCommit?: boolean;
	recoverableInitialCommit?: boolean;
}) {
	let now = 10_000;
	const timeline: string[] = [];
	const stateStore = new MemoryStateStore();
	const vault = new MemoryCredentialVault(timeline);
	const connections = new MemoryConnectionStore(timeline);
	const provider = new FakeCloudflareOAuthProvider();
	const audit: Array<Record<string, unknown>> = [];
	const atomicCommits: Array<Record<string, unknown>> = [];
	const auditControl: { throwFor: string | null } = { throwFor: null };
	const stateSigningKey = await crypto.subtle.generateKey(
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	const redirectUri = "https://shiplet.invalid/integrations/cloudflare/callback";
	const dependencies = {
		clientId: runtimeId("public_client"),
		redirectUri,
		stateTtlMs: 300,
		allowedScopes: options?.allowedScopes ?? [
			"workers_scripts_write",
			"workers_scripts_read",
		],
		grantTypes: options?.grantTypes ?? ["authorization_code"],
		stateSigningKey,
		stateStore,
		vault,
		connections,
		provider,
		now: () => now,
		audit: async (event: Record<string, unknown>) => {
			if (auditControl.throwFor === event.eventKind) {
				throw new Error("oauth_audit_sink_unavailable");
			}
			audit.push(structuredClone(event));
		},
		...(options?.atomicInitialCommit
			? {
					commitConnection: async (input: {
						material: CredentialMaterial;
						connection: Omit<ConnectionRecord, "credentialRef" | "status">;
					}) => {
						atomicCommits.push(structuredClone(input.connection));
						const credentialRef = runtimeId("atomic_vault");
						vault.values.set(credentialRef, input.material);
						const record: ConnectionRecord = {
							...structuredClone(input.connection),
							credentialRef,
							status: "active",
						};
						connections.records.set(record.id, record);
						return structuredClone(record);
					},
			  }
			: {}),
		...(options?.recoverableInitialCommit
			? {
					recoverableCommitConnection: async (input: {
						material: CredentialMaterial;
						connection: Omit<ConnectionRecord, "credentialRef" | "status">;
					}) => {
						atomicCommits.push(structuredClone(input.connection));
						const credentialRef = runtimeId("recoverable_vault");
						vault.values.set(credentialRef, input.material);
						const record: ConnectionRecord = {
							...structuredClone(input.connection),
							credentialRef,
							status: "active",
						};
						connections.records.set(record.id, record);
						return structuredClone(record);
					},
			  }
			: {}),
	};
	const service = createCloudflareOAuthService(dependencies);
	const actor: HumanActor = { kind: "human", id: runtimeId("user") };
	const sessionId = runtimeId("session");
	return {
		service,
		provider,
		vault,
		connections,
		audit,
		auditControl,
		atomicCommits,
		timeline,
		actor,
		sessionId,
		redirectUri,
		advance(milliseconds: number) {
			now += milliseconds;
		},
	};
}

async function beginAndCallback(context: Awaited<ReturnType<typeof setup>>) {
	const started = await context.service.begin({
		actor: context.actor,
		sessionId: context.sessionId,
		requestedScopes: ["workers_scripts_write"],
		expectedAccountId: context.provider.accountId,
	});
	return {
		state: new URL(started.authorizationUrl).searchParams.get("state")!,
		authorizationCode: runtimeId("provider_artifact"),
	};
}

function allKeys(value: unknown, keys = new Set<string>()) {
	if (!value || typeof value !== "object") return keys;
	for (const [key, child] of Object.entries(value)) {
		keys.add(key.toLowerCase());
		allKeys(child, keys);
	}
	return keys;
}

describe("Cloudflare OAuth kernel", () => {
	it("binds one-time signed state to the human, browser session, account, exact redirect, and S256 PKCE", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		const authorization = context.provider.authorizeRequests[0];

		expect(authorization.codeChallengeMethod).toBe("S256");
		expect(authorization.scopes).toEqual(["workers_scripts_write"]);

		const completed = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});
		const exchange = context.provider.exchangeRequests[0];

		expect(authorization.codeChallenge).toBe(
			await s256(exchange.codeVerifier),
		);
		expect(exchange.redirectUri).toBe(context.redirectUri);
		expect(completed).toMatchObject({
			ok: true,
			connection: {
				userId: context.actor.id,
				accountId: context.provider.accountId,
				status: "active",
			},
		});
		expect(context.vault.values.size).toBe(1);
		expect([...context.vault.values.values()][0]).toBe(
			context.provider.exchangedMaterial,
		);
		const publicKeys = allKeys(completed);
		for (const forbidden of [
			"material",
			"credentialref",
			"codeverifier",
			"authorizationcode",
		]) {
			expect(publicKeys.has(forbidden), forbidden).toBe(false);
		}
	});

	it("persists the callback under the flow's predetermined connection identity", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		const connectionId = `cloudflare_connection_${crypto.randomUUID()}`;

		const completed = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			connectionId,
			...callback,
		});

		expect(completed).toMatchObject({
			ok: true,
			connection: { id: connectionId, status: "active" },
		});
		expect(await context.connections.get(connectionId)).toMatchObject({
			id: connectionId,
			status: "active",
		});
	});

	it("accepts the provider's single account when the consent screen owns account selection", async () => {
		const context = await setup();
		const started = await context.service.begin({
			actor: context.actor,
			sessionId: context.sessionId,
			requestedScopes: ["workers_scripts_write"],
		});
		const completed = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			authorizationCode: runtimeId("provider_artifact"),
			state: new URL(started.authorizationUrl).searchParams.get("state")!,
		});

		expect(completed).toMatchObject({
			ok: true,
			connection: {
				accountId: context.provider.accountId,
			},
		});
	});

	it.each([
		"missing_state",
		"reused_state",
		"expired_state",
		"wrong_session",
		"wrong_user",
		"wrong_redirect",
		"wrong_account",
		"pkce_verification_failed",
	] as const)("rejects %s without creating a connection", async (failure) => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		const input = {
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		};

		if (failure === "missing_state") input.state = "";
		if (failure === "expired_state") context.advance(301);
		if (failure === "wrong_session") input.sessionId = runtimeId("session");
		if (failure === "wrong_user") {
			input.actor = { kind: "human", id: runtimeId("user") };
		}
		if (failure === "wrong_redirect") {
			input.redirectUri = "https://shiplet.invalid/different-callback";
		}
		if (failure === "wrong_account") {
			input.selectedAccountId = runtimeId("account");
		}
		if (failure === "pkce_verification_failed") {
			context.provider.pkceAccepted = false;
		}
		if (failure === "reused_state") {
			const first = await context.service.complete(input);
			expect(first.ok).toBe(true);
			context.connections.records.clear();
		}

		const result = await context.service.complete(input);

		expect(result).toMatchObject({ ok: false, reason: failure });
		expect(context.connections.records.size).toBe(0);
	});

	it("rejects tampered state before provider exchange", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		const changedState = `${callback.state.slice(0, -1)}${
			callback.state.endsWith("A") ? "B" : "A"
		}`;

		const result = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			authorizationCode: callback.authorizationCode,
			state: changedState,
		});

		expect(result).toEqual({ ok: false, reason: "invalid_state" });
		expect(context.provider.exchangeRequests).toHaveLength(0);
		expect(context.connections.records.size).toBe(0);
	});

	it("atomically rotates opaque vault material on refresh and exposes only public metadata", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		const completed = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});
		if (!completed.ok) throw new Error("setup_connection_failed");

		const refreshed = await context.service.refresh({
			actor: context.actor,
			connectionId: completed.connection.id,
		});
		const stored = context.connections.records.get(completed.connection.id)!;

		expect(context.provider.refreshInputs).toEqual([
			context.provider.exchangedMaterial,
		]);
		expect(context.vault.values.get(stored.credentialRef)).toBe(
			context.provider.refreshedMaterial,
		);
		expect(refreshed).toMatchObject({
			ok: true,
			connection: { id: completed.connection.id, expiresAt: 30_000 },
		});
		const publicKeys = allKeys(refreshed);
		for (const forbidden of ["material", "credentialref"]) {
			expect(publicKeys.has(forbidden), forbidden).toBe(false);
		}
	});

	it("fails refresh closed without replacing the prior vault value", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		const completed = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});
		if (!completed.ok) throw new Error("setup_connection_failed");
		const record = context.connections.records.get(completed.connection.id)!;
		context.provider.refreshSucceeds = false;

		const refreshed = await context.service.refresh({
			actor: context.actor,
			connectionId: completed.connection.id,
		});

		expect(refreshed).toEqual({
			ok: false,
			reason: "provider_refresh_failed",
		});
		expect(context.vault.values.get(record.credentialRef)).toBe(
			context.provider.exchangedMaterial,
		);
	});

	it("revokes locally and denies future management even when provider revocation fails", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		const completed = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});
		if (!completed.ok) throw new Error("setup_connection_failed");
		context.provider.revocationSucceeds = false;

		const revoked = await context.service.revoke({
			actor: context.actor,
			connectionId: completed.connection.id,
		});
		const management = await context.service.authorizeManagement({
			actor: context.actor,
			connectionId: completed.connection.id,
			accountId: context.provider.accountId,
		});

		expect(revoked).toMatchObject({
			ok: false,
			reason: "provider_revocation_failed",
			connection: { status: "revoked" },
		});
		expect(management).toEqual({ ok: false, reason: "connection_revoked" });
		expect(context.connections.records.get(completed.connection.id)?.status).toBe(
			"revoked",
		);
	});

	it("binds management to the connecting user and selected account", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		const completed = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});
		if (!completed.ok) throw new Error("setup_connection_failed");

		await expect(
			context.service.authorizeManagement({
				actor: { kind: "human", id: runtimeId("user") },
				connectionId: completed.connection.id,
				accountId: context.provider.accountId,
			}),
		).resolves.toEqual({ ok: false, reason: "connection_owner_mismatch" });
		await expect(
			context.service.authorizeManagement({
				actor: context.actor,
				connectionId: completed.connection.id,
				accountId: runtimeId("account"),
			}),
		).resolves.toEqual({ ok: false, reason: "connection_account_mismatch" });
	});

	it("keeps authorization artifacts and vault references out of denial audit data", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		context.advance(301);

		await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});

		const keys = allKeys(context.audit);
		for (const forbidden of [
			"state",
			"authorizationcode",
			"codeverifier",
			"material",
			"credentialref",
		]) {
			expect(keys.has(forbidden), forbidden).toBe(false);
		}
	});
});

describe("Cloudflare OAuth least authority and transactional lifecycle", () => {
	it("rejects requested scopes outside the kernel allowlist before creating an authorization request", async () => {
		const context = await setup();

		const result = await context.service.begin({
			actor: context.actor,
			sessionId: context.sessionId,
			requestedScopes: ["account_settings_write"],
		});

		expect(result).toEqual({ ok: false, reason: "scope_not_allowed" });
		expect(context.provider.authorizeRequests).toHaveLength(0);
	});

	it.each([
		{
			label: "missing a requested scope",
			grantedScopes: [] as string[],
			reason: "granted_scope_insufficient",
		},
		{
			label: "contains an unrequested scope",
			grantedScopes: ["workers_scripts_write", "workers_scripts_read"],
			reason: "granted_scope_escalation",
		},
	])("rejects a provider grant that $label", async ({ grantedScopes, reason }) => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		context.provider.grantedScopes = grantedScopes;

		const result = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});

		expect(result).toEqual({ ok: false, reason });
		expect(context.connections.records.size).toBe(0);
		expect(context.vault.values.size).toBe(0);
		expect(context.provider.revokeInputs).toContain(
			context.provider.exchangedMaterial,
		);
	});

	it("revokes exchanged material when the provider returns a different account than the bound selection", async () => {
		const context = await setup();
		const selectedAccountId = context.provider.accountId;
		const callback = await beginAndCallback(context);
		context.provider.accountId = runtimeId("unexpected_account");

		const result = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId,
			...callback,
		});

		expect(result).toEqual({ ok: false, reason: "wrong_account" });
		expect(context.connections.records.size).toBe(0);
		expect(context.provider.revokeInputs).toContain(
			context.provider.exchangedMaterial,
		);
	});

	it("denies management after connection expiry and when operation scopes are absent", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		const completed = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});
		if (!completed.ok) throw new Error("setup_connection_failed");
		const authorizeManagement = context.service.authorizeManagement as unknown as (
			input: {
				actor: HumanActor;
				connectionId: string;
				accountId: string;
				operation: string;
				requiredScopes: string[];
			},
		) => Promise<unknown>;

		const scopeDenied = await authorizeManagement({
			actor: context.actor,
			connectionId: completed.connection.id,
			accountId: context.provider.accountId,
			operation: "d1.database.write",
			requiredScopes: ["d1_write"],
		});
		expect(scopeDenied).toEqual({
			ok: false,
			reason: "connection_scope_insufficient",
		});

		context.advance(10_001);
		const expired = await authorizeManagement({
			actor: context.actor,
			connectionId: completed.connection.id,
			accountId: context.provider.accountId,
			operation: "worker.version.upload",
			requiredScopes: ["workers_scripts_write"],
		});
		expect(expired).toEqual({ ok: false, reason: "connection_expired" });
	});

	it("serializes concurrent refreshes by generation before asking the provider twice", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		const completed = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});
		if (!completed.ok) throw new Error("setup_connection_failed");
		const refresh = context.service.refresh as unknown as (input: {
			actor: HumanActor;
			connectionId: string;
			idempotencyKey: string;
		}) => Promise<{ ok: boolean; reason?: string }>;
		const gate = context.provider.pauseRefresh(1);
		const first = refresh({
			actor: context.actor,
			connectionId: completed.connection.id,
			idempotencyKey: runtimeId("operation"),
		});
		await gate.entered;
		const second = refresh({
			actor: context.actor,
			connectionId: completed.connection.id,
			idempotencyKey: runtimeId("operation"),
		});
		const observation = await Promise.race([
			second.then((result) => ({ kind: "result" as const, result })),
			context.provider
				.waitForRefreshCount(2)
				.then(() => ({ kind: "provider_called_twice" as const })),
		]);
		gate.release();
		await first;
		const secondResult = await second;

		expect(observation.kind).toBe("result");
		expect(secondResult).toEqual({
			ok: false,
			reason: "refresh_in_progress",
		});
		expect(context.provider.refreshInputs).toHaveLength(1);
	});

	it("keeps the prior generation and revokes newly minted material when refresh persistence CAS fails", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		const completed = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});
		if (!completed.ok) throw new Error("setup_connection_failed");
		const record = context.connections.records.get(completed.connection.id)!;
		context.connections.failNextRefresh = true;

		const result = await context.service.refresh({
			actor: context.actor,
			connectionId: completed.connection.id,
		});

		expect(result).toEqual({ ok: false, reason: "connection_conflict" });
		expect(context.vault.values.get(record.credentialRef)).toBe(
			context.provider.exchangedMaterial,
		);
		expect(context.provider.revokeInputs).toContain(
			context.provider.refreshedMaterial,
		);
	});

	it("uses one atomic credential-and-connection commit for the initial exchange", async () => {
		// Given the production persistence adapter is available, when OAuth
		// completes, then the service must not expose a seal/create crash window.
		const context = await setup({ atomicInitialCommit: true });
		const callback = await beginAndCallback(context);
		const predeterminedId = `cloudflare_connection_${crypto.randomUUID()}`;

		const result = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			connectionId: predeterminedId,
			...callback,
		});

		expect(result).toMatchObject({
			ok: true,
			connection: { id: predeterminedId, status: "active" },
		});
		expect(context.atomicCommits).toEqual([
			expect.objectContaining({
				id: predeterminedId,
				userId: context.actor.id,
				accountId: context.provider.accountId,
				generation: 1,
			}),
		]);
		expect(context.vault.values).toHaveLength(1);
		expect(context.connections.records).toHaveLength(1);
	});

	it("prefers the recoverable initial-exchange coordinator over every legacy persistence path", async () => {
		const context = await setup({ recoverableInitialCommit: true });
		const callback = await beginAndCallback(context);
		const predeterminedId = `cloudflare_connection_${crypto.randomUUID()}`;

		const result = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			connectionId: predeterminedId,
			...callback,
		});

		expect(result).toMatchObject({
			ok: true,
			connection: { id: predeterminedId, status: "active" },
		});
		expect(context.atomicCommits).toEqual([
			expect.objectContaining({ id: predeterminedId }),
		]);
		expect(context.vault.values).toHaveLength(1);
		expect(context.connections.records).toHaveLength(1);
	});

	it("revokes provider material if initial connection persistence fails", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		context.connections.createSucceeds = false;

		const result = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});

		expect(result).toEqual({ ok: false, reason: "connection_conflict" });
		expect(context.provider.revokeInputs).toEqual([
			context.provider.exchangedMaterial,
		]);
		expect(context.vault.values.size).toBe(0);
	});

	it("retains failed cleanup material behind the vault for retry without exposing it", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		context.connections.createSucceeds = false;
		context.provider.revocationSucceeds = false;

		const result = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});

		expect(result).toEqual({ ok: false, reason: "connection_conflict" });
		expect(context.provider.revokeInputs).toEqual([
			context.provider.exchangedMaterial,
		]);
		expect(context.vault.values.size).toBe(1);
		expect(context.vault.cleanupRetries.size).toBe(1);
		expect(allKeys(result).has("credentialref")).toBe(false);
	});
});

async function establishConnection(
	context: Awaited<ReturnType<typeof setup>>,
) {
	const callback = await beginAndCallback(context);
	const completed = await context.service.complete({
		actor: context.actor,
		sessionId: context.sessionId,
		redirectUri: context.redirectUri,
		selectedAccountId: context.provider.accountId,
		...callback,
	});
	if (!completed.ok) throw new Error("setup_connection_failed");
	return completed.connection;
}

describe("Cloudflare OAuth staged credential state machine", () => {
	it("stages a new opaque vault reference, CASes connection metadata, then retires the prior generation", async () => {
		const context = await setup();
		const connection = await establishConnection(context);
		const before = context.connections.records.get(connection.id)!;
		const oldRef = before.credentialRef;
		context.timeline.length = 0;

		const result = await context.service.refresh({
			actor: context.actor,
			connectionId: connection.id,
		});
		const current = context.connections.records.get(connection.id)!;

		expect(result.ok).toBe(true);
		expect(current.credentialRef).not.toBe(oldRef);
		expect(current.generation).toBe(2);
		expect(current.expiresAt).toBe(30_000);
		expect(context.vault.values.get(current.credentialRef)).toBe(
			context.provider.refreshedMaterial,
		);
		expect(context.vault.values.has(oldRef)).toBe(false);
		expect(context.timeline).toEqual([
			"vault.stage",
			"connection.cas",
			"vault.retire",
		]);
	});

	it.each(["stage", "cas_false", "cas_throw"] as const)(
		"compensates a %s failure without splitting connection metadata from vault material",
		async (failure) => {
			const context = await setup();
			const connection = await establishConnection(context);
			const oldRecord = structuredClone(
				context.connections.records.get(connection.id)!,
			);
			const oldMaterial = context.vault.values.get(oldRecord.credentialRef);
			if (failure === "stage") context.vault.stageSucceeds = false;
			if (failure === "cas_false") context.connections.failNextRefresh = true;
			if (failure === "cas_throw") context.connections.refreshCasThrows = true;

			const result = context.service.refresh({
				actor: context.actor,
				connectionId: connection.id,
			});

			await expect(result).resolves.toMatchObject({ ok: false });
			expect(context.connections.records.get(connection.id)).toEqual(oldRecord);
			expect(context.vault.values.get(oldRecord.credentialRef)).toBe(oldMaterial);
			expect(context.vault.values.size).toBe(1);
			expect(context.provider.revokeInputs).toContain(
				context.provider.refreshedMaterial,
			);
			expect(context.timeline).toEqual(
				failure === "stage"
					? ["vault.stage"]
					: ["vault.stage", "connection.cas", "vault.retire"],
			);
			expect(context.connections.refreshReservations.size).toBe(0);
		},
	);

	it("keeps the new current generation coherent and retains the old reference for cleanup when retirement fails", async () => {
		const context = await setup();
		const connection = await establishConnection(context);
		const oldRef = context.connections.records.get(connection.id)!.credentialRef;
		context.vault.retireSucceeds = false;

		const result = await context.service.refresh({
			actor: context.actor,
			connectionId: connection.id,
		});
		const current = context.connections.records.get(connection.id)!;

		expect(result).toMatchObject({
			ok: false,
			reason: "credential_retirement_pending",
		});
		expect(current.credentialRef).not.toBe(oldRef);
		expect(context.vault.values.get(current.credentialRef)).toBe(
			context.provider.refreshedMaterial,
		);
		expect(context.vault.values.has(oldRef)).toBe(true);
		expect(context.vault.cleanupRetries.has(oldRef)).toBe(true);
	});

	it.each(["wrong_user", "wrong_session"] as const)(
		"does not burn valid callback state on %s",
		async (failure) => {
			const context = await setup();
			const callback = await beginAndCallback(context);
			const denied = await context.service.complete({
				actor:
					failure === "wrong_user"
						? { kind: "human" as const, id: runtimeId("user") }
						: context.actor,
				sessionId:
					failure === "wrong_session"
						? runtimeId("session")
						: context.sessionId,
				redirectUri: context.redirectUri,
				selectedAccountId: context.provider.accountId,
				...callback,
			});
			const valid = await context.service.complete({
				actor: context.actor,
				sessionId: context.sessionId,
				redirectUri: context.redirectUri,
				selectedAccountId: context.provider.accountId,
				...callback,
			});

			expect(denied).toEqual({ ok: false, reason: failure });
			expect(valid.ok).toBe(true);
		},
	);

	it.each(["state", "connection"] as const)(
		"treats %s expiration as expired at the exact boundary",
		async (boundary) => {
			const context = await setup();
			if (boundary === "state") {
				const callback = await beginAndCallback(context);
				context.advance(300);
				await expect(
					context.service.complete({
						actor: context.actor,
						sessionId: context.sessionId,
						redirectUri: context.redirectUri,
						selectedAccountId: context.provider.accountId,
						...callback,
					}),
				).resolves.toEqual({ ok: false, reason: "expired_state" });
				return;
			}

			const connection = await establishConnection(context);
			context.advance(10_000);
			await expect(
				context.service.authorizeManagement({
					actor: context.actor,
					connectionId: connection.id,
					accountId: context.provider.accountId,
				}),
			).resolves.toEqual({ ok: false, reason: "connection_expired" });
		},
	);

	it("uses current dot-delimited provider scopes and requests offline access for refresh-token clients", async () => {
		const context = await setup({
			allowedScopes: ["workers.scripts.write", "offline_access"],
			grantTypes: ["authorization_code", "refresh_token"],
		});
		context.provider.grantedScopes = [
			"workers.scripts.write",
			"offline_access",
		];
		const started = await context.service.begin({
			actor: context.actor,
			sessionId: context.sessionId,
			requestedScopes: ["workers.scripts.write"],
			expectedAccountId: context.provider.accountId,
		});
		const state = new URL(started.authorizationUrl).searchParams.get("state")!;
		const completed = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			state,
			authorizationCode: runtimeId("provider_artifact"),
		});

		expect(context.provider.authorizeRequests[0].scopes).toEqual([
			"offline_access",
			"workers.scripts.write",
		]);
		expect(completed).toMatchObject({
			ok: true,
			connection: {
				scopes: ["offline_access", "workers.scripts.write"],
			},
		});
	});

	it("retains locally revoked material for retry until provider revocation succeeds", async () => {
		const context = await setup();
		const connection = await establishConnection(context);
		const record = context.connections.records.get(connection.id)!;
		context.provider.revocationSucceeds = false;

		const revoked = await context.service.revoke({
			actor: context.actor,
			connectionId: connection.id,
		});

		expect(revoked).toMatchObject({
			ok: false,
			reason: "provider_revocation_failed",
			connection: { status: "revoked" },
		});
		expect(context.vault.values.has(record.credentialRef)).toBe(true);
		expect(context.vault.cleanupRetries.has(record.credentialRef)).toBe(true);
		await expect(
			context.service.authorizeManagement({
				actor: context.actor,
				connectionId: connection.id,
				accountId: context.provider.accountId,
			}),
		).resolves.toEqual({ ok: false, reason: "connection_revoked" });
		expect(allKeys(revoked).has("credentialref")).toBe(false);

		context.provider.revocationSucceeds = true;
		const retry = (
			context.service as unknown as {
				retryRevocationCleanup(input: {
					connectionId: string;
				}): Promise<Record<string, unknown>>;
			}
		).retryRevocationCleanup;
		await expect(retry({ connectionId: connection.id })).resolves.toEqual({
			ok: true,
			status: "cleaned",
		});
		expect(context.vault.values.has(record.credentialRef)).toBe(false);
	});

	it("allows verified expiry to finish retained revocation cleanup without provider success", async () => {
		const context = await setup();
		const connection = await establishConnection(context);
		const record = context.connections.records.get(connection.id)!;
		context.provider.revocationSucceeds = false;
		await context.service.revoke({
			actor: context.actor,
			connectionId: connection.id,
		});
		context.advance(10_000);
		const retry = (
			context.service as unknown as {
				retryRevocationCleanup(input: {
					connectionId: string;
				}): Promise<Record<string, unknown>>;
			}
		).retryRevocationCleanup;

		await expect(retry({ connectionId: connection.id })).resolves.toEqual({
			ok: true,
			status: "expired_cleanup_complete",
		});
		expect(context.vault.values.has(record.credentialRef)).toBe(false);
	});

	it("sanitizes vault cleanup throws and retains an opaque retry reference", async () => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		context.connections.createSucceeds = false;
		context.vault.withMaterialThrows = true;

		const result = context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});

		await expect(result).resolves.toEqual({
			ok: false,
			reason: "connection_cleanup_retry_required",
		});
		expect(context.vault.values.size).toBe(1);
		expect(context.vault.cleanupRetries.size).toBe(1);
		for (const forbidden of ["material", "credentialref", "authorizationcode"]) {
			expect(allKeys(context.audit).has(forbidden), forbidden).toBe(false);
		}
	});
});

describe("Cloudflare OAuth integration hardening", () => {
	it("uses the shared typed dot-delimited Cloudflare scope vocabulary", async () => {
		const context = await setup({
			allowedScopes: Object.values(scopeContract),
			grantTypes: ["authorization_code", "refresh_token"],
		});
		context.provider.grantedScopes = [
			scopeContract.workerScriptWrite,
			scopeContract.offlineAccess,
		];

		const started = await context.service.begin({
			actor: context.actor,
			sessionId: context.sessionId,
			requestedScopes: [scopeContract.workerScriptWrite],
		});

		expect(context.provider.authorizeRequests[0].scopes).toEqual([
			scopeContract.offlineAccess,
			scopeContract.workerScriptWrite,
		]);
		expect(
			context.provider.authorizeRequests[0].scopes.every(
				(scope) => scope === "offline_access" || scope.includes("."),
			),
		).toBe(true);
		expect(started.authorizationUrl).toContain("https://provider.invalid/");
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		9_999,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects an invalid provider exchange expiry before persistence: %s", async (expiresAt) => {
		const context = await setup();
		const callback = await beginAndCallback(context);
		context.provider.exchangeExpiresAt = expiresAt;

		const result = await context.service.complete({
			actor: context.actor,
			sessionId: context.sessionId,
			redirectUri: context.redirectUri,
			selectedAccountId: context.provider.accountId,
			...callback,
		});

		expect(result).toEqual({ ok: false, reason: "provider_expiry_invalid" });
		expect(context.connections.records.size).toBe(0);
		expect(context.vault.values.size).toBe(0);
		expect(context.provider.revokeInputs).toContain(
			context.provider.exchangedMaterial,
		);
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		9_999,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects an invalid refresh expiry before staging or CAS: %s", async (expiresAt) => {
		const context = await setup();
		const connection = await establishConnection(context);
		const before = structuredClone(
			context.connections.records.get(connection.id)!,
		);
		context.provider.refreshExpiresAt = expiresAt;

		const result = await context.service.refresh({
			actor: context.actor,
			connectionId: connection.id,
		});

		expect(result).toEqual({ ok: false, reason: "provider_expiry_invalid" });
		expect(context.connections.records.get(connection.id)).toEqual(before);
		expect(context.provider.revokeInputs).toContain(
			context.provider.refreshedMaterial,
		);
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects a corrupt persisted expiry before authorizing its use: %s", async (expiresAt) => {
		const context = await setup();
		const connection = await establishConnection(context);
		context.connections.records.get(connection.id)!.expiresAt = expiresAt;

		await expect(
			context.service.authorizeManagement({
				actor: context.actor,
				connectionId: connection.id,
				accountId: connection.accountId,
			}),
		).resolves.toEqual({
			ok: false,
			reason: "connection_expiry_invalid",
		});
	});

	it.each(["connected", "refreshed", "revoked"] as const)(
		"durably records the OAuth %s success event when the delivery sink fails",
		async (operation) => {
			const context = await setup();
			let connection: { id: string; accountId: string } | null = null;
			if (operation !== "connected") {
				connection = await establishConnection(context);
			}
			context.auditControl.throwFor = `cloudflare.oauth.${operation}`;

			const result =
				operation === "connected"
					? (async () => {
							const callback = await beginAndCallback(context);
							return context.service.complete({
								actor: context.actor,
								sessionId: context.sessionId,
								redirectUri: context.redirectUri,
								selectedAccountId: context.provider.accountId,
								...callback,
							});
						})()
					: operation === "refreshed"
						? context.service.refresh({
								actor: context.actor,
								connectionId: connection!.id,
							})
						: context.service.revoke({
								actor: context.actor,
								connectionId: connection!.id,
							});

			await expect(result).resolves.toMatchObject({ ok: true });
			expect(context.connections.auditOutbox).toContainEqual(
				expect.objectContaining({
					eventKind: `cloudflare.oauth.${operation}`,
					deliveryStatus: "pending",
				}),
			);
		},
	);
});
