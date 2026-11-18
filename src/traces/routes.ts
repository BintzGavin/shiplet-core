// REST routes for traces (docs/traces-spec.md, slice 1). A trace is the full
// log of an agent session: the prompts, the agent's replies, and every tool
// call and result. In slice 1 every trace is private to its uploader and the
// Shiplet owner.
import type { Hono } from "hono";
import {
	TRACE_LIMITS,
	decodeUploadAttachments,
	finalizeTrace,
	maskAttachments,
	maskEvents,
	sha256Hex,
	truncateEvents,
	validateUpload,
	type TraceUpload,
} from "../cli/trace-core.mjs";
import { newId } from "../store";
import { notFound, resolveTraceAccess, traceError } from "./access";
import {
	createTrace,
	decodeCursor,
	deleteTrace,
	findTraceByUpload,
	getTrace,
	listTracesForReader,
	readAttachment,
	readManifest,
	readerMayRead,
	readSegment,
	traceQuotaUsage,
	traceSummary,
} from "./store";

class PayloadTooLarge extends Error {}

async function readBodyWithLimit(request: Request, limit: number) {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > limit) {
			await reader.cancel().catch(() => undefined);
			throw new PayloadTooLarge();
		}
		chunks.push(value);
	}
	const body = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm"]);

// biome-ignore lint/suspicious/noExplicitAny: the Worker's Hono app carries app-specific variables.
export function registerTraceRoutes(app: Hono<any>) {
	app.post("/api/shiplets/:projectId/traces", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "write");
		if (access instanceof Response) return access;
		const { project, reader, user, token } = access;

		let raw: Uint8Array;
		try {
			raw = await readBodyWithLimit(c.req.raw, TRACE_LIMITS.uploadRequestBytes);
		} catch (error) {
			if (error instanceof PayloadTooLarge) {
				return traceError(413, "payload_too_large", "Trace uploads are limited to 16 MiB until multipart upload ships.");
			}
			throw error;
		}
		const uploadSha256 = await sha256Hex(raw);
		const existing = await findTraceByUpload(c.env.DB, project.id, uploadSha256);
		if (existing) {
			if (!readerMayRead(existing, reader)) {
				return traceError(409, "duplicate_upload", "This exact trace was already uploaded to this Shiplet.");
			}
			return Response.json({ trace: traceSummary(existing), manifest: await readManifest(c.env, existing), duplicate: true });
		}

		let upload: TraceUpload;
		try {
			upload = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			return traceError(400, "invalid_upload", "The body must be JSON.", { errors: [{ path: "", message: "Invalid JSON." }] });
		}
		const validation = await validateUpload(upload);
		if (!validation.ok) {
			return traceError(400, "invalid_upload", "The trace upload is invalid.", { errors: validation.errors });
		}
		const revisionId = upload.revisionId ?? null;
		if (revisionId) {
			const revision = await c.env.DB.prepare("SELECT id FROM shiplet_revisions WHERE id = ? AND project_id = ? LIMIT 1")
				.bind(revisionId, project.id)
				.first();
			if (!revision) return traceError(400, "revision_not_in_shiplet", "That revision does not belong to this Shiplet.");
		}

		const maskedEvents = await maskEvents(upload.events);
		const maskedAttachments = await maskAttachments(decodeUploadAttachments(upload), maskedEvents.events);
		const events = truncateEvents(maskedAttachments.events);
		const serverKinds: Record<string, number> = { ...maskedEvents.kinds };
		for (const [kind, value] of Object.entries(maskedAttachments.kinds)) serverKinds[kind] = (serverKinds[kind] || 0) + value;
		const serverCount = maskedEvents.count + maskedAttachments.count;
		const finalized = await finalizeTrace({
			events,
			attachments: maskedAttachments.attachments,
			cwd: upload.cwd ?? null,
			title: upload.title.trim(),
			source: {
				harness: upload.source.harness,
				harnessVersion: upload.source.harnessVersion ?? null,
				importer: upload.source.importer ?? null,
			},
			startedAt: upload.startedAt ?? null,
			endedAt: upload.endedAt ?? null,
			models: upload.models,
			skippedLines: upload.skippedLines ?? 0,
			droppedAttachments: upload.droppedAttachments ?? 0,
			masking: {
				clientCount: upload.clientMasking.count,
				clientKinds: upload.clientMasking.kinds,
				serverCount,
				serverKinds,
			},
		});
		if (finalized.segments.length > TRACE_LIMITS.segmentsPerTrace) {
			return traceError(400, "invalid_upload", "The trace has too many segments.", {
				errors: [{ path: "events", message: `At most ${TRACE_LIMITS.segmentsPerTrace} segments.` }],
			});
		}

		const newBytes =
			finalized.segments.reduce((sum, segment) => sum + new TextEncoder().encode(segment.ndjson).byteLength, 0) +
			maskedAttachments.attachments.reduce((sum, attachment) => sum + attachment.bytes, 0);
		const organizationId = project.organization_id ?? null;
		const uploaderUserId = user?.id ?? null;
		const used = await traceQuotaUsage(c.env.DB, { organizationId, uploaderUserId });
		const quota = organizationId ? TRACE_LIMITS.organizationQuotaBytes : TRACE_LIMITS.personalQuotaBytes;
		if (used + newBytes > quota) {
			return traceError(413, "quota_exceeded", "This upload would exceed the trace storage quota.");
		}

		const row = await createTrace(c.env, {
			id: newId("trc"),
			projectId: project.id,
			organizationId,
			revisionId,
			uploaderUserId,
			uploaderTokenId: token?.id ?? null,
			uploadSha256,
			manifest: finalized.manifest,
			manifestSha256: await sha256Hex(JSON.stringify(finalized.manifest)),
			segments: finalized.segments,
			attachments: maskedAttachments.attachments,
			clientMaskedCount: upload.clientMasking.count,
			serverMaskedCount: serverCount,
			createdOn: new Date().toISOString(),
		});
		return Response.json(
			{ trace: traceSummary(row), manifest: finalized.manifest, serverMasked: { count: serverCount, kinds: serverKinds } },
			{ status: 201 },
		);
	});

	app.get("/api/shiplets/:projectId/traces", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		const limitParam = Number(c.req.query("limit") || 50);
		const limit = Number.isInteger(limitParam) ? Math.min(100, Math.max(1, limitParam)) : 50;
		const { rows, nextCursor } = await listTracesForReader(c.env.DB, access.project.id, access.reader, {
			cursor: decodeCursor(c.req.query("cursor")),
			limit,
		});
		return Response.json({ traces: rows.map(traceSummary), nextCursor });
	});

	app.get("/api/shiplets/:projectId/traces/:traceId", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		const row = await getTrace(c.env.DB, access.project.id, c.req.param("traceId"));
		if (!row || !readerMayRead(row, access.reader)) return notFound();
		return Response.json({ trace: traceSummary(row), manifest: await readManifest(c.env, row) });
	});

	app.get("/api/shiplets/:projectId/traces/:traceId/segments/:index", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		const row = await getTrace(c.env.DB, access.project.id, c.req.param("traceId"));
		if (!row || !readerMayRead(row, access.reader)) return notFound();
		const index = Number(c.req.param("index"));
		if (!Number.isInteger(index) || index < 0 || index >= row.segment_count) return notFound();
		const events = await readSegment(c.env, row, index);
		if (!events) return notFound();
		return Response.json({ index, events });
	});

	app.get("/api/shiplets/:projectId/traces/:traceId/attachments/:sha256", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		const row = await getTrace(c.env.DB, access.project.id, c.req.param("traceId"));
		const sha256 = c.req.param("sha256");
		if (!row || !readerMayRead(row, access.reader) || !/^[a-f0-9]{64}$/.test(sha256)) return notFound();
		const object = await readAttachment(c.env, row, sha256);
		if (!object) return notFound();
		const contentType = object.httpMetadata?.contentType || "application/octet-stream";
		const headers = new Headers({
			"content-type": contentType,
			"x-content-type-options": "nosniff",
			"cache-control": "private, max-age=300",
			"content-disposition": INLINE_TYPES.has(contentType) ? "inline" : `attachment; filename="${sha256}"`,
			"content-length": String(object.size),
		});
		return new Response(object.body, { headers });
	});

	app.delete("/api/shiplets/:projectId/traces/:traceId", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "delete");
		if (access instanceof Response) return access;
		const row = await getTrace(c.env.DB, access.project.id, c.req.param("traceId"));
		if (!row || !readerMayRead(row, access.reader)) return notFound();
		await deleteTrace(c.env, row);
		return new Response(null, { status: 204 });
	});
}
