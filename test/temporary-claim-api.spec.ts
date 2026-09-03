import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import type {
  CloudflareDeploymentProvider,
  TemporaryClaimVault,
} from "../src/deployment-orchestrator";
import {
  SUPPORT_RUNTIME_VERSION,
  supportAttestationBindings,
  supportContract,
} from "./helpers/cloudflare-support-runtime";

type ClaimTestEnv = Env & {
  CLOUDFLARE_DEPLOYMENT_PROVIDER?: CloudflareDeploymentProvider;
  CLOUDFLARE_CLAIM_VAULT?: TemporaryClaimVault;
  CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS?:
    | "disabled"
    | "operator_smoke"
    | "enabled";
  CLOUDFLARE_TEMPORARY_ACCOUNTS_SMOKE_USER_ID?: string;
};

const OWNER = {
  "x-shiplet-user-id": "user_temporary_claim_owner",
  "x-shiplet-user-email": "temporary-claim-owner@example.com",
};

async function request(
  path: string,
  init: RequestInit = {},
  runtimeEnv: ClaimTestEnv = env as ClaimTestEnv,
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

async function fixture() {
  const organizationResponse = await request("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({ name: `Temporary Claim ${crypto.randomUUID()}` }),
  });
  const { organization } = (await organizationResponse.json()) as {
    organization: { id: string };
  };
  const publishResponse = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Temporary Claim Shiplet",
      organization_id: organization.id,
      subdomain: `temporary-claim-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "private",
      assets: [
        {
          path: "index.html",
          content: btoa("<!doctype html><h1>temporary preview</h1>"),
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
  const { revision } = (await packageResponse.json()) as {
    revision: { id: string };
  };
  return { project, revision };
}

function runtime(
  readiness: "disabled" | "operator_smoke" | "enabled" = "enabled",
  smokeUserId = "",
) {
  const providerCalls: Array<Record<string, unknown>> = [];
  let temporaryBinding: Record<string, string> | null = null;
  const provider: CloudflareDeploymentProvider = {
    async hasScript() {
      return false;
    },
    async initializeScript() {
      return { versionId: "unused" };
    },
    async uploadVersion() {
      return { versionId: "unused" };
    },
    async proveCandidate() {
      return { healthy: false, observedVersionId: "unused" };
    },
    async createDeployment() {
      return { deploymentId: "unused" };
    },
    async createTemporaryDeployment(input) {
      providerCalls.push(structuredClone(input));
      temporaryBinding = Object.fromEntries(
        [
          "operationId",
          "actorId",
          "shipletId",
          "targetId",
          "revisionId",
        ].map((key) => [key, String(input[key])]),
      );
      return {
        providerDeploymentId: `provider_deployment_${crypto.randomUUID()}`,
        providerVersionId: `provider_version_${crypto.randomUUID()}`,
        temporaryAuthorization: Object.freeze(Object.create(null)),
        claimUrl: new URL("https://example.invalid/"),
        expiresAt: Date.now() + 60_000,
      };
    },
    async cleanupTemporaryDeployment() {},
  };
  let delivered = false;
  const deliveryEventId = `delivery_event_${crypto.randomUUID()}`;
  const redirect = {
    kind: "trusted_backend_redirect" as const,
    opaqueHandle: `delivery_${crypto.randomUUID()}`,
  };
  const vault: TemporaryClaimVault = {
    async store() {
      return `vault_${crypto.randomUUID()}`;
    },
    async consumeForBackendRedirect(input) {
      if (delivered) return { ok: true, redirect };
      if (
        !temporaryBinding ||
        !(await input.markDelivered({
          operationId: temporaryBinding.operationId!,
          deliveryEventId,
          deploymentId: input.ref,
          userId: temporaryBinding.actorId!,
          shipletId: temporaryBinding.shipletId!,
          targetId: temporaryBinding.targetId!,
          revisionId: temporaryBinding.revisionId!,
        }))
      ) {
        return { ok: false, reason: "claim_already_consumed" };
      }
      delivered = true;
      return { ok: true, redirect };
    },
    async redeemBackendRedirect() {
      return new Response(null, {
        status: 303,
        headers: { location: "https://example.invalid/" },
      });
    },
  };
  return {
    providerCalls,
    env: Object.assign({}, env, {
      CLOUDFLARE_DEPLOYMENT_PROVIDER: provider,
      CLOUDFLARE_CLAIM_VAULT: vault,
      CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS: readiness,
      CLOUDFLARE_TEMPORARY_ACCOUNTS_SMOKE_USER_ID: smokeUserId,
    }) as ClaimTestEnv,
  };
}

describe("temporary preview-and-claim API boundary", () => {
  it("refuses to create a target or call Cloudflare until the human accepts the exact current policies", async () => {
    const { project, revision } = await fixture();
    const runtimeEnv = runtime();
    const response = await request(
      `/api/revisions/${revision.id}/temporary-claims`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": `claim_${crypto.randomUUID()}`,
          ...OWNER,
        },
        body: JSON.stringify({ approval: true }),
      },
      runtimeEnv.env,
    );

    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({
      ok: false,
      code: "cloudflare_policy_acceptance_required",
      policies: {
        termsOfService: "https://www.cloudflare.com/terms/",
        privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
      },
    });
    expect(runtimeEnv.providerCalls).toHaveLength(0);
    const count = await (env as Env).DB.prepare(
      "SELECT COUNT(*) AS count FROM deployment_targets WHERE project_id = ?",
    )
      .bind(project.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("fails with an exact prerequisite before creating a target", async () => {
    const { project, revision } = await fixture();
    const response = await request(
      `/api/revisions/${revision.id}/temporary-claims`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": `claim_${crypto.randomUUID()}`,
          ...OWNER,
        },
        body: JSON.stringify({
          approval: true,
          cloudflarePolicyAcceptance: {
            termsOfService: "https://www.cloudflare.com/terms/",
            privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
            acceptTermsOfService: "yes",
          },
        }),
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      code: "temporary_claim_prerequisite",
      retryable: false,
    });
    const count = await (env as Env).DB.prepare(
      "SELECT COUNT(*) AS count FROM deployment_targets WHERE project_id = ?",
    )
      .bind(project.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("keeps the API and ownership UI unavailable when the operator readiness gate is disabled", async () => {
    const { project, revision } = await fixture();
    const runtimeEnv = runtime("disabled");
    const response = await request(
      `/api/revisions/${revision.id}/temporary-claims`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": `claim_${crypto.randomUUID()}`,
          ...OWNER,
        },
        body: JSON.stringify({
          approval: true,
          cloudflarePolicyAcceptance: {
            termsOfService: "https://www.cloudflare.com/terms/",
            privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
            acceptTermsOfService: "yes",
          },
        }),
      },
      runtimeEnv.env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      code: "temporary_claim_prerequisite",
      retryable: false,
    });
    expect(runtimeEnv.providerCalls).toHaveLength(0);

    const ownership = await request(
      `/shiplets/${project.id}/ownership`,
      { headers: OWNER },
      runtimeEnv.env,
    );
    expect(ownership.status).toBe(200);
    const html = await ownership.text();
    expect(html).toContain(
      "Temporary preview and claim is not available in this environment.",
    );
    expect(html).not.toContain("Create temporary preview</button>");
    expect(runtimeEnv.providerCalls).toHaveLength(0);
  });

  it("limits operator-smoke readiness to the exact configured human for both API and ownership UI", async () => {
    const exactFixture = await fixture();
    const exactRuntime = runtime("operator_smoke", OWNER["x-shiplet-user-id"]);
    const exactOwnership = await request(
      `/shiplets/${exactFixture.project.id}/ownership`,
      { headers: OWNER },
      exactRuntime.env,
    );
    expect(exactOwnership.status).toBe(200);
    expect(await exactOwnership.text()).toContain(
      "Create temporary preview</button>",
    );
    const exactResponse = await request(
      `/api/revisions/${exactFixture.revision.id}/temporary-claims`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": `claim_${crypto.randomUUID()}`,
          ...OWNER,
        },
        body: JSON.stringify({
          approval: true,
          cloudflarePolicyAcceptance: {
            termsOfService: "https://www.cloudflare.com/terms/",
            privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
            acceptTermsOfService: "yes",
          },
        }),
      },
      exactRuntime.env,
    );
    expect(exactResponse.status, await exactResponse.clone().text()).toBe(201);
    const exactPayload = (await exactResponse.json()) as {
      deployment: { targetId: string };
    };
    expect(exactRuntime.providerCalls).toHaveLength(1);
    const exactClaim = await request(
      `/api/temporary-claims/${exactPayload.deployment.targetId}/claim`,
      { method: "POST", headers: OWNER, redirect: "manual" },
      exactRuntime.env,
    );
    expect(exactClaim.status).toBe(303);

    const mismatchedFixture = await fixture();
    const mismatchedRuntime = runtime("operator_smoke", "user_other_operator");
    const mismatchedOwnership = await request(
      `/shiplets/${mismatchedFixture.project.id}/ownership`,
      { headers: OWNER },
      mismatchedRuntime.env,
    );
    expect(mismatchedOwnership.status).toBe(200);
    const mismatchedHtml = await mismatchedOwnership.text();
    expect(mismatchedHtml).toContain(
      "Temporary preview and claim is not available in this environment.",
    );
    expect(mismatchedHtml).not.toContain("Create temporary preview</button>");
    const mismatchedResponse = await request(
      `/api/revisions/${mismatchedFixture.revision.id}/temporary-claims`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": `claim_${crypto.randomUUID()}`,
          ...OWNER,
        },
        body: JSON.stringify({
          approval: true,
          cloudflarePolicyAcceptance: {
            termsOfService: "https://www.cloudflare.com/terms/",
            privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
            acceptTermsOfService: "yes",
          },
        }),
      },
      mismatchedRuntime.env,
    );
    expect(mismatchedResponse.status).toBe(503);
    expect(await mismatchedResponse.json()).toEqual({
      ok: false,
      code: "temporary_claim_prerequisite",
      retryable: false,
    });
    expect(mismatchedRuntime.providerCalls).toHaveLength(0);
  });

  it("rejects support drift before creating a temporary target or calling its provider", async () => {
    const { project, revision } = await fixture();
    const runtimeEnv = runtime();
    Object.assign(
      runtimeEnv.env,
      supportAttestationBindings({
        CLOUDFLARE_GRANT_VAULT_RPC: {
          contract: async () => ({
            ...supportContract(1),
            versionId: SUPPORT_RUNTIME_VERSION,
          }),
        },
      }),
    );
    const response = await request(
      `/api/revisions/${revision.id}/temporary-claims`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `claim_${crypto.randomUUID()}`,
          ...OWNER,
        },
        body: JSON.stringify({
          approval: true,
          cloudflarePolicyAcceptance: {
            termsOfService: "https://www.cloudflare.com/terms/",
            privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
            acceptTermsOfService: "yes",
          },
        }),
      },
      runtimeEnv.env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      code: "cloudflare_support_contract_mismatch",
    });
    expect(runtimeEnv.providerCalls).toHaveLength(0);
    const targetCount = await (env as Env).DB.prepare(
      "SELECT COUNT(*) AS count FROM deployment_targets WHERE project_id = ?",
    )
      .bind(project.id)
      .first<{ count: number }>();
    expect(targetCount?.count).toBe(0);
  });

  it("creates one safe temporary deployment and replays only its exact actor-bound backend redirect", async () => {
    const { project, revision } = await fixture();
    const runtimeEnv = runtime();
    const idempotencyKey = `claim_${crypto.randomUUID()}`;
    const createResponse = await request(
      `/api/revisions/${revision.id}/temporary-claims`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": idempotencyKey,
          ...OWNER,
        },
        body: JSON.stringify({
          approval: true,
          cloudflarePolicyAcceptance: {
            termsOfService: "https://www.cloudflare.com/terms/",
            privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
            acceptTermsOfService: "yes",
          },
        }),
      },
      runtimeEnv.env,
    );
    expect(createResponse.status, await createResponse.clone().text()).toBe(
      201,
    );
    const payload = (await createResponse.json()) as {
      deployment: {
        targetId: string;
        revisionId: string;
        status: string;
        requiresOAuthConnectionForUpdates: boolean;
      };
    };
    expect(payload.deployment).toMatchObject({
      revisionId: revision.id,
      status: "awaiting_claim",
      requiresOAuthConnectionForUpdates: true,
    });
    for (const forbidden of [
      "temporaryAuthorization",
      "claimUrl",
      "vaultRef",
    ]) {
      expect(JSON.stringify(payload)).not.toContain(forbidden);
    }
    expect(runtimeEnv.providerCalls).toHaveLength(1);
    expect(runtimeEnv.providerCalls[0]).toMatchObject({ bindings: [] });

    const nonConsumptiveGet = await request(
      `/api/temporary-claims/${payload.deployment.targetId}/claim`,
      { headers: OWNER, redirect: "manual" },
      runtimeEnv.env,
    );
    expect(nonConsumptiveGet.status).toBe(404);

    const claimResponse = await request(
      `/api/temporary-claims/${payload.deployment.targetId}/claim`,
      { method: "POST", headers: OWNER, redirect: "manual" },
      runtimeEnv.env,
    );
    expect(claimResponse.status).toBe(303);
    expect(claimResponse.headers.get("cache-control")).toBe("no-store");
    expect(claimResponse.headers.get("referrer-policy")).toBe("no-referrer");

    const replay = await request(
      `/api/temporary-claims/${payload.deployment.targetId}/claim`,
      { method: "POST", headers: OWNER, redirect: "manual" },
      runtimeEnv.env,
    );
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toBe(
      claimResponse.headers.get("location"),
    );
  });
});
