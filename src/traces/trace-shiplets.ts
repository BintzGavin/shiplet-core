// Trace-only Shiplets (docs/traces-spec.md D19). A Shiplet made to share an
// agent session on its own is an ordinary Shiplet: same access, revisions,
// lifecycle, and URLs. Its artifact is a small page Shiplet writes, and its
// detail page shows the trace viewer where the artifact frame would be. A
// marker row records which Shiplets were made this way, so no Shiplet type or
// source type changes.
import type { Env } from "../env";
import type { Project } from "../types";
import { traceError, tracesAvailable, type TraceActor } from "./access";
import { ok } from "./handlers";

export const TRACE_SHIPLET_NAME_MAX = 120;

export type TraceShipletCreator = (
	env: Env,
	input: { actor: TraceActor; organizationId: string | null; name: string; subdomain: string; html: string },
) => Promise<Project>;

let creator: TraceShipletCreator | null = null;

// index.ts owns Shiplet creation; it registers the creator at startup so this
// module does not import it (and create a cycle).
export function setTraceShipletCreator(next: TraceShipletCreator) {
	creator = next;
}

export async function ensureTraceShipletSchema(db: D1Database) {
	await db.prepare(
		`CREATE TABLE IF NOT EXISTS trace_shiplets (
			project_id TEXT PRIMARY KEY,
			created_on TEXT NOT NULL
		)`,
	).run();
}

export async function isTraceOnlyShiplet(db: D1Database, projectId: string) {
	try {
		return Boolean(await db.prepare("SELECT project_id FROM trace_shiplets WHERE project_id = ?").bind(projectId).first());
	} catch {
		// Before the trace schema exists, no Shiplet is trace-only.
		return false;
	}
}

const escapeHtml = (value: string) =>
	value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

export function traceShipletPlaceholderHtml(name: string, appUrl: string) {
	const app = escapeHtml(appUrl.replace(/\/$/, ""));
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; background: #f6f1e7; color: #13202d; }
main { max-width: 520px; padding: 32px; }
h1 { font-size: 24px; margin: 0 0 8px; }
a { color: #b4401f; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(name)}</h1>
<p>This Shiplet shares an agent session. A trace is the full log of an agent session: the prompts, the agent's replies, and every tool call and result.</p>
<p>Open this Shiplet in <a href="${app}/" target="_top" rel="noreferrer">the Shiplet app</a> to read the trace.</p>
</main>
</body>
</html>
`;
}

function randomSuffix() {
	const bytes = crypto.getRandomValues(new Uint8Array(5));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function handleCreateTraceShiplet(env: Env, actor: TraceActor, body: unknown, appUrl: string) {
	const unavailable = tracesAvailable(env);
	if (unavailable) return unavailable;
	if (!creator) return traceError(503, "trace_shiplets_unavailable", "Trace-only Shiplets are not available on this server.");
	if (actor.kind === "anonymous") return traceError(401, "unauthorized", "Sign in to share a session.");
	if (actor.kind === "token" && !actor.token.scopes.includes("traces:write")) {
		return traceError(403, "forbidden", "This API key needs traces:write.");
	}
	const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	const name = typeof input.name === "string" ? input.name.trim().slice(0, TRACE_SHIPLET_NAME_MAX) : "";
	if (!name) return traceError(400, "invalid_request", "name is required: a short title for the session.");
	const organizationId = typeof input.organizationId === "string" && input.organizationId.trim() ? input.organizationId.trim() : null;
	const subdomain = `trace-${randomSuffix()}`;
	let project: Project;
	try {
		project = await creator(env, { actor, organizationId, name, subdomain, html: traceShipletPlaceholderHtml(name, appUrl) });
	} catch (error) {
		if (error instanceof Response) {
			const text = await error.text().catch(() => "");
			let parsed: { code?: string; error?: string; organizations?: unknown } | null = null;
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = null;
			}
			if (parsed?.code === "organization_required") {
				return traceError(400, "organization_required", "Choose an organization with organizationId.", { organizations: parsed.organizations });
			}
			return traceError(error.status, error.status === 403 ? "forbidden" : "invalid_request", text || "Shiplet creation failed.");
		}
		throw error;
	}
	await env.DB.prepare("INSERT OR IGNORE INTO trace_shiplets (project_id, created_on) VALUES (?, ?)")
		.bind(project.id, new Date().toISOString())
		.run();
	const base = appUrl.replace(/\/$/, "");
	return ok(
		{
			shiplet: {
				id: project.id,
				name: project.name,
				organizationId: project.organization_id ?? null,
				visibility: project.visibility,
				traceOnly: true,
				url: `${base}/shiplets/${project.id}`,
			},
			next: [
				`Upload the session: npx shiplet-cli trace share --current --shiplet ${project.id}`,
				`Or over MCP: POST /api/shiplets/${project.id}/trace-uploads for an upload link.`,
			],
		},
		201,
	);
}
