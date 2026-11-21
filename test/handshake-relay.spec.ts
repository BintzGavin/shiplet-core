// The hosted Agent Handshake relay: one per organization, same Hub as the
// local broker. Agents in an organization find each other, talk, tie a
// handshake to an annotation they can read, and export recorded handshakes as
// traces. Nobody outside the organization gets in, and a session belongs to
// the actor that opened it.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { admitToOrganization } from "../src/handshakes/handlers";
import { parseJsonl } from "../src/cli/trace-core.mjs";

type TestEnv = Omit<Env, "SHIPLET_ENABLED_FEATURE_FLAGS"> & { SHIPLET_ENABLED_FEATURE_FLAGS?: string };
const testEnv = env as unknown as TestEnv;
const runtimeEnv = env as unknown as Env;

const person = (id: string) => ({ "x-shiplet-user-id": `user_hs_${id}`, "x-shiplet-user-email": `${id}@handshake.test` });
const OWNER = person("owner");
const COLLEAGUE = person("colleague");
const OUTSIDER = person("outsider");

async function request(path: string, init: RequestInit = {}) {
	const context = createExecutionContext();
	let response: Response;
	try {
		response = await app.fetch(new Request(`http://localhost${path}`, init), runtimeEnv, context);
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

async function organization(owner: Record<string, string>) {
	const created = await request("/api/organizations", json(owner, { name: `Handshakes ${crypto.randomUUID()}` }));
	expect(created.status).toBe(201);
	return ((await created.json()) as { organization: { id: string } }).organization.id;
}

async function shiplet(organizationId: string, visibility: "organization" | "private") {
	const created = await request(
		"/api/shiplets",
		json(OWNER, {
			name: "Checkout",
			organization_id: organizationId,
			subdomain: `hs-${crypto.randomUUID().slice(0, 8)}`,
			visibility,
			assets: [{ path: "index.html", content: btoa("<h1>Checkout</h1><button>Pay</button>") }],
		}),
	);
	expect(created.status).toBe(201);
	return ((await created.json()) as { project: { id: string } }).project.id;
}

async function annotation(projectId: string, comment: string) {
	const created = await request(
		`/api/projects/${projectId}/review-feedback`,
		json(
			{ ...OWNER, Origin: "http://localhost" },
			{
				clientFeedbackId: `hs-${crypto.randomUUID()}`,
				comment,
				name: OWNER["x-shiplet-user-email"],
				pageUrl: "http://localhost/",
				screenshotMode: "page",
				mentions: [],
				viewport: { width: 1280, height: 720 },
			},
		),
	);
	expect(created.status, await created.clone().text()).toBeLessThan(300);
	return ((await created.json()) as { feedback: { id: string; ticket_label: string } }).feedback;
}

async function apiKey(organizationId: string, scopes: string[]) {
	const response = await request(
		`/api/organizations/${organizationId}/api-tokens`,
		json(OWNER, { name: `Codex on the CI runner`, scopes, projectAccessMode: "all" }),
	);
	expect(response.status).toBe(201);
	return { authorization: `Bearer ${((await response.json()) as { token: string }).token}` };
}

async function setup() {
	const organizationId = await organization(OWNER);
	await request("/api/me", { headers: COLLEAGUE });
	await request("/api/me", { headers: OUTSIDER });
	await testEnv.DB.prepare("INSERT INTO organization_memberships (id, organization_id, user_id, role, created_on) VALUES (?, ?, ?, 'member', ?)")
		.bind(`orgm_${crypto.randomUUID()}`, organizationId, COLLEAGUE["x-shiplet-user-id"], new Date().toISOString())
		.run();
	return organizationId;
}

const base = (organizationId: string) => `/api/organizations/${organizationId}`;

async function open(organizationId: string, headers: Record<string, string>, peer: Record<string, unknown>) {
	const response = await request(`${base(organizationId)}/handshake-sessions`, json(headers, peer));
	expect(response.status, await response.clone().text()).toBe(201);
	return (await response.json()) as { session: string; peer: { id: string; name: string; account: string } };
}

describe("hosted handshake relay", () => {
	it("is off unless the agent-handshakes flag is on", async () => {
		const organizationId = await setup();
		const response = await request(`${base(organizationId)}/handshake-sessions`, json(OWNER, { name: "builder" }));
		expect(response.status).toBe(404);
		expect(((await response.json()) as { error: string }).error).toBe("handshakes_not_enabled");
	});

	it("lets agents in one organization find each other, talk about an annotation, and export the handshake", async () => {
		await withHandshakes(async () => {
			const organizationId = await setup();
			const projectId = await shiplet(organizationId, "organization");
			const feedback = await annotation(projectId, "The pay button label is too light.");
			const codex = await apiKey(organizationId, ["mcp", "feedback:read"]);

			const builder = await open(organizationId, OWNER, { name: "builder", kind: "claude", app: "claude-cli", machine: "studio", cwd: "/Users/someone/secret", session: "local-1" });
			const checker = await open(organizationId, codex, { name: "checker", kind: "codex", app: "codex-cli", machine: "ci-runner" });
			expect(builder.session).toMatch(/^hss_[0-9a-f]{36}$/);
			expect(builder.peer).toMatchObject({ name: "builder", kind: "claude", account: "owner@handshake.test" });
			expect(checker.peer.account).toBe("Codex on the CI runner");

			// Peers carry who each agent acts for, and nothing local (cwd, session).
			const peers = await request(`${base(organizationId)}/handshake-sessions/${checker.session}/peers`, { headers: codex });
			const listed = (await peers.json()) as { self: string; peers: Array<Record<string, unknown>> };
			expect(listed.self).toBe(checker.peer.id);
			expect(listed.peers.map((peer) => peer.name).sort()).toEqual(["builder", "checker"]);
			expect(JSON.stringify(listed)).not.toContain("/Users/someone/secret");
			expect(JSON.stringify(listed)).not.toContain("local-1");

			// The checker waits; the builder opens a recorded handshake for the annotation.
			const waiting = request(`${base(organizationId)}/handshake-sessions/${checker.session}/inbox?wait=5`, { headers: codex });
			const sent = await request(
				`${base(organizationId)}/handshake-sessions/${builder.session}/messages`,
				json(OWNER, {
					to: "checker",
					text: "Can you run the contrast check on the new version?",
					record: true,
					topic: "Pay button contrast",
					request: { shiplet: projectId, feedback: feedback.id, label: "forged label" },
				}),
			);
			expect(sent.status, await sent.clone().text()).toBe(200);
			const delivery = (await sent.json()) as { handshake: string; status: string; recorded: boolean };
			expect(delivery).toMatchObject({ status: "delivered", recorded: true });
			const inbox = (await (await waiting).json()) as { messages: Array<{ text: string; room: string; from: Record<string, unknown> }> };
			expect(inbox.messages).toHaveLength(1);
			expect(inbox.messages[0]).toMatchObject({ text: "Can you run the contrast check on the new version?", room: delivery.handshake });
			expect(inbox.messages[0].from).toMatchObject({ name: "builder", account: "owner@handshake.test", cwd: null, session: null });

			const reply = await request(
				`${base(organizationId)}/handshake-sessions/${checker.session}/messages`,
				json(codex, { to: "builder", handshake: delivery.handshake, text: "Passes at 4.8:1." }),
			);
			expect(reply.status).toBe(200);

			// Any member can watch: the handshake, its annotation (with the server's label) and, since it is recorded, what was said.
			const watched = await request(`${base(organizationId)}/handshakes`, { headers: COLLEAGUE });
			const { handshakes } = (await watched.json()) as { handshakes: Array<Record<string, any>> };
			expect(handshakes).toHaveLength(1);
			expect(handshakes[0]).toMatchObject({ id: delivery.handshake, topic: "Pay button contrast", record: true, messageCount: 2 });
			expect(handshakes[0].request).toEqual({ shiplet: projectId, feedback: feedback.id, label: feedback.ticket_label });
			expect(handshakes[0].transcript.map((message: { text: string }) => message.text)).toEqual([
				"Can you run the contrast check on the new version?",
				"Passes at 4.8:1.",
			]);

			// A participant exports it as a shiplet.trace/v1 file.
			const exported = await request(
				`${base(organizationId)}/handshake-sessions/${checker.session}/handshakes/${delivery.handshake}/export`,
				json(codex),
			);
			expect(exported.status).toBe(200);
			const { trace } = (await exported.json()) as { trace: string };
			const parsed = parseJsonl(trace);
			expect(parsed.records[0]).toMatchObject({ format: "shiplet.trace/v1", harness: "agent-handshake", title: "Handshake: Pay button contrast" });

			// Leaving ends the handshake once nobody is left in it.
			expect((await request(`${base(organizationId)}/handshake-sessions/${builder.session}`, json(OWNER, undefined, "DELETE"))).status).toBe(200);
			expect((await request(`${base(organizationId)}/handshake-sessions/${checker.session}`, json(codex, undefined, "DELETE"))).status).toBe(200);
			const after = (await (await request(`${base(organizationId)}/handshakes`, { headers: OWNER })).json()) as { handshakes: unknown[] };
			expect(after.handshakes).toEqual([]);
		});
	});

	it("keeps out anyone outside the organization, and a session belongs to whoever opened it", async () => {
		await withHandshakes(async () => {
			const organizationId = await setup();
			const otherOrganization = await organization(OUTSIDER);
			const builder = await open(organizationId, OWNER, { name: "builder" });

			expect((await request(`${base(organizationId)}/handshakes`, { headers: OUTSIDER })).status).toBe(404);
			expect((await request(`${base(organizationId)}/handshake-sessions`, json(OUTSIDER, { name: "intruder" }))).status).toBe(404);
			expect((await request(`${base(organizationId)}/handshakes`)).status).toBe(401);

			const foreignKey = await apiKey(otherOrganization, ["mcp"]).catch(() => null);
			if (foreignKey) expect((await request(`${base(organizationId)}/handshakes`, { headers: foreignKey })).status).toBe(404);
			const noMcp = await apiKey(organizationId, ["feedback:read"]);
			expect((await request(`${base(organizationId)}/handshake-sessions`, json(noMcp, { name: "agent" }))).status).toBe(403);

			// A colleague cannot drive the builder's session.
			const hijack = await request(`${base(organizationId)}/handshake-sessions/${builder.session}/inbox`, { headers: COLLEAGUE });
			expect(hijack.status).toBe(404);
			expect(((await hijack.json()) as { error: string }).error).toBe("session_not_found");

			// Browser sessions only act from Shiplet's own pages.
			const crossSite = await request(`${base(organizationId)}/handshake-sessions`, json({ ...OWNER, "sec-fetch-site": "cross-site" }, { name: "x" }));
			expect(crossSite.status).toBe(403);
		});
	});

	it("ties a handshake only to an annotation the opener can read, and hides it from members who cannot", async () => {
		await withHandshakes(async () => {
			const organizationId = await setup();
			const privateShiplet = await shiplet(organizationId, "private");
			const feedback = await annotation(privateShiplet, "Private checkout note.");
			const owner = await open(organizationId, OWNER, { name: "builder" });
			const colleague = await open(organizationId, COLLEAGUE, { name: "helper" });
			const blindKey = await apiKey(organizationId, ["mcp"]);
			const blind = await open(organizationId, blindKey, { name: "blind" });

			const missing = await request(
				`${base(organizationId)}/handshake-sessions/${owner.session}/messages`,
				json(OWNER, { to: "helper", text: "hi", request: { shiplet: privateShiplet, feedback: "fb_missing" } }),
			);
			expect(missing.status).toBe(404);
			expect(((await missing.json()) as { error: string }).error).toBe("request_not_found");

			// The colleague cannot read the private Shiplet, so cannot claim its annotation.
			const claimed = await request(
				`${base(organizationId)}/handshake-sessions/${colleague.session}/messages`,
				json(COLLEAGUE, { to: "builder", text: "hi", request: { shiplet: privateShiplet, feedback: feedback.id } }),
			);
			expect(claimed.status).toBe(404);
			// Neither can an API key without feedback:read.
			const keyClaim = await request(
				`${base(organizationId)}/handshake-sessions/${blind.session}/messages`,
				json(blindKey, { to: "builder", text: "hi", request: { shiplet: privateShiplet, feedback: feedback.id } }),
			);
			expect(keyClaim.status).toBe(404);

			const opened = await request(
				`${base(organizationId)}/handshake-sessions/${owner.session}/messages`,
				json(OWNER, { to: "helper", text: "Look at this with me?", request: { shiplet: privateShiplet, feedback: feedback.id } }),
			);
			expect(opened.status).toBe(200);
			const asOwner = (await (await request(`${base(organizationId)}/handshakes`, { headers: OWNER })).json()) as { handshakes: Array<Record<string, any>> };
			expect(asOwner.handshakes[0].request.feedback).toBe(feedback.id);
			const asColleague = (await (await request(`${base(organizationId)}/handshakes`, { headers: COLLEAGUE })).json()) as { handshakes: Array<Record<string, any>> };
			expect(asColleague.handshakes[0].request).toBeNull();
			// Not recorded: who and how many, never what was said.
			expect(asColleague.handshakes[0]).toMatchObject({ record: false, messageCount: 1, transcript: null });

			const notRecorded = await request(
				`${base(organizationId)}/handshake-sessions/${owner.session}/handshakes/${asOwner.handshakes[0].id}/export`,
				json(OWNER),
			);
			expect(notRecorded.status).toBe(409);
		});
	});

	it("works the same through Code Mode MCP", async () => {
		await withHandshakes(async () => {
			const organizationId = await setup();
			const execute = async (headers: Record<string, string>, code: string) => {
				const response = await request(
					"/api/mcp",
					json(headers, { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: "execute", arguments: { code } } }),
				);
				const value = (await response.json()) as Record<string, any>;
				const text = value.result?.content?.[0]?.text;
				return { isError: value.result?.isError === true, text, output: (() => { try { return JSON.parse(text); } catch { return text; } })() };
			};
			const path = `/api/organizations/${organizationId}`;
			const opened = await execute(OWNER, `async () => await codemode.request({ method: "POST", path: "${path}/handshake-sessions", body: { name: "builder", kind: "claude" } })`);
			expect(opened.isError, opened.text).toBe(false);
			const helper = await open(organizationId, COLLEAGUE, { name: "helper", kind: "codex" });
			const sent = await execute(
				OWNER,
				`async () => {
					const session = ${JSON.stringify(opened.output.session)};
					const peers = await codemode.request({ method: "GET", path: "${path}/handshake-sessions/" + session + "/peers" });
					return codemode.request({ method: "POST", path: "${path}/handshake-sessions/" + session + "/messages", body: { to: peers.peers.find((p) => p.name === "helper").id, text: "From Code Mode" } });
				}`,
			);
			expect(sent.isError, sent.text).toBe(false);
			const inbox = (await (await request(`${path}/handshake-sessions/${helper.session}/inbox`, { headers: COLLEAGUE })).json()) as { messages: Array<{ text: string }> };
			expect(inbox.messages.map((message) => message.text)).toEqual(["From Code Mode"]);
			const listed = await execute(OWNER, `async () => await codemode.request({ method: "GET", path: "${path}/handshakes" })`);
			expect(listed.output.handshakes).toHaveLength(1);
		});
	});

	it("admits an MCP OAuth agent only for the organization it selected, with the mcp permission", async () => {
		await withHandshakes(async () => {
			const organizationId = await setup();
			const subject = { id: COLLEAGUE["x-shiplet-user-id"], email: COLLEAGUE["x-shiplet-user-email"], created_on: "", updated_on: "" };
			const principal = (organization: string | null, permissions: string[]) =>
				({ kind: "oauth_agent", principal: { actorId: "mcp-oauth:client:grant", subject, organizationId: organization, permissions } }) as never;
			const admitted = await admitToOrganization(runtimeEnv, principal(organizationId, ["mcp"]), organizationId);
			expect(admitted).toMatchObject({ organizationId, owner: { actor: "mcp-oauth:client:grant", account: COLLEAGUE["x-shiplet-user-email"] } });
			expect(((await admitToOrganization(runtimeEnv, principal("org_other", ["mcp"]), organizationId)) as Response).status).toBe(404);
			expect(((await admitToOrganization(runtimeEnv, principal(null, ["mcp"]), organizationId)) as Response).status).toBe(404);
			expect(((await admitToOrganization(runtimeEnv, principal(organizationId, ["feedback:read"]), organizationId)) as Response).status).toBe(403);
		});
	});
});
