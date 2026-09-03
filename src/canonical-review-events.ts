export type CanonicalStatusCategory =
	| "open"
	| "in_progress"
	| "blocked"
	| "resolved"
	| "closed"
	| "informational"
	| "unknown";

export type CanonicalActor = {
	kind: "human" | "agent" | "shiplet" | "system";
	id: string;
};

export type CanonicalReviewEvent = {
	eventId: string;
	shipletId: string;
	revisionId: string;
	actorKind: CanonicalActor["kind"];
	actorId: string;
	eventKind: string;
	summary: string;
	canonicalStatusCategory: CanonicalStatusCategory;
	customPayload: Readonly<Record<string, unknown>>;
	occurredAt: string;
	createdAt: string;
};

export class CanonicalEventError extends Error {
	constructor(
		public readonly code: string,
		public readonly path?: string,
	) {
		super(path ? `${code} at ${path}` : code);
		this.name = "CanonicalEventError";
	}
}

type AuthorityResolution =
	| { allowed: true; actor: CanonicalActor }
	| { allowed: false; reason: "revoked" | "expired" | "denied" | "replayed" };

export type CanonicalEventStoreOptions = {
	db: D1Database;
	resolveAuthority(input: {
		authorityHandle: string;
		shipletId: string;
		revisionId: string;
		eventKind: string;
	}): Promise<AuthorityResolution>;
	revisionBelongsToShiplet(
		revisionId: string,
		shipletId: string,
	): Promise<boolean>;
	now?: () => Date;
};

export type RecordCanonicalEventInput = {
	authorityHandle: string;
	shipletId: string;
	revisionId: string;
	eventKind: string;
	summary: string;
	canonicalStatusCategory: CanonicalStatusCategory;
	customPayload: unknown;
	occurredAt?: string;
};

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_NODES = 2_000;
const MAX_DEPTH = 24;
const MAX_KEYS = 256;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EVENT_KIND = /^[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9-]{0,63}$/;
const STATUS_CATEGORIES = new Set<CanonicalStatusCategory>([
	"open",
	"in_progress",
	"blocked",
	"resolved",
	"closed",
	"informational",
	"unknown",
]);
const FORBIDDEN_KEYS = new Set([
	"accesstoken",
	"authorization",
	"authorizationcode",
	"bearer",
	"claim",
	"claimurl",
	"cookie",
	"credential",
	"oauth",
	"oauthtoken",
	"password",
	"refreshtoken",
	"secret",
	"session",
	"token",
]);

function fail(code: string, path?: string): never {
	throw new CanonicalEventError(code, path);
}

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function assertIdentifier(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) {
		fail("invalid_identifier", path);
	}
}

function normalizedKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function snapshotPayload(input: unknown): Readonly<Record<string, unknown>> {
	let nodes = 0;
	let bytes = 0;
	const seen = new Set<object>();

	const addBytes = (value: string, path: string) => {
		const length = utf8Length(value);
		if (length > MAX_STRING_BYTES) fail("payload_too_large", path);
		bytes += length;
		if (bytes > MAX_PAYLOAD_BYTES) fail("payload_too_large", "$");
	};

	const visit = (value: unknown, path: string, depth: number): unknown => {
		nodes += 1;
		if (nodes > MAX_NODES || depth > MAX_DEPTH) fail("payload_too_large", path);
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) fail("invalid_payload", path);
			return value;
		}
		if (typeof value === "string") {
			addBytes(value, path);
			return value;
		}
		if (typeof value !== "object") fail("invalid_payload", path);
		if (seen.has(value)) fail("invalid_payload", path);
		seen.add(value);
		try {
			if (Array.isArray(value)) {
				if (value.length > MAX_KEYS) fail("payload_too_large", path);
				const descriptors = Object.getOwnPropertyDescriptors(value);
				const output: unknown[] = [];
				for (let index = 0; index < value.length; index += 1) {
					const descriptor = descriptors[String(index)];
					if (!descriptor || !("value" in descriptor)) {
						fail("invalid_payload", `${path}[${index}]`);
					}
					output.push(visit(descriptor.value, `${path}[${index}]`, depth + 1));
				}
				return Object.freeze(output);
			}
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== null) {
				fail("invalid_payload", path);
			}
			const descriptors = Object.getOwnPropertyDescriptors(value);
			const keys = Object.keys(descriptors).filter(
				(key) => descriptors[key]?.enumerable,
			);
			if (keys.length > MAX_KEYS) fail("payload_too_large", path);
			const output = Object.create(null) as Record<string, unknown>;
			for (const key of keys.sort()) {
				if (key === "__proto__" || key === "constructor" || key === "prototype") {
					fail("forbidden_payload_key", `${path}.${key}`);
				}
				if (FORBIDDEN_KEYS.has(normalizedKey(key))) {
					fail("forbidden_payload_key", `${path}.${key}`);
				}
				addBytes(key, `${path}.${key}`);
				const descriptor = descriptors[key];
				if (!descriptor || !("value" in descriptor)) {
					fail("invalid_payload", `${path}.${key}`);
				}
				Object.defineProperty(output, key, {
					value: visit(descriptor.value, `${path}.${key}`, depth + 1),
					enumerable: true,
					configurable: false,
					writable: false,
				});
			}
			return Object.freeze(output);
		} finally {
			seen.delete(value);
		}
	};

	const snapshot = visit(input, "$", 0);
	if (
		snapshot === null ||
		typeof snapshot !== "object" ||
		Array.isArray(snapshot)
	) {
		fail("invalid_payload", "$");
	}
	const serialized = JSON.stringify(snapshot);
	if (utf8Length(serialized) > MAX_PAYLOAD_BYTES) fail("payload_too_large", "$");
	return snapshot as Readonly<Record<string, unknown>>;
}

function isoTimestamp(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length > 64) fail("invalid_timestamp", path);
	const time = Date.parse(value);
	if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
		fail("invalid_timestamp", path);
	}
	return value;
}

function mapRow(row: {
	id: string;
	project_id: string;
	revision_id: string;
	actor_kind: CanonicalActor["kind"];
	actor_id: string;
	event_kind: string;
	summary: string;
	canonical_status_category: CanonicalStatusCategory;
	canonical_status_category_v2?: CanonicalStatusCategory | null;
	custom_payload_json: string;
	occurred_at: string;
	created_at: string;
}): CanonicalReviewEvent {
	return Object.freeze({
		eventId: row.id,
		shipletId: row.project_id,
		revisionId: row.revision_id,
		actorKind: row.actor_kind,
		actorId: row.actor_id,
		eventKind: row.event_kind,
		summary: row.summary,
		canonicalStatusCategory:
			row.canonical_status_category_v2 ?? row.canonical_status_category,
		customPayload: snapshotPayload(JSON.parse(row.custom_payload_json)),
		occurredAt: row.occurred_at,
		createdAt: row.created_at,
	});
}

export async function ensureCanonicalEventSchema(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(
			`CREATE TABLE IF NOT EXISTS shiplet_events (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				revision_id TEXT NOT NULL,
				actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'shiplet', 'system')),
				actor_id TEXT NOT NULL,
				event_kind TEXT NOT NULL,
				summary TEXT NOT NULL,
				canonical_status_category TEXT NOT NULL CHECK (canonical_status_category IN ('open', 'in_progress', 'resolved', 'closed', 'unknown')),
				canonical_status_category_v2 TEXT CHECK (canonical_status_category_v2 IN ('open', 'in_progress', 'blocked', 'resolved', 'closed', 'informational', 'unknown')),
				custom_payload_json TEXT NOT NULL,
				occurred_at TEXT NOT NULL,
				created_at TEXT NOT NULL,
				FOREIGN KEY (project_id) REFERENCES projects(id)
			)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_shiplet_events_project_created
			 ON shiplet_events(project_id, created_at DESC, id DESC)`,
		),
		db.prepare(
			`CREATE TRIGGER IF NOT EXISTS trg_shiplet_events_immutable_update
			 BEFORE UPDATE ON shiplet_events
			 BEGIN SELECT RAISE(ABORT, 'shiplet_events are immutable'); END`,
		),
		db.prepare(
			`CREATE TRIGGER IF NOT EXISTS trg_shiplet_events_immutable_delete
			 BEFORE DELETE ON shiplet_events
			 BEGIN SELECT RAISE(ABORT, 'shiplet_events are immutable'); END`,
		),
	]);
	const columns = await db
		.prepare("PRAGMA table_info('shiplet_events')")
		.all<{ name: string }>();
	if (
		!(columns.results ?? []).some(
			(column) => column.name === "canonical_status_category_v2",
		)
	) {
		await db
			.prepare(
				`ALTER TABLE shiplet_events ADD COLUMN canonical_status_category_v2 TEXT
				 CHECK (canonical_status_category_v2 IN ('open', 'in_progress', 'blocked', 'resolved', 'closed', 'informational', 'unknown'))`,
			)
			.run();
	}
}

export function legacyCanonicalStatusCategory(
	category: CanonicalStatusCategory,
): "open" | "in_progress" | "resolved" | "closed" | "unknown" {
	if (category === "blocked") return "in_progress";
	if (category === "informational") return "unknown";
	return category;
}

export function createCanonicalEventStore(options: CanonicalEventStoreOptions) {
	if (!options || typeof options.resolveAuthority !== "function") {
		throw new CanonicalEventError("authority_resolver_required");
	}
	if (typeof options.revisionBelongsToShiplet !== "function") {
		throw new CanonicalEventError("revision_resolver_required");
	}
	const now = options.now ?? (() => new Date());

	return Object.freeze({
		async record(input: RecordCanonicalEventInput): Promise<CanonicalReviewEvent> {
			assertIdentifier(input.authorityHandle, "authorityHandle");
			assertIdentifier(input.shipletId, "shipletId");
			assertIdentifier(input.revisionId, "revisionId");
			if (typeof input.eventKind !== "string" || !EVENT_KIND.test(input.eventKind)) {
				fail("invalid_event_kind", "eventKind");
			}
			if (
				typeof input.summary !== "string" ||
				input.summary.trim().length === 0 ||
				utf8Length(input.summary) > 512
			) {
				fail("invalid_summary", "summary");
			}
			if (!STATUS_CATEGORIES.has(input.canonicalStatusCategory)) {
				fail("invalid_status_category", "canonicalStatusCategory");
			}
			const customPayload = snapshotPayload(input.customPayload);
			const createdAt = now().toISOString();
			const occurredAt = input.occurredAt
				? isoTimestamp(input.occurredAt, "occurredAt")
				: createdAt;
			if (
				!(await options.revisionBelongsToShiplet(
					input.revisionId,
					input.shipletId,
				))
			) {
				fail("revision_scope_mismatch");
			}
			const authority = await options.resolveAuthority({
				authorityHandle: input.authorityHandle,
				shipletId: input.shipletId,
				revisionId: input.revisionId,
				eventKind: input.eventKind,
			});
			if (!authority.allowed) fail("authority_denied");
			if (
				!(["human", "agent", "shiplet", "system"] as string[]).includes(
					authority.actor.kind,
				)
			) {
				fail("invalid_actor", "actor.kind");
			}
			assertIdentifier(authority.actor.id, "actor.id");
			const eventId = `event_${crypto.randomUUID().replace(/-/g, "")}`;
			await options.db
				.prepare(
					`INSERT INTO shiplet_events (
						id, project_id, revision_id, actor_kind, actor_id, event_kind,
						summary, canonical_status_category, canonical_status_category_v2,
						custom_payload_json,
						occurred_at, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					eventId,
					input.shipletId,
					input.revisionId,
					authority.actor.kind,
					authority.actor.id,
					input.eventKind,
					input.summary.trim(),
					legacyCanonicalStatusCategory(input.canonicalStatusCategory),
					input.canonicalStatusCategory,
					JSON.stringify(customPayload),
					occurredAt,
					createdAt,
				)
				.run();
			return Object.freeze({
				eventId,
				shipletId: input.shipletId,
				revisionId: input.revisionId,
				actorKind: authority.actor.kind,
				actorId: authority.actor.id,
				eventKind: input.eventKind,
				summary: input.summary.trim(),
				canonicalStatusCategory: input.canonicalStatusCategory,
				customPayload,
				occurredAt,
				createdAt,
			});
		},

		async list(input: {
			shipletId: string;
			limit?: number;
		}): Promise<CanonicalReviewEvent[]> {
			assertIdentifier(input.shipletId, "shipletId");
			const limit = input.limit ?? 100;
			if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
				fail("invalid_limit", "limit");
			}
			const rows = await options.db
				.prepare(
					`SELECT * FROM shiplet_events
					 WHERE project_id = ?
					 ORDER BY created_at DESC, id DESC
					 LIMIT ?`,
				)
				.bind(input.shipletId, limit)
				.all<Parameters<typeof mapRow>[0]>();
			return (rows.results ?? []).map(mapRow);
		},
	});
}
