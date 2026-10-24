import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import app from "../src/index";
import { createInvitationConsentToken } from "../src/auth-consent";
import { getWorkOSInvitation } from "../src/workos";
import {
	setCookiePairs,
	signInWithCode,
	signInWithMintedState,
} from "./helpers/auth-flow";

// A restricted Shiplet's invitation is offered only after sign-in, and only to
// the exact invited email. An email share grants that one Shiplet, never
// membership of the workspace that owns it.

const testEnv = env as Env;
const origin = "https://shiplet.cc";

async function request(url: string, init: RequestInit = {}) {
	const context = createExecutionContext();
	const absolute = /^https?:\/\//.test(url) ? url : `${origin}${url}`;
	let response: Response;
	try {
		response = await app.fetch(new Request(absolute, init), testEnv, context);
	} catch (error) {
		if (!(error instanceof Response)) throw error;
		response = error;
	}
	await waitOnExecutionContext(context);
	return response;
}

type Person = { id: string; email: string; headers: Record<string, string> };

function person(label: string, domain = "example.com"): Person {
	const email = `${label}-${crypto.randomUUID().slice(0, 8)}@${domain}`;
	const id = `user_${email.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
	return {
		id,
		email,
		headers: { "x-shiplet-user-id": id, "x-shiplet-user-email": email },
	};
}

function testCode(email: string, organizationId = "") {
	return `test-code:${organizationId}:${encodeURIComponent(email)}`;
}

function sessionCookie(response: Response) {
	return setCookiePairs(response)
		.filter((pair) => /^(?:__Host-)?shiplet_(?:session|account_group)=./.test(pair))
		.join("; ");
}

async function postJson(path: string, actor: Person, body: unknown) {
	return request(path, {
		method: "POST",
		headers: { ...actor.headers, "Content-Type": "application/json", Origin: origin },
		body: JSON.stringify(body),
	});
}

async function createWorkspace(owner: Person) {
	const response = await postJson("/api/organizations", owner, {
		name: `Invite Workspace ${crypto.randomUUID().slice(0, 8)}`,
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { organization: { id: string; name: string } })
		.organization;
}

async function publish(owner: Person, organizationId: string, visibility: string) {
	const name = `Invite Shiplet ${crypto.randomUUID().slice(0, 8)}`;
	const response = await postJson("/projects", owner, {
		name,
		organization_id: organizationId,
		subdomain: `invite-${crypto.randomUUID().slice(0, 8)}`,
		visibility,
		assets: [
			{
				path: "index.html",
				content: btoa(`<!doctype html><h1>${name}</h1>`),
				size: 40,
			},
		],
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { project: { id: string; name: string } }).project;
}

async function shareByEmail(owner: Person, projectId: string, email: string, role = "viewer") {
	return postJson(`/api/projects/${projectId}/invitations`, owner, {
		targetType: "user",
		email,
		role,
	});
}

async function restrictedShipletWithInvite(visibility = "private") {
	const owner = person("owner");
	const invitee = person("invitee");
	const organization = await createWorkspace(owner);
	const project = await publish(owner, organization.id, visibility);
	const shared = await shareByEmail(owner, project.id, invitee.email);
	expect(shared.status).toBe(201);
	const body = (await shared.json()) as {
		appInvitation: { id: string };
		workosInvitation: { id: string };
	};
	return { owner, invitee, organization, project, ...body };
}

/** Signs in through /auth/login and returns the callback and its session. */
async function signIn(code: string, returnTo: string) {
	const callback = await signInWithCode(request, code, { origin, returnTo });
	expect(callback.status).toBe(302);
	return {
		location: new URL(callback.headers.get("location") || "", origin),
		cookie: sessionCookie(callback),
	};
}

async function acceptConsent(consentUrl: URL, cookie: string) {
	const page = await request(consentUrl.toString(), { headers: { cookie } });
	expect(page.status).toBe(200);
	const html = await page.text();
	const consentToken = html.match(/name="consent_token" value="([^"]+)"/)?.[1];
	expect(consentToken).toBeTruthy();
	const accepted = await request("/auth/login", {
		method: "POST",
		headers: {
			cookie,
			Origin: origin,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ consent_token: consentToken! }),
		redirect: "manual",
	});
	return { html, accepted };
}

async function invitationStatus(invitationId: string) {
	return (
		await testEnv.DB.prepare("SELECT status FROM app_invitations WHERE id = ?")
			.bind(invitationId)
			.first<{ status: string }>()
	)?.status;
}

async function organizationMembershipCount(organizationId: string, userId: string) {
	const row = await testEnv.DB.prepare(
		`SELECT COUNT(*) AS count FROM organization_memberships
		 WHERE organization_id = ? AND user_id = ?`,
	)
		.bind(organizationId, userId)
		.first<{ count: number }>();
	return Number(row?.count || 0);
}

describe("restricted Shiplet invitations: sign in first", () => {
	it("starts a normal sign-in for an anonymous visitor without naming the Shiplet or workspace", async () => {
		const { project, organization } = await restrictedShipletWithInvite();

		const response = await request(
			`/auth/login?return_to=${encodeURIComponent(`/shiplets/${project.id}`)}`,
			{ redirect: "manual" },
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toMatch(/^https:\/\/authkit\.test\//);
		const body = await response.text();
		expect(body).not.toContain(project.name);
		expect(body).not.toContain(organization.name);
	});

	it("does not name the Shiplet when an anonymous visitor opens a consent link", async () => {
		const { invitee, project, organization } = await restrictedShipletWithInvite();
		const { location, cookie } = await signIn(testCode(invitee.email), `/shiplets/${project.id}`);
		expect(location.searchParams.get("consent")).toBeTruthy();
		expect(cookie).toBeTruthy();

		const anonymous = await request(location.toString(), { redirect: "manual" });

		expect(anonymous.status).toBe(302);
		expect(anonymous.headers.get("location")).toMatch(/^https:\/\/authkit\.test\//);
		const body = await anonymous.text();
		expect(body).not.toContain(project.name);
		expect(body).not.toContain(organization.name);
	});

	it("offers the invitee named consent after sign-in, then opens the Shiplet on acceptance", async () => {
		const { invitee, project, organization, appInvitation } =
			await restrictedShipletWithInvite();
		const shipletPath = `/shiplets/${project.id}`;

		const { location, cookie } = await signIn(testCode(invitee.email), shipletPath);
		expect(location.origin).toBe(origin);
		expect(location.pathname).toBe("/auth/login");
		expect(await invitationStatus(appInvitation.id)).toBe("pending");

		const { html, accepted } = await acceptConsent(location, cookie);
		expect(html).toContain(project.name);
		expect(html).toContain(organization.name);
		expect(html).toContain("Accept invitation and open Shiplet");
		expect(html).not.toContain("Sign in and accept invitation");
		const card = html.match(/<section[^>]*invitation-consent-title[\s\S]*?<\/section>/)?.[0];
		expect(card).toBeTruthy();
		expect(card).not.toContain(invitee.email);

		expect(accepted.status).toBe(302);
		expect(new URL(accepted.headers.get("location") || "", origin).toString()).toBe(
			`${origin}${shipletPath}`,
		);
		expect(await invitationStatus(appInvitation.id)).toBe("accepted");
		const shiplet = await request(shipletPath, { headers: { cookie }, redirect: "manual" });
		expect(shiplet.status).toBe(200);
	});

	it("lets a workspace colleague who joins through AuthKit open an organization Shiplet without a 403", async () => {
		const { organization, project, appInvitation } =
			await restrictedShipletWithInvite("organization");
		const colleague = person("colleague");
		const shipletPath = `/shiplets/${project.id}`;

		const { location, cookie } = await signIn(
			testCode(colleague.email, organization.id),
			shipletPath,
		);

		expect(location.toString()).toBe(`${origin}${shipletPath}`);
		const shiplet = await request(shipletPath, { headers: { cookie }, redirect: "manual" });
		expect(shiplet.status).toBe(200);
		expect(await invitationStatus(appInvitation.id)).toBe("pending");
	});

	it("sends an outsider who is not invited to the Request access screen", async () => {
		const { project, appInvitation } = await restrictedShipletWithInvite("organization");
		const outsider = person("outsider", "elsewhere.example");
		const shipletPath = `/shiplets/${project.id}`;

		const { location, cookie } = await signIn(testCode(outsider.email), shipletPath);

		expect(location.toString()).toBe(`${origin}${shipletPath}`);
		const shiplet = await request(shipletPath, { headers: { cookie }, redirect: "manual" });
		expect(shiplet.status).toBe(302);
		expect(shiplet.headers.get("location")).toBe(`/shiplets/${project.id}/access`);
		const access = await request(`/shiplets/${project.id}/access`, { headers: { cookie } });
		expect(access.status).toBe(200);
		expect(await access.text()).toContain(`Request access to ${project.name}`);
		expect(await invitationStatus(appInvitation.id)).toBe("pending");
	});

	it("does not show another person's consent to a signed-in mismatched email", async () => {
		const { invitee, project, organization, appInvitation } =
			await restrictedShipletWithInvite();
		const invited = await signIn(testCode(invitee.email), `/shiplets/${project.id}`);
		const mismatched = person("mismatch");
		const other = await signIn(testCode(mismatched.email), "/");

		const page = await request(invited.location.toString(), {
			headers: { cookie: other.cookie },
			redirect: "manual",
		});

		expect(page.status).toBe(302);
		expect(await page.text()).not.toContain(organization.name);
		expect(await invitationStatus(appInvitation.id)).toBe("pending");
	});

	it("offers consent to an invitee who is already signed in when they open the Shiplet", async () => {
		const { invitee, project } = await restrictedShipletWithInvite();
		const { cookie } = await signIn(testCode(invitee.email), "/");

		const gate = await request(`/shiplets/${project.id}/access`, {
			headers: { cookie },
			redirect: "manual",
		});
		expect(gate.status).toBe(302);
		const consentUrl = new URL(gate.headers.get("location") || "", origin);
		expect(consentUrl.pathname).toBe("/auth/login");
		expect(consentUrl.searchParams.get("consent")).toBeTruthy();

		const login = await request(
			`/auth/login?return_to=${encodeURIComponent(`/shiplets/${project.id}`)}`,
			{ headers: { cookie }, redirect: "manual" },
		);
		expect(login.status).toBe(302);
		expect(
			new URL(login.headers.get("location") || "", origin).searchParams.get("consent"),
		).toBeTruthy();
	});

	it("answers a consent form submitted after the session ended without leaving the app origin", async () => {
		const { invitee, project, appInvitation } = await restrictedShipletWithInvite();
		const { location, cookie } = await signIn(testCode(invitee.email), `/shiplets/${project.id}`);
		const page = await request(location.toString(), { headers: { cookie } });
		const consentToken = (await page.text()).match(
			/name="consent_token" value="([^"]+)"/,
		)?.[1];

		const signedOut = await request("/auth/login", {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ consent_token: consentToken! }),
			redirect: "manual",
		});

		const redirect = signedOut.headers.get("location");
		if (redirect) expect(new URL(redirect, origin).origin).toBe(origin);
		expect(signedOut.status).toBeLessThan(400);
		expect(await invitationStatus(appInvitation.id)).toBe("pending");
	});
});

describe("sign-ins started before consent moved after sign-in", () => {
	it("re-offers consent instead of accepting when a pre-change consent sign-in returns", async () => {
		const { invitee, project, appInvitation } = await restrictedShipletWithInvite();
		const shipletPath = `/shiplets/${project.id}`;
		const consentToken = await createInvitationConsentToken(testEnv, {
			projectId: project.id,
			invitationId: appInvitation.id,
			returnTo: shipletPath,
		});

		const callback = await signInWithMintedState(
			request,
			testEnv,
			testCode(invitee.email),
			{ returnTo: "/", consentToken },
			{ origin },
		);

		expect(callback.status).toBe(302);
		const location = new URL(callback.headers.get("location") || "", origin);
		expect(location.pathname).toBe("/auth/login");
		expect(location.searchParams.get("consent")).toBeTruthy();
		expect(await invitationStatus(appInvitation.id)).toBe("pending");
	});

	it("answers a pre-change consent sign-in from a non-invitee with normal access, not a 403", async () => {
		const { organization, project, appInvitation } =
			await restrictedShipletWithInvite("organization");
		const colleague = person("colleague");
		const shipletPath = `/shiplets/${project.id}`;
		const consentToken = await createInvitationConsentToken(testEnv, {
			projectId: project.id,
			returnTo: shipletPath,
		});

		const callback = await signInWithMintedState(
			request,
			testEnv,
			testCode(colleague.email, organization.id),
			{ returnTo: shipletPath, consentToken },
			{ origin },
		);

		expect(callback.status).toBe(302);
		expect(new URL(callback.headers.get("location") || "", origin).toString()).toBe(
			`${origin}${shipletPath}`,
		);
		expect(await invitationStatus(appInvitation.id)).toBe("pending");
	});
});

describe("email shares grant one Shiplet only", () => {
	it("invites a new email to the Shiplet without inviting them to the workspace", async () => {
		const { workosInvitation } = await restrictedShipletWithInvite();

		const sent = await getWorkOSInvitation(testEnv, workosInvitation.id);

		expect(sent.organizationId ?? null).toBeNull();
	});

	it("gives an accepted invitee that Shiplet but no workspace membership", async () => {
		const { owner, invitee, organization, project } =
			await restrictedShipletWithInvite("organization");
		const otherShiplet = await publish(owner, organization.id, "organization");
		const { location, cookie } = await signIn(testCode(invitee.email), `/shiplets/${project.id}`);
		const { accepted } = await acceptConsent(location, cookie);
		expect(accepted.status).toBe(302);

		const shared = await request(`/shiplets/${project.id}`, { headers: { cookie }, redirect: "manual" });
		expect(shared.status).toBe(200);
		expect(await organizationMembershipCount(organization.id, invitee.id)).toBe(0);

		const other = await request(`/shiplets/${otherShiplet.id}`, {
			headers: { cookie },
			redirect: "manual",
		});
		expect(other.status).toBe(302);
		expect(other.headers.get("location")).toBe(`/shiplets/${otherShiplet.id}/access`);

		for (const target of [project.id, otherShiplet.id]) {
			const archive = await request(`/api/projects/${target}/archive`, {
				method: "POST",
				headers: { cookie, Origin: origin },
				redirect: "manual",
			});
			expect(archive.status, target).toBe(403);
		}

		const invite = await request(`/api/organizations/${organization.id}/invitations`, {
			method: "POST",
			headers: { cookie, Origin: origin, "Content-Type": "application/json" },
			body: JSON.stringify({ email: `friend-${crypto.randomUUID()}@example.com` }),
		});
		expect(invite.status).toBe(403);
	});

	it("grants an existing workspace member directly, without a new invitation", async () => {
		const owner = person("owner");
		const organization = await createWorkspace(owner);
		const member = person("member");
		await signIn(testCode(member.email, organization.id), "/");
		const project = await publish(owner, organization.id, "private");

		const shared = await shareByEmail(owner, project.id, member.email, "reviewer");

		expect(shared.status).toBe(201);
		const body = (await shared.json()) as {
			grant: { target_id: string; accepted_on: string | null };
			appInvitation?: unknown;
		};
		expect(body.grant.target_id).toBe(member.id);
		expect(body.grant.accepted_on).toBeTruthy();
		expect(body.appInvitation).toBeUndefined();
		const pending = await testEnv.DB.prepare(
			"SELECT COUNT(*) AS count FROM app_invitations WHERE project_id = ?",
		)
			.bind(project.id)
			.first<{ count: number }>();
		expect(Number(pending?.count)).toBe(0);
		const view = await request(`/shiplets/${project.id}`, {
			headers: member.headers,
			redirect: "manual",
		});
		expect(view.status).toBe(200);
	});

	it("answers a repeated email share without a second invitation or a server error", async () => {
		const owner = person("owner");
		const organization = await createWorkspace(owner);
		const member = person("member");
		await signIn(testCode(member.email, organization.id), "/");
		const project = await publish(owner, organization.id, "private");
		const newcomer = person("newcomer");

		for (const email of [member.email, newcomer.email]) {
			const first = await shareByEmail(owner, project.id, email);
			expect(first.status, email).toBe(201);
			const again = await shareByEmail(owner, project.id, email);
			expect(again.status, email).toBe(200);
			const changedRole = await shareByEmail(owner, project.id, email, "editor");
			expect(changedRole.status, email).toBe(409);
		}

		const counts = await testEnv.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM app_invitations WHERE project_id = ?1) AS invitations,
				(SELECT COUNT(*) FROM shiplet_access_grants WHERE project_id = ?1 AND target_type = 'user') AS grants`,
		)
			.bind(project.id)
			.first<{ invitations: number; grants: number }>();
		expect(Number(counts?.invitations)).toBe(1);
		expect(Number(counts?.grants)).toBe(2);
	});
});
