import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { sessionCookie } from "../src/auth";
import {
	approveCliAuthorizationRequest,
	createCliAuthorizationRequest,
	exchangeCliAuthorizationCode,
	revokeCliSession,
} from "../src/cli-session";
import type { Env } from "../src/env";
import app from "../src/index";
import { ensureSchema } from "../src/schema";
import { createSession, upsertUser } from "../src/store";

const testEnv = env as Env;

async function request(path: string, init: RequestInit = {}) {
	const context = createExecutionContext();
	const response = await app.fetch(
		new Request(`https://shiplet.cc${path}`, init), testEnv, context,
	);
	await waitOnExecutionContext(context);
	return response;
}

async function browserSession() {
	const userId = `user_auth_boundary_${crypto.randomUUID()}`;
	await upsertUser(testEnv.DB, { id: userId, email: `${userId}@example.invalid` });
	const session = await createSession(testEnv.DB, userId);
	return { userId, cookie: sessionCookie(session.id, testEnv).split(";")[0] };
}

async function cliSession(userId: string) {
	const verifier = crypto.randomUUID().replace(/-/g, "").repeat(2);
	const digest = new Uint8Array(await crypto.subtle.digest(
		"SHA-256", new TextEncoder().encode(verifier),
	));
	const challenge = btoa(String.fromCharCode(...digest))
		.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
	const redirectUri = "http://127.0.0.1:43195/callback";
	const authorization = await createCliAuthorizationRequest(testEnv.DB, {
		userId, redirectUri, state: crypto.randomUUID().replace(/-/g, ""),
		codeChallenge: challenge, method: "S256",
	});
	if (!authorization) throw new Error("CLI authorization fixture failed");
	const approved = await approveCliAuthorizationRequest(testEnv.DB, {
		requestId: authorization.id, userId,
	});
	if (!approved) throw new Error("CLI approval fixture failed");
	const exchanged = await exchangeCliAuthorizationCode(testEnv.DB, {
		code: approved.code, verifier, redirectUri,
	});
	if (!exchanged.ok) throw new Error("CLI exchange fixture failed");
	return `Bearer ${exchanged.accessToken}`;
}

describe("browser and explicit credential authentication boundaries", () => {
	beforeAll(async () => { await ensureSchema(testEnv.DB); });

	it.each(["invalid", "expired", "revoked", "missing scope"])(
		"denies CLI credentials in state '%s' even when a valid browser session is supplied",
		async (state) => {
			const { userId, cookie } = await browserSession();
			const authorization = state === "invalid"
				? `Bearer shiplet_cli_session_${crypto.randomUUID().replace(/-/g, "")}`
				: await cliSession(userId);
			if (state === "expired") {
				await testEnv.DB.prepare("UPDATE cli_sessions SET expires_on = ? WHERE user_id = ?")
					.bind(new Date(Date.now() - 1_000).toISOString(), userId).run();
			} else if (state === "revoked") {
				expect(await revokeCliSession(testEnv.DB, new Request("https://shiplet.cc/api/cli/session/revoke", {
					method: "POST", headers: { authorization },
				}), userId)).toBe(true);
			} else if (state === "missing scope") {
				await testEnv.DB.prepare("UPDATE cli_sessions SET scopes_json = '[]' WHERE user_id = ?")
					.bind(userId).run();
			}
			const response = await request("/api/shiplets", { headers: { authorization, cookie } });
			expect(response.status).toBe(401);
		},
	);

	it("denies a CLI credential on a browser-only mutation instead of using its cookie", async () => {
		const { userId, cookie } = await browserSession();
		const authorization = await cliSession(userId);
		const response = await request("/api/organizations", {
			method: "POST",
			headers: { authorization, cookie, origin: "https://untrusted.example", "content-type": "application/json" },
			body: JSON.stringify({ name: "Must not create an organization" }),
		});
		expect(response.status).toBe(401);
	});

	it.each(["Bearer", "Basic invalid", "Bearer shiplet_cli_session_invalid"])(
		"does not use test identity headers after rejecting explicit authorization %s",
		async (authorization) => {
			const { userId } = await browserSession();
			const response = await request("/api/organizations", {
				method: "POST",
				headers: { authorization, "x-shiplet-user-id": userId, origin: "https://shiplet.cc", "content-type": "application/json" },
				body: JSON.stringify({ name: `Must not use test identity ${crypto.randomUUID()}` }),
			});
			expect(response.status).toBe(401);
		},
	);

	it("accepts a browser session without explicit authorization", async () => {
		const { cookie } = await browserSession();
		expect((await request("/api/shiplets", { headers: { cookie } })).status).toBe(200);
	});

	it("accepts a valid CLI session on an allowed route without a browser cookie", async () => {
		const { userId } = await browserSession();
		const authorization = await cliSession(userId);
		expect((await request("/api/shiplets", { headers: { authorization } })).status).toBe(200);
	});

	it.each(["%", "%E0%A4%A"])("ignores an unrelated malformed cookie value %s", async (value) => {
		const { cookie } = await browserSession();
		expect((await request("/api/shiplets", { headers: { cookie: `unrelated=${value}; ${cookie}` } })).status).toBe(200);
	});

	it("denies a malformed session cookie without returning a server error", async () => {
		const response = await request("/api/shiplets", { headers: { cookie: "__Host-shiplet_session=%" } });
		expect(response.status).toBe(401);
	});

	it("preserves the last value for duplicate well-formed session cookies", async () => {
		const { cookie } = await browserSession();
		const unknown = `__Host-shiplet_session=${crypto.randomUUID()}`;
		expect((await request("/api/shiplets", { headers: { cookie: `${unknown}; ${cookie}` } })).status).toBe(200);
		expect((await request("/api/shiplets", { headers: { cookie: `${cookie}; ${unknown}` } })).status).toBe(401);
	});
});
