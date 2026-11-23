/// <reference lib="dom" />
// A person in a handshake, from a Shiplet page. The relay names the person
// from their account and marks them kind "person" (src/handshakes/handlers.ts),
// so an agent knows a person is speaking.
//
// One relay session per organization per browser tab, kept in sessionStorage
// so moving between Shiplet pages keeps the same peer. Reading the inbox
// consumes it, so everything received is kept in the same tab-local log and
// each panel shows the handshakes it cares about. Nothing leaves the tab: the
// relay keeps no messages unless an agent records the handshake.
//
// Framework-free, so the dashboard (React) and other Shiplet pages share it.
import type { Message, PeerKind, Sender } from "../../packages/agent-handshake/src/core/protocol.js";

export type PersonApp = "shiplet-dashboard" | "shiplet-review" | "shiplet-embed";

export type ChatPeer = { id: string; name: string; kind: PeerKind; app: string; machine: string | null; account: string | null };

function asSender(peer: ChatPeer): Sender {
	return { ...peer, session: null, cwd: null };
}

// A line in the person's view of a handshake. "pending" until the relay
// accepts it, "failed" if it did not.
export type ChatLine = Message & { mine: boolean; state?: "pending" | "failed"; error?: string };

export type ChatState = {
	self: ChatPeer | null;
	lines: ChatLine[];
	// The last thing that went wrong, for an inline error. Null when fine.
	error: string | null;
};

type Stored = { session: string; self: ChatPeer; lines: ChatLine[] };

const LOG_LIMIT = 300;
const WAIT_SECONDS = 20;

export class HandshakeError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export type PersonChatOptions = {
	organizationId: string;
	app: PersonApp;
	// Overridable for tests.
	fetch?: typeof fetch;
	storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
};

export class PersonChat {
	private readonly base: string;
	private readonly key: string;
	private readonly doFetch: typeof fetch;
	private readonly storage: PersonChatOptions["storage"];
	private stored: Stored | null;
	private error: string | null = null;
	private listeners = new Set<(state: ChatState) => void>();
	private polling = false;
	private stopped = false;
	private opening: Promise<Stored> | null = null;
	// Sent before the first session existed; shown at once, kept once it does.
	private pendingLines: ChatLine[] = [];

	constructor(private readonly options: PersonChatOptions) {
		this.base = `/api/organizations/${encodeURIComponent(options.organizationId)}`;
		this.key = `shiplet.handshake.person.${options.organizationId}`;
		this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.storage = options.storage === undefined ? safeSessionStorage() : options.storage;
		this.stored = this.load();
		if (this.stored) void this.poll();
	}

	get state(): ChatState {
		return { self: this.stored?.self ?? null, lines: this.stored?.lines ?? [], error: this.error };
	}

	subscribe(listener: (state: ChatState) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// Agents and people in the organization this person can talk to.
	async peers(): Promise<ChatPeer[]> {
		const body = await this.withSession((session) => this.call<{ self: string; peers: ChatPeer[] }>("GET", `/handshake-sessions/${session}/peers`));
		return body.peers.filter((peer) => peer.id !== body.self);
	}

	// Sends to a peer (name or id). Without `handshake` it opens (or continues)
	// the direct handshake with that peer. Resolves to the handshake id.
	async send(input: { to: string; text: string; handshake?: string | null; topic?: string; request?: { shiplet: string; feedback: string } }) {
		const text = input.text.trim();
		if (!text) return null;
		const local: ChatLine = {
			id: `local_${Math.random().toString(36).slice(2)}`,
			room: input.handshake ?? "",
			from: this.stored ? asSender(this.stored.self) : { id: "", name: "You", kind: "person", app: this.options.app, machine: null, session: null, cwd: null },
			to: { id: input.to, name: input.to, kind: "other" },
			text,
			at: new Date().toISOString(),
			mine: true,
			state: "pending",
		};
		this.append(local);
		try {
			const sent = await this.withSession((session) =>
				this.call<{ id: string; handshake: string; at: string; to: Message["to"] }>("POST", `/handshake-sessions/${session}/messages`, {
					to: input.to,
					text,
					handshake: input.handshake ?? undefined,
					topic: input.topic,
					request: input.request,
				}),
			);
			this.replace(local.id, { ...local, id: sent.id, room: sent.handshake, at: sent.at, to: sent.to, from: this.stored ? asSender(this.stored.self) : local.from, state: undefined });
			this.error = null;
			this.emit();
			return sent.handshake;
		} catch (error) {
			const message = errorText(error);
			this.replace(local.id, { ...local, state: "failed", error: message });
			this.error = message;
			this.emit();
			return null;
		}
	}

	// Lines in one handshake, or every line when no id is given.
	lines(handshake?: string | null) {
		const lines = this.stored?.lines ?? [];
		return handshake ? lines.filter((line) => line.room === handshake) : lines;
	}

	// Leaves the relay: agents stop seeing this person, and the tab forgets the
	// conversation.
	async leave() {
		this.stopped = true;
		const stored = this.stored;
		this.stored = null;
		this.storage?.removeItem(this.key);
		this.emit();
		if (stored) await this.call("DELETE", `/handshake-sessions/${stored.session}`).catch(() => undefined);
		this.stopped = false;
	}

	// Stops polling when the page goes away; the session stays for the next page.
	dispose() {
		this.stopped = true;
		this.listeners.clear();
	}

	private async withSession<T>(run: (session: string) => Promise<T>): Promise<T> {
		const stored = this.stored ?? (await this.open());
		try {
			return await run(stored.session);
		} catch (error) {
			// The relay restarted or the session idled out: open a new one once.
			if (error instanceof HandshakeError && error.code === "session_not_found") {
				this.stored = null;
				const fresh = await this.open(stored.lines);
				return run(fresh.session);
			}
			throw error;
		}
	}

	private open(lines: ChatLine[] = []) {
		this.opening ??= this.call<{ session: string; peer: ChatPeer }>("POST", "/handshake-sessions", { kind: "person", app: this.options.app })
			.then((opened) => {
				this.stored = { session: opened.session, self: opened.peer, lines: this.stored?.lines ?? lines };
				this.save();
				this.emit();
				// Agents can answer as soon as they can see this person.
				void this.poll();
				return this.stored;
			})
			.finally(() => {
				this.opening = null;
			});
		return this.opening;
	}

	private async poll() {
		if (this.polling || this.stopped) return;
		this.polling = true;
		try {
			while (this.stored && !this.stopped) {
				const session = this.stored.session;
				let body: { messages: Message[] };
				try {
					body = await this.call<{ messages: Message[] }>("GET", `/handshake-sessions/${session}/inbox?wait=${WAIT_SECONDS}`);
				} catch (error) {
					if (error instanceof HandshakeError && error.code === "session_not_found") {
						// Nobody is listening any more; the next send opens a new session.
						if (this.stored?.session === session) {
							this.stored = null;
							this.storage?.removeItem(this.key);
						}
						this.emit();
						return;
					}
					this.error = errorText(error);
					this.emit();
					await delay(5_000);
					continue;
				}
				if (body.messages.length) {
					for (const message of body.messages) this.append({ ...message, mine: false });
					this.error = null;
					this.emit();
				}
			}
		} finally {
			this.polling = false;
		}
	}

	private append(line: ChatLine) {
		if (!this.stored) {
			this.pendingLines.push(line);
			this.emit();
			return;
		}
		this.stored.lines = [...this.stored.lines, line].slice(-LOG_LIMIT);
		this.save();
		this.emit();
	}

	private replace(id: string, line: ChatLine) {
		this.pendingLines = this.pendingLines.filter((item) => item.id !== id);
		if (!this.stored) return;
		const lines = this.stored.lines.filter((item) => item.id !== id);
		this.stored.lines = [...lines, line].sort((a, b) => a.at.localeCompare(b.at)).slice(-LOG_LIMIT);
		this.save();
	}

	private emit() {
		const state = this.state;
		if (this.pendingLines.length) state.lines = [...state.lines, ...this.pendingLines];
		for (const listener of this.listeners) listener(state);
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await this.doFetch(`${this.base}${path}`, {
			method,
			credentials: "same-origin",
			cache: "no-store",
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const parsed = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
		if (!response.ok) throw new HandshakeError(response.status, parsed.error ?? "error", parsed.message ?? `The relay answered ${response.status}.`);
		return parsed as T;
	}

	private load(): Stored | null {
		try {
			const raw = this.storage?.getItem(this.key);
			const parsed = raw ? (JSON.parse(raw) as Stored) : null;
			return parsed?.session && parsed.self ? { ...parsed, lines: Array.isArray(parsed.lines) ? parsed.lines : [] } : null;
		} catch {
			return null;
		}
	}

	private save() {
		try {
			if (this.stored) this.storage?.setItem(this.key, JSON.stringify(this.stored));
		} catch {
			// Storage full or blocked: the conversation still works in this page.
		}
	}
}

function errorText(error: unknown) {
	if (error instanceof HandshakeError) return error.message;
	return "Could not reach Shiplet. Check your connection and try again.";
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeSessionStorage() {
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage;
	} catch {
		return null;
	}
}
