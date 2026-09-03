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

export const SESSION_COOKIE = "__Host-shiplet_session";
export const ACCOUNT_GROUP_COOKIE = "__Host-shiplet_account_group";
export const LEGACY_SESSION_COOKIE = "shiplet_session";
export const LEGACY_ACCOUNT_GROUP_COOKIE = "shiplet_account_group";

function parseCookies(header: string | null) {
	const cookies = new Map<string, string>();
	if (!header) return cookies;

	for (const part of header.split(";")) {
		const [name, ...valueParts] = part.trim().split("=");
		if (name) cookies.set(name, decodeURIComponent(valueParts.join("=")));
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
