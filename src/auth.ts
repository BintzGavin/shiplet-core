import type { Context } from "hono";
import type { Env } from "./env";
import {
	attachSessionToAccountGroup,
	createSession,
	deleteAccountGroupSessions,
	deleteSession,
	getAccountGroupSession,
	getUser,
	getSessionWithUser,
	listAccountGroupSessions,
	ShipletUser,
	touchAccountGroupSession,
	upsertUser,
} from "./store";
import { authenticateCliSession } from "./cli-session";
import { timingSafeSecretMatches } from "./timing-safe-secret";

export const SESSION_COOKIE = "__Host-shiplet_session";
export const ACCOUNT_GROUP_COOKIE = "__Host-shiplet_account_group";
export const LEGACY_SESSION_COOKIE = "shiplet_session";
export const LEGACY_ACCOUNT_GROUP_COOKIE = "shiplet_account_group";

function parseCookies(header: string | null) {
	const cookies = new Map<string, string>();
	if (!header) return cookies;

	for (const part of header.split(";")) {
		const [name, ...valueParts] = part.trim().split("=");
		if (!name) continue;
		try {
			cookies.set(name, decodeURIComponent(valueParts.join("=")));
		} catch {
			// Ignore malformed cookies without discarding unrelated valid sessions.
			continue;
		}
	}

	return cookies;
}

export function getCookie(request: Request, name: string) {
	return parseCookies(request.headers.get("cookie")).get(name);
}

function useHostPrefixedCookies(env?: Env) {
	if (!env?.SHIPLET_APP_URL) return true;
	try {
		return new URL(env.SHIPLET_APP_URL).protocol === "https:";
	} catch {
		return true;
	}
}

function activeSessionCookieName(env?: Env) {
	return useHostPrefixedCookies(env) ? SESSION_COOKIE : LEGACY_SESSION_COOKIE;
}

function activeAccountGroupCookieName(env?: Env) {
	return useHostPrefixedCookies(env)
		? ACCOUNT_GROUP_COOKIE
		: LEGACY_ACCOUNT_GROUP_COOKIE;
}

function secureCookieAttribute(env?: Env) {
	return useHostPrefixedCookies(env) ? "; Secure" : "";
}

export function getSessionCookie(request: Request, env: Env) {
	return getCookie(request, activeSessionCookieName(env));
}

export function getAccountGroupCookie(request: Request, env: Env) {
	return getCookie(request, activeAccountGroupCookieName(env));
}

function legacyCookieDomainAttribute(env?: Env) {
	const domain = env?.CUSTOM_DOMAIN?.trim().toLowerCase();
	if (
		!domain ||
		domain === "localhost" ||
		domain.endsWith(".localhost") ||
		domain.includes(":")
	) {
		return "";
	}
	return `; Domain=${domain}`;
}

export function sessionCookie(sessionId: string, env?: Env) {
	return `${activeSessionCookieName(env)}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly${secureCookieAttribute(env)}; SameSite=Lax; Max-Age=${14 * 24 * 60 * 60}`;
}

export function accountGroupCookie(groupId: string, env?: Env) {
	return `${activeAccountGroupCookieName(env)}=${encodeURIComponent(groupId)}; Path=/; HttpOnly${secureCookieAttribute(env)}; SameSite=Lax; Max-Age=${14 * 24 * 60 * 60}`;
}

export function clearSessionCookie(env?: Env) {
	return `${activeSessionCookieName(env)}=; Path=/; HttpOnly${secureCookieAttribute(env)}; SameSite=Lax; Max-Age=0`;
}

export function clearAccountGroupCookie(env?: Env) {
	return `${activeAccountGroupCookieName(env)}=; Path=/; HttpOnly${secureCookieAttribute(env)}; SameSite=Lax; Max-Age=0`;
}

// Sign-in state is honored only by the browser that started it. Each AuthKit
// redirect gets its own short-lived cookie, keyed by a random flow ID carried
// in the state, so concurrent tabs do not overwrite each other's flows. The
// cookie value is a digest of the exact state, so a changed state no longer
// matches. Host-prefixed cookies keep sibling artifact hosts from planting one.
const AUTH_FLOW_COOKIE_PREFIX = "shiplet_auth_flow_";
const AUTH_FLOW_TTL_SECONDS = 10 * 60;
const AUTH_FLOW_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export type AuthFlowState = Record<string, unknown>;

export type AuthFlowVerification =
	| { ok: true; state: AuthFlowState; clearCookie: string }
	| {
			ok: false;
			/** missing: no state; unbound: no flow cookie for it; mismatch: cookie and state disagree. */
			reason: "missing" | "unbound" | "mismatch";
			state: AuthFlowState;
			clearCookie?: string;
	  };

function base64UrlBytes(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function authFlowCookieName(flowId: string, env?: Env) {
	return `${useHostPrefixedCookies(env) ? "__Host-" : ""}${AUTH_FLOW_COOKIE_PREFIX}${flowId}`;
}

function authFlowCookie(flowId: string, value: string, maxAge: number, env?: Env) {
	return `${authFlowCookieName(flowId, env)}=${value}; Path=/; HttpOnly${secureCookieAttribute(env)}; SameSite=Lax; Max-Age=${maxAge}`;
}

async function authFlowBinding(state: string) {
	return base64UrlBytes(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state)),
		),
	);
}

function parseAuthFlowState(state: string): AuthFlowState | null {
	try {
		const value = JSON.parse(atob(state));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as AuthFlowState)
			: null;
	} catch {
		return null;
	}
}

/** Mints AuthKit state for one sign-in and the cookie that binds it to this browser. */
export async function createAuthFlowState(env: Env, payload: AuthFlowState) {
	const flowId = base64UrlBytes(crypto.getRandomValues(new Uint8Array(16)));
	const state = btoa(JSON.stringify({ ...payload, flow: flowId }));
	return {
		state,
		cookie: authFlowCookie(
			flowId,
			await authFlowBinding(state),
			AUTH_FLOW_TTL_SECONDS,
			env,
		),
	};
}

/** Checks that AuthKit state was minted for the browser presenting it. */
export async function verifyAuthFlowState(
	request: Request,
	env: Env,
	state: string | null,
): Promise<AuthFlowVerification> {
	if (!state) return { ok: false, reason: "missing", state: {} };
	const parsed = parseAuthFlowState(state);
	if (!parsed) return { ok: false, reason: "unbound", state: {} };
	const flowId = parsed.flow;
	if (typeof flowId !== "string" || !AUTH_FLOW_ID_PATTERN.test(flowId)) {
		return { ok: false, reason: "unbound", state: parsed };
	}
	const binding = getCookie(request, authFlowCookieName(flowId, env));
	if (!binding) return { ok: false, reason: "unbound", state: parsed };
	const clearCookie = authFlowCookie(flowId, "", 0, env);
	if (!(await timingSafeSecretMatches(await authFlowBinding(state), binding))) {
		return { ok: false, reason: "mismatch", state: parsed, clearCookie };
	}
	return { ok: true, state: parsed, clearCookie };
}

export function clearLegacySessionCookie(env?: Env) {
	return `${LEGACY_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0${legacyCookieDomainAttribute(env)}`;
}

export function clearLegacyAccountGroupCookie(env?: Env) {
	return `${LEGACY_ACCOUNT_GROUP_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0${legacyCookieDomainAttribute(env)}`;
}

function normalizeHostname(hostname: string) {
	return hostname.toLowerCase().replace(/\.$/, "");
}

function isLocalDevHostname(hostname: string) {
	const host = normalizeHostname(hostname).replace(/^\[|\]$/g, "");
	return (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host.endsWith(".localhost")
	);
}

function configuredAppHostname(env: Env) {
	if (env.SHIPLET_APP_URL) {
		try {
			return normalizeHostname(new URL(env.SHIPLET_APP_URL).hostname);
		} catch {
			return null;
		}
	}
	return env.CUSTOM_DOMAIN ? normalizeHostname(env.CUSTOM_DOMAIN) : null;
}

export function requestCanUsePlatformCookies(request: Request, env: Env) {
	let requestHost = "";
	try {
		requestHost = normalizeHostname(new URL(request.url).hostname);
	} catch {
		return false;
	}
	const appHost = configuredAppHostname(env);

	if (appHost && isLocalDevHostname(appHost)) {
		return true;
	}
	if (isLocalDevHostname(requestHost)) return true;
	if (appHost) return requestHost === appHost;
	if (env.CUSTOM_DOMAIN) {
		return requestHost === normalizeHostname(env.CUSTOM_DOMAIN);
	}
	return true;
}

export async function getCurrentUser(
	request: Request,
	env: Env,
): Promise<ShipletUser | null> {
	const cliUserId = await authenticateCliSession(env.DB, request);
	if (cliUserId) return getUser(env.DB, cliUserId);
	if (request.headers.get("authorization")?.trim()) return null;
	if (env.SHIPLET_AUTH_MODE === "test") {
		const userId = request.headers.get("x-shiplet-user-id");
		if (!userId) {
			if (!requestCanUsePlatformCookies(request, env)) return null;
			const sessionId = getSessionCookie(request, env);
			if (!sessionId) return null;
			return getSessionWithUser(env.DB, sessionId);
		}

		const email =
			request.headers.get("x-shiplet-user-email") || `${userId}@example.com`;
		const firstName = request.headers.get("x-shiplet-user-first-name");
		const lastName = request.headers.get("x-shiplet-user-last-name");

		await upsertUser(env.DB, {
			id: userId,
			email,
			firstName,
			lastName,
		});

		return getUser(env.DB, userId);
	}

	if (!requestCanUsePlatformCookies(request, env)) return null;
	const sessionId = getSessionCookie(request, env);
	if (!sessionId) return null;
	return getSessionWithUser(env.DB, sessionId);
}

export async function requireCurrentUser(c: Context<any>) {
	const user = await getCurrentUser(c.req.raw, c.env);
	if (!user) {
		throw new Response("Authentication required", { status: 401 });
	}
	return user;
}

export async function createUserSessionResponse(
	env: Env,
	userId: string,
	redirectTo = "/",
	options: {
		accountGroupId?: string | null;
		seedSessionId?: string | null;
	} = {},
) {
	const session = await createSession(env.DB, userId);
	const response = new Response(null, {
		status: 302,
		headers: {
			location: redirectTo,
			"set-cookie": sessionCookie(session.id, env),
		},
	});
	if (useHostPrefixedCookies(env)) {
		response.headers.append("set-cookie", clearLegacySessionCookie(env));
		response.headers.append("set-cookie", clearLegacyAccountGroupCookie(env));
	}

	if (options.accountGroupId) {
		if (options.seedSessionId) {
			const seedUser = await getSessionWithUser(env.DB, options.seedSessionId);
			if (seedUser) {
				await attachSessionToAccountGroup(
					env.DB,
					options.accountGroupId,
					options.seedSessionId,
					seedUser.id,
				);
			}
		}
		await attachSessionToAccountGroup(
			env.DB,
			options.accountGroupId,
			session.id,
			userId,
		);
		response.headers.append(
			"set-cookie",
			accountGroupCookie(options.accountGroupId, env),
		);
	}

	return response;
}

export async function listCurrentAccountSessions(
	env: Env,
	request: Request,
	activeUser: ShipletUser,
) {
	const activeSessionId = getSessionCookie(request, env);
	if (!activeSessionId) return [];

	const accountGroupId = getAccountGroupCookie(request, env);
	if (!accountGroupId) {
		return [
			{
				session_id: activeSessionId,
				user_id: activeUser.id,
				email: activeUser.email,
				first_name: activeUser.first_name || null,
				last_name: activeUser.last_name || null,
				avatar_preset: activeUser.avatar_preset || null,
				avatar_data_url: activeUser.avatar_data_url || null,
				active: true,
			},
		];
	}

	const sessions = await listAccountGroupSessions(env.DB, accountGroupId);
	return sessions.map((session) => ({
		session_id: session.session_id,
		user_id: session.user_id,
		email: session.email,
		first_name: session.first_name || null,
		last_name: session.last_name || null,
		avatar_preset: session.avatar_preset || null,
		avatar_data_url: session.avatar_data_url || null,
		active: session.session_id === activeSessionId,
	}));
}

export async function switchAccountSessionResponse(
	env: Env,
	request: Request,
	sessionId: string,
	redirectTo = "/account",
) {
	const accountGroupId = getAccountGroupCookie(request, env);
	if (!accountGroupId) {
		return new Response("Account group required", { status: 403 });
	}

	const accountSession = await getAccountGroupSession(
		env.DB,
		accountGroupId,
		sessionId,
	);
	if (!accountSession) {
		return new Response("Account session not found", { status: 404 });
	}

	await touchAccountGroupSession(env.DB, accountGroupId, sessionId);
	const response = new Response(null, {
		status: 302,
		headers: {
			location: redirectTo,
			"set-cookie": sessionCookie(sessionId, env),
		},
	});
	response.headers.append("set-cookie", accountGroupCookie(accountGroupId, env));
	if (useHostPrefixedCookies(env)) {
		response.headers.append("set-cookie", clearLegacySessionCookie(env));
		response.headers.append("set-cookie", clearLegacyAccountGroupCookie(env));
	}
	return response;
}

export async function logoutResponse(request: Request, env: Env) {
	const sessionId = getSessionCookie(request, env);
	const accountGroupId = getAccountGroupCookie(request, env);
	if (accountGroupId) {
		await deleteAccountGroupSessions(env.DB, accountGroupId);
	} else if (sessionId) {
		await deleteSession(env.DB, sessionId);
	}

	const response = new Response(null, {
		status: 302,
		headers: {
			location: "/",
			"set-cookie": clearSessionCookie(env),
		},
	});
	response.headers.append("set-cookie", clearAccountGroupCookie(env));
	if (useHostPrefixedCookies(env)) {
		response.headers.append("set-cookie", clearLegacySessionCookie(env));
		response.headers.append("set-cookie", clearLegacyAccountGroupCookie(env));
	}
	return response;
}
