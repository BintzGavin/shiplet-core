import { describe, expect, it, vi } from "vitest";
import {
  createDeploymentOrchestrator,
  type CloudflareDeploymentTarget,
  type ImmutableRevisionBundle,
  type ProviderAuthorization,
} from "../src/deployment-orchestrator";

const target: CloudflareDeploymentTarget = {
  id: "target_customer_static",
  shipletId: "shiplet_static",
  kind: "customer_cloudflare",
  ownerUserId: "user_owner",
  connectionId: "connection_customer",
  providerAccountId: "account_customer",
  providerScriptName: "shiplet-customer-static",
  status: "connected",
  resourceBindingRefs: [],
  resourceBindings: [],
};

function revision(modules: ImmutableRevisionBundle["modules"]): ImmutableRevisionBundle {
  return {
    shipletId: target.shipletId,
    revisionId: modules.length > 0 ? "revision_dynamic" : "revision_static",
    packageDigest:
      modules.length > 0 ? "sha256-dynamic-package" : "sha256-static-package",
    modules,
    staticAssets: [
      {
        path: "index.html",
        mediaType: "text/html",
        content: "<!doctype html><title>Static customer deployment</title>",
      },
    ],
  };
}

function setup() {
  const authorize = vi.fn(
    async (input: {
      userId: string;
      shipletId: string;
      accountId: string;
      operation: string;
      requiredScopes: string[];
      targetId: string;
      scriptName: string;
      revisionId: string;
      packageDigest: string;
      requestDigest: string;
    }) => {
      const authorization: ProviderAuthorization = {
        handle: `grant_${authorize.mock.calls.length}`,
        userId: input.userId,
        shipletId: input.shipletId,
        accountId: input.accountId,
        expiresAt: 20_000,
        operation: input.operation,
        scopes: [...input.requiredScopes],
        targetId: input.targetId,
        scriptName: input.scriptName,
        revisionId: input.revisionId,
        packageDigest: input.packageDigest,
        requestDigest: input.requestDigest,
      };
      return { ok: true as const, grantRef: authorization.handle, authorization };
    },
  );
  const provider = {
    hasScript: vi.fn(async () => true),
    initializeScript: vi.fn(async () => ({ versionId: "version_bootstrap" })),
    uploadVersion: vi.fn(async () => ({ versionId: "version_static" })),
    proveCandidate: vi.fn(async () => ({
      healthy: true,
      observedVersionId: "version_static",
    })),
    createDeployment: vi.fn(async () => ({ deploymentId: "deployment_static" })),
    createTemporaryDeployment: vi.fn(),
    cleanupTemporaryDeployment: vi.fn(),
  };
  const repository = {
    getTargetScoped: vi.fn(async () => structuredClone(target)),
    getKnownGood: vi.fn(async () => null),
    getDeploymentScoped: vi.fn(async () => null),
    resolveRevisionPackageDigest: vi.fn(async () => null),
    resolveTargetResources: vi.fn(async () => []),
    reserveTargetOperation: vi.fn(async () => ({
      ok: true as const,
      replay: false as const,
      journal: { id: "journal_static", status: "reserved" },
    })),
    finalizeTargetOperation: vi.fn(async () => true),
    recheckTargetOperation: vi.fn(async () => true),
    completeTargetOperation: vi.fn(async () => true),
    markTargetOperationCompensated: vi.fn(async () => undefined),
    abortTargetOperation: vi.fn(async () => undefined),
    finalizeTemporaryClaimOperation: vi.fn(async () => true),
    recordTemporaryClaim: vi.fn(async () => undefined),
    markTemporaryClaimDelivered: vi.fn(async () => true),
    recordFailure: vi.fn(async () => undefined),
  };
  const dependencies = {
    repository,
    provider,
    connectionAuthorizer: { authorize },
    claimVault: {
      store: vi.fn(),
      consumeForBackendRedirect: vi.fn(),
      redeemBackendRedirect: vi.fn(),
    },
    now: () => 10_000,
    audit: vi.fn(async () => undefined),
    telemetry: vi.fn(async () => undefined),
  };
  const orchestrator = createDeploymentOrchestrator(
    dependencies as unknown as Parameters<
      typeof createDeploymentOrchestrator
    >[0],
  );

  return { authorize, orchestrator, provider, repository };
}

describe("customer static runtime gate", () => {
  it("rejects a module-bearing revision before any grant or provider call", async () => {
    const context = setup();

    const result = await context.orchestrator.deployCustomerRevision({
      actor: { kind: "human", id: target.ownerUserId },
      shipletId: target.shipletId,
      targetId: target.id,
      revision: revision([
        {
          name: "index.mjs",
          mediaType: "application/javascript+module",
          content: "export default { fetch() { return new Response('unsafe'); } }",
        },
      ]),
      idempotencyKey: "reject-customer-module",
    });

    expect(result).toEqual({
      ok: false,
      reason: "customer_advanced_runtime_egress_unavailable",
    });
    expect(context.authorize).not.toHaveBeenCalled();
    expect(
      Object.values(context.provider).every((operation) =>
        vi.mocked(operation).mock.calls.length === 0,
      ),
    ).toBe(true);
  });

  it("preserves successful static-only customer deployments", async () => {
    const context = setup();

    const result = await context.orchestrator.deployCustomerRevision({
      actor: { kind: "human", id: target.ownerUserId },
      shipletId: target.shipletId,
      targetId: target.id,
      revision: revision([]),
      idempotencyKey: "deploy-customer-static",
    });

    expect(result).toMatchObject({
      ok: true,
      deployment: {
        targetId: target.id,
        revisionId: "revision_static",
        providerVersionId: "version_static",
        providerDeploymentId: "deployment_static",
        status: "known_good",
      },
    });
    expect(context.authorize).toHaveBeenCalled();
    expect(context.provider.uploadVersion).toHaveBeenCalledOnce();
    expect(context.provider.createDeployment).toHaveBeenCalledOnce();
    expect(context.repository.finalizeTargetOperation).toHaveBeenCalledOnce();
  });
});
