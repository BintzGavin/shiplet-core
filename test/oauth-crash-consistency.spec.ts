import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileCloudflareOAuthAcknowledgements } from "../src/cloudflare-oauth-ack-outbox";
import {
	acknowledgeD1OAuthFinalizationDelivery,
	attachD1OAuthProviderExchangeRecovery,
	beginD1OAuthStateWithinQuota,
	prepareD1OAuthFinalizationDelivery,
	reconcileD1OAuthProviderExchangeRecoveries,
	reconcileD1OAuthRetention,
	reserveD1OAuthFinalizationFlow,
	stageD1OAuthProviderExchangeRecovery,
} from "../src/cloudflare-support/oauth-finalization-delivery";
// @ts-expect-error Vite's raw loader supplies the additive migration text.
import oauthCrashConsistencyMigration from "../workers/cloudflare-control-plane/migrations/0006_oauth_crash_consistency.sql?raw";

/**
 * Behavioral specification
 *
 * - Given provider material has been returned, when a process stops or the
 *   connection commit fails, then an encrypted, opaque recovery record remains
 *   available to trusted scheduled cleanup.
 * - Given provider revocation succeeded and ciphertext retirement committed,
 *   when execution stops before the recovery row is marked cleaned, then the
 *   next scheduled pass detects the durable checkpoints and finishes cleanup
 *   without reopening retired material or revoking a newly attached owner.
 * - Given support committed an exact ACK but its response was lost, when the
 *   kernel retries after delivery expiry, then the ACK remains authoritative
 *   and the live connection is not revoked.
 * - Given one actor repeatedly starts OAuth for one Shiplet, when outstanding
 *   or window quotas are exhausted, then quota authority is reserved before
 *   any state sealing or persistence callback runs, crash-abandoned starts stay
 *   bounded, and sibling scopes remain independent; terminal recovery data is
 *   purged in bounded batches without deleting live connection authority or
 *   audit history.
 */

const testEnv = env as { DB: D1Database };
const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const SESSION_DIGEST = "d".repeat(64);

function testCipherKey() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

async function digest(value: string) {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(value),
			),
		),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}

function migrationStatements(source: string) {
	const statements: string[] = [];
	let current: string[] = [];
	let trigger = false;
	for (const line of source.split(/\r?\n/)) {
		if (!current.length && !line.trim()) continue;
		current.push(line);
		if (/^CREATE TRIGGER\b/i.test(line.trim())) trigger = true;
		if (
			(!trigger && line.trim().endsWith(";")) ||
			(trigger && line.trim().toUpperCase() === "END;")
		) {
			statements.push(current.join("\n"));
			current = [];
			trigger = false;
		}
	}
	if (current.some((line) => line.trim())) throw new Error("migration_incomplete");
	return statements;
}

async function createSchema() {
	await testEnv.DB.batch([
		testEnv.DB.prepare("DROP TABLE IF EXISTS cloudflare_oauth_ack_outbox"),
		testEnv.DB.prepare("DROP TABLE IF EXISTS oauth_provider_exchange_recoveries"),
		testEnv.DB.prepare("DROP TABLE IF EXISTS cloudflare_oauth_state_refs"),
		testEnv.DB.prepare("DROP TABLE IF EXISTS oauth_flows"),
		testEnv.DB.prepare("DROP TABLE IF EXISTS oauth_start_reservations"),
		testEnv.DB.prepare("DROP TABLE IF EXISTS cloudflare_connections"),
		testEnv.DB.prepare("DROP TABLE IF EXISTS encrypted_records"),
		testEnv.DB.prepare("DROP TABLE IF EXISTS deployment_targets"),
		testEnv.DB.prepare("DROP TABLE IF EXISTS shiplet_audit_events"),
		testEnv.DB.prepare(`CREATE TABLE encrypted_records (
			id TEXT PRIMARY KEY,
			purpose TEXT NOT NULL,
			nonce TEXT NOT NULL,
			ciphertext TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'cleanup')),
			expires_at INTEGER,
			created_on TEXT NOT NULL,
			retired_on TEXT
		)`),
		testEnv.DB.prepare(`CREATE TABLE cloudflare_connections (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			account_label TEXT NOT NULL,
			scopes_json TEXT NOT NULL,
			credential_ref TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
			revoked_at INTEGER,
			generation INTEGER NOT NULL,
			created_on TEXT NOT NULL,
			refreshed_at INTEGER,
			UNIQUE (user_id, account_id),
			FOREIGN KEY (credential_ref) REFERENCES encrypted_records(id)
		)`),
		testEnv.DB.prepare(`CREATE TABLE oauth_provider_exchange_recoveries (
			connection_id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			account_label TEXT NOT NULL,
			scopes_json TEXT NOT NULL,
			generation INTEGER NOT NULL,
			credential_ref TEXT NOT NULL UNIQUE,
			credential_expires_at INTEGER NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('staged', 'cleaning', 'attached', 'cleaned')),
			created_on TEXT NOT NULL,
			attached_on TEXT,
			provider_revoked_on TEXT,
			credential_retired_on TEXT,
			cleaned_on TEXT,
			last_attempt_on TEXT,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (credential_ref) REFERENCES encrypted_records(id)
		)`),
		testEnv.DB.prepare(`CREATE TABLE oauth_start_reservations (
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
		testEnv.DB.prepare(`CREATE TABLE oauth_flows (
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
			exchange_ambiguity_on TEXT,
			return_key TEXT,
			start_reservation_id TEXT UNIQUE
		)`),
		testEnv.DB.prepare(`CREATE UNIQUE INDEX idx_test_oauth_delivery
			ON oauth_flows(delivery_handle_digest)
			WHERE delivery_handle_digest IS NOT NULL`),
		testEnv.DB.prepare(`CREATE UNIQUE INDEX idx_test_oauth_return
			ON oauth_flows(return_key) WHERE return_key IS NOT NULL`),
		testEnv.DB.prepare(`CREATE TABLE cloudflare_oauth_state_refs (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			session_binding_digest TEXT NOT NULL,
			redirect_uri_digest TEXT NOT NULL,
			secret_ref TEXT,
			expires_at INTEGER NOT NULL,
			created_on TEXT NOT NULL,
			consumed_on TEXT
		)`),
		testEnv.DB.prepare(`CREATE TABLE cloudflare_oauth_ack_outbox (
			connection_id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			shiplet_id TEXT NOT NULL,
			delivery_handle TEXT NOT NULL,
			session_binding TEXT NOT NULL,
			delivery_expires_at INTEGER NOT NULL,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			created_on TEXT NOT NULL,
			last_attempt_on TEXT
		)`),
		testEnv.DB.prepare(`CREATE TABLE deployment_targets (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			connection_id TEXT,
			detached_on TEXT
		)`),
		testEnv.DB.prepare(`CREATE TABLE shiplet_audit_events (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			revision_id TEXT,
			deployment_id TEXT,
			actor_kind TEXT NOT NULL,
			actor_id TEXT NOT NULL,
			event_kind TEXT NOT NULL,
			summary TEXT NOT NULL,
			status_category TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			occurred_on TEXT NOT NULL,
			recorded_on TEXT NOT NULL
		)`),
	]);
}

function connection(suffix: string) {
	return {
		id: `connection_${suffix}`,
		userId: `user_${suffix}`,
		accountId: `account_${suffix}`,
		accountLabel: `Account ${suffix}`,
		scopes: ["workers.scripts.read", "workers.scripts.write"],
		expiresAt: NOW + 86_400_000,
		generation: 1,
	};
}

async function reserve(input: {
	state: string;
	shiplet?: string;
	user?: string;
	handle: string;
	returnKey: string;
	createdOn?: number;
	quota?: {
		maxOutstanding: number;
		maxStartsPerWindow: number;
		windowMs: number;
	};
}) {
	const createdOn = input.createdOn ?? NOW;
	const started = await beginD1OAuthStateWithinQuota({
		db: testEnv.DB,
		shipletId: input.shiplet ?? "shiplet_quota",
		userId: input.user ?? "user_quota",
		sessionBindingDigest: SESSION_DIGEST,
		expiresAt: createdOn + 60_000,
		deliveryHandle: input.handle.repeat(43),
		returnKey: input.returnKey.repeat(22),
		supportVersionId: "11111111-1111-4111-8111-111111111111",
		supportVersionTag: "shiplet-oauth-test",
		createdOn: new Date(createdOn).toISOString(),
		...(input.quota ? { quota: input.quota } : {}),
		begin: async () => ({ authorizationUrl: "https://dash.cloudflare.com/oauth" }),
	});
	if (!started.ok) return started;
	return reserveD1OAuthFinalizationFlow({
		db: testEnv.DB,
		startReservationId: started.reservationId,
		stateDigest: input.state.repeat(64),
		now: createdOn,
	});
}

describe("OAuth crash consistency and bounded recovery", () => {
	beforeEach(createSchema);

	it("applies the additive recovery migration and makes recovery identity immutable", async () => {
		await testEnv.DB.batch([
			testEnv.DB.prepare("DROP TABLE oauth_provider_exchange_recoveries"),
			testEnv.DB.prepare("DROP TABLE oauth_flows"),
			testEnv.DB.prepare("DROP TABLE oauth_start_reservations"),
			testEnv.DB.prepare(`CREATE TABLE oauth_flows (
				state_digest TEXT PRIMARY KEY,
				shiplet_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				session_binding_digest TEXT NOT NULL,
				expected_account_id TEXT,
				expires_at INTEGER NOT NULL,
				status TEXT NOT NULL,
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
				exchange_ambiguity_on TEXT,
				return_key TEXT
			)`),
		]);
		for (const statement of migrationStatements(oauthCrashConsistencyMigration)) {
			await testEnv.DB.prepare(statement).run();
		}
		expect(
			await testEnv.DB.prepare(
				"SELECT name FROM pragma_table_info('oauth_flows') WHERE name = 'start_reservation_id'",
			).first(),
		).toEqual({ name: "start_reservation_id" });
		expect(
			await testEnv.DB.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_start_reservations'",
			).first(),
		).toEqual({ name: "oauth_start_reservations" });
		await testEnv.DB.prepare(
			`INSERT INTO encrypted_records
			 (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
			 VALUES ('vault_migration', 'oauth_credential', 'n', 'c', 'cleanup', NULL, ?, NULL)`,
		)
			.bind(new Date(NOW).toISOString())
			.run();
		await testEnv.DB.prepare(
			`INSERT INTO oauth_provider_exchange_recoveries
			 (connection_id, user_id, account_id, account_label, scopes_json,
			  generation, credential_ref, credential_expires_at, status, created_on,
			  attached_on, provider_revoked_on, credential_retired_on, cleaned_on,
			  last_attempt_on, attempt_count)
			 VALUES ('connection_migration', 'user_migration', 'account_migration',
			 'Migration', '[]', 1, 'vault_migration', ?, 'staged', ?, NULL, NULL,
			 NULL, NULL, NULL, 0)`,
		)
			.bind(NOW + 60_000, new Date(NOW).toISOString())
			.run();
		await expect(
			testEnv.DB.prepare(
				`UPDATE oauth_provider_exchange_recoveries SET user_id = 'user_sibling'
				 WHERE connection_id = 'connection_migration'`,
			).run(),
		).rejects.toThrow(/OAuth exchange recovery binding is immutable/);
	});

	it("durably stages returned provider material before attachment and cleans a process-loss orphan", async () => {
		// Given provider material has returned, when the process stops after the
		// durable stage and before connection attachment, then the scheduled
		// reconciler can revoke it by opaque reference and retire the ciphertext.
		const staged = await stageD1OAuthProviderExchangeRecovery({
			db: testEnv.DB,
			encodedKey: testCipherKey(),
			now: () => NOW,
			material: Object.freeze({ fixtureKind: "opaque-provider-material" }),
			connection: connection("process_loss"),
		});
		expect(staged.connection.credentialRef).toMatch(/^vault_/);
		expect(
			await testEnv.DB.prepare(
				`SELECT status FROM oauth_provider_exchange_recoveries
				 WHERE connection_id = ?`,
			)
				.bind(staged.connection.id)
				.first(),
		).toEqual({ status: "staged" });
		expect(
			await testEnv.DB.prepare(
				"SELECT id FROM cloudflare_connections WHERE id = ?",
			)
				.bind(staged.connection.id)
				.first(),
		).toBeNull();

		const revokeCredentialRef = vi.fn(async (_ref: string) => undefined);
		const audit = vi.fn(async () => undefined);
		const retireCredentialRef = vi.fn(async (ref: string) => {
			await testEnv.DB.prepare(
				`UPDATE encrypted_records SET status = 'retired', retired_on = ?
				 WHERE id = ? AND status = 'cleanup'`,
			)
				.bind(new Date(NOW + 1).toISOString(), ref)
				.run();
		});
		await expect(
			reconcileD1OAuthProviderExchangeRecoveries({
				db: testEnv.DB,
				now: NOW + 1,
				limit: 25,
				revokeCredentialRef,
				retireCredentialRef,
				audit,
			}),
		).resolves.toEqual({ inspected: 1, attached: 0, cleaned: 1, pending: 0 });
		expect(revokeCredentialRef).toHaveBeenCalledOnce();
		expect(revokeCredentialRef).toHaveBeenCalledWith(
			staged.connection.credentialRef,
		);
		expect(audit).toHaveBeenCalledOnce();
		expect(
			await testEnv.DB.prepare(
				`SELECT recovery.status, credential.status AS credential_status
				 FROM oauth_provider_exchange_recoveries AS recovery
				 JOIN encrypted_records AS credential ON credential.id = recovery.credential_ref
				 WHERE recovery.connection_id = ?`,
			)
				.bind(staged.connection.id)
				.first(),
		).toEqual({ status: "cleaned", credential_status: "retired" });
	});

	it("resumes cleanup after ciphertext retirement commits but its response is lost", async () => {
		// Given cleanup has exclusive ownership of a staged exchange, when the
		// provider revoke and encrypted-record retirement commit but execution
		// stops before `cleaned`, then a retry must finish from durable state.
		const staged = await stageD1OAuthProviderExchangeRecovery({
			db: testEnv.DB,
			encodedKey: testCipherKey(),
			now: () => NOW,
			material: Object.freeze({ fixtureKind: "retirement-response-loss" }),
			connection: connection("retirement_response_loss"),
		});
		const revokeCredentialRef = vi.fn(async (ref: string) => {
			const credential = await testEnv.DB.prepare(
				"SELECT status FROM encrypted_records WHERE id = ?",
			)
				.bind(ref)
				.first<{ status: string }>();
			if (credential?.status === "retired") {
				throw new Error("retired_material_cannot_be_reopened");
			}
		});
		let loseRetirementResponse = true;
		const retireCredentialRef = vi.fn(async (ref: string) => {
			await testEnv.DB.prepare(
				`UPDATE encrypted_records SET status = 'retired', retired_on = ?
				 WHERE id = ? AND status = 'cleanup'`,
			)
				.bind(new Date(NOW + 1).toISOString(), ref)
				.run();
			if (loseRetirementResponse) {
				loseRetirementResponse = false;
				throw new Error("retirement_response_lost");
			}
		});
		const audit = vi.fn(async () => undefined);

		await expect(
			reconcileD1OAuthProviderExchangeRecoveries({
				db: testEnv.DB,
				now: NOW + 1,
				limit: 25,
				revokeCredentialRef,
				retireCredentialRef,
				audit,
			}),
		).resolves.toEqual({ inspected: 1, attached: 0, cleaned: 0, pending: 1 });

		await expect(
			reconcileD1OAuthProviderExchangeRecoveries({
				db: testEnv.DB,
				now: NOW + 2,
				limit: 25,
				revokeCredentialRef,
				retireCredentialRef,
				audit,
			}),
		).resolves.toEqual({ inspected: 1, attached: 0, cleaned: 1, pending: 0 });
		expect(revokeCredentialRef).toHaveBeenCalledOnce();
		expect(retireCredentialRef).toHaveBeenCalledOnce();
		expect(
			await testEnv.DB.prepare(
				`SELECT recovery.status, credential.status AS credential_status
				 FROM oauth_provider_exchange_recoveries AS recovery
				 JOIN encrypted_records AS credential
				   ON credential.id = recovery.credential_ref
				 WHERE recovery.connection_id = ?`,
			)
				.bind(staged.connection.id)
				.first(),
		).toEqual({ status: "cleaned", credential_status: "retired" });
	});

	it("atomically assigns a staged exchange to attachment or cleanup so cleanup cannot revoke a newly active connection", async () => {
		const staged = await stageD1OAuthProviderExchangeRecovery({
			db: testEnv.DB,
			encodedKey: testCipherKey(),
			now: () => NOW,
			material: Object.freeze({ fixtureKind: "cleanup-attachment-race" }),
			connection: connection("cleanup_race"),
		});
		let attachRejected = false;
		const revokeCredentialRef = vi.fn(async () => undefined);
		const retireCredentialRef = vi.fn(async (ref: string) => {
			await testEnv.DB.prepare(
				`UPDATE encrypted_records SET status = 'retired', retired_on = ?
				 WHERE id = ? AND status = 'cleanup'`,
			)
				.bind(new Date(NOW + 1).toISOString(), ref)
				.run();
		});

		await expect(
			reconcileD1OAuthProviderExchangeRecoveries({
				db: testEnv.DB,
				now: NOW + 1,
				limit: 25,
				revokeCredentialRef,
				retireCredentialRef,
				audit: async () => {
					try {
						await attachD1OAuthProviderExchangeRecovery({
							db: testEnv.DB,
							now: () => NOW + 1,
							staged,
						});
					} catch {
						attachRejected = true;
					}
				},
			}),
		).resolves.toEqual({ inspected: 1, attached: 0, cleaned: 1, pending: 0 });
		expect(attachRejected).toBe(true);
		expect(revokeCredentialRef).toHaveBeenCalledOnce();
		expect(
			await testEnv.DB.prepare(
				"SELECT id FROM cloudflare_connections WHERE id = ?",
			)
				.bind(staged.connection.id)
				.first(),
		).toBeNull();
	});

	it("reconciles an unowned cleanup ciphertext left by rejected provider output", async () => {
		await testEnv.DB.prepare(
			`INSERT INTO encrypted_records
			 (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
			 VALUES ('vault_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			 'oauth_credential', 'n', 'c', 'cleanup', NULL, ?, NULL)`,
		)
			.bind(new Date(NOW).toISOString())
			.run();
		const revokeCredentialRef = vi.fn(async () => undefined);
		const retireCredentialRef = vi.fn(async (ref: string) => {
			await testEnv.DB.prepare(
				`UPDATE encrypted_records SET status = 'retired', retired_on = ?
				 WHERE id = ? AND status = 'cleanup'`,
			)
				.bind(new Date(NOW + 1).toISOString(), ref)
				.run();
		});
		const audit = vi.fn(async () => undefined);

		await expect(
			reconcileD1OAuthProviderExchangeRecoveries({
				db: testEnv.DB,
				now: NOW + 1,
				limit: 25,
				revokeCredentialRef,
				retireCredentialRef,
				audit,
			}),
		).resolves.toEqual({ inspected: 1, attached: 0, cleaned: 1, pending: 0 });
		expect(revokeCredentialRef).toHaveBeenCalledOnce();
		expect(audit).toHaveBeenCalledOnce();
	});

	it("keeps a connection conflict durably recoverable and attaches an exact staged exchange atomically", async () => {
		const key = testCipherKey();
		const attachedStage = await stageD1OAuthProviderExchangeRecovery({
			db: testEnv.DB,
			encodedKey: key,
			now: () => NOW,
			material: Object.freeze({ fixtureKind: "attachable-material" }),
			connection: connection("attach"),
		});
		await expect(
			attachD1OAuthProviderExchangeRecovery({
				db: testEnv.DB,
				now: () => NOW,
				staged: attachedStage,
			}),
		).resolves.toMatchObject({ id: "connection_attach", status: "active" });

		await testEnv.DB.prepare(
			`INSERT INTO encrypted_records
			 (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
			 VALUES ('vault_conflict_owner', 'oauth_credential', 'n', 'c', 'active', ?, ?, NULL)`,
		)
			.bind(NOW + 86_400_000, new Date(NOW).toISOString())
			.run();
		await testEnv.DB.prepare(
			`INSERT INTO cloudflare_connections
			 (id, user_id, account_id, account_label, scopes_json, credential_ref,
			  expires_at, status, revoked_at, generation, created_on, refreshed_at)
			 VALUES ('connection_conflict_owner', 'user_conflict', 'account_conflict',
			 'Existing', '[]', 'vault_conflict_owner', ?, 'active', NULL, 1, ?, NULL)`,
		)
			.bind(NOW + 86_400_000, new Date(NOW).toISOString())
			.run();
		const conflict = connection("conflict");
		conflict.userId = "user_conflict";
		conflict.accountId = "account_conflict";
		const conflictStage = await stageD1OAuthProviderExchangeRecovery({
			db: testEnv.DB,
			encodedKey: key,
			now: () => NOW,
			material: Object.freeze({ fixtureKind: "conflicting-material" }),
			connection: conflict,
		});
		await expect(
			attachD1OAuthProviderExchangeRecovery({
				db: testEnv.DB,
				now: () => NOW,
				staged: conflictStage,
			}),
		).rejects.toThrow();
		expect(
			await testEnv.DB.prepare(
				`SELECT status FROM oauth_provider_exchange_recoveries
				 WHERE connection_id = ?`,
			)
				.bind(conflict.id)
				.first(),
		).toEqual({ status: "staged" });
	});

	it("rejects a staged recovery rebound to different public connection metadata", async () => {
		const staged = await stageD1OAuthProviderExchangeRecovery({
			db: testEnv.DB,
			encodedKey: testCipherKey(),
			now: () => NOW,
			material: Object.freeze({ fixtureKind: "binding-material" }),
			connection: connection("binding"),
		});
		const rebound = {
			connection: {
				...staged.connection,
				accountId: "account_sibling",
			},
		};

		await expect(
			attachD1OAuthProviderExchangeRecovery({
				db: testEnv.DB,
				now: () => NOW,
				staged: rebound,
			}),
		).rejects.toThrow();
		expect(
			await testEnv.DB.prepare(
				"SELECT id FROM cloudflare_connections WHERE id = ?",
			)
				.bind(staged.connection.id)
				.first(),
		).toBeNull();
	});

	it("treats an exact consumed ACK as authoritative after expiry instead of revoking", async () => {
		const deliveryHandle = "A".repeat(43);
		const shipletId = "shiplet_ack_response_loss";
		const userId = "user_ack_response_loss";
		const sessionBinding = "f".repeat(64);
		const stateDigest = "a".repeat(64);
		const connectionId = `cloudflare_connection_${stateDigest.slice(0, 48)}`;
		await reserve({
			state: "a",
			shiplet: shipletId,
			user: userId,
			handle: "A",
			returnKey: "A",
		});
		await prepareD1OAuthFinalizationDelivery({
			db: testEnv.DB,
			stateDigest,
			shipletId,
			userId,
			sessionBindingDigest: SESSION_DIGEST,
			connectionId,
			deliveryResultJson: JSON.stringify({ id: connectionId }),
			completedOn: new Date(NOW).toISOString(),
			deliveryExpiresAt: NOW + 1_000,
		});
		await acknowledgeD1OAuthFinalizationDelivery({
			db: testEnv.DB,
			shipletId,
			userId,
			sessionBindingDigest: SESSION_DIGEST,
			deliveryHandle,
			connectionId,
			now: NOW + 500,
			acknowledgedOn: new Date(NOW + 500).toISOString(),
		});
		await testEnv.DB.prepare(
			`INSERT INTO encrypted_records
			 (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
			 VALUES ('vault_ack', 'oauth_credential', 'n', 'c', 'active', ?, ?, NULL)`,
		)
			.bind(NOW + 86_400_000, new Date(NOW).toISOString())
			.run();
		await testEnv.DB.prepare(
			`INSERT INTO cloudflare_connections
			 (id, user_id, account_id, account_label, scopes_json, credential_ref,
			  expires_at, status, revoked_at, generation, created_on, refreshed_at)
			 VALUES (?, ?, 'account_ack', 'ACK', '[]', 'vault_ack', ?, 'active', NULL, 1, ?, NULL)`,
		)
			.bind(connectionId, userId, NOW + 86_400_000, new Date(NOW).toISOString())
			.run();
		await testEnv.DB.prepare(
			`INSERT INTO cloudflare_oauth_ack_outbox
			 (connection_id, project_id, user_id, shiplet_id, delivery_handle,
			  session_binding, delivery_expires_at, attempt_count, created_on, last_attempt_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`,
		)
			.bind(
				connectionId,
				shipletId,
				userId,
				shipletId,
				deliveryHandle,
				sessionBinding,
				NOW + 1_000,
				new Date(NOW).toISOString(),
			)
			.run();
		const revoke = vi.fn(async () => ({ ok: true as const }));

		await expect(
			reconcileCloudflareOAuthAcknowledgements({
				db: testEnv.DB,
				now: NOW + 2_000,
				limit: 25,
				controlForUser: () => ({
					acknowledge: async () =>
						acknowledgeD1OAuthFinalizationDelivery({
							db: testEnv.DB,
							shipletId,
							userId,
							sessionBindingDigest: SESSION_DIGEST,
							deliveryHandle,
							connectionId,
							now: NOW + 2_000,
							acknowledgedOn: new Date(NOW + 2_000).toISOString(),
						}),
					revoke,
				}),
			}),
		).resolves.toEqual({ acknowledged: 1, revoked: 0, pending: 0 });
		expect(revoke).not.toHaveBeenCalled();
		expect(
			await testEnv.DB.prepare(
				"SELECT connection_id FROM cloudflare_oauth_ack_outbox WHERE connection_id = ?",
			)
				.bind(connectionId)
				.first(),
		).toBeNull();
	});

	it("enforces outstanding and rate quotas per user and Shiplet scope", async () => {
		const quota = {
			maxOutstanding: 1,
			maxStartsPerWindow: 2,
			windowMs: 60_000,
		};
		await expect(
			reserve({ state: "1", handle: "B", returnKey: "B", quota }),
		).resolves.toMatchObject({ ok: true });
		await expect(
			reserve({ state: "2", handle: "C", returnKey: "C", quota }),
		).resolves.toEqual({ ok: false, reason: "oauth_flow_quota_exceeded" });
		await expect(
			reserve({
				state: "3",
				handle: "D",
				returnKey: "D",
				quota,
				shiplet: "shiplet_sibling_scope",
			}),
		).resolves.toMatchObject({ ok: true });

		await testEnv.DB.prepare(
			"UPDATE oauth_flows SET status = 'denied', completed_on = ? WHERE state_digest = ?",
		)
			.bind(new Date(NOW + 1).toISOString(), "1".repeat(64))
			.run();
		await expect(
			reserve({
				state: "4",
				handle: "E",
				returnKey: "E",
				quota,
				createdOn: NOW + 2,
			}),
		).resolves.toMatchObject({ ok: true });
		await testEnv.DB.prepare(
			"UPDATE oauth_flows SET status = 'denied', completed_on = ? WHERE state_digest = ?",
		)
			.bind(new Date(NOW + 3).toISOString(), "4".repeat(64))
			.run();
		await expect(
			reserve({
				state: "5",
				handle: "F",
				returnKey: "F",
				quota,
				createdOn: NOW + 4,
			}),
		).resolves.toEqual({ ok: false, reason: "oauth_flow_rate_limited" });
	});

	it("reserves quota before state work and never runs rejected state creation", async () => {
		// Given one live start already consumes the actor+Shiplet allowance, when
		// another start arrives, then the D1 reservation rejects it before the
		// callback can spend crypto, CPU, or encrypted-state storage.
		const quota = {
			maxOutstanding: 1,
			maxStartsPerWindow: 2,
			windowMs: 60_000,
		};
		const createState = vi.fn(async () => {
			const sequence = createState.mock.calls.length;
			await testEnv.DB.prepare(
				`INSERT INTO cloudflare_oauth_state_refs
				 (id, user_id, session_binding_digest, redirect_uri_digest, secret_ref,
				  expires_at, created_on, consumed_on)
				 VALUES (?, 'user_prestate_quota', ?, ?, NULL, ?, ?, NULL)`,
			)
				.bind(
					`state_prestate_${sequence}`,
					SESSION_DIGEST,
					"e".repeat(64),
					NOW + 60_000,
					new Date(NOW).toISOString(),
				)
				.run();
			return { authorizationUrl: `https://dash.cloudflare.com/oauth?attempt=${sequence}` };
		});
		const start = (suffix: string, shipletId = "shiplet_prestate_quota") =>
			beginD1OAuthStateWithinQuota({
				db: testEnv.DB,
				shipletId,
				userId: "user_prestate_quota",
				sessionBindingDigest: SESSION_DIGEST,
				expiresAt: NOW + 60_000,
				deliveryHandle: suffix.repeat(43),
				returnKey: suffix.repeat(22),
				supportVersionId: "33333333-3333-4333-8333-333333333333",
				supportVersionTag: "shiplet-prestate-quota",
				createdOn: new Date(NOW).toISOString(),
				quota,
				begin: createState,
			});

		await expect(start("M")).resolves.toMatchObject({ ok: true });
		await expect(start("N")).resolves.toEqual({
			ok: false,
			reason: "oauth_flow_quota_exceeded",
		});
		await expect(start("M")).resolves.toEqual({
			ok: false,
			reason: "oauth_flow_reservation_conflict",
		});
		expect(createState).toHaveBeenCalledOnce();
		expect(
			await testEnv.DB.prepare(
				"SELECT COUNT(*) AS count FROM cloudflare_oauth_state_refs",
			).first(),
		).toEqual({ count: 1 });

		await expect(start("P", "shiplet_prestate_sibling")).resolves.toMatchObject({
			ok: true,
		});
		expect(createState).toHaveBeenCalledTimes(2);
	});

	it("keeps a crash-abandoned pre-state reservation inside the outstanding bound", async () => {
		const quota = {
			maxOutstanding: 1,
			maxStartsPerWindow: 2,
			windowMs: 60_000,
		};
		const failedStateCreation = vi.fn(async () => {
			throw new Error("state_persistence_response_lost");
		});
		await expect(
			beginD1OAuthStateWithinQuota({
				db: testEnv.DB,
				shipletId: "shiplet_prestate_crash",
				userId: "user_prestate_crash",
				sessionBindingDigest: SESSION_DIGEST,
				expiresAt: NOW + 60_000,
				deliveryHandle: "R".repeat(43),
				returnKey: "R".repeat(22),
				supportVersionId: "44444444-4444-4444-8444-444444444444",
				supportVersionTag: "shiplet-prestate-crash",
				createdOn: new Date(NOW).toISOString(),
				quota,
				begin: failedStateCreation,
			}),
		).rejects.toThrow("state_persistence_response_lost");

		const shouldNotRun = vi.fn(async () => ({ authorizationUrl: "unexpected" }));
		await expect(
			beginD1OAuthStateWithinQuota({
				db: testEnv.DB,
				shipletId: "shiplet_prestate_crash",
				userId: "user_prestate_crash",
				sessionBindingDigest: SESSION_DIGEST,
				expiresAt: NOW + 60_000,
				deliveryHandle: "S".repeat(43),
				returnKey: "S".repeat(22),
				supportVersionId: "44444444-4444-4444-8444-444444444444",
				supportVersionTag: "shiplet-prestate-crash",
				createdOn: new Date(NOW + 1).toISOString(),
				quota,
				begin: shouldNotRun,
			}),
		).resolves.toEqual({ ok: false, reason: "oauth_flow_quota_exceeded" });
		expect(shouldNotRun).not.toHaveBeenCalled();
	});

	it("atomically consumes the exact pre-state reservation into one immutable flow", async () => {
		// Given quota was reserved before state creation, when the returned state
		// is bound, then one transaction creates the flow and consumes that exact
		// reservation; a replay or rebound remains a conflict.
		const started = await beginD1OAuthStateWithinQuota({
			db: testEnv.DB,
			shipletId: "shiplet_prestate_consume",
			userId: "user_prestate_consume",
			sessionBindingDigest: SESSION_DIGEST,
			expectedAccountId: "account_prestate_consume",
			expiresAt: NOW + 60_000,
			deliveryHandle: "T".repeat(43),
			returnKey: "T".repeat(22),
			supportVersionId: "55555555-5555-4555-8555-555555555555",
			supportVersionTag: "shiplet-prestate-consume",
			createdOn: new Date(NOW).toISOString(),
			begin: async () => ({ authorizationUrl: "https://dash.cloudflare.com/oauth" }),
		});
		if (!started.ok) throw new Error("fixture_start_reservation_failed");
		const stateDigest = "b".repeat(64);
		await expect(
			reserveD1OAuthFinalizationFlow({
				db: testEnv.DB,
				startReservationId: "oauth_start_unrelated",
				stateDigest: "c".repeat(64),
				now: NOW + 1,
			}),
		).resolves.toEqual({
			ok: false,
			reason: "oauth_flow_reservation_conflict",
		});
		expect(
			await testEnv.DB.prepare(
				"SELECT status FROM oauth_start_reservations WHERE id = ?",
			)
				.bind(started.reservationId)
				.first(),
		).toEqual({ status: "reserved" });

		await expect(
			reserveD1OAuthFinalizationFlow({
				db: testEnv.DB,
				startReservationId: started.reservationId,
				stateDigest,
				now: NOW + 1,
			}),
		).resolves.toEqual({
			ok: true,
			connectionId: `cloudflare_connection_${stateDigest.slice(0, 48)}`,
		});
		expect(
			await testEnv.DB.prepare(
				`SELECT reservation.status, reservation.state_digest,
				        flow.start_reservation_id, flow.shiplet_id,
				        flow.expected_account_id
				 FROM oauth_start_reservations AS reservation
				 JOIN oauth_flows AS flow
				   ON flow.start_reservation_id = reservation.id
				 WHERE reservation.id = ?`,
			)
				.bind(started.reservationId)
				.first(),
		).toEqual({
			status: "consumed",
			state_digest: stateDigest,
			start_reservation_id: started.reservationId,
			shiplet_id: "shiplet_prestate_consume",
			expected_account_id: "account_prestate_consume",
		});
		await expect(
			reserveD1OAuthFinalizationFlow({
				db: testEnv.DB,
				startReservationId: started.reservationId,
				stateDigest,
				now: NOW + 2,
			}),
		).resolves.toEqual({
			ok: false,
			reason: "oauth_flow_reservation_conflict",
		});
	});

	it("purges terminal OAuth records and retired unreferenced ciphertext in bounded batches", async () => {
		const old = NOW - 8 * 86_400_000;
		for (const [state, handle, returnKey] of [
			["6", "G", "G"],
			["7", "H", "H"],
		] as const) {
			await reserve({
				state,
				handle,
				returnKey,
				createdOn: old,
			});
			await testEnv.DB.prepare(
				"UPDATE oauth_flows SET status = 'denied', completed_on = ? WHERE state_digest = ?",
			)
				.bind(new Date(old).toISOString(), state.repeat(64))
				.run();
		}
		const consumedState = "8".repeat(64);
		const consumedConnection = `cloudflare_connection_${consumedState.slice(0, 48)}`;
		await reserve({
			state: "8",
			handle: "I",
			returnKey: "I",
			createdOn: old,
		});
		await testEnv.DB.batch([
			testEnv.DB.prepare(
				`INSERT INTO encrypted_records
				 (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
				 VALUES ('vault_retention_active', 'oauth_credential', 'n', 'c', 'active',
				 ?, ?, NULL)`,
			).bind(NOW + 60_000, new Date(old).toISOString()),
			testEnv.DB.prepare(
				`INSERT INTO cloudflare_connections
				 (id, user_id, account_id, account_label, scopes_json, credential_ref,
				  expires_at, status, revoked_at, generation, created_on, refreshed_at)
				 VALUES (?, 'user_quota', 'account_retention', 'Retention', '[]',
				 'vault_retention_active', ?, 'active', NULL, 1, ?, NULL)`,
			).bind(consumedConnection, NOW + 60_000, new Date(old).toISOString()),
			testEnv.DB.prepare(
				`UPDATE oauth_flows SET status = 'consumed', completed_on = ?, consumed_on = ?
				 WHERE state_digest = ?`,
			).bind(
				new Date(old).toISOString(),
				new Date(old).toISOString(),
				consumedState,
			),
		]);
		await testEnv.DB.batch([
			testEnv.DB.prepare(
				`INSERT INTO cloudflare_oauth_state_refs
				 (id, user_id, session_binding_digest, redirect_uri_digest, secret_ref,
				  expires_at, created_on, consumed_on)
				 VALUES ('state_ref_old', 'user_retention', ?, ?, NULL, ?, ?, ?)`,
			).bind(
				SESSION_DIGEST,
				"e".repeat(64),
				old,
				new Date(old).toISOString(),
				new Date(old).toISOString(),
			),
			testEnv.DB.prepare(
				`INSERT INTO encrypted_records
				 (id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on)
				 VALUES ('vault_retired_old', 'oauth_state', 'n', 'c', 'retired', ?, ?, ?)`,
			).bind(old, new Date(old).toISOString(), new Date(old).toISOString()),
		]);

		await expect(
			reconcileD1OAuthRetention({
				db: testEnv.DB,
				now: NOW,
				limit: 1,
				retentionMs: 7 * 86_400_000,
				retireStateRef: async () => undefined,
			}),
		).resolves.toEqual({
			flowsPurged: 1,
			startReservationsPurged: 1,
			stateRefsPurged: 1,
			recoveriesPurged: 0,
			ciphertextsPurged: 1,
		});
		expect(
			await testEnv.DB.prepare(
				"SELECT COUNT(*) AS count FROM oauth_flows WHERE status = 'denied'",
			).first(),
		).toEqual({ count: 1 });
		expect(
			await testEnv.DB.prepare(
				"SELECT status FROM oauth_flows WHERE state_digest = ?",
			)
				.bind(consumedState)
				.first(),
		).toEqual({ status: "consumed" });
	});
});
