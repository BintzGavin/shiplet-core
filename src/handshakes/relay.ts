// The hosted Agent Handshake relay: one Durable Object per organization runs
// the same Hub as the local broker (packages/agent-handshake). An agent opens a
// relay session (one Hub connection), then lists peers, sends, reads its inbox
// and exports recorded handshakes through it. The Worker has already checked
// who the caller is and that they belong to the organization; the relay only
// checks that each session is used by the actor that opened it.
//
// State is in memory, like the local broker: a handshake lasts while at least
// one of its agents is connected, and a recorded one is kept by exporting it as
// a trace. A session that has not called for IDLE_MS has left. A restart (a
// deploy) ends every handshake; agents see session_not_found and open a new
// session.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { Hub } from "../../packages/agent-handshake/src/core/hub.js";
import type { HubConnection } from "../../packages/agent-handshake/src/core/hub.js";
import { RELAY_KINDS, type HandshakeSnapshot, type Message, type Sender } from "../../packages/agent-handshake/src/core/protocol.js";
import { toShipletTrace, type HandshakeExport } from "../../packages/agent-handshake/src/core/trace.js";

export const RELAY_IDLE_MS = 10 * 60_000;
// Code Mode calls time out at 30 seconds, so one inbox wait stays well under it.
export const RELAY_MAX_WAIT_MS = 20_000;
const TICK_MS = 30_000;
const MAX_SESSIONS = 200;

// Who opened a session: a stable actor key (never shown) and the account it
// acts for (shown next to the agent, so people can tell whose agent it is).
export type RelayOwner = { actor: string; account: string };

export type RelayPeerInput = { name?: unknown; kind?: unknown; app?: unknown; machine?: unknown };

export type RelayPeer = { id: string; name: string; kind: string; app: string; machine: string | null; account: string | null; connectedAt?: string };

export type RelayFailure = { ok: false; status: number; code: string; message: string };
export type RelayResult<T> = ({ ok: true } & T) | RelayFailure;

export type RelaySendInput = {
	to?: unknown;
	text?: unknown;
	handshake?: unknown;
	record?: unknown;
	topic?: unknown;
	request?: { shiplet: string; feedback: string; label: string | null } | null;
};

// A public visitor's session: which Shiplet's website they are on, and when
// they last sent (for the rate limits).
type VisitorScope = { shiplet: string; origin: string; page: string; sent: number[] };

type Session = { id: string; owner: RelayOwner; conn: HubConnection; peerId: string; lastSeen: number; visitor?: VisitorScope };

// Visitor limits. Text is counted in characters, after trimming.
export const VISITOR_TEXT_CHARS = 2000;
const VISITOR_PER_MINUTE = 8;
const VISITOR_PER_HOUR = 60;
const SHIPLET_VISITOR_PER_HOUR = 300;

export type VisitorInput = { shiplet: string; origin: string; page: string };
// What a visitor sees of the agent answering them: a name and a kind, nothing about whose it is.
export type VisitorMessage = { id: string; text: string; at: string; from: { name: string; kind: string } };

const STATUS: Record<string, number> = {
	bad_request: 400,
	too_large: 413,
	not_registered: 409,
	not_recorded: 409,
	not_found: 404,
};

function failure(status: number, code: string, message: string): RelayFailure {
	return { ok: false, status, code, message };
}

function fromError(error: unknown): RelayFailure {
	const code = (error as { code?: unknown })?.code;
	if (typeof code === "string" && code in STATUS) return failure(STATUS[code], code, (error as Error).message);
	throw error;
}

function sessionId() {
	const bytes = crypto.getRandomValues(new Uint8Array(18));
	return `hss_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class HandshakeRelay extends DurableObject<Env> {
	// The relay admits people (kind "person"); handlers.ts lets only a browser
	// signed in to Shiplet open one.
	private hub = new Hub({ kinds: RELAY_KINDS });
	private sessions = new Map<string, Session>();
	// peer id -> account, kept while the peer is still named in a handshake.
	private accounts = new Map<string, string>();
	// Shiplet id -> the session on duty for its public visitors.
	private duty = new Map<string, string>();
	// visitor peer id -> the agents that visitor has written to; only they may answer.
	private contacts = new Map<string, Set<string>>();
	// Shiplet id -> visitor message times in the last hour.
	private shipletVisitorSends = new Map<string, number[]>();

	async openSession(owner: RelayOwner, input: RelayPeerInput): Promise<RelayResult<{ session: string; peer: RelayPeer }>> {
		if (this.sessions.size >= MAX_SESSIONS) {
			return failure(429, "too_many_sessions", `This organization already has ${MAX_SESSIONS} agents connected.`);
		}
		const conn = this.hub.open();
		let registered: { peer: { id: string } };
		try {
			// Only descriptive fields cross the relay: never a local session id,
			// working directory or process id.
			registered = await conn.handle("register", { name: input.name, kind: input.kind, app: input.app, machine: input.machine });
		} catch (error) {
			conn.close();
			return fromError(error);
		}
		const session: Session = { id: sessionId(), owner, conn, peerId: registered.peer.id, lastSeen: Date.now() };
		this.sessions.set(session.id, session);
		this.accounts.set(session.peerId, owner.account);
		await this.keepTime();
		return { ok: true, session: session.id, peer: this.peer(registered.peer as Sender) };
	}

	// An agent (or person) answers the public visitors of one Shiplet's website,
	// or stops (shiplet: null). The Worker has checked they can read its annotations.
	async setDuty(owner: RelayOwner, id: string, shiplet: string | null): Promise<RelayResult<{ shiplet: string | null }>> {
		const session = this.use(owner, id);
		if (!("conn" in session)) return session;
		if (session.visitor) return failure(403, "forbidden", "A visitor cannot go on duty.");
		for (const [key, holder] of [...this.duty]) if (holder === session.id) this.duty.delete(key);
		if (shiplet) this.duty.set(shiplet, session.id);
		return { ok: true, shiplet };
	}

	// Whether anyone is answering a Shiplet's visitors, without a session.
	async dutyStatus(shiplet: string): Promise<{ onDuty: boolean }> {
		return { onDuty: Boolean(this.onDuty(shiplet)) };
	}

	async openVisitor(owner: RelayOwner, input: VisitorInput): Promise<RelayResult<{ session: string }>> {
		if (this.sessions.size >= MAX_SESSIONS) {
			return failure(429, "too_many_sessions", "Too many people are connected right now. Try again in a few minutes.");
		}
		const conn = this.hub.open();
		const suffix = [...crypto.getRandomValues(new Uint8Array(3))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		const registered = (await conn.handle("register", { name: `visitor-${suffix}`, kind: "visitor", app: "shiplet-embed-public" })) as { peer: { id: string } };
		const session: Session = {
			id: sessionId(),
			owner,
			conn,
			peerId: registered.peer.id,
			lastSeen: Date.now(),
			visitor: { shiplet: input.shiplet, origin: input.origin, page: input.page, sent: [] },
		};
		this.sessions.set(session.id, session);
		this.accounts.set(session.peerId, owner.account);
		await this.keepTime();
		return { ok: true, session: session.id };
	}

	async visitorStatus(owner: RelayOwner, id: string): Promise<RelayResult<{ onDuty: boolean; agent?: { name: string; kind: string } }>> {
		const session = this.useVisitor(owner, id);
		if (!("conn" in session)) return session;
		const agent = this.onDuty(session.visitor!.shiplet);
		const peer = agent ? this.hub.findPeer(agent.peerId) : null;
		return peer ? { ok: true, onDuty: true, agent: { name: peer.name, kind: peer.kind } } : { ok: true, onDuty: false };
	}

	async visitorSend(owner: RelayOwner, id: string, text: unknown, page?: unknown): Promise<RelayResult<{ handshake: string; at: string }>> {
		const session = this.useVisitor(owner, id);
		if (!("conn" in session)) return session;
		const scope = session.visitor!;
		const body = typeof text === "string" ? text.trim() : "";
		if (!body) return failure(400, "bad_request", "Write a message first.");
		if (body.length > VISITOR_TEXT_CHARS) return failure(400, "too_long", `Messages can be at most ${VISITOR_TEXT_CHARS} characters.`);
		const now = Date.now();
		scope.sent = scope.sent.filter((at) => now - at < 3_600_000);
		const shipletSent = (this.shipletVisitorSends.get(scope.shiplet) ?? []).filter((at) => now - at < 3_600_000);
		if (
			scope.sent.filter((at) => now - at < 60_000).length >= VISITOR_PER_MINUTE ||
			scope.sent.length >= VISITOR_PER_HOUR ||
			shipletSent.length >= SHIPLET_VISITOR_PER_HOUR
		) {
			return failure(429, "rate_limited", "That is a lot of messages. Wait a minute and try again.");
		}
		const agent = this.onDuty(scope.shiplet);
		if (!agent) return failure(409, "no_agent_on_duty", "Nobody is answering right now. Leave feedback instead and the team will see it.");
		if (typeof page === "string" && page) scope.page = page;
		const contacts = this.contacts.get(session.peerId) ?? new Set<string>();
		contacts.add(agent.peerId);
		this.contacts.set(session.peerId, contacts);
		const sent = (await session.conn.handle("send", {
			to: agent.peerId,
			text: `${body}\n\n[Visitor context]\nwebsite: ${scope.origin}\npage: ${scope.page}`,
			topic: `Visitor on ${visitorPath(scope.page)}`,
		})) as { room: string; at: string };
		scope.sent.push(now);
		shipletSent.push(now);
		this.shipletVisitorSends.set(scope.shiplet, shipletSent);
		return { ok: true, handshake: sent.room, at: sent.at };
	}

	async visitorRead(owner: RelayOwner, id: string, waitMs: number): Promise<RelayResult<{ messages: VisitorMessage[] }>> {
		const session = this.useVisitor(owner, id);
		if (!("conn" in session)) return session;
		const read = await this.read(owner, id, waitMs);
		if (!read.ok) return read;
		return {
			ok: true,
			messages: read.messages.map((message) => ({ id: message.id, text: message.text, at: message.at, from: { name: message.from.name, kind: message.from.kind } })),
		};
	}

	async closeSession(owner: RelayOwner, id: string): Promise<RelayResult<Record<never, never>>> {
		const session = this.use(owner, id);
		if (!("conn" in session)) return session;
		this.end(session);
		return { ok: true };
	}

	async peers(owner: RelayOwner, id: string): Promise<RelayResult<{ self: string; peers: RelayPeer[] }>> {
		const session = this.use(owner, id);
		if (!("conn" in session)) return session;
		const result = (await session.conn.handle("peers")) as { peers: Sender[] };
		// Visitors are reachable only by the agent they wrote to, so nobody lists them.
		const peers = result.peers.filter((peer) => peer.kind !== "visitor");
		return { ok: true, self: session.peerId, peers: peers.map((peer) => this.peer(peer)) };
	}

	async send(owner: RelayOwner, id: string, input: RelaySendInput) {
		const session = this.use(owner, id);
		if (!("conn" in session)) return session;
		if (session.visitor) return failure(403, "forbidden", "Visitors send through the website widget.");
		const closed = this.visitorBarrier(session, input);
		if (closed) return closed;
		try {
			const sent = await session.conn.handle("send", {
				to: input.to,
				text: input.text,
				room: typeof input.handshake === "string" && input.handshake ? input.handshake : null,
				record: input.record === true,
				topic: input.topic,
				request: input.request ?? null,
			});
			return { ok: true as const, ...sent, handshake: sent.room };
		} catch (error) {
			return fromError(error);
		}
	}

	async read(owner: RelayOwner, id: string, waitMs: number): Promise<RelayResult<{ messages: Message[]; queued: number; timedOut?: boolean }>> {
		const session = this.use(owner, id);
		if (!("conn" in session)) return session;
		const wait = Math.max(0, Math.min(Number.isFinite(waitMs) ? Math.floor(waitMs) : 0, RELAY_MAX_WAIT_MS));
		const result = (await session.conn.handle("read", { wait_ms: wait, via: "tool" })) as {
			messages: Message[];
			queued: number;
			timedOut?: boolean;
			superseded?: boolean;
			gone?: boolean;
		};
		session.lastSeen = Date.now();
		return {
			ok: true,
			messages: result.messages.map((message) => this.message(message)),
			queued: result.queued ?? 0,
			...(result.timedOut || result.superseded ? { timedOut: true } : {}),
		};
	}

	async exportHandshake(owner: RelayOwner, id: string, handshakeId: string) {
		const session = this.use(owner, id);
		if (!("conn" in session)) return session;
		if (session.visitor) return failure(403, "forbidden", "Visitors cannot export a handshake.");
		try {
			const exported = (await session.conn.handle("export", { room: handshakeId })) as HandshakeExport;
			return { ok: true as const, handshake: exported, trace: toShipletTrace(exported) };
		} catch (error) {
			return fromError(error);
		}
	}

	// A read-only view for people watching (the dashboard) and for agents
	// listing what is going on. Messages only for recorded handshakes.
	async list(): Promise<HandshakeSnapshot[]> {
		this.expire();
		return this.hub.handshakes().map((snapshot) => ({
			...snapshot,
			members: snapshot.members.map((member) => ({ ...this.sender(member), live: member.live })),
			transcript: snapshot.transcript ? snapshot.transcript.map((message) => this.message(message)) : null,
		}));
	}

	async alarm() {
		this.expire();
		await this.keepTime();
	}

	private use(owner: RelayOwner, id: string): Session | RelayFailure {
		const session = this.sessions.get(id);
		// Someone else's session reads exactly like one that does not exist.
		if (!session || session.owner.actor !== owner.actor) {
			return failure(404, "session_not_found", "No open handshake session with that id. Open a new one.");
		}
		if (Date.now() - session.lastSeen > RELAY_IDLE_MS) {
			this.end(session);
			return failure(404, "session_not_found", "That handshake session timed out. Open a new one.");
		}
		session.lastSeen = Date.now();
		return session;
	}

	// A visitor can be written to only by an agent they wrote to, and a
	// handshake with a visitor in it takes nobody new.
	private visitorBarrier(session: Session, input: RelaySendInput): RelayFailure | null {
		const closed = () => failure(403, "visitor_not_reachable", "Only the agent a visitor wrote to can talk with them.");
		const target = typeof input.to === "string" && input.to ? this.hub.findPeer(input.to) : null;
		if (target?.kind === "visitor" && !this.contacts.get(target.id)?.has(session.peerId)) return closed();
		const room = typeof input.handshake === "string" && input.handshake ? this.hub.roomMembers(input.handshake) : null;
		if (room?.some((member) => member.kind === "visitor") && !room.some((member) => member.id === session.peerId)) return closed();
		return null;
	}

	private useVisitor(owner: RelayOwner, id: string): Session | RelayFailure {
		const session = this.use(owner, id);
		if (!("conn" in session)) return session;
		if (!session.visitor) return failure(404, "session_not_found", "No open visitor session with that id.");
		return session;
	}

	private onDuty(shiplet: string): Session | null {
		const id = this.duty.get(shiplet);
		const session = id ? this.sessions.get(id) : undefined;
		if (!session || Date.now() - session.lastSeen > RELAY_IDLE_MS) {
			if (id) this.duty.delete(shiplet);
			return null;
		}
		return session;
	}

	private end(session: Session) {
		this.sessions.delete(session.id);
		for (const [key, holder] of [...this.duty]) if (holder === session.id) this.duty.delete(key);
		this.contacts.delete(session.peerId);
		session.conn.close();
		this.forgetAccounts();
	}

	private expire() {
		const cutoff = Date.now() - RELAY_IDLE_MS;
		for (const session of [...this.sessions.values()]) if (session.lastSeen < cutoff) this.end(session);
	}

	private forgetAccounts() {
		const named = new Set<string>();
		for (const session of this.sessions.values()) named.add(session.peerId);
		for (const snapshot of this.hub.handshakes()) for (const member of snapshot.members) named.add(member.id);
		for (const peerId of [...this.accounts.keys()]) if (!named.has(peerId)) this.accounts.delete(peerId);
	}

	// While anyone is connected, a tick every 30 seconds expires idle sessions
	// (and keeps this object from being evicted with live handshakes in memory).
	private async keepTime() {
		if (!this.sessions.size) return;
		const current = await this.ctx.storage.getAlarm();
		if (current === null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
	}

	// Local-only fields (session, cwd) never leave the relay.
	private sender(peer: Sender): Sender {
		return {
			id: peer.id,
			name: peer.name,
			kind: peer.kind,
			app: peer.app,
			machine: peer.machine ?? null,
			session: null,
			cwd: null,
			account: this.accounts.get(peer.id) ?? null,
		};
	}

	private peer(peer: Sender & { connectedAt?: string }): RelayPeer {
		const { session: _session, cwd: _cwd, ...rest } = this.sender(peer);
		return { ...rest, account: rest.account ?? null, connectedAt: peer.connectedAt };
	}

	private message(message: Message): Message {
		return { ...message, from: this.sender(message.from) };
	}
}

function visitorPath(page: string) {
	try {
		return new URL(page).pathname || "/";
	} catch {
		return "/";
	}
}
