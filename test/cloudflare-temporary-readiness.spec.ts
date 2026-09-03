import { describe, expect, it, vi } from "vitest";

import {
  createCloudflareTemporaryRpcComposition,
  resolveCloudflareDeploymentRuntime,
  type CloudflareDeploymentRuntimeBindings,
  type CloudflareTemporaryAccountRpcBinding,
} from "../src/cloudflare-runtime-composition";

type TemporaryReadinessBindings = CloudflareDeploymentRuntimeBindings & {
  CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS: "disabled" | "enabled";
};

function configuredTemporaryRuntime(
  readiness: TemporaryReadinessBindings["CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS"],
) {
  const createAndDeploy = vi.fn(async () => {
    throw new Error("temporary_rpc_not_exercised");
  });
  const rpc: CloudflareTemporaryAccountRpcBinding = {
    createAndDeploy,
    async cleanup() {
      throw new Error("temporary_rpc_not_exercised");
    },
    async storeClaim() {
      return { ref: "temporary_claim_fixture" };
    },
    async consumeForBackendRedirect() {
      return { ok: false as const, reason: "temporary_claim_unavailable" };
    },
    async redeemBackendRedirect() {
      return null;
    },
  };
  const temporary = createCloudflareTemporaryRpcComposition({
    rpc,
    trustedControlPlaneOrigin: "https://shiplet.example",
    expectation: {
      versionId: "11111111-1111-4111-8111-111111111111",
      versionTag: "shiplet-test-release",
    },
  });
  const grantOperations = vi.fn();
  const bindings: TemporaryReadinessBindings = {
    CLOUDFLARE_GRANT_VAULT: {
      async withGrant(_binding, operation) {
        grantOperations();
        return operation({
          async request() {
            throw new Error("grant_transport_not_exercised");
          },
          async uploadStaticAssets() {
            throw new Error("grant_transport_not_exercised");
          },
        });
      },
    },
    CLOUDFLARE_TEMPORARY_ACCOUNT_BROKER: temporary.broker,
    CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN: "https://shiplet.example",
    CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS: readiness,
  };
  return { bindings, createAndDeploy, grantOperations };
}

describe("Cloudflare temporary-account readiness", () => {
  it("Given a configured temporary RPC and trusted origin, When readiness is disabled, Then temporary deployment fails closed without exposing or using a provider", () => {
    const fixture = configuredTemporaryRuntime("disabled");

    const runtime = resolveCloudflareDeploymentRuntime(
      fixture.bindings,
      () => 1_000,
    );

    expect(runtime.temporaryReady).toBe(false);
    expect(runtime.temporaryProvider).toBeUndefined();
    expect(fixture.createAndDeploy).not.toHaveBeenCalled();
    expect(fixture.grantOperations).not.toHaveBeenCalled();
  });

  it("Given the same configured boundary, When readiness is enabled, Then temporary deployment composition remains available", () => {
    const fixture = configuredTemporaryRuntime("enabled");

    const runtime = resolveCloudflareDeploymentRuntime(
      fixture.bindings,
      () => 1_000,
    );

    expect(runtime.temporaryReady).toBe(true);
    expect(runtime.temporaryProvider).toBeDefined();
    expect(fixture.createAndDeploy).not.toHaveBeenCalled();
    expect(fixture.grantOperations).not.toHaveBeenCalled();
  });
});
