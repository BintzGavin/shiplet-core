// Who may use an organization's handshake relay, and the operations REST and
// Code Mode MCP share. Access is the organization: any authenticated agent
// acting for a member (an MCP OAuth agent with the organization selected, an
// organization API key with the mcp scope, a CLI session or a signed-in
// person) can open a session, list peers, send and read. Tying a handshake to
// an annotation needs read access to that annotation's Shiplet, and anyone
// listing handshakes sees the annotation only if they can read it too.
import type { Env } from "../env";
import { AGENT_HANDSHAKES_FLAG, useFeatureFlag } from "../feature-flags";
import type { AuthenticatedMcpAgentPrincipal } from "../mcp-principal";
import { canOrganizationApiTokenAccessProject, type OrganizationApiTokenRecord } from "../org-api-tokens";
import { getReviewFeedback } from "../review";
import { canViewProject, getOrganizationMembership, getProjectById, type ShipletUser } from "../store";
import type { Project } from "../types";
import { PERSON_KIND, VISITOR_KIND, type HandshakeSnapshot } from "../../packages/agent-handshake/src/core/protocol.js";
import type { HandshakeRelay, RelayFailure, RelayOwner, RelaySendInput } from "./relay";

export type HandshakeActor =
	// browser: a page on Shiplet's own origin with the person's browser session.
	// embed: the trusted review frame of the website widget, signed in with its
	// embed review session for one Shiplet (the platform session cannot reach a
	// third-party frame). It may only be a person in its own session.
	| { kind: "user"; user: ShipletUser; browser?: boolean; embed?: EmbedBinding }
	| { kind: "token"; token: OrganizationApiTokenRecord }
	| { kind: "oauth_agent"; principal: AuthenticatedMcpAgentPrincipal };

export type EmbedBinding = { projectId: string; installationId: string };

// An actor admitted to one organization's relay.
export type HandshakeMember = { organizationId: string; owner: RelayOwner; actor: HandshakeActor };

export function handshakeError(status: number, error: string, message: string) {
	return Response.json({ error, message }, { status });
}

const notFound = () => handshakeError(404, "not_found", "No handshake relay for that organization.");

const embedBinding = (actor: HandshakeActor) => (actor.kind === "user" ? (actor.embed ?? null) : null);

// What the website widget may not do: it is a person at one review page, not a
// watcher of the organization.
export function refuseEmbed(member: HandshakeMember) {
	return embedBinding(member.actor) ? handshakeError(403, "forbidden", "The website widget can only talk in its own session.") : null;
}

export function handshakesAvailable(env: Env): Response | null {
	if (!useFeatureFlag(env, AGENT_HANDSHAKES_FLAG) || !env.HANDSHAKE_RELAY) {
		return handshakeError(404, "handshakes_not_enabled", "Agent handshakes are not enabled on this server.");
	}
	return null;
}

export function displayName(user: ShipletUser) {
	return [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.email;
}

export async function admitToOrganization(env: Env, actor: HandshakeActor, organizationId: string): Promise<HandshakeMember | Response> {
	if (!organizationId) return notFound();
	if (actor.kind === "token") {
		if (actor.token.organization_id !== organizationId) return notFound();
		if (!actor.token.scopes.includes("mcp")) return handshakeError(403, "forbidden", "This API key needs the mcp scope to join agent handshakes.");
		return { organizationId, actor, owner: { actor: `token:${actor.token.id}`, account: actor.token.name } };
	}
	if (actor.kind === "oauth_agent") {
		const { principal } = actor;
		if (principal.organizationId !== organizationId) return notFound();
		if (!principal.permissions.includes("mcp")) return handshakeError(403, "forbidden", "This agent needs the mcp permission.");
		if (!(await getOrganizationMembership(env.DB, organizationId, principal.subject.id))) return notFound();
		return { organizationId, actor, owner: { actor: principal.actorId, account: displayName(principal.subject) } };
	}
	if (actor.embed) {
		// Only the organization of the Shiplet the widget session is for.
		const project = (await getProjectById(env.DB, actor.embed.projectId)) as Project | null;
		if (!project || project.organization_id !== organizationId) return notFound();
	}
	if (!(await getOrganizationMembership(env.DB, organizationId, actor.user.id))) return notFound();
	return { organizationId, actor, owner: { actor: `user:${actor.user.id}`, account: displayName(actor.user) } };
}

// Whether this member can read the annotations of a Shiplet in their organization.
async function canReadAnnotations(env: Env, member: HandshakeMember, project: Project) {
	if (project.organization_id !== member.organizationId) return false;
	const { actor } = member;
	if (actor.kind === "token") return actor.token.scopes.includes("feedback:read") && canOrganizationApiTokenAccessProject(actor.token, project);
	if (actor.kind === "oauth_agent") {
		return actor.principal.permissions.includes("feedback:read") && canViewProject(env.DB, project, actor.principal.subject.id);
	}
	return canViewProject(env.DB, project, actor.user.id);
}

// Checks the annotation a handshake is opened for, and returns the reference
// with the server's own label for it.
async function verifyRequest(env: Env, member: HandshakeMember, request: unknown) {
	if (request === undefined || request === null) return null;
	if (typeof request !== "object" || Array.isArray(request)) {
		return handshakeError(400, "bad_request", "request must be { shiplet, feedback }.");
	}
	const { shiplet, feedback } = request as Record<string, unknown>;
	if (typeof shiplet !== "string" || !shiplet || typeof feedback !== "string" || !feedback) {
		return handshakeError(400, "bad_request", "request must be { shiplet, feedback }.");
	}
	const missing = handshakeError(404, "request_not_found", "No annotation you can read with that Shiplet and feedback id.");
	// The website widget ties a handshake only to the Shiplet under review.
	const embed = embedBinding(member.actor);
	if (embed && shiplet !== embed.projectId) return missing;
	const project = (await getProjectById(env.DB, shiplet)) as Project | null;
	if (!project || !(await canReadAnnotations(env, member, project))) return missing;
	const row = (await getReviewFeedback(env.DB, project.id, feedback)) as { id: string; ticket_label?: string | null } | null;
	if (!row) return missing;
	return { shiplet: project.id, feedback: row.id, label: row.ticket_label || null };
}

// The relay's RPC methods, typed directly: the generic stub type is too deep
// for the compiler on these result shapes.
type RelayApi = Pick<
	HandshakeRelay,
	"openSession" | "closeSession" | "peers" | "send" | "read" | "exportHandshake" | "list" | "setDuty" | "dutyStatus" | "openVisitor" | "visitorStatus" | "visitorSend" | "visitorRead"
>;

export function relay(env: Env, organizationId: string): RelayApi {
	const namespace = env.HANDSHAKE_RELAY;
	return namespace.get(namespace.idFromName(`organization:${organizationId}`)) as unknown as RelayApi;
}

type Settled = { ok: true } | RelayFailure;

function respond<T extends Settled>(result: T, status = 200) {
	if (!result.ok) return handshakeError(result.status, result.code, result.message);
	const { ok: _ok, ...body } = result as { ok: true } & Record<string, unknown>;
	return Response.json(body, { status });
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// The Shiplet pages a person can talk from.
export const PERSON_APPS = ["shiplet-dashboard", "shiplet-review", "shiplet-embed"] as const;

export async function handleOpenSession(env: Env, member: HandshakeMember, body: unknown) {
	const input = record(body);
	if (input.kind === VISITOR_KIND) {
		return handshakeError(403, "forbidden", "Visitors join through the website widget, never through the organization relay.");
	}
	if (embedBinding(member.actor) && input.kind !== PERSON_KIND) {
		return handshakeError(403, "embed_person_only", "From the website widget you can only join as yourself, as a person.");
	}
	const peer = input.kind === PERSON_KIND ? personPeer(member, input.app) : { name: input.name, kind: input.kind, app: input.app, machine: input.machine };
	if (peer instanceof Response) return peer;
	const result = await relay(env, member.organizationId).openSession(member.owner, peer);
	return respond(result, 201);
}

// A person joins only from a Shiplet page with their browser session, and the
// relay names them from their account, so the person kind is something an
// agent can rely on.
function personPeer(member: HandshakeMember, app: unknown) {
	const { actor } = member;
	if (actor.kind !== "user" || !actor.browser) {
		return handshakeError(403, "person_requires_browser", "Only a person signed in to Shiplet can join as a person, from a Shiplet page.");
	}
	return {
		name: peerName(displayName(actor.user)),
		kind: PERSON_KIND,
		app: actor.embed ? "shiplet-embed" : (PERSON_APPS as readonly unknown[]).includes(app) ? app : PERSON_APPS[0],
		machine: null,
	};
}

// "Dana Reyes" -> "Dana-Reyes": a handshake name (letters, digits, . _ -).
export function peerName(value: string) {
	const name = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64).replace(/-+$/, "");
	return name || "person";
}

export async function handleCloseSession(env: Env, member: HandshakeMember, sessionId: string) {
	const result = await relay(env, member.organizationId).closeSession(member.owner, sessionId);
	return result.ok ? Response.json({ closed: true }) : respond(result);
}

export async function handleListPeers(env: Env, member: HandshakeMember, sessionId: string) {
	return respond(await relay(env, member.organizationId).peers(member.owner, sessionId));
}

export async function handleSend(env: Env, member: HandshakeMember, sessionId: string, body: unknown) {
	const input = record(body);
	const request = await verifyRequest(env, member, input.request);
	if (request instanceof Response) return request;
	const message: RelaySendInput = {
		to: input.to,
		text: input.text,
		handshake: input.handshake,
		record: input.record,
		topic: input.topic,
		request,
	};
	return respond(await relay(env, member.organizationId).send(member.owner, sessionId, message));
}

export async function handleReadInbox(env: Env, member: HandshakeMember, sessionId: string, wait: unknown) {
	const seconds = Number(wait ?? 0);
	return respond(await relay(env, member.organizationId).read(member.owner, sessionId, Number.isFinite(seconds) ? seconds * 1000 : 0));
}

// Answer a Shiplet's public website visitors (shiplet: id), or stop (null).
// Only someone who can read that Shiplet's annotations may go on duty for it.
export async function handleDuty(env: Env, member: HandshakeMember, sessionId: string, body: unknown) {
	if (embedBinding(member.actor)) return handshakeError(403, "forbidden", "Go on duty from the dashboard or an agent, not from the website widget.");
	const shiplet = record(body).shiplet;
	if (shiplet !== null && (typeof shiplet !== "string" || !shiplet)) {
		return handshakeError(400, "bad_request", "shiplet must be a Shiplet id, or null to go off duty.");
	}
	if (shiplet) {
		const project = (await getProjectById(env.DB, shiplet)) as Project | null;
		if (!project || !(await canReadAnnotations(env, member, project))) {
			return handshakeError(403, "forbidden", "Going on duty needs read access to that Shiplet's annotations.");
		}
	}
	return respond(await relay(env, member.organizationId).setDuty(member.owner, sessionId, shiplet ?? null));
}

export async function handleExport(env: Env, member: HandshakeMember, sessionId: string, handshakeId: string) {
	const refused = refuseEmbed(member);
	if (refused) return refused;
	return respond(await relay(env, member.organizationId).exportHandshake(member.owner, sessionId, handshakeId));
}

// Live handshakes in the organization, as a member sees them. Annotations they
// cannot read are left out of each handshake.
export async function listHandshakesFor(env: Env, member: HandshakeMember): Promise<HandshakeSnapshot[]> {
	const snapshots = await relay(env, member.organizationId).list();
	const readable = new Map<string, boolean>();
	return Promise.all(
		snapshots.map(async (snapshot) => {
			if (!snapshot.request) return snapshot;
			const shiplet = snapshot.request.shiplet;
			if (!readable.has(shiplet)) {
				const project = (await getProjectById(env.DB, shiplet)) as Project | null;
				readable.set(shiplet, Boolean(project && (await canReadAnnotations(env, member, project))));
			}
			return readable.get(shiplet) ? snapshot : { ...snapshot, request: null };
		}),
	);
}

export async function handleListHandshakes(env: Env, member: HandshakeMember) {
	const refused = refuseEmbed(member);
	if (refused) return refused;
	return Response.json({ handshakes: await listHandshakesFor(env, member) });
}
