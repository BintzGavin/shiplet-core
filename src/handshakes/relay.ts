// The hosted Agent Handshake relay: one Durable Object per organization runs
// the same Hub as the local broker (packages/agent-handshake). An agent opens a
// relay session (one Hub connection), then lists peers, sends, reads its inbox
// and exports recorded handshakes through it. The Worker has already checked
// who the caller is and that they belong to the organization; the relay only
// checks that each session is used by the actor that opened it.
//
// State is saved in the object's own storage after every call, so eviction,
// hibernation and deploys keep sessions, queued messages and handshakes.
// A handshake lasts while at least one of its agents is connected, and a
// recorded one is kept by exporting it as a trace. A session that has not
// called for IDLE_MS has left, unless it holds an open events WebSocket.
//
// Event-driven delivery: an agent asks for a single-use ticket and opens a
// hibernatable WebSocket with it. Each message sent to it is pushed over the
// socket the moment it is sent instead of waiting in its inbox.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { Hub } from "../../packages/agent-handshake/src/core/hub.js";
import type { HubConnection, HubSnapshot } from "../../packages/agent-handshake/src/core/hub.js";
import { RELAY_KINDS, type HandshakeSnapshot, type Message, type Sender } from "../../packages/agent-handshake/src/core/protocol.js";
import { toShipletTrace, type HandshakeExport } from "../../packages/agent-handshake/src/core/trace.js";

export const RELAY_IDLE_MS = 10 * 60_000;
// Code Mode calls time out at 30 seconds, so one inbox wait stays well under it.
export const RELAY_MAX_WAIT_MS = 20_000;
const MAX_SESSIONS = 200;
export const EVENT_TICKET_MS = 60_000;
// Stored values stay well under the 2 MB limit; longer records are split.
const CHUNK_CHARS = 512 * 1024;
// One pushed frame stays well under the WebSocket message limit.
const FRAME_CHARS = 512 * 1024;
const SOCKET_OPEN = 1;

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

// A service agent's webhook. Failing deliveries back off; after a day of
// failures the webhook is dropped and the session idles out as usual.
type Webhook = { url: string; secret: string; failures: number; failingSince: number | null; retryAt: number | null };

type Session = { id: string; owner: RelayOwner; conn: HubConnection; peerId: string; lastSeen: number; webhook?: Webhook };

const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_GIVE_UP_MS = 24 * 3_600_000;
const WEBHOOK_MAX_BACKOFF_MS = 10 * 60_000;

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

type StoredSession = Omit<Session, "conn"> & { connId: string };

type StoredMeta = {
	version: 1;
	conns: Array<{ id: string; peerId: string }>;
	sessions: StoredSession[];
	accounts: Array<[string, string]>;
	// Stored record key -> how many chunks it is split into.
	records: Array<[string, number]>;
};

// A save from any earlier version. Sessions could carry a "visitor" field.
type LegacyMeta = Omit<StoredMeta, "sessions"> & { sessions: Array<StoredSession & { visitor?: unknown }> };

function chunks(value: string) {
	const parts: string[] = [];
	for (let start = 0; start < value.length || !parts.length; start += CHUNK_CHARS) parts.push(value.slice(start, start + CHUNK_CHARS));
	return parts;
}

function batches<T>(items: T[], size = 128) {
	const out: T[][] = [];
	for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
	return out;
}

export class HandshakeRelay extends DurableObject<Env> {
	// The relay admits people (kind "person"); handlers.ts lets only a browser
	// signed in to Shiplet open one.
	private hub = new Hub({ kinds: RELAY_KINDS });
	private sessions = new Map<string, Session>();
	// peer id -> account, kept while the peer is still named in a handshake.
	private accounts = new Map<string, string>();
	// Sessions with a webhook delivery in flight, so deliveries stay in order.
	private delivering = new Set<string>();
	// Single-use events tickets. In memory only: a ticket outlives a restart by
	// at most a minute, and the agent asks for another.
	private tickets = new Map<string, { session: string; expires: number }>();
	// What storage holds, to write only what changed.
	private stored = new Map<string, { chunks: number; json: string }>();
	private storedMeta = "";

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Keep-alive pings are answered without waking a hibernating relay.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		void ctx.blockConcurrencyWhile(() => this.load());
	}

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
			await this.push(sent.to.id);
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
		for (const session of [...this.sessions.values()]) if (session.webhook?.retryAt && session.webhook.retryAt <= Date.now()) {
			session.webhook.retryAt = null;
			await this.deliver(session.id);
		}
		await this.persist();
		await this.keepTime();
	}

	// A service agent's webhook (url: null removes it). The Worker has checked
	// the URL is public https. The secret is returned once, here.
	async setWebhook(owner: RelayOwner, id: string, url: string | null): Promise<RelayResult<{ url: string | null; secret?: string }>> {
		const session = this.use(owner, id);
		if (!("conn" in session)) return session;
		const kind = this.hub.findPeer(session.peerId)?.kind;
		if (kind === "person") return failure(403, "forbidden", "Only agents can receive messages through a webhook.");
		if (!url) {
			delete session.webhook;
			session.lastSeen = Date.now();
			return { ok: true, url: null };
		}
		const secret = `whsec_${[...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
		session.webhook = { url, secret, failures: 0, failingSince: null, retryAt: null };
		this.ctx.waitUntil(this.deliver(session.id));
		return { ok: true, url, secret };
	}

	// A single-use ticket that opens this session's events WebSocket.
	async createEventTicket(owner: RelayOwner, id: string): Promise<RelayResult<{ ticket: string; expiresAt: string }>> {
		const session = this.use(owner, id);
		if (!("conn" in session)) return session;
		const now = Date.now();
		for (const [ticket, entry] of [...this.tickets]) if (entry.expires < now) this.tickets.delete(ticket);
		const ticket = `hset_${[...crypto.getRandomValues(new Uint8Array(24))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
		this.tickets.set(ticket, { session: id, expires: now + EVENT_TICKET_MS });
		return { ok: true, ticket, expiresAt: new Date(now + EVENT_TICKET_MS).toISOString() };
	}

	// The events WebSocket. The Worker forwards the upgrade with the session id
	// and ticket from the URL; the ticket is the only credential.
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return Response.json({ error: "upgrade_required", message: "Open this path as a WebSocket." }, { status: 426 });
		}
		const url = new URL(request.url);
		const id = url.searchParams.get("session") ?? "";
		const ticket = url.searchParams.get("ticket") ?? "";
		const entry = this.tickets.get(ticket);
		const session = this.sessions.get(id);
		if (!entry || entry.session !== id || entry.expires < Date.now() || !session) {
			return Response.json({ error: "invalid_ticket", message: "That events ticket is not valid. Ask for a new one." }, { status: 403 });
		}
		this.tickets.delete(ticket);
		// One socket per session: a newer one replaces the older.
		for (const older of this.ctx.getWebSockets(id)) older.close(4000, "replaced by a newer connection");
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server, [id]);
		session.lastSeen = Date.now();
		server.send(JSON.stringify({ type: "ready", session: id, peer: this.peer(this.hub.findPeer(session.peerId) as Sender) }));
		await this.push(session.peerId);
		await this.persist();
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage() {
		// Agents send nothing but "ping", which is answered automatically.
	}

	async webSocketClose(socket: WebSocket) {
		await this.socketGone(socket);
	}

	async webSocketError(socket: WebSocket) {
		await this.socketGone(socket);
	}

	// Without its socket, a session idles out like any other, from now.
	private async socketGone(socket: WebSocket) {
		const [id] = this.ctx.getTags(socket);
		const session = id ? this.sessions.get(id) : undefined;
		if (session) session.lastSeen = Date.now();
		await this.persist();
		await this.keepTime();
	}

	private sockets(sessionId: string) {
		return this.ctx.getWebSockets(sessionId).filter((socket) => socket.readyState === SOCKET_OPEN);
	}

	// Whether a session still counts as connected: it holds a socket, has a
	// webhook, or called recently.
	private alive(session: Session) {
		return this.held(session) || Date.now() - session.lastSeen <= RELAY_IDLE_MS;
	}

	private held(session: Session) {
		return this.sockets(session.id).length > 0 || Boolean(session.webhook);
	}

	// Hands everything queued for a peer to its open socket, or else to its webhook.
	private async push(peerId: string) {
		const session = [...this.sessions.values()].find((candidate) => candidate.peerId === peerId);
		const [socket] = session ? this.sockets(session.id) : [];
		if (session && !socket && session.webhook) this.ctx.waitUntil(this.deliver(session.id));
		if (!session || !socket) return;
		for (;;) {
			const read = (await session.conn.handle("read", { wait_ms: 0, max: 50, via: "tool" })) as { messages: Message[] };
			if (!read.messages.length) return;
			let frame: Message[] = [];
			let size = 0;
			const flush = () => {
				if (frame.length) socket.send(JSON.stringify({ type: "messages", messages: frame }));
				frame = [];
				size = 0;
			};
			for (const message of read.messages.map((each) => this.message(each))) {
				const length = JSON.stringify(message).length;
				if (size + length > FRAME_CHARS) flush();
				frame.push(message);
				size += length;
			}
			flush();
		}
	}

	// Posts queued messages to the session's webhook, a batch at a time, in
	// order. A failed post puts the batch back and schedules a retry.
	private async deliver(id: string) {
		if (this.delivering.has(id)) return;
		this.delivering.add(id);
		try {
			for (;;) {
				const session = this.sessions.get(id);
				const hook = session?.webhook;
				if (!session || !hook || this.sockets(id).length || (hook.retryAt && hook.retryAt > Date.now())) return;
				const read = (await session.conn.handle("read", { wait_ms: 0, max: 50, via: "tool" })) as { messages: Message[] };
				if (!read.messages.length) return;
				if (await this.post(hook, id, read.messages.map((message) => this.message(message)))) {
					Object.assign(hook, { failures: 0, failingSince: null, retryAt: null });
					await this.persist();
					continue;
				}
				this.hub.requeue(session.peerId, read.messages);
				hook.failures++;
				hook.failingSince ??= Date.now();
				if (Date.now() - hook.failingSince > WEBHOOK_GIVE_UP_MS) {
					delete session.webhook;
					session.lastSeen = Date.now();
				} else {
					hook.retryAt = Date.now() + Math.min(30_000 * 2 ** (hook.failures - 1), WEBHOOK_MAX_BACKOFF_MS);
				}
				await this.persist();
				await this.keepTime();
				return;
			}
		} finally {
			this.delivering.delete(id);
		}
	}

	// Signed like common webhook schemes: HMAC-SHA256 of "<id>.<timestamp>.<body>".
	private async post(hook: Webhook, session: string, messages: Message[]) {
		const id = `whd_${[...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
		const timestamp = String(Math.floor(Date.now() / 1000));
		const body = JSON.stringify({ type: "messages", session, messages });
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey("raw", encoder.encode(hook.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${id}.${timestamp}.${body}`)))]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		try {
			const response = await fetch(hook.url, {
				method: "POST",
				redirect: "manual",
				signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
				headers: {
					"content-type": "application/json",
					"user-agent": "Shiplet-Handshake-Webhook/1",
					"shiplet-webhook-id": id,
					"shiplet-webhook-timestamp": timestamp,
					"shiplet-webhook-signature": `v1=${signature}`,
				},
				body,
			});
			await response.body?.cancel();
			return response.status >= 200 && response.status < 300;
		} catch {
			return false;
		}
	}

	private async load() {
		const raw = await this.ctx.storage.get<string>("meta");
		if (!raw) return;
		const meta = JSON.parse(raw) as LegacyMeta;
		const keys = meta.records.flatMap(([key, count]) => Array.from({ length: count }, (_, index) => `rec:${key}:${index}`));
		const values = new Map<string, string>();
		for (const batch of batches(keys)) for (const [key, value] of await this.ctx.storage.get<string>(batch)) values.set(key, value);
		const peers: HubSnapshot["peers"] = [];
		const rooms: HubSnapshot["rooms"] = [];
		for (const [key, count] of meta.records) {
			const parts = Array.from({ length: count }, (_, index) => values.get(`rec:${key}:${index}`));
			if (parts.some((part) => part === undefined)) continue;
			const json = parts.join("");
			this.stored.set(key, { chunks: count, json });
			if (key.startsWith("peer:")) peers.push(JSON.parse(json));
			else rooms.push(JSON.parse(json));
		}
		// Saves from before public visitor chat was removed can hold visitor
		// sessions (marked "visitor") and peers of kind "visitor", next to the
		// old duty, contacts and shipletVisitorSends fields, which are ignored.
		// The visitors, their handshakes and every message from them are left
		// out, so nothing can list or reach one; the next save drops them.
		const visitors = new Set(meta.sessions.filter((session) => "visitor" in session).map((session) => session.peerId));
		for (const peer of peers) if (peer.kind === "visitor") visitors.add(peer.id);
		const fromVisitor = (sender: Sender) => (sender.kind as string) === "visitor" || visitors.has(sender.id);
		this.hub.restore({
			peers: peers.filter((peer) => !visitors.has(peer.id)).map((peer) => ({ ...peer, inbox: peer.inbox.filter((message) => !fromVisitor(message.from)) })),
			rooms: rooms.filter((room) => !room.members.some(fromVisitor)),
			conns: meta.conns,
		});
		for (const { connId, ...stored } of meta.sessions) {
			if ("visitor" in stored || visitors.has(stored.peerId)) continue;
			const conn = this.hub.reopen(connId);
			if (conn) this.sessions.set(stored.id, { ...stored, conn });
		}
		this.accounts = new Map(meta.accounts.filter(([peerId]) => !visitors.has(peerId)));
		this.storedMeta = raw;
	}

	// Writes what changed since the last save. Every write is issued before the
	// first await, so a save lands as one batch and saves land in order.
	private async persist() {
		const snapshot = this.hub.snapshot();
		const records = new Map<string, string>();
		for (const peer of snapshot.peers) records.set(`peer:${peer.id}`, JSON.stringify(peer));
		for (const room of snapshot.rooms) records.set(`room:${room.id}`, JSON.stringify(room));
		const puts: Record<string, string> = {};
		const deletes: string[] = [];
		for (const [key, json] of records) {
			const before = this.stored.get(key);
			if (before?.json === json) continue;
			const parts = chunks(json);
			parts.forEach((part, index) => (puts[`rec:${key}:${index}`] = part));
			for (let index = parts.length; index < (before?.chunks ?? 0); index++) deletes.push(`rec:${key}:${index}`);
			this.stored.set(key, { chunks: parts.length, json });
		}
		for (const [key, before] of [...this.stored]) {
			if (records.has(key)) continue;
			for (let index = 0; index < before.chunks; index++) deletes.push(`rec:${key}:${index}`);
			this.stored.delete(key);
		}
		const meta: StoredMeta = {
			version: 1,
			conns: snapshot.conns,
			sessions: [...this.sessions.values()].map(({ conn, ...session }) => ({ ...session, connId: conn.id })),
			accounts: [...this.accounts],
			records: [...this.stored].map(([key, value]) => [key, value.chunks]),
		};
		const json = JSON.stringify(meta);
		if (json !== this.storedMeta) {
			puts.meta = json;
			this.storedMeta = json;
		}
		const writes: Promise<unknown>[] = [];
		for (const batch of batches(Object.entries(puts))) writes.push(this.ctx.storage.put(Object.fromEntries(batch)));
		for (const batch of batches(deletes)) writes.push(this.ctx.storage.delete(batch));
		await Promise.all(writes);
	}

	private use(owner: RelayOwner, id: string): Session | RelayFailure {
		const session = this.sessions.get(id);
		// Someone else's session reads exactly like one that does not exist.
		if (!session || session.owner.actor !== owner.actor) {
			return failure(404, "session_not_found", "No open handshake session with that id. Open a new one.");
		}
		if (!this.alive(session)) {
			this.end(session);
			return failure(404, "session_not_found", "That handshake session timed out. Open a new one.");
		}
		session.lastSeen = Date.now();
		return session;
	}

	private end(session: Session, code: "session_closed" | "session_not_found" = "session_closed") {
		for (const socket of this.ctx.getWebSockets(session.id)) {
			try {
				socket.send(JSON.stringify({ type: "closed", code, message: code === "session_closed" ? "The session was closed." : "The session timed out. Open a new one." }));
				socket.close(1000, code);
			} catch {
				// Already closing.
			}
		}
		this.sessions.delete(session.id);
		session.conn.close();
		this.forgetAccounts();
	}

	private expire() {
		for (const session of [...this.sessions.values()]) if (!this.alive(session)) this.end(session, "session_not_found");
	}

	private forgetAccounts() {
		const named = new Set<string>();
		for (const session of this.sessions.values()) named.add(session.peerId);
		for (const snapshot of this.hub.handshakes()) for (const member of snapshot.members) named.add(member.id);
		for (const peerId of [...this.accounts.keys()]) if (!named.has(peerId)) this.accounts.delete(peerId);
	}

	// Wakes the relay when the next session without a socket or webhook could
	// have idled out, or a webhook retry is due.
	private async keepTime() {
		const times = [...this.sessions.values()].flatMap((session) => [
			...(this.held(session) ? [] : [session.lastSeen + RELAY_IDLE_MS + 1_000]),
			...(session.webhook?.retryAt ? [session.webhook.retryAt] : []),
		]);
		if (!times.length) return;
		const due = Math.min(...times);
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > due) await this.ctx.storage.setAlarm(due);
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

// Every call that can change state saves it before it returns.
const SAVED_AFTER = [
	"openSession",
	"closeSession",
	"peers",
	"send",
	"read",
	"exportHandshake",
	"list",
	"createEventTicket",
	"setWebhook",
] as const;
for (const name of SAVED_AFTER) {
	const original = HandshakeRelay.prototype[name] as (...args: unknown[]) => Promise<unknown>;
	Object.defineProperty(HandshakeRelay.prototype, name, {
		configurable: true,
		writable: true,
		value: async function (this: HandshakeRelay, ...args: unknown[]) {
			try {
				return await original.apply(this, args);
			} finally {
				await (this as unknown as { persist(): Promise<void> }).persist();
				await (this as unknown as { keepTime(): Promise<void> }).keepTime();
			}
		},
	});
}
