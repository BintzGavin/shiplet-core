import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
	authenticateMcpOAuthPrincipal,
	authenticateMcpOAuthUser,
} from "../src/mcp-auth";
import { createMcpOAuthPrincipal } from "../src/mcp-principal";
import { ensureSchema } from "../src/schema";

/*
 * Behavioral specification
 *
 * Given a jose-verified WorkOS OAuth access token for an MCP client,
 * When Shiplet authenticates the delegated request,
 * Then the human subject, exact OAuth client, stable consent/session, selected
 * organization, and exact operation permissions remain separate; the request
 * is attributed to a stable agent actor that never contains bearer material.
 *
 * Given a token whose delegated client/grant identity or permission set is
 * missing, malformed, or insufficient,
 * When Shiplet authenticates it,
 * Then authentication fails closed without falling back to a human actor.
 */

type TestClaims = {
	sub?: unknown;
	client_id?: unknown;
	sid?: unknown;
	org_id?: unknown;
	permissions?: unknown;
	scope?: unknown;
	jti?: unknown;
	email?: unknown;
};

const testEnv = env as Env;
const TEST_TOKEN_PREFIX = "shiplet_mcp_principal_";

function testPrincipalToken(overrides: TestClaims = {}) {
	const claims: TestClaims = {
		sub: "user_mcp_subject",
		client_id: "client_mcp_desktop",
		sid: "app_consent_mcp_stable",
		org_id: "org_mcp_selected",
		permissions: ["shiplets:read", "revisions:validate"],
		jti: `test_rotation_${crypto.randomUUID()}`,
		email: "mcp-subject@example.test",
		...overrides,
	};
	const encoded = btoa(JSON.stringify(claims))
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
	return `${TEST_TOKEN_PREFIX}${encoded}`;
}

function requestWithBearer(token: string) {
	return new Request("https://shiplet.cc/api/mcp", {
		headers: { authorization: `Bearer ${token}` },
	});
}

async function expectUnauthorized(token: string, requiredPermissions = ["shiplets:read"]) {
	await expect(
		authenticateMcpOAuthPrincipal(
			testEnv,
			requestWithBearer(token),
			{ requiredPermissions },
		),
	).rejects.toMatchObject({ status: 401 });
}

describe("trusted delegated MCP OAuth principal", () => {
	beforeAll(async () => {
		await ensureSchema(testEnv.DB);
	});

	it("keeps the human subject separate from the exact client and stable delegated actor", async () => {
		const firstToken = testPrincipalToken({ jti: "rotation_one" });
		const rotatedToken = testPrincipalToken({ jti: "rotation_two" });

		const first = await authenticateMcpOAuthPrincipal(
			testEnv,
			requestWithBearer(firstToken),
			{ requiredPermissions: ["shiplets:read", "revisions:validate"] },
		);
		const rotated = await authenticateMcpOAuthPrincipal(
			testEnv,
			requestWithBearer(rotatedToken),
			{ requiredPermissions: ["shiplets:read"] },
		);

		expect(first).not.toBeNull();
		expect(first).toMatchObject({
			kind: "agent",
			actor: {
				kind: "agent",
				id: "mcp-oauth:client_mcp_desktop:app_consent_mcp_stable",
			},
			actorId: "mcp-oauth:client_mcp_desktop:app_consent_mcp_stable",
			clientId: "client_mcp_desktop",
			grantId: "app_consent_mcp_stable",
			organizationId: "org_mcp_selected",
			permissions: ["shiplets:read", "revisions:validate"],
			subject: {
				id: "user_mcp_subject",
				email: "mcp-subject@example.test",
			},
		});
		expect(first?.actorId).toBe(rotated?.actorId);
		expect(first?.actorId).not.toBe(first?.subject.id);
		expect(JSON.stringify(first)).not.toContain(firstToken);
		expect(JSON.stringify(first)).not.toContain(rotatedToken);
	});

	it("binds actor identity to both the OAuth client and consent/session", async () => {
		const base = await authenticateMcpOAuthPrincipal(
			testEnv,
			requestWithBearer(testPrincipalToken()),
			{ requiredPermissions: ["shiplets:read"] },
		);
		const otherClient = await authenticateMcpOAuthPrincipal(
			testEnv,
			requestWithBearer(
				testPrincipalToken({ client_id: "client_mcp_other" }),
			),
			{ requiredPermissions: ["shiplets:read"] },
		);
		const otherGrant = await authenticateMcpOAuthPrincipal(
			testEnv,
			requestWithBearer(
				testPrincipalToken({ sid: "app_consent_mcp_other" }),
			),
			{ requiredPermissions: ["shiplets:read"] },
		);

		expect(base?.subject.id).toBe(otherClient?.subject.id);
		expect(base?.subject.id).toBe(otherGrant?.subject.id);
		expect(base?.actorId).not.toBe(otherClient?.actorId);
		expect(base?.actorId).not.toBe(otherGrant?.actorId);
	});

	it("keeps a migrated local account distinct from its verified WorkOS subject", () => {
		const timestamp = new Date().toISOString();
		const localUser = {
			id: "user_from_staging_environment",
			email: "migrated-subject@example.test",
			created_on: timestamp,
			updated_on: timestamp,
		};
		const claims = {
			subjectId: "user_from_production_environment",
			clientId: "client_mcp_desktop",
			grantId: "app_consent_mcp_stable",
			organizationId: "org_mcp_selected",
			permissions: ["shiplets:read"],
		};

		const principal = createMcpOAuthPrincipal(localUser, claims, {
			authenticatedProviderSubjectId: "user_from_production_environment",
		});
		expect(principal.subject.id).toBe("user_from_staging_environment");
		expect(() =>
			createMcpOAuthPrincipal(localUser, claims, {
				authenticatedProviderSubjectId: "user_from_another_environment",
			}),
		).toThrow("Delegated MCP OAuth subject mismatch");
	});

	it("does not infer application operations from identity scopes", async () => {
		const principal = await authenticateMcpOAuthPrincipal(
			testEnv,
			requestWithBearer(
				testPrincipalToken({
					permissions: ["shiplets:read"],
					scope: "openid profile email",
				}),
			),
			{ requiredPermissions: ["shiplets:read"] },
		);

		expect(principal?.permissions).toEqual(["shiplets:read"]);
		expect(principal?.permissions).not.toContain("openid");
	});

	it.each([
		["missing client identity", { client_id: undefined }],
		["non-string client identity", { client_id: ["client_mcp_desktop"] }],
		["client identity with whitespace", { client_id: "client bad" }],
		["missing consent/session identity", { sid: undefined }],
		["non-string consent/session identity", { sid: { id: "grant" } }],
		["missing human subject", { sub: undefined }],
		["client used as human subject", { sub: "client_mcp_desktop" }],
		["malformed selected organization", { org_id: "org bad" }],
		["missing operation permissions", { permissions: undefined }],
		["non-string operation permission", { permissions: ["shiplets:read", 7] }],
	])("rejects %s", async (_label, claims) => {
		await expectUnauthorized(testPrincipalToken(claims));
	});

	it("rejects a valid delegated identity that lacks a required operation", async () => {
		await expectUnauthorized(
			testPrincipalToken({ permissions: ["shiplets:read"] }),
			["shiplets:promote"],
		);
	});

	it("rejects malformed and oversized test-token fixtures", async () => {
		await expectUnauthorized(`${TEST_TOKEN_PREFIX}not-base64url`);
		await expectUnauthorized(
			`${TEST_TOKEN_PREFIX}${"a".repeat(12_000)}`,
		);
	});

	it("returns null when no bearer is present", async () => {
		await expect(
			authenticateMcpOAuthPrincipal(
				testEnv,
				new Request("https://shiplet.cc/api/mcp"),
				{ requiredPermissions: ["shiplets:read"] },
			),
		).resolves.toBeNull();
	});

	it("preserves the existing browser-session user authentication API", async () => {
		const encodedEmail = btoa("legacy-oauth@example.test")
			.replace(/=/g, "")
			.replace(/\+/g, "-")
			.replace(/\//g, "_");
		const user = await authenticateMcpOAuthUser(
			testEnv,
			requestWithBearer(`shiplet_oauth_${encodedEmail}`),
		);

		expect(user).toMatchObject({ email: "legacy-oauth@example.test" });
	});
});
