import { describe, expect, it } from "vitest";

import {
  createCloudflareCustomMcpRpcIsolation,
  createCloudflareTemporaryRpcComposition,
  resolveCloudflareDeploymentRuntime,
  type CloudflareDeploymentRuntimeBindings,
} from "../src/cloudflare-runtime-composition";
import type { CloudflareDeploymentProvider } from "../src/deployment-orchestrator";
import { digestCloudflareProviderRequest } from "../src/cloudflare-production-adapters";

function explicitProvider(): CloudflareDeploymentProvider {
  return {
    async hasScript() {
      return true;
    },
    async initializeScript() {
      return { versionId: "version_bootstrap" };
    },
    async uploadVersion() {
      return { versionId: "version_candidate" };
    },
    async proveCandidate() {
      return { healthy: true, observedVersionId: "version_candidate" };
    },
    async createDeployment() {
      return { deploymentId: "deployment_candidate" };
    },
    async createTemporaryDeployment() {
      return {
        providerDeploymentId: "temporary_deployment",
        providerVersionId: "temporary_version",
        temporaryAuthorization: Object.freeze({}),
        claimUrl: new URL(
          "https://shiplet.example/api/cloudflare/temporary/claim",
        ),
        expiresAt: 61_000,
      };
    },
    async cleanupTemporaryDeployment() {},
  };
}

function valueFreeBindings(): CloudflareDeploymentRuntimeBindings {
  return {
    CLOUDFLARE_GRANT_VAULT: {
      async withGrant(_binding, operation) {
        return operation({
          async request() {
            throw new Error("transport_not_exercised");
          },
          async uploadStaticAssets() {
            throw new Error("transport_not_exercised");
          },
        });
      },
    },
    CLOUDFLARE_VERSION_HEALTH_VERIFIER: {
      async execute() {
        throw new Error("health_not_exercised");
      },
    },
    CLOUDFLARE_TEMPORARY_ACCOUNT_BROKER: {
      async createAndDeploy() {
        throw new Error("temporary_not_exercised");
      },
      async cleanup() {
        throw new Error("temporary_not_exercised");
      },
    },
    CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN: "https://shiplet.example",
    CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS: "enabled",
  };
}

describe("Cloudflare production runtime composition", () => {
  it("Given a verified handler binding, When a custom MCP invocation crosses RPC, Then cancellation and capability callbacks remain invocation-local", async () => {
    const started: Array<Record<string, unknown>> = [];
    const capabilityCalls: Uint8Array[] = [];
    let releaseRun: ((value: Uint8Array) => void) | undefined;
    let cancelCount = 0;
    let disposeCount = 0;
    const isolation = createCloudflareCustomMcpRpcIsolation({
      expectation: {
        versionId: "11111111-1111-4111-8111-111111111111",
        versionTag: "shiplet-test-release",
      },
      rpc: {
        async start(input, requestCapability, expectation) {
          expect(expectation).toEqual({
            versionId: "11111111-1111-4111-8111-111111111111",
            versionTag: "shiplet-test-release",
          });
          started.push(structuredClone(input) as Record<string, unknown>);
          if (requestCapability) {
            const request = new TextEncoder().encode(
              JSON.stringify({
                schemaVersion: "shiplet.runtime.capability-request/v1",
                capability: "state.read:review",
                resource: "state:review",
                input: { key: "summary" },
                effect: "read",
              }),
            );
            capabilityCalls.push((await requestCapability(request)).slice());
          }
          return {
            run: () =>
              new Promise<Uint8Array>((resolve) => {
                releaseRun = resolve;
              }),
            async cancel() {
              cancelCount += 1;
            },
            [Symbol.dispose]() {
              disposeCount += 1;
            },
          };
        },
      },
      attestationAuthority: {
        issue() {
          return {
            schemaVersion: "shiplet.runtime-isolation-attestation/v1" as const,
            attestationId: `attestation_${crypto.randomUUID()}`,
          };
        },
      },
    });
    const bound = isolation.bind({
      shipletId: "shiplet_a",
      revisionId: "revision_a",
      packageDigest: `sha256:${"a".repeat(64)}`,
      activationGeneration: 4,
      handlerSetDigest: `sha256:${"b".repeat(64)}`,
      handlers: [
        {
          path: "mcp/handlers/read.js",
          digest: "c".repeat(64),
          bytes: new TextEncoder().encode(
            "export default async () => ({ content: [] });",
          ),
        },
      ],
      policy: {
        schemaVersion: "shiplet.runtime-isolation-policy/v1",
        hardTermination: "enforced",
        maxCpuMs: 1_000,
        maxMemoryBytes: 128 * 1024 * 1024,
        maxSubrequests: 4,
        outboundNetwork: "deny_by_default",
        ambientBindings: "none",
        ambientSecrets: "none",
      },
    });
    const invocation = bound.transport.invoke({
      invocationId: "invocation_a",
      requestBytes: new TextEncoder().encode("{}"),
      requestCapability: async () =>
        new TextEncoder().encode(JSON.stringify({ ok: true, value: null })),
    });
    for (let index = 0; index < 10 && !releaseRun; index += 1) {
      await Promise.resolve();
    }
    await bound.transport.cancel({
      invocationId: "invocation_a",
      reason: "deadline_exceeded",
    });
    releaseRun?.(new TextEncoder().encode(JSON.stringify({ content: [] })));
    await expect(invocation).resolves.toBeInstanceOf(Uint8Array);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ invocationId: "invocation_a" });
    expect(capabilityCalls).toHaveLength(1);
    expect(cancelCount).toBe(1);
    expect(disposeCount).toBe(1);
  });

  it("Given serializable temporary RPC references, When composed, Then only local opaque authority crosses into the kernel", async () => {
    const calls: Array<{ kind: string; input: unknown }> = [];
    const opaqueClaim = crypto.randomUUID();
    const rpc = {
      async createAndDeploy(input: unknown, expectation: unknown) {
        expect(expectation).toEqual({
          versionId: "11111111-1111-4111-8111-111111111111",
          versionTag: "shiplet-test-release",
        });
        calls.push({ kind: "create", input: structuredClone(input) });
        return {
          providerDeploymentId: "123e4567-e89b-42d3-a456-426614174000",
          providerVersionId: "123e4567-e89b-42d3-a456-426614174001",
          selectedVersionId: "123e4567-e89b-42d3-a456-426614174001",
          temporaryAuthorizationRef: "temporary_authority_fixture",
          claimRef: "temporary_claim_fixture",
          binding: {
            userId: "user_a",
            shipletId: "shiplet_a",
            accountHandle: "temporary_account_a",
            targetId: "target_a",
            scriptName: "shiplet-a",
            revisionId: "revision_a",
            packageDigest: `sha256:${"a".repeat(64)}`,
            requestDigest: `sha256:${"b".repeat(64)}`,
            operationId: "deployment_journal_a",
          },
          expiresAt: 61_000,
          serializedBodyBytes: 512,
        };
      },
      async cleanup(input: unknown, expectation: unknown) {
        expect(expectation).toEqual({
          versionId: "11111111-1111-4111-8111-111111111111",
          versionTag: "shiplet-test-release",
        });
        calls.push({ kind: "cleanup", input: structuredClone(input) });
        return {
          success: true,
          selectedVersionId: "123e4567-e89b-42d3-a456-426614174001",
          binding: {
            userId: "user_a",
            shipletId: "shiplet_a",
            accountHandle: "temporary_account_a",
            targetId: "target_a",
            scriptName: "shiplet-a",
            revisionId: "revision_a",
            packageDigest: `sha256:${"a".repeat(64)}`,
            requestDigest: `sha256:${"b".repeat(64)}`,
            operationId: "deployment_journal_a",
          },
          serializedBodyBytes: 128,
        };
      },
      async storeClaim(input: unknown, expectation: unknown) {
        expect(expectation).toEqual({
          versionId: "11111111-1111-4111-8111-111111111111",
          versionTag: "shiplet-test-release",
        });
        calls.push({ kind: "store", input: structuredClone(input) });
        return { ref: "claim_vault_fixture" };
      },
      async consumeForBackendRedirect(
        input: unknown,
        markDelivered: (delivery: {
          operationId: string;
          deliveryEventId: string;
          deploymentId: string;
          userId: string;
          shipletId: string;
          targetId: string;
          revisionId: string;
        }) => Promise<boolean>,
        expectation: unknown,
      ) {
        expect(expectation).toEqual({
          versionId: "11111111-1111-4111-8111-111111111111",
          versionTag: "shiplet-test-release",
        });
        calls.push({ kind: "consume", input: structuredClone(input) });
        if (!(await markDelivered({
          operationId: "deployment_journal_a",
          deliveryEventId: "delivery_event_a",
          deploymentId: "temporary_deployment_a",
          userId: "user_a",
          shipletId: "shiplet_a",
          targetId: "target_a",
          revisionId: "revision_a",
        }))) {
          return { ok: false as const, reason: "claim_delivery_conflict" };
        }
        return {
          ok: true as const,
          redirect: {
            kind: "trusted_backend_redirect" as const,
            opaqueHandle: "claim_delivery_fixture",
          },
        };
      },
      async redeemBackendRedirect(input: unknown, expectation: unknown) {
        expect(expectation).toEqual({
          versionId: "11111111-1111-4111-8111-111111111111",
          versionTag: "shiplet-test-release",
        });
        calls.push({ kind: "redeem", input: structuredClone(input) });
        return new Response(null, {
          status: 303,
          headers: {
            location: `https://dash.cloudflare.com/claim-preview?claimToken=${opaqueClaim}`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      },
    };
    const composed = createCloudflareTemporaryRpcComposition({
      rpc,
      trustedControlPlaneOrigin: "https://shiplet.example",
      expectation: {
        versionId: "11111111-1111-4111-8111-111111111111",
        versionTag: "shiplet-test-release",
      },
    });
    const authorization = {
      handle: "temporary_grant_a",
      userId: "user_a",
      shipletId: "shiplet_a",
      accountHandle: "temporary_account_a",
      targetId: "target_a",
      scriptName: "shiplet-a",
      revisionId: "revision_a",
      packageDigest: `sha256:${"a".repeat(64)}`,
      operation: "temporary.deployment.create" as const,
      requestDigest: `sha256:${"b".repeat(64)}`,
      operationId: "deployment_journal_a",
      requiredScopes: ["workers.temporary_accounts.write"],
      expiresAt: 31_000,
    };
    const created = await composed.broker.createAndDeploy({
      authorization,
      canonicalRequest: { fixture: true },
      request: { fixture: true },
    });

    expect(Reflect.ownKeys(created.temporaryAuthorizationHandle)).toEqual([]);
    expect(Object.isFrozen(created.temporaryAuthorizationHandle)).toBe(true);
    expect(JSON.stringify(created)).not.toContain(
      "temporary_authority_fixture",
    );
    expect(JSON.stringify(created)).not.toContain("temporary_claim_fixture");

    const trustedClaimUrl = new URL(
      "/api/cloudflare/temporary/claim",
      "https://shiplet.example",
    );
    trustedClaimUrl.searchParams.set("handle", created.claimHandle);
    await expect(
      composed.claimVault.store({
        targetId: "target_a",
        temporaryAuthorization: Object.freeze({}),
        claimUrl: trustedClaimUrl,
        expiresAt: created.expiresAt,
      }),
    ).rejects.toThrow("temporary_claim_binding_invalid");
    const ref = await composed.claimVault.store({
      targetId: "target_a",
      temporaryAuthorization: created.temporaryAuthorizationHandle,
      claimUrl: trustedClaimUrl,
      expiresAt: created.expiresAt,
    });
    expect(ref).toBe("claim_vault_fixture");
    expect(calls.find((call) => call.kind === "store")?.input).toEqual({
      targetId: "target_a",
      temporaryAuthorizationRef: "temporary_authority_fixture",
      claimRef: "temporary_claim_fixture",
      expiresAt: 61_000,
    });
    await expect(
      composed.claimVault.store({
        targetId: "target_a",
        temporaryAuthorization: created.temporaryAuthorizationHandle,
        claimUrl: trustedClaimUrl,
        expiresAt: created.expiresAt,
      }),
    ).rejects.toThrow("temporary_claim_binding_invalid");

    const consumed = await composed.claimVault.consumeForBackendRedirect({
      ref,
      now: 2_000,
      markDelivered: async () => true,
    });
    expect(consumed).toEqual({
      ok: true,
      redirect: {
        kind: "trusted_backend_redirect",
        opaqueHandle: "claim_delivery_fixture",
      },
    });
    const response = await composed.claimVault.redeemBackendRedirect({
      opaqueHandle: "claim_delivery_fixture",
    });
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toContain(
      "https://dash.cloudflare.com/claim-preview?claimToken=",
    );
  });

  it("Given value-free customer dependencies, When resolved, Then composes the strict provider", () => {
    const bindings = valueFreeBindings();
    const runtime = resolveCloudflareDeploymentRuntime(bindings, () => 1_000);

    expect(runtime.customerProvider).toBeDefined();
    expect(runtime.customerReady).toBe(true);
    expect(runtime.temporaryReady).toBe(true);
    expect(runtime.temporaryProvider).toBe(runtime.customerProvider);
    expect(Object.keys(runtime).sort()).toEqual([
      "customerProvider",
      "customerReady",
      "temporaryProvider",
      "temporaryReady",
    ]);
  });

  it("Given a Workers RPC grant transport, When a response crosses isolates, Then the kernel bounds and attests its bytes locally", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runtime = resolveCloudflareDeploymentRuntime(
      {
        CLOUDFLARE_GRANT_VAULT_RPC: {
          async withGrant(
            _binding: unknown,
            operation: (transport: unknown) => Promise<unknown>,
            expectation: unknown,
          ) {
            expect(expectation).toEqual({
              versionId: "11111111-1111-4111-8111-111111111111",
              versionTag: "shiplet-test-release",
            });
            return operation({
              async requestBytes(request: Record<string, unknown>) {
                calls.push(structuredClone(request));
                const versionId = "123e4567-e89b-42d3-a456-426614174000";
                const versionRequest = String(request.url || "").includes(
                  `/versions/${versionId}`,
                );
                return structuredClone({
                  status: 200,
                  bytes: new TextEncoder().encode(
                    JSON.stringify({
                      success: true,
                      result: versionRequest
                        ? {
                            id: versionId,
                            annotations: {
                              "workers/tag": `sha256:${"a".repeat(64)}`,
                            },
                            urls: ["https://candidate.workers.dev/"],
                          }
                        : {},
                    }),
                  ),
                });
              },
              async uploadStaticAssets() {
                throw new Error("not exercised");
              },
            });
          },
        },
        CLOUDFLARE_VERSION_HEALTH_RPC: {
          async executeBytes(
            input: Record<string, unknown>,
            expectation: unknown,
          ) {
            expect(expectation).toEqual({
              versionId: "22222222-2222-4222-8222-222222222222",
              versionTag: "shiplet-test-release",
            });
            return structuredClone({
              status: 200,
              bytes: new TextEncoder().encode(
                JSON.stringify({
                  ok: true,
                  versionId: input.versionId,
                  revisionId: input.revisionId,
                  packageDigest: input.packageDigest,
                }),
              ),
            });
          },
        },
        CLOUDFLARE_CONTROL_PLANE_VERSION_ID:
          "11111111-1111-4111-8111-111111111111",
        CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID:
          "22222222-2222-4222-8222-222222222222",
        CLOUDFLARE_SUPPORT_RELEASE_TAG: "shiplet-test-release",
      } as unknown as CloudflareDeploymentRuntimeBindings,
      () => 1_000,
    );
    expect(runtime.customerReady).toBe(true);
    expect(runtime.customerProvider).toBeDefined();
    const request = {
      actorId: "user_a",
      shipletId: "shiplet_a",
      targetId: "target_a",
      accountId: "account_a",
      scriptName: "shiplet-a",
    };
    const authorization = {
      handle: "grant_a",
      userId: request.actorId,
      shipletId: request.shipletId,
      accountId: request.accountId,
      expiresAt: 2_000,
      operation: "worker.inspect",
      scopes: ["workers.scripts.read"],
      targetId: request.targetId,
      scriptName: request.scriptName,
      revisionId: "revision_a",
      requestDigest: await digestCloudflareProviderRequest(request),
    };

    await expect(
      runtime.customerProvider!.hasScript({
        authorization,
        request,
        ...request,
      }),
    ).resolves.toBe(true);
    const versionId = "123e4567-e89b-42d3-a456-426614174000";
    const revisionId = "revision_a";
    const packageDigest = `sha256:${"a".repeat(64)}`;
    const proofRequest = {
      ...request,
      revisionId,
      packageDigest,
      versionId,
      healthCheck: { path: "/__shiplet/health", expectedStatus: 200 },
    };
    await expect(
      runtime.customerProvider!.proveCandidate({
        authorization: {
          ...authorization,
          operation: "worker.candidate.prove",
          revisionId,
          packageDigest,
          requestDigest: await digestCloudflareProviderRequest(proofRequest),
        },
        request: proofRequest,
        ...proofRequest,
      }),
    ).resolves.toEqual({
      healthy: true,
      observedVersionId: versionId,
      observedPackageDigest: packageDigest,
    });
    expect(calls).toEqual([
      expect.objectContaining({
        method: "GET",
        url: expect.stringContaining(
          "/workers/scripts/shiplet-a/script-settings",
        ),
      }),
      expect.objectContaining({
        method: "GET",
        url: expect.stringContaining(`/versions/${versionId}`),
      }),
    ]);
  });

  it("Given incomplete dependencies, When resolved, Then each capability fails closed independently", () => {
    const bindings = valueFreeBindings();
    const withoutHealth = resolveCloudflareDeploymentRuntime(
      {
        CLOUDFLARE_GRANT_VAULT: bindings.CLOUDFLARE_GRANT_VAULT,
        CLOUDFLARE_TEMPORARY_ACCOUNT_BROKER:
          bindings.CLOUDFLARE_TEMPORARY_ACCOUNT_BROKER,
        CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN:
          bindings.CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN,
        CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS: "enabled",
      },
      () => 1_000,
    );
    expect(withoutHealth.customerReady).toBe(false);
    expect(withoutHealth.customerProvider).toBeUndefined();
    expect(withoutHealth.temporaryReady).toBe(true);

    const withoutBroker = resolveCloudflareDeploymentRuntime(
      {
        CLOUDFLARE_GRANT_VAULT: bindings.CLOUDFLARE_GRANT_VAULT,
        CLOUDFLARE_VERSION_HEALTH_VERIFIER:
          bindings.CLOUDFLARE_VERSION_HEALTH_VERIFIER,
        CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN:
          bindings.CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN,
      },
      () => 1_000,
    );
    expect(withoutBroker.customerReady).toBe(true);
    expect(withoutBroker.temporaryReady).toBe(false);
    expect(withoutBroker.temporaryProvider).toBeUndefined();

    const withoutGrantVault = resolveCloudflareDeploymentRuntime(
      {
        CLOUDFLARE_VERSION_HEALTH_VERIFIER:
          bindings.CLOUDFLARE_VERSION_HEALTH_VERIFIER,
        CLOUDFLARE_TEMPORARY_ACCOUNT_BROKER:
          bindings.CLOUDFLARE_TEMPORARY_ACCOUNT_BROKER,
        CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN:
          bindings.CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN,
      },
      () => 1_000,
    );
    expect(withoutGrantVault).toEqual({
      customerProvider: undefined,
      customerReady: false,
      temporaryProvider: undefined,
      temporaryReady: false,
    });
  });

  it("Given a malformed temporary origin, When resolved, Then customer deployment remains ready while temporary claim fails closed", () => {
    const bindings = valueFreeBindings();
    const runtime = resolveCloudflareDeploymentRuntime(
      {
        ...bindings,
        CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN: "not-an-origin",
      },
      () => 1_000,
    );

    expect(runtime.customerReady).toBe(true);
    expect(runtime.customerProvider).toBeDefined();
    expect(runtime.temporaryReady).toBe(false);
    expect(runtime.temporaryProvider).toBeUndefined();
  });

  it("Given an explicit provider, When resolved, Then preserves the compatibility binding", () => {
    const provider = explicitProvider();
    const runtime = resolveCloudflareDeploymentRuntime(
      {
        CLOUDFLARE_DEPLOYMENT_PROVIDER: provider,
        CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS: "enabled",
      },
      () => 1_000,
    );

    expect(runtime).toEqual({
      customerProvider: provider,
      customerReady: true,
      temporaryProvider: provider,
      temporaryReady: true,
    });
  });
});
