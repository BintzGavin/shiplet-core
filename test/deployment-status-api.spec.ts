import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import { createD1CloudflareConnectionStore } from "../src/d1-cloudflare-control-plane";

const OWNER_HEADERS = {
	"x-shiplet-user-id": "user_deployment_status_owner",
	"x-shiplet-user-email": "deployment-status-owner@example.com",
};

async function request(path: string, init: RequestInit = {}) {
	const context = createExecutionContext();
	let response: Response;
	try {
		response = await app.fetch(
			new Request(`http://localhost${path}`, init),
			env as Env,
			context,
		);
	} catch (error) {
		if (!(error instanceof Response)) throw error;
		response = error;
	}
	await waitOnExecutionContext(context);
	return response;
}

async function requestWithEnv(
	path: string,
	init: RequestInit,
	runtimeEnv: Env,
) {
	const context = createExecutionContext();
	let response: Response;
	try {
		response = await app.fetch(
			new Request(`http://localhost${path}`, init),
			runtimeEnv,
			context,
		);
	} catch (error) {
		if (!(error instanceof Response)) throw error;
		response = error;
	}
	await waitOnExecutionContext(context);
	return response;
}

async function createStaticShiplet() {
	const organizationResponse = await request("/api/organizations", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
		body: JSON.stringify({ name: `Deployment status ${crypto.randomUUID()}` }),
	});
	const { organization } = (await organizationResponse.json()) as {
		organization: { id: string };
	};
	const response = await request("/api/shiplets", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
		body: JSON.stringify({
			name: "Deployment status Shiplet",
			organization_id: organization.id,
			subdomain: `deployment-status-${crypto.randomUUID().slice(0, 8)}`,
			visibility: "private",
			assets: [
				{
					path: "index.html",
					content: btoa("<!doctype html><h1>Managed static</h1>"),
				},
			],
		}),
	});
	expect(response.status).toBe(201);
	return (await response.json()) as { project: { id: string } };
}

describe("deployment ownership status API", () => {
	it("shows managed static hosting as the default and honestly reports unavailable managed arbitrary execution and Cloudflare OAuth", async () => {
		const { project } = await createStaticShiplet();
		const response = await request(
			`/api/shiplets/${project.id}/deployment-status`,
			{ headers: OWNER_HEADERS },
		);

		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toEqual({
			shipletId: project.id,
			managed: {
				default: true,
				owner: "shiplet",
				status: "active",
				runtime: "static",
				arbitraryWorkerExecution: {
					available: false,
					reason: "managed_dynamic_unavailable",
				},
			},
			customerCloudflare: {
				connectAvailable: false,
				reason: "cloudflare_oauth_prerequisite",
				targets: [],
			},
		});
	});

	it("does not advertise an unmediated raw dispatch namespace as managed arbitrary execution", async () => {
		const { project } = await createStaticShiplet();
		let dispatchCalls = 0;
		const rawDispatcherOnly = Object.assign({}, env, {
			dispatcher: {
				get() {
					dispatchCalls += 1;
					return {
						fetch: async () => new Response("unmediated runtime"),
					};
				},
			},
		}) as unknown as Env;
		const response = await requestWithEnv(
			`/api/shiplets/${project.id}/deployment-status`,
			{ headers: OWNER_HEADERS },
			rawDispatcherOnly,
		);

		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			managed: {
				arbitraryWorkerExecution: {
					available: false,
					reason: "managed_dynamic_unavailable",
				},
			},
		});
		expect(dispatchCalls).toBe(0);
	});

	it("advertises the exact managed runtime only to the configured operator while operator smoke is active", async () => {
		const { project } = await createStaticShiplet();
		const gateway = {
			async contract() {
				return {};
			},
			async readiness() {
				return { ok: true };
			},
			async stageRevision() {
				return {};
			},
			async promote() {
				return {};
			},
			async rollback() {
				return {};
			},
			async invoke() {
				return new Response("managed");
			},
			async invokeValidatedRevision() {
				return new Response("managed");
			},
		};
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_MANAGED_RUNTIME_READINESS: "operator_smoke",
			CLOUDFLARE_MANAGED_RUNTIME_SMOKE_USER_ID:
				OWNER_HEADERS["x-shiplet-user-id"],
			CLOUDFLARE_CONTROL_PLANE_VERSION_ID:
				"11111111-1111-4111-8111-111111111111",
			CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID:
				"22222222-2222-4222-8222-222222222222",
			CLOUDFLARE_DENY_EGRESS_VERSION_ID:
				"33333333-3333-4333-8333-333333333333",
			CLOUDFLARE_SUPPORT_RELEASE_TAG: "shiplet-operator-smoke",
			CLOUDFLARE_MANAGED_RUNTIME_RPC: gateway,
		}) as unknown as Env;

		const allowed = await requestWithEnv(
			`/api/shiplets/${project.id}/deployment-status`,
			{ headers: OWNER_HEADERS },
			runtimeEnv,
		);
		expect(await allowed.json()).toMatchObject({
			managed: { arbitraryWorkerExecution: { available: true } },
		});

		const wrongOperatorRuntime = Object.assign({}, runtimeEnv, {
			CLOUDFLARE_MANAGED_RUNTIME_SMOKE_USER_ID: "user_other_operator",
		}) as unknown as Env;
		const denied = await requestWithEnv(
			`/api/shiplets/${project.id}/deployment-status`,
			{ headers: OWNER_HEADERS },
			wrongOperatorRuntime,
		);
		expect(await denied.json()).toMatchObject({
			managed: {
				arbitraryWorkerExecution: {
					available: false,
					reason: "managed_dynamic_unavailable",
				},
			},
		});
	});

	it("denies sibling status guesses and fails Cloudflare connect closed without a configured OAuth control plane", async () => {
		const { project } = await createStaticShiplet();
		const outsider = {
			"x-shiplet-user-id": "user_deployment_status_outsider",
			"x-shiplet-user-email": "deployment-status-outsider@example.com",
		};
		const denied = await request(
			`/api/shiplets/${project.id}/deployment-status`,
			{ headers: outsider },
		);
		expect(denied.status).toBe(403);

		const connect = await request("/api/cloudflare/oauth/start", {
			method: "POST",
			headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
			body: JSON.stringify({ shipletId: project.id }),
		});
		expect(connect.status).toBe(503);
		expect(await connect.json()).toEqual({
			ok: false,
			code: "cloudflare_oauth_prerequisite",
		});
	});

	it("begins a scoped customer Cloudflare connection through a trusted control-plane binding", async () => {
		const { project } = await createStaticShiplet();
		const beginCalls: Array<Record<string, unknown>> = [];
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_OAUTH_READINESS: "enabled",
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin(input: Record<string, unknown>) {
					beginCalls.push(structuredClone(input));
					return {
						ok: true as const,
						authorizationUrl: "https://dash.cloudflare.com/oauth2/auth",
					};
				},
				async finalize() {
					return { ok: false as const, reason: "not_used" };
				},
				async acknowledge() {
					return { ok: false as const, reason: "not_used" };
				},
				async revoke() {
					return { ok: false as const, reason: "not_used" };
				},
			},
		}) as unknown as Env;

		const status = await requestWithEnv(
			`/api/shiplets/${project.id}/deployment-status`,
			{ headers: OWNER_HEADERS },
			runtimeEnv,
		);
		expect(status.status, await status.clone().text()).toBe(200);
		expect(await status.json()).toMatchObject({
			customerCloudflare: {
				connectAvailable: true,
				reason: null,
			},
		});

		const connect = await requestWithEnv(
			"/api/cloudflare/oauth/start",
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
				body: JSON.stringify({ shipletId: project.id }),
			},
			runtimeEnv,
		);
		expect(connect.status, await connect.clone().text()).toBe(200);
		expect(await connect.json()).toEqual({
			ok: true,
			authorizationUrl: "https://dash.cloudflare.com/oauth2/auth",
		});
		expect(beginCalls).toHaveLength(1);
		expect(beginCalls[0]).toMatchObject({
			actor: {
				kind: "human",
				id: OWNER_HEADERS["x-shiplet-user-id"],
			},
			shipletId: project.id,
			requestedScopes: [
				"workers.scripts.read",
				"workers.scripts.write",
			],
		});
		expect(beginCalls[0]?.sessionBinding).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(beginCalls)).not.toContain("credential");
	});

	it("keeps OAuth dark when the service binding exists without provider-proof readiness", async () => {
		const { project } = await createStaticShiplet();
		let beginCalls = 0;
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin() {
					beginCalls += 1;
					return {
						ok: true as const,
						authorizationUrl: "https://dash.cloudflare.com/oauth2/auth",
					};
				},
				async finalize() {
					return { ok: false as const, reason: "not_used" };
				},
				async acknowledge() {
					return { ok: false as const, reason: "not_used" };
				},
				async revoke() {
					return { ok: false as const, reason: "not_used" };
				},
			},
		}) as unknown as Env;

		const status = await requestWithEnv(
			`/api/shiplets/${project.id}/deployment-status`,
			{ headers: OWNER_HEADERS },
			runtimeEnv,
		);
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({
			customerCloudflare: {
				connectAvailable: false,
				reason: "cloudflare_oauth_not_verified",
			},
		});

		const connect = await requestWithEnv(
			"/api/cloudflare/oauth/start",
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
				body: JSON.stringify({ shipletId: project.id }),
			},
			runtimeEnv,
		);
		expect(connect.status).toBe(503);
		expect(await connect.json()).toEqual({
			ok: false,
			code: "cloudflare_oauth_not_verified",
		});
		expect(beginCalls).toBe(0);

		const wrongOperatorRuntime = Object.assign({}, runtimeEnv, {
			CLOUDFLARE_OAUTH_READINESS: "operator_smoke",
			CLOUDFLARE_OAUTH_SMOKE_USER_ID: "user_different_smoke_operator",
		}) as unknown as Env;
		const wrongOperatorStatus = await requestWithEnv(
			`/api/shiplets/${project.id}/deployment-status`,
			{ headers: OWNER_HEADERS },
			wrongOperatorRuntime,
		);
		expect(await wrongOperatorStatus.json()).toMatchObject({
			customerCloudflare: {
				connectAvailable: false,
				reason: "cloudflare_oauth_not_verified",
			},
		});

		const operatorRuntime = Object.assign({}, runtimeEnv, {
			CLOUDFLARE_OAUTH_READINESS: "operator_smoke",
			CLOUDFLARE_OAUTH_SMOKE_USER_ID:
				OWNER_HEADERS["x-shiplet-user-id"],
		}) as unknown as Env;
		const operatorStatus = await requestWithEnv(
			`/api/shiplets/${project.id}/deployment-status`,
			{ headers: OWNER_HEADERS },
			operatorRuntime,
		);
		expect(await operatorStatus.json()).toMatchObject({
			customerCloudflare: { connectAvailable: true, reason: null },
		});
	});

	it("shows that revoking Shiplet access disables updates while the last customer-owned deployment keeps running", async () => {
		const { project } = await createStaticShiplet();
		const packageResponse = await request(`/api/shiplets/${project.id}/package`, {
			headers: OWNER_HEADERS,
		});
		const { revision } = (await packageResponse.json()) as {
			revision: { id: string };
		};
		const store = createD1CloudflareConnectionStore({
			db: (env as Env).DB,
			now: () => 1_800_000_000_000,
		});
		const connection = await store.create({
			userId: OWNER_HEADERS["x-shiplet-user-id"],
			accountId: `account_${crypto.randomUUID()}`,
			accountLabel: "Customer account",
			scopes: ["workers.scripts.read", "workers.scripts.write"],
			credentialRef: `vault_ref_${crypto.randomUUID()}`,
			expiresAt: 1_900_000_000_000,
			generation: 1,
		});
		const targetId = `target_${crypto.randomUUID()}`;
		const deploymentId = `deployment_${crypto.randomUUID()}`;
		await (env as Env).DB.prepare(
			`INSERT INTO deployment_targets (
			 id, project_id, kind, owner_kind, owner_id, connection_id,
			 provider_account_id, configuration_json, created_on, detached_on
			) VALUES (?, ?, 'customer_cloudflare', 'human', ?, ?, ?, ?, ?, NULL)`,
		)
			.bind(
				targetId,
				project.id,
				OWNER_HEADERS["x-shiplet-user-id"],
				connection.id,
				connection.accountId,
				JSON.stringify({ internalMarker: crypto.randomUUID() }),
				new Date().toISOString(),
			)
			.run();
		await (env as Env).DB.prepare(
			`INSERT INTO shiplet_deployments (
			 id, target_id, revision_id, provider_resource_name,
			 provider_version_id, status, health_json, deployed_on,
			 failed_on, supersedes_deployment_id
			) VALUES (?, ?, ?, 'customer-worker', 'version-known-good', 'healthy',
			 '{"status":"healthy"}', ?, NULL, NULL)`,
		)
			.bind(deploymentId, targetId, revision.id, new Date().toISOString())
			.run();
		expect(
			await store.markRevoked({ id: connection.id, revokedAt: 1_800_000_000_100 }),
		).toBe(true);

		const response = await request(
			`/api/shiplets/${project.id}/deployment-status`,
			{ headers: OWNER_HEADERS },
		);
		const text = await response.text();
		expect(response.status, text).toBe(200);
		expect(text).not.toContain("internalMarker");
		expect(text).not.toContain("credential_ref");
		expect(JSON.parse(text)).toMatchObject({
			customerCloudflare: {
				targets: [
					{
						id: targetId,
						kind: "customer_cloudflare",
						ownership: "customer",
						providerAccountId: connection.accountId,
						connection: { id: connection.id, status: "revoked" },
						lastDeployment: {
							id: deploymentId,
							revisionId: revision.id,
							scriptName: "customer-worker",
							status: "healthy",
							running: true,
							updatesAvailable: false,
						},
					},
				],
			},
		});
	});
});
