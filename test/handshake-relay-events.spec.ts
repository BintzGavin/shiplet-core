// The relay is event-driven: its state survives the Durable Object being
// evicted, hibernated or redeployed, and an agent can hold a WebSocket that
// receives each message the moment it is sent instead of polling its inbox.
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { HandshakeRelay } from "../src/handshakes/relay";

type TestEnv = Omit<Env, "SHIPLET_ENABLED_FEATURE_FLAGS"> & { SHIPLET_ENABLED_FEATURE_FLAGS?: string };
const testEnv = env as unknown as TestEnv;
const runtimeEnv = env as unknown as Env;

const OWNER = { "x-shiplet-user-id": "user_hs_events_owner", "x-shiplet-user-email": "owner@events.test" };

async function request(path: string, init: RequestInit = {}) {
	const context = createExecutionContext();
	let response: Response;
	try {
		response = await app.fetch(new Request(path.startsWith("http") ? path : `http://localhost${path}`, init), runtimeEnv, context);
	} catch (error) {
		if (!(error instanceof Response)) throw error;
		response = error;
	}
	await waitOnExecutionContext(context);
	return response;
}

const json = (headers: Record<string, string>, body?: unknown, method = "POST"): RequestInit => ({
	method,
	headers: { "Content-Type": "application/json", ...headers },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function withHandshakes<T>(callback: () => Promise<T>) {
	const previous = testEnv.SHIPLET_ENABLED_FEATURE_FLAGS;
	testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = "agent-handshakes,traces";
	try {
		return await callback();
	} finally {
		testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = previous;
	}
}

function relayStub(name: string) {
	return runtimeEnv.HANDSHAKE_RELAY.get(runtimeEnv.HANDSHAKE_RELAY.idFromName(name));
}

// What eviction, hibernation or a deploy looks like to the relay: a new object
// over the same storage. The callback runs inside the object.
async function restarted<T>(stub: unknown, callback: (fresh: HandshakeRelay, state: DurableObjectState) => Promise<T>) {
	return runInDurableObject(stub as DurableObjectStub, async (_instance, state) => {
		const fresh = new HandshakeRelay(state, runtimeEnv);
		await state.blockConcurrencyWhile(async () => {});
		return callback(fresh, state);
	});
}

const A = { actor: "token:a", account: "Builder key" };
const B = { actor: "token:b", account: "Reviewer key" };

describe("the relay keeps its state across restarts", () => {
	it("restores sessions, queued messages, recorded handshakes and duty, and stores nothing once everyone leaves", async () => {
		const stub = relayStub(`organization:events-${crypto.randomUUID()}`) as unknown as HandshakeRelay;
		const a = await stub.openSession(A, { name: "builder", kind: "claude", app: "claude-cli", machine: "studio" });
		const b = await stub.openSession(B, { name: "reviewer", kind: "codex", app: "codex-cli", machine: null });
		if (!a.ok || !b.ok) throw new Error("open failed");
		const sent = await stub.send(A, a.session, { to: b.peer.id, text: "Darken the Pay button.", record: true, topic: "Pay button" });
		expect(sent.ok).toBe(true);
		expect((await stub.setDuty(B, b.session, "project_events")).ok).toBe(true);

		await restarted(stub, async (fresh, state) => {
			const inbox = await fresh.read(B, b.session, 0);
			if (!inbox.ok) throw new Error(inbox.message);
			expect(inbox.messages.map((message) => message.text)).toEqual(["Darken the Pay button."]);
			expect(inbox.messages[0].from).toMatchObject({ name: "builder", account: "Builder key", cwd: null });
			const [handshake] = await fresh.list();
			expect(handshake).toMatchObject({ topic: "Pay button", record: true, messageCount: 1 });
			expect(await fresh.dutyStatus("project_events")).toEqual({ onDuty: true });
			// Sessions still belong to their openers.
			expect((await fresh.read(A, b.session, 0)).ok).toBe(false);
			// The handshake continues where it left off.
			const reply = await fresh.send(B, b.session, { to: a.peer.id, text: "On it." });
			expect(reply).toMatchObject({ ok: true, handshake: (sent as { handshake: string }).handshake, recorded: true });

			expect((await fresh.closeSession(A, a.session)).ok).toBe(true);
			expect((await fresh.closeSession(B, b.session)).ok).toBe(true);
			const again = new HandshakeRelay(state, runtimeEnv);
			await state.blockConcurrencyWhile(async () => {});
			expect(await again.list()).toEqual([]);
			expect(await again.dutyStatus("project_events")).toEqual({ onDuty: false });
			const left = [...(await state.storage.list()).keys()].filter((key) => key.startsWith("rec:"));
			expect(left).toEqual([]);
		});
	});

	it("keeps a large inbox under the storage value limit by splitting it", async () => {
		const stub = relayStub(`organization:events-${crypto.randomUUID()}`) as unknown as HandshakeRelay;
		const a = await stub.openSession(A, { name: "builder", kind: "claude" });
		const b = await stub.openSession(B, { name: "reviewer", kind: "codex" });
		if (!a.ok || !b.ok) throw new Error("open failed");
		const big = "x".repeat(60_000);
		for (let index = 0; index < 60; index++) expect((await stub.send(A, a.session, { to: b.peer.id, text: `${index} ${big}` })).ok).toBe(true);
		await restarted(stub, async (fresh) => {
			const inbox = await fresh.read(B, b.session, 0);
			if (!inbox.ok) throw new Error(inbox.message);
			expect(inbox.messages).toHaveLength(50);
			expect(inbox.queued).toBe(10);
		});
	});
});

async function organizationWithKeys() {
	const created = await request("/api/organizations", json(OWNER, { name: `Events ${crypto.randomUUID()}` }));
	expect(created.status).toBe(201);
	const organizationId = ((await created.json()) as { organization: { id: string } }).organization.id;
	const key = async (name: string) => {
		const response = await request(
			`/api/organizations/${organizationId}/api-tokens`,
			json({ ...OWNER, Origin: "http://localhost" }, { name, scopes: ["mcp"], projectAccessMode: "all" }),
		);
		expect(response.status).toBe(201);
		return { authorization: `Bearer ${((await response.json()) as { token: string }).token}` };
	};
	return { organizationId, builder: await key("Builder key"), reviewer: await key("Reviewer key") };
}

async function join(organizationId: string, headers: Record<string, string>, name: string) {
	const response = await request(`/api/organizations/${organizationId}/handshake-sessions`, json(headers, { name, kind: "claude", app: "claude-cli" }));
	expect(response.status).toBe(201);
	return (await response.json()) as { session: string; peer: { id: string } };
}

async function openSocket(url: string) {
	const response = await request(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } });
	expect(response.status).toBe(101);
	const socket = response.webSocket!;
	const frames: Array<Record<string, unknown>> = [];
	const waiters: Array<() => void> = [];
	socket.addEventListener("message", (event) => {
		frames.push(typeof event.data === "string" && event.data.startsWith("{") ? JSON.parse(event.data) : { raw: event.data });
		for (const wake of waiters.splice(0)) wake();
	});
	socket.accept();
	const next = async (type: string) => {
		for (let attempt = 0; attempt < 50; attempt++) {
			const index = frames.findIndex((frame) => frame.type === type || frame.raw === type);
			if (index >= 0) return frames.splice(index, 1)[0];
			await new Promise<void>((resolve) => {
				waiters.push(resolve);
				setTimeout(resolve, 100);
			});
		}
		throw new Error(`no ${type} frame; got ${JSON.stringify(frames)}`);
	};
	return { socket, frames, next };
}

describe("agents receive messages over a WebSocket", () => {
	it("pushes each message the moment it is sent, with a single-use ticket bound to one session", () =>
		withHandshakes(async () => {
			const { organizationId, builder, reviewer } = await organizationWithKeys();
			const base = `/api/organizations/${organizationId}/handshake-sessions`;
			const listener = await join(organizationId, reviewer, "reviewer");
			const talker = await join(organizationId, builder, "builder");
			// Something already waiting arrives right after the socket opens.
			await request(`${base}/${talker.session}/messages`, json(builder, { to: listener.peer.id, text: "Before you connected." }));

			// Only the session's own actor gets a ticket.
			expect((await request(`${base}/${listener.session}/events`, json(builder))).status).toBe(404);
			const ticketed = await request(`${base}/${listener.session}/events`, json(reviewer));
			expect(ticketed.status).toBe(201);
			const { url, expiresAt } = (await ticketed.json()) as { url: string; expiresAt: string };
			expect(url).toMatch(new RegExp(`^ws://localhost${base}/${listener.session}/events\\?ticket=hset_[a-f0-9]{48}$`));
			expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
			// A ticket opens only the session it was made for.
			const wrongSession = await request(url.replace(/^ws/, "http").replace(listener.session, talker.session), { headers: { Upgrade: "websocket" } });
			expect(wrongSession.status).toBe(403);

			const { socket, next } = await openSocket(url);
			expect(await next("ready")).toMatchObject({ session: listener.session, peer: { id: listener.peer.id, name: "reviewer" } });
			expect(await next("messages")).toMatchObject({ messages: [{ text: "Before you connected." }] });
			// Used once, a ticket is spent.
			expect((await request(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } })).status).toBe(403);
			// Without an upgrade the events path refuses.
			expect((await request(url.replace(/^ws/, "http"))).status).toBe(426);

			const sent = await request(`${base}/${talker.session}/messages`, json(builder, { to: listener.peer.id, text: "Pushed, not polled." }));
			expect(sent.status).toBe(200);
			const pushed = (await next("messages")) as { messages: Array<{ text: string; from: { name: string; account: string; cwd: null } }> };
			expect(pushed.messages).toHaveLength(1);
			expect(pushed.messages[0]).toMatchObject({ text: "Pushed, not polled.", from: { name: "builder", account: "Builder key", cwd: null } });
			// Delivered over the socket, so not queued again.
			const inbox = (await (await request(`${base}/${listener.session}/inbox`, { headers: reviewer })).json()) as { messages: unknown[] };
			expect(inbox.messages).toEqual([]);

			socket.send("ping");
			expect(await next("pong")).toEqual({ raw: "pong" });

			// Holding the socket keeps the session open however long since its last call.
			await runInDurableObject(relayStub(`organization:${organizationId}`), async (instance) => {
				const sessions = (instance as unknown as { sessions: Map<string, { lastSeen: number }> }).sessions;
				sessions.get(listener.session)!.lastSeen = 0;
				sessions.get(talker.session)!.lastSeen = 0;
			});
			expect((await request(`${base}/${listener.session}/peers`, { headers: reviewer })).status).toBe(200);
			expect((await request(`${base}/${talker.session}/peers`, { headers: builder })).status).toBe(404);

			// Leaving tells the socket why it closes.
			expect((await request(`${base}/${listener.session}`, { method: "DELETE", headers: reviewer })).status).toBe(200);
			expect(await next("closed")).toMatchObject({ code: "session_closed" });
		}));

	it("is off while handshakes are off, and a ticket needs a live session", async () => {
		const { organizationId, reviewer } = await organizationWithKeys();
		const base = `/api/organizations/${organizationId}/handshake-sessions`;
		expect((await request(`${base}/hss_missing/events`, json(reviewer))).status).toBe(404);
		await withHandshakes(async () => {
			expect((await request(`${base}/hss_missing/events`, json(reviewer))).status).toBe(404);
			expect((await request(`${base}/hss_missing/events?ticket=hset_${"0".repeat(48)}`, { headers: { Upgrade: "websocket" } })).status).toBe(403);
		});
	});
});

// Service agents (the agent on duty for visitors, an Agents SDK agent, a cloud
// routine) have no session open to hold a socket. The relay calls their webhook.
const HOOK = "https://agent.shiplet-tests.dev/handshake";
const realFetch = globalThis.fetch;
// Read inside the stub: a body made in the relay cannot be read from the test.
const hookCalls: Array<{ method: string; headers: Headers; body: string }> = [];
let hookStatus = 200;
function stubHook() {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = new Request(input, init);
		if (call.url === HOOK) {
			hookCalls.push({ method: call.method, headers: new Headers(call.headers), body: await call.text() });
			return new Response(null, { status: hookStatus });
		}
		return realFetch(input, init);
	}) as typeof fetch;
}
afterEach(() => {
	globalThis.fetch = realFetch;
	hookCalls.length = 0;
	hookStatus = 200;
});

async function eventually<T>(check: () => Promise<T | undefined> | T | undefined) {
	for (let attempt = 0; attempt < 40; attempt++) {
		const value = await check();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("timed out");
}

async function hmac(secret: string, text: string) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("service agents receive messages through a signed webhook", () => {
	it("delivers each message to a public https URL, signed with a secret shown once", () =>
		withHandshakes(async () => {
			stubHook();
			const { organizationId, builder, reviewer } = await organizationWithKeys();
			const base = `/api/organizations/${organizationId}/handshake-sessions`;
			const service = await join(organizationId, reviewer, "support");
			const talker = await join(organizationId, builder, "builder");

			for (const url of ["http://agent.shiplet-tests.dev/x", "https://10.0.0.8/x", "https://localhost/x", "https://user:pw@agent.shiplet-tests.dev/x", "https://agent.shiplet-tests.dev:8443/x", "not a url"]) {
				expect((await request(`${base}/${service.session}/webhook`, json(reviewer, { url }))).status, url).toBe(400);
			}
			// Only the session's own actor.
			expect((await request(`${base}/${service.session}/webhook`, json(builder, { url: HOOK }))).status).toBe(404);
			const registered = await request(`${base}/${service.session}/webhook`, json(reviewer, { url: HOOK }));
			expect(registered.status).toBe(201);
			const { secret } = (await registered.json()) as { url: string; secret: string };
			expect(secret).toMatch(/^whsec_[a-f0-9]{64}$/);

			expect((await request(`${base}/${talker.session}/messages`, json(builder, { to: service.peer.id, text: "Can you check checkout?" }))).status).toBe(200);
			const call = await eventually(() => hookCalls[0]);
			expect(call.method).toBe("POST");
			const id = call.headers.get("shiplet-webhook-id")!;
			const timestamp = call.headers.get("shiplet-webhook-timestamp")!;
			const body = call.body;
			expect(Math.abs(Number(timestamp) * 1000 - Date.now())).toBeLessThan(60_000);
			expect(call.headers.get("shiplet-webhook-signature")).toBe(`v1=${await hmac(secret, `${id}.${timestamp}.${body}`)}`);
			const payload = JSON.parse(body) as { type: string; session: string; messages: Array<{ text: string; from: { account: string; cwd: null } }> };
			expect(payload).toMatchObject({ type: "messages", session: service.session });
			expect(payload.messages).toHaveLength(1);
			expect(payload.messages[0]).toMatchObject({ text: "Can you check checkout?", from: { account: "Builder key", cwd: null } });
			// Delivered, so not queued again.
			const inbox = (await (await request(`${base}/${service.session}/inbox`, { headers: reviewer })).json()) as { messages: unknown[] };
			expect(inbox.messages).toEqual([]);

			// With a webhook the session stays open between calls.
			await runInDurableObject(relayStub(`organization:${organizationId}`), async (instance) => {
				(instance as unknown as { sessions: Map<string, { lastSeen: number }> }).sessions.get(service.session)!.lastSeen = 0;
			});
			expect((await request(`${base}/${service.session}/peers`, { headers: reviewer })).status).toBe(200);
			// Removing it brings back the usual idle timeout.
			expect((await request(`${base}/${service.session}/webhook`, json(reviewer, { url: null }))).status).toBe(200);
		}));

	it("keeps a message queued when the webhook fails, for a retry or an inbox read", () =>
		withHandshakes(async () => {
			stubHook();
			hookStatus = 500;
			const { organizationId, builder, reviewer } = await organizationWithKeys();
			const base = `/api/organizations/${organizationId}/handshake-sessions`;
			const service = await join(organizationId, reviewer, "support");
			const talker = await join(organizationId, builder, "builder");
			expect((await request(`${base}/${service.session}/webhook`, json(reviewer, { url: HOOK }))).status).toBe(201);
			await request(`${base}/${talker.session}/messages`, json(builder, { to: service.peer.id, text: "Still there?" }));
			await eventually(() => hookCalls[0]);
			const inbox = await eventually(async () => {
				const read = (await (await request(`${base}/${service.session}/inbox`, { headers: reviewer })).json()) as { messages: Array<{ text: string }> };
				return read.messages.length ? read : undefined;
			});
			expect(inbox.messages.map((message) => message.text)).toEqual(["Still there?"]);
			// A retry is scheduled rather than hammering a failing endpoint.
			await runInDurableObject(relayStub(`organization:${organizationId}`), async (instance, state) => {
				const hook = (instance as unknown as { sessions: Map<string, { webhook?: { failures: number; retryAt: number } }> }).sessions.get(service.session)!.webhook!;
				expect(hook.failures).toBe(1);
				expect(hook.retryAt).toBeGreaterThan(Date.now());
				expect(await state.storage.getAlarm()).toBeLessThanOrEqual(hook.retryAt);
			});
			expect(hookCalls).toHaveLength(1);
		}));
});
