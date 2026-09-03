import type {
	CloudflareConnectionRecord,
	CloudflareConnectionStore,
	CloudflareOAuthStateRecord,
	CloudflareOAuthStateStore,
	PublicCloudflareConnection,
} from "./cloudflare-oauth";

type OAuthStateVault = {
	seal(material: object): Promise<string>;
	withMaterial<T>(
		ref: string,
		operation: (material: object) => Promise<T>,
	): Promise<T>;
	retire(ref: string): Promise<void>;
};

const AUDIT_KEYS = new Set([
	"eventKind",
	"actorKind",
	"actorId",
	"connectionId",
	"accountId",
	"outcome",
	"occurredAt",
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function newId(prefix: string) {
	return `${prefix}_${crypto.randomUUID()}`;
}

async function digest(value: string) {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseScopes(value: string) {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== "string")) {
		throw new Error("cloudflare_connection_corrupt");
	}
	return [...parsed];
}

function connectionFromRow(row: {
	id: string;
	user_id: string;
	account_id: string;
	account_label: string;
	scopes_json: string;
	credential_ref: string;
	expires_at: number;
	status: "active" | "revoked";
	revoked_at: number | null;
	generation: number;
}): CloudflareConnectionRecord {
	return {
		id: row.id,
		userId: row.user_id,
		accountId: row.account_id,
		accountLabel: row.account_label,
		scopes: parseScopes(row.scopes_json),
		credentialRef: row.credential_ref,
		expiresAt: row.expires_at,
		status: row.status,
		...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
		generation: row.generation,
	};
}

function publicConnection(
	connection: CloudflareConnectionRecord,
): PublicCloudflareConnection {
	const { credentialRef: _credentialRef, ...publicRecord } = connection;
	return publicRecord;
}

function validateStateRecord(value: object): asserts value is CloudflareOAuthStateRecord {
	const state = value as Partial<CloudflareOAuthStateRecord>;
	if (
		!IDENTIFIER.test(state.id || "") ||
		!IDENTIFIER.test(state.userId || "") ||
		typeof state.sessionId !== "string" ||
		state.sessionId.length < 8 ||
		state.sessionId.length > 2_048 ||
		typeof state.redirectUri !== "string" ||
		state.redirectUri.length > 2_048 ||
		typeof state.codeVerifier !== "string" ||
		state.codeVerifier.length < 16 ||
		state.codeVerifier.length > 512 ||
		!Array.isArray(state.requestedScopes) ||
		state.requestedScopes.some((scope) => typeof scope !== "string") ||
		!Number.isSafeInteger(state.expiresAt)
	) {
		throw new Error("oauth_state_invalid");
	}
}

export async function ensureCloudflareControlPlaneSchema(db: D1Database) {
	await db.batch([
		db.prepare(
			`CREATE TABLE IF NOT EXISTS cloudflare_oauth_state_refs (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				session_binding_digest TEXT NOT NULL,
				redirect_uri_digest TEXT NOT NULL,
				secret_ref TEXT,
				expires_at INTEGER NOT NULL,
				created_on TEXT NOT NULL,
				consumed_on TEXT
			)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS cloudflare_connections (
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
				refreshed_at INTEGER
			)`,
		),
		db.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_cloudflare_connections_active_account
			 ON cloudflare_connections(user_id, account_id) WHERE status = 'active'`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS cloudflare_revocation_requests (
				connection_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				account_id TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
				requested_on TEXT NOT NULL,
				completed_on TEXT,
				last_failure_code TEXT,
				FOREIGN KEY (connection_id) REFERENCES cloudflare_connections(id)
			)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS cloudflare_oauth_ack_outbox (
				connection_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				shiplet_id TEXT NOT NULL,
				delivery_handle TEXT NOT NULL,
				session_binding TEXT NOT NULL,
				delivery_expires_at INTEGER NOT NULL,
				attempt_count INTEGER NOT NULL DEFAULT 0,
				created_on TEXT NOT NULL,
				last_attempt_on TEXT,
				FOREIGN KEY (connection_id) REFERENCES cloudflare_connections(id)
			)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_cloudflare_oauth_ack_outbox_expiry
			 ON cloudflare_oauth_ack_outbox(delivery_expires_at, connection_id)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS cloudflare_refresh_reservations (
				connection_id TEXT PRIMARY KEY,
				reservation_id TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				created_on TEXT NOT NULL,
				FOREIGN KEY (connection_id) REFERENCES cloudflare_connections(id)
			)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS cloudflare_control_audit_outbox (
				id TEXT PRIMARY KEY,
				event_json TEXT NOT NULL,
				delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'delivered')),
				created_on TEXT NOT NULL,
				delivered_on TEXT
			)`,
		),
		db.prepare(
			`CREATE TRIGGER IF NOT EXISTS cloudflare_oauth_state_refs_binding_immutable
			 BEFORE UPDATE ON cloudflare_oauth_state_refs
			 WHEN NEW.id != OLD.id OR NEW.user_id != OLD.user_id
			 OR NEW.session_binding_digest != OLD.session_binding_digest
			 OR NEW.redirect_uri_digest != OLD.redirect_uri_digest
			 OR NEW.expires_at != OLD.expires_at OR NEW.created_on != OLD.created_on
			 BEGIN SELECT RAISE(ABORT, 'OAuth state binding is immutable'); END`,
		),
		db.prepare(
			`CREATE TRIGGER IF NOT EXISTS cloudflare_audit_outbox_content_immutable
			 BEFORE UPDATE ON cloudflare_control_audit_outbox
			 WHEN NEW.id != OLD.id OR NEW.event_json != OLD.event_json
			 OR NEW.created_on != OLD.created_on
			 OR OLD.delivery_status != 'pending' OR NEW.delivery_status != 'delivered'
			 BEGIN SELECT RAISE(ABORT, 'Cloudflare audit content is immutable'); END`,
		),
		db.prepare(
			`CREATE TRIGGER IF NOT EXISTS cloudflare_audit_outbox_no_delete
			 BEFORE DELETE ON cloudflare_control_audit_outbox
			 BEGIN SELECT RAISE(ABORT, 'Cloudflare audit history is immutable'); END`,
		),
	]);
}

export function createD1CloudflareOAuthStateStore(input: {
	db: D1Database;
	vault: OAuthStateVault;
}): CloudflareOAuthStateStore {
	return {
		async put(record) {
			validateStateRecord(record);
			const secretRef = await input.vault.seal(structuredClone(record));
			try {
				await input.db
					.prepare(
						`INSERT INTO cloudflare_oauth_state_refs (
						 id, user_id, session_binding_digest, redirect_uri_digest,
						 secret_ref, expires_at, created_on, consumed_on
						) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
					)
					.bind(
						record.id,
						record.userId,
						await digest(record.sessionId),
						await digest(record.redirectUri),
						secretRef,
						record.expiresAt,
						new Date().toISOString(),
					)
					.run();
			} catch (error) {
				await input.vault.retire(secretRef).catch(() => undefined);
				throw error;
			}
		},

		async get(id) {
			const row = await input.db
				.prepare(
					`SELECT secret_ref FROM cloudflare_oauth_state_refs
					 WHERE id = ? AND consumed_on IS NULL AND secret_ref IS NOT NULL`,
				)
				.bind(id)
				.first<{ secret_ref: string }>();
			if (!row) return null;
			return input.vault.withMaterial(row.secret_ref, async (material) => {
				validateStateRecord(material);
				return structuredClone(material);
			});
		},

		async consume(id) {
			const state = await this.get(id);
			if (!state) return null;
			return this.consumeBound({
				id,
				userId: state.userId,
				sessionId: state.sessionId,
				redirectUri: state.redirectUri,
			});
		},

		async consumeBound(binding) {
			const row = await input.db
				.prepare(
					`SELECT secret_ref FROM cloudflare_oauth_state_refs
					 WHERE id = ? AND user_id = ? AND session_binding_digest = ?
					 AND redirect_uri_digest = ? AND consumed_on IS NULL
					 AND secret_ref IS NOT NULL`,
				)
				.bind(
					binding.id,
					binding.userId,
					await digest(binding.sessionId),
					await digest(binding.redirectUri),
				)
				.first<{ secret_ref: string }>();
			if (!row) return null;
			const claimed = await input.db
				.prepare(
					`UPDATE cloudflare_oauth_state_refs
					 SET consumed_on = ?
					 WHERE id = ? AND user_id = ? AND session_binding_digest = ?
					 AND redirect_uri_digest = ? AND consumed_on IS NULL
					 AND secret_ref = ?`,
				)
				.bind(
					new Date().toISOString(),
					binding.id,
					binding.userId,
					await digest(binding.sessionId),
					await digest(binding.redirectUri),
					row.secret_ref,
				)
				.run();
			if (claimed.meta.changes !== 1) return null;
			const state = await input.vault.withMaterial(
				row.secret_ref,
				async (material) => {
					validateStateRecord(material);
					return structuredClone(material);
				},
			);
			try {
				await input.vault.retire(row.secret_ref);
				await input.db
					.prepare(
						`UPDATE cloudflare_oauth_state_refs SET secret_ref = NULL
						 WHERE id = ? AND consumed_on IS NOT NULL AND secret_ref = ?`,
					)
					.bind(binding.id, row.secret_ref)
					.run();
			} catch {
				// The consumed row retains only the opaque reference for a trusted
				// cleanup reconciler; it can never be consumed a second time.
			}
			return state;
		},
	};
}

export function createD1CloudflareConnectionStore(input: {
	db: D1Database;
	now: () => number;
}): CloudflareConnectionStore & {
	listPublicForUser(userId: string): Promise<PublicCloudflareConnection[]>;
} {
	const get = async (id: string) => {
		const row = await input.db
			.prepare("SELECT * FROM cloudflare_connections WHERE id = ?")
			.bind(id)
			.first<Parameters<typeof connectionFromRow>[0]>();
		return row ? connectionFromRow(row) : null;
	};
	return {
		async create(record) {
			const id = record.id ?? newId("cloudflare_connection");
			const generation = record.generation ?? 1;
			await input.db
				.prepare(
					`INSERT INTO cloudflare_connections (
					 id, user_id, account_id, account_label, scopes_json,
					 credential_ref, expires_at, status, revoked_at, generation,
					 created_on, refreshed_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL)`,
				)
				.bind(
					id,
					record.userId,
					record.accountId,
					record.accountLabel,
					JSON.stringify([...new Set(record.scopes)].sort()),
					record.credentialRef,
					record.expiresAt,
					generation,
					new Date(input.now()).toISOString(),
				)
				.run();
			const created = await get(id);
			if (!created) throw new Error("cloudflare_connection_create_failed");
			return created;
		},

		get,

		async listPublicForUser(userId) {
			const rows = await input.db
				.prepare(
					`SELECT * FROM cloudflare_connections
					 WHERE user_id = ? ORDER BY created_on, id`,
				)
				.bind(userId)
				.all<Parameters<typeof connectionFromRow>[0]>();
			return rows.results.map(connectionFromRow).map(publicConnection);
		},

		async compareAndSwapCredential(update) {
			const result = await input.db
				.prepare(
					`UPDATE cloudflare_connections SET credential_ref = ?, expires_at = ?,
					 refreshed_at = ?, generation = ?
					 WHERE id = ? AND status = 'active' AND credential_ref = ?
					 AND generation = ?`,
				)
				.bind(
					update.nextCredentialRef,
					update.expiresAt,
					update.refreshedAt,
					update.nextGeneration,
					update.id,
					update.expectedCredentialRef,
					update.expectedGeneration,
				)
				.run();
			return result.meta.changes === 1;
		},

		async markRevoked(update) {
			const result = await input.db
				.prepare(
					`UPDATE cloudflare_connections SET status = 'revoked', revoked_at = ?
					 WHERE id = ? AND status = 'active'`,
				)
				.bind(update.revokedAt, update.id)
				.run();
			return result.meta.changes === 1;
		},

		async reserveRefresh(reservation) {
			await input.db
				.prepare(
					"DELETE FROM cloudflare_refresh_reservations WHERE connection_id = ? AND expires_at <= ?",
				)
				.bind(reservation.connectionId, input.now())
				.run();
			const reservationId = newId("cloudflare_refresh");
			const inserted = await input.db
				.prepare(
					`INSERT OR IGNORE INTO cloudflare_refresh_reservations (
					 connection_id, reservation_id, idempotency_key, expires_at, created_on
					) SELECT ?, ?, ?, ?, ? WHERE EXISTS (
					 SELECT 1 FROM cloudflare_connections
					 WHERE id = ? AND status = 'active'
					)`,
				)
				.bind(
					reservation.connectionId,
					reservationId,
					reservation.idempotencyKey,
					input.now() + 60_000,
					new Date(input.now()).toISOString(),
					reservation.connectionId,
				)
				.run();
			return inserted.meta.changes === 1
				? { ok: true as const, reservationId }
				: { ok: false as const, reason: "refresh_in_progress" as const };
		},

		async releaseRefresh(release) {
			await input.db
				.prepare("DELETE FROM cloudflare_refresh_reservations WHERE connection_id = ?")
				.bind(release.connectionId)
				.run();
		},

		async recordAuditEvent(event) {
			if (
				Object.keys(event).some((key) => !AUDIT_KEYS.has(key)) ||
				typeof event.eventKind !== "string" ||
				JSON.stringify(event).length > 16_384
			) {
				throw new Error("audit_event_invalid");
			}
			const id = newId("cloudflare_audit");
			await input.db
				.prepare(
					`INSERT INTO cloudflare_control_audit_outbox (
					 id, event_json, delivery_status, created_on, delivered_on
					) VALUES (?, ?, 'pending', ?, NULL)`,
				)
				.bind(id, JSON.stringify(event), new Date(input.now()).toISOString())
				.run();
			return id;
		},

		async markAuditDelivered(delivery) {
			const result = await input.db
				.prepare(
					`UPDATE cloudflare_control_audit_outbox
					 SET delivery_status = 'delivered', delivered_on = ?
					 WHERE id = ? AND delivery_status = 'pending'`,
				)
				.bind(new Date(input.now()).toISOString(), delivery.id)
				.run();
			return result.meta.changes === 1;
		},
	};
}
