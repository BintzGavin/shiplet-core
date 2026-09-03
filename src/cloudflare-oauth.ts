/**
 * Trusted-kernel Cloudflare OAuth orchestration.
 *
 * Credential material is intentionally generic and can only cross the provider
 * and vault callbacks. Browser/API-facing results contain public connection
 * metadata and never a vault reference or provider authorization artifact.
 */

export type CloudflareHumanActor = {
	kind: "human";
	id: string;
};

export const CLOUDFLARE_OAUTH_SCOPES = {
	workerScriptRead: "workers.scripts.read",
	workerScriptWrite: "workers.scripts.write",
	offlineAccess: "offline_access",
} as const;

const CONNECTION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export type CloudflareOAuthScope =
	(typeof CLOUDFLARE_OAUTH_SCOPES)[keyof typeof CLOUDFLARE_OAUTH_SCOPES];

export type CloudflareOAuthStateRecord = {
	id: string;
	userId: string;
	sessionId: string;
	redirectUri: string;
	expectedAccountId?: string;
	requestedScopes: string[];
	codeVerifier: string;
	expiresAt: number;
};

export type CloudflareConnectionRecord = {
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

export type PublicCloudflareConnection = Omit<
	CloudflareConnectionRecord,
	"credentialRef"
>;

export interface CloudflareOAuthStateStore {
	put(record: CloudflareOAuthStateRecord): Promise<void>;
	get(id: string): Promise<CloudflareOAuthStateRecord | null>;
	consume(id: string): Promise<CloudflareOAuthStateRecord | null>;
	consumeBound(input: {
		id: string;
		userId: string;
		sessionId: string;
		redirectUri: string;
	}): Promise<CloudflareOAuthStateRecord | null>;
}

export interface CloudflareCredentialVault<CredentialMaterial extends object> {
	seal(material: CredentialMaterial): Promise<string>;
	stage(material: CredentialMaterial): Promise<{ ref: string }>;
	retire(ref: string): Promise<void>;
	withMaterial<Result>(
		ref: string,
		operation: (material: CredentialMaterial) => Promise<Result>,
	): Promise<Result>;
	revoke(ref: string): Promise<void>;
	retainForCleanup(ref: string): Promise<void>;
}

export interface CloudflareConnectionStore {
	create(
		record: Omit<CloudflareConnectionRecord, "id" | "status"> & {
			id?: string;
			status?: "active";
		},
	): Promise<CloudflareConnectionRecord>;
	get(id: string): Promise<CloudflareConnectionRecord | null>;
	compareAndSwapCredential(input: {
		id: string;
		expectedCredentialRef: string;
		nextCredentialRef: string;
		expiresAt: number;
		refreshedAt: number;
		expectedGeneration: number;
		nextGeneration: number;
	}): Promise<boolean>;
	markRevoked(input: { id: string; revokedAt: number }): Promise<boolean>;
	reserveRefresh(input: {
		connectionId: string;
		idempotencyKey: string;
	}): Promise<
		| { ok: true; reservationId: string }
		| { ok: false; reason: "refresh_in_progress" }
	>;
	releaseRefresh(input: { connectionId: string }): Promise<void>;
	recordAuditEvent(event: Record<string, unknown>): Promise<string>;
	markAuditDelivered(input: { id: string }): Promise<boolean>;
}

export interface CloudflareOAuthProvider<CredentialMaterial extends object> {
	createAuthorizationUrl(input: {
		clientId: string;
		redirectUri: string;
		state: string;
		codeChallenge: string;
		codeChallengeMethod: "S256";
		scopes: string[];
	}): Promise<URL | string>;
	exchangeAuthorization(input: {
		authorizationCode: string;
		redirectUri: string;
		codeVerifier: string;
	}): Promise<{
		material: CredentialMaterial;
		accountId: string;
		accountLabel: string;
		scopes: string[];
		expiresAt: number;
	}>;
	refresh(material: CredentialMaterial): Promise<{
		material: CredentialMaterial;
		expiresAt: number;
	}>;
	revoke(material: CredentialMaterial): Promise<void>;
}

type OAuthAuditSink = (event: Record<string, unknown>) => Promise<void>;

type OAuthFailureReason =
	| "missing_state"
	| "invalid_state"
	| "reused_state"
	| "expired_state"
	| "wrong_session"
	| "wrong_user"
	| "wrong_redirect"
	| "wrong_account"
	| "pkce_verification_failed"
	| "provider_exchange_failed"
	| "provider_refresh_failed"
	| "provider_revocation_failed"
	| "connection_not_found"
	| "connection_revoked"
	| "connection_owner_mismatch"
	| "connection_account_mismatch"
	| "connection_binding_invalid"
	| "connection_conflict"
	| "vault_unavailable"
	| "scope_not_allowed"
	| "granted_scope_insufficient"
	| "granted_scope_escalation"
	| "connection_scope_insufficient"
	| "connection_expired"
	| "refresh_in_progress"
	| "credential_retirement_pending"
	| "connection_cleanup_retry_required"
	| "provider_expiry_invalid"
	| "connection_expiry_invalid";

type Failure = { ok: false; reason: OAuthFailureReason };

type CloudflareOAuthDependencies<CredentialMaterial extends object> = {
	clientId: string;
	redirectUri: string;
	stateTtlMs: number;
	allowedScopes: string[];
	grantTypes?: Array<"authorization_code" | "refresh_token">;
	stateSigningKey: CryptoKey;
	stateStore: CloudflareOAuthStateStore;
	vault: CloudflareCredentialVault<CredentialMaterial>;
	connections: CloudflareConnectionStore;
	commitConnection?: (input: {
		material: CredentialMaterial;
		connection: Omit<
			CloudflareConnectionRecord,
			"credentialRef" | "status" | "revokedAt"
		>;
	}) => Promise<CloudflareConnectionRecord>;
	recoverableCommitConnection?: (input: {
		material: CredentialMaterial;
		connection: Omit<
			CloudflareConnectionRecord,
			"credentialRef" | "status" | "revokedAt"
		>;
	}) => Promise<CloudflareConnectionRecord>;
	provider: CloudflareOAuthProvider<CredentialMaterial>;
	now: () => number;
	audit: OAuthAuditSink;
};

function normalizeScopes(scopes: string[]) {
	return [...new Set(scopes.map((scope) => scope.trim().toLowerCase()))]
		.filter(Boolean)
		.sort();
}

function includesEveryScope(granted: string[], required: string[]) {
	const grantedSet = new Set(normalizeScopes(granted));
	return normalizeScopes(required).every((scope) => grantedSet.has(scope));
}

function isSafeFutureTimestamp(value: number, now: number) {
	return Number.isSafeInteger(value) && value > now;
}

function encodeBase64Url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function decodeBase64Url(value: string) {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	const padded = value.replaceAll("-", "+").replaceAll("_", "/");
	const padding = "=".repeat((4 - (padded.length % 4)) % 4);
	try {
		const binary = atob(`${padded}${padding}`);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		return encodeBase64Url(bytes) === value ? bytes : null;
	} catch {
		return null;
	}
}

function randomBase64Url(byteLength: number) {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return encodeBase64Url(bytes);
}

async function pkceChallenge(verifier: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return encodeBase64Url(new Uint8Array(digest));
}

async function signState(id: string, key: CryptoKey) {
	const payload = encodeBase64Url(
		new TextEncoder().encode(JSON.stringify({ version: 1, id })),
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(payload),
	);
	return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifyState(value: string, key: CryptoKey) {
	const parts = value.split(".");
	if (parts.length !== 2) return null;
	const [payload, encodedSignature] = parts;
	const signature = decodeBase64Url(encodedSignature);
	const payloadBytes = decodeBase64Url(payload);
	if (!signature || !payloadBytes) return null;
	const valid = await crypto.subtle.verify(
		"HMAC",
		key,
		signature,
		new TextEncoder().encode(payload),
	);
	if (!valid) return null;
	try {
		const decoded = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
			version?: unknown;
			id?: unknown;
		};
		return decoded.version === 1 && typeof decoded.id === "string"
			? decoded.id
			: null;
	} catch {
		return null;
	}
}

function publicConnection(
	connection: CloudflareConnectionRecord,
): PublicCloudflareConnection {
	return {
		id: connection.id,
		userId: connection.userId,
		accountId: connection.accountId,
		accountLabel: connection.accountLabel,
		scopes: [...connection.scopes],
		expiresAt: connection.expiresAt,
		status: connection.status,
		...(connection.revokedAt === undefined
			? {}
			: { revokedAt: connection.revokedAt }),
	};
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : "";
}

export function createCloudflareOAuthService<CredentialMaterial extends object>(
	dependencies: CloudflareOAuthDependencies<CredentialMaterial>,
) {
	const auditDenial = async (
		action: string,
		actor: CloudflareHumanActor,
		reason: OAuthFailureReason,
	) => {
		try {
			await dependencies.audit({
				eventKind: `cloudflare.oauth.${action}`,
				actorKind: actor.kind,
				actorId: actor.id,
				outcome: "denied",
				reason,
				occurredAt: dependencies.now(),
			});
		} catch {
			// Authorization outcomes must remain fail-closed if audit delivery is down.
		}
	};

	const fail = async (
		action: string,
		actor: CloudflareHumanActor,
		reason: OAuthFailureReason,
	): Promise<Failure> => {
		await auditDenial(action, actor, reason);
		return { ok: false, reason };
	};

	const retainForCleanup = async (ref: string) => {
		try {
			await dependencies.vault.retainForCleanup(ref);
		} catch {
			// The opaque reference remains in the vault even when retry indexing fails.
		}
	};

	const revokeUnstoredMaterial = async (material: CredentialMaterial) => {
		try {
			await dependencies.provider.revoke(material);
			return;
		} catch {
			// If provider cleanup is unavailable, retain an opaque vault reference
			// so a trusted reconciler can retry without exposing the material.
		}
		try {
			const cleanupRef = await dependencies.vault.seal(material);
			await retainForCleanup(cleanupRef);
		} catch {
			// Neither provider cleanup nor durable retry storage is available.
		}
	};

	const publishSuccessAudit = async (event: Record<string, unknown>) => {
		let auditId: string;
		try {
			auditId = await dependencies.connections.recordAuditEvent(event);
		} catch {
			// State is already committed. A direct delivery remains useful even if
			// the durable outbox is temporarily unavailable.
			try {
				await dependencies.audit(event);
			} catch {
				// The committed state remains authoritative and is reconciled by store scans.
			}
			return;
		}
		try {
			await dependencies.audit({ ...event, auditEventId: auditId });
		} catch {
			// Leave the durable event pending for asynchronous reconciliation.
			return;
		}
		try {
			await dependencies.connections.markAuditDelivered({ id: auditId });
		} catch {
			// A pending record is safe: redelivery is idempotent by audit event ID.
		}
	};

	return {
		async begin(input: {
			actor: CloudflareHumanActor;
			sessionId: string;
			requestedScopes: string[];
			expectedAccountId?: string;
		}) {
			const explicitlyRequestedScopes = normalizeScopes(input.requestedScopes);
			const requestedScopes = normalizeScopes([
				...explicitlyRequestedScopes,
				...((dependencies.grantTypes ?? []).includes("refresh_token")
					? [CLOUDFLARE_OAUTH_SCOPES.offlineAccess]
					: []),
			]);
			const allowedScopes = new Set(normalizeScopes(dependencies.allowedScopes));
			if (
				explicitlyRequestedScopes.length !== input.requestedScopes.length ||
				requestedScopes.some((scope) => !allowedScopes.has(scope))
			) {
				return (await fail("begin", input.actor, "scope_not_allowed")) as never;
			}
			const id = crypto.randomUUID();
			const codeVerifier = randomBase64Url(32);
			const state = await signState(id, dependencies.stateSigningKey);
			await dependencies.stateStore.put({
				id,
				userId: input.actor.id,
				sessionId: input.sessionId,
				redirectUri: dependencies.redirectUri,
				...(input.expectedAccountId
					? { expectedAccountId: input.expectedAccountId }
					: {}),
				requestedScopes,
				codeVerifier,
				expiresAt: dependencies.now() + dependencies.stateTtlMs,
			});
			const authorizationUrl = await dependencies.provider.createAuthorizationUrl({
				clientId: dependencies.clientId,
				redirectUri: dependencies.redirectUri,
				state,
				codeChallenge: await pkceChallenge(codeVerifier),
				codeChallengeMethod: "S256",
				scopes: requestedScopes,
			});
			return { authorizationUrl: authorizationUrl.toString() };
		},

		async complete(input: {
			actor: CloudflareHumanActor;
			sessionId: string;
			redirectUri: string;
			selectedAccountId?: string;
			connectionId?: string;
			authorizationCode: string;
			state?: string;
		}) {
			if (
				input.connectionId !== undefined &&
				!CONNECTION_IDENTIFIER.test(input.connectionId)
			) {
				return fail("callback", input.actor, "connection_binding_invalid");
			}
			if (!input.state) return fail("callback", input.actor, "missing_state");
			const stateId = await verifyState(
				input.state,
				dependencies.stateSigningKey,
			);
			if (!stateId) return fail("callback", input.actor, "invalid_state");
			const candidate = await dependencies.stateStore.get(stateId);
			if (!candidate) return fail("callback", input.actor, "reused_state");
			if (candidate.sessionId !== input.sessionId) {
				return fail("callback", input.actor, "wrong_session");
			}
			if (candidate.userId !== input.actor.id) {
				return fail("callback", input.actor, "wrong_user");
			}
			if (dependencies.now() >= candidate.expiresAt) {
				await dependencies.stateStore.consumeBound({
					id: stateId,
					userId: input.actor.id,
					sessionId: input.sessionId,
					redirectUri: candidate.redirectUri,
				});
				return fail("callback", input.actor, "expired_state");
			}
			if (
				candidate.redirectUri !== dependencies.redirectUri ||
				input.redirectUri !== dependencies.redirectUri
			) {
				return fail("callback", input.actor, "wrong_redirect");
			}
			if (
				candidate.expectedAccountId &&
				input.selectedAccountId &&
				candidate.expectedAccountId !== input.selectedAccountId
			) {
				return fail("callback", input.actor, "wrong_account");
			}
			const state = await dependencies.stateStore.consumeBound({
				id: stateId,
				userId: input.actor.id,
				sessionId: input.sessionId,
				redirectUri: dependencies.redirectUri,
			});
			if (!state) return fail("callback", input.actor, "reused_state");
			let exchanged: Awaited<
				ReturnType<CloudflareOAuthProvider<CredentialMaterial>["exchangeAuthorization"]>
			>;
			try {
				exchanged = await dependencies.provider.exchangeAuthorization({
					authorizationCode: input.authorizationCode,
					redirectUri: dependencies.redirectUri,
					codeVerifier: state.codeVerifier,
				});
			} catch (error) {
				return fail(
					"callback",
					input.actor,
					errorMessage(error) === "pkce_verification_failed"
						? "pkce_verification_failed"
						: "provider_exchange_failed",
				);
			}
			if (!isSafeFutureTimestamp(exchanged.expiresAt, dependencies.now())) {
				await revokeUnstoredMaterial(exchanged.material);
				return fail("callback", input.actor, "provider_expiry_invalid");
			}
			if (
				(input.selectedAccountId !== undefined &&
					exchanged.accountId !== input.selectedAccountId) ||
				(state.expectedAccountId &&
					exchanged.accountId !== state.expectedAccountId)
			) {
				await revokeUnstoredMaterial(exchanged.material);
				return fail("callback", input.actor, "wrong_account");
			}
			const requestedScopes = normalizeScopes(state.requestedScopes);
			const grantedScopes = normalizeScopes(exchanged.scopes);
			if (!includesEveryScope(grantedScopes, requestedScopes)) {
				await revokeUnstoredMaterial(exchanged.material);
				return fail("callback", input.actor, "granted_scope_insufficient");
			}
			if (!includesEveryScope(requestedScopes, grantedScopes)) {
				await revokeUnstoredMaterial(exchanged.material);
				return fail("callback", input.actor, "granted_scope_escalation");
			}

			let connection: CloudflareConnectionRecord;
			if (dependencies.recoverableCommitConnection) {
				try {
					connection = await dependencies.recoverableCommitConnection({
						material: exchanged.material,
						connection: {
							id:
								input.connectionId ??
								`cloudflare_connection_${crypto.randomUUID()}`,
							userId: input.actor.id,
							accountId: exchanged.accountId,
							accountLabel: exchanged.accountLabel,
							scopes: grantedScopes,
							expiresAt: exchanged.expiresAt,
							generation: 1,
						},
					});
				} catch {
					// The recoverable committer encrypts and indexes provider material
					// before attachment. Scheduled cleanup owns every staged failure,
					// so an in-memory best-effort copy cannot weaken that boundary.
					return fail("callback", input.actor, "connection_conflict");
				}
			} else if (dependencies.commitConnection) {
				try {
					connection = await dependencies.commitConnection({
						material: exchanged.material,
						connection: {
							id:
								input.connectionId ??
								`cloudflare_connection_${crypto.randomUUID()}`,
							userId: input.actor.id,
							accountId: exchanged.accountId,
							accountLabel: exchanged.accountLabel,
							scopes: grantedScopes,
							expiresAt: exchanged.expiresAt,
							generation: 1,
						},
					});
				} catch {
					await revokeUnstoredMaterial(exchanged.material);
					return fail("callback", input.actor, "connection_conflict");
				}
			} else {
				let credentialRef: string;
				try {
					credentialRef = await dependencies.vault.seal(exchanged.material);
				} catch {
					try {
						await dependencies.provider.revoke(exchanged.material);
					} catch {
						// No durable vault reference exists; provider revocation is best effort.
					}
					return fail("callback", input.actor, "vault_unavailable");
				}
				try {
					connection = await dependencies.connections.create({
						...(input.connectionId ? { id: input.connectionId } : {}),
						userId: input.actor.id,
						accountId: exchanged.accountId,
						accountLabel: exchanged.accountLabel,
						scopes: grantedScopes,
						credentialRef,
						expiresAt: exchanged.expiresAt,
						generation: 1,
					});
				} catch {
					let providerRevoked: boolean;
					try {
						providerRevoked = await dependencies.vault.withMaterial(
							credentialRef,
							async (material) => {
								try {
									await dependencies.provider.revoke(material);
									return true;
								} catch {
									return false;
								}
							},
						);
					} catch {
						await retainForCleanup(credentialRef);
						return fail(
							"callback",
							input.actor,
							"connection_cleanup_retry_required",
						);
					}
					if (providerRevoked) {
						try {
							await dependencies.vault.revoke(credentialRef);
						} catch {
							await retainForCleanup(credentialRef);
							return fail(
								"callback",
								input.actor,
								"connection_cleanup_retry_required",
							);
						}
					} else {
						await retainForCleanup(credentialRef);
					}
					return fail("callback", input.actor, "connection_conflict");
				}
			}
			await publishSuccessAudit({
				eventKind: "cloudflare.oauth.connected",
				actorKind: input.actor.kind,
				actorId: input.actor.id,
				connectionId: connection.id,
				accountId: connection.accountId,
				outcome: "success",
				occurredAt: dependencies.now(),
			});
			return { ok: true as const, connection: publicConnection(connection) };
		},

		async refresh(input: {
			actor: CloudflareHumanActor;
			connectionId: string;
			idempotencyKey?: string;
		}) {
			const connection = await dependencies.connections.get(input.connectionId);
			if (!connection) return fail("refresh", input.actor, "connection_not_found");
			if (connection.userId !== input.actor.id) {
				return fail("refresh", input.actor, "connection_owner_mismatch");
			}
			if (connection.status !== "active") {
				return fail("refresh", input.actor, "connection_revoked");
			}
			const reservation = await dependencies.connections.reserveRefresh({
				connectionId: connection.id,
				idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
			});
			if (!reservation.ok) {
				return { ok: false as const, reason: reservation.reason };
			}
			try {
				let refreshResult:
					| {
							ok: true;
							value: { material: CredentialMaterial; expiresAt: number };
					  }
					| { ok: false };
				try {
					refreshResult = await dependencies.vault.withMaterial(
						connection.credentialRef,
						async (material) => {
							try {
								return {
									ok: true as const,
									value: await dependencies.provider.refresh(material),
								};
							} catch {
								return { ok: false as const };
							}
						},
					);
				} catch {
					return fail("refresh", input.actor, "provider_refresh_failed");
				}
				if (!refreshResult.ok) {
					return fail("refresh", input.actor, "provider_refresh_failed");
				}
				const refreshed = refreshResult.value;
				if (!isSafeFutureTimestamp(refreshed.expiresAt, dependencies.now())) {
					await revokeUnstoredMaterial(refreshed.material);
					return fail("refresh", input.actor, "provider_expiry_invalid");
				}
				const currentGeneration = connection.generation ?? 1;
				let stagedRef: string;
				try {
					stagedRef = (await dependencies.vault.stage(refreshed.material)).ref;
				} catch {
					let providerRevoked = false;
					try {
						await dependencies.provider.revoke(refreshed.material);
						providerRevoked = true;
					} catch {
						providerRevoked = false;
					}
					if (!providerRevoked) {
						try {
							const cleanupRef = await dependencies.vault.seal(
								refreshed.material,
							);
							await retainForCleanup(cleanupRef);
						} catch {
							// Both durable storage and provider cleanup are unavailable.
						}
					}
					return fail("refresh", input.actor, "vault_unavailable");
				}
				let updated = false;
				try {
					updated = await dependencies.connections.compareAndSwapCredential({
						id: connection.id,
						expectedCredentialRef: connection.credentialRef,
						nextCredentialRef: stagedRef,
						expiresAt: refreshed.expiresAt,
						refreshedAt: dependencies.now(),
						expectedGeneration: currentGeneration,
						nextGeneration: currentGeneration + 1,
					});
				} catch {
					updated = false;
				}
				if (!updated) {
					let providerRevoked = false;
					try {
						await dependencies.provider.revoke(refreshed.material);
						providerRevoked = true;
					} catch {
						await retainForCleanup(stagedRef);
					}
					if (providerRevoked) {
						try {
							await dependencies.vault.retire(stagedRef);
						} catch {
							await retainForCleanup(stagedRef);
						}
					}
					return fail("refresh", input.actor, "connection_conflict");
				}
				try {
					await dependencies.vault.retire(connection.credentialRef);
				} catch {
					await retainForCleanup(connection.credentialRef);
					return fail(
						"refresh",
						input.actor,
						"credential_retirement_pending",
					);
				}
				const current = await dependencies.connections.get(connection.id);
				if (!current) return fail("refresh", input.actor, "connection_conflict");
				await publishSuccessAudit({
					eventKind: "cloudflare.oauth.refreshed",
					actorKind: input.actor.kind,
					actorId: input.actor.id,
					connectionId: connection.id,
					outcome: "success",
					occurredAt: dependencies.now(),
				});
				return { ok: true as const, connection: publicConnection(current) };
				} finally {
					try {
						await dependencies.connections.releaseRefresh({
							connectionId: connection.id,
						});
					} catch {
						// The durable reservation expires/reconciles independently.
					}
			}
		},

		async revoke(input: {
			actor: CloudflareHumanActor;
			connectionId: string;
		}) {
			const connection = await dependencies.connections.get(input.connectionId);
			if (!connection) return fail("revoke", input.actor, "connection_not_found");
			if (connection.userId !== input.actor.id) {
				return fail("revoke", input.actor, "connection_owner_mismatch");
			}
			const locallyRevoked = await dependencies.connections.markRevoked({
				id: connection.id,
				revokedAt: dependencies.now(),
			});
			if (!locallyRevoked) {
				return fail("revoke", input.actor, "connection_conflict");
			}
			let providerSucceeded = false;
			try {
				providerSucceeded = await dependencies.vault.withMaterial(
					connection.credentialRef,
					async (material) => {
						try {
							await dependencies.provider.revoke(material);
							return true;
						} catch {
							return false;
						}
					},
				);
			} catch {
				providerSucceeded = false;
			}
			let vaultCleanupSucceeded = false;
			if (providerSucceeded) {
				try {
					await dependencies.vault.revoke(connection.credentialRef);
					vaultCleanupSucceeded = true;
				} catch {
					await retainForCleanup(connection.credentialRef);
				}
			} else {
				await retainForCleanup(connection.credentialRef);
			}
			const current = await dependencies.connections.get(connection.id);
			if (!current) return fail("revoke", input.actor, "connection_conflict");
			await publishSuccessAudit({
				eventKind: "cloudflare.oauth.revoked",
				actorKind: input.actor.kind,
				actorId: input.actor.id,
				connectionId: connection.id,
				outcome:
					providerSucceeded && vaultCleanupSucceeded
						? "success"
						: providerSucceeded
							? "vault_cleanup_failed_local_revoked"
							: "provider_failed_local_revoked",
				occurredAt: dependencies.now(),
			});
			return !providerSucceeded
				? {
						ok: false as const,
						reason: "provider_revocation_failed" as const,
						connection: publicConnection(current),
					}
				: !vaultCleanupSucceeded
					? {
							ok: false as const,
							reason: "vault_unavailable" as const,
							connection: publicConnection(current),
						}
					: { ok: true as const, connection: publicConnection(current) };
		},

		async retryRevocationCleanup(input: { connectionId: string }) {
			const connection = await dependencies.connections.get(input.connectionId);
			if (!connection || connection.status !== "revoked") {
				return { ok: false as const, reason: "connection_not_found" as const };
			}
			if (dependencies.now() >= connection.expiresAt) {
				try {
					await dependencies.vault.revoke(connection.credentialRef);
					return {
						ok: true as const,
						status: "expired_cleanup_complete" as const,
					};
				} catch {
					await retainForCleanup(connection.credentialRef);
					return {
						ok: false as const,
						reason: "connection_cleanup_retry_required" as const,
					};
				}
			}
			let providerSucceeded = false;
			try {
				providerSucceeded = await dependencies.vault.withMaterial(
					connection.credentialRef,
					async (material) => {
						try {
							await dependencies.provider.revoke(material);
							return true;
						} catch {
							return false;
						}
					},
				);
			} catch {
				providerSucceeded = false;
			}
			if (!providerSucceeded) {
				await retainForCleanup(connection.credentialRef);
				return {
					ok: false as const,
					reason: "provider_revocation_failed" as const,
				};
			}
			try {
				await dependencies.vault.revoke(connection.credentialRef);
				return { ok: true as const, status: "cleaned" as const };
			} catch {
				await retainForCleanup(connection.credentialRef);
				return {
					ok: false as const,
					reason: "connection_cleanup_retry_required" as const,
				};
			}
		},

		async authorizeManagement(input: {
			actor: CloudflareHumanActor;
			connectionId: string;
			accountId: string;
			operation?: string;
			requiredScopes?: string[];
		}) {
			const connection = await dependencies.connections.get(input.connectionId);
			if (!connection) {
				return { ok: false as const, reason: "connection_not_found" as const };
			}
			if (connection.status !== "active") {
				return { ok: false as const, reason: "connection_revoked" as const };
			}
			if (connection.userId !== input.actor.id) {
				return {
					ok: false as const,
					reason: "connection_owner_mismatch" as const,
				};
			}
			if (connection.accountId !== input.accountId) {
				return {
					ok: false as const,
					reason: "connection_account_mismatch" as const,
				};
			}
			if (!Number.isSafeInteger(connection.expiresAt)) {
				return {
					ok: false as const,
					reason: "connection_expiry_invalid" as const,
				};
			}
			if (dependencies.now() >= connection.expiresAt) {
				return { ok: false as const, reason: "connection_expired" as const };
			}
			if (!includesEveryScope(connection.scopes, input.requiredScopes ?? [])) {
				return {
					ok: false as const,
					reason: "connection_scope_insufficient" as const,
				};
			}
			return { ok: true as const };
		},
	};
}
