// Upload links (D7). MCP requests are capped at 128 KiB, and copying a session
// through a model's tool arguments wastes its context, so an MCP call creates a
// short-lived link and the CLI or curl sends the bytes to it. The link carries
// the creator's authority for one trace on one Shiplet for 30 minutes, and the
// creator's access is checked again when it is used.
import { sha256Hex } from "../cli/trace-core.mjs";
import type { Env } from "../env";
import { authorizeTraceActor, loadTraceProject, storedTraceActor, traceError, tracesAvailable, type TraceAccess } from "./access";
import { ok } from "./handlers";

export const UPLOAD_LINK_TTL_MS = 30 * 60 * 1000;
const TOKEN_PATTERN = /^shiplet_trace_upload_[a-f0-9]{64}$/;

type TicketRow = {
	token_hash: string;
	project_id: string;
	organization_id: string | null;
	actor_kind: string;
	actor_id: string;
	trace_id: string | null;
	expires_on: string;
	created_on: string;
};

export async function ensureTraceUploadSchema(db: D1Database) {
	await db.batch([
		db.prepare(
			`CREATE TABLE IF NOT EXISTS trace_upload_links (
				token_hash TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				organization_id TEXT,
				actor_kind TEXT NOT NULL,
				actor_id TEXT NOT NULL,
				trace_id TEXT,
				expires_on TEXT NOT NULL,
				created_on TEXT NOT NULL
			)`,
		),
		db.prepare("CREATE INDEX IF NOT EXISTS trace_upload_links_expiry ON trace_upload_links(expires_on)"),
	]);
}

function randomToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `shiplet_trace_upload_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function handleCreateUploadLink(env: Env, access: TraceAccess, origin: string) {
	const actor = access.token ? { kind: "token", id: access.token.id } : access.user ? { kind: "user", id: access.user.id } : null;
	if (!actor) return traceError(401, "unauthorized", "Sign in to add a trace.");
	const token = randomToken();
	const now = Date.now();
	const expiresOn = new Date(now + UPLOAD_LINK_TTL_MS).toISOString();
	await env.DB.prepare(
		`INSERT INTO trace_upload_links (token_hash, project_id, organization_id, actor_kind, actor_id, expires_on, created_on)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(await sha256Hex(token), access.project.id, access.project.organization_id ?? null, actor.kind, actor.id, expiresOn, new Date(now).toISOString())
		.run();
	const uploadUrl = `${origin.replace(/\/$/, "")}/api/trace-uploads/${token}`;
	return ok(
		{
			uploadUrl,
			expiresOn,
			instructions: [
				`To upload the session you are in, run: npx shiplet-cli trace share --current --upload-url '${uploadUrl}'`,
				"The CLI masks secrets on this computer first and attaches screenshots, videos, and PDFs the session produced.",
				`POST the upload JSON (at most 16 MiB) to uploadUrl with content-type application/json, for example: curl -X POST -H 'content-type: application/json' --data-binary @trace.json '${uploadUrl}'`,
				"Then PUT each pending attachment's bytes to uploadUrl + '/attachments/<sha256>'.",
				"The link works for one trace and expires in 30 minutes. Treat it like a password.",
			],
		},
		201,
	);
}

// Resolves an upload link to the access of the actor who created it.
export async function accessForUploadLink(env: Env, token: string): Promise<{ access: TraceAccess; link: TicketRow } | Response> {
	const unavailable = tracesAvailable(env);
	if (unavailable) return unavailable;
	if (!TOKEN_PATTERN.test(token)) return traceError(404, "upload_link_not_found", "This upload link is invalid or expired.");
	const link = await env.DB.prepare("SELECT * FROM trace_upload_links WHERE token_hash = ?").bind(await sha256Hex(token)).first<TicketRow>();
	if (!link || Date.parse(link.expires_on) <= Date.now()) {
		return traceError(404, "upload_link_not_found", "This upload link is invalid or expired.");
	}
	const project = await loadTraceProject(env, link.project_id);
	if (!project) return traceError(404, "upload_link_not_found", "This upload link is invalid or expired.");
	const actor = await storedTraceActor(env, link.actor_kind, link.actor_id, link.organization_id);
	if (!actor) return traceError(403, "forbidden", "The account that created this upload link can no longer add traces.");
	const access = await authorizeTraceActor(env, project, actor, "write");
	if (access instanceof Response) return access;
	return { access, link };
}

export async function markUploadLinkUsed(env: Env, link: TicketRow, traceId: string) {
	await env.DB.prepare("UPDATE trace_upload_links SET trace_id = ? WHERE token_hash = ?").bind(traceId, link.token_hash).run();
}

export async function sweepExpiredUploadLinks(env: Env, now = Date.now()) {
	await env.DB.prepare("DELETE FROM trace_upload_links WHERE expires_on <= ?").bind(new Date(now).toISOString()).run();
}
