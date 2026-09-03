import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import {
	parseCloudflareJsonBytesBounded,
	type CloudflareRedactingFetch,
} from "../src/cloudflare-production-adapters";
import type { CloudflareDeploymentRuntimeBindings } from "../src/cloudflare-runtime-composition";
import type {
	CloudflareDeploymentProvider,
	TemporaryClaimVault,
} from "../src/deployment-orchestrator";
import { digestShipletPackage } from "../src/self-owned/package";
import {
	SUPPORT_RUNTIME_VERSION,
	supportAttestationBindings,
	supportContract,
} from "./helpers/cloudflare-support-runtime";

type DeploymentTestEnv = Env &
	CloudflareDeploymentRuntimeBindings & {
		CLOUDFLARE_CLAIM_VAULT?: TemporaryClaimVault;
	};

const OWNER = {
	"x-shiplet-user-id": "user_deployment_api_owner",
	"x-shiplet-user-email": "deployment-api-owner@example.com",
};

async function request(
	path: string,
	init: RequestInit = {},
	runtimeEnv: DeploymentTestEnv = env as DeploymentTestEnv,
) {
	const context = createExecutionContext();
	const response = await app.fetch(
		new Request(`http://localhost${path}`, init),
		runtimeEnv,
		context,
	);
	await waitOnExecutionContext(context);
	return response;
}

async function fixture(options: { connected?: boolean } = {}) {
	const organizationResponse = await request("/api/organizations", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...OWNER },
		body: JSON.stringify({ name: `Deployment API ${crypto.randomUUID()}` }),
	});
	const { organization } = (await organizationResponse.json()) as {
		organization: { id: string };
	};
	const publishResponse = await request("/api/shiplets", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...OWNER },
		body: JSON.stringify({
			name: "Deployment API Shiplet",
			organization_id: organization.id,
			subdomain: `deployment-api-${crypto.randomUUID().slice(0, 8)}`,
			visibility: "private",
			assets: [
				{
					path: "index.html",
					content: btoa("<!doctype html><h1>deployment</h1>"),
				},
			],
		}),
	});
	const { project } = (await publishResponse.json()) as {
		project: { id: string };
	};
	const packageResponse = await request(`/api/shiplets/${project.id}/package`, {
		headers: OWNER,
	});
	const { package: packageEnvelope, revision } =
		(await packageResponse.json()) as {
			package: Record<string, any>;
			revision: { id: string };
		};
	const targetId = `target_${crypto.randomUUID()}`;
	const accountId = crypto.randomUUID().replaceAll("-", "");
	const scriptName = `shiplet-${crypto.randomUUID()}`;
	const connectionId = options.connected
		? `connection_${crypto.randomUUID()}`
		: null;
	if (connectionId) {
		await (env as Env).DB.prepare(
			`INSERT INTO cloudflare_connections (
			 id, user_id, account_id, account_label, scopes_json, credential_ref,
			 expires_at, status, revoked_at, generation, created_on, refreshed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, NULL)`,
		)
			.bind(
				connectionId,
				OWNER["x-shiplet-user-id"],
				accountId,
				"Deployment test account",
				JSON.stringify(["workers.scripts.read", "workers.scripts.write"]),
				`credential_ref_${crypto.randomUUID()}`,
				Date.now() + 60_000,
				new Date().toISOString(),
			)
			.run();
	}
	await (env as Env).DB.prepare(
		`INSERT INTO deployment_targets (
		 id, project_id, kind, owner_kind, owner_id, connection_id,
		 provider_account_id, configuration_json, created_on, detached_on
		) VALUES (?, ?, 'customer_cloudflare', 'human', ?, ?, ?, ?, ?, NULL)`,
	)
		.bind(
			targetId,
			project.id,
			OWNER["x-shiplet-user-id"],
			connectionId,
			accountId,
			JSON.stringify({
				scriptName,
				status: "connected",
				resourceBindingRefs: [],
			}),
			new Date().toISOString(),
		)
		.run();
	return {
		project,
		revision,
		packageEnvelope,
		targetId,
		connectionId,
		scriptName,
	};
}

describe("customer-owned deployment API boundary", () => {
	it("rejects a module-bearing immutable revision before any provider call", async () => {
		const { revision, packageEnvelope, targetId } = await fixture({
			connected: true,
		});
		const source =
			"export default { fetch() { return new Response('blocked'); } };";
		const artifact = packageEnvelope.files.find(
			(file: { path?: string }) => file.path === "artifact/index.html",
		);
		expect(artifact).toBeTruthy();
		artifact.path = "artifact/index.mjs";
		artifact.mediaType = "application/javascript+module";
		artifact.encoding = "utf8";
		artifact.content = source;
		artifact.size = new TextEncoder().encode(source).byteLength;
		artifact.sha256 = Array.from(
			new Uint8Array(
				await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
			),
			(byte) => byte.toString(16).padStart(2, "0"),
		).join("");
		packageEnvelope.manifest.staticFirst = false;
		packageEnvelope.manifest.requestedCapabilities = ["runtime.worker"];
		packageEnvelope.manifest.entrypoints.artifact = "artifact/index.mjs";
		const dynamicRevisionId = `revision_${crypto.randomUUID()}`;
		const packageDigest = await digestShipletPackage(packageEnvelope);
		await (env as Env).DB.prepare(
			`INSERT INTO shiplet_revisions (
			 id, project_id, parent_revision_id, package_json, package_digest,
			 content_digest, runtime_compatibility, validation_report_json,
			 created_by_actor_kind, created_by_actor_id, created_on
			) SELECT ?, project_id, id, ?, ?, NULL, ?, ?, 'human', ?, ?
			 FROM shiplet_revisions WHERE id = ?`,
		)
			.bind(
				dynamicRevisionId,
				JSON.stringify(packageEnvelope),
				packageDigest,
				packageEnvelope.manifest.runtimeCompatibility,
				JSON.stringify({ ok: true, errors: [] }),
				OWNER["x-shiplet-user-id"],
				new Date().toISOString(),
				revision.id,
			)
			.run();

		let providerCalls = 0;
		const provider = {
			hasScript: async () => {
				providerCalls += 1;
				return true;
			},
			initializeScript: async () => {
				providerCalls += 1;
				throw new Error("must_not_run");
			},
			uploadVersion: async () => {
				providerCalls += 1;
				throw new Error("must_not_run");
			},
			proveCandidate: async () => {
				providerCalls += 1;
				throw new Error("must_not_run");
			},
			createDeployment: async () => {
				providerCalls += 1;
				throw new Error("must_not_run");
			},
			createTemporaryDeployment: async () => {
				providerCalls += 1;
				throw new Error("must_not_run");
			},
			cleanupTemporaryDeployment: async () => {
				providerCalls += 1;
			},
		} as CloudflareDeploymentProvider;
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_DEPLOYMENT_PROVIDER: provider,
		}) as DeploymentTestEnv;

		const response = await request(
			`/api/revisions/${dynamicRevisionId}/deployments`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": `dynamic_${crypto.randomUUID()}`,
					...OWNER,
				},
				body: JSON.stringify({ targetId, approval: true }),
			},
			runtimeEnv,
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			code: "customer_advanced_runtime_egress_unavailable",
			retryable: false,
		});
		expect(providerCalls).toBe(0);
	});

	it("fails with a precise external prerequisite instead of exposing an unmounted route", async () => {
		const { revision, targetId } = await fixture();
		const response = await request(
			`/api/revisions/${revision.id}/deployments`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...OWNER },
				body: JSON.stringify({ targetId, approval: true }),
			},
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			ok: false,
			code: "customer_cloudflare_deployment_prerequisite",
			retryable: false,
		});
	});

	it("rejects support drift before any customer deployment provider call", async () => {
		const { revision, targetId } = await fixture({ connected: true });
		let providerCalls = 0;
		const mustNotRun = async () => {
			providerCalls += 1;
			throw new Error("provider_must_not_run");
		};
		const provider = {
			hasScript: mustNotRun,
			initializeScript: mustNotRun,
			uploadVersion: mustNotRun,
			proveCandidate: mustNotRun,
			createDeployment: mustNotRun,
			createTemporaryDeployment: mustNotRun,
			cleanupTemporaryDeployment: mustNotRun,
		} as unknown as CloudflareDeploymentProvider;
		const runtimeEnv = Object.assign(
			{},
			env,
			supportAttestationBindings({
				CLOUDFLARE_GRANT_VAULT_RPC: {
					contract: async () => ({
						...supportContract(1),
						versionId: SUPPORT_RUNTIME_VERSION,
					}),
				},
			}),
			{ CLOUDFLARE_DEPLOYMENT_PROVIDER: provider },
		) as unknown as DeploymentTestEnv;
		const response = await request(
			`/api/revisions/${revision.id}/deployments`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": `drift_${crypto.randomUUID()}`,
					...OWNER,
				},
				body: JSON.stringify({ targetId, approval: true }),
			},
			runtimeEnv,
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			ok: false,
			code: "cloudflare_support_contract_mismatch",
		});
		expect(providerCalls).toBe(0);
	});

	it("denies a sibling actor before revealing deployment prerequisite state", async () => {
		const { revision, targetId } = await fixture();
		const response = await request(
			`/api/revisions/${revision.id}/deployments`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-shiplet-user-id": "user_deployment_api_outsider",
					"x-shiplet-user-email": "deployment-api-outsider@example.com",
				},
				body: JSON.stringify({ targetId, approval: true }),
			},
		);
		expect(response.status).toBe(403);
	});

	it("requires explicit approval before attempting a customer-owned deployment", async () => {
		const { revision, targetId } = await fixture();
		const response = await request(
			`/api/revisions/${revision.id}/deployments`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...OWNER },
				body: JSON.stringify({ targetId }),
			},
		);
		expect(response.status).toBe(428);
	});

	it("deploys one immutable revision through an explicitly bound provider without exposing OAuth material", async () => {
		const { project, revision, targetId } = await fixture({ connected: true });
		const providerVersionId = `version_${crypto.randomUUID()}`;
		const providerDeploymentId = `provider_deployment_${crypto.randomUUID()}`;
		const provider: CloudflareDeploymentProvider = {
			async hasScript() {
				return true;
			},
			async initializeScript() {
				throw new Error("existing_script_expected");
			},
			async uploadVersion() {
				return { versionId: providerVersionId };
			},
			async proveCandidate(input) {
				const request = input.request as { versionId?: unknown };
				return {
					healthy: true,
					observedVersionId: String(request.versionId || ""),
				};
			},
			async createDeployment() {
				return { deploymentId: providerDeploymentId };
			},
			async createTemporaryDeployment() {
				throw new Error("temporary_claim_not_expected");
			},
			async cleanupTemporaryDeployment() {},
		};
		const claimVault: TemporaryClaimVault = {
			async store() {
				throw new Error("temporary_claim_not_expected");
			},
			async consumeForBackendRedirect() {
				return { ok: false, reason: "temporary_claim_not_expected" };
			},
			async redeemBackendRedirect() {
				return null;
			},
		};
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_DEPLOYMENT_PROVIDER: provider,
			CLOUDFLARE_CLAIM_VAULT: claimVault,
		}) as DeploymentTestEnv;

		const idempotencyKey = `deploy_${crypto.randomUUID()}`;
		const response = await request(
			`/api/revisions/${revision.id}/deployments`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"idempotency-key": idempotencyKey,
					...OWNER,
				},
				body: JSON.stringify({ targetId, approval: true }),
			},
			runtimeEnv,
		);
		expect(response.status).toBe(201);
		const payload = (await response.json()) as {
			operation: Record<string, unknown>;
			result: {
				ok: boolean;
				deployment: { id: string; revisionId: string; targetId: string };
			};
		};
		expect(payload.operation).toEqual({
			id: expect.any(String),
			kind: "deploy",
			status: "committed",
			idempotencyKey,
		});
		expect(payload.result.ok).toBe(true);
		expect(payload.result.deployment).toMatchObject({
			revisionId: revision.id,
			targetId,
		});
		expect(Object.keys(payload.result.deployment)).not.toContain(
			"authorization",
		);
		const stored = await (env as Env).DB.prepare(
			`SELECT revision_id, status FROM shiplet_deployments
			 WHERE id = ? AND target_id = ? LIMIT 1`,
		)
			.bind(payload.result.deployment.id, targetId)
			.first<{ revision_id: string; status: string }>();
		expect(stored).toEqual({ revision_id: revision.id, status: "healthy" });
		expect(project.id).toBeTruthy();
	});

	it("delegates an expired cached control-plane connection to the grant vault for refresh instead of revoking it locally", async () => {
		const { revision, targetId, connectionId } = await fixture({
			connected: true,
		});
		expect(connectionId).toBeTruthy();
		await (env as Env).DB.prepare(
			`UPDATE cloudflare_connections
			 SET credential_ref = ?, expires_at = ? WHERE id = ?`,
		)
			.bind(`control-plane:${connectionId}`, Date.now() - 1, connectionId)
			.run();
		let uploadCount = 0;
		const provider: CloudflareDeploymentProvider = {
			async hasScript() {
				return true;
			},
			async initializeScript() {
				throw new Error("existing_script_expected");
			},
			async uploadVersion() {
				uploadCount += 1;
				return { versionId: `version_${crypto.randomUUID()}` };
			},
			async proveCandidate(input) {
				return {
					healthy: true,
					observedVersionId: String(
						(input.request as { versionId?: unknown }).versionId || "",
					),
				};
			},
			async createDeployment() {
				return { deploymentId: `provider_${crypto.randomUUID()}` };
			},
			async createTemporaryDeployment() {
				throw new Error("temporary_claim_not_expected");
			},
			async cleanupTemporaryDeployment() {},
		};
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_DEPLOYMENT_PROVIDER: provider,
		}) as DeploymentTestEnv;
		const response = await request(
			`/api/revisions/${revision.id}/deployments`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": `refresh_${crypto.randomUUID()}`,
					...OWNER,
				},
				body: JSON.stringify({ targetId, approval: true }),
			},
			runtimeEnv,
		);
		expect(response.status, await response.clone().text()).toBe(201);
		expect(uploadCount).toBe(1);
	});

	it("composes the production adapter from value-free runtime bindings before deployment", async () => {
		const { revision, targetId, scriptName } = await fixture({
			connected: true,
		});
		const candidateVersionId = crypto.randomUUID();
		const providerDeploymentId = crypto.randomUUID();
		const bounded = (status: number, body: unknown) =>
			parseCloudflareJsonBytesBounded(
				{ status, bytes: new TextEncoder().encode(JSON.stringify(body)) },
				1024 * 1024,
			);
		const transportCalls: Array<{ method: string; pathname: string }> = [];
		const transport: CloudflareRedactingFetch = {
			async uploadStaticAssets(input) {
				transportCalls.push({
					method: "ASSETS",
					pathname: new URL(input.manifestEndpoint).pathname,
				});
				return {
					completion: Object.freeze({ kind: "opaque_asset_completion" }),
					manifestDigest: input.packageDigest,
					serializedBodyBytes: 64,
				};
			},
			async request(input) {
				transportCalls.push({
					method: input.method,
					pathname: new URL(input.url).pathname,
				});
				if (
					input.body?.kind === "worker_version" &&
					typeof input.body.metadata.annotations === "object" &&
					input.body.metadata.annotations
				) {
					activePackageDigest = String(
						(input.body.metadata.annotations as Record<string, unknown>)[
							"workers/tag"
						] || "",
					);
				}
				if (input.url.endsWith("/script-settings")) {
					return bounded(200, { success: true, result: {} });
				}
				if (input.url.includes("/workers/scripts-search?")) {
					return bounded(200, {
						success: true,
						result: [
							{ id: "worker_runtime_composed", script_name: scriptName },
						],
					});
				}
				if (
					input.method === "POST" &&
					input.url.endsWith(`/workers/scripts/${scriptName}/versions`)
				) {
					return bounded(200, {
						success: true,
						result: { id: candidateVersionId },
					});
				}
				if (input.url.endsWith(`/versions/${candidateVersionId}`)) {
					const workerTag = input.method === "GET" ? activePackageDigest : "";
					return bounded(200, {
						success: true,
						result: {
							id: candidateVersionId,
							annotations: { "workers/tag": workerTag },
							urls: ["https://candidate-runtime-composed.workers.dev/"],
						},
					});
				}
				if (input.url.endsWith("/deployments")) {
					return bounded(200, {
						success: true,
						result: {
							id: providerDeploymentId,
							strategy: "percentage",
							versions: [{ version_id: candidateVersionId, percentage: 100 }],
						},
					});
				}
				throw new Error("unexpected_transport_request");
			},
		};
		let activePackageDigest = "";
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_GRANT_VAULT: {
				async withGrant(
					_binding: object,
					operation: (fetch: CloudflareRedactingFetch) => Promise<unknown>,
				) {
					transportCalls.push({ method: "GRANT", pathname: "/opaque" });
					return operation(transport);
				},
			},
			CLOUDFLARE_VERSION_HEALTH_VERIFIER: {
				async execute(input: {
					packageDigest: string;
					revisionId: string;
					versionId: string;
				}) {
					return bounded(200, {
						ok: true,
						versionId: input.versionId,
						revisionId: input.revisionId,
						packageDigest: input.packageDigest,
					});
				},
			},
		}) as DeploymentTestEnv;

		const response = await request(
			`/api/revisions/${revision.id}/deployments`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"idempotency-key": `runtime_${crypto.randomUUID()}`,
					...OWNER,
				},
				body: JSON.stringify({ targetId, approval: true }),
			},
			runtimeEnv,
		);

		expect(
			response.status,
			`${await response.clone().text()} ${JSON.stringify(transportCalls)}`,
		).toBe(201);
		expect(await response.json()).toMatchObject({
			ok: true,
			deployment: {
				revisionId: revision.id,
				targetId,
				providerVersionId: candidateVersionId,
				providerDeploymentId,
			},
		});
	});

	it("prepares and proves a customer version before atomically promoting a validated revision", async () => {
		const {
			project,
			revision: initialRevision,
			targetId,
		} = await fixture({
			connected: true,
		});
		const forkResponse = await request(`/api/shiplets/${project.id}/drafts`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...OWNER },
			body: JSON.stringify({ fromRevisionId: initialRevision.id }),
		});
		expect(forkResponse.status).toBe(201);
		const { draft } = (await forkResponse.json()) as {
			draft: { id: string; version: number };
		};
		const validationResponse = await request(
			`/api/drafts/${draft.id}/validate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...OWNER },
				body: JSON.stringify({ expectedVersion: draft.version }),
			},
		);
		expect(validationResponse.status).toBe(200);
		const validation = (await validationResponse.json()) as {
			validation: { revisionId: string };
		};

		const calls: string[] = [];
		let uploadedDigest = "";
		const provider: CloudflareDeploymentProvider = {
			async hasScript() {
				calls.push("inspect");
				return true;
			},
			async initializeScript() {
				throw new Error("existing_script_expected");
			},
			async uploadVersion(input) {
				calls.push("upload");
				const request = input.request as { packageDigest?: unknown };
				uploadedDigest = String(request.packageDigest || "");
				return { versionId: "provider_version_for_promotion" };
			},
			async proveCandidate() {
				calls.push("prove");
				return {
					healthy: true,
					observedVersionId: "provider_version_for_promotion",
					observedPackageDigest: uploadedDigest,
				};
			},
			async createDeployment() {
				calls.push("activate");
				return { deploymentId: "provider_deployment_for_promotion" };
			},
			async createTemporaryDeployment() {
				throw new Error("temporary_claim_not_expected");
			},
			async cleanupTemporaryDeployment() {},
		};
		const runtimeEnv = Object.assign({}, env, {
			CLOUDFLARE_DEPLOYMENT_PROVIDER: provider,
		}) as DeploymentTestEnv;
		const missingBaseline = await request(
			`/api/drafts/${draft.id}/promote`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"idempotency-key": `promote_${crypto.randomUUID()}`,
					...OWNER,
				},
				body: JSON.stringify({
					expectedActiveRevisionId: initialRevision.id,
					targetIds: [targetId],
					approval: true,
				}),
			},
			runtimeEnv,
		);
		expect(missingBaseline.status).toBe(409);
		expect(await missingBaseline.json()).toMatchObject({
			ok: false,
			code: "deployment_baseline_required",
		});
		expect(calls).toEqual([]);
		await (env as Env).DB.prepare(
			`INSERT INTO shiplet_deployments (
			 id, target_id, revision_id, provider_resource_name,
			 provider_version_id, provider_deployment_id, status, health_json,
			 deployed_on, deployed_at_ms, failed_on, supersedes_deployment_id
			) VALUES (?, ?, ?, ?, ?, ?, 'healthy', '{"status":"healthy"}',
			 ?, ?, NULL, NULL)`,
		)
			.bind(
				`deployment_${crypto.randomUUID()}`,
				targetId,
				initialRevision.id,
				`shiplet-${project.id}`,
				"provider_version_baseline",
				"provider_deployment_baseline",
				new Date().toISOString(),
				Date.now(),
			)
			.run();
		const promoteResponse = await request(
			`/api/drafts/${draft.id}/promote`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"idempotency-key": `promote_${crypto.randomUUID()}`,
					...OWNER,
				},
				body: JSON.stringify({
					expectedActiveRevisionId: initialRevision.id,
					targetIds: [targetId],
					approval: true,
				}),
			},
			runtimeEnv,
		);
		expect(promoteResponse.status, await promoteResponse.clone().text()).toBe(
			200,
		);
		expect(calls).toEqual(["inspect", "upload", "prove", "activate"]);
		expect(uploadedDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
		const activeResponse = await request(
			`/api/shiplets/${project.id}/package`,
			{
				headers: OWNER,
			},
		);
		expect(
			((await activeResponse.json()) as { revision: { id: string } }).revision
				.id,
		).toBe(validation.validation.revisionId);
	});
});
