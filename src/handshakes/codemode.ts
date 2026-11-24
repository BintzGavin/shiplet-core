// Code Mode MCP for the handshake relay: agents connected to Shiplet MCP reach
// the same handlers as REST through `execute` and codemode.request(...).
import type { Env } from "../env";
import type { AuthenticatedMcpAgentPrincipal } from "../mcp-principal";
import type { OrganizationApiTokenRecord } from "../org-api-tokens";
import type { ShipletUser } from "../store";
import {
	admitToOrganization,
	handleCloseSession,
	handleExport,
	handleWebhook,
	handleListHandshakes,
	handleListPeers,
	handleOpenSession,
	handleReadInbox,
	handleSend,
	handshakesAvailable,
	type HandshakeActor,
} from "./handlers";

export type HandshakeCodeModeContext =
	| { kind: "user"; user: ShipletUser }
	| { kind: "token"; token: OrganizationApiTokenRecord }
	| { kind: "oauth_agent"; principal: AuthenticatedMcpAgentPrincipal };

type Request = {
	method: string;
	path: string;
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
};

const ORGANIZATION = "/api/organizations/([^/]+)";
const SESSION = `${ORGANIZATION}/handshake-sessions/([^/]+)`;
const ROUTES: Array<{ method: string; pattern: RegExp; name: string }> = [
	{ method: "GET", pattern: new RegExp(`^${ORGANIZATION}/handshakes$`), name: "list" },
	{ method: "POST", pattern: new RegExp(`^${ORGANIZATION}/handshake-sessions$`), name: "open" },
	{ method: "DELETE", pattern: new RegExp(`^${SESSION}$`), name: "close" },
	{ method: "GET", pattern: new RegExp(`^${SESSION}/peers$`), name: "peers" },
	{ method: "POST", pattern: new RegExp(`^${SESSION}/messages$`), name: "send" },
	{ method: "GET", pattern: new RegExp(`^${SESSION}/inbox$`), name: "inbox" },
	{ method: "POST", pattern: new RegExp(`^${SESSION}/webhook$`), name: "webhook" },
	{ method: "POST", pattern: new RegExp(`^${SESSION}/handshakes/([^/]+)/export$`), name: "export" },
];

export function isHandshakeCodeModePath(path: string) {
	return /^\/api\/organizations\/[^/]+\/(?:handshakes|handshake-sessions)(?:\/|$)/.test(path);
}

async function unwrap(response: Response) {
	if (!response.ok) throw response;
	if (response.status === 204) return { ok: true };
	return response.json();
}

export async function executeHandshakeCodeModeRequest(env: Env, context: HandshakeCodeModeContext, request: Request) {
	const unavailable = handshakesAvailable(env);
	if (unavailable) throw unavailable;
	const route = ROUTES.find((candidate) => candidate.method === request.method && candidate.pattern.test(request.path));
	if (!route) throw new Response("Code Mode request path is not supported.", { status: 404 });
	const [, organizationId, sessionId, handshakeId] = (request.path.match(route.pattern) || []).map((part) => (part ? decodeURIComponent(part) : part));
	const member = await admitToOrganization(env, context as HandshakeActor, organizationId);
	if (member instanceof Response) throw member;
	switch (route.name) {
		case "list":
			return unwrap(await handleListHandshakes(env, member));
		case "open":
			return unwrap(await handleOpenSession(env, member, request.body));
		case "close":
			return unwrap(await handleCloseSession(env, member, sessionId));
		case "peers":
			return unwrap(await handleListPeers(env, member, sessionId));
		case "send":
			return unwrap(await handleSend(env, member, sessionId, request.body));
		case "inbox":
			return unwrap(await handleReadInbox(env, member, sessionId, request.query?.wait));
		case "export":
			return unwrap(await handleExport(env, member, sessionId, handshakeId));
		case "webhook":
			// Shiplet's own host is refused inside handleWebhook from SHIPLET_APP_URL.
			return unwrap(await handleWebhook(env, member, sessionId, request.body, "https://shiplet.invalid/"));
	}
	throw new Response("Code Mode request path is not supported.", { status: 404 });
}
