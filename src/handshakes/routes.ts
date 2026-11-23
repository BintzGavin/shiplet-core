// REST routes for the hosted Agent Handshake relay. The same operations are
// reachable from Shiplet MCP through Code Mode (./codemode).
import type { Hono } from "hono";
import type { Env } from "../env";
import { getCurrentUser } from "../auth";
import { authenticateOrganizationApiToken } from "../org-api-tokens";
import { readBodyWithLimit } from "../traces/routes";
import {
	admitToOrganization,
	handleCloseSession,
	handleExport,
	handleListHandshakes,
	handleListPeers,
	handleOpenSession,
	handleReadInbox,
	handleSend,
	handshakeError,
	handshakesAvailable,
	type HandshakeActor,
	type HandshakeMember,
} from "./handlers";

const BODY_LIMIT = 80 * 1024; // one 64 KiB message plus its envelope

async function actorFromRequest(env: Env, request: Request): Promise<HandshakeActor | Response> {
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
	}
	return handshakeError(401, "unauthorized", "Sign in, or send an organization API key with the mcp scope.");
}

async function member(env: Env, request: Request, organizationId: string): Promise<HandshakeMember | Response> {
	const unavailable = handshakesAvailable(env);
	if (unavailable) return unavailable;
	const actor = await actorFromRequest(env, request);
	if (actor instanceof Response) return actor;
	return admitToOrganization(env, actor, organizationId);
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
export function registerHandshakeRoutes(app: Hono<any>) {
	const organization = "/api/organizations/:organizationId";
	const session = `${organization}/handshake-sessions/:sessionId`;

	app.get(`${organization}/handshakes`, async (c) => {
		const admitted = await member(c.env, c.req.raw, c.req.param("organizationId"));
		return admitted instanceof Response ? admitted : handleListHandshakes(c.env, admitted);
	});

	app.post(`${organization}/handshake-sessions`, async (c) => {
		const admitted = await member(c.env, c.req.raw, c.req.param("organizationId"));
		if (admitted instanceof Response) return admitted;
		const body = await readJson(c.req.raw);
		return body instanceof Response ? body : handleOpenSession(c.env, admitted, body);
	});

	app.delete(session, async (c) => {
		const admitted = await member(c.env, c.req.raw, c.req.param("organizationId"));
		return admitted instanceof Response ? admitted : handleCloseSession(c.env, admitted, c.req.param("sessionId"));
	});

	app.get(`${session}/peers`, async (c) => {
		const admitted = await member(c.env, c.req.raw, c.req.param("organizationId"));
		return admitted instanceof Response ? admitted : handleListPeers(c.env, admitted, c.req.param("sessionId"));
	});

	app.post(`${session}/messages`, async (c) => {
		const admitted = await member(c.env, c.req.raw, c.req.param("organizationId"));
		if (admitted instanceof Response) return admitted;
		const body = await readJson(c.req.raw);
		return body instanceof Response ? body : handleSend(c.env, admitted, c.req.param("sessionId"), body);
	});

	app.get(`${session}/inbox`, async (c) => {
		const admitted = await member(c.env, c.req.raw, c.req.param("organizationId"));
		return admitted instanceof Response ? admitted : handleReadInbox(c.env, admitted, c.req.param("sessionId"), c.req.query("wait"));
	});

	app.post(`${session}/handshakes/:handshakeId/export`, async (c) => {
		const admitted = await member(c.env, c.req.raw, c.req.param("organizationId"));
		if (admitted instanceof Response) return admitted;
		return handleExport(c.env, admitted, c.req.param("sessionId"), c.req.param("handshakeId"));
	});
}
