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

type Session = { id: string; owner: RelayOwner; conn: HubConnection; peerId: string; lastSeen: number };

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
		return { ok: true, self: session.peerId, peers: result.peers.map((peer) => this.peer(peer)) };
	}

	async send(owner: RelayOwner, id: string, input: RelaySendInput) {
		const session = this.use(owner, id);
		if (!("conn" in session)) return session;
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

	private end(session: Session) {
		this.sessions.delete(session.id);
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
