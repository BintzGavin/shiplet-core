// Redacted variants (D12): each distinct profile is rendered once from the
// canonical trace, segment by segment, and stored next to it. Reads serve the
// stored variant; nothing is redacted per request.
import {
	applyProfileToEvents,
	applyProfileToManifest,
	attachmentKeeper,
	profileDroppedCallIds,
	sha256Hex,
	type TraceEvent,
	type TraceManifest,
	type TraceProfile as CoreProfile,
} from "../cli/trace-core.mjs";
import { deleteR2Keys } from "../cloudflare-external-rewrite-spool";
import type { Env } from "../env";
import { readManifest, readSegment, traceObjectPrefix, type TraceRow } from "./store";

const variantPrefix = (row: TraceRow, digest: string) => `${traceObjectPrefix(row.project_id, row.id)}variants/${digest}/`;
const variantSegmentKey = (row: TraceRow, digest: string, index: number) =>
	`${variantPrefix(row, digest)}seg-${String(index).padStart(5, "0")}.ndjson.gz`;
const variantManifestKey = (row: TraceRow, digest: string) => `${variantPrefix(row, digest)}manifest.json`;

async function gzip(text: string) {
	const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipEvents(body: ReadableStream): Promise<TraceEvent[]> {
	const text = await new Response(body.pipeThrough(new DecompressionStream("gzip"))).text();
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TraceEvent);
}

async function canonicalEvents(env: Env, row: TraceRow) {
	const all: TraceEvent[][] = [];
	for (let index = 0; index < row.segment_count; index++) all.push((await readSegment(env, row, index)) || []);
	return all;
}

// Renders a profile into stored segments and a manifest. Two passes: the
// first finds tool calls whose results must be hidden in any segment.
export async function renderVariant(env: Env, row: TraceRow, profile: CoreProfile, digest: string, cwd: string | null = null) {
	const existing = await env.DB.prepare("SELECT 1 FROM trace_variants WHERE trace_id = ? AND profile_digest = ?")
		.bind(row.id, digest)
		.first();
	if (existing) return;
	const manifest = await readManifest(env, row);
	if (!manifest) throw new Error("trace manifest missing");
	const segments = await canonicalEvents(env, row);
	const droppedCallIds = profileDroppedCallIds(segments.flat(), profile, { cwd });
	const keepAttachment = attachmentKeeper(manifest, profile);
	const records: TraceManifest["segments"] = [];
	const referenced = new Set<string>();
	const written: string[] = [];
	try {
		if (profile.level !== "summary" && profile.level !== "hidden") {
			for (const [index, events] of segments.entries()) {
				const rendered = applyProfileToEvents(events, profile, { cwd, droppedCallIds, keepAttachment });
				for (const event of rendered) for (const id of event.attachmentIds || []) referenced.add(id);
				const ndjson = rendered.map((event) => JSON.stringify(event)).join("\n") + (rendered.length ? "\n" : "");
				const key = variantSegmentKey(row, digest, index);
				await env.REVIEW_ASSETS.put(key, await gzip(ndjson), {
					httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
				});
				written.push(key);
				records.push({
					index,
					firstSeq: rendered[0]?.seq ?? manifest.segments[index]?.firstSeq ?? 0,
					lastSeq: rendered[rendered.length - 1]?.seq ?? manifest.segments[index]?.lastSeq ?? 0,
					events: rendered.length,
					bytes: new TextEncoder().encode(ndjson).byteLength,
					sha256: await sha256Hex(ndjson),
				});
			}
		}
		const variantManifest = {
			...applyProfileToManifest(manifest, profile, { attachmentsInEvents: referenced }),
			segments: records,
		};
		const manifestText = JSON.stringify(variantManifest);
		await env.REVIEW_ASSETS.put(variantManifestKey(row, digest), manifestText, { httpMetadata: { contentType: "application/json" } });
		written.push(variantManifestKey(row, digest));
		await env.DB.prepare(
			`INSERT OR REPLACE INTO trace_variants (trace_id, profile_digest, segment_count, manifest_sha256, created_on)
			 VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(row.id, digest, records.length, await sha256Hex(manifestText), new Date().toISOString())
			.run();
	} catch (error) {
		await deleteR2Keys(env.REVIEW_ASSETS, written).catch(() => undefined);
		throw error;
	}
}

export async function readVariantManifest(env: Env, row: TraceRow, digest: string): Promise<(TraceManifest & { level?: string }) | null> {
	const object = await env.REVIEW_ASSETS.get(variantManifestKey(row, digest));
	return object ? ((await object.json()) as TraceManifest) : null;
}

export async function readVariantSegment(env: Env, row: TraceRow, digest: string, index: number) {
	const object = await env.REVIEW_ASSETS.get(variantSegmentKey(row, digest, index));
	return object ? gunzipEvents(object.body) : null;
}

// Removes variants no audience uses any more.
export async function pruneVariants(env: Env, row: TraceRow, keep: Set<string>) {
	const rows = await env.DB.prepare("SELECT profile_digest FROM trace_variants WHERE trace_id = ?").bind(row.id).all<{ profile_digest: string }>();
	for (const { profile_digest: digest } of rows.results || []) {
		if (keep.has(digest)) continue;
		await env.DB.prepare("DELETE FROM trace_variants WHERE trace_id = ? AND profile_digest = ?").bind(row.id, digest).run();
		let cursor: string | undefined;
		do {
			const listed = await env.REVIEW_ASSETS.list({ prefix: variantPrefix(row, digest), cursor });
			await deleteR2Keys(
				env.REVIEW_ASSETS,
				listed.objects.map((object) => object.key),
			).catch(() => undefined);
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
	}
}
