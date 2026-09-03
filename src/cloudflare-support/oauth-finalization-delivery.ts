import type { CloudflareConnectionRecord } from "../cloudflare-oauth";
import { createCloudflareCredentialCipher } from "./control-plane";

type OAuthFinalizationBinding = {
	db: D1Database;
	shipletId: string;
	userId: string;
	sessionBindingDigest: string;
	deliveryHandle: string;
	now: number;
};

type OAuthFinalizationDeliveryRow = {
	state_digest: string;
	shiplet_id: string;
	user_id: string;
	session_binding_digest: string;
	connection_id: string;
	status: "completed" | "consumed";
	delivery_expires_at: number;
	delivery_result_json: string;
};

const DELIVERY_HANDLE = /^[A-Za-z0-9_-]{43}$/;
const RETURN_KEY = /^[A-Za-z0-9_-]{22}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const DEFAULT_FLOW_QUOTA = Object.freeze({
	maxOutstanding: 3,
	maxStartsPerWindow: 8,
	windowMs: 10 * 60_000,
});

type OAuthFlowQuota = {
	maxOutstanding: number;
	maxStartsPerWindow: number;
	windowMs: number;
};

type OAuthStartReservationInput = {
	db: D1Database;
	shipletId: string;
	userId: string;
	sessionBindingDigest: string;
	expectedAccountId?: string;
	expiresAt: number;
	deliveryHandle: string;
	returnKey: string;
	supportVersionId: string;
	supportVersionTag: string;
	createdOn: string;
	quota?: OAuthFlowQuota;
};

type OAuthExchangeConnectionInput = {
	id: string;
	userId: string;
	accountId: string;
	accountLabel: string;
	scopes: string[];
	expiresAt: number;
	generation?: number;
};

export type StagedD1OAuthProviderExchange = {
	connection: CloudflareConnectionRecord;
};

export function createOAuthDeliveryReturnResponse(input: {
	appOrigin: string;
	shipletId: string;
	status: "connected";
	returnKey: string;
}) {
	let origin: URL;
	try {
		origin = new URL(input.appOrigin);
	} catch {
		throw new TypeError("oauth_delivery_return_invalid");
	}
	if (
		origin.protocol !== "https:" ||
		origin.origin !== input.appOrigin ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash ||
		origin.username ||
		origin.password ||
		!IDENTIFIER.test(input.shipletId) ||
		input.status !== "connected" ||
		!RETURN_KEY.test(input.returnKey)
	) {
		throw new TypeError("oauth_delivery_return_invalid");
	}
	const destination = new URL(
		"/api/cloudflare/oauth/return",
		origin.origin,
	);
	destination.searchParams.set("status", input.status);
	destination.searchParams.set("shipletId", input.shipletId);
	destination.searchParams.set("flow", input.returnKey);
	return new Response(null, {
		status: 303,
		headers: {
			location: destination.toString(),
			"cache-control": "no-store",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		},
	});
}

async function sha256(value: string) {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validQuota(quota: OAuthFlowQuota) {
	return (
		Number.isSafeInteger(quota.maxOutstanding) &&
		quota.maxOutstanding >= 1 &&
		quota.maxOutstanding <= 20 &&
		Number.isSafeInteger(quota.maxStartsPerWindow) &&
		quota.maxStartsPerWindow >= quota.maxOutstanding &&
		quota.maxStartsPerWindow <= 100 &&
		Number.isSafeInteger(quota.windowMs) &&
		quota.windowMs >= 60_000 &&
		quota.windowMs <= 3_600_000
	);
}

function normalizeExchangeConnection(
	connection: OAuthExchangeConnectionInput,
	now: number,
) {
	const scopes = [...new Set(connection.scopes.map((scope) => scope.trim()))]
		.filter(Boolean)
		.sort();
	const generation = connection.generation ?? 1;
	if (
		!IDENTIFIER.test(connection.id) ||
		!IDENTIFIER.test(connection.userId) ||
		!IDENTIFIER.test(connection.accountId) ||
		connection.accountLabel.trim().length === 0 ||
		connection.accountLabel.length > 512 ||
		scopes.length !== connection.scopes.length ||
		scopes.some((scope) => !IDENTIFIER.test(scope)) ||
		!Number.isSafeInteger(connection.expiresAt) ||
		connection.expiresAt <= now ||
		!Number.isSafeInteger(generation) ||
		generation < 1
	) {
		throw new TypeError("oauth_exchange_recovery_binding_invalid");
	}
	return { scopes, generation };
}

async function recoveryCredentialRef(connectionId: string) {
	const hex = await sha256(`shiplet:oauth-exchange-recovery:${connectionId}`);
	return `vault_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function oauthStartReservationId(deliveryHandleDigest: string) {
	const hex = await sha256(
		`shiplet:oauth-start-reservation:${deliveryHandleDigest}`,
	);
	return `oauth_start_${hex.slice(0, 48)}`;
}

export async function reserveD1OAuthStart(
	input: OAuthStartReservationInput,
) {
	const quota = input.quota ?? DEFAULT_FLOW_QUOTA;
	const createdAt = Date.parse(input.createdOn);
	if (
		!IDENTIFIER.test(input.shipletId) ||
		!IDENTIFIER.test(input.userId) ||
		!SHA256_HEX.test(input.sessionBindingDigest) ||
		(input.expectedAccountId !== undefined &&
			!IDENTIFIER.test(input.expectedAccountId)) ||
		!Number.isSafeInteger(input.expiresAt) ||
		!DELIVERY_HANDLE.test(input.deliveryHandle) ||
		!RETURN_KEY.test(input.returnKey) ||
		!IDENTIFIER.test(input.supportVersionId) ||
		!IDENTIFIER.test(input.supportVersionTag) ||
		Number.isNaN(createdAt) ||
		input.expiresAt <= createdAt ||
		!validQuota(quota)
	) {
		return { ok: false as const, reason: "oauth_flow_binding_invalid" };
	}
	const deliveryHandleDigest = await sha256(input.deliveryHandle);
	const reservationId = await oauthStartReservationId(deliveryHandleDigest);
	const windowStart = new Date(createdAt - quota.windowMs).toISOString();
	const inserted = await input.db
		.prepare(
			`INSERT OR IGNORE INTO oauth_start_reservations (
			 id, shiplet_id, user_id, session_binding_digest, expected_account_id,
			 delivery_handle_digest, return_key, support_version_id,
			 support_version_tag, expires_at, status, state_digest, created_on,
			 consumed_on, released_on
			)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, NULL, NULL
			WHERE (
			  (SELECT COUNT(*) FROM oauth_start_reservations
			   WHERE user_id = ? AND shiplet_id = ? AND status = 'reserved'
			     AND expires_at > ?)
			  +
			  (SELECT COUNT(*) FROM oauth_flows
			   WHERE user_id = ? AND shiplet_id = ? AND (
			     (status = 'pending' AND expires_at > ?)
			     OR (status = 'completed' AND delivery_expires_at > ?)
			   ))
			) < ?
			AND (
			  (SELECT COUNT(*) FROM oauth_start_reservations
			   WHERE user_id = ? AND shiplet_id = ? AND created_on >= ?)
			  +
			  (SELECT COUNT(*) FROM oauth_flows
			   WHERE user_id = ? AND shiplet_id = ? AND created_on >= ?
			     AND start_reservation_id IS NULL)
			) < ?`,
		)
		.bind(
			reservationId,
			input.shipletId,
			input.userId,
			input.sessionBindingDigest,
			input.expectedAccountId ?? null,
			deliveryHandleDigest,
			input.returnKey,
			input.supportVersionId,
			input.supportVersionTag,
			input.expiresAt,
			input.createdOn,
			input.userId,
			input.shipletId,
			createdAt,
			input.userId,
			input.shipletId,
			createdAt,
			createdAt,
			quota.maxOutstanding,
			input.userId,
			input.shipletId,
			windowStart,
			input.userId,
			input.shipletId,
			windowStart,
			quota.maxStartsPerWindow,
		)
		.run();
	if (inserted.meta.changes === 1) {
		return { ok: true as const, reservationId };
	}
	const conflict = await input.db
		.prepare(
			`SELECT 1 AS conflict FROM oauth_start_reservations
			 WHERE id = ? OR delivery_handle_digest = ? OR return_key = ? LIMIT 1`,
		)
		.bind(reservationId, deliveryHandleDigest, input.returnKey)
		.first<{ conflict: number }>();
	if (conflict?.conflict === 1) {
		return { ok: false as const, reason: "oauth_flow_reservation_conflict" };
	}
	const counts = await input.db
		.prepare(
			`SELECT
			 ((SELECT COUNT(*) FROM oauth_start_reservations
			   WHERE user_id = ? AND shiplet_id = ? AND status = 'reserved'
			     AND expires_at > ?)
			  +
			  (SELECT COUNT(*) FROM oauth_flows
			   WHERE user_id = ? AND shiplet_id = ? AND (
			     (status = 'pending' AND expires_at > ?)
			     OR (status = 'completed' AND delivery_expires_at > ?)
			   ))) AS outstanding,
			 ((SELECT COUNT(*) FROM oauth_start_reservations
			   WHERE user_id = ? AND shiplet_id = ? AND created_on >= ?)
			  +
			  (SELECT COUNT(*) FROM oauth_flows
			   WHERE user_id = ? AND shiplet_id = ? AND created_on >= ?
			     AND start_reservation_id IS NULL)) AS starts`,
		)
		.bind(
			input.userId,
			input.shipletId,
			createdAt,
			input.userId,
			input.shipletId,
			createdAt,
			createdAt,
			input.userId,
			input.shipletId,
			windowStart,
			input.userId,
			input.shipletId,
			windowStart,
		)
		.first<{ outstanding: number; starts: number }>();
	if ((counts?.starts ?? 0) >= quota.maxStartsPerWindow) {
		return { ok: false as const, reason: "oauth_flow_rate_limited" };
	}
	return { ok: false as const, reason: "oauth_flow_quota_exceeded" };
}

/** Reserves D1 quota before invoking any OAuth state creation work. */
export async function beginD1OAuthStateWithinQuota<T>(
	input: OAuthStartReservationInput & { begin(): Promise<T> },
) {
	const reserved = await reserveD1OAuthStart(input);
	if (!reserved.ok) return reserved;
	return {
		ok: true as const,
		reservationId: reserved.reservationId,
		started: await input.begin(),
	};
}

export async function releaseD1OAuthStartReservation(input: {
	db: D1Database;
	reservationId: string;
	releasedOn: string;
}) {
	if (
		!IDENTIFIER.test(input.reservationId) ||
		Number.isNaN(Date.parse(input.releasedOn))
	) {
		return { ok: false as const, reason: "oauth_flow_binding_invalid" };
	}
	const released = await input.db
		.prepare(
			`UPDATE oauth_start_reservations
			 SET status = 'released', released_on = ?
			 WHERE id = ? AND status = 'reserved'`,
		)
		.bind(input.releasedOn, input.reservationId)
		.run();
	return released.meta.changes === 1
		? { ok: true as const }
		: { ok: false as const, reason: "oauth_flow_reservation_conflict" };
}

/**
 * The first durable boundary after a provider exchange. Provider material is
 * encrypted before connection attachment and is indexed only by opaque
 * references so scheduled cleanup can close a process-loss gap.
 */
export async function stageD1OAuthProviderExchangeRecovery<
	CredentialMaterial extends object,
>(input: {
	db: D1Database;
	encodedKey: string;
	now(): number;
	material: CredentialMaterial;
	connection: OAuthExchangeConnectionInput;
}): Promise<StagedD1OAuthProviderExchange> {
	const now = input.now();
	const { scopes, generation } = normalizeExchangeConnection(
		input.connection,
		now,
	);
	const credentialRef = await recoveryCredentialRef(input.connection.id);
	const purpose = "oauth_credential";
	const cipher = createCloudflareCredentialCipher(input.encodedKey);
	const sealed = await cipher.seal({
		recordId: credentialRef,
		purpose,
		material: input.material,
	});
	const createdOn = new Date(now).toISOString();
	await input.db.batch([
		input.db
			.prepare(
				`INSERT INTO encrypted_records (
				 id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on
				) VALUES (?, ?, ?, ?, 'cleanup', NULL, ?, NULL)`,
			)
			.bind(
				credentialRef,
				purpose,
				sealed.nonce,
				sealed.ciphertext,
				createdOn,
			),
		input.db
			.prepare(
				`INSERT INTO oauth_provider_exchange_recoveries (
				 connection_id, user_id, account_id, account_label, scopes_json,
				 generation, credential_ref, credential_expires_at, status, created_on,
				 attached_on, provider_revoked_on, credential_retired_on, cleaned_on,
				 last_attempt_on, attempt_count
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, NULL, NULL, NULL, NULL, NULL, 0)`,
			)
			.bind(
				input.connection.id,
				input.connection.userId,
				input.connection.accountId,
				input.connection.accountLabel,
				JSON.stringify(scopes),
				generation,
				credentialRef,
				input.connection.expiresAt,
				createdOn,
			),
	]);
	return {
		connection: Object.freeze({
			id: input.connection.id,
			userId: input.connection.userId,
			accountId: input.connection.accountId,
			accountLabel: input.connection.accountLabel,
			scopes,
			credentialRef,
			expiresAt: input.connection.expiresAt,
			status: "active" as const,
			generation,
		}),
	};
}

function exactAttachedConnection(
	row: Record<string, unknown> | null,
	connection: CloudflareConnectionRecord,
) {
	return (
		row?.user_id === connection.userId &&
		row.account_id === connection.accountId &&
		row.account_label === connection.accountLabel &&
		row.scopes_json === JSON.stringify(connection.scopes) &&
		row.credential_ref === connection.credentialRef &&
		row.expires_at === connection.expiresAt &&
		row.status === "active" &&
		row.generation === (connection.generation ?? 1) &&
		row.recovery_status === "attached" &&
		row.credential_status === "active"
	);
}

/** Atomically promotes one staged recovery credential into its sole owner. */
export async function attachD1OAuthProviderExchangeRecovery(input: {
	db: D1Database;
	now(): number;
	staged: StagedD1OAuthProviderExchange;
}): Promise<CloudflareConnectionRecord> {
	const connection = input.staged.connection;
	const { scopes, generation } = normalizeExchangeConnection(
		connection,
		input.now(),
	);
	if (connection.credentialRef !== (await recoveryCredentialRef(connection.id))) {
		throw new TypeError("oauth_exchange_recovery_binding_invalid");
	}
	const attachedOn = new Date(input.now()).toISOString();
	try {
		const results = await input.db.batch([
			input.db
				.prepare(
					`INSERT INTO cloudflare_connections (
					 id, user_id, account_id, account_label, scopes_json,
					 credential_ref, expires_at, status, revoked_at, generation,
					 created_on, refreshed_at
					)
					SELECT ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL
					FROM oauth_provider_exchange_recoveries AS recovery
					WHERE recovery.connection_id = ? AND recovery.user_id = ?
					  AND recovery.account_id = ? AND recovery.account_label = ?
					  AND recovery.scopes_json = ? AND recovery.generation = ?
					  AND recovery.credential_ref = ?
					  AND recovery.credential_expires_at = ?
					  AND recovery.status = 'staged'`,
				)
				.bind(
					connection.id,
					connection.userId,
					connection.accountId,
					connection.accountLabel,
					JSON.stringify(scopes),
					connection.credentialRef,
					connection.expiresAt,
					generation,
					attachedOn,
					connection.id,
					connection.userId,
					connection.accountId,
					connection.accountLabel,
					JSON.stringify(scopes),
					generation,
					connection.credentialRef,
					connection.expiresAt,
				),
			input.db
				.prepare(
					`UPDATE encrypted_records
					 SET status = 'active', expires_at = ?
					 WHERE id = ? AND purpose = 'oauth_credential'
					   AND status = 'cleanup' AND expires_at IS NULL
					   AND EXISTS (
					     SELECT 1 FROM oauth_provider_exchange_recoveries
					     WHERE connection_id = ? AND user_id = ? AND account_id = ?
					       AND account_label = ? AND scopes_json = ? AND generation = ?
					       AND credential_ref = ? AND credential_expires_at = ?
					       AND status = 'staged'
					   )`,
				)
				.bind(
					connection.expiresAt,
					connection.credentialRef,
					connection.id,
					connection.userId,
					connection.accountId,
					connection.accountLabel,
					JSON.stringify(scopes),
					generation,
					connection.credentialRef,
					connection.expiresAt,
				),
			input.db
				.prepare(
					`UPDATE oauth_provider_exchange_recoveries
					 SET status = 'attached', attached_on = ?
					 WHERE connection_id = ? AND user_id = ? AND account_id = ?
					   AND account_label = ? AND scopes_json = ? AND generation = ?
					   AND credential_ref = ? AND credential_expires_at = ?
					   AND status = 'staged'`,
				)
				.bind(
					attachedOn,
					connection.id,
					connection.userId,
					connection.accountId,
					connection.accountLabel,
					JSON.stringify(scopes),
					generation,
					connection.credentialRef,
					connection.expiresAt,
				),
		]);
		if (results.some((result) => result.meta.changes !== 1)) {
			throw new Error("oauth_exchange_recovery_attach_conflict");
		}
		return connection;
	} catch (error) {
		const recovered = await input.db
			.prepare(
				`SELECT connection.user_id, connection.account_id,
				        connection.account_label, connection.scopes_json,
				        connection.credential_ref, connection.expires_at,
				        connection.status, connection.generation,
				        recovery.status AS recovery_status,
				        credential.status AS credential_status
				 FROM cloudflare_connections AS connection
				 JOIN oauth_provider_exchange_recoveries AS recovery
				   ON recovery.connection_id = connection.id
				 JOIN encrypted_records AS credential
				   ON credential.id = connection.credential_ref
				 WHERE connection.id = ?`,
			)
			.bind(connection.id)
			.first<Record<string, unknown>>();
		if (exactAttachedConnection(recovered, connection)) return connection;
		throw error;
	}
}

export function createD1RecoverableOAuthConnectionCommitter<
	CredentialMaterial extends object,
>(input: { db: D1Database; encodedKey: string; now(): number }) {
	return async (request: {
		material: CredentialMaterial;
		connection: OAuthExchangeConnectionInput;
	}) =>
		attachD1OAuthProviderExchangeRecovery({
			db: input.db,
			now: input.now,
			staged: await stageD1OAuthProviderExchangeRecovery({
				...input,
				material: request.material,
				connection: request.connection,
			}),
		});
}

export async function reconcileD1OAuthProviderExchangeRecoveries(input: {
	db: D1Database;
	now: number;
	limit: number;
	revokeCredentialRef(ref: string): Promise<void>;
	retireCredentialRef(ref: string): Promise<void>;
	audit(event: Record<string, unknown>): Promise<void>;
}) {
	if (
		!Number.isSafeInteger(input.now) ||
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 100
	) {
		throw new TypeError("oauth_exchange_recovery_reconciliation_invalid");
	}
	const result = await input.db
		.prepare(
			`SELECT connection_id, user_id, account_id, account_label, scopes_json,
			        generation, credential_ref, credential_expires_at, status,
			        provider_revoked_on, credential_retired_on
			 FROM oauth_provider_exchange_recoveries
			 WHERE status IN ('staged', 'cleaning')
			 ORDER BY created_on, connection_id LIMIT ?`,
		)
		.bind(input.limit)
		.all<{
			connection_id: string;
			user_id: string;
			account_id: string;
			account_label: string;
			scopes_json: string;
			generation: number;
			credential_ref: string;
			credential_expires_at: number;
			status: "staged" | "cleaning";
			provider_revoked_on: string | null;
			credential_retired_on: string | null;
		}>();
	let attached = 0;
	let cleaned = 0;
	let pending = 0;
	for (const row of result.results) {
		if (
			!IDENTIFIER.test(row.connection_id) ||
			!IDENTIFIER.test(row.user_id) ||
			!IDENTIFIER.test(row.account_id) ||
			row.account_label.trim().length === 0 ||
			row.account_label.length > 512 ||
			!Number.isSafeInteger(row.generation) ||
			row.generation < 1 ||
			!Number.isSafeInteger(row.credential_expires_at) ||
			!/^vault_[0-9a-f-]{36}$/i.test(row.credential_ref)
		) {
			pending += 1;
			continue;
		}
		const attemptedOn = new Date(input.now).toISOString();
		await input.db
			.prepare(
				`UPDATE oauth_provider_exchange_recoveries
				 SET attempt_count = attempt_count + 1, last_attempt_on = ?
				 WHERE connection_id = ? AND user_id = ? AND credential_ref = ?
				   AND status IN ('staged', 'cleaning')`,
			)
			.bind(
				attemptedOn,
				row.connection_id,
				row.user_id,
				row.credential_ref,
			)
			.run();
		const owner = await input.db
			.prepare(
				`SELECT 1 AS exact_owner FROM cloudflare_connections
				 WHERE id = ? AND user_id = ? AND account_id = ?
				   AND account_label = ? AND scopes_json = ? AND generation = ?
				   AND credential_ref = ? AND expires_at = ? AND status = 'active'`,
			)
			.bind(
				row.connection_id,
				row.user_id,
				row.account_id,
				row.account_label,
				row.scopes_json,
				row.generation,
				row.credential_ref,
				row.credential_expires_at,
			)
			.first<{ exact_owner: number }>();
		if (owner?.exact_owner === 1 && row.status === "staged") {
			const promoted = await input.db.batch([
				input.db
					.prepare(
						`UPDATE encrypted_records SET status = 'active'
						 WHERE id = ? AND purpose = 'oauth_credential'
						   AND status = 'cleanup'`,
					)
					.bind(row.credential_ref),
				input.db
					.prepare(
						`UPDATE oauth_provider_exchange_recoveries
						 SET status = 'attached', attached_on = ?
						 WHERE connection_id = ? AND user_id = ? AND credential_ref = ?
						   AND status = 'staged'`,
					)
					.bind(
						attemptedOn,
						row.connection_id,
						row.user_id,
						row.credential_ref,
					),
			]);
			if (promoted[1]?.meta.changes === 1) attached += 1;
			else pending += 1;
			continue;
		}
		if (owner?.exact_owner === 1) {
			// A cleanup claim must never revoke a connection. This state is not
			// reachable through the transactional attach path, so preserve it for
			// explicit reconciliation instead of guessing ownership.
			pending += 1;
			continue;
		}
		if (row.status === "staged") {
			const claimed = await input.db
				.prepare(
					`UPDATE oauth_provider_exchange_recoveries SET status = 'cleaning'
					 WHERE connection_id = ? AND user_id = ? AND credential_ref = ?
					   AND status = 'staged'`,
				)
				.bind(row.connection_id, row.user_id, row.credential_ref)
				.run();
			if (claimed.meta.changes !== 1) {
				pending += 1;
				continue;
			}
		}
		const credential = await input.db
			.prepare(
				`SELECT status FROM encrypted_records
				 WHERE id = ? AND purpose = 'oauth_credential'`,
			)
			.bind(row.credential_ref)
			.first<{ status: "active" | "cleanup" | "retired" }>();
		if (!credential) {
			pending += 1;
			continue;
		}
		if (!row.provider_revoked_on) {
			// Retired material cannot be reopened. A row in this shape predates the
			// durable provider checkpoint or was changed outside this coordinator,
			// so fail closed for explicit operator reconciliation.
			if (credential.status === "retired") {
				pending += 1;
				continue;
			}
			try {
				await input.audit({
					eventKind: "cloudflare.oauth.exchange_recovery.cleanup_started",
					actorKind: "shiplet",
					actorId: row.user_id,
					connectionId: row.connection_id,
					outcome: "attempted",
					occurredAt: input.now,
				});
				await input.revokeCredentialRef(row.credential_ref);
				const checkpoint = await input.db
					.prepare(
						`UPDATE oauth_provider_exchange_recoveries
						 SET provider_revoked_on = COALESCE(provider_revoked_on, ?)
						 WHERE connection_id = ? AND user_id = ? AND credential_ref = ?
						   AND status = 'cleaning'`,
					)
					.bind(
						attemptedOn,
						row.connection_id,
						row.user_id,
						row.credential_ref,
					)
					.run();
				if (checkpoint.meta.changes !== 1) {
					pending += 1;
					continue;
				}
			} catch {
				pending += 1;
				continue;
			}
		}
		if (credential.status !== "retired") {
			try {
				await input.retireCredentialRef(row.credential_ref);
			} catch {
				// The retirement write may have committed even when its response was
				// lost. The next pass detects `retired` without reopening material.
				pending += 1;
				continue;
			}
		}
		const retired = await input.db
			.prepare(
				`SELECT 1 AS retired FROM encrypted_records
				 WHERE id = ? AND purpose = 'oauth_credential' AND status = 'retired'`,
			)
			.bind(row.credential_ref)
			.first<{ retired: number }>();
		if (retired?.retired !== 1) {
			pending += 1;
			continue;
		}
		const marked = await input.db
			.prepare(
				`UPDATE oauth_provider_exchange_recoveries
				 SET status = 'cleaned',
				     credential_retired_on = COALESCE(credential_retired_on, ?),
				     cleaned_on = ?
				 WHERE connection_id = ? AND user_id = ? AND credential_ref = ?
				   AND status = 'cleaning'`,
			)
			.bind(
				attemptedOn,
				attemptedOn,
				row.connection_id,
				row.user_id,
				row.credential_ref,
			)
			.run();
		if (marked.meta.changes === 1) cleaned += 1;
		else pending += 1;
	}
	const remaining = input.limit - result.results.length;
	const unindexed =
		remaining > 0
			? await input.db
					.prepare(
						`SELECT credential.id
						 FROM encrypted_records AS credential
						 WHERE credential.purpose = 'oauth_credential'
						   AND credential.status = 'cleanup'
						   AND NOT EXISTS (
						     SELECT 1 FROM cloudflare_connections AS connection
						     WHERE connection.credential_ref = credential.id
						   )
						   AND NOT EXISTS (
						     SELECT 1 FROM oauth_provider_exchange_recoveries AS recovery
						     WHERE recovery.credential_ref = credential.id
						   )
						 ORDER BY credential.created_on, credential.id LIMIT ?`,
					)
					.bind(remaining)
					.all<{ id: string }>()
			: { results: [] as Array<{ id: string }> };
	for (const row of unindexed.results) {
		if (!/^vault_[0-9a-f-]{36}$/i.test(row.id)) {
			pending += 1;
			continue;
		}
		try {
			await input.audit({
				eventKind: "cloudflare.oauth.unowned_recovery.cleanup_started",
				actorKind: "shiplet",
				actorId: "shiplet-cloudflare-control-plane",
				outcome: "attempted",
				occurredAt: input.now,
			});
			await input.revokeCredentialRef(row.id);
			await input.retireCredentialRef(row.id);
			cleaned += 1;
		} catch {
			pending += 1;
		}
	}
	return {
		inspected: result.results.length + unindexed.results.length,
		attached,
		cleaned,
		pending,
	};
}

export async function reserveD1OAuthFinalizationFlow(input: {
	db: D1Database;
	startReservationId: string;
	stateDigest: string;
	now: number;
}) {
	if (
		!SHA256_HEX.test(input.stateDigest) ||
		!IDENTIFIER.test(input.startReservationId) ||
		!Number.isSafeInteger(input.now)
	) {
		return { ok: false as const, reason: "oauth_flow_binding_invalid" };
	}
	const connectionId = `cloudflare_connection_${input.stateDigest.slice(0, 48)}`;
	const consumedOn = new Date(input.now).toISOString();
	const results = await input.db.batch([
		input.db
			.prepare(
				`INSERT OR IGNORE INTO oauth_flows (
				 state_digest, shiplet_id, user_id, session_binding_digest,
				 expected_account_id, expires_at, status, connection_id,
				 delivery_handle_digest, support_version_id, support_version_tag,
				 return_key, created_on, completed_on, consumed_on,
				 start_reservation_id
				)
				SELECT ?, shiplet_id, user_id, session_binding_digest,
				       expected_account_id, expires_at, 'pending', ?,
				       delivery_handle_digest, support_version_id, support_version_tag,
				       return_key, created_on, NULL, NULL, id
				FROM oauth_start_reservations
				WHERE id = ? AND status = 'reserved' AND expires_at > ?`,
			)
			.bind(
				input.stateDigest,
				connectionId,
				input.startReservationId,
				input.now,
			),
		input.db
			.prepare(
				`UPDATE oauth_start_reservations
				 SET status = 'consumed', state_digest = ?, consumed_on = ?
				 WHERE id = ? AND status = 'reserved' AND expires_at > ?
				   AND EXISTS (
				     SELECT 1 FROM oauth_flows
				     WHERE start_reservation_id = ? AND state_digest = ?
				   )`,
			)
			.bind(
				input.stateDigest,
				consumedOn,
				input.startReservationId,
				input.now,
				input.startReservationId,
				input.stateDigest,
			),
	]);
	if (results.every((result) => result.meta.changes === 1)) {
		return { ok: true as const, connectionId };
	}
	const conflict = await input.db
		.prepare(
			`SELECT 1 AS conflict
			 FROM oauth_start_reservations AS reservation
			 LEFT JOIN oauth_flows AS flow
			   ON flow.state_digest = ?
			   OR flow.start_reservation_id = reservation.id
			   OR flow.delivery_handle_digest = reservation.delivery_handle_digest
			   OR flow.return_key = reservation.return_key
			 WHERE reservation.id = ?
			   AND (reservation.status != 'reserved' OR flow.state_digest IS NOT NULL)
			 LIMIT 1`,
		)
		.bind(input.stateDigest, input.startReservationId)
		.first<{ conflict: number }>();
	if (conflict?.conflict === 1) {
		return { ok: false as const, reason: "oauth_flow_reservation_conflict" };
	}
	return { ok: false as const, reason: "oauth_flow_reservation_conflict" };
}

export async function reserveD1OAuthProviderExchange(input: {
	db: D1Database;
	stateDigest: string;
	connectionId: string;
	now: number;
	startedOn: string;
}) {
	if (
		!SHA256_HEX.test(input.stateDigest) ||
		!IDENTIFIER.test(input.connectionId) ||
		!Number.isSafeInteger(input.now) ||
		Number.isNaN(Date.parse(input.startedOn))
	) {
		return { ok: false as const, reason: "oauth_exchange_binding_invalid" };
	}
	const claimed = await input.db
		.prepare(
			`UPDATE oauth_flows SET exchange_started_on = ?
			 WHERE state_digest = ? AND connection_id = ? AND status = 'pending'
			   AND expires_at > ? AND exchange_started_on IS NULL`,
		)
		.bind(
			input.startedOn,
			input.stateDigest,
			input.connectionId,
			input.now,
		)
		.run();
	if (claimed.meta.changes === 1) {
		return {
			ok: true as const,
			claimed: true as const,
			connectionId: input.connectionId,
		};
	}
	const existing = await input.db
		.prepare(
			`SELECT connection_id FROM oauth_flows
			 WHERE state_digest = ? AND connection_id = ? AND status = 'pending'
			   AND expires_at > ? AND exchange_started_on IS NOT NULL`,
		)
		.bind(input.stateDigest, input.connectionId, input.now)
		.first<{ connection_id: string }>();
	return existing?.connection_id === input.connectionId
		? {
				ok: true as const,
				claimed: false as const,
				connectionId: input.connectionId,
			}
		: { ok: false as const, reason: "oauth_exchange_reservation_conflict" };
}

export async function markD1OAuthProviderExchangeCommitted(input: {
	db: D1Database;
	stateDigest: string;
	connectionId: string;
	committedOn: string;
}) {
	if (
		!SHA256_HEX.test(input.stateDigest) ||
		!IDENTIFIER.test(input.connectionId) ||
		Number.isNaN(Date.parse(input.committedOn))
	) {
		return { ok: false as const, reason: "oauth_exchange_binding_invalid" };
	}
	const result = await input.db
		.prepare(
			`UPDATE oauth_flows
			 SET exchange_committed_on = COALESCE(exchange_committed_on, ?)
			 WHERE state_digest = ? AND connection_id = ? AND status = 'pending'
			   AND exchange_started_on IS NOT NULL`,
		)
		.bind(input.committedOn, input.stateDigest, input.connectionId)
		.run();
	return result.meta.changes === 1
		? { ok: true as const }
		: { ok: false as const, reason: "oauth_exchange_commit_conflict" };
}

function validBinding(input: Omit<OAuthFinalizationBinding, "db">) {
	return (
		DELIVERY_HANDLE.test(input.deliveryHandle) &&
		input.shipletId.length > 0 &&
		input.userId.length > 0 &&
		input.sessionBindingDigest.length > 0 &&
		Number.isSafeInteger(input.now)
	);
}

export async function prepareD1OAuthFinalizationDelivery(input: {
	db: D1Database;
	stateDigest: string;
	shipletId: string;
	userId: string;
	sessionBindingDigest: string;
	connectionId: string;
	deliveryResultJson: string;
	completedOn: string;
	deliveryExpiresAt: number;
}) {
	if (
		!IDENTIFIER.test(input.shipletId) ||
		!IDENTIFIER.test(input.userId) ||
		input.sessionBindingDigest.length === 0 ||
		!Number.isSafeInteger(input.deliveryExpiresAt) ||
		input.stateDigest.length === 0 ||
		!IDENTIFIER.test(input.connectionId) ||
		input.deliveryResultJson.length === 0 ||
		input.deliveryResultJson.length > 16_384 ||
		Number.isNaN(Date.parse(input.completedOn))
	) {
		return { ok: false as const, reason: "oauth_delivery_binding_invalid" };
	}

	const result = await input.db
		.prepare(
			`UPDATE oauth_flows
			 SET status = 'completed', completed_on = ?, delivery_expires_at = ?,
			     delivery_result_json = ?
			 WHERE state_digest = ? AND shiplet_id = ? AND user_id = ?
			   AND session_binding_digest = ? AND connection_id = ?
			   AND delivery_handle_digest IS NOT NULL AND status = 'pending'`,
		)
		.bind(
			input.completedOn,
			input.deliveryExpiresAt,
			input.deliveryResultJson,
			input.stateDigest,
			input.shipletId,
			input.userId,
			input.sessionBindingDigest,
			input.connectionId,
		)
		.run();
	return result.meta.changes === 1
		? { ok: true as const }
		: { ok: false as const, reason: "oauth_delivery_prepare_conflict" };
}

export async function readD1OAuthFinalizationDelivery(
	input: OAuthFinalizationBinding,
) {
	if (!validBinding(input)) return null;
	const row = await input.db
		.prepare(
			`SELECT state_digest, shiplet_id, user_id, session_binding_digest,
			        connection_id, status, delivery_expires_at, delivery_result_json
			 FROM oauth_flows
			 WHERE delivery_handle_digest = ? AND shiplet_id = ? AND user_id = ?
			   AND session_binding_digest = ? AND status IN ('completed', 'consumed')
			   AND delivery_expires_at > ? AND connection_id IS NOT NULL`,
		)
		.bind(
			await sha256(input.deliveryHandle),
			input.shipletId,
			input.userId,
			input.sessionBindingDigest,
			input.now,
		)
		.first<OAuthFinalizationDeliveryRow>();
	if (!row) return null;
	return {
		stateDigest: row.state_digest,
		shipletId: row.shiplet_id,
		userId: row.user_id,
		connectionId: row.connection_id,
		deliveryExpiresAt: row.delivery_expires_at,
		acknowledged: row.status === "consumed",
		deliveryResultJson: row.delivery_result_json,
	};
}

export async function acknowledgeD1OAuthFinalizationDelivery(
	input: OAuthFinalizationBinding & {
		connectionId: string;
		acknowledgedOn: string;
	},
) {
	if (
		!validBinding(input) ||
		input.connectionId.length === 0 ||
		Number.isNaN(Date.parse(input.acknowledgedOn))
	) {
		return { ok: false as const, reason: "oauth_delivery_ack_binding_invalid" };
	}
	const deliveryDigest = await sha256(input.deliveryHandle);
	const updated = await input.db
		.prepare(
			`UPDATE oauth_flows SET status = 'consumed', consumed_on = ?
			 WHERE delivery_handle_digest = ? AND shiplet_id = ? AND user_id = ?
			   AND session_binding_digest = ? AND connection_id = ?
			   AND status = 'completed' AND delivery_expires_at > ?`,
		)
		.bind(
			input.acknowledgedOn,
			deliveryDigest,
			input.shipletId,
			input.userId,
			input.sessionBindingDigest,
			input.connectionId,
			input.now,
		)
		.run();
	if (updated.meta.changes === 1) return { ok: true as const };

	const acknowledged = await input.db
		.prepare(
			`SELECT 1 AS acknowledged FROM oauth_flows
			 WHERE delivery_handle_digest = ? AND shiplet_id = ? AND user_id = ?
			   AND session_binding_digest = ? AND connection_id = ?
			   AND status = 'consumed'`,
		)
		.bind(
			deliveryDigest,
			input.shipletId,
			input.userId,
			input.sessionBindingDigest,
			input.connectionId,
		)
		.first<{ acknowledged: number }>();
	return acknowledged?.acknowledged === 1
		? { ok: true as const }
		: { ok: false as const, reason: "oauth_delivery_ack_conflict" };
}

export async function reconcileD1ExpiredOAuthFinalizationDeliveries(input: {
	db: D1Database;
	now: number;
	limit: number;
	revoke(binding: {
		actor: { kind: "human"; id: string };
		connectionId: string;
	}): Promise<{ ok: boolean }>;
}) {
	if (
		!Number.isSafeInteger(input.now) ||
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 100
	) {
		throw new TypeError("oauth_delivery_reconciliation_invalid");
	}
	const result = await input.db
		.prepare(
			`SELECT state_digest, user_id, connection_id
			 FROM oauth_flows
			 WHERE status = 'completed' AND delivery_expires_at <= ?
			   AND connection_id IS NOT NULL
			 ORDER BY delivery_expires_at ASC LIMIT ?`,
		)
		.bind(input.now, input.limit)
		.all<{
			state_digest: string;
			user_id: string;
			connection_id: string;
		}>();
	const rows = result.results ?? [];
	let revoked = 0;
	for (const row of rows) {
		let result: { ok: boolean };
		try {
			result = await input.revoke({
				actor: { kind: "human", id: row.user_id },
				connectionId: row.connection_id,
			});
		} catch {
			continue;
		}
		if (!result.ok) continue;
		const updated = await input.db
			.prepare(
				`UPDATE oauth_flows SET status = 'denied', consumed_on = ?
				 WHERE state_digest = ? AND connection_id = ?
				   AND status = 'completed' AND delivery_expires_at <= ?`,
			)
			.bind(
				new Date(input.now).toISOString(),
				row.state_digest,
				row.connection_id,
				input.now,
			)
			.run();
		if (updated.meta.changes === 1) revoked += 1;
	}
	return { inspected: rows.length, revoked };
}

export async function reconcileD1ExpiredPendingOAuthConnections(input: {
	db: D1Database;
	now: number;
	limit: number;
	loadConnection(
		connectionId: string,
	): Promise<{ status: "active" | "revoked" } | null>;
	revoke(binding: {
		actor: { kind: "human"; id: string };
		connectionId: string;
	}): Promise<{ ok: boolean }>;
}) {
	if (
		!Number.isSafeInteger(input.now) ||
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 100
	) {
		throw new TypeError("oauth_pending_reconciliation_invalid");
	}
	const result = await input.db
		.prepare(
			`SELECT state_digest, user_id, connection_id
			 FROM oauth_flows
			 WHERE status = 'pending' AND expires_at <= ?
			   AND connection_id IS NOT NULL
			 ORDER BY expires_at ASC LIMIT ?`,
		)
		.bind(input.now, input.limit)
		.all<{
			state_digest: string;
			user_id: string;
			connection_id: string;
		}>();
	const rows = result.results ?? [];
	let revoked = 0;
	let denied = 0;
	for (const row of rows) {
		let connection: { status: "active" | "revoked" } | null;
		try {
			connection = await input.loadConnection(row.connection_id);
		} catch {
			continue;
		}
		if (connection?.status === "active") {
			let result: { ok: boolean };
			try {
				result = await input.revoke({
					actor: { kind: "human", id: row.user_id },
					connectionId: row.connection_id,
				});
			} catch {
				continue;
			}
			if (!result.ok) continue;
			revoked += 1;
		}
		const updated = await input.db
			.prepare(
				`UPDATE oauth_flows SET status = 'denied', completed_on = ?,
				 exchange_ambiguity_on = CASE
				   WHEN exchange_started_on IS NOT NULL
				    AND exchange_committed_on IS NULL
				   THEN COALESCE(exchange_ambiguity_on, ?)
				   ELSE exchange_ambiguity_on END
				 WHERE state_digest = ? AND connection_id = ?
				   AND status = 'pending' AND expires_at <= ?`,
			)
			.bind(
				new Date(input.now).toISOString(),
				new Date(input.now).toISOString(),
				row.state_digest,
				row.connection_id,
				input.now,
			)
			.run();
		if (updated.meta.changes === 1) denied += 1;
	}
	return { inspected: rows.length, revoked, denied };
}

/**
 * Removes only terminal OAuth coordination data in bounded batches. Consumed
 * ACK rows remain while their exact connection is active so a delayed kernel
 * replay can never turn an already acknowledged grant into a revocation.
 */
export async function reconcileD1OAuthRetention(input: {
	db: D1Database;
	now: number;
	limit: number;
	retentionMs: number;
	retireStateRef(ref: string): Promise<void>;
}) {
	if (
		!Number.isSafeInteger(input.now) ||
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 100 ||
		!Number.isSafeInteger(input.retentionMs) ||
		input.retentionMs < 86_400_000 ||
		input.retentionMs > 90 * 86_400_000
	) {
		throw new TypeError("oauth_retention_reconciliation_invalid");
	}
	const cutoff = input.now - input.retentionMs;
	const cutoffOn = new Date(cutoff).toISOString();
	const stateRows = await input.db
		.prepare(
			`SELECT id, secret_ref
			 FROM cloudflare_oauth_state_refs
			 WHERE (consumed_on IS NOT NULL OR expires_at <= ?)
			   AND COALESCE(consumed_on, created_on) <= ?
			 ORDER BY COALESCE(consumed_on, created_on), id LIMIT ?`,
		)
		.bind(cutoff, cutoffOn, input.limit)
		.all<{ id: string; secret_ref: string | null }>();
	let stateRefsPurged = 0;
	for (const row of stateRows.results) {
		if (row.secret_ref) {
			const credential = await input.db
				.prepare(
					`SELECT status FROM encrypted_records
					 WHERE id = ? AND purpose = 'oauth_state'`,
				)
				.bind(row.secret_ref)
				.first<{ status: "active" | "cleanup" | "retired" }>();
			if (credential?.status === "active" || credential?.status === "cleanup") {
				try {
					await input.retireStateRef(row.secret_ref);
				} catch {
					continue;
				}
			}
			const retired = await input.db
				.prepare(
					`SELECT 1 AS retired FROM encrypted_records
					 WHERE id = ? AND purpose = 'oauth_state' AND status = 'retired'`,
				)
				.bind(row.secret_ref)
				.first<{ retired: number }>();
			if (credential && retired?.retired !== 1) continue;
			await input.db
				.prepare(
					`UPDATE cloudflare_oauth_state_refs SET secret_ref = NULL
					 WHERE id = ? AND secret_ref = ?`,
				)
				.bind(row.id, row.secret_ref)
				.run();
		}
		const removed = await input.db
			.prepare(
				`DELETE FROM cloudflare_oauth_state_refs
				 WHERE id = ? AND secret_ref IS NULL
				   AND (consumed_on IS NOT NULL OR expires_at <= ?)`,
			)
			.bind(row.id, cutoff)
			.run();
		if (removed.meta.changes === 1) stateRefsPurged += 1;
	}

	const flowDelete = await input.db
		.prepare(
			`DELETE FROM oauth_flows WHERE state_digest IN (
			 SELECT flow.state_digest FROM oauth_flows AS flow
			 WHERE COALESCE(flow.consumed_on, flow.completed_on, flow.created_on) <= ?
			   AND (
			     flow.status = 'denied'
			     OR (flow.status = 'consumed' AND NOT EXISTS (
			       SELECT 1 FROM cloudflare_connections AS connection
			       WHERE connection.id = flow.connection_id
			         AND connection.status = 'active'
			     ))
			   )
			 ORDER BY COALESCE(flow.consumed_on, flow.completed_on, flow.created_on),
			          flow.state_digest
			 LIMIT ?
			)`,
		)
		.bind(cutoffOn, input.limit)
		.run();

	const startReservationDelete = await input.db
		.prepare(
			`DELETE FROM oauth_start_reservations WHERE id IN (
			 SELECT reservation.id FROM oauth_start_reservations AS reservation
			 WHERE (
			   (reservation.status = 'reserved' AND reservation.expires_at <= ?)
			   OR (reservation.status = 'consumed' AND reservation.consumed_on <= ?)
			   OR (reservation.status = 'released' AND reservation.released_on <= ?)
			 )
			 AND NOT EXISTS (
			   SELECT 1 FROM oauth_flows AS flow
			   WHERE flow.start_reservation_id = reservation.id
			 )
			 ORDER BY COALESCE(
			   reservation.consumed_on,
			   reservation.released_on,
			   reservation.created_on
			 ), reservation.id
			 LIMIT ?
			)`,
		)
		.bind(cutoff, cutoffOn, cutoffOn, input.limit)
		.run();

	const recoveryDelete = await input.db
		.prepare(
			`DELETE FROM oauth_provider_exchange_recoveries WHERE connection_id IN (
			 SELECT connection_id FROM oauth_provider_exchange_recoveries
			 WHERE status IN ('attached', 'cleaned')
			   AND COALESCE(cleaned_on, attached_on, created_on) <= ?
			 ORDER BY COALESCE(cleaned_on, attached_on, created_on), connection_id
			 LIMIT ?
			)`,
		)
		.bind(cutoffOn, input.limit)
		.run();

	const ciphertextDelete = await input.db
		.prepare(
			`DELETE FROM encrypted_records WHERE id IN (
			 SELECT credential.id FROM encrypted_records AS credential
			 WHERE credential.status = 'retired'
			   AND credential.purpose IN ('oauth_state', 'oauth_credential')
			   AND credential.retired_on <= ?
			   AND NOT EXISTS (
			     SELECT 1 FROM cloudflare_connections AS connection
			     WHERE connection.credential_ref = credential.id
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM cloudflare_oauth_state_refs AS state
			     WHERE state.secret_ref = credential.id
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM oauth_provider_exchange_recoveries AS recovery
			     WHERE recovery.credential_ref = credential.id
			   )
			 ORDER BY credential.retired_on, credential.id LIMIT ?
			)`,
		)
		.bind(cutoffOn, input.limit)
		.run();

	return {
		flowsPurged: flowDelete.meta.changes,
		startReservationsPurged: startReservationDelete.meta.changes,
		stateRefsPurged,
		recoveriesPurged: recoveryDelete.meta.changes,
		ciphertextsPurged: ciphertextDelete.meta.changes,
	};
}
