// Trace storage: metadata in D1 (project_traces), bodies in REVIEW_ASSETS
// under traces/v1/<projectId>/<traceId>/. Canonical segments are gzipped
// NDJSON. See docs/traces-spec.md (D8, D11, slice 1).
import type { Env } from "../env";
import type { TraceAttachment, TraceEvent, TraceManifest } from "../cli/trace-core.mjs";
import { deleteR2Keys } from "../cloudflare-external-rewrite-spool";

export type TraceRow = {
	id: string;
	project_id: string;
	organization_id: string | null;
	revision_id: string | null;
	uploader_user_id: string | null;
	uploader_token_id: string | null;
	upload_sha256: string;
	sharing: "private" | "shared";
	title: string;
	harness: string;
	started_on: string | null;
	ended_on: string | null;
	event_count: number;
	segment_count: number;
	canonical_bytes: number;
	attachment_count: number;
	attachment_bytes: number;
	pending_attachments: number;
	client_masked_count: number;
	server_masked_count: number;
	manifest_sha256: string;
	created_on: string;
};

export type TraceSummary = {
	id: string;
	projectId: string;
	revisionId: string | null;
	title: string;
	harness: string;
	startedOn: string | null;
	endedOn: string | null;
	eventCount: number;
	segmentCount: number;
	canonicalBytes: number;
	attachmentCount: number;
	attachmentBytes: number;
	pendingAttachments: number;
	serverMaskedCount: number;
	sharing: "private" | "shared";
	uploadedBy: { kind: "user" | "api_key"; id: string };
	createdOn: string;
};

export function traceSummary(row: TraceRow): TraceSummary {
	return {
		id: row.id,
		projectId: row.project_id,
		revisionId: row.revision_id,
		title: row.title,
		harness: row.harness,
		startedOn: row.started_on,
		endedOn: row.ended_on,
		eventCount: row.event_count,
		segmentCount: row.segment_count,
		canonicalBytes: row.canonical_bytes,
		attachmentCount: row.attachment_count,
		attachmentBytes: row.attachment_bytes,
		pendingAttachments: row.pending_attachments || 0,
		serverMaskedCount: row.server_masked_count,
		sharing: row.sharing === "shared" ? "shared" : "private",
		uploadedBy: row.uploader_token_id
			? { kind: "api_key", id: row.uploader_token_id }
			: { kind: "user", id: row.uploader_user_id || "" },
		createdOn: row.created_on,
	};
}

export function traceObjectPrefix(projectId: string, traceId?: string) {
	return traceId ? `traces/v1/${projectId}/${traceId}/` : `traces/v1/${projectId}/`;
}

const segmentKey = (projectId: string, traceId: string, index: number) =>
	`${traceObjectPrefix(projectId, traceId)}canonical/seg-${String(index).padStart(5, "0")}.ndjson.gz`;
const manifestKey = (projectId: string, traceId: string) =>
	`${traceObjectPrefix(projectId, traceId)}canonical/manifest.json`;
const attachmentKey = (projectId: string, traceId: string, sha256: string) =>
	`${traceObjectPrefix(projectId, traceId)}attachments/${sha256}`;

async function gzip(text: string) {
	const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(body: ReadableStream) {
	return new Response(body.pipeThrough(new DecompressionStream("gzip"))).text();
}

export type CreateTraceInput = {
	id: string;
	projectId: string;
	organizationId: string | null;
	revisionId: string | null;
	uploaderUserId: string | null;
	uploaderTokenId: string | null;
	uploadSha256: string;
	manifest: TraceManifest;
	manifestSha256: string;
	segments: Array<{ index: number; ndjson: string }>;
	attachments: TraceAttachment[];
	pendingAttachments?: Array<{ sha256: string; mediaType: string; bytes: number }>;
	clientMaskedCount: number;
	serverMaskedCount: number;
	createdOn: string;
};

// Every object first, then the row. On any failure, the objects already
// written are removed, so a row never exists without its objects.
export async function createTrace(env: Env, input: CreateTraceInput): Promise<TraceRow> {
	const bucket = env.REVIEW_ASSETS;
	const written: string[] = [];
	const put = async (key: string, body: Uint8Array | string, contentType: string, encoding?: string) => {
		await bucket.put(key, body, {
			httpMetadata: { contentType, ...(encoding ? { contentEncoding: encoding } : {}) },
		});
		written.push(key);
	};
	const canonicalBytes = input.segments.reduce(
		(sum, segment) => sum + new TextEncoder().encode(segment.ndjson).byteLength,
		0,
	);
	const pending = input.pendingAttachments || [];
	const attachmentBytes =
		input.attachments.reduce((sum, attachment) => sum + attachment.bytes, 0) + pending.reduce((sum, attachment) => sum + attachment.bytes, 0);
	const row: TraceRow = {
		id: input.id,
		project_id: input.projectId,
		organization_id: input.organizationId,
		revision_id: input.revisionId,
		uploader_user_id: input.uploaderUserId,
		uploader_token_id: input.uploaderTokenId,
		upload_sha256: input.uploadSha256,
		sharing: "private",
		title: input.manifest.title,
		harness: input.manifest.source.harness,
		started_on: input.manifest.startedAt,
		ended_on: input.manifest.endedAt,
		event_count: input.manifest.counts.events,
		segment_count: input.segments.length,
		canonical_bytes: canonicalBytes,
		attachment_count: input.attachments.length + pending.length,
		attachment_bytes: attachmentBytes,
		pending_attachments: pending.length,
		client_masked_count: input.clientMaskedCount,
		server_masked_count: input.serverMaskedCount,
		manifest_sha256: input.manifestSha256,
		created_on: input.createdOn,
	};
	try {
		for (const segment of input.segments) {
			await put(segmentKey(input.projectId, input.id, segment.index), await gzip(segment.ndjson), "application/x-ndjson", "gzip");
		}
		for (const attachment of input.attachments) {
			await put(attachmentKey(input.projectId, input.id, attachment.sha256), attachment.data, attachment.mediaType);
		}
		await put(manifestKey(input.projectId, input.id), JSON.stringify(input.manifest), "application/json");
		await env.DB.prepare(
			`INSERT INTO project_traces (
				id, project_id, organization_id, revision_id, uploader_user_id, uploader_token_id,
				upload_sha256, sharing, title, harness, started_on, ended_on, event_count,
				segment_count, canonical_bytes, attachment_count, attachment_bytes, pending_attachments,
				client_masked_count, server_masked_count, manifest_sha256, created_on
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				row.id,
				row.project_id,
				row.organization_id,
				row.revision_id,
				row.uploader_user_id,
				row.uploader_token_id,
				row.upload_sha256,
				row.sharing,
				row.title,
				row.harness,
				row.started_on,
				row.ended_on,
				row.event_count,
				row.segment_count,
				row.canonical_bytes,
				row.attachment_count,
				row.attachment_bytes,
				row.pending_attachments,
				row.client_masked_count,
				row.server_masked_count,
				row.manifest_sha256,
				row.created_on,
			)
			.run();
		for (const attachment of pending) {
			await env.DB.prepare(
				"INSERT OR REPLACE INTO trace_pending_attachments (trace_id, sha256, media_type, bytes) VALUES (?, ?, ?, ?)",
			)
				.bind(row.id, attachment.sha256, attachment.mediaType, attachment.bytes)
				.run();
		}
	} catch (error) {
		try {
			await deleteR2Keys(bucket, written);
		} catch {
			console.error("Failed to clean up objects of a failed trace upload.");
		}
		throw error;
	}
	return row;
}

export async function findTraceByUpload(db: D1Database, projectId: string, uploadSha256: string) {
	return db
		.prepare("SELECT * FROM project_traces WHERE project_id = ? AND upload_sha256 = ? LIMIT 1")
		.bind(projectId, uploadSha256)
		.first<TraceRow>();
}

export async function getTrace(db: D1Database, projectId: string, traceId: string) {
	return db
		.prepare("SELECT * FROM project_traces WHERE project_id = ? AND id = ? LIMIT 1")
		.bind(projectId, traceId)
		.first<TraceRow>();
}

export type TraceReader =
	| { kind: "user"; id: string; isShipletOwner: boolean }
	| { kind: "api_key"; id: string }
	| { kind: "anonymous" };

// Slice 1 rule (uploader or Shiplet owner). Shared traces go through
// resolveTraceLevel in ./audiences.
export function readerMayRead(row: TraceRow, reader: TraceReader) {
	if (reader.kind === "anonymous") return false;
	if (reader.kind === "api_key") return row.uploader_token_id === reader.id;
	return reader.isShipletOwner || row.uploader_user_id === reader.id;
}

type Cursor = { createdOn: string; id: string };

export function encodeCursor(row: Pick<TraceRow, "created_on" | "id">) {
	return btoa(JSON.stringify({ createdOn: row.created_on, id: row.id }));
}

export function decodeCursor(value: string | null | undefined): Cursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(atob(value));
		if (typeof parsed?.createdOn === "string" && typeof parsed?.id === "string") return parsed;
	} catch {
		// fall through
	}
	return null;
}

// One page of a Shiplet's traces, newest first. Callers filter by what the
// reader may see (resolveTraceLevel), so pages can come back short.
export async function listProjectTraces(
	db: D1Database,
	projectId: string,
	{ cursor, limit }: { cursor: Cursor | null; limit: number },
) {
	const conditions = ["project_id = ?"];
	const binds: unknown[] = [projectId];
	if (cursor) {
		conditions.push("(created_on < ? OR (created_on = ? AND id < ?))");
		binds.push(cursor.createdOn, cursor.createdOn, cursor.id);
	}
	const rows = await db
		.prepare(
			`SELECT * FROM project_traces WHERE ${conditions.join(" AND ")}
			 ORDER BY created_on DESC, id DESC LIMIT ?`,
		)
		.bind(...binds, limit + 1)
		.all<TraceRow>();
	const results = rows.results || [];
	const page = results.slice(0, limit);
	return { rows: page, nextCursor: results.length > limit ? encodeCursor(page[page.length - 1]) : null };
}

export async function readManifest(env: Env, row: TraceRow): Promise<TraceManifest | null> {
	const object = await env.REVIEW_ASSETS.get(manifestKey(row.project_id, row.id));
	return object ? ((await object.json()) as TraceManifest) : null;
}

export async function readSegment(env: Env, row: TraceRow, index: number): Promise<TraceEvent[] | null> {
	const object = await env.REVIEW_ASSETS.get(segmentKey(row.project_id, row.id, index));
	if (!object) return null;
	const text = await gunzipText(object.body);
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TraceEvent);
}

export async function readAttachment(env: Env, row: TraceRow, sha256: string, range?: R2Range) {
	return env.REVIEW_ASSETS.get(attachmentKey(row.project_id, row.id, sha256), range ? { range } : undefined);
}

export async function attachmentSize(env: Env, row: TraceRow, sha256: string) {
	return (await env.REVIEW_ASSETS.head(attachmentKey(row.project_id, row.id, sha256)))?.size ?? null;
}

async function deletePrefix(bucket: R2Bucket, prefix: string) {
	let cursor: string | undefined;
	do {
		const listed = await bucket.list({ prefix, cursor, limit: 1000 });
		const keys = listed.objects.map((object) => object.key);
		if (keys.length) await deleteR2Keys(bucket, keys);
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
}

// The row goes first; a failed object delete then leaves only orphans, which
// the project-level prefix delete (or the slice 2 sweep) later removes.
export async function deleteTrace(env: Env, row: TraceRow) {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM project_traces WHERE project_id = ? AND id = ?").bind(row.project_id, row.id),
		env.DB.prepare("DELETE FROM trace_audiences WHERE trace_id = ?").bind(row.id),
		env.DB.prepare("DELETE FROM trace_variants WHERE trace_id = ?").bind(row.id),
		env.DB.prepare("DELETE FROM trace_pending_attachments WHERE trace_id = ?").bind(row.id),
	]);
	try {
		await deletePrefix(env.REVIEW_ASSETS, traceObjectPrefix(row.project_id, row.id));
	} catch {
		console.error("Failed to delete trace objects; they will be removed with the Shiplet.");
	}
}

// Best effort, after the D1 records are gone (deleteProjectPermanently's
// convention). Returns false when any delete failed.
export async function deleteProjectTraceObjects(env: Env, projectId: string) {
	if (!env.REVIEW_ASSETS) return false;
	try {
		await deletePrefix(env.REVIEW_ASSETS, traceObjectPrefix(projectId));
		return true;
	} catch {
		return false;
	}
}

export async function traceQuotaUsage(
	db: D1Database,
	{ organizationId, uploaderUserId }: { organizationId: string | null; uploaderUserId: string | null },
) {
	const row = organizationId
		? await db
				.prepare(
					"SELECT COALESCE(SUM(canonical_bytes + attachment_bytes), 0) AS used FROM project_traces WHERE organization_id = ?",
				)
				.bind(organizationId)
				.first<{ used: number }>()
		: await db
				.prepare(
					"SELECT COALESCE(SUM(canonical_bytes + attachment_bytes), 0) AS used FROM project_traces WHERE organization_id IS NULL AND uploader_user_id = ?",
				)
				.bind(uploaderUserId)
				.first<{ used: number }>();
	return Number(row?.used || 0);
}

export async function storePendingAttachment(
	env: Env,
	row: TraceRow,
	attachment: { sha256: string; mediaType: string; data: Uint8Array },
) {
	await env.REVIEW_ASSETS.put(attachmentKey(row.project_id, row.id, attachment.sha256), attachment.data, {
		httpMetadata: { contentType: attachment.mediaType },
	});
	await env.DB.batch([
		env.DB.prepare("DELETE FROM trace_pending_attachments WHERE trace_id = ? AND sha256 = ?").bind(row.id, attachment.sha256),
		env.DB.prepare(
			"UPDATE project_traces SET pending_attachments = MAX(0, pending_attachments - 1) WHERE id = ?",
		).bind(row.id),
	]);
}

export async function getPendingAttachment(db: D1Database, traceId: string, sha256: string) {
	return db
		.prepare("SELECT sha256, media_type, bytes FROM trace_pending_attachments WHERE trace_id = ? AND sha256 = ?")
		.bind(traceId, sha256)
		.first<{ sha256: string; media_type: string; bytes: number }>();
}

export const ARCHIVED_TRACE_RETENTION_DAYS = 7;

// D18: traces of Shiplets archived more than 7 days ago are deleted, ahead of
// the Shiplet's own 30-day retention. Bounded per run; the cron repeats.
export async function sweepArchivedShipletTraces(env: Env, now = Date.now(), limit = 25) {
	if (!env.REVIEW_ASSETS) return 0;
	const cutoff = new Date(now - ARCHIVED_TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const rows = await env.DB.prepare(
		`SELECT project_traces.* FROM project_traces
		 JOIN projects ON projects.id = project_traces.project_id
		 WHERE projects.archived_on IS NOT NULL AND projects.archived_on <= ?
		 LIMIT ?`,
	)
		.bind(cutoff, limit)
		.all<TraceRow>();
	for (const row of rows.results || []) await deleteTrace(env, row);
	return (rows.results || []).length;
}
