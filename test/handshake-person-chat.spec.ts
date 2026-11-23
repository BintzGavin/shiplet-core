// A person talking in a handshake from a Shiplet page: the browser client
// opens a person session only when the person first acts, shows what they sent
// at once, picks up replies by long-poll, keeps the tab's conversation across
// pages, and reopens a session the relay forgot.
import { describe, expect, it } from "vitest";
import { PersonChat, type ChatState } from "../src/platform/handshake-person";

type Call = { method: string; path: string; body: unknown };

function fakeRelay() {
	const calls: Call[] = [];
	const inbox: Array<(value: Response) => void> = [];
	let sessions = 0;
	let forget = false;
	const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const self = { id: "peer_dana", name: "Dana-Reyes", kind: "person", app: "shiplet-dashboard", machine: null, account: "Dana Reyes" };
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "https://shiplet.test");
		const path = url.pathname.replace("/api/organizations/org_1", "") + url.search;
		const method = init?.method ?? "GET";
		calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		if (method === "POST" && path === "/handshake-sessions") {
			sessions++;
			return respond(201, { session: `hss_${sessions}`, peer: self });
		}
		if (forget && path.startsWith(`/handshake-sessions/hss_${sessions}/`) && sessions === 1) {
			return respond(404, { error: "session_not_found", message: "That handshake session timed out. Open a new one." });
		}
		if (path.endsWith("/peers")) {
			return respond(200, { self: self.id, peers: [self, { id: "peer_builder", name: "builder", kind: "claude", app: "claude-cli", machine: "studio", account: "Dana Reyes" }] });
		}
		if (path.endsWith("/messages")) {
			return respond(200, { id: "msg_1", handshake: "hs_1", at: "2026-11-23T10:00:00.000Z", to: { id: "peer_builder", name: "builder", kind: "claude" }, status: "delivered" });
		}
		if (path.includes("/inbox")) return new Promise<Response>((resolve) => inbox.push(resolve));
		if (method === "DELETE") return respond(200, { closed: true });
		return respond(404, { error: "not_found", message: "?" });
	}) as typeof globalThis.fetch;
	return {
		calls,
		fetch,
		self,
		forgetFirstSession: () => {
			forget = true;
		},
		deliver(messages: unknown[]) {
			inbox.shift()?.(respond(200, { messages, queued: 0 }));
		},
		waiting: () => inbox.length,
		respond,
	};
}

function memoryStorage() {
	const items = new Map<string, string>();
	return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key), items };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a person in a handshake from a Shiplet page", () => {
	it("joins as a person only when they first act, and talks with an agent", async () => {
		const relay = fakeRelay();
		const storage = memoryStorage();
		const chat = new PersonChat({ organizationId: "org_1", app: "shiplet-dashboard", fetch: relay.fetch, storage });
		const seen: ChatState[] = [];
		chat.subscribe((state) => seen.push(state));

		// Opening the page joins nothing.
		expect(relay.calls).toEqual([]);
		expect(chat.state.self).toBeNull();

		const peers = await chat.peers();
		expect(relay.calls[0]).toEqual({ method: "POST", path: "/handshake-sessions", body: { kind: "person", app: "shiplet-dashboard" } });
		expect(peers.map((peer) => peer.name)).toEqual(["builder"]);

		const sending = chat.send({ to: "peer_builder", text: "  The pay button still looks gray.  " });
		// Shown at once, before the relay answers.
		expect(seen.at(-1)?.lines.at(-1)).toMatchObject({ text: "The pay button still looks gray.", mine: true, state: "pending" });
		expect(await sending).toBe("hs_1");
		expect(chat.lines("hs_1")).toEqual([expect.objectContaining({ id: "msg_1", mine: true, state: undefined, room: "hs_1" })]);

		// Once the person is visible, one long-poll waits for replies.
		await tick();
		expect(relay.waiting()).toBe(1);
		expect(relay.calls.filter((call) => call.path.includes("/inbox"))).toEqual([{ method: "GET", path: "/handshake-sessions/hss_1/inbox?wait=20", body: undefined }]);
		relay.deliver([
			{ id: "msg_2", room: "hs_1", at: "2026-11-23T10:00:05.000Z", text: "Darkening it now.", to: { id: relay.self.id, name: relay.self.name, kind: "person" }, from: { id: "peer_builder", name: "builder", kind: "claude", app: "claude-cli", machine: "studio", session: null, cwd: null } },
		]);
		await tick();
		expect(chat.lines("hs_1").map((line) => [line.mine, line.text])).toEqual([
			[true, "The pay button still looks gray."],
			[false, "Darkening it now."],
		]);

		// The next page in this tab picks up the same session and conversation.
		chat.dispose();
		const next = new PersonChat({ organizationId: "org_1", app: "shiplet-dashboard", fetch: relay.fetch, storage });
		expect(next.state.self?.name).toBe("Dana-Reyes");
		expect(next.lines("hs_1")).toHaveLength(2);

		// Leaving tells the relay and forgets the conversation.
		await next.leave();
		expect(relay.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/handshake-sessions/hss_1" });
		expect(storage.items.size).toBe(0);
		expect(next.state).toEqual({ self: null, lines: [], error: null });
	});

	it("reopens a session the relay forgot, keeping what was said", async () => {
		const relay = fakeRelay();
		const storage = memoryStorage();
		const chat = new PersonChat({ organizationId: "org_1", app: "shiplet-review", fetch: relay.fetch, storage });
		await chat.send({ to: "builder", text: "First." });
		chat.dispose();
		relay.forgetFirstSession();

		const later = new PersonChat({ organizationId: "org_1", app: "shiplet-review", fetch: relay.fetch, storage });
		later.dispose(); // no long-poll noise in this test
		expect(await later.send({ to: "builder", text: "Second.", handshake: "hs_1" })).toBe("hs_1");
		const opens = relay.calls.filter((call) => call.method === "POST" && call.path === "/handshake-sessions");
		expect(opens).toHaveLength(2);
		expect(opens[1].body).toEqual({ kind: "person", app: "shiplet-review" });
		expect(later.lines("hs_1").map((line) => line.text)).toEqual(["First.", "Second."]);
	});

	it("keeps a failed message visible with the reason, and its text for another try", async () => {
		const relay = fakeRelay();
		const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/messages")) return relay.respond(404, { error: "not_found", message: 'no live peer named "builder"; call list_peers' });
			return relay.fetch(input, init);
		}) as typeof fetch;
		const chat = new PersonChat({ organizationId: "org_1", app: "shiplet-dashboard", fetch: failing, storage: memoryStorage() });
		chat.dispose();
		expect(await chat.send({ to: "builder", text: "Anyone there?" })).toBeNull();
		expect(chat.state.error).toBe('no live peer named "builder"; call list_peers');
		expect(chat.lines()).toEqual([expect.objectContaining({ text: "Anyone there?", state: "failed", error: 'no live peer named "builder"; call list_peers' })]);
	});
});
