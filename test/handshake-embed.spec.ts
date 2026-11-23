// A person reviewing a Shiplet through the website widget talks with the
// organization's agents. The embedded frame cannot carry the platform session,
// so the relay accepts the embed review session instead, and only for what a
// person at a review page needs: join as a person from the widget, see who is
// connected, send, read and leave. Nothing else, and only for members of the
// Shiplet's organization.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";

type TestEnv = Omit<Env, "SHIPLET_ENABLED_FEATURE_FLAGS"> & { SHIPLET_ENABLED_FEATURE_FLAGS?: string };
const testEnv = env as unknown as TestEnv;
const runtimeEnv = env as unknown as Env;

const OWNER = {
	"x-shiplet-user-id": "user_hs_embed_owner",
	"x-shiplet-user-email": "embed-owner@handshake.test",
	"x-shiplet-user-first-name": "Dana",
	"x-shiplet-user-last-name": "Reyes",
};
const VISITOR = { "x-shiplet-user-id": "user_hs_embed_visitor", "x-shiplet-user-email": "visitor@handshake.test" };
const SITE_ORIGIN = "https://client.example.com";
const PAGE_URL = `${SITE_ORIGIN}/pricing/`;

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

async function organization() {
	const created = await request("/api/organizations", json(OWNER, { name: `Embed handshakes ${crypto.randomUUID()}` }));
	expect(created.status).toBe(201);
	return ((await created.json()) as { organization: { id: string } }).organization.id;
}

async function website(organizationId: string) {
	const created = await request(
		"/api/shiplets",
		json(OWNER, {
			name: "Client website",
			organization_id: organizationId,
			subdomain: `hs-embed-${crypto.randomUUID().slice(0, 8)}`,
			external_url: `${SITE_ORIGIN}/`,
		}),
	);
	expect(created.status).toBe(201);
	const projectId = ((await created.json()) as { project: { id: string } }).project.id;
	const installed = await request("/embed/install", {
		method: "POST",
		headers: { ...OWNER, Origin: "http://localhost" },
		body: new URLSearchParams({ project_id: projectId, site_url: `${SITE_ORIGIN}/` }),
	});
	expect(installed.status).toBe(200);
	const row = await runtimeEnv.DB.prepare("SELECT id FROM embed_installations WHERE project_id = ? AND site_origin = ? AND revoked_on IS NULL")
		.bind(projectId, SITE_ORIGIN)
		.first<{ id: string }>();
	expect(row?.id).toBeTruthy();
	return { projectId, installationId: row!.id };
}

// Signs a reviewer in through the widget and returns what the trusted frame
// holds: the partitioned embed cookie and the host URL.
async function embedSession(installationId: string, who: Record<string, string> = OWNER) {
	const start = await request(`/embed/review/start?${new URLSearchParams({ installation_id: installationId, return_url: PAGE_URL })}`, {
		redirect: "manual",
		headers: who,
	});
	expect(start.status).toBe(302);
	return { cookie: (start.headers.get("set-cookie") || "").split(";", 1)[0], host: new URL(start.headers.get("location") || "") };
}

// What the trusted frame sends: its own origin, the embed cookie, no platform session.
const frame = (cookie: string) => ({ Cookie: cookie, "sec-fetch-site": "same-origin", Origin: "http://localhost" });

async function annotation(projectId: string, comment: string) {
	const created = await request(
		`/api/projects/${projectId}/review-feedback`,
		json(
			{ ...OWNER, Origin: "http://localhost" },
			{
				clientFeedbackId: `hs-${crypto.randomUUID()}`,
				comment,
				name: OWNER["x-shiplet-user-email"],
				pageUrl: PAGE_URL,
				screenshotMode: "page",
				mentions: [],
				viewport: { width: 1280, height: 720 },
			},
		),
	);
	expect(created.status, await created.clone().text()).toBeLessThan(300);
	return ((await created.json()) as { feedback: { id: string; ticket_label: string } }).feedback;
}

async function agentKey(organizationId: string) {
	const response = await request(`/api/organizations/${organizationId}/api-tokens`, json(OWNER, { name: "Builder", scopes: ["mcp"], projectAccessMode: "all" }));
	expect(response.status).toBe(201);
	return { authorization: `Bearer ${((await response.json()) as { token: string }).token}` };
}

const sessions = (organizationId: string, installationId: string, path = "") =>
	`/api/organizations/${organizationId}/handshake-sessions${path}?installation_id=${encodeURIComponent(installationId)}`;

describe("handshakes from the website widget", () => {
	it("lets a signed-in member join from the widget as a person and talk with an agent", async () => {
		await withHandshakes(async () => {
			const organizationId = await organization();
			const { projectId, installationId } = await website(organizationId);
			const feedback = await annotation(projectId, "The pay button is too light.");
			const { cookie } = await embedSession(installationId);
			const agent = await agentKey(organizationId);
			const builder = await request(`/api/organizations/${organizationId}/handshake-sessions`, json(agent, { name: "builder", kind: "claude", app: "claude-cli" }));
			expect(builder.status).toBe(201);
			const builderSession = ((await builder.json()) as { session: string }).session;

			// The relay names the person from their account and pins the app to the widget.
			const opened = await request(sessions(organizationId, installationId), json(frame(cookie), { kind: "person", app: "shiplet-dashboard", name: "ceo" }));
			expect(opened.status, await opened.clone().text()).toBe(201);
			const person = (await opened.json()) as { session: string; peer: { id: string; name: string; kind: string; app: string; account: string } };
			expect(person.peer).toMatchObject({ name: "Dana-Reyes", kind: "person", app: "shiplet-embed", account: "Dana Reyes" });

			const peers = await request(sessions(organizationId, installationId, `/${person.session}/peers`), { headers: frame(cookie) });
			expect(peers.status).toBe(200);
			expect(((await peers.json()) as { peers: Array<{ name: string }> }).peers.map((peer) => peer.name)).toContain("builder");

			// A message can carry the annotation open on the page.
			const sent = await request(
				sessions(organizationId, installationId, `/${person.session}/messages`),
				json(frame(cookie), { to: "builder", text: "Can you darken it?", request: { shiplet: projectId, feedback: feedback.id } }),
			);
			expect(sent.status, await sent.clone().text()).toBe(200);
			const inbox = await request(`/api/organizations/${organizationId}/handshake-sessions/${builderSession}/inbox`, { headers: agent });
			const message = ((await inbox.json()) as { messages: Array<{ text: string; room: string; from: { kind: string; app: string; id: string } }> }).messages[0];
			expect(message).toMatchObject({ text: "Can you darken it?", from: { kind: "person", app: "shiplet-embed" } });
			const watched = await request(`/api/organizations/${organizationId}/handshakes`, { headers: OWNER });
			const handshake = ((await watched.json()) as { handshakes: Array<{ id: string; request: { feedback: string } | null }> }).handshakes.find((item) => item.id === message.room);
			expect(handshake?.request).toMatchObject({ shiplet: projectId, feedback: feedback.id, label: feedback.ticket_label });

			// The agent answers and the person reads it from the widget.
			await request(`/api/organizations/${organizationId}/handshake-sessions/${builderSession}/messages`, json(agent, { to: message.from.id, handshake: message.room, text: "Darkened." }));
			const reply = await request(sessions(organizationId, installationId, `/${person.session}/inbox`), { headers: frame(cookie) });
			expect(reply.status).toBe(200);
			expect(((await reply.json()) as { messages: Array<{ text: string }> }).messages.map((item) => item.text)).toEqual(["Darkened."]);

			const left = await request(sessions(organizationId, installationId, `/${person.session}`), { method: "DELETE", headers: frame(cookie) });
			expect(left.status).toBe(200);
		});
	});

	it("keeps a widget session to its own person session and its own Shiplet", async () => {
		await withHandshakes(async () => {
			const organizationId = await organization();
			const { projectId, installationId } = await website(organizationId);
			const { cookie } = await embedSession(installationId);
			const other = await website(organizationId);
			const elsewhere = await annotation(other.projectId, "Another site's annotation.");

			// Only a person, never an agent.
			const agent = await request(sessions(organizationId, installationId), json(frame(cookie), { name: "builder", kind: "claude", app: "claude-cli" }));
			expect(agent.status).toBe(403);
			expect(((await agent.json()) as { error: string }).error).toBe("embed_person_only");

			// No watching the organization's handshakes, and no exports.
			const watch = await request(`/api/organizations/${organizationId}/handshakes?installation_id=${installationId}`, { headers: frame(cookie) });
			expect(watch.status).toBe(403);
			const opened = await request(sessions(organizationId, installationId), json(frame(cookie), { kind: "person" }));
			const person = (await opened.json()) as { session: string };
			const exported = await request(sessions(organizationId, installationId, `/${person.session}/handshakes/hs_x/export`), json(frame(cookie), {}));
			expect(exported.status).toBe(403);

			// Annotations only from the Shiplet under review.
			const agentKeyHeaders = await agentKey(organizationId);
			await request(`/api/organizations/${organizationId}/handshake-sessions`, json(agentKeyHeaders, { name: "builder", kind: "claude", app: "claude-cli" }));
			const tied = await request(
				sessions(organizationId, installationId, `/${person.session}/messages`),
				json(frame(cookie), { to: "builder", text: "About that one", request: { shiplet: other.projectId, feedback: elsewhere.id } }),
			);
			expect(tied.status).toBe(404);
			expect(((await tied.json()) as { error: string }).error).toBe("request_not_found");

			// Only the organization the Shiplet belongs to.
			const otherOrganization = await organization();
			const outside = await request(sessions(otherOrganization, installationId), json(frame(cookie), { kind: "person" }));
			expect(outside.status).toBe(404);
			expect(projectId).toBeTruthy();
		});
	});

	it("accepts the widget session only from the trusted frame itself", async () => {
		await withHandshakes(async () => {
			const organizationId = await organization();
			const { installationId } = await website(organizationId);
			const { cookie } = await embedSession(installationId);

			const crossSite = await request(sessions(organizationId, installationId), json({ ...frame(cookie), "sec-fetch-site": "cross-site" }, { kind: "person" }));
			expect(crossSite.status).toBe(403);
			const otherOrigin = await request(sessions(organizationId, installationId), json({ ...frame(cookie), Origin: SITE_ORIGIN }, { kind: "person" }));
			expect(otherOrigin.status).toBe(403);
			const noCookie = await request(sessions(organizationId, installationId), json({ "sec-fetch-site": "same-origin", Origin: "http://localhost" }, { kind: "person" }));
			expect(noCookie.status).toBe(401);
			expect(((await noCookie.json()) as { error: string }).error).toBe("embed_session_expired");
			const withoutInstallation = await request(`/api/organizations/${organizationId}/handshake-sessions`, json(frame(cookie), { kind: "person" }));
			expect(withoutInstallation.status).toBe(401);
			expect(((await withoutInstallation.json()) as { error: string }).error).toBe("unauthorized");
		});
	});

	it("tells the widget when its sign-in ended", async () => {
		await withHandshakes(async () => {
			const organizationId = await organization();
			const { installationId } = await website(organizationId);
			const { cookie } = await embedSession(installationId);
			const opened = await request(sessions(organizationId, installationId), json(frame(cookie), { kind: "person" }));
			const person = (await opened.json()) as { session: string };
			await runtimeEnv.DB.prepare("UPDATE embed_review_sessions SET expires_on = ? WHERE installation_id = ?").bind("2000-01-01T00:00:00.000Z", installationId).run();
			const expired = await request(sessions(organizationId, installationId, `/${person.session}/inbox`), { headers: frame(cookie) });
			expect(expired.status).toBe(401);
			expect(((await expired.json()) as { error: string }).error).toBe("embed_session_expired");
		});
	});

	it("keeps out a reviewer who is not in the Shiplet's organization", async () => {
		await withHandshakes(async () => {
			const organizationId = await organization();
			const { projectId, installationId } = await website(organizationId);
			await request("/api/me", { headers: VISITOR });
			await runtimeEnv.DB.prepare("UPDATE projects SET visibility = 'public' WHERE id = ?").bind(projectId).run();
			const { cookie, host } = await embedSession(installationId, VISITOR);

			const opened = await request(sessions(organizationId, installationId), json(frame(cookie), { kind: "person" }));
			expect(opened.status).toBe(404);
			// And the widget never offers them the Agents panel.
			const page = await request(`${host.pathname}${host.search}`, { headers: { Cookie: cookie } });
			expect(page.status).toBe(200);
			expect(await page.text()).not.toContain("data-shiplet-organization-id");
		});
	});
});

describe("review hosts offer the Agents panel", () => {
	it("marks the widget and dashboard review hosts with the organization, for members, when handshakes are on", async () => {
		const organizationId = await organization();
		const { projectId, installationId } = await website(organizationId);
		const { cookie, host } = await embedSession(installationId);
		const hostPath = `${host.pathname}${host.search}`;

		const off = await request(hostPath, { headers: { Cookie: cookie } });
		expect(await off.text()).not.toContain("data-shiplet-organization-id");
		const dashboardOff = await request(`/shiplets/${projectId}/review-host`, { headers: OWNER });
		expect(await dashboardOff.text()).not.toContain("data-shiplet-organization-id");

		await withHandshakes(async () => {
			const on = await request(hostPath, { headers: { Cookie: cookie } });
			expect(on.status).toBe(200);
			expect(await on.text()).toContain(`data-shiplet-organization-id="${organizationId}"`);
			const dashboard = await request(`/shiplets/${projectId}/review-host`, { headers: OWNER });
			expect(dashboard.status).toBe(200);
			expect(await dashboard.text()).toContain(`data-shiplet-organization-id="${organizationId}"`);

			// A signed-in viewer outside the organization (a public Shiplet) gets no panel.
			await request("/api/me", { headers: VISITOR });
			await runtimeEnv.DB.prepare("UPDATE projects SET visibility = 'public' WHERE id = ?").bind(projectId).run();
			const visitor = await request(`/shiplets/${projectId}/review-host`, { headers: VISITOR });
			expect(visitor.status).toBe(200);
			expect(await visitor.text()).not.toContain("data-shiplet-organization-id");
		});
	});
});
