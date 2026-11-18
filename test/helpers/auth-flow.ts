import { createAuthFlowState } from "../../src/auth";
import type { Env } from "../../src/env";

/** Fetches a path or absolute URL through the Worker under test. */
export type AuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

type SignInOptions = {
	/** Absolute origin such as https://app.shiplet.cc; omit for relative paths. */
	origin?: string;
	returnTo?: string;
	accountAction?: "add";
	/** Cookies the browser already holds, such as an existing session. */
	cookie?: string;
};

export function setCookiePairs(response: Response) {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.filter(Boolean);
}

export function joinCookies(...cookies: Array<string | null | undefined>) {
	return cookies.filter(Boolean).join("; ");
}

export function authCallbackUrl(origin: string | undefined, code: string, state?: string) {
	const params = new URLSearchParams({ code });
	if (state !== undefined) params.set("state", state);
	return `${origin ?? ""}/auth/callback?${params}`;
}

/**
 * Starts sign-in the way a browser does: GET /auth/login, then keep the state
 * from the AuthKit redirect and the per-flow cookie Shiplet set for it.
 */
export async function startSignIn(fetcher: AuthFetch, options: SignInOptions = {}) {
	const params = new URLSearchParams();
	if (options.returnTo) params.set("return_to", options.returnTo);
	if (options.accountAction) params.set("account_action", options.accountAction);
	const query = params.toString();
	const response = await fetcher(
		`${options.origin ?? ""}/auth/login${query ? `?${query}` : ""}`,
		{
			headers: options.cookie ? { cookie: options.cookie } : {},
			redirect: "manual",
		},
	);
	const location = response.headers.get("location");
	if (response.status !== 302 || !location?.startsWith("https://authkit.test/")) {
		throw new Error(
			`Expected /auth/login to redirect to AuthKit, got ${response.status} ${location ?? ""}`,
		);
	}
	const authorizationUrl = new URL(location);
	const state = authorizationUrl.searchParams.get("state");
	const cookie = setCookiePairs(response).find((pair) =>
		/^(?:__Host-)?shiplet_auth_flow_/.test(pair),
	);
	if (!state || !cookie) throw new Error("Sign-in did not bind its state to a cookie");
	return { state, cookie, authorizationUrl };
}

/** Starts sign-in at /auth/login and returns with an AuthKit code. */
export async function signInWithCode(
	fetcher: AuthFetch,
	code: string,
	options: SignInOptions = {},
) {
	const flow = await startSignIn(fetcher, options);
	return fetcher(authCallbackUrl(options.origin, code, flow.state), {
		headers: { cookie: joinCookies(options.cookie, flow.cookie) },
		redirect: "manual",
	});
}

/**
 * Returns with an AuthKit code for a state Shiplet minted with a specific
 * payload (invitation or consent flows that /auth/login reaches indirectly).
 */
export async function signInWithMintedState(
	fetcher: AuthFetch,
	env: unknown,
	code: string,
	payload: Record<string, unknown>,
	options: { origin?: string; cookie?: string } = {},
) {
	const flow = await createAuthFlowState(env as Env, payload);
	return fetcher(authCallbackUrl(options.origin, code, flow.state), {
		headers: { cookie: joinCookies(options.cookie, flow.cookie.split(";")[0]) },
		redirect: "manual",
	});
}

/** The session cookies a sign-in callback set, as a Cookie header. */
export function sessionCookieHeader(response: Response) {
	return setCookiePairs(response)
		.filter((pair) => /^(?:__Host-)?shiplet_(?:session|account_group)=./.test(pair))
		.join("; ");
}

/**
 * Follows a sign-in callback to the invitation consent it offered, then
 * accepts it the way the signed-in browser does.
 */
export async function acceptOfferedInvitationConsent(
	fetcher: AuthFetch,
	callback: Response,
	options: { origin?: string; headers?: Record<string, string> } = {},
) {
	const cookie = sessionCookieHeader(callback);
	const consentUrl = new URL(
		callback.headers.get("location") || "",
		options.origin ?? "http://localhost",
	);
	if (consentUrl.pathname !== "/auth/login" || !consentUrl.searchParams.get("consent")) {
		throw new Error(`Expected sign-in to offer invitation consent, got ${consentUrl}`);
	}
	const consentPath = `${consentUrl.pathname}${consentUrl.search}`;
	const consentPage = await fetcher(
		options.origin ? `${options.origin}${consentPath}` : consentPath,
		{ headers: { cookie }, redirect: "manual" },
	);
	const html = await consentPage.text();
	const consentToken = html.match(/name="consent_token" value="([^"]+)"/)?.[1];
	if (!consentToken) throw new Error("Consent page did not offer an invitation");
	const accepted = await fetcher(`${options.origin ?? ""}/auth/login`, {
		method: "POST",
		headers: {
			cookie,
			Origin: consentUrl.origin,
			"Content-Type": "application/x-www-form-urlencoded",
			...options.headers,
		},
		body: new URLSearchParams({ consent_token: consentToken }),
		redirect: "manual",
	});
	return { cookie, consentToken, consentPage: html, accepted };
}
