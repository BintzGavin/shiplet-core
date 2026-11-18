// Who may read, write, or delete traces on a Shiplet (docs/traces-spec.md).
// Reads and deletes never reveal whether a trace or Shiplet exists: every
// refusal is 404 not_found. HTTP requests and Code Mode MCP calls both end in
// authorizeTraceActor, so the rules are the same on every surface.
import type { Env } from "../env";
import { getCurrentUser } from "../auth";
import { cliSessionHasScope } from "../cli-session";
import { TRACES_FLAG, useFeatureFlag } from "../feature-flags";
import {
	authenticateOrganizationApiToken,
	canOrganizationApiTokenAccessProject,
	listOrganizationApiTokens,
	type OrganizationApiTokenRecord,
} from "../org-api-tokens";
import { canEditProject, canViewProject, getProjectById, getUser, type ShipletUser } from "../store";
import type { Project } from "../types";
import type { TraceViewer } from "./audiences";
import type { TraceReader } from "./store";

export type TraceMode = "read" | "write" | "delete";

export type TraceActor =
	| { kind: "user"; user: ShipletUser }
	| { kind: "token"; token: OrganizationApiTokenRecord }
	| { kind: "anonymous" };

export type TraceAccess = {
	project: Project;
	reader: TraceReader;
	viewer: TraceViewer;
	user: ShipletUser | null;
	token: OrganizationApiTokenRecord | null;
};

export function traceError(status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
	return Response.json({ error, message, ...extra }, { status });
}

export const notFound = () => traceError(404, "not_found", "Trace not found.");

export function tracesAvailable(env: Env): Response | null {
	if (!useFeatureFlag(env, TRACES_FLAG)) {
		return traceError(404, "traces_not_enabled", "Traces are not enabled on this server.");
	}
	if (!env.REVIEW_ASSETS) {
		return traceError(503, "traces_storage_unavailable", "Traces need the REVIEW_ASSETS storage binding.");
	}
	return null;
}

export async function authorizeTraceActor(
	env: Env,
	project: Project,
	actor: TraceActor,
	mode: TraceMode,
): Promise<TraceAccess | Response> {
	if (actor.kind === "token") {
		const { token } = actor;
		const scope = mode === "read" ? "traces:read" : "traces:write";
		const allowed = token.scopes.includes(scope) && canOrganizationApiTokenAccessProject(token, project);
		if (!allowed) {
			return mode === "write"
				? traceError(403, "forbidden", `This API key needs ${scope} and access to this Shiplet.`)
				: notFound();
		}
		if (mode === "write" && project.archived_on) {
			return traceError(409, "shiplet_archived", "Restore this Shiplet before adding traces.");
		}
		return { project, token, user: null, reader: { kind: "api_key", id: token.id }, viewer: { kind: "api_key", tokenId: token.id } };
	}
	if (actor.kind === "anonymous") {
		// Anonymous visitors of a public or unlisted Shiplet can read traces
		// shared with a "link" audience, and nothing else.
		if (mode !== "read") return mode === "write" ? traceError(401, "unauthorized", "Sign in to add a trace.") : notFound();
		if (!(await canViewProject(env.DB, project))) return notFound();
		return { project, token: null, user: null, reader: { kind: "anonymous" }, viewer: { kind: "anonymous" } };
	}
	const { user } = actor;
	if (mode === "write") {
		if (!(await canEditProject(env.DB, project, user))) {
			return traceError(403, "forbidden", "Shiplet editor access is required to add a trace.");
		}
		if (project.archived_on) {
			return traceError(409, "shiplet_archived", "Restore this Shiplet before adding traces.");
		}
	} else if (!(await canViewProject(env.DB, project, user.id))) {
		return notFound();
	}
	return {
		project,
		token: null,
		user,
		reader: { kind: "user", id: user.id, isShipletOwner: project.owner_user_id === user.id },
		viewer: { kind: "user", user },
	};
}

export async function loadTraceProject(env: Env, projectId: string) {
	return (await getProjectById(env.DB, projectId)) as Project | null;
}

// The caller of an HTTP request: a CLI session, an organization API key, a
// signed-in browser, or nobody.
export async function traceActorFromRequest(env: Env, request: Request, mode: TraceMode): Promise<TraceActor | Response> {
	const cliScope = await cliSessionHasScope(env.DB, request, mode === "read" ? "trace:read" : "trace:write");
	if (cliScope === false) {
		return traceError(
			401,
			"cli_session_reauth_required",
			"This CLI session cannot use traces. Sign in again to approve a new session.",
		);
	}
	const authorization = request.headers.get("authorization")?.trim() || "";
	if (authorization && cliScope === null) {
		const token = await authenticateOrganizationApiToken(env.DB, authorization);
		if (!token) return traceError(401, "unauthorized", "Invalid or revoked authorization credential.");
		return { kind: "token", token };
	}
	const user = await getCurrentUser(request, env);
	if (user) {
		// A browser session only changes traces from Shiplet's own pages.
		const site = request.headers.get("sec-fetch-site");
		if (mode !== "read" && site && site !== "same-origin" && site !== "none") {
			return traceError(403, "forbidden", "Trace changes must come from Shiplet itself.");
		}
		return { kind: "user", user };
	}
	if (authorization) return mode === "write" ? traceError(401, "unauthorized", "Sign in to add a trace.") : notFound();
	return { kind: "anonymous" };
}

export async function resolveTraceAccess(
	env: Env,
	request: Request,
	projectId: string,
	mode: TraceMode,
): Promise<TraceAccess | Response> {
	const unavailable = tracesAvailable(env);
	if (unavailable) return unavailable;
	const project = await loadTraceProject(env, projectId);
	if (!project) return notFound();
	const actor = await traceActorFromRequest(env, request, mode);
	if (actor instanceof Response) return actor;
	return authorizeTraceActor(env, project, actor, mode);
}

// Rebuilds a stored actor (for example, the creator of an upload link) and
// re-checks that it is still valid now.
export async function storedTraceActor(env: Env, kind: string, id: string, organizationId: string | null): Promise<TraceActor | null> {
	if (kind === "user") {
		const user = (await getUser(env.DB, id)) as ShipletUser | null;
		return user ? { kind: "user", user } : null;
	}
	if (kind === "token" && organizationId) {
		const token = (await listOrganizationApiTokens(env.DB, organizationId)).find((record) => record.id === id);
		return token && !(token as { revoked_on?: string | null }).revoked_on ? { kind: "token", token: token as OrganizationApiTokenRecord } : null;
	}
	return null;
}
