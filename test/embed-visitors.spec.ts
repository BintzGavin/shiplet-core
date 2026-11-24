// Public visitors on a website with the Shiplet widget. An editor turns
// visitor feedback on per installation (it is off by default). A visitor who
// passes a Turnstile check on Shiplet's own frame can leave an annotation
// marked as from a visitor. Feedback is one way: visitors never talk with
// agents, which is only for signed-in members. Every limit fails closed.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { executeHandshakeCodeModeRequest } from "../src/handshakes/codemode";

type TestEnv = Omit<Env, "SHIPLET_ENABLED_FEATURE_FLAGS"> & { SHIPLET_ENABLED_FEATURE_FLAGS?: string; TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET?: string };
const testEnv = env as unknown as TestEnv;

const OWNER = { "x-shiplet-user-id": "user_visitors_owner", "x-shiplet-user-email": "visitors-owner@example.com" };
const OUTSIDER = { "x-shiplet-user-id": "user_visitors_outsider", "x-shiplet-user-email": "visitors-outsider@example.com" };
const SITE_ORIGIN = "https://shop.example.com";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

async function request(path: string, init: RequestInit = {}) {
	const context = createExecutionContext();
	let response: Response;
	try {
		response = await app.fetch(new Request(`http://localhost${path}`, init), env as Env, context);
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

// Turnstile's siteverify, answered by the test. Every other outbound call is refused.
type Verdict = { success: boolean; action?: string; hostname?: string };
let verdict: Verdict = { success: true, action: "visitor", hostname: "localhost" };
const siteverifyCalls: URLSearchParams[] = [];
const realFetch = globalThis.fetch;
function stubSiteverify() {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input) === SITEVERIFY) {
			siteverifyCalls.push(new URLSearchParams(String(init?.body ?? "")));
			return Response.json({ ...verdict, "error-codes": verdict.success ? [] : ["invalid-input-response"] });
		}
		return realFetch(input, init);
	}) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	verdict = { success: true, action: "visitor", hostname: "localhost" };
	siteverifyCalls.length = 0;
	delete testEnv.TURNSTILE_SITE_KEY;
	delete testEnv.TURNSTILE_SECRET;
	testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = "";
});

function configureTurnstile() {
	testEnv.TURNSTILE_SITE_KEY = "0x4AAAAAAAtest-site-key";
	testEnv.TURNSTILE_SECRET = "test-secret-not-real";
	stubSiteverify();
}

async function installedShop() {
	const organization = await request("/api/organizations", json(OWNER, { name: `Visitors ${crypto.randomUUID()}` }));
	const organizationId = ((await organization.json()) as { organization: { id: string } }).organization.id;
	const created = await request(
		"/api/shiplets",
		json(OWNER, { name: "Shop", organization_id: organizationId, subdomain: `visitors-${crypto.randomUUID().slice(0, 8)}`, external_url: `${SITE_ORIGIN}/` }),
	);
	const projectId = ((await created.json()) as { project: { id: string } }).project.id;
	const installed = await request("/embed/install", setupForm(OWNER, { project_id: projectId, site_url: `${SITE_ORIGIN}/` }));
	expect(installed.status).toBe(200);
	const row = await testEnv.DB.prepare("SELECT id FROM embed_installations WHERE project_id = ? AND revoked_on IS NULL").bind(projectId).first<{ id: string }>();
	return { organizationId, projectId, installationId: row!.id };
}

function setupForm(headers: Record<string, string>, fields: Record<string, string>): RequestInit {
	return { method: "POST", headers: { ...headers, Origin: "http://localhost" }, body: new URLSearchParams(fields) };
}

async function setVisitors(projectId: string, installationId: string, on: boolean, headers = OWNER) {
	return request("/embed/install", setupForm(headers, { project_id: projectId, action: on ? "visitors_on" : "visitors_off", installation_id: installationId }));
}

async function visitorSession(installationId: string, pageUrl = `${SITE_ORIGIN}/pricing/`) {
	const response = await request(
		"/api/embed/visitors/session",
		json({ "CF-Connecting-IP": "203.0.113.9", "sec-fetch-site": "same-origin" }, { installation_id: installationId, turnstile_token: "XXXX.DUMMY.TOKEN.XXXX", page_url: pageUrl }),
	);
	return response;
}

async function visitor(installationId: string, pageUrl?: string) {
	const response = await visitorSession(installationId, pageUrl);
	expect(response.status, await response.clone().text()).toBe(201);
	const { token } = (await response.json()) as { token: string };
	return { authorization: `Bearer ${token}` };
}

function annotation(comment: string, pageUrl = `${SITE_ORIGIN}/pricing/`) {
	return { comment, pageUrl, viewport: { width: 1280, height: 720 }, selectedElement: { selector: "main > button.pay", tagName: "BUTTON", text: "Pay" } };
}

describe("visitor feedback on a public website", () => {
	it("is off until an editor turns it on, and only an editor can", async () => {
		configureTurnstile();
		const { projectId, installationId } = await installedShop();

		const off = (await (await request(`/api/embed/visitors/config?installation_id=${installationId}`)).json()) as Record<string, unknown>;
		expect(off).toEqual({ enabled: false });
		const refused = await visitorSession(installationId);
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toBe("visitors_off");
		expect(siteverifyCalls).toHaveLength(0);

		await request("/api/me", { headers: OUTSIDER });
		expect((await setVisitors(projectId, installationId, true, OUTSIDER)).status).toBeGreaterThanOrEqual(400);

		const turnedOn = await setVisitors(projectId, installationId, true);
		expect(turnedOn.status).toBe(200);
		expect(await turnedOn.text()).toContain("Visitor feedback is on");
		const on = (await (await request(`/api/embed/visitors/config?installation_id=${installationId}`)).json()) as Record<string, unknown>;
		expect(on).toEqual({ enabled: true, siteKey: "0x4AAAAAAAtest-site-key" });

		expect((await setVisitors(projectId, installationId, false)).status).toBe(200);
		expect(((await (await request(`/api/embed/visitors/config?installation_id=${installationId}`)).json()) as { enabled: boolean }).enabled).toBe(false);
	});

	it("fails closed without Turnstile configured, and admits only a passed check made for Shiplet's frame", async () => {
		const { projectId, installationId } = await installedShop();

		// No Turnstile keys on this server: an editor cannot turn it on...
		expect((await setVisitors(projectId, installationId, true)).status).toBe(409);
		// ...and if the keys go away after it was turned on, it stops.
		configureTurnstile();
		expect((await setVisitors(projectId, installationId, true)).status).toBe(200);
		delete testEnv.TURNSTILE_SECRET;
		expect(((await (await request(`/api/embed/visitors/config?installation_id=${installationId}`)).json()) as { enabled: boolean }).enabled).toBe(false);
		expect((await visitorSession(installationId)).status).toBe(503);

		configureTurnstile();
		for (const failing of [
			{ success: false },
			{ success: true, action: "login", hostname: "localhost" },
			{ success: true, action: "visitor", hostname: "shop.example.com" },
		]) {
			verdict = failing;
			const response = await visitorSession(installationId);
			expect(response.status, JSON.stringify(failing)).toBe(403);
			expect(((await response.json()) as { error: string }).error).toBe("turnstile_failed");
		}

		verdict = { success: true, action: "visitor", hostname: "localhost" };
		const passed = await visitorSession(installationId);
		expect(passed.status).toBe(201);
		const body = (await passed.json()) as { token: string; expiresOn: string };
		expect(body.token).toMatch(/^shiplet_visitor_[0-9a-f]{48}$/);
		const sent = siteverifyCalls.at(-1)!;
		expect(sent.get("secret")).toBe("test-secret-not-real");
		expect(sent.get("response")).toBe("XXXX.DUMMY.TOKEN.XXXX");
		expect(sent.get("remoteip")).toBe("203.0.113.9");

		// A page on another origin is not this installation's.
		expect((await visitorSession(installationId, "https://evil.example.net/")).status).toBe(400);
		// The token itself is never stored.
		const stored = await testEnv.DB.prepare("SELECT * FROM embed_visitor_sessions WHERE installation_id = ?").bind(installationId).all();
		expect(JSON.stringify(stored.results)).not.toContain(body.token);
	});

	it("records a visitor's annotation as from a visitor, on the installation's own pages, within limits", async () => {
		configureTurnstile();
		const { projectId, installationId } = await installedShop();
		await setVisitors(projectId, installationId, true);
		const guest = await visitor(installationId);

		expect((await request("/api/embed/visitors/feedback", json({}, annotation("No token")))).status).toBe(401);
		expect((await request("/api/embed/visitors/feedback", json(guest, annotation("Elsewhere", "https://evil.example.net/")))).status).toBe(400);
		expect((await request("/api/embed/visitors/feedback", json(guest, annotation("x".repeat(2001))))).status).toBe(400);

		const created = await request("/api/embed/visitors/feedback", json(guest, annotation("The Pay button does nothing on my phone.")));
		expect(created.status, await created.clone().text()).toBe(201);
		const { feedback } = (await created.json()) as { feedback: { id: string; ticket_label: string } };
		expect(feedback.ticket_label).toMatch(/^[A-Z]+-\d+$/);
		const row = await testEnv.DB.prepare("SELECT * FROM review_feedback WHERE id = ?").bind(feedback.id).first<Record<string, unknown>>();
		expect(row).toMatchObject({ source: "visitor", name: "Visitor", submitted_by_user_id: null, submitted_by_email: null, page_url: `${SITE_ORIGIN}/pricing/` });
		expect(JSON.parse(String(row!.selected_element_json))).toMatchObject({ selector: "main > button.pay" });

		// Members see it, marked as from a visitor.
		const listed = (await (await request(`/api/projects/${projectId}/review-feedback`, { headers: OWNER })).json()) as { feedback: Array<{ id: string; source: string }> };
		expect(listed.feedback.find((item) => item.id === feedback.id)?.source).toBe("visitor");

		// Five annotations per visitor per ten minutes.
		for (let index = 2; index <= 5; index++) {
			expect((await request("/api/embed/visitors/feedback", json(guest, annotation(`Note ${index}`)))).status).toBe(201);
		}
		const limited = await request("/api/embed/visitors/feedback", json(guest, annotation("Note 6")));
		expect(limited.status).toBe(429);
		expect(((await limited.json()) as { error: string }).error).toBe("rate_limited");

		// Turning visitor feedback off stops existing visitors at once.
		const another = await visitor(installationId);
		await setVisitors(projectId, installationId, false);
		expect((await request("/api/embed/visitors/feedback", json(another, annotation("After off")))).status).toBe(401);
	});

	it("offers visitors no chat: the chat routes and going on duty are gone", async () => {
		configureTurnstile();
		testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = "agent-handshakes";
		const { organizationId, projectId, installationId } = await installedShop();
		await setVisitors(projectId, installationId, true);
		const guest = await visitor(installationId);
		const unknown = await request("/api/embed/no-such-route", { headers: guest });

		// A valid visitor token reaches the same not-found as any unknown route.
		for (const [path, init] of [
			["/api/embed/visitors/chat", { headers: guest }],
			["/api/embed/visitors/chat", json(guest, { text: "Does the Pro plan include SSO?" })],
			["/api/embed/visitors/chat/inbox?wait=0", { headers: guest }],
		] as Array<[string, RequestInit]>) {
			const response = await request(path, init);
			expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(404);
			expect(response.headers.get("content-type")).toBe(unknown.headers.get("content-type"));
		}

		// An agent cannot go on duty for a Shiplet, over REST or Code Mode's paths.
		const base = `/api/organizations/${organizationId}`;
		const tokenResponse = await request(`${base}/api-tokens`, json(OWNER, { name: "Support agent", scopes: ["mcp", "feedback:read"], projectAccessMode: "all" }));
		const supportKey = { authorization: `Bearer ${((await tokenResponse.json()) as { token: string }).token}` };
		const opened = await request(`${base}/handshake-sessions`, json(supportKey, { name: "support", kind: "claude", app: "claude-cli" }));
		expect(opened.status).toBe(201);
		const support = (await opened.json()) as { session: string };
		expect((await request(`${base}/handshake-sessions/${support.session}/duty`, json(supportKey, { shiplet: projectId }))).status).toBe(404);
		const viaCodeMode = await executeHandshakeCodeModeRequest(env as Env, { kind: "token", token: {} as never }, { method: "POST", path: `${base}/handshake-sessions/${support.session}/duty`, body: { shiplet: projectId } }).then(
			() => null,
			(thrown: unknown) => thrown,
		);
		expect(viaCodeMode).toBeInstanceOf(Response);
		expect((viaCodeMode as Response).status).toBe(404);
		expect(await (viaCodeMode as Response).text()).toBe("Code Mode request path is not supported.");

		// "visitor" is no peer kind: joining as one is joining as "other", and no peer list shows a visitor.
		const joined = await request(`${base}/handshake-sessions`, json(supportKey, { name: "pretender", kind: "visitor" }));
		expect(joined.status).toBe(201);
		const pretender = (await joined.json()) as { session: string; peer: { kind: string } };
		expect(pretender.peer.kind).toBe("other");
		const peers = (await (await request(`${base}/handshake-sessions/${support.session}/peers`, { headers: supportKey })).json()) as { peers: Array<{ kind: string }> };
		expect(peers.peers.map((peer) => peer.kind).sort()).toEqual(["claude", "other"]);

		// A visitor token opens nothing in the organization.
		expect((await request(`${base}/handshake-sessions`, json(guest, { kind: "person" }))).status).toBe(401);
		// Visitor sessions keep no relay session.
		const row = await testEnv.DB.prepare("SELECT relay_session FROM embed_visitor_sessions WHERE installation_id = ?").bind(installationId).first<{ relay_session: string | null }>();
		expect(row?.relay_session).toBeNull();
	});

	it("serves the visitor frame only while visitor feedback is on, locked to the site and Turnstile", async () => {
		configureTurnstile();
		const { projectId, installationId } = await installedShop();
		const frame = (query = "") => request(`/embed/visitor/frame?installation_id=${installationId}${query}`);
		const start = () => request(`/embed/review/start?${new URLSearchParams({ installation_id: installationId, return_url: `${SITE_ORIGIN}/pricing/` })}`, { redirect: "manual" });

		expect((await frame()).status).toBe(404);
		expect(await (await start()).text()).not.toContain("Leave feedback without an account");

		await setVisitors(projectId, installationId, true);
		const signedOut = await (await start()).text();
		expect(signedOut).toContain('aria-label="Leave feedback without an account"');
		expect(signedOut).toContain("/embed/visitor/frame?installation_id=");

		const page = await frame(`&return_url=${encodeURIComponent(`${SITE_ORIGIN}/pricing/?token=secret`)}`);
		expect(page.status).toBe(200);
		const csp = page.headers.get("content-security-policy") || "";
		expect(csp).toContain(`frame-ancestors 'self' ${SITE_ORIGIN}`);
		expect(csp).toContain("frame-src https://challenges.cloudflare.com");
		expect(csp).toContain("connect-src 'self'");
		expect(csp).toContain("script-src-attr 'none'");
		const html = await page.text();
		expect(html).toContain('data-site-key="0x4AAAAAAAtest-site-key"');
		// Credential-shaped query values never reach the frame.
		expect(html).not.toContain("secret");
		expect(html).not.toMatch(/<script>(?!<)/);

		// The frame offers a note and nothing else: no question to an agent.
		expect(html).toContain("data-visitor-note");
		expect(html).toContain("Send note");
		for (const gone of ['data-visitor-step="chat"', "data-visitor-chat", "visitorAsk", "Your question", "answering visitors", ">Ask"]) {
			expect(html).not.toContain(gone);
		}

		// The frame's own script sets every server value as text, and only ever
		// starts a visitor session and sends notes.
		const script = await (await request("/api/embed/visitor.js")).text();
		expect([...script.matchAll(/"(\/api\/[^"]*)"/g)].map((match) => match[1]).sort()).toEqual(["/api/embed/visitors/feedback", "/api/embed/visitors/session"]);
		for (const gone of ["visitors/chat", "inbox", "data-visitor-chat", "Nobody is answering", "poll"]) expect(script).not.toContain(gone);
		const css = await (await request("/api/embed/visitor.css")).text();
		expect(css).not.toContain("visitor-lines");
		expect(script).not.toContain("innerHTML");
		expect(script).toContain('action: "visitor"');
		// A failed check waits for the person; it never resets Turnstile on its own.
		const exchange = script.slice(script.indexOf("async function exchange"), script.indexOf("function renderCheck"));
		expect(exchange).not.toContain("turnstile.reset");
	});
});
