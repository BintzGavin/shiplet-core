// REST routes for the hosted Agent Handshake relay. The same operations are
// reachable from Shiplet MCP through Code Mode (./codemode).
import type { Context, Hono } from "hono";
import type { Env } from "../env";
import { getCurrentUser } from "../auth";
import { authenticateOrganizationApiToken } from "../org-api-tokens";
import { readBodyWithLimit } from "../traces/routes";
import {
	admitToOrganization,
	handleCloseSession,
	handleDuty,
	handleExport,
	handleListHandshakes,
	handleListPeers,
	handleOpenSession,
	handleReadInbox,
	handleSend,
	handshakeError,
	handshakesAvailable,
	type EmbedBinding,
	type HandshakeActor,
	type HandshakeMember,
} from "./handlers";
import type { ShipletUser } from "../store";

const BODY_LIMIT = 80 * 1024; // one 64 KiB message plus its envelope

// Resolves the website widget's embed review session (the request carries
// `installation_id`) to the person it signed in. It may throw a Response, as
// the embed routes do.
// biome-ignore lint/suspicious/noExplicitAny: the Worker's Hono context carries app-specific variables.
export type EmbedActorResolver = (c: Context<any>) => Promise<({ user: ShipletUser } & EmbedBinding) | Response>;

export type HandshakeRouteOptions = { embedActor?: EmbedActorResolver };

// The trusted review frame of the website widget, on Shiplet's own origin. Its
// embed cookie is SameSite=None, so the request itself must show it came from
// that frame: a same-origin fetch, with Shiplet's own Origin on changes.
// biome-ignore lint/suspicious/noExplicitAny: the Worker's Hono context carries app-specific variables.
async function embedActorFromRequest(c: Context<any>, resolve: EmbedActorResolver): Promise<HandshakeActor | Response> {
	const request = c.req.raw;
	const notFromFrame = handshakeError(403, "forbidden", "Handshake changes must come from Shiplet itself.");
	if (request.headers.get("sec-fetch-site") !== "same-origin" || request.headers.get("authorization")) return notFromFrame;
	if (request.method !== "GET" && request.headers.get("origin") !== new URL(request.url).origin) return notFromFrame;
	let resolved: Awaited<ReturnType<EmbedActorResolver>>;
	try {
		resolved = await resolve(c);
	} catch (error) {
		if (!(error instanceof Response)) throw error;
		resolved = error;
	}
	if (resolved instanceof Response) {
		// The resolver's own JSON refusals (an actor mismatch) pass through.
		if (resolved.headers.get("content-type")?.includes("application/json") && resolved.status !== 401) return resolved;
		if (resolved.status === 401) return handshakeError(401, "embed_session_expired", "Your Shiplet sign-in on this site ended. Sign in again to keep talking.");
		if (resolved.status === 400) return handshakeError(400, "bad_request", "The website widget's review binding is missing.");
		return handshakeError(403, "forbidden", "This review session cannot join agent handshakes.");
	}
	const { user, projectId, installationId } = resolved;
	return { kind: "user", user, browser: true, embed: { projectId, installationId } };
}

// biome-ignore lint/suspicious/noExplicitAny: the Worker's Hono context carries app-specific variables.
async function actorFromRequest(c: Context<any>, options: HandshakeRouteOptions): Promise<HandshakeActor | Response> {
	const { env } = c;
	const request = c.req.raw;
	const user = await getCurrentUser(request, env);
	if (user) {
		// A browser session only acts from Shiplet's own pages.
		const site = request.headers.get("sec-fetch-site");
		if (request.method !== "GET" && site && site !== "same-origin" && site !== "none") {
			return handshakeError(403, "forbidden", "Handshake changes must come from Shiplet itself.");
		}
		// A page on Shiplet's own origin, signed in with the browser session
		// (not a CLI session, which sends an Authorization header). Only this
		// actor may join as a person.
		const browser = site === "same-origin" && !request.headers.get("authorization");
		return { kind: "user", user, browser };
	}
	const authorization = request.headers.get("authorization")?.trim();
	if (authorization) {
		const token = await authenticateOrganizationApiToken(env.DB, authorization);
		if (token) return { kind: "token", token };
		return handshakeError(401, "unauthorized", "Sign in, or send an organization API key with the mcp scope.");
	}
	if (options.embedActor && new URL(request.url).searchParams.get("installation_id")) return embedActorFromRequest(c, options.embedActor);
	return handshakeError(401, "unauthorized", "Sign in, or send an organization API key with the mcp scope.");
}

// biome-ignore lint/suspicious/noExplicitAny: the Worker's Hono context carries app-specific variables.
async function member(c: Context<any>, options: HandshakeRouteOptions): Promise<HandshakeMember | Response> {
	const env = c.env as Env;
	const unavailable = handshakesAvailable(env);
	if (unavailable) return unavailable;
	const actor = await actorFromRequest(c, options);
	if (actor instanceof Response) return actor;
	return admitToOrganization(env, actor, c.req.param("organizationId") ?? "");
}

async function readJson(request: Request): Promise<unknown | Response> {
	try {
		const bytes = await readBodyWithLimit(request, BODY_LIMIT);
		return bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {};
	} catch (error) {
		if (error instanceof SyntaxError) return handshakeError(400, "invalid_json", "The body must be JSON.");
		return handshakeError(413, "payload_too_large", "The request body is too large.");
	}
}

// biome-ignore lint/suspicious/noExplicitAny: the Worker's Hono app carries app-specific variables.
export function registerHandshakeRoutes(app: Hono<any>, options: HandshakeRouteOptions = {}) {
	const organization = "/api/organizations/:organizationId";
	const session = `${organization}/handshake-sessions/:sessionId`;

	app.get(`${organization}/handshakes`, async (c) => {
		const admitted = await member(c, options);
		return admitted instanceof Response ? admitted : handleListHandshakes(c.env, admitted);
	});

	app.post(`${organization}/handshake-sessions`, async (c) => {
		const admitted = await member(c, options);
		if (admitted instanceof Response) return admitted;
		const body = await readJson(c.req.raw);
		return body instanceof Response ? body : handleOpenSession(c.env, admitted, body);
	});

	app.delete(session, async (c) => {
		const admitted = await member(c, options);
		return admitted instanceof Response ? admitted : handleCloseSession(c.env, admitted, c.req.param("sessionId"));
	});

	app.get(`${session}/peers`, async (c) => {
		const admitted = await member(c, options);
		return admitted instanceof Response ? admitted : handleListPeers(c.env, admitted, c.req.param("sessionId"));
	});

	app.post(`${session}/messages`, async (c) => {
		const admitted = await member(c, options);
		if (admitted instanceof Response) return admitted;
		const body = await readJson(c.req.raw);
		return body instanceof Response ? body : handleSend(c.env, admitted, c.req.param("sessionId"), body);
	});

	app.get(`${session}/inbox`, async (c) => {
		const admitted = await member(c, options);
		return admitted instanceof Response ? admitted : handleReadInbox(c.env, admitted, c.req.param("sessionId"), c.req.query("wait"));
	});

	app.post(`${session}/duty`, async (c) => {
		const admitted = await member(c, options);
		if (admitted instanceof Response) return admitted;
		const body = await readJson(c.req.raw);
		return body instanceof Response ? body : handleDuty(c.env, admitted, c.req.param("sessionId"), body);
	});

	app.post(`${session}/handshakes/:handshakeId/export`, async (c) => {
		const admitted = await member(c, options);
		if (admitted instanceof Response) return admitted;
		return handleExport(c.env, admitted, c.req.param("sessionId"), c.req.param("handshakeId"));
	});
}
