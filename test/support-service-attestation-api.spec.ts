import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import { SUPPORT_ENTRYPOINTS } from "../src/cloudflare-support/service-contract";

const OPERATOR = {
  "x-shiplet-user-id": "user_support_attestation_operator",
  "x-shiplet-user-email": "support-attestation@example.com",
};
const controlVersion = "11111111-1111-4111-8111-111111111111";
const runtimeVersion = "22222222-2222-4222-8222-222222222222";
const denyVersion = "33333333-3333-4333-8333-333333333333";
const releaseTag = "shiplet-0123456789abcdef0123456789abcdef01234567";

function healthySupportHealth() {
  return {
    schemaVersion: "shiplet.support-health/v1" as const,
    status: "healthy" as const,
    schemaReady: true,
    credentialContinuity: "verified" as const,
    reconciliation: {
      status: "success" as const,
      fresh: true,
      completedAt: 1_800_000_000_000,
    },
    backlog: {
      cleanupPending: 0,
      revocationPending: 0,
      temporaryAmbiguous: 0,
      temporaryAmbiguityExpired: 0,
      boundedAt: 101,
    },
    release: { versionId: controlVersion, versionTag: releaseTag },
  };
}

function contract(expected: (typeof SUPPORT_ENTRYPOINTS)[number]) {
  return {
    schemaVersion: "shiplet.support/v1" as const,
    ...expected,
    versionId:
      expected.service === "shiplet-cloudflare-control-plane"
        ? controlVersion
        : runtimeVersion,
    versionTag: releaseTag,
  };
}

function runtime(overrides: Record<string, unknown> = {}) {
  const contracts = SUPPORT_ENTRYPOINTS.map(contract);
  return Object.assign({}, env, {
    CLOUDFLARE_CONTROL_PLANE_VERSION_ID: controlVersion,
    CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID: runtimeVersion,
    CLOUDFLARE_DENY_EGRESS_VERSION_ID: denyVersion,
    CLOUDFLARE_SUPPORT_RELEASE_TAG: releaseTag,
    CLOUDFLARE_OAUTH_CONTROL_PLANE: {
      begin: async () => ({ ok: false as const, reason: "not_used" }),
      finalize: async () => ({ ok: false as const, reason: "not_used" }),
      acknowledge: async () => ({ ok: false as const, reason: "not_used" }),
      revoke: async () => ({ ok: false as const, reason: "not_used" }),
      contract: async () => contracts[0],
      health: async () => healthySupportHealth(),
    },
    CLOUDFLARE_GRANT_VAULT_RPC: { contract: async () => contracts[1] },
    CLOUDFLARE_TEMPORARY_ACCOUNT_RPC: { contract: async () => contracts[2] },
    CLOUDFLARE_VERSION_HEALTH_RPC: { contract: async () => contracts[3] },
    CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC: { contract: async () => contracts[4] },
    CLOUDFLARE_MANAGED_RUNTIME_RPC: { contract: async () => contracts[5] },
    ...overrides,
  }) as unknown as Env;
}

async function request(runtimeEnv: Env) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request("http://localhost/api/platform/support-contract", {
      headers: OPERATOR,
    }),
    runtimeEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function createShiplet() {
  const organizationResponse = await app.fetch(
    new Request("http://localhost/api/organizations", {
      method: "POST",
      headers: { "content-type": "application/json", ...OPERATOR },
      body: JSON.stringify({ name: `Support gate ${crypto.randomUUID()}` }),
    }),
    env as Env,
  );
  const { organization } = (await organizationResponse.json()) as {
    organization: { id: string };
  };
  const publishResponse = await app.fetch(
    new Request("http://localhost/api/shiplets", {
      method: "POST",
      headers: { "content-type": "application/json", ...OPERATOR },
      body: JSON.stringify({
        name: "Support gate Shiplet",
        organization_id: organization.id,
        subdomain: `support-gate-${crypto.randomUUID().slice(0, 8)}`,
        visibility: "private",
        assets: [{ path: "index.html", content: btoa("support gate") }],
      }),
    }),
    env as Env,
  );
  return (await publishResponse.json()) as { project: { id: string } };
}

describe("support-service contract API", () => {
  it("calls and attests all six live named entrypoints at their captured versions", async () => {
    const response = await request(runtime());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      ok: true,
      contracts: SUPPORT_ENTRYPOINTS.map(contract),
      supportHealth: healthySupportHealth(),
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /authorization|claim.?url|secret|api.?token|access.?token|refresh.?token|ciphertext|nonce|credentialRef|encodedKey/i,
    );
  });

  it("Given exact operator-smoke authority, When the support contract is opened, Then managed broker and deny-egress readiness is live-attested", async () => {
    let expectation: unknown;
    const contracts = SUPPORT_ENTRYPOINTS.map(contract);
    const response = await request(
      runtime({
        CLOUDFLARE_MANAGED_RUNTIME_READINESS: "operator_smoke",
        CLOUDFLARE_MANAGED_RUNTIME_SMOKE_USER_ID:
          "user_support_attestation_operator",
        CLOUDFLARE_MANAGED_RUNTIME_RPC: {
          contract: async () => contracts[5],
          readiness: async (input: unknown) => {
            expectation = input;
            return { ok: true as const };
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      managedRuntime: { ok: true },
    });
    expect(expectation).toEqual({
      gateway: { versionId: runtimeVersion, versionTag: releaseTag },
      deploymentBroker: {
        versionId: controlVersion,
        versionTag: releaseTag,
      },
      denyEgress: { versionId: denyVersion, versionTag: releaseTag },
    });
  });

  it("Given operator-smoke mode for another user, When the support contract is opened, Then managed authority is not advertised or invoked", async () => {
    let readinessCalls = 0;
    const contracts = SUPPORT_ENTRYPOINTS.map(contract);
    const response = await request(
      runtime({
        CLOUDFLARE_MANAGED_RUNTIME_READINESS: "operator_smoke",
        CLOUDFLARE_MANAGED_RUNTIME_SMOKE_USER_ID: "user_other_operator",
        CLOUDFLARE_MANAGED_RUNTIME_RPC: {
          contract: async () => contracts[5],
          readiness: async () => {
            readinessCalls += 1;
            return { ok: true as const };
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("managedRuntime");
    expect(readinessCalls).toBe(0);
  });

  it("fails closed when credential continuity, cron freshness, or bounded cleanup health is degraded", async () => {
    const response = await request(
      runtime({
        CLOUDFLARE_OAUTH_CONTROL_PLANE: {
          contract: async () => contract(SUPPORT_ENTRYPOINTS[0]),
          health: async () => ({
            ...healthySupportHealth(),
            status: "degraded",
            credentialContinuity: "unavailable",
          }),
        },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      code: "cloudflare_support_health_degraded",
      supportHealth: {
        ...healthySupportHealth(),
        status: "degraded",
        credentialContinuity: "unavailable",
      },
    });
  });

  it("fails closed when an entrypoint version drifts or any contract call is unavailable", async () => {
    const drifted = await request(
      runtime({
        CLOUDFLARE_VERSION_HEALTH_RPC: {
          contract: async () => ({
            ...contract(SUPPORT_ENTRYPOINTS[3]),
            versionId: controlVersion,
          }),
        },
      }),
    );
    expect(drifted.status).toBe(503);
    expect(await drifted.json()).toEqual({
      ok: false,
      code: "cloudflare_support_contract_mismatch",
    });

    const wrongRelease = await request(
      runtime({
        CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC: {
          contract: async () => ({
            ...contract(SUPPORT_ENTRYPOINTS[4]),
            versionTag: "shiplet-other-release",
          }),
        },
      }),
    );
    expect(wrongRelease.status).toBe(503);
    expect(await wrongRelease.json()).toEqual({
      ok: false,
      code: "cloudflare_support_contract_mismatch",
    });

    const unavailable = await request(
      runtime({ CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC: undefined }),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      ok: false,
      code: "cloudflare_support_contract_mismatch",
    });
  });

  it("blocks OAuth authority before begin when any live support entrypoint drifts", async () => {
    const { project } = await createShiplet();
    let beginCalls = 0;
    const contracts = SUPPORT_ENTRYPOINTS.map(contract);
    const response = await (async () => {
      const context = createExecutionContext();
      const result = await app.fetch(
        new Request("http://localhost/api/cloudflare/oauth/start", {
          method: "POST",
          headers: { "content-type": "application/json", ...OPERATOR },
          body: JSON.stringify({ shipletId: project.id }),
        }),
        runtime({
          CLOUDFLARE_OAUTH_READINESS: "enabled",
          CLOUDFLARE_OAUTH_CONTROL_PLANE: {
            contract: async () => contracts[0],
            begin: async () => {
              beginCalls += 1;
              return { ok: false as const, reason: "must_not_run" };
            },
            finalize: async () => ({ ok: false as const, reason: "not_used" }),
            acknowledge: async () => ({ ok: false as const, reason: "not_used" }),
            revoke: async () => ({ ok: false as const, reason: "not_used" }),
          },
          CLOUDFLARE_GRANT_VAULT_RPC: {
            contract: async () => ({
              ...contracts[1],
              versionId: runtimeVersion,
            }),
          },
        }),
        context,
      );
      await waitOnExecutionContext(context);
      return result;
    })();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      code: "cloudflare_support_contract_mismatch",
    });
    expect(beginCalls).toBe(0);
  });

  it("Given exact entrypoint versions but degraded support health, When OAuth begins, Then provider authority is blocked before the control plane call", async () => {
    const { project } = await createShiplet();
    const contracts = SUPPORT_ENTRYPOINTS.map(contract);
    let beginCalls = 0;
    const context = createExecutionContext();
    const response = await app.fetch(
      new Request("http://localhost/api/cloudflare/oauth/start", {
        method: "POST",
        headers: { "content-type": "application/json", ...OPERATOR },
        body: JSON.stringify({ shipletId: project.id }),
      }),
      runtime({
        CLOUDFLARE_OAUTH_READINESS: "enabled",
        CLOUDFLARE_OAUTH_CONTROL_PLANE: {
          contract: async () => contracts[0],
          health: async () => ({
            ...healthySupportHealth(),
            status: "degraded" as const,
            reconciliation: {
              ...healthySupportHealth().reconciliation,
              fresh: false,
            },
          }),
          begin: async () => {
            beginCalls += 1;
            return { ok: false as const, reason: "must_not_run" };
          },
          finalize: async () => ({ ok: false as const, reason: "not_used" }),
          acknowledge: async () => ({ ok: false as const, reason: "not_used" }),
          revoke: async () => ({ ok: false as const, reason: "not_used" }),
        },
      }),
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      code: "cloudflare_support_health_degraded",
    });
    expect(beginCalls).toBe(0);
  });

  it("blocks OAuth authority before finalization when any live support entrypoint drifts", async () => {
    let finalizeCalls = 0;
    const contracts = SUPPORT_ENTRYPOINTS.map(contract);
    const context = createExecutionContext();
    const response = await app.fetch(
      new Request("http://localhost/api/cloudflare/oauth/finalize", {
        method: "POST",
        headers: { "content-type": "application/json", ...OPERATOR },
        body: JSON.stringify({
          shipletId: "shiplet_attestation_fixture",
          deliveryHandle: "F".repeat(43),
        }),
      }),
      runtime({
        CLOUDFLARE_OAUTH_READINESS: "enabled",
        CLOUDFLARE_OAUTH_CONTROL_PLANE: {
          contract: async () => contracts[0],
          begin: async () => ({ ok: false as const, reason: "not_used" }),
          finalize: async () => {
            finalizeCalls += 1;
            return { ok: false as const, reason: "must_not_run" };
          },
          acknowledge: async () => ({ ok: false as const, reason: "not_used" }),
          revoke: async () => ({ ok: false as const, reason: "not_used" }),
        },
        CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC: {
          contract: async () => ({
            ...contracts[4],
            versionTag: "shiplet-drifted-release",
          }),
        },
      }),
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(503);
    expect(finalizeCalls).toBe(0);
  });

  it("binds the exact attested support release to an authorized OAuth call", async () => {
    const { project } = await createShiplet();
    const contracts = SUPPORT_ENTRYPOINTS.map(contract);
    let receivedExpectation: unknown;
    const context = createExecutionContext();
    const response = await app.fetch(
      new Request("http://localhost/api/cloudflare/oauth/start", {
        method: "POST",
        headers: { "content-type": "application/json", ...OPERATOR },
        body: JSON.stringify({ shipletId: project.id }),
      }),
      runtime({
        CLOUDFLARE_OAUTH_READINESS: "enabled",
        CLOUDFLARE_OAUTH_CONTROL_PLANE: {
          contract: async () => contracts[0],
          health: async () => healthySupportHealth(),
          begin: async (_input: unknown, expectation: unknown) => {
            receivedExpectation = expectation;
            return {
              ok: true as const,
              authorizationUrl:
                "https://dash.cloudflare.com/oauth2/auth?client_id=public-test",
            };
          },
          finalize: async () => ({ ok: false as const, reason: "not_used" }),
          acknowledge: async () => ({ ok: false as const, reason: "not_used" }),
          revoke: async () => ({ ok: false as const, reason: "not_used" }),
        },
      }),
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(200);
    expect(receivedExpectation).toEqual({
      versionId: controlVersion,
      versionTag: releaseTag,
    });
  });

  it("retries an attested remote revoke after local fail-closed revocation", async () => {
    const { project } = await createShiplet();
    const connectionId = `connection_${crypto.randomUUID()}`;
    const targetId = `target_${crypto.randomUUID()}`;
    const accountId = `account_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await (env as Env).DB.batch([
      (env as Env).DB.prepare(
        `INSERT INTO cloudflare_connections (
          id, user_id, account_id, account_label, scopes_json, credential_ref,
          expires_at, status, revoked_at, generation, created_on, refreshed_at
        ) VALUES (?, ?, ?, 'Revoke fixture', ?, ?, ?, 'active', NULL, 1, ?, NULL)`,
      ).bind(
        connectionId,
        OPERATOR["x-shiplet-user-id"],
        accountId,
        JSON.stringify(["workers.scripts.read", "workers.scripts.write"]),
        `control-plane:${connectionId}`,
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
        OPERATOR["x-shiplet-user-id"],
        connectionId,
        accountId,
        JSON.stringify({
          scriptName: `shiplet-${crypto.randomUUID()}`,
          status: "connected",
          resourceBindingRefs: [],
        }),
        now,
      ),
    ]);
    const contracts = SUPPORT_ENTRYPOINTS.map(contract);
    let revokeCalls = 0;
    const controlPlane = {
      contract: async () => contracts[0],
      health: async () => healthySupportHealth(),
      begin: async () => ({ ok: false as const, reason: "not_used" }),
      finalize: async () => ({ ok: false as const, reason: "not_used" }),
      acknowledge: async () => ({ ok: false as const, reason: "not_used" }),
      revoke: async () => {
        revokeCalls += 1;
        return {
          ok: true as const,
          connection: {
            id: connectionId,
            userId: OPERATOR["x-shiplet-user-id"],
            accountId,
            status: "revoked" as const,
            generation: 2,
          },
        };
      },
    };
    const revokeRequest = () =>
      new Request(
        `http://localhost/api/cloudflare/connections/${connectionId}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json", ...OPERATOR },
          body: JSON.stringify({ shipletId: project.id, approval: true }),
        },
      );
    const execute = async (runtimeEnv: Env) => {
      const context = createExecutionContext();
      const response = await app.fetch(revokeRequest(), runtimeEnv, context);
      await waitOnExecutionContext(context);
      return response;
    };

    const drifted = await execute(
      runtime({
        CLOUDFLARE_OAUTH_READINESS: "enabled",
        CLOUDFLARE_OAUTH_CONTROL_PLANE: controlPlane,
        CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC: {
          contract: async () => ({
            ...contracts[4],
            versionTag: "shiplet-drifted-release",
          }),
        },
      }),
    );
    expect(drifted.status).toBe(503);
    expect(revokeCalls).toBe(0);

    const pending = await (env as Env).DB.prepare(
      `SELECT status FROM cloudflare_revocation_requests
       WHERE connection_id = ?`,
    )
      .bind(connectionId)
      .first<{ status: string }>();
    expect(pending).toEqual({ status: "pending" });

    const recovered = await execute(
      runtime({
        CLOUDFLARE_OAUTH_READINESS: "enabled",
        CLOUDFLARE_OAUTH_CONTROL_PLANE: controlPlane,
      }),
    );
    expect(recovered.status).toBe(200);
    expect(revokeCalls).toBe(1);
    expect(
      await (env as Env).DB.prepare(
        `SELECT status FROM cloudflare_revocation_requests
         WHERE connection_id = ?`,
      )
        .bind(connectionId)
        .first(),
    ).toEqual({ status: "complete" });

    const replay = await execute(
      runtime({
        CLOUDFLARE_OAUTH_READINESS: "enabled",
        CLOUDFLARE_OAUTH_CONTROL_PLANE: controlPlane,
      }),
    );
    expect(replay.status).toBe(200);
    expect(revokeCalls).toBe(1);
  });
});
