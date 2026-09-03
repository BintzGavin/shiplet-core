import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";
import { absoluteSiteUrl, normalizeAppUrl } from "./seo";
import {
	upsertUser,
	type ShipletUser,
} from "./store";
import {
	createMcpAgentRegistrationPrincipal,
	createMcpOAuthPrincipal,
	parseVerifiedAgentRegistrationClaims,
	parseVerifiedMcpOAuthClaims,
	type AuthenticatedMcpAgentPrincipal,
} from "./mcp-principal";
import { getWorkOSUser } from "./workos";
import { resolveVerifiedWorkOSUser } from "./workos-identity";

export const MCP_OAUTH_SCOPES = ["openid", "profile", "email"] as const;

const TEST_OAUTH_TOKEN_PREFIX = "shiplet_oauth_";
const TEST_MCP_PRINCIPAL_TOKEN_PREFIX = "shiplet_mcp_principal_";
const TEST_AGENT_REGISTRATION_TOKEN_PREFIX = "shiplet_agent_registration_";
const MAX_MCP_OAUTH_TOKEN_BYTES = 16_384;
const MAX_TEST_MCP_PRINCIPAL_PAYLOAD_BYTES = 8_192;
const MAX_AGENT_AUTH_GUIDE_BYTES = 256 * 1024;
const SHIPLET_AGENT_GUIDE_RESOURCE_NOTE = [
	"",
	"## Shiplet MCP resource",
	"",
	"Shiplet requires a resource-bound access token. In the step that exchanges the identity assertion for an access token, include this form field:",
	"",
	"```bash",
	`--data-urlencode "resource=${mcpResourceUrl()}"`,
	"```",
	"",
	"WorkOS places this URI in the access token audience. Use the resulting access token only with this Shiplet MCP resource.",
	"",
].join("\n");
const SHIPLET_AGENT_GUIDE_RESOURCE_NOTE_BYTES = new TextEncoder().encode(
	SHIPLET_AGENT_GUIDE_RESOURCE_NOTE,
);
const jwksByIssuer = new Map<
	string,
	ReturnType<typeof createRemoteJWKSet>
>();

export function mcpResourceUrl(appUrl?: string) {
	return absoluteSiteUrl(appUrl, "/api/mcp");
}

export function mcpResourceMetadataUrl(appUrl?: string) {
	return absoluteSiteUrl(appUrl, "/.well-known/oauth-protected-resource");
}

export function workOSAuthKitIssuer(env: Env) {
	const configured = env.WORKOS_AUTHKIT_ISSUER;
	if (configured) return normalizeIssuer(configured);
	if (env.SHIPLET_AUTH_MODE === "test") {
		return "https://example.authkit.app";
	}
	throw new Response("WORKOS_AUTHKIT_ISSUER is not configured", {
		status: 500,
	});
}

export function mcpOAuthChallenge(appUrl?: string) {
	return [
		'Bearer error="unauthorized"',
		'error_description="Authorization needed"',
		`resource_metadata="${mcpResourceMetadataUrl(appUrl)}"`,
		`scope="${MCP_OAUTH_SCOPES.join(" ")}"`,
	].join(", ");
}

export function mcpAuthorizationRequiredResponse(appUrl?: string) {
	return new Response(
		JSON.stringify({
			error: "authorization_required",
			error_description: "Authorization needed",
		}),
		{
			status: 401,
			headers: {
				"content-type": "application/json; charset=utf-8",
				"www-authenticate": mcpOAuthChallenge(appUrl),
			},
		},
	);
}

export function mcpProtectedResourceMetadata(env: Env, appUrl?: string) {
	const baseUrl = normalizeAppUrl(appUrl);
	return {
		resource: mcpResourceUrl(baseUrl),
		authorization_servers: [workOSAuthKitIssuer(env)],
		bearer_methods_supported: ["header"],
		scopes_supported: [...MCP_OAUTH_SCOPES],
		resource_documentation: absoluteSiteUrl(baseUrl, "/docs/code-mode-mcp"),
		resource_name: "Shiplet Code Mode MCP",
	};
}

export function mcpProtectedResourceMetadataResponse(env: Env, appUrl?: string) {
	return new Response(JSON.stringify(mcpProtectedResourceMetadata(env, appUrl)), {
		headers: {
			"cache-control": "public, max-age=300",
			"content-type": "application/json; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

export async function proxyWorkOSAuthorizationServerMetadata(env: Env) {
	const response = await fetch(
		`${workOSAuthKitIssuer(env)}/.well-known/oauth-authorization-server`,
		{
			headers: { accept: "application/json" },
		},
	);
	const body = await response.text();
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: {
			"cache-control": "public, max-age=300",
			"content-type":
				response.headers.get("content-type") ||
				"application/json; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

type PublicFetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

function unavailableAgentAuthGuide() {
	return new Response("AuthKit agent guide is unavailable", {
		status: 502,
		headers: {
			"cache-control": "no-store",
			"content-type": "text/plain; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

export async function proxyWorkOSAgentAuthGuide(
	env: Env,
	fetcher: PublicFetcher = fetch,
) {
	const upstreamByteLimit =
		MAX_AGENT_AUTH_GUIDE_BYTES - SHIPLET_AGENT_GUIDE_RESOURCE_NOTE_BYTES.byteLength;
	let response: Response;
	try {
		response = await fetcher(`${workOSAuthKitIssuer(env)}/agent/auth.md`, {
			headers: { accept: "text/markdown" },
			redirect: "manual",
		});
	} catch {
		return unavailableAgentAuthGuide();
	}
	if (!response.ok || !response.body) return unavailableAgentAuthGuide();

	const declaredLength = Number(response.headers.get("content-length") || "0");
	if (
		Number.isFinite(declaredLength) &&
		declaredLength > upstreamByteLimit
	) {
		void response.body.cancel();
		return unavailableAgentAuthGuide();
	}

	const chunks: Uint8Array[] = [];
	let received = 0;
	const reader = response.body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > upstreamByteLimit) {
				await reader.cancel();
				return unavailableAgentAuthGuide();
			}
			chunks.push(value);
		}
	} catch {
		return unavailableAgentAuthGuide();
	}

	const body = new Uint8Array(
		received + SHIPLET_AGENT_GUIDE_RESOURCE_NOTE_BYTES.byteLength,
	);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	body.set(SHIPLET_AGENT_GUIDE_RESOURCE_NOTE_BYTES, offset);
	return new Response(body, {
		headers: {
			"cache-control": "public, max-age=300",
			"content-type": "text/markdown; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

export async function authenticateMcpOAuthUser(
	env: Env,
	request: Request,
	appUrl?: string,
) {
	const token = bearerToken(request.headers.get("authorization"));
	if (!token) return null;

	if (env.SHIPLET_AUTH_MODE === "test") {
		return authenticateTestOAuthToken(env, token);
	}

	const issuer = workOSAuthKitIssuer(env);
	try {
		const { payload } = await jwtVerify(token, jwksForIssuer(issuer), {
			issuer,
			audience: mcpResourceUrl(appUrl),
		});

		const userId = typeof payload.sub === "string" ? payload.sub : "";
		if (!userId) throw new Error("Missing subject claim.");

		const workosUser = await getWorkOSUser(env, userId);
		return resolveVerifiedWorkOSUser(env.DB, workosUser);
	} catch {
		throw mcpAuthorizationRequiredResponse(appUrl);
	}
}

export async function authenticateMcpOAuthPrincipal(
	env: Env,
	request: Request,
	options: {
		appUrl?: string;
		requiredPermissions?: readonly string[];
	} = {},
): Promise<AuthenticatedMcpAgentPrincipal | null> {
	const token = bearerToken(request.headers.get("authorization"));
	if (!token) return null;
	if (token.length > MAX_MCP_OAUTH_TOKEN_BYTES) {
		throw mcpAuthorizationRequiredResponse(options.appUrl);
	}

	try {
		if (env.SHIPLET_AUTH_MODE === "test") {
			if (token.startsWith(TEST_AGENT_REGISTRATION_TOKEN_PREFIX)) {
				const payload = parseTestMcpPrincipalPayload(
					token,
					TEST_AGENT_REGISTRATION_TOKEN_PREFIX,
				);
				const claims = parseVerifiedAgentRegistrationClaims(
					payload,
					options.requiredPermissions,
				);
				const subject = await upsertAndReturnUser(env, {
					id: claims.subjectId,
					email: boundedTestEmail(payload.email),
					firstName: "Registration",
					lastName: "Subject",
				});
				return createMcpAgentRegistrationPrincipal(subject, claims);
			}
			if (!token.startsWith(TEST_MCP_PRINCIPAL_TOKEN_PREFIX)) return null;
			const payload = parseTestMcpPrincipalPayload(token);
			const claims = parseVerifiedMcpOAuthClaims(
				payload,
				options.requiredPermissions,
			);
			const email = boundedTestEmail(payload.email);
			const subject = await upsertAndReturnUser(env, {
				id: claims.subjectId,
				email,
				firstName: "OAuth",
				lastName: "Subject",
			});
			return createMcpOAuthPrincipal(subject, claims);
		}

		const issuer = workOSAuthKitIssuer(env);
		const { payload } = await jwtVerify(token, jwksForIssuer(issuer), {
			issuer,
			audience: mcpResourceUrl(options.appUrl),
		});
		if (isAgentRegistrationPayload(payload)) {
			const claims = parseVerifiedAgentRegistrationClaims(
				payload,
				options.requiredPermissions,
			);
			const workosUser = await getWorkOSUser(env, claims.subjectId);
			const subject = await resolveVerifiedWorkOSUser(env.DB, workosUser);
			return createMcpAgentRegistrationPrincipal(subject, claims, {
				authenticatedProviderSubjectId: workosUser.id,
			});
		}
		if (!isDelegatedMcpOAuthPayload(payload)) return null;
		const claims = parseVerifiedMcpOAuthClaims(
			payload,
			options.requiredPermissions,
		);
		const workosUser = await getWorkOSUser(env, claims.subjectId);
		const subject = await resolveVerifiedWorkOSUser(env.DB, workosUser);
		return createMcpOAuthPrincipal(subject, claims, {
			authenticatedProviderSubjectId: workosUser.id,
		});
	} catch {
		throw mcpAuthorizationRequiredResponse(options.appUrl);
	}
}

function isAgentRegistrationPayload(payload: Record<string, unknown>) {
	return (
		payload.act !== undefined ||
		(typeof payload.sub === "string" && payload.sub.startsWith("agent_reg_"))
	);
}

function isDelegatedMcpOAuthPayload(payload: Record<string, unknown>) {
	return (
		payload.client_id !== undefined ||
		payload.sid !== undefined ||
		payload.permissions !== undefined
	);
}

function normalizeIssuer(value: string) {
	const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
	return withScheme.replace(/\/+$/, "");
}

function bearerToken(authorization: string | null | undefined) {
	if (!authorization) return null;
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}

function jwksForIssuer(issuer: string) {
	const cached = jwksByIssuer.get(issuer);
	if (cached) return cached;
	const jwks = createRemoteJWKSet(new URL(`${issuer}/oauth2/jwks`));
	jwksByIssuer.set(issuer, jwks);
	return jwks;
}

async function authenticateTestOAuthToken(env: Env, token: string) {
	if (!token.startsWith(TEST_OAUTH_TOKEN_PREFIX)) return null;
	const encoded = token.slice(TEST_OAUTH_TOKEN_PREFIX.length);
	const email = base64UrlDecode(encoded) || "oauth@example.com";
	const id = `user_oauth_${slug(email)}`;
	return upsertAndReturnUser(env, {
		id,
		email,
		firstName: "OAuth",
		lastName: "Agent",
	});
}

async function upsertAndReturnUser(
	env: Env,
	user: {
		id: string;
		email: string;
		firstName?: string | null;
		lastName?: string | null;
	},
): Promise<ShipletUser> {
	await upsertUser(env.DB, user);
	const now = new Date().toISOString();
	return {
		id: user.id,
		email: user.email,
		first_name: user.firstName || null,
		last_name: user.lastName || null,
		created_on: now,
		updated_on: now,
	};
}

function base64UrlDecode(value: string) {
	const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
	try {
		return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
	} catch {
		return "";
	}
}

function parseTestMcpPrincipalPayload(
	token: string,
	prefix = TEST_MCP_PRINCIPAL_TOKEN_PREFIX,
) {
	const encoded = token.slice(prefix.length);
	if (
		encoded.length < 1 ||
		encoded.length > MAX_TEST_MCP_PRINCIPAL_PAYLOAD_BYTES ||
		!/^[A-Za-z0-9_-]+$/.test(encoded)
	) {
		throw new Error("Invalid delegated MCP OAuth test token.");
	}
	const decoded = base64UrlDecode(encoded);
	if (!decoded || decoded.length > MAX_TEST_MCP_PRINCIPAL_PAYLOAD_BYTES) {
		throw new Error("Invalid delegated MCP OAuth test payload.");
	}
	const payload: unknown = JSON.parse(decoded);
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Invalid delegated MCP OAuth test claims.");
	}
	return payload as Record<string, unknown>;
}

function boundedTestEmail(value: unknown) {
	if (
		typeof value !== "string" ||
		value.length < 3 ||
		value.length > 320 ||
		!/^[^\s@]+@[^\s@]+$/.test(value)
	) {
		throw new Error("Invalid delegated MCP OAuth test subject email.");
	}
	return value;
}

function slug(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64) || "user";
}
