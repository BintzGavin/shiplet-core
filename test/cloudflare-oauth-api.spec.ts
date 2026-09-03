import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";

const OWNER = {
	"x-shiplet-user-id": "user_cloudflare_oauth_api_owner",
	"x-shiplet-user-email": "cloudflare-oauth-api-owner@example.com",
};

async function request(
	path: string,
	init: RequestInit,
	runtimeEnv: Env = env as Env,
	origin = "http://localhost",
) {
	const context = createExecutionContext();
	const response = await app.fetch(
		new Request(`${origin}${path}`, init),
		runtimeEnv,
		context,
	);
	await waitOnExecutionContext(context);
	return response;
}

async function createShiplet() {
	const organizationResponse = await request("/api/organizations", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...OWNER },
		body: JSON.stringify({ name: `OAuth API ${crypto.randomUUID()}` }),
	});
	const { organization } = (await organizationResponse.json()) as {
		organization: { id: string };
	};
	const publishResponse = await request("/api/shiplets", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...OWNER },
		body: JSON.stringify({
			name: "OAuth API Shiplet",
			organization_id: organization.id,
			subdomain: `oauth-api-${crypto.randomUUID().slice(0, 8)}`,
			visibility: "private",
			assets: [
				{
					path: "index.html",
					content: btoa("<!doctype html><h1>OAuth target</h1>"),
				},
			],
		}),
	});
	expect(publishResponse.status).toBe(201);
	return (await publishResponse.json()) as { project: { id: string } };
}

const DEFAULT_DELIVERY_HANDLE = "D".repeat(43);

function finalizeOAuth(shipletId: string, runtimeEnv: Env) {
	return request(
		"/api/cloudflare/oauth/finalize",
		{
			method: "POST",
			headers: { "content-type": "application/json", ...OWNER },
			body: JSON.stringify({
				shipletId,
				deliveryHandle: DEFAULT_DELIVERY_HANDLE,
			}),
		},
		runtimeEnv,
	);
}

describe("Cloudflare OAuth application boundary", () => {
	it("finalizes the browser callback return and redirects to the connected Shiplet without exposing control-plane material", async () => {
		const { project } = await createShiplet();
		const connectionId = `cloudflare_connection_${crypto.randomUUID()}`;
		const accountId = `account_${crypto.randomUUID()}`;
		let finalizeCount = 0;
		let acknowledgeCount = 0;
		let deliveryHandle = "";
		let returnKey = "";
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_OAUTH_READINESS: "enabled",
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin(input: Record<string, unknown>) {
					deliveryHandle = String(input.deliveryHandle ?? "");
					returnKey = String(input.returnKey ?? "");
					expect(deliveryHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
					expect(returnKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
					return {
						ok: true as const,
						authorizationUrl:
							"https://dash.cloudflare.com/oauth2/auth?client_id=fixture",
					};
				},
				async finalize(input: Record<string, unknown>) {
					finalizeCount += 1;
					expect(input).toMatchObject({
						shipletId: project.id,
						deliveryHandle,
					});
					return {
						ok: true as const,
						shipletId: project.id,
						deliveryExpiresAt: Date.now() + 60_000,
						connection: {
							id: connectionId,
							userId: OWNER["x-shiplet-user-id"],
							accountId,
							accountLabel: "Browser callback account",
							scopes: ["workers.scripts.read", "workers.scripts.write"],
							expiresAt: Date.now() + 60_000,
							status: "active" as const,
							generation: 1,
						},
					};
				},
				async acknowledge() {
					acknowledgeCount += 1;
					return { ok: true as const };
				},
				async revoke() {
					return { ok: false as const, reason: "not_used" };
				},
			},
		}) as unknown as Env;

		const started = await request(
			"/api/cloudflare/oauth/start",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					...OWNER,
				},
				body: JSON.stringify({ shipletId: project.id }),
			},
			runtimeEnv,
			"https://shiplet.example",
		);
		expect(started.status).toBe(200);
		const flowCookie = started.headers.get("set-cookie") ?? "";
		expect(flowCookie).toContain(
			`shiplet_cloudflare_oauth_delivery_${returnKey}=`,
		);
		expect(flowCookie).toContain("HttpOnly");
		expect(flowCookie).toContain("Secure");
		expect(flowCookie).toContain("SameSite=Lax");
		expect(await started.text()).not.toContain(deliveryHandle);

		const missingCookie = await request(
			`/api/cloudflare/oauth/return?status=connected&shipletId=${project.id}&flow=${returnKey}`,
			{ method: "GET", headers: OWNER },
			runtimeEnv,
			"https://shiplet.example",
		);
		expect(missingCookie.status).toBe(400);
		expect(finalizeCount).toBe(0);

		const crossSitePost = await request(
			"/api/cloudflare/oauth/return",
			{
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					cookie: flowCookie.split(";", 1)[0],
					...OWNER,
				},
				body: new URLSearchParams({
					shipletId: project.id,
					deliveryHandle,
				}).toString(),
			},
			runtimeEnv,
			"https://shiplet.example",
		);
		expect([400, 403]).toContain(crossSitePost.status);
		expect(finalizeCount).toBe(0);

		const response = await request(
			`/api/cloudflare/oauth/return?status=connected&shipletId=${project.id}&flow=${returnKey}`,
			{
				method: "GET",
				headers: {
					cookie: flowCookie.split(";", 1)[0],
					...OWNER,
				},
			},
			runtimeEnv,
			"https://shiplet.example",
		);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(
			`/shiplets/${project.id}/ownership?cloudflare=connected`,
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
		expect(finalizeCount).toBe(1);
		expect(acknowledgeCount).toBe(1);
		expect(
			await (env as Env).DB.prepare(
				"SELECT id FROM cloudflare_connections WHERE id = ?",
			)
				.bind(connectionId)
				.first(),
		).toEqual({ id: connectionId });
	});

	it("keeps concurrent connect cookies isolated even for the same Shiplet", async () => {
		const { project } = await createShiplet();
		const returnKeys: string[] = [];
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_OAUTH_READINESS: "enabled",
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin(input: Record<string, unknown>) {
					returnKeys.push(String(input.returnKey ?? ""));
					return {
						ok: true as const,
						authorizationUrl:
							"https://dash.cloudflare.com/oauth2/auth?client_id=fixture",
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
		const start = () =>
			request(
				"/api/cloudflare/oauth/start",
				{
					method: "POST",
					headers: { "content-type": "application/json", ...OWNER },
					body: JSON.stringify({ shipletId: project.id }),
				},
				runtimeEnv,
				"https://shiplet.example",
			);

		const [first, second] = await Promise.all([start(), start()]);
		expect(returnKeys).toHaveLength(2);
		expect(returnKeys[0]).not.toBe(returnKeys[1]);
		expect(first.headers.get("set-cookie")).toContain(
			`shiplet_cloudflare_oauth_delivery_${returnKeys[0]}=`,
		);
		expect(second.headers.get("set-cookie")).toContain(
			`shiplet_cloudflare_oauth_delivery_${returnKeys[1]}=`,
		);
	});

	it("retries a lost ACK response without duplicating local connection, target, or audit state", async () => {
		const { project } = await createShiplet();
		const connectionId = `cloudflare_connection_${crypto.randomUUID()}`;
		const accountId = `account_${crypto.randomUUID()}`;
		const deliveryHandle = "R".repeat(43);
		const expiresAt = Date.now() + 60_000;
		let finalizeCount = 0;
		let acknowledgeCount = 0;
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_OAUTH_READINESS: "enabled",
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin() {
					return { ok: false as const, reason: "not_used" };
				},
				async finalize(input: Record<string, unknown>) {
					finalizeCount += 1;
					expect(input).toMatchObject({
						shipletId: project.id,
						deliveryHandle,
					});
					return {
						ok: true as const,
						shipletId: project.id,
						deliveryExpiresAt: expiresAt,
						connection: {
							id: connectionId,
							userId: OWNER["x-shiplet-user-id"],
							accountId,
							accountLabel: "Replay account",
							scopes: ["workers.scripts.read", "workers.scripts.write"],
							expiresAt,
							status: "active" as const,
							generation: 1,
						},
					};
				},
				async acknowledge() {
					acknowledgeCount += 1;
					const persisted = await (env as Env).DB.prepare(
						"SELECT id FROM deployment_targets WHERE project_id = ? AND connection_id = ?",
					)
						.bind(project.id, connectionId)
						.first();
					expect(persisted).not.toBeNull();
					if (acknowledgeCount === 1) throw new Error("ack response lost");
					return { ok: true as const };
				},
				async revoke() {
					return { ok: false as const, reason: "not_used" };
				},
			},
		}) as unknown as Env;
		const finalize = () =>
			request(
				"/api/cloudflare/oauth/finalize",
				{
					method: "POST",
					headers: { "content-type": "application/json", ...OWNER },
					body: JSON.stringify({ shipletId: project.id, deliveryHandle }),
				},
				runtimeEnv,
			);

		const ambiguous = await finalize();
		expect(ambiguous.status).toBe(503);
		expect(await ambiguous.json()).toEqual({
			ok: false,
			code: "cloudflare_oauth_ack_pending",
		});
		expect(
			await (env as Env).DB.prepare(
				`SELECT connection_id, project_id, user_id, delivery_expires_at
				 FROM cloudflare_oauth_ack_outbox WHERE connection_id = ?`,
			)
				.bind(connectionId)
				.first(),
		).toMatchObject({
			connection_id: connectionId,
			project_id: project.id,
			user_id: OWNER["x-shiplet-user-id"],
			delivery_expires_at: expect.any(Number),
		});
		const pendingStatus = await request(
			`/api/shiplets/${project.id}/deployment-status`,
			{ method: "GET", headers: OWNER },
			runtimeEnv,
		);
		expect(await pendingStatus.json()).toMatchObject({
			customerCloudflare: {
				targets: [
					expect.objectContaining({
						connection: { id: connectionId, status: "pending" },
					}),
				],
			},
		});
		const recovered = await finalize();
		expect(recovered.status, await recovered.clone().text()).toBe(201);
		expect(finalizeCount).toBe(2);
		expect(acknowledgeCount).toBe(2);
		expect(
			await (env as Env).DB.prepare(
				"SELECT COUNT(*) AS count FROM deployment_targets WHERE project_id = ? AND connection_id = ?",
			)
				.bind(project.id, connectionId)
				.first(),
		).toEqual({ count: 1 });
		expect(
			await (env as Env).DB.prepare(
				"SELECT COUNT(*) AS count FROM shiplet_audit_events WHERE project_id = ? AND event_kind = 'cloudflare.connection.created'",
			)
				.bind(project.id)
				.first(),
		).toEqual({ count: 1 });
		expect(
			await (env as Env).DB.prepare(
				"SELECT connection_id FROM cloudflare_oauth_ack_outbox WHERE connection_id = ?",
			)
				.bind(connectionId)
				.first(),
		).toBeNull();
	});

	it("reconciles a durable ACK after the browser never retries the callback", async () => {
		// Given Shiplet committed the local target but the support ACK response was
		// lost, when the scheduled kernel job runs, then it finishes the exact ACK
		// and only then exposes the connection as active.
		const { project } = await createShiplet();
		const connectionId = `cloudflare_connection_${crypto.randomUUID()}`;
		const accountId = `account_${crypto.randomUUID()}`;
		const deliveryHandle = "S".repeat(43);
		let failAcknowledgement = true;
		let acknowledgeCount = 0;
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_OAUTH_READINESS: "enabled",
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin() {
					return { ok: false as const, reason: "not_used" };
				},
				async finalize() {
					return {
						ok: true as const,
						shipletId: project.id,
						deliveryExpiresAt: Date.now() + 60_000,
						connection: {
							id: connectionId,
							userId: OWNER["x-shiplet-user-id"],
							accountId,
							accountLabel: "Scheduled ACK account",
							scopes: ["workers.scripts.read", "workers.scripts.write"],
							expiresAt: Date.now() + 60_000,
							status: "active" as const,
							generation: 1,
						},
					};
				},
				async acknowledge() {
					acknowledgeCount += 1;
					if (failAcknowledgement) throw new Error("fixture_response_lost");
					return { ok: true as const };
				},
				async revoke() {
					return { ok: false as const, reason: "not_used" };
				},
			},
		}) as unknown as Env;

		const ambiguous = await request(
			"/api/cloudflare/oauth/finalize",
			{
				method: "POST",
				headers: { "content-type": "application/json", ...OWNER },
				body: JSON.stringify({ shipletId: project.id, deliveryHandle }),
			},
			runtimeEnv,
		);
		expect(ambiguous.status).toBe(503);
		failAcknowledgement = false;
		const context = createExecutionContext();
		await (
			app as unknown as {
				scheduled(
					controller: ScheduledController,
					environment: Env,
					context: ExecutionContext,
				): Promise<void>;
			}
		).scheduled(
			{ cron: "*/5 * * * *", scheduledTime: Date.now() } as ScheduledController,
			runtimeEnv,
			context,
		);
		await waitOnExecutionContext(context);

		expect(acknowledgeCount).toBe(2);
		expect(
			await (env as Env).DB.prepare(
				"SELECT connection_id FROM cloudflare_oauth_ack_outbox WHERE connection_id = ?",
			)
				.bind(connectionId)
				.first(),
		).toBeNull();
		const statusResponse = await request(
			`/api/shiplets/${project.id}/deployment-status`,
			{ method: "GET", headers: OWNER },
			runtimeEnv,
		);
		expect(await statusResponse.json()).toMatchObject({
			customerCloudflare: {
				targets: [
					expect.objectContaining({
						connection: { id: connectionId, status: "active" },
					}),
				],
			},
		});
	});

	it("revokes an expired unacknowledged connection before clearing pending state", async () => {
		const { project } = await createShiplet();
		const connectionId = `cloudflare_connection_${crypto.randomUUID()}`;
		const accountId = `account_${crypto.randomUUID()}`;
		const deliveryHandle = "E".repeat(43);
		let revokeCount = 0;
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_OAUTH_READINESS: "enabled",
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin() {
					return { ok: false as const, reason: "not_used" };
				},
				async finalize() {
					return {
						ok: true as const,
						shipletId: project.id,
						deliveryExpiresAt: Date.now() + 60_000,
						connection: {
							id: connectionId,
							userId: OWNER["x-shiplet-user-id"],
							accountId,
							accountLabel: "Expired ACK account",
							scopes: ["workers.scripts.read", "workers.scripts.write"],
							expiresAt: Date.now() + 120_000,
							status: "active" as const,
							generation: 1,
						},
					};
				},
				async acknowledge() {
					throw new Error("fixture_ack_unavailable");
				},
				async revoke() {
					revokeCount += 1;
					return {
						ok: true as const,
						connection: { status: "revoked" as const },
					};
				},
			},
		}) as unknown as Env;

		expect(
			(
				await request(
					"/api/cloudflare/oauth/finalize",
					{
						method: "POST",
						headers: { "content-type": "application/json", ...OWNER },
						body: JSON.stringify({ shipletId: project.id, deliveryHandle }),
					},
					runtimeEnv,
				)
			).status,
		).toBe(503);
		await (env as Env).DB.prepare(
			"UPDATE cloudflare_oauth_ack_outbox SET delivery_expires_at = ? WHERE connection_id = ?",
		)
			.bind(Date.now() - 1, connectionId)
			.run();
		const context = createExecutionContext();
		await (
			app as unknown as {
				scheduled(
					controller: ScheduledController,
					environment: Env,
					context: ExecutionContext,
				): Promise<void>;
			}
		).scheduled(
			{ cron: "*/5 * * * *", scheduledTime: Date.now() } as ScheduledController,
			runtimeEnv,
			context,
		);
		await waitOnExecutionContext(context);

		expect(revokeCount).toBe(1);
		expect(
			await (env as Env).DB.prepare(
				"SELECT status FROM cloudflare_connections WHERE id = ?",
			)
				.bind(connectionId)
				.first(),
		).toEqual({ status: "revoked" });
		expect(
			await (env as Env).DB.prepare(
				"SELECT detached_on FROM deployment_targets WHERE connection_id = ?",
			)
				.bind(connectionId)
				.first(),
		).toEqual({ detached_on: expect.any(String) });
		expect(
			await (env as Env).DB.prepare(
				"SELECT connection_id FROM cloudflare_oauth_ack_outbox WHERE connection_id = ?",
			)
				.bind(connectionId)
				.first(),
		).toBeNull();
		expect(
			await (env as Env).DB.prepare(
				`SELECT COUNT(*) AS count FROM shiplet_audit_events
				 WHERE project_id = ? AND event_kind = 'cloudflare.connection.delivery_expired'`,
			)
				.bind(project.id)
				.first(),
		).toEqual({ count: 1 });
	});

	it("commits concurrent retries of one OAuth delivery without revoking the winner", async () => {
		const { project } = await createShiplet();
		const connectionId = `cloudflare_connection_${crypto.randomUUID()}`;
		const accountId = `account_${crypto.randomUUID()}`;
		const deliveryHandle = "C".repeat(43);
		const expiresAt = Date.now() + 60_000;
		const realDb = (env as Env).DB;
		let targetReadArrivals = 0;
		let releaseTargetReads: (() => void) | undefined;
		const targetReadsReady = new Promise<void>((resolve) => {
			releaseTargetReads = resolve;
		});
		const concurrentDb = new Proxy(realDb, {
			get(target, property) {
				if (property === "prepare") {
					return (query: string) => {
						const waitsForPeer = query.includes(
							"FROM deployment_targets WHERE id = ?",
						);
						const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
							new Proxy(statement, {
								get(statementTarget, statementProperty) {
									if (statementProperty === "bind") {
										return (...values: unknown[]) =>
											wrap(statementTarget.bind(...values));
									}
									if (statementProperty === "first" && waitsForPeer) {
										return async <T>() => {
											targetReadArrivals += 1;
											if (targetReadArrivals === 2) releaseTargetReads?.();
											await targetReadsReady;
											return statementTarget.first<T>();
										};
									}
									const value = Reflect.get(
										statementTarget,
										statementProperty,
										statementTarget,
									);
									return typeof value === "function"
										? value.bind(statementTarget)
										: value;
								},
							});
						return wrap(target.prepare(query));
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		let acknowledgeCount = 0;
		let revokeCount = 0;
		const runtimeEnv = Object.assign({}, env, {
			DB: concurrentDb,
			CLOUDFLARE_OAUTH_READINESS: "enabled",
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin() {
					return { ok: false as const, reason: "not_used" };
				},
				async finalize() {
					return {
						ok: true as const,
						shipletId: project.id,
						deliveryExpiresAt: expiresAt,
						connection: {
							id: connectionId,
							userId: OWNER["x-shiplet-user-id"],
							accountId,
							accountLabel: "Concurrent retry account",
							scopes: ["workers.scripts.read", "workers.scripts.write"],
							expiresAt,
							status: "active" as const,
							generation: 1,
						},
					};
				},
				async acknowledge() {
					acknowledgeCount += 1;
					return { ok: true as const };
				},
				async revoke() {
					revokeCount += 1;
					return { ok: true as const };
				},
			},
		}) as unknown as Env;
		const finalize = () =>
			request(
				"/api/cloudflare/oauth/finalize",
				{
					method: "POST",
					headers: { "content-type": "application/json", ...OWNER },
					body: JSON.stringify({ shipletId: project.id, deliveryHandle }),
				},
				runtimeEnv,
			);

		const responses = await Promise.all([finalize(), finalize()]);
		expect(responses.map((response) => response.status).sort()).toEqual([
			201,
			201,
		]);
		expect(targetReadArrivals).toBeGreaterThanOrEqual(2);
		expect(acknowledgeCount).toBe(2);
		expect(revokeCount).toBe(0);
		expect(
			await realDb
				.prepare(
					"SELECT COUNT(*) AS count FROM deployment_targets WHERE project_id = ? AND connection_id = ?",
				)
				.bind(project.id, connectionId)
				.first(),
		).toEqual({ count: 1 });
		expect(
			await realDb
				.prepare(
					"SELECT COUNT(*) AS count FROM shiplet_audit_events WHERE project_id = ? AND event_kind = 'cloudflare.connection.created'",
				)
				.bind(project.id)
				.first(),
		).toEqual({ count: 1 });
	});

	it("fails a denied browser callback closed without invoking finalization", async () => {
		let finalizeCount = 0;
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_OAUTH_READINESS: "enabled",
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin() {
					return { ok: false as const, reason: "not_used" };
				},
				async finalize() {
					finalizeCount += 1;
					return { ok: false as const, reason: "must_not_run" };
				},
			},
		}) as unknown as Env;
		const response = await request(
			"/api/cloudflare/oauth/return?status=denied",
			{ method: "GET", headers: OWNER },
			runtimeEnv,
		);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(
			"/dashboard?cloudflare=denied",
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(finalizeCount).toBe(0);
	});

	it("finalizes a same-session control-plane result into public metadata and one isolated target", async () => {
		const { project } = await createShiplet();
		const connectionId = `cloudflare_connection_${crypto.randomUUID()}`;
		const accountId = `account_${crypto.randomUUID()}`;
		const finalizeCalls: Array<Record<string, unknown>> = [];
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_OAUTH_READINESS: "enabled",
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin() {
					return { ok: false as const, reason: "not_used" };
				},
				async finalize(input: Record<string, unknown>) {
					finalizeCalls.push(structuredClone(input));
					return {
						ok: true as const,
						shipletId: project.id,
						deliveryExpiresAt: Date.now() + 60_000,
						connection: {
							id: connectionId,
							userId: OWNER["x-shiplet-user-id"],
							accountId,
							accountLabel: "Customer account",
							scopes: ["workers.scripts.read", "workers.scripts.write"],
							expiresAt: Date.now() + 60_000,
							status: "active" as const,
							generation: 1,
						},
					};
				},
				async acknowledge() {
					return { ok: true as const };
				},
				async revoke() {
					return { ok: false as const, reason: "not_used" };
				},
			},
		}) as unknown as Env;

		const response = await finalizeOAuth(project.id, runtimeEnv);
		expect(response.status, await response.clone().text()).toBe(201);
		const text = await response.text();
		expect(text).not.toMatch(
			/(authorization|credential_ref|oauth_state|refresh_token)/i,
		);
		const payload = JSON.parse(text) as {
			connection: Record<string, unknown>;
			target: Record<string, unknown>;
		};
		expect(payload.connection).toMatchObject({
			id: connectionId,
			accountId,
			status: "active",
		});
		expect(payload.target).toMatchObject({
			shipletId: project.id,
			kind: "customer_cloudflare",
			connectionId,
			providerAccountId: accountId,
		});
		expect(payload.target.scriptName).toMatch(/^shiplet-[a-f0-9]{32}$/);
		expect(finalizeCalls).toHaveLength(1);
		expect(finalizeCalls[0]).toMatchObject({
			actor: { kind: "human", id: OWNER["x-shiplet-user-id"] },
			shipletId: project.id,
			deliveryHandle: DEFAULT_DELIVERY_HANDLE,
		});
		expect(finalizeCalls[0]?.sessionBinding).toMatch(/^[a-f0-9]{64}$/);

		const row = await (env as Env).DB.prepare(
			`SELECT project_id, owner_id, connection_id, provider_account_id,
			 configuration_json FROM deployment_targets WHERE id = ?`,
		)
			.bind(payload.target.id)
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			project_id: project.id,
			owner_id: OWNER["x-shiplet-user-id"],
			connection_id: connectionId,
			provider_account_id: accountId,
		});
		expect(String(row?.configuration_json)).not.toContain(project.id);
	});

	it("rejects a cross-user finalization result without creating connection state", async () => {
		const { project } = await createShiplet();
		const connectionId = `cloudflare_connection_${crypto.randomUUID()}`;
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_OAUTH_READINESS: "enabled",
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin() {
					return { ok: false as const, reason: "not_used" };
				},
				async finalize() {
					return {
						ok: true as const,
						shipletId: project.id,
						deliveryExpiresAt: Date.now() + 60_000,
						connection: {
							id: connectionId,
							userId: "user_cloudflare_oauth_api_other",
							accountId: `account_${crypto.randomUUID()}`,
							accountLabel: "Wrong user account",
							scopes: ["workers.scripts.read", "workers.scripts.write"],
							expiresAt: Date.now() + 60_000,
							status: "active" as const,
							generation: 1,
						},
					};
				},
				async acknowledge() {
					return { ok: true as const };
				},
				async revoke() {
					return { ok: false as const, reason: "not_used" };
				},
			},
		}) as unknown as Env;
		const response = await finalizeOAuth(project.id, runtimeEnv);
		expect(response.status).toBe(403);
		expect(
			await (env as Env).DB.prepare(
				"SELECT id FROM cloudflare_connections WHERE id = ?",
			)
				.bind(connectionId)
				.first(),
		).toBeNull();
	});

	it("revokes a finalized provider connection when local target persistence fails", async () => {
		const { project } = await createShiplet();
		const connectionId = `cloudflare_connection_${crypto.randomUUID()}`;
		const revokeCalls: Array<Record<string, unknown>> = [];
		let providerFinalized = false;
		const realDb = (env as Env).DB;
		const failingDb = new Proxy(realDb, {
			get(target, property) {
				if (property === "batch") {
					return async (statements: D1PreparedStatement[]) => {
					if (providerFinalized) {
							throw new Error("fixture_batch_failure");
						}
						return target.batch(statements);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const runtimeEnv = Object.assign({}, env, {
			DB: failingDb,
			CLOUDFLARE_OAUTH_READINESS: "enabled",
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin() {
					return { ok: false as const, reason: "not_used" };
				},
				async finalize() {
					providerFinalized = true;
					return {
						ok: true as const,
						shipletId: project.id,
						deliveryExpiresAt: Date.now() + 60_000,
						connection: {
							id: connectionId,
							userId: OWNER["x-shiplet-user-id"],
							accountId: `account_${crypto.randomUUID()}`,
							accountLabel: "Compensation fixture",
							scopes: ["workers.scripts.read", "workers.scripts.write"],
							expiresAt: Date.now() + 60_000,
							status: "active" as const,
							generation: 1,
						},
					};
				},
				async acknowledge() {
					return { ok: true as const };
				},
				async revoke(input: Record<string, unknown>) {
					revokeCalls.push(structuredClone(input));
					return {
						ok: true as const,
						connection: {
							id: connectionId,
							userId: OWNER["x-shiplet-user-id"],
							accountId: "account_compensated",
							status: "revoked" as const,
							generation: 2,
						},
					};
				},
			},
		}) as unknown as Env;

		const response = await finalizeOAuth(project.id, runtimeEnv);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			code: "cloudflare_connection_conflict",
		});
		expect(revokeCalls).toHaveLength(1);
		expect(revokeCalls[0]).toMatchObject({
			actor: { kind: "human", id: OWNER["x-shiplet-user-id"] },
			connectionId,
		});
		expect(revokeCalls[0]?.sessionBinding).toMatch(/^[a-f0-9]{64}$/);
	});

	it.each(["returns_failure", "throws"] as const)(
		"reports compensation pending when control-plane revocation %s",
		async (revokeMode) => {
			const { project } = await createShiplet();
			const connectionId = `cloudflare_connection_${crypto.randomUUID()}`;
			let providerFinalized = false;
			let revokeCalls = 0;
			const realDb = (env as Env).DB;
			const failingDb = new Proxy(realDb, {
				get(target, property) {
					if (property === "batch") {
						return async (statements: D1PreparedStatement[]) => {
							if (providerFinalized) throw new Error("fixture_batch_failure");
							return target.batch(statements);
						};
					}
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const runtimeEnv = Object.assign({}, env, {
				DB: failingDb,
				CLOUDFLARE_OAUTH_READINESS: "enabled",
				CLOUDFLARE_OAUTH_CONTROL_PLANE: {
					async begin() {
						return { ok: false as const, reason: "not_used" };
					},
					async finalize() {
						providerFinalized = true;
						return {
							ok: true as const,
							shipletId: project.id,
							deliveryExpiresAt: Date.now() + 60_000,
							connection: {
								id: connectionId,
								userId: OWNER["x-shiplet-user-id"],
								accountId: `account_${crypto.randomUUID()}`,
								accountLabel: "Pending compensation fixture",
								scopes: ["workers.scripts.read", "workers.scripts.write"],
								expiresAt: Date.now() + 60_000,
								status: "active" as const,
								generation: 1,
							},
						};
					},
					async acknowledge() {
						return { ok: true as const };
					},
					async revoke() {
						revokeCalls += 1;
						if (revokeMode === "throws") {
							throw new Error("fixture_control_plane_unavailable");
						}
						return {
							ok: false as const,
							reason: "provider_revocation_failed",
						};
					},
				},
			}) as unknown as Env;

			const response = await finalizeOAuth(project.id, runtimeEnv);
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				ok: false,
				code: "cloudflare_connection_compensation_pending",
			});
			expect(revokeCalls).toBe(1);
		},
	);

	it("compensates when the first local project read fails after remote finalization", async () => {
		const { project } = await createShiplet();
		const connectionId = `cloudflare_connection_${crypto.randomUUID()}`;
		let providerFinalized = false;
		let revokeCalls = 0;
		const realDb = (env as Env).DB;
		const failingDb = new Proxy(realDb, {
			get(target, property) {
				if (property === "prepare") {
					return (...args: Parameters<D1Database["prepare"]>) => {
						if (providerFinalized) throw new Error("fixture_project_read_failure");
						return target.prepare(...args);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const runtimeEnv = Object.assign({}, env, {
			DB: failingDb,
			CLOUDFLARE_OAUTH_READINESS: "enabled",
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin() {
					return { ok: false as const, reason: "not_used" };
				},
				async finalize() {
					providerFinalized = true;
					return {
						ok: true as const,
						shipletId: project.id,
						deliveryExpiresAt: Date.now() + 60_000,
						connection: {
							id: connectionId,
							userId: OWNER["x-shiplet-user-id"],
							accountId: `account_${crypto.randomUUID()}`,
							accountLabel: "Project read compensation fixture",
							scopes: ["workers.scripts.read", "workers.scripts.write"],
							expiresAt: Date.now() + 60_000,
							status: "active" as const,
							generation: 1,
						},
					};
				},
				async acknowledge() {
					return { ok: true as const };
				},
				async revoke() {
					revokeCalls += 1;
					return { ok: false as const, reason: "provider_revocation_failed" };
				},
			},
		}) as unknown as Env;

		const response = await finalizeOAuth(project.id, runtimeEnv);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			ok: false,
			code: "cloudflare_connection_compensation_pending",
		});
		expect(revokeCalls).toBe(1);
	});

	it("revokes future Shiplet access while leaving the last customer deployment running", async () => {
		const { project } = await createShiplet();
		const packageResponse = await request(`/api/shiplets/${project.id}/package`, {
			method: "GET",
			headers: OWNER,
		});
		const packagePayload = (await packageResponse.json()) as {
			revision: { id: string };
		};
		const connectionId = `cloudflare_connection_${crypto.randomUUID()}`;
		const targetId = `target_${crypto.randomUUID()}`;
		const accountId = `account_${crypto.randomUUID()}`;
		const now = new Date().toISOString();
		await (env as Env).DB.batch([
			(env as Env).DB.prepare(
				`INSERT INTO cloudflare_connections (
				 id, user_id, account_id, account_label, scopes_json, credential_ref,
				 expires_at, status, revoked_at, generation, created_on, refreshed_at
				) VALUES (?, ?, ?, 'Revocation account', ?, ?, ?, 'active', NULL, 1, ?, NULL)`,
			).bind(
				connectionId,
				OWNER["x-shiplet-user-id"],
				accountId,
				JSON.stringify(["workers.scripts.read", "workers.scripts.write"]),
				`credential_ref_${crypto.randomUUID()}`,
				Date.now() + 60_000,
				now,
			),
			(env as Env).DB.prepare(
				`INSERT INTO deployment_targets (
				 id, project_id, kind, owner_kind, owner_id, connection_id,
				 provider_account_id, configuration_json, created_on, detached_on
				) VALUES (?, ?, 'customer_cloudflare', 'human', ?, ?, ?, ?, ?, NULL)`,
			).bind(
				targetId,
				project.id,
				OWNER["x-shiplet-user-id"],
				connectionId,
				accountId,
				JSON.stringify({
					scriptName: `shiplet-${crypto.randomUUID()}`,
					status: "connected",
					resourceBindingRefs: [],
				}),
				now,
			),
			(env as Env).DB.prepare(
				`INSERT INTO shiplet_deployments (
				 id, target_id, revision_id, provider_resource_name,
				 provider_version_id, status, health_json, deployed_on, failed_on,
				 supersedes_deployment_id
				) VALUES (?, ?, ?, 'shiplet-opaque', 'version-known-good', 'healthy',
				 '{}', ?, NULL, NULL)`,
			).bind(
				`deployment_${crypto.randomUUID()}`,
				targetId,
				packagePayload.revision.id,
				now,
			),
		]);
		const revokeCalls: Array<Record<string, unknown>> = [];
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_OAUTH_CONTROL_PLANE: {
				async begin() {
					return { ok: false as const, reason: "not_used" };
				},
				async finalize() {
					return { ok: false as const, reason: "not_used" };
				},
				async acknowledge() {
					return { ok: false as const, reason: "not_used" };
				},
				async revoke(input: Record<string, unknown>) {
					revokeCalls.push(structuredClone(input));
					return {
						ok: true as const,
						connection: {
							id: connectionId,
							userId: OWNER["x-shiplet-user-id"],
							accountId,
							status: "revoked" as const,
							generation: 2,
						},
					};
				},
			},
		}) as unknown as Env;
		const response = await request(
			`/api/cloudflare/connections/${connectionId}`,
			{
				method: "DELETE",
				headers: { "Content-Type": "application/json", ...OWNER },
				body: JSON.stringify({ shipletId: project.id, approval: true }),
			},
			runtimeEnv,
		);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			connection: { id: connectionId, status: "revoked" },
			lastDeploymentContinues: true,
		});
		expect(revokeCalls).toHaveLength(1);
		expect(revokeCalls[0]).toMatchObject({
			actor: { kind: "human", id: OWNER["x-shiplet-user-id"] },
			connectionId,
		});
		expect(revokeCalls[0]?.sessionBinding).toMatch(/^[a-f0-9]{64}$/);
		const statusResponse = await request(
			`/api/shiplets/${project.id}/deployment-status`,
			{ method: "GET", headers: OWNER },
			runtimeEnv,
		);
		const status = (await statusResponse.json()) as {
			customerCloudflare: { targets: Array<Record<string, unknown>> };
		};
		expect(status.customerCloudflare.targets[0]).toMatchObject({
			id: targetId,
			detached: true,
			connection: { id: connectionId, status: "revoked" },
			lastDeployment: {
				status: "healthy",
				running: true,
				updatesAvailable: false,
			},
		});
	});
});
