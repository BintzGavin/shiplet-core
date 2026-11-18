// Code Mode MCP for traces (slice 3). Agents reach the same handlers as REST,
// through `execute` and codemode.request(...). Uploads go through an upload
// link because MCP request bodies are capped at 128 KiB (D7); attachment bytes
// are not served here.
import type { Env } from "../env";
import type { AuthenticatedMcpAgentPrincipal } from "../mcp-principal";
import type { OrganizationApiTokenRecord } from "../org-api-tokens";
import type { ShipletUser } from "../store";
import { authorizeTraceActor, loadTraceProject, notFound, traceError, tracesAvailable, type TraceActor, type TraceMode } from "./access";
import {
	handleDeleteTrace,
	handleGetAudiences,
	handleGetContext,
	handleGetSegment,
	handleGetTrace,
	handleListReadableTraces,
	handleListTraces,
	handlePreview,
	handlePutAudiences,
} from "./handlers";
import { handleCreateTraceShiplet } from "./trace-shiplets";
import { handleCreateUploadLink } from "./uploads";

export type TraceCodeModeContext =
	| { kind: "user"; user: ShipletUser }
	| { kind: "token"; token: OrganizationApiTokenRecord }
	| { kind: "oauth_agent"; principal: AuthenticatedMcpAgentPrincipal };

type Request = {
	method: string;
	path: string;
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
};

const PROJECT = "/api/shiplets/([^/]+)";
const ROUTES: Array<{ method: string; pattern: RegExp; mode: TraceMode; name: string }> = [
	{ method: "GET", pattern: /^\/api\/traces$/, mode: "read", name: "listReadable" },
	{ method: "POST", pattern: /^\/api\/trace-shiplets$/, mode: "write", name: "createShiplet" },
	{ method: "GET", pattern: new RegExp(`^${PROJECT}/traces$`), mode: "read", name: "list" },
	{ method: "GET", pattern: new RegExp(`^${PROJECT}/traces/([^/]+)$`), mode: "read", name: "get" },
	{ method: "GET", pattern: new RegExp(`^${PROJECT}/traces/([^/]+)/segments/([^/]+)$`), mode: "read", name: "segment" },
	{ method: "GET", pattern: new RegExp(`^${PROJECT}/traces/([^/]+)/context$`), mode: "read", name: "context" },
	{ method: "GET", pattern: new RegExp(`^${PROJECT}/traces/([^/]+)/audiences$`), mode: "read", name: "getAudiences" },
	{ method: "PUT", pattern: new RegExp(`^${PROJECT}/traces/([^/]+)/audiences$`), mode: "delete", name: "putAudiences" },
	{ method: "POST", pattern: new RegExp(`^${PROJECT}/traces/([^/]+)/preview$`), mode: "read", name: "preview" },
	{ method: "DELETE", pattern: new RegExp(`^${PROJECT}/traces/([^/]+)$`), mode: "delete", name: "delete" },
	{ method: "POST", pattern: new RegExp(`^${PROJECT}/trace-uploads$`), mode: "write", name: "uploadLink" },
];

export function isTraceCodeModePath(path: string) {
	return /^\/api\/(?:traces|trace-shiplets)$/.test(path) || /^\/api\/shiplets\/[^/]+\/(?:traces|trace-uploads)(?:\/|$)/.test(path);
}

function actorFor(context: TraceCodeModeContext, mode: TraceMode, projectOrganizationId: string | null): TraceActor | Response {
	if (context.kind === "user") return { kind: "user", user: context.user };
	if (context.kind === "token") return { kind: "token", token: context.token };
	const permission = mode === "read" ? "traces:read" : "traces:write";
	if (!context.principal.permissions.includes(permission)) {
		return traceError(403, "forbidden", `This agent needs the ${permission} permission.`);
	}
	if (projectOrganizationId !== null && context.principal.organizationId !== projectOrganizationId) return notFound();
	return { kind: "user", user: context.principal.subject };
}

async function unwrap(response: Response) {
	if (!response.ok) throw response;
	if (response.status === 204) return { ok: true };
	return response.json();
}

export async function executeTraceCodeModeRequest(env: Env, context: TraceCodeModeContext, request: Request, origin: string) {
	const unavailable = tracesAvailable(env);
	if (unavailable) throw unavailable;
	const route = ROUTES.find((candidate) => candidate.method === request.method && candidate.pattern.test(request.path));
	if (!route) throw new Response("Code Mode request path is not supported.", { status: 404 });
	const [, projectId, traceId, extra] = request.path.match(route.pattern) || [];
	const query = request.query || {};

	if (route.name === "listReadable") {
		const actor = actorFor(context, "read", null);
		if (actor instanceof Response) throw actor;
		if (context.kind === "oauth_agent") {
			// Delegated agents see only their selected organization.
			const response = await handleListReadableTraces(env, actor, { limit: query.limit });
			const body = (await unwrap(response)) as { traces: Array<{ projectId: string }> };
			const organizationId = context.principal.organizationId;
			const allowed = [];
			for (const trace of body.traces) {
				const project = await loadTraceProject(env, trace.projectId);
				if (project && project.organization_id === organizationId) allowed.push(trace);
			}
			return { traces: allowed };
		}
		return unwrap(await handleListReadableTraces(env, actor, { limit: query.limit }));
	}

	if (route.name === "createShiplet") {
		const actor = actorFor(context, "write", null);
		if (actor instanceof Response) throw actor;
		const body = { ...((request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>) };
		if (context.kind === "oauth_agent") {
			// Delegated agents create Shiplets only in their selected organization.
			if (body.organizationId && body.organizationId !== context.principal.organizationId) throw notFound();
			body.organizationId = context.principal.organizationId;
		}
		return unwrap(await handleCreateTraceShiplet(env, actor, body, origin));
	}

	const project = await loadTraceProject(env, decodeURIComponent(projectId));
	if (!project) throw notFound();
	const actor = actorFor(context, route.mode, project.organization_id ?? null);
	if (actor instanceof Response) throw actor;
	const access = await authorizeTraceActor(env, project, actor, route.mode);
	if (access instanceof Response) throw access;
	const id = traceId ? decodeURIComponent(traceId) : "";
	switch (route.name) {
		case "list":
			return unwrap(await handleListTraces(env, access, { cursor: query.cursor === undefined ? null : String(query.cursor), limit: query.limit }));
		case "get":
			return unwrap(await handleGetTrace(env, access, id));
		case "segment":
			return unwrap(await handleGetSegment(env, access, id, decodeURIComponent(extra)));
		case "context":
			return unwrap(await handleGetContext(env, access, id, query.maxTokens));
		case "getAudiences":
			return unwrap(await handleGetAudiences(env, access, id));
		case "putAudiences":
			return unwrap(await handlePutAudiences(env, access, id, request.body));
		case "preview":
			return unwrap(await handlePreview(env, access, id, request.body, query.segment));
		case "delete":
			return unwrap(await handleDeleteTrace(env, access, id));
		case "uploadLink":
			return unwrap(await handleCreateUploadLink(env, access, origin));
	}
	throw new Response("Code Mode request path is not supported.", { status: 404 });
}
