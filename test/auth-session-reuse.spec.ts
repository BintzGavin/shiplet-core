import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { sessionCookie } from "../src/auth";
import type { Env } from "../src/env";
import { ensureSchema } from "../src/schema";
import { createAppInvitation, createOrganizationRecord, createSession, upsertUser } from "../src/store";

const runtime = {
	...(env as Env),
	SHIPLET_APP_URL: "https://app.shiplet.cc",
	CUSTOM_DOMAIN: "shiplet.cc",
} as unknown as Env;

async function request(path: string, headers: HeadersInit = {}, bindings = runtime) {
	const context = createExecutionContext();
	const response = await app.fetch(new Request(new URL(path, bindings.SHIPLET_APP_URL), {
		headers,
	}), bindings, context);
	await waitOnExecutionContext(context);
	return response;
}

async function browserSession() {
	const id = `user_${crypto.randomUUID().replace(/-/g, "")}`;
	await upsertUser(runtime.DB, { id, email: `${id}@example.com` });
	const session = await createSession(runtime.DB, id);
	return { userId: id, sessionId: session.id, cookie: sessionCookie(session.id, runtime).split(";", 1)[0] };
}

async function privateProject(ownerUserId: string) {
	const id = `project_${crypto.randomUUID().replace(/-/g, "")}`;
	const subdomain = `session-${crypto.randomUUID().slice(0, 8)}`;
	const now = new Date().toISOString();
	await runtime.DB.prepare(
		"INSERT INTO projects (id, owner_user_id, name, subdomain, script_content, visibility, created_on, modified_on) VALUES (?, ?, 'Session review', ?, '', 'private', ?, ?)",
	).bind(id, ownerUserId, subdomain, now, now).run();
	return { id, subdomain };
}

async function pendingInvitation(projectId: string, ownerUserId: string, inviteeUserId: string) {
	const organizationId = `org_${crypto.randomUUID().replace(/-/g, "")}`;
	await createOrganizationRecord(runtime.DB, {
		id: organizationId, name: "Invitation workspace", created_by_user_id: ownerUserId,
		created_on: new Date().toISOString(),
	});
	await runtime.DB.prepare("UPDATE projects SET organization_id = ? WHERE id = ?")
		.bind(organizationId, projectId).run();
	await createAppInvitation(runtime.DB, {
		id: `appinv_${crypto.randomUUID()}`, organization_id: organizationId, project_id: projectId,
		team_id: null, email: `${inviteeUserId}@example.com`, invite_type: "shiplet",
		role: "reviewer", status: "pending", invited_by_user_id: ownerUserId,
		workos_invitation_id: `inv_${crypto.randomUUID()}`, workos_invitation_token: null,
		created_on: new Date().toISOString(), accepted_on: null,
	});
}

function expectProviderLogin(response: Response) {
	expect(response.status).toBe(302);
	const location = new URL(response.headers.get("location")!);
	expect(location.origin).not.toBe(new URL(runtime.SHIPLET_APP_URL!).origin);
	expect(location.searchParams.has("state")).toBe(true);
	return location;
}

describe("browser login session reuse", () => {
	beforeEach(async () => { await ensureSchema(runtime.DB); });

	it("Given a valid browser cookie, when ordinary login is requested, then the user resumes without another provider login", async () => {
		const { cookie } = await browserSession();
		const response = await request("/auth/login?return_to=%2Fshiplets", { Cookie: cookie });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/shiplets");
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	it.each(["absent", "invalid", "expired"])("Given an %s browser session, when login is requested, then provider authentication is still required", async (state) => {
		const session = await browserSession();
		if (state === "expired") {
			await runtime.DB.prepare("UPDATE sessions SET expires_on = ? WHERE id = ?")
				.bind(new Date(Date.now() - 1_000).toISOString(), session.sessionId).run();
		}
		const cookie = state === "absent" ? "" : state === "invalid"
			? sessionCookie("missing-session", runtime).split(";", 1)[0] : session.cookie;
		expectProviderLogin(await request("/auth/login?return_to=%2Fshiplets", cookie ? { Cookie: cookie } : {}));
	});

	it("Given an Authorization header and a valid cookie, when login is requested, then credentials do not activate the browser shortcut", async () => {
		const { cookie } = await browserSession();
		expectProviderLogin(await request("/auth/login?return_to=%2Fshiplets", {
			Cookie: cookie, Authorization: "Bearer invalid-test-credential",
		}));
	});

	it("Given a signed-in browser returning to its private artifact, when login resumes, then the existing return resolver refreshes artifact access", async () => {
		const session = await browserSession();
		const project = await privateProject(session.userId);
		const target = `https://${project.subdomain}.shiplet.cc/docs/?mode=review`;
		const response = await request(`/auth/login?return_to=${encodeURIComponent(target)}`, { Cookie: session.cookie });
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location")!);
		expect(location.origin).toBe(new URL(target).origin);
		expect(location.pathname).toBe("/docs/");
		expect(location.searchParams.get("mode")).toBe("review");
		expect(location.searchParams.get("shiplet_preview_token")).toMatch(/^shiplet_review_cap_v1\./);
	});

	it("Given a signed-in browser without project access, when login resumes toward its access gate, then it still sees the access request", async () => {
		const owner = await browserSession();
		const outsider = await browserSession();
		const project = await privateProject(owner.userId);
		const target = `/shiplets/${project.id}/access`;
		const response = await request(`/auth/login?return_to=${encodeURIComponent(target)}`, { Cookie: outsider.cookie });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(target);
		const gate = await request(target, { Cookie: outsider.cookie });
		expect(gate.status).toBe(200);
		expect(await gate.text()).toContain("Request access");
	});

	it("Given add-account is explicitly requested, when a browser session exists, then provider login still opens", async () => {
		const { cookie } = await browserSession();
		const response = await request("/auth/login?return_to=%2Faccount&account_action=add", { Cookie: cookie }, {
			...runtime, SHIPLET_ENABLED_FEATURE_FLAGS: "account-email-switching",
		} as unknown as Env);
		const location = expectProviderLogin(response);
		expect(location.searchParams.get("prompt")).toBe("login");
	});

	it("Given an explicit invitation, when a browser session exists, then the invitation authentication flow is preserved", async () => {
		const { cookie } = await browserSession();
		const response = await request("/auth/login?return_to=%2Fshiplets&invitation_token=unmatched-test-invitation", { Cookie: cookie });
		const location = expectProviderLogin(response);
		const state = JSON.parse(atob(location.searchParams.get("state")!));
		expect(state.invitationToken).toBe("unmatched-test-invitation");
	});

	it("Given a signed-in invitee follows an ordinary restricted-project link, when login resumes, then invitation acceptance is still offered", async () => {
		const owner = await browserSession();
		const invitee = await browserSession();
		const project = await privateProject(owner.userId);
		await pendingInvitation(project.id, owner.userId, invitee.userId);
		const response = await request(`/auth/login?return_to=${encodeURIComponent(`/shiplets/${project.id}`)}`, { Cookie: invitee.cookie });
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Accept invitation");
	});

	it("Given an authorized browser and another pending invite, when login resumes, then invitation handling adds no confirmation", async () => {
		const owner = await browserSession();
		const invitee = await browserSession();
		const project = await privateProject(owner.userId);
		await pendingInvitation(project.id, owner.userId, invitee.userId);
		const target = `https://${project.subdomain}.shiplet.cc/docs/`;
		const response = await request(`/auth/login?return_to=${encodeURIComponent(target)}`, { Cookie: owner.cookie });
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location")!);
		expect(location.origin).toBe(new URL(target).origin);
		expect(location.pathname).toBe("/docs/");
		expect(location.searchParams.has("shiplet_preview_token")).toBe(true);
	});

	it("Given an invalid invitation consent, when a browser session exists, then consent validation is not bypassed", async () => {
		const { cookie } = await browserSession();
		const response = await request("/auth/login?consent=invalid-consent", { Cookie: cookie });
		expect(response.status).toBe(400);
	});

	it("Given an unsafe return target, when a valid session is reused, then navigation stays on the application", async () => {
		const { cookie } = await browserSession();
		const response = await request(`/auth/login?return_to=${encodeURIComponent("https://other.example/path")}`, { Cookie: cookie });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/");
	});
});
