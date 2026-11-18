// REST routes for traces (docs/traces-spec.md, slices 1 and 2). A trace is the
// full log of an agent session: the prompts, the agent's replies, and every
// tool call and result. New traces are private to their uploader and the
// Shiplet owner; sharing adds audiences, each with a redaction level.
import type { Hono } from "hono";
import {
	TRACE_LIMITS,
	applyProfileToEvents,
	applyProfileToManifest,
	attachmentKeeper,
	decodeUploadAttachments,
	deferredUploadAttachments,
	finalizeTrace,
	maskAttachments,
	maskEvents,
	profileDigest,
	profileDroppedCallIds,
	sha256Hex,
	truncateEvents,
	validateProfile,
	validateUpload,
	type TraceManifest,
	type TraceProfile,
	type TraceUpload,
} from "../cli/trace-core.mjs";
import type { Env } from "../env";
import { getTeam, newId } from "../store";
import type { Project } from "../types";
import { notFound, resolveTraceAccess, traceError, type TraceAccess } from "./access";
import {
	AUDIENCE_TARGET_TYPES,
	audienceView,
	canDeleteTrace,
	canManageAudiences,
	listAudiences,
	resolveTraceLevel,
	type AudienceTargetType,
	type ResolvedAccess,
} from "./audiences";
import {
	createTrace,
	decodeCursor,
	deleteTrace,
	findTraceByUpload,
	getPendingAttachment,
	getTrace,
	listProjectTraces,
	readAttachment,
	readManifest,
	readSegment,
	storePendingAttachment,
	traceQuotaUsage,
	traceSummary,
	type TraceRow,
} from "./store";
import { pruneVariants, readVariantManifest, readVariantSegment, renderVariant } from "./variants";

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

async function readJsonBody(request: Request, limit: number): Promise<unknown | Response> {
	try {
		const raw = await readBodyWithLimit(request, limit);
		return JSON.parse(new TextDecoder().decode(raw));
	} catch (error) {
		if (error instanceof PayloadTooLarge) return traceError(413, "payload_too_large", "The request body is too large.");
		return traceError(400, "invalid_json", "The body must be JSON.");
	}
}

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm"]);
const MAX_AUDIENCES = 100;

// What the viewer may see of one trace, with the manifest at that level.
type TraceView = { row: TraceRow; resolved: ResolvedAccess; manifest: TraceManifest & { level?: string } };

async function viewTrace(env: Env, access: TraceAccess, row: TraceRow): Promise<TraceView | null> {
	const resolved = await resolveTraceLevel(env, access.project, row, access.viewer);
	if (resolved.level === "hidden") return null;
	if (resolved.via !== "audience") {
		const manifest = await readManifest(env, row);
		return manifest ? { row, resolved, manifest: { ...manifest, level: "full" } } : null;
	}
	let manifest = await readVariantManifest(env, row, resolved.profileDigest);
	if (!manifest) {
		await renderVariant(env, row, resolved.profile as TraceProfile, resolved.profileDigest);
		manifest = await readVariantManifest(env, row, resolved.profileDigest);
	}
	return manifest ? { row, resolved, manifest } : null;
}

function accessSummary(resolved: ResolvedAccess) {
	return { level: resolved.level, via: resolved.via };
}

async function loadRow(c: { env: Env; req: { param: (name: string) => string } }, access: TraceAccess) {
	return getTrace(c.env.DB, access.project.id, c.req.param("traceId"));
}

type AudienceInput = { targetType: AudienceTargetType; targetId: string; profile: TraceProfile };

async function normalizeAudiences(env: Env, project: Project, input: unknown): Promise<AudienceInput[] | Response> {
	if (!Array.isArray(input) || input.length > MAX_AUDIENCES) {
		return traceError(400, "invalid_audiences", `audiences must be an array of at most ${MAX_AUDIENCES}.`);
	}
	const seen = new Set<string>();
	const result: AudienceInput[] = [];
	const errors: Array<{ path: string; message: string }> = [];
	for (const [index, entry] of input.entries()) {
		const path = `audiences[${index}]`;
		if (!entry || typeof entry !== "object") {
			errors.push({ path, message: "Must be { targetType, targetId, profile }." });
			continue;
		}
		const { targetType, targetId, profile } = entry as Record<string, unknown>;
		if (!AUDIENCE_TARGET_TYPES.includes(targetType as AudienceTargetType)) {
			errors.push({ path: `${path}.targetType`, message: `Must be one of ${AUDIENCE_TARGET_TYPES.join(", ")}.` });
			continue;
		}
		let id = typeof targetId === "string" ? targetId.trim() : "";
		if (targetType === "link") id = "link";
		if (targetType === "organization") {
			if (!project.organization_id) {
				errors.push({ path: `${path}.targetType`, message: "This Shiplet has no organization." });
				continue;
			}
			id = project.organization_id;
		}
		if (targetType === "email") {
			id = id.toLowerCase();
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id) || id.length > 320) errors.push({ path: `${path}.targetId`, message: "Must be an email address." });
		}
		if ((targetType === "user" || targetType === "team" || targetType === "api_token") && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) {
			errors.push({ path: `${path}.targetId`, message: "Must be an ID." });
		}
		if (targetType === "team") {
			const team = (await getTeam(env.DB, id)) as { organization_id?: string } | null;
			if (!team || team.organization_id !== project.organization_id) {
				errors.push({ path: `${path}.targetId`, message: "Team not found in this Shiplet's organization." });
			}
		}
		if (targetType === "api_token") {
			const token = await env.DB.prepare("SELECT organization_id FROM organization_api_tokens WHERE id = ?").bind(id).first<{ organization_id: string }>();
			if (!token || token.organization_id !== project.organization_id) {
				errors.push({ path: `${path}.targetId`, message: "API key not found in this Shiplet's organization." });
			}
		}
		const validation = validateProfile(profile);
		if (!validation.ok) {
			for (const error of validation.errors) errors.push({ path: `${path}.profile${error.path ? `.${error.path}` : ""}`, message: error.message });
			continue;
		}
		const key = `${targetType}:${id}`;
		if (seen.has(key)) errors.push({ path, message: "Duplicate audience." });
		seen.add(key);
		const normalized = profile as TraceProfile;
		result.push({ targetType: targetType as AudienceTargetType, targetId: id, profile: { level: normalized.level, rules: normalized.rules ?? [] } });
	}
	return errors.length ? traceError(400, "invalid_audiences", "Some audiences are invalid.", { errors: errors.slice(0, 50) }) : result;
}

function actorId(access: TraceAccess) {
	return access.user?.id ?? (access.token ? `api_key:${access.token.id}` : "anonymous");
}

// biome-ignore lint/suspicious/noExplicitAny: the Worker's Hono app carries app-specific variables.
export function registerTraceRoutes(app: Hono<any>) {
	app.post("/api/shiplets/:projectId/traces", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "write");
		if (access instanceof Response) return access;
		const { project, user, token } = access;

		let raw: Uint8Array;
		try {
			raw = await readBodyWithLimit(c.req.raw, TRACE_LIMITS.uploadRequestBytes);
		} catch (error) {
			if (error instanceof PayloadTooLarge) {
				return traceError(413, "payload_too_large", "Trace event uploads are limited to 16 MiB; send large files as deferred attachments.");
			}
			throw error;
		}
		const uploadSha256 = await sha256Hex(raw);
		const existing = await findTraceByUpload(c.env.DB, project.id, uploadSha256);
		if (existing) {
			const view = await viewTrace(c.env, access, existing);
			if (!view) return traceError(409, "duplicate_upload", "This exact trace was already uploaded to this Shiplet.");
			return Response.json({ trace: traceSummary(existing), manifest: view.manifest, duplicate: true });
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
		const pending = deferredUploadAttachments(upload);
		const events = truncateEvents(maskedAttachments.events);
		const serverKinds: Record<string, number> = { ...maskedEvents.kinds };
		for (const [kind, value] of Object.entries(maskedAttachments.kinds)) serverKinds[kind] = (serverKinds[kind] || 0) + value;
		const serverCount = maskedEvents.count + maskedAttachments.count;
		const finalized = await finalizeTrace({
			events,
			attachments: [...maskedAttachments.attachments, ...pending.map((item) => ({ ...item, data: new Uint8Array() }))],
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
			maskedAttachments.attachments.reduce((sum, attachment) => sum + attachment.bytes, 0) +
			pending.reduce((sum, attachment) => sum + attachment.bytes, 0);
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
			pendingAttachments: pending,
			clientMaskedCount: upload.clientMasking.count,
			serverMaskedCount: serverCount,
			createdOn: new Date().toISOString(),
		});
		return Response.json(
			{
				trace: traceSummary(row),
				manifest: finalized.manifest,
				serverMasked: { count: serverCount, kinds: serverKinds },
				pendingAttachments: pending.map((attachment) => attachment.sha256),
			},
			{ status: 201 },
		);
	});

	app.get("/api/shiplets/:projectId/traces", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		const limitParam = Number(c.req.query("limit") || 50);
		const limit = Number.isInteger(limitParam) ? Math.min(100, Math.max(1, limitParam)) : 50;
		const { rows, nextCursor } = await listProjectTraces(c.env.DB, access.project.id, {
			cursor: decodeCursor(c.req.query("cursor")),
			limit,
		});
		const traces = [];
		for (const row of rows) {
			const resolved = await resolveTraceLevel(c.env, access.project, row, access.viewer);
			if (resolved.level !== "hidden") traces.push({ ...traceSummary(row), access: accessSummary(resolved) });
		}
		return Response.json({ traces, nextCursor });
	});

	app.get("/api/shiplets/:projectId/traces/:traceId", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		const row = await loadRow(c, access);
		const view = row && (await viewTrace(c.env, access, row));
		if (!row || !view) return notFound();
		return Response.json({
			trace: traceSummary(row),
			manifest: view.manifest,
			access: { ...accessSummary(view.resolved), canManage: canManageAudiences(access.project, row, access.viewer) },
		});
	});

	app.get("/api/shiplets/:projectId/traces/:traceId/segments/:index", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		const row = await loadRow(c, access);
		const view = row && (await viewTrace(c.env, access, row));
		if (!row || !view) return notFound();
		const index = Number(c.req.param("index"));
		if (!Number.isInteger(index) || index < 0 || index >= view.manifest.segments.length) return notFound();
		const events =
			view.resolved.via === "audience"
				? await readVariantSegment(c.env, row, view.resolved.profileDigest, index)
				: await readSegment(c.env, row, index);
		if (!events) return notFound();
		return Response.json({ index, events, level: view.resolved.level });
	});

	app.get("/api/shiplets/:projectId/traces/:traceId/attachments/:sha256", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		const row = await loadRow(c, access);
		const sha256 = c.req.param("sha256");
		const view = row && /^[a-f0-9]{64}$/.test(sha256) ? await viewTrace(c.env, access, row) : null;
		if (!row || !view || !(view.manifest.attachments || []).some((attachment) => attachment.sha256 === sha256)) return notFound();
		const object = await readAttachment(c.env, row, sha256);
		if (!object) {
			if (await getPendingAttachment(c.env.DB, row.id, sha256)) {
				return traceError(404, "attachment_pending", "This attachment has not been uploaded yet.");
			}
			return notFound();
		}
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

	// Uploads the bytes of a deferred attachment (a session-produced file).
	app.put("/api/shiplets/:projectId/traces/:traceId/attachments/:sha256", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "write");
		if (access instanceof Response) return access;
		const row = await loadRow(c, access);
		const sha256 = c.req.param("sha256");
		if (!row || !canManageAudiences(access.project, row, access.viewer)) return notFound();
		const pending = await getPendingAttachment(c.env.DB, row.id, sha256);
		if (!pending) return traceError(409, "attachment_not_pending", "This attachment is not waiting for an upload.");
		let data: Uint8Array;
		try {
			data = await readBodyWithLimit(c.req.raw, TRACE_LIMITS.attachmentBytes);
		} catch (error) {
			if (error instanceof PayloadTooLarge) return traceError(413, "payload_too_large", "Attachments are limited to 20 MiB.");
			throw error;
		}
		if (data.byteLength !== pending.bytes || (await sha256Hex(data)) !== sha256) {
			return traceError(400, "attachment_mismatch", "The bytes do not match the attachment's size and sha256.");
		}
		await storePendingAttachment(c.env, row, { sha256, mediaType: pending.media_type, data });
		return new Response(null, { status: 204 });
	});

	app.get("/api/shiplets/:projectId/traces/:traceId/audiences", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		const row = await loadRow(c, access);
		if (!row || !canManageAudiences(access.project, row, access.viewer)) return notFound();
		return Response.json({ sharing: row.sharing, audiences: (await listAudiences(c.env.DB, row.id)).map(audienceView) });
	});

	// Replaces the whole audience set. Adding the first audience shares the
	// trace; only an explicit "sharing": "private" makes it private again.
	app.put("/api/shiplets/:projectId/traces/:traceId/audiences", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "delete");
		if (access instanceof Response) return access;
		const row = await loadRow(c, access);
		if (!row || !canManageAudiences(access.project, row, access.viewer)) return notFound();
		const body = await readJsonBody(c.req.raw, 256 * 1024);
		if (body instanceof Response) return body;
		const input = body as { sharing?: unknown; audiences?: unknown };
		if (input.sharing !== undefined && input.sharing !== "private" && input.sharing !== "shared") {
			return traceError(400, "invalid_sharing", 'sharing must be "private" or "shared".');
		}
		// Omitting "audiences" keeps the current set and only changes sharing.
		const keepAudiences = input.audiences === undefined;
		const audiences = keepAudiences
			? (await listAudiences(c.env.DB, row.id)).map((existing) => ({
					targetType: existing.target_type,
					targetId: existing.target_id,
					profile: JSON.parse(existing.profile_json) as TraceProfile,
				}))
			: await normalizeAudiences(c.env, access.project, input.audiences);
		if (audiences instanceof Response) return audiences;
		const digests = new Map<string, TraceProfile>();
		const statements = keepAudiences ? [] : [c.env.DB.prepare("DELETE FROM trace_audiences WHERE trace_id = ?").bind(row.id)];
		const now = new Date().toISOString();
		for (const audience of audiences) {
			const digest = await profileDigest(audience.profile);
			digests.set(digest, audience.profile);
			if (keepAudiences) continue;
			statements.push(
				c.env.DB.prepare(
					`INSERT INTO trace_audiences (id, trace_id, project_id, target_type, target_id, profile_json, profile_digest, created_by, created_on)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).bind(newId("tra"), row.id, row.project_id, audience.targetType, audience.targetId, JSON.stringify(audience.profile), digest, actorId(access), now),
			);
		}
		const sharing = input.sharing ?? (!keepAudiences && audiences.length ? "shared" : row.sharing);
		statements.push(c.env.DB.prepare("UPDATE project_traces SET sharing = ? WHERE id = ?").bind(sharing, row.id));
		await c.env.DB.batch(statements);
		const updated = { ...row, sharing } as TraceRow;
		for (const [digest, profile] of digests) await renderVariant(c.env, updated, profile, digest);
		await pruneVariants(c.env, updated, new Set(digests.keys()));
		return Response.json({ trace: traceSummary(updated), sharing, audiences: (await listAudiences(c.env.DB, row.id)).map(audienceView) });
	});

	// Shows exactly what a profile would reveal, without storing anything.
	app.post("/api/shiplets/:projectId/traces/:traceId/preview", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		const row = await loadRow(c, access);
		if (!row || !canManageAudiences(access.project, row, access.viewer)) return notFound();
		const body = await readJsonBody(c.req.raw, 64 * 1024);
		if (body instanceof Response) return body;
		const profile = (body as { profile?: unknown }).profile;
		const validation = validateProfile(profile);
		if (!validation.ok) return traceError(400, "invalid_profile", "The profile is invalid.", { errors: validation.errors });
		const index = Number(c.req.query("segment") || 0);
		if (!Number.isInteger(index) || index < 0 || index >= row.segment_count) return notFound();
		const manifest = await readManifest(c.env, row);
		if (!manifest) return notFound();
		const all = [];
		for (let segment = 0; segment < row.segment_count; segment++) all.push((await readSegment(c.env, row, segment)) || []);
		const typed = profile as TraceProfile;
		const droppedCallIds = profileDroppedCallIds(all.flat(), typed);
		const events = applyProfileToEvents(all[index], typed, { droppedCallIds, keepAttachment: attachmentKeeper(manifest, typed) });
		return Response.json({ manifest: applyProfileToManifest(manifest, typed), segment: index, events });
	});

	app.delete("/api/shiplets/:projectId/traces/:traceId", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "delete");
		if (access instanceof Response) return access;
		const row = await loadRow(c, access);
		if (!row || !(await canDeleteTrace(c.env, access.project, row, access.viewer))) return notFound();
		await deleteTrace(c.env, row);
		return new Response(null, { status: 204 });
	});
}
