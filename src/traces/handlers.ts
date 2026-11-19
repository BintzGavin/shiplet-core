// Trace operations shared by REST routes and Code Mode MCP. Each handler takes
// an already-authorized TraceAccess (or actor) and returns a Response, so the
// same rules and shapes apply on every surface.
import {
	TRACE_LIMITS,
	applyProfileToEvents,
	applyProfileToManifest,
	attachmentKeeper,
	buildContext,
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
	type TraceEvent,
	type TraceManifest,
	type TraceProfile,
	type TraceUpload,
} from "../cli/trace-core.mjs";
import type { Env } from "../env";
import { listProjectsForOrganizationApiToken } from "../org-api-tokens";
import { getTeam, listProjectsForUser, newId } from "../store";
import type { Project } from "../types";
import { authorizeTraceActor, notFound, traceError, type TraceAccess, type TraceActor } from "./access";
import {
	AUDIENCE_TARGET_TYPES,
	audienceView,
	canDeleteTrace,
	canManageAudiences,
	listAudiences,
	listAudiencesForTraces,
	resolveTraceLevel,
	type MembershipMemo,
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
	attachmentSize,
	readManifest,
	readSegment,
	storePendingAttachment,
	traceQuotaUsage,
	traceSummary,
	type TraceRow,
} from "./store";
import { pruneVariants, readVariantManifest, readVariantSegment, renderVariant } from "./variants";

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm"]);
const MAX_AUDIENCES = 100;

export const ok = (body: unknown, status = 200) => Response.json(body, { status });

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

async function viewEvents(env: Env, view: TraceView, index: number) {
	return view.resolved.via === "audience"
		? readVariantSegment(env, view.row, view.resolved.profileDigest, index)
		: readSegment(env, view.row, index);
}

// Only shared traces consult audiences (resolveTraceLevel).
const sharedTraceIds = (rows: TraceRow[]) => rows.filter((row) => row.sharing === "shared").map((row) => row.id);

const accessSummary = (resolved: ResolvedAccess) => ({ level: resolved.level, via: resolved.via });

export async function handleCreateTrace(env: Env, access: TraceAccess, raw: Uint8Array) {
	const { project, user, token } = access;
	const uploadSha256 = await sha256Hex(raw);
	const existing = await findTraceByUpload(env.DB, project.id, uploadSha256);
	if (existing) {
		const view = await viewTrace(env, access, existing);
		if (!view) return traceError(409, "duplicate_upload", "This exact trace was already uploaded to this Shiplet.");
		return ok({ trace: traceSummary(existing), manifest: view.manifest, duplicate: true });
	}
	let upload: TraceUpload;
	try {
		upload = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		return traceError(400, "invalid_upload", "The body must be JSON.", { errors: [{ path: "", message: "Invalid JSON." }] });
	}
	const validation = await validateUpload(upload);
	if (!validation.ok) return traceError(400, "invalid_upload", "The trace upload is invalid.", { errors: validation.errors });
	const revisionId = upload.revisionId ?? null;
	if (revisionId) {
		const revision = await env.DB.prepare("SELECT id FROM shiplet_revisions WHERE id = ? AND project_id = ? LIMIT 1")
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
		source: { harness: upload.source.harness, harnessVersion: upload.source.harnessVersion ?? null, importer: upload.source.importer ?? null },
		startedAt: upload.startedAt ?? null,
		endedAt: upload.endedAt ?? null,
		models: upload.models,
		skippedLines: upload.skippedLines ?? 0,
		droppedAttachments: upload.droppedAttachments ?? 0,
		masking: { clientCount: upload.clientMasking.count, clientKinds: upload.clientMasking.kinds, serverCount, serverKinds },
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
	const used = await traceQuotaUsage(env.DB, { organizationId, uploaderUserId });
	const quota = organizationId ? TRACE_LIMITS.organizationQuotaBytes : TRACE_LIMITS.personalQuotaBytes;
	if (used + newBytes > quota) return traceError(413, "quota_exceeded", "This upload would exceed the trace storage quota.");

	const row = await createTrace(env, {
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
	return ok(
		{
			trace: traceSummary(row),
			manifest: finalized.manifest,
			serverMasked: { count: serverCount, kinds: serverKinds },
			pendingAttachments: pending.map((attachment) => attachment.sha256),
		},
		201,
	);
}

export async function handleListTraces(env: Env, access: TraceAccess, query: { cursor?: string | null; limit?: unknown }) {
	const limitParam = Number(query.limit ?? 50);
	const limit = Number.isInteger(limitParam) ? Math.min(100, Math.max(1, limitParam)) : 50;
	const { rows, nextCursor } = await listProjectTraces(env.DB, access.project.id, { cursor: decodeCursor(query.cursor), limit });
	const audiences = await listAudiencesForTraces(env.DB, sharedTraceIds(rows));
	const memberships: MembershipMemo = new Map();
	const traces = [];
	for (const row of rows) {
		const resolved = await resolveTraceLevel(env, access.project, row, access.viewer, audiences.get(row.id), memberships);
		if (resolved.level !== "hidden") traces.push({ ...traceSummary(row), access: accessSummary(resolved) });
	}
	return ok({ traces, nextCursor });
}

// Every trace the actor can read, across the Shiplets it can view, newest
// first. Lets a colleague find a trace without knowing the Shiplet.
export async function handleListReadableTraces(env: Env, actor: TraceActor, query: { limit?: unknown }) {
	const limitParam = Number(query.limit ?? 50);
	const limit = Number.isInteger(limitParam) ? Math.min(100, Math.max(1, limitParam)) : 50;
	let projects: Project[] = [];
	if (actor.kind === "user") projects = (await listProjectsForUser(env.DB, actor.user.id)) as Project[];
	else if (actor.kind === "token") {
		if (!actor.token.scopes.includes("traces:read")) return traceError(403, "forbidden", "This API key needs traces:read.");
		projects = (await listProjectsForOrganizationApiToken(env.DB, actor.token, { limit: 500 })) as Project[];
	} else return traceError(401, "unauthorized", "Sign in to list traces.");
	const byId = new Map(projects.map((project) => [project.id, project]));
	const ids = [...byId.keys()];
	const candidates: TraceRow[] = [];
	for (let index = 0; index < ids.length; index += 90) {
		const chunk = ids.slice(index, index + 90);
		const rows = await env.DB.prepare(
			`SELECT * FROM project_traces WHERE project_id IN (${chunk.map(() => "?").join(",")}) ORDER BY created_on DESC LIMIT ?`,
		)
			.bind(...chunk, limit * 3)
			.all<TraceRow>();
		candidates.push(...(rows.results || []));
	}
	candidates.sort((a, b) => (a.created_on < b.created_on ? 1 : a.created_on > b.created_on ? -1 : 0));
	const audiences = await listAudiencesForTraces(env.DB, sharedTraceIds(candidates));
	const memberships: MembershipMemo = new Map();
	const authorized = new Map<string, ReturnType<typeof authorizeTraceActor>>();
	const traces = [];
	for (const row of candidates) {
		if (traces.length >= limit) break;
		const project = byId.get(row.project_id)!;
		let pending = authorized.get(project.id);
		if (!pending) {
			pending = authorizeTraceActor(env, project, actor, "read");
			authorized.set(project.id, pending);
		}
		const access = await pending;
		if (access instanceof Response) continue;
		const resolved = await resolveTraceLevel(env, project, row, access.viewer, audiences.get(row.id), memberships);
		if (resolved.level === "hidden") continue;
		traces.push({ ...traceSummary(row), shiplet: { id: project.id, name: project.name }, access: accessSummary(resolved) });
	}
	return ok({ traces });
}

export async function handleGetTrace(env: Env, access: TraceAccess, traceId: string) {
	const row = await getTrace(env.DB, access.project.id, traceId);
	const view = row && (await viewTrace(env, access, row));
	if (!row || !view) return notFound();
	return ok({
		trace: traceSummary(row),
		manifest: view.manifest,
		access: { ...accessSummary(view.resolved), canManage: canManageAudiences(access.project, row, access.viewer) },
	});
}

export async function handleGetSegment(env: Env, access: TraceAccess, traceId: string, indexValue: unknown) {
	const row = await getTrace(env.DB, access.project.id, traceId);
	const view = row && (await viewTrace(env, access, row));
	if (!row || !view) return notFound();
	const index = Number(indexValue);
	if (!Number.isInteger(index) || index < 0 || index >= view.manifest.segments.length) return notFound();
	const events = await viewEvents(env, view, index);
	if (!events) return notFound();
	return ok({ index, events, level: view.resolved.level });
}

// D13: the agent handoff (Markdown) at the caller's level.
export async function handleGetContext(env: Env, access: TraceAccess, traceId: string, maxTokensValue: unknown) {
	const row = await getTrace(env.DB, access.project.id, traceId);
	const view = row && (await viewTrace(env, access, row));
	if (!row || !view) return notFound();
	const maxTokens = maxTokensValue === undefined || maxTokensValue === null || maxTokensValue === "" ? 32000 : Number(maxTokensValue);
	if (!Number.isInteger(maxTokens) || maxTokens < 500 || maxTokens > 200_000) {
		return traceError(400, "invalid_max_tokens", "maxTokens must be an integer from 500 to 200000.");
	}
	const events: TraceEvent[] = [];
	for (let index = 0; index < view.manifest.segments.length; index++) events.push(...((await viewEvents(env, view, index)) || []));
	const context = buildContext(view.manifest, events, { level: view.resolved.level, maxTokens });
	return ok({ traceId: row.id, level: view.resolved.level, context });
}

// One byte range from a Range header ("bytes=0-99", "bytes=100-", "bytes=-500"),
// resolved against the object size. Browsers send these to seek in a video.
// Multiple ranges are not supported, so the whole file is served instead.
export function parseByteRange(header: string | null | undefined, size: number): { offset: number; length: number } | "unsatisfiable" | null {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match || (match[1] === "" && match[2] === "")) return null;
	if (match[1] === "") {
		const suffix = Number(match[2]);
		if (suffix === 0) return "unsatisfiable";
		const length = Math.min(suffix, size);
		return size === 0 ? "unsatisfiable" : { offset: size - length, length };
	}
	const start = Number(match[1]);
	if (start >= size) return "unsatisfiable";
	const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	if (end < start) return null;
	return { offset: start, length: end - start + 1 };
}

export async function handleGetAttachment(env: Env, access: TraceAccess, traceId: string, sha256: string, rangeHeader?: string | null) {
	const row = await getTrace(env.DB, access.project.id, traceId);
	const view = row && /^[a-f0-9]{64}$/.test(sha256) ? await viewTrace(env, access, row) : null;
	if (!row || !view || !(view.manifest.attachments || []).some((attachment) => attachment.sha256 === sha256)) return notFound();
	let range: { offset: number; length: number } | null = null;
	let size: number | null = null;
	if (rangeHeader) {
		size = await attachmentSize(env, row, sha256);
		if (size !== null) {
			const parsed = parseByteRange(rangeHeader, size);
			if (parsed === "unsatisfiable") {
				return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" } });
			}
			range = parsed;
		}
	}
	const object = await readAttachment(env, row, sha256, range ?? undefined);
	if (!object) {
		if (await getPendingAttachment(env.DB, row.id, sha256)) return traceError(404, "attachment_pending", "This attachment has not been uploaded yet.");
		return notFound();
	}
	const contentType = object.httpMetadata?.contentType || "application/octet-stream";
	const headers: Record<string, string> = {
		"content-type": contentType,
		"x-content-type-options": "nosniff",
		"cache-control": "private, max-age=300",
		"content-disposition": INLINE_TYPES.has(contentType) ? "inline" : `attachment; filename="${sha256}"`,
		"accept-ranges": "bytes",
		etag: `"${sha256}"`,
	};
	if (range) {
		headers["content-range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`;
		headers["content-length"] = String(range.length);
		return new Response(object.body, { status: 206, headers });
	}
	headers["content-length"] = String(object.size);
	return new Response(object.body, { headers });
}

export async function handlePutAttachment(env: Env, access: TraceAccess, traceId: string, sha256: string, data: Uint8Array) {
	const row = await getTrace(env.DB, access.project.id, traceId);
	if (!row || !canManageAudiences(access.project, row, access.viewer)) return notFound();
	const pending = await getPendingAttachment(env.DB, row.id, sha256);
	if (!pending) return traceError(409, "attachment_not_pending", "This attachment is not waiting for an upload.");
	if (data.byteLength !== pending.bytes || (await sha256Hex(data)) !== sha256) {
		return traceError(400, "attachment_mismatch", "The bytes do not match the attachment's size and sha256.");
	}
	await storePendingAttachment(env, row, { sha256, mediaType: pending.media_type, data });
	return new Response(null, { status: 204 });
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

export async function handleGetAudiences(env: Env, access: TraceAccess, traceId: string) {
	const row = await getTrace(env.DB, access.project.id, traceId);
	if (!row || !canManageAudiences(access.project, row, access.viewer)) return notFound();
	return ok({ sharing: row.sharing, audiences: (await listAudiences(env.DB, row.id)).map(audienceView) });
}

// Replaces the whole audience set. Adding the first audience shares the trace;
// only an explicit "sharing": "private" makes it private again. Omitting
// "audiences" keeps the current set and changes only sharing.
export async function handlePutAudiences(env: Env, access: TraceAccess, traceId: string, body: unknown) {
	const row = await getTrace(env.DB, access.project.id, traceId);
	if (!row || !canManageAudiences(access.project, row, access.viewer)) return notFound();
	const input = (body && typeof body === "object" ? body : {}) as { sharing?: unknown; audiences?: unknown };
	if (input.sharing !== undefined && input.sharing !== "private" && input.sharing !== "shared") {
		return traceError(400, "invalid_sharing", 'sharing must be "private" or "shared".');
	}
	const keepAudiences = input.audiences === undefined;
	const audiences = keepAudiences
		? (await listAudiences(env.DB, row.id)).map((existing) => ({
				targetType: existing.target_type,
				targetId: existing.target_id,
				profile: JSON.parse(existing.profile_json) as TraceProfile,
			}))
		: await normalizeAudiences(env, access.project, input.audiences);
	if (audiences instanceof Response) return audiences;
	const digests = new Map<string, TraceProfile>();
	const statements = keepAudiences ? [] : [env.DB.prepare("DELETE FROM trace_audiences WHERE trace_id = ?").bind(row.id)];
	const now = new Date().toISOString();
	for (const audience of audiences) {
		const digest = await profileDigest(audience.profile);
		digests.set(digest, audience.profile);
		if (keepAudiences) continue;
		statements.push(
			env.DB.prepare(
				`INSERT INTO trace_audiences (id, trace_id, project_id, target_type, target_id, profile_json, profile_digest, created_by, created_on)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(newId("tra"), row.id, row.project_id, audience.targetType, audience.targetId, JSON.stringify(audience.profile), digest, actorId(access), now),
		);
	}
	const sharing = input.sharing ?? (!keepAudiences && audiences.length ? "shared" : row.sharing);
	statements.push(env.DB.prepare("UPDATE project_traces SET sharing = ? WHERE id = ?").bind(sharing, row.id));
	await env.DB.batch(statements);
	const updated = { ...row, sharing } as TraceRow;
	for (const [digest, profile] of digests) await renderVariant(env, updated, profile, digest);
	await pruneVariants(env, updated, new Set(digests.keys()));
	return ok({ trace: traceSummary(updated), sharing, audiences: (await listAudiences(env.DB, row.id)).map(audienceView) });
}

// Shows exactly what a profile would reveal, without storing anything.
export async function handlePreview(env: Env, access: TraceAccess, traceId: string, body: unknown, segmentValue: unknown) {
	const row = await getTrace(env.DB, access.project.id, traceId);
	if (!row || !canManageAudiences(access.project, row, access.viewer)) return notFound();
	const profile = (body && typeof body === "object" ? (body as { profile?: unknown }).profile : undefined) as unknown;
	const validation = validateProfile(profile);
	if (!validation.ok) return traceError(400, "invalid_profile", "The profile is invalid.", { errors: validation.errors });
	const index = Number(segmentValue ?? 0);
	if (!Number.isInteger(index) || index < 0 || index >= row.segment_count) return notFound();
	const manifest = await readManifest(env, row);
	if (!manifest) return notFound();
	const all: TraceEvent[][] = [];
	for (let segment = 0; segment < row.segment_count; segment++) all.push((await readSegment(env, row, segment)) || []);
	const typed = profile as TraceProfile;
	const droppedCallIds = profileDroppedCallIds(all.flat(), typed);
	const events = applyProfileToEvents(all[index], typed, { droppedCallIds, keepAttachment: attachmentKeeper(manifest, typed) });
	return ok({ manifest: applyProfileToManifest(manifest, typed), segment: index, events });
}

export async function handleDeleteTrace(env: Env, access: TraceAccess, traceId: string) {
	const row = await getTrace(env.DB, access.project.id, traceId);
	if (!row || !(await canDeleteTrace(env, access.project, row, access.viewer))) return notFound();
	await deleteTrace(env, row);
	return ok({ deleted: true, traceId: row.id });
}
