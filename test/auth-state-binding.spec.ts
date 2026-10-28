import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import app from "../src/index";
import { ensureSchema } from "../src/schema";
import {
	authCallbackUrl,
	joinCookies,
	setCookiePairs,
	signInWithCode,
	startSignIn,
} from "./helpers/auth-flow";

const testEnv = env as Env;
const origin = "https://shiplet.cc";

async function request(url: string, init: RequestInit = {}, runtime: Env = testEnv) {
	const context = createExecutionContext();
	const absolute = /^https?:\/\//.test(url) ? url : `${origin}${url}`;
	const response = await app.fetch(new Request(absolute, init), runtime, context);
	await waitOnExecutionContext(context);
	return response;
}

function uniqueEmail(label: string) {
	return `${label}-${crypto.randomUUID()}@example.com`;
}

function testCode(email: string, organizationId = "") {
	return `test-code:${organizationId}:${encodeURIComponent(email)}`;
}

async function userExists(email: string) {
	const row = await testEnv.DB.prepare("SELECT id FROM users WHERE email = ?")
		.bind(email)
		.first<{ id: string }>();
	return Boolean(row);
}

function sessionSetCookie(response: Response) {
	return response.headers
		.getSetCookie()
		.filter((cookie) => /^(?:__Host-)?shiplet_session=[^;]/.test(cookie));
}

async function callback(code: string, state: string | undefined, cookie = "") {
	return request(authCallbackUrl(undefined, code, state), {
		headers: cookie ? { cookie } : {},
		redirect: "manual",
	});
}

function tamper(state: string, change: Record<string, unknown>) {
	return btoa(JSON.stringify({ ...JSON.parse(atob(state)), ...change }));
}

async function expectRefused(response: Response, email: string) {
	expect(response.status).not.toBe(200);
	expect(sessionSetCookie(response)).toEqual([]);
	expect(await userExists(email)).toBe(false);
}

describe("sign-in state is bound to the browser that started it", () => {
	beforeAll(async () => {
		await ensureSchema(testEnv.DB);
	});

	it("Given a fresh login, when /auth/login redirects to AuthKit, then it sets a short-lived HttpOnly per-flow cookie", async () => {
		const flow = await startSignIn(request, { returnTo: "/workspace" });
		const login = await request("/auth/login?return_to=%2Fworkspace", { redirect: "manual" });
		const flowCookie = login.headers
			.getSetCookie()
			.find((cookie) => cookie.includes("shiplet_auth_flow_"));
		expect(flowCookie).toMatch(/^__Host-shiplet_auth_flow_[A-Za-z0-9_-]{22}=[A-Za-z0-9_-]{43};/);
		expect(flowCookie).toContain("Path=/;");
		expect(flowCookie).toContain("HttpOnly");
		expect(flowCookie).toContain("Secure");
		expect(flowCookie).toContain("SameSite=Lax");
		expect(flowCookie).toContain("Max-Age=600");
		expect(flowCookie).not.toMatch(/Domain=/i);
		expect(JSON.parse(atob(flow.state)).returnTo).toBe("/workspace");
		expect(JSON.parse(atob(flow.state)).flow).toMatch(/^[A-Za-z0-9_-]{22}$/);
	});

	it("Given the browser that started sign-in, when AuthKit returns, then the session is created and the flow cookie is spent", async () => {
		const email = uniqueEmail("bound");
		const flow = await startSignIn(request, { returnTo: "/workspace" });
		const response = await callback(testCode(email), flow.state, flow.cookie);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/workspace");
		expect(sessionSetCookie(response)).toHaveLength(1);
		const flowName = flow.cookie.split("=")[0];
		const cleared = response.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${flowName}=;`));
		expect(cleared).toContain("Max-Age=0");
		expect(await userExists(email)).toBe(true);
	});

	it("Given an attacker's code and state sent to a browser that never started sign-in, when the link opens, then the code is not exchanged", async () => {
		const email = uniqueEmail("csrf-attacker");
		const attackerFlow = await startSignIn(request, { returnTo: "/workspace" });
		const response = await callback(testCode(email), attackerFlow.state);
		await expectRefused(response, email);
		expect(response.status).toBe(302);
		const retry = new URL(response.headers.get("location")!, origin);
		expect(retry.pathname).toBe("/auth/login");
		expect(retry.searchParams.get("return_to")).toBe("/workspace");
		expect(retry.searchParams.get("auth_retry")).toBe("1");
	});

	it("Given a callback with no state at all, when it opens, then a fresh bound sign-in starts instead of exchanging the code", async () => {
		const email = uniqueEmail("no-state");
		const response = await callback(testCode(email), undefined);
		await expectRefused(response, email);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/auth/login");
	});

	it("Given a retried sign-in that still has no flow cookie, when AuthKit returns, then the recovery page is shown instead of looping", async () => {
		const email = uniqueEmail("retry");
		const login = await request("/auth/login?return_to=%2Fworkspace&auth_retry=1", { redirect: "manual" });
		const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
		expect(JSON.parse(atob(state)).retried).toBe(true);
		const response = await request(authCallbackUrl(undefined, testCode(email), state), {
			headers: { Accept: "text/html" },
			redirect: "manual",
		});
		await expectRefused(response, email);
		expect(response.status).toBe(400);
		const html = await response.text();
		expect(html).toContain("Sign-in needs attention");
		expect(html).toContain("Go to Shiplet");
	});

	it("Given another flow's cookie, when the state's own cookie is absent, then the code is not exchanged", async () => {
		const email = uniqueEmail("other-flow");
		const victimFlow = await startSignIn(request, { returnTo: "/workspace" });
		const attackerFlow = await startSignIn(request, { returnTo: "/workspace" });
		const response = await callback(testCode(email), attackerFlow.state, victimFlow.cookie);
		await expectRefused(response, email);
	});

	it("Given a flow cookie whose value does not match the state, when AuthKit returns, then sign-in is refused", async () => {
		const email = uniqueEmail("mismatch");
		const flow = await startSignIn(request, { returnTo: "/workspace" });
		const [name] = flow.cookie.split("=");
		const forged = `${name}=${"A".repeat(43)}`;
		const response = await callback(testCode(email), flow.state, forged);
		await expectRefused(response, email);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Start sign-in again");
	});

	it.each([
		["returnTo", { returnTo: "/account" }],
		["consentToken", { consentToken: "shiplet_invite_consent_v1.forged.forged" }],
		["invitationToken", { invitationToken: "test-org-invitation:org_forged:victim%40example.com" }],
	])("Given a state with a changed %s, when AuthKit returns, then sign-in is refused", async (_field, change) => {
		const email = uniqueEmail("tamper");
		const flow = await startSignIn(request, { returnTo: "/workspace" });
		const response = await callback(testCode(email), tamper(flow.state, change), flow.cookie);
		await expectRefused(response, email);
		expect(response.status).toBe(400);
	});

	it("Given a completed sign-in, when the same state is replayed by the browser, then it is refused", async () => {
		const firstEmail = uniqueEmail("replay-first");
		const replayEmail = uniqueEmail("replay-second");
		const flow = await startSignIn(request, { returnTo: "/workspace" });
		const first = await callback(testCode(firstEmail), flow.state, flow.cookie);
		expect(first.status).toBe(302);
		const remaining = setCookiePairs(first).filter((pair) => !pair.endsWith("="));
		expect(remaining.some((pair) => pair.startsWith(flow.cookie.split("=")[0]))).toBe(false);
		const replay = await callback(testCode(replayEmail), flow.state, joinCookies(...remaining));
		await expectRefused(replay, replayEmail);
	});

	it("Given two tabs signing in at once, when both return in either order, then each completes", async () => {
		const firstEmail = uniqueEmail("tab-one");
		const secondEmail = uniqueEmail("tab-two");
		const first = await startSignIn(request, { returnTo: "/workspace" });
		const second = await startSignIn(request, { returnTo: "/shiplets" });
		const jar = joinCookies(first.cookie, second.cookie);
		const secondResponse = await callback(testCode(secondEmail), second.state, jar);
		expect(secondResponse.status).toBe(302);
		expect(secondResponse.headers.get("location")).toBe("/shiplets");
		const firstResponse = await callback(testCode(firstEmail), first.state, jar);
		expect(firstResponse.status).toBe(302);
		expect(firstResponse.headers.get("location")).toBe("/workspace");
		expect(await userExists(firstEmail)).toBe(true);
		expect(await userExists(secondEmail)).toBe(true);
	});

	it("Given an http app URL, when sign-in starts, then the flow cookie works without the __Host- prefix", async () => {
		const runtime = { ...testEnv, SHIPLET_APP_URL: "http://localhost:8787" } as Env;
		const local = (url: string, init?: RequestInit) => request(url, init, runtime);
		const email = uniqueEmail("local");
		const flow = await startSignIn(local, { returnTo: "/workspace" });
		expect(flow.cookie).toMatch(/^shiplet_auth_flow_/);
		const response = await local(authCallbackUrl(undefined, testCode(email), flow.state), {
			headers: { cookie: flow.cookie },
			redirect: "manual",
		});
		expect(response.status).toBe(302);
		expect(await userExists(email)).toBe(true);
	});

	it("Given account switching, when a signed-in browser adds an account, then the bound flow links both sessions", async () => {
		const runtime = { ...testEnv, SHIPLET_ENABLED_FEATURE_FLAGS: "account-email-switching" } as unknown as Env;
		const switching = (url: string, init?: RequestInit) => request(url, init, runtime);
		const firstEmail = uniqueEmail("add-first");
		const secondEmail = uniqueEmail("add-second");
		const first = await signInWithCode(switching, testCode(firstEmail));
		expect(first.status).toBe(302);
		const firstCookies = joinCookies(...setCookiePairs(first).filter((pair) => !pair.endsWith("=")));

		const second = await signInWithCode(switching, testCode(secondEmail), {
			returnTo: "/account",
			accountAction: "add",
			cookie: firstCookies,
		});
		expect(second.status).toBe(302);
		expect(second.headers.get("location")).toBe("/account");
		const secondCookies = joinCookies(...setCookiePairs(second).filter((pair) => !pair.endsWith("=")));
		const dashboard = await switching("/api/dashboard", { headers: { cookie: secondCookies } });
		expect(dashboard.status).toBe(200);
		const body = (await dashboard.json()) as {
			user: { email: string };
			accountSessions: Array<{ email: string }>;
		};
		expect(body.user.email).toBe(secondEmail);
		expect(body.accountSessions.map((session) => session.email).sort()).toEqual(
			[firstEmail, secondEmail].sort(),
		);
	});
});
