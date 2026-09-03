import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { ensureSchema } from "../src/schema";

type KernelTestEnv = {
	DB: D1Database;
	SHIPLET_AUTH_MODE: "test";
};

const testEnv = env as KernelTestEnv;

async function request(path: string, init?: RequestInit) {
	const context = createExecutionContext();
	let response: Response;
	try {
		response = await app.fetch(
			new Request(`https://shiplet.cc${path}`, init),
			testEnv,
			context,
		);
	} catch (error) {
		if (!(error instanceof Response)) throw error;
		response = error;
	}
	await waitOnExecutionContext(context);
	return response;
}

async function insertSentinelProject() {
	const id = `project_kernel_${crypto.randomUUID()}`;
	const name = `Kernel sentinel ${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	await testEnv.DB.prepare(
		`INSERT INTO projects (
			id, organization_id, owner_user_id, name, subdomain,
			script_content, visibility, created_on, modified_on
		) VALUES (?, NULL, NULL, ?, ?, ?, 'private', ?, ?)`,
	)
		.bind(id, name, `kernel-${crypto.randomUUID()}`, "", now, now)
		.run();
	return { id, name };
}

async function insertOrganizationMember(role: "owner" | "member") {
	const userId = `user_kernel_${crypto.randomUUID()}`;
	const organizationId = `org_kernel_${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	await testEnv.DB.batch([
		testEnv.DB.prepare(
			`INSERT INTO users (
				id, email, first_name, last_name, created_on, updated_on
			) VALUES (?, ?, 'Kernel', 'Member', ?, ?)`,
		)
			.bind(userId, `${userId}@example.test`, now, now),
		testEnv.DB.prepare(
			`INSERT INTO organizations (id, name, created_by_user_id, created_on)
			 VALUES (?, 'Kernel organization', ?, ?)`,
		)
			.bind(organizationId, userId, now),
		testEnv.DB.prepare(
			`INSERT INTO organization_memberships (
				id, organization_id, user_id, role, created_on
			) VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(
				`membership_kernel_${crypto.randomUUID()}`,
				organizationId,
				userId,
				role,
				now,
			),
	]);
	return { userId, organizationId };
}

describe("trusted kernel administrative boundary", () => {
	beforeEach(async () => {
		await ensureSchema(testEnv.DB);
	});

	it("does not expose the global administration inventory anonymously", async () => {
		const sentinel = await insertSentinelProject();

		const response = await request("/admin");
		const body = await response.text();

		expect([401, 403, 404]).toContain(response.status);
		expect(body).not.toContain(sentinel.name);
	});

	it("does not allow an anonymous GET to reset projects or deployment scripts", async () => {
		const sentinel = await insertSentinelProject();

		const response = await request("/init", { redirect: "manual" });
		const persisted = await testEnv.DB.prepare(
			"SELECT id FROM projects WHERE id = ?",
		)
			.bind(sentinel.id)
			.first<{ id: string }>();

		expect([401, 403, 404, 405]).toContain(response.status);
		expect(persisted?.id).toBe(sentinel.id);
	});

	it("does not let an ordinary member mint organization-wide API authority", async () => {
		const actor = await insertOrganizationMember("member");

		const response = await request(
			`/api/organizations/${actor.organizationId}/api-tokens`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: "https://shiplet.cc",
					"x-shiplet-user-id": actor.userId,
					"x-shiplet-user-email": `${actor.userId}@example.test`,
				},
				body: JSON.stringify({
					name: "Member escalation attempt",
					scopes: ["shiplets:read", "shiplets:write", "mcp"],
					projectAccessMode: "all",
				}),
			},
		);

		expect(response.status).toBe(403);
		const tokenCount = await testEnv.DB.prepare(
			"SELECT COUNT(*) AS count FROM organization_api_tokens WHERE organization_id = ?",
		)
			.bind(actor.organizationId)
			.first<{ count: number }>();
		expect(Number(tokenCount?.count || 0)).toBe(0);
	});

	it("does not let an ordinary member inventory or revoke organization API authority", async () => {
		const actor = await insertOrganizationMember("member");
		const tokenId = `org_token_kernel_${crypto.randomUUID()}`;
		const now = new Date().toISOString();
		await testEnv.DB.prepare(
			`INSERT INTO organization_api_tokens (
				id, organization_id, name, token_hash, scopes,
				project_access_mode, created_by_user_id, created_on
			) VALUES (?, ?, 'Privileged token', ?, '["mcp"]', 'all', ?, ?)`,
		)
			.bind(
				tokenId,
				actor.organizationId,
				`hash_${crypto.randomUUID()}`,
				actor.userId,
				now,
			)
			.run();
		const headers = {
			Origin: "https://shiplet.cc",
			"x-shiplet-user-id": actor.userId,
			"x-shiplet-user-email": `${actor.userId}@example.test`,
		};

		const listResponse = await request(
			`/api/organizations/${actor.organizationId}/api-tokens`,
			{ headers },
		);
		const revokeResponse = await request(
			`/api/organizations/${actor.organizationId}/api-tokens/${tokenId}`,
			{ method: "DELETE", headers },
		);
		const dashboardResponse = await request("/api/dashboard", { headers });
		const dashboard = (await dashboardResponse.json()) as {
			apiTokensByOrganization: Record<string, unknown[]>;
		};
		const persisted = await testEnv.DB.prepare(
			"SELECT revoked_on FROM organization_api_tokens WHERE id = ?",
		)
			.bind(tokenId)
			.first<{ revoked_on: string | null }>();

		expect(listResponse.status).toBe(403);
		expect(revokeResponse.status).toBe(403);
		expect(dashboardResponse.status).toBe(200);
		expect(dashboard.apiTokensByOrganization[actor.organizationId]).toEqual([]);
		expect(persisted?.revoked_on).toBeNull();
	});
});
