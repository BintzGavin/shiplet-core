import { describe, expect, it } from "vitest";
import type {
  CloudflareDeploymentProvider,
  CloudflareDeploymentTarget,
  DeploymentConnectionAuthorizer,
  DeploymentRepository,
  ImmutableRevisionBundle,
  KernelDeploymentResource,
  ProviderAuthorization,
  ShipletDeploymentRecord,
} from "../src/deployment-orchestrator";
import {
  createRevisionDeploymentCoordinator,
  type RevisionDeploymentPreparation,
  type RevisionDeploymentPreparationStore,
} from "../src/revision-deployment-coordinator";
import type { RevisionDeploymentRequest } from "../src/self-owned/revisions";

// Behavioral specification
//
// Given an exact immutable revision and a connected, human-owned customer target,
// when the kernel prepares it, then it uploads and proves an undeployed candidate
// without moving provider traffic.
//
// Given a trusted preparation receipt bound to the candidate, actor, target,
// revision, connection, target generation, provider resource, and package digest,
// when the kernel activates it, then exactly that provider version receives 100%
// traffic and replay cannot create a second deployment.
//
// Given any sibling guess, changed/revoked target, wrong actor, malformed proof,
// mixed receipt tuple, or ambiguous provider outcome, when a lifecycle method runs,
// then it fails closed and never silently changes the active provider deployment.
//
// Given a prior known-good deployment selected by the kernel, when compensation
// runs, then the coordinator re-resolves that deployment in the exact target scope
// and creates a new 100% deployment of its exact provider version.

const timestamp = 1_800_000_000_000;
const limits = { cpuMs: 25, subRequests: 8 };

function target(
  overrides: Partial<CloudflareDeploymentTarget> = {},
): CloudflareDeploymentTarget {
  return {
    id: "target_a",
    shipletId: "shiplet_a",
    kind: "customer_cloudflare",
    ownerUserId: "user_a",
    connectionId: "connection_a",
    providerAccountId: "account_a",
    providerScriptName: "shiplet-a-app",
    status: "connected",
    resourceBindingRefs: ["resource_a"],
    resourceBindings: [
      {
        name: "APP_DATA",
        kind: "d1",
        providerResourceId: "provider_resource_a",
        ownerShipletId: "shiplet_a",
        ownerTargetId: "target_a",
      },
    ],
    ...overrides,
  };
}

function revision(
  overrides: Partial<ImmutableRevisionBundle> = {},
): ImmutableRevisionBundle {
  return {
    shipletId: "shiplet_a",
    revisionId: "revision_a2",
    packageDigest: `sha256:${"a".repeat(64)}`,
    modules: [],
    staticAssets: [
      {
        path: "index.html",
        mediaType: "text/html",
        content: "<!doctype html><h1>Static Shiplet</h1>",
      },
    ],
    ...overrides,
  };
}

function request(
  overrides: Partial<RevisionDeploymentRequest> = {},
): RevisionDeploymentRequest {
  return {
    shipletId: "shiplet_a",
    revisionId: "revision_a2",
    targetId: "target_a",
    reason: "promotion",
    ...overrides,
  };
}

class MemoryPreparationStore implements RevisionDeploymentPreparationStore {
  readonly records = new Map<string, RevisionDeploymentPreparation>();

  async insert(record: RevisionDeploymentPreparation) {
    if (this.records.has(record.id)) return false;
    this.records.set(record.id, structuredClone(record));
    return true;
  }

  async get(id: string) {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async compareAndSet(input: {
    id: string;
    expectedVersion: number;
    next: RevisionDeploymentPreparation;
  }) {
    const current = this.records.get(input.id);
    if (!current || current.version !== input.expectedVersion) return false;
    this.records.set(input.id, structuredClone(input.next));
    return true;
  }
}

class FakeProvider implements CloudflareDeploymentProvider {
  hasScriptResult = true;
  proofHealthy = true;
  proofVersionId = "provider_version_candidate";
  proofPackageDigest = `sha256:${"a".repeat(64)}`;
  activationFailure: Error | null = null;
  readonly calls: Array<{ method: string; input: Record<string, unknown> }> =
    [];

  async hasScript(input: Record<string, unknown>) {
    this.calls.push({ method: "hasScript", input: structuredClone(input) });
    return this.hasScriptResult;
  }

  async initializeScript(input: Record<string, unknown>) {
    this.calls.push({
      method: "initializeScript",
      input: structuredClone(input),
    });
    return { versionId: "provider_version_inert" };
  }

  async uploadVersion(input: Record<string, unknown>) {
    this.calls.push({ method: "uploadVersion", input: structuredClone(input) });
    return { versionId: "provider_version_candidate" };
  }

  async proveCandidate(input: Record<string, unknown>) {
    this.calls.push({
      method: "proveCandidate",
      input: structuredClone(input),
    });
    return {
      healthy: this.proofHealthy,
      observedVersionId: this.proofVersionId,
      observedPackageDigest: this.proofPackageDigest,
    };
  }

  async createDeployment(input: Record<string, unknown>) {
    this.calls.push({
      method: "createDeployment",
      input: structuredClone(input),
    });
    if (this.activationFailure) throw this.activationFailure;
    return { deploymentId: `provider_deployment_${this.calls.length}` };
  }

  async createTemporaryDeployment(_input: Record<string, unknown>): Promise<{
    providerDeploymentId: string;
    providerVersionId: string;
    temporaryAuthorization: object;
    claimUrl: URL;
    expiresAt: number;
  }> {
    throw new Error("not available in this fixture");
  }

  async cleanupTemporaryDeployment(input: Record<string, unknown>) {
    this.calls.push({
      method: "cleanupTemporaryDeployment",
      input: structuredClone(input),
    });
  }

  async cleanupVersion(input: Record<string, unknown>) {
    this.calls.push({
      method: "cleanupVersion",
      input: structuredClone(input),
    });
  }
}

type FixtureOptions = {
  target?: CloudflareDeploymentTarget | null;
  actorId?: string;
  targetGeneration?: number;
  bundle?: ImmutableRevisionBundle | null;
  resources?: KernelDeploymentResource[] | null;
  provider?: FakeProvider;
  store?: MemoryPreparationStore;
};

function fixture(options: FixtureOptions = {}) {
  let currentTarget = options.target === undefined ? target() : options.target;
  let currentActorId = options.actorId ?? "user_a";
  let currentGeneration = options.targetGeneration ?? 4;
  const bundle = options.bundle === undefined ? revision() : options.bundle;
  const resources =
    options.resources === undefined
      ? [
          {
            id: "resource_a",
            shipletId: "shiplet_a",
            targetId: "target_a",
            name: "APP_DATA",
            kind: "d1" as const,
            providerResourceId: "provider_resource_a",
            visibility: "private" as const,
          },
        ]
      : options.resources;
  const provider = options.provider ?? new FakeProvider();
  const store = options.store ?? new MemoryPreparationStore();
  const deployments = new Map<string, ShipletDeploymentRecord>([
    [
      "deployment_prior",
      {
        id: "deployment_prior",
        targetId: "target_a",
        revisionId: "revision_a1",
        providerVersionId: "provider_version_prior",
        providerDeploymentId: "provider_deployment_prior",
        status: "known_good",
        supersedesDeploymentId: null,
      },
    ],
  ]);
  const mutationJournals = new Map<
    string,
    Record<string, unknown> & { id: string; status: string }
  >();
  let currentKnownGoodId = "deployment_prior";
  let activeMutationJournalId: string | null = null;
  let afterAuthorize: ((input: Record<string, unknown>) => void) | null = null;
  const repository = {
    getTargetScoped: async (scope: { shipletId: string; targetId: string }) =>
      currentTarget?.shipletId === scope.shipletId &&
      currentTarget.id === scope.targetId
        ? structuredClone(currentTarget)
        : null,
    getKnownGood: async (targetId: string) => {
      const selected = deployments.get(currentKnownGoodId);
      return selected?.targetId === targetId ? structuredClone(selected) : null;
    },
    getDeploymentScoped: async (scope: {
      shipletId: string;
      targetId: string;
      deploymentId: string;
    }) => {
      const selected = deployments.get(scope.deploymentId);
      return currentTarget?.shipletId === scope.shipletId &&
        currentTarget.id === scope.targetId &&
        selected?.targetId === scope.targetId
        ? structuredClone(selected)
        : null;
    },
    resolveRevisionPackageDigest: async (scope: {
      shipletId: string;
      revisionId: string;
    }) =>
      scope.shipletId === "shiplet_a"
        ? scope.revisionId === "revision_a1"
          ? `sha256:${"b".repeat(64)}`
          : bundle?.revisionId === scope.revisionId
            ? bundle.packageDigest
            : null
        : null,
    resolveTargetResources: async (scope: {
      shipletId: string;
      targetId: string;
      resourceRefs: string[];
    }) =>
      resources &&
      scope.shipletId === "shiplet_a" &&
      scope.targetId === "target_a" &&
      scope.resourceRefs.join(",") === "resource_a"
        ? structuredClone(resources)
        : null,
    reserveTargetOperation: async (input: Record<string, unknown>) => {
      const replay = [...mutationJournals.values()].find(
        (journal) =>
          journal.targetId === input.targetId &&
          journal.idempotencyKey === input.idempotencyKey,
      );
      if (replay) {
        return { ok: true as const, replay: true as const, journal: replay };
      }
      if (activeMutationJournalId) {
        return { ok: false as const, reason: "operation_in_progress" };
      }
      const id = `journal_${crypto.randomUUID()}`;
      const journal = {
        id,
        ...structuredClone(input),
        status: "reserved",
      };
      mutationJournals.set(id, journal);
      activeMutationJournalId = id;
      return { ok: true as const, replay: false as const, journal };
    },
    recheckTargetOperation: async (input: {
      journalId: string;
      expectedKnownGoodDeploymentId: string | null;
    }) => {
      const journal = mutationJournals.get(input.journalId);
      const current = await repository.getKnownGood(String(journal?.targetId));
      return (
        (journal?.status === "reserved" ||
          journal?.status === "reconcile_required") &&
        journal.expectedKnownGoodDeploymentId ===
          input.expectedKnownGoodDeploymentId &&
        (current?.id ?? null) === input.expectedKnownGoodDeploymentId
      );
    },
    finalizeTargetOperation: async () => {
      throw new Error("not used by the coordinator");
    },
    markTargetOperationCompensated: async (input: { journalId: string }) => {
      const journal = mutationJournals.get(input.journalId);
      if (journal) journal.status = "compensated";
      if (activeMutationJournalId === input.journalId) {
        activeMutationJournalId = null;
      }
    },
    completeTargetOperation: async (input: {
      journalId: string;
      resultDeploymentId: string;
      status: "finalized" | "compensated";
    }) => {
      const journal = mutationJournals.get(input.journalId);
      if (
        !journal ||
        !deployments.has(input.resultDeploymentId) ||
        currentKnownGoodId !== input.resultDeploymentId
      ) {
        return false;
      }
      journal.status = input.status;
      journal.resultDeploymentId = input.resultDeploymentId;
      if (activeMutationJournalId === input.journalId) {
        activeMutationJournalId = null;
      }
      return true;
    },
    abortTargetOperation: async (input: {
      journalId: string;
      status: "failed" | "aborted" | "reconcile_required";
      reason: string;
    }) => {
      const journal = mutationJournals.get(input.journalId);
      if (journal) {
        journal.status = input.status;
        journal.failureReason = input.reason;
      }
      if (
        input.status !== "reconcile_required" &&
        activeMutationJournalId === input.journalId
      ) {
        activeMutationJournalId = null;
      }
    },
    finalizeTemporaryClaimOperation: async () => false,
    recordTemporaryClaim: async () => undefined,
    markTemporaryClaimDelivered: async () => false,
    recordFailure: async () => undefined,
  } as DeploymentRepository & {
    recheckTargetOperation(input: {
      journalId: string;
      expectedKnownGoodDeploymentId: string | null;
    }): Promise<boolean>;
  };
  const authorizationCalls: Array<Record<string, unknown>> = [];
  const connectionAuthorizer: DeploymentConnectionAuthorizer = {
    authorize: async (input) => {
      authorizationCalls.push(structuredClone(input));
      const authorization: ProviderAuthorization = {
        handle: `opaque_${crypto.randomUUID()}`,
        userId: input.userId,
        shipletId: input.shipletId,
        accountId: input.accountId,
        expiresAt: timestamp + 60_000,
        operation: input.operation,
        scopes: [...input.requiredScopes],
        targetId: input.targetId,
        scriptName: input.scriptName,
        revisionId: input.revisionId,
        packageDigest: input.packageDigest,
        requestDigest: input.requestDigest,
      };
      afterAuthorize?.(structuredClone(input));
      return {
        ok: true as const,
        grantRef: `grant_${crypto.randomUUID()}`,
        authorization,
      };
    },
  };
  const audits: Array<Record<string, unknown>> = [];
  const coordinator = createRevisionDeploymentCoordinator({
    repository,
    provider,
    connectionAuthorizer,
    preparations: store,
    loadRevisionBundle: async (scope) =>
      bundle?.shipletId === scope.shipletId &&
      bundle.revisionId === scope.revisionId
        ? structuredClone(bundle)
        : null,
    resolveHumanActor: async () => ({
      kind: "human" as const,
      id: currentActorId,
    }),
    loadTargetGeneration: async (scope) =>
      currentTarget?.shipletId === scope.shipletId &&
      currentTarget.id === scope.targetId
        ? currentGeneration
        : null,
    limits,
    now: () => timestamp,
    audit: async (event) => {
      audits.push(structuredClone(event));
    },
  });
  return {
    coordinator,
    provider,
    store,
    audits,
    authorizationCalls,
    mutationJournals,
    setTarget(value: CloudflareDeploymentTarget | null) {
      currentTarget = value;
    },
    setActor(value: string) {
      currentActorId = value;
    },
    setGeneration(value: number) {
      currentGeneration = value;
    },
    afterAuthorize(callback: (input: Record<string, unknown>) => void) {
      afterAuthorize = callback;
    },
    commitLocalDeployment(prepared: {
      deploymentId: string;
      providerVersionId: string;
    }) {
      deployments.set(prepared.deploymentId, {
        id: prepared.deploymentId,
        targetId: "target_a",
        revisionId: "revision_a2",
        providerVersionId: prepared.providerVersionId,
        providerDeploymentId: "provider_deployment_committed",
        status: "known_good",
        supersedesDeploymentId: "deployment_prior",
      });
      currentKnownGoodId = prepared.deploymentId;
    },
    compensateLocalDeployment(prepared: { deploymentId: string }) {
      deployments.delete(prepared.deploymentId);
      currentKnownGoodId = "deployment_prior";
    },
  };
}

describe("two-phase revision deployment coordinator", () => {
  it("fails closed before provider access when an advanced customer Worker lacks enforced outbound mediation", async () => {
    const context = fixture({
      bundle: revision({
        modules: [
          {
            name: "worker.mjs",
            mediaType: "application/javascript",
            content: "export default { fetch: () => fetch('https://example.com') };",
          },
        ],
        staticAssets: [],
      }),
    });

    await expect(
      context.coordinator.prepareRevision(request()),
    ).rejects.toMatchObject({
      code: "customer_advanced_runtime_egress_unavailable",
    });
    expect(context.provider.calls).toHaveLength(0);
  });

  it("prepares and proves an exact undeployed candidate with scoped resources and limits", async () => {
    const context = fixture();

    const prepared = await context.coordinator.prepareRevision(request());

    expect(prepared).toMatchObject({
      providerVersionId: "provider_version_candidate",
      providerResourceName: "shiplet-a-app",
      status: "healthy",
    });
    expect(prepared.deploymentId).toMatch(/^deployment_[a-f0-9-]+$/);
    expect(
      context.provider.calls.filter(
        (call) => call.method === "createDeployment",
      ),
    ).toHaveLength(0);
    const upload = context.provider.calls.find(
      (call) => call.method === "uploadVersion",
    )?.input.request as Record<string, unknown>;
    expect(upload).toMatchObject({
      accountId: "account_a",
      scriptName: "shiplet-a-app",
      revisionId: "revision_a2",
      packageDigest: `sha256:${"a".repeat(64)}`,
      actorId: "user_a",
      targetId: "target_a",
      mainModule: "__shiplet_static.mjs",
      bindings: [
        {
          name: "APP_DATA",
          kind: "d1",
          providerResourceId: "provider_resource_a",
        },
      ],
      limits,
      egress: { status: "customer_controlled_unrestricted" },
      staticAssets: [
        {
          path: "/index.html",
          mediaType: "text/html",
          content: "<!doctype html><h1>Static Shiplet</h1>",
        },
      ],
    });
    const proof = context.provider.calls.find(
      (call) => call.method === "proveCandidate",
    )?.input.request;
    expect(proof).toMatchObject({
      actorId: "user_a",
      targetId: "target_a",
      revisionId: "revision_a2",
      packageDigest: `sha256:${"a".repeat(64)}`,
      healthCheck: { path: "/__shiplet/health", expectedStatus: 200 },
    });
    expect(context.audits.at(-1)).toMatchObject({
      eventKind: "cloudflare.revision_candidate.prepared",
      shipletId: "shiplet_a",
      targetId: "target_a",
      revisionId: "revision_a2",
      actorKind: "human",
      actorId: "user_a",
    });
  });

  it("initializes only an inert script when the customer resource does not exist", async () => {
    const provider = new FakeProvider();
    provider.hasScriptResult = false;
    const context = fixture({ provider });

    await context.coordinator.prepareRevision(request());

    const initialization = provider.calls.find(
      (call) => call.method === "initializeScript",
    )?.input.request;
    expect(initialization).toMatchObject({
      accountId: "account_a",
      scriptName: "shiplet-a-app",
      bootstrap: { kind: "inert_known_good" },
    });
    expect(
      provider.calls.filter((call) => call.method === "createDeployment"),
    ).toHaveLength(0);
  });

  it("activates exactly the bound provider version once across replay", async () => {
    const context = fixture();
    const prepared = await context.coordinator.prepareRevision(request());

    await context.coordinator.activatePreparedRevision?.({
      ...request(),
      ...prepared,
    });
    await context.coordinator.activatePreparedRevision?.({
      ...request(),
      ...prepared,
    });

    const activations = context.provider.calls.filter(
      (call) => call.method === "createDeployment",
    );
    expect(activations).toHaveLength(1);
    expect(activations[0]?.input.request).toEqual({
      actorId: "user_a",
      shipletId: "shiplet_a",
      targetId: "target_a",
      accountId: "account_a",
      scriptName: "shiplet-a-app",
      versionId: "provider_version_candidate",
      percentage: 100,
      revisionId: "revision_a2",
      packageDigest: `sha256:${"a".repeat(64)}`,
    });
    expect(context.store.records.get(prepared.deploymentId)).toMatchObject({
      state: "activated",
      providerVersionId: "provider_version_candidate",
    });
  });

  it("holds the shared target mutation fence across provider activation until the local commit", async () => {
    const context = fixture();
    const prepared = await context.coordinator.prepareRevision(request());

    await context.coordinator.activatePreparedRevision?.({
      ...request(),
      ...prepared,
    });

    expect([...context.mutationJournals.values()]).toEqual([
      expect.objectContaining({
        operation: "promotion",
        targetId: "target_a",
        revisionId: "revision_a2",
        expectedKnownGoodDeploymentId: "deployment_prior",
        idempotencyKey: prepared.deploymentId,
        status: "reserved",
      }),
    ]);
  });

  it("rechecks the held fence before local commit and releases it only after the committed deployment is durable", async () => {
    const context = fixture();
    const prepared = await context.coordinator.prepareRevision(request());
    const receipt = { ...request(), ...prepared };
    await context.coordinator.activatePreparedRevision?.(receipt);

    await expect(
      context.coordinator.assertPreparedRevisionCommitAllowed(receipt),
    ).resolves.toBeUndefined();
    context.commitLocalDeployment(prepared);
    await context.coordinator.commitPreparedRevision(receipt);

    expect([...context.mutationJournals.values()]).toEqual([
      expect.objectContaining({
        status: "finalized",
        resultDeploymentId: prepared.deploymentId,
      }),
    ]);
  });

  it("reopens a finalized fence for exact prior-version compensation after a local finalization failure", async () => {
    const context = fixture();
    const prepared = await context.coordinator.prepareRevision(request());
    const receipt = { ...request(), ...prepared };
    await context.coordinator.activatePreparedRevision?.(receipt);
    context.commitLocalDeployment(prepared);
    await context.coordinator.commitPreparedRevision(receipt);
    context.compensateLocalDeployment(prepared);

    await context.coordinator.restorePriorRevision?.({
      ...receipt,
      previousDeployment: {
        deploymentId: "deployment_prior",
        providerVersionId: "provider_version_prior",
        providerResourceName: "shiplet-a-app",
      },
    });

    expect([...context.mutationJournals.values()]).toEqual([
      expect.objectContaining({ status: "compensated" }),
    ]);
    expect(
      context.provider.calls.filter(
        (call) => call.method === "createDeployment",
      ),
    ).toHaveLength(2);
  });

  it("revalidates target configuration after authorization and before moving traffic", async () => {
    const context = fixture();
    const prepared = await context.coordinator.prepareRevision(request());
    context.afterAuthorize((authorization) => {
      if (authorization.operation === "worker.deployment.promote") {
        context.setTarget(target({ providerScriptName: "changed-script" }));
      }
    });

    await expect(
      context.coordinator.activatePreparedRevision?.({
        ...request(),
        ...prepared,
      }),
    ).rejects.toMatchObject({ code: "target_generation_conflict" });
    expect(
      context.provider.calls.filter(
        (call) => call.method === "createDeployment",
      ),
    ).toHaveLength(0);
    expect([...context.mutationJournals.values()]).toEqual([
      expect.objectContaining({ status: "aborted" }),
    ]);
  });

  it.each([
    ["wrong shiplet", { shipletId: "shiplet_b" }],
    ["wrong target", { targetId: "target_b" }],
    ["wrong revision", { revisionId: "revision_b2" }],
    ["wrong reason", { reason: "rollback" as const }],
  ])("rejects a mixed receipt tuple: %s", async (_label, overrides) => {
    const context = fixture();
    const prepared = await context.coordinator.prepareRevision(request());

    await expect(
      context.coordinator.activatePreparedRevision?.({
        ...request(overrides),
        ...prepared,
      }),
    ).rejects.toMatchObject({ code: "preparation_binding_mismatch" });
    expect(
      context.provider.calls.filter(
        (call) => call.method === "createDeployment",
      ),
    ).toHaveLength(0);
  });

  it("rejects invented provider fields on an otherwise valid receipt", async () => {
    const context = fixture();
    const prepared = await context.coordinator.prepareRevision(request());

    await expect(
      context.coordinator.activatePreparedRevision?.({
        ...request(),
        ...prepared,
        providerVersionId: "provider_version_guessed",
      }),
    ).rejects.toMatchObject({ code: "preparation_binding_mismatch" });
  });

  it("fails closed when actor, generation, connection, or target status changes", async () => {
    const mutations: Array<(context: ReturnType<typeof fixture>) => void> = [
      (context) => context.setActor("user_b"),
      (context) => context.setGeneration(5),
      (context) => context.setTarget(target({ connectionId: "connection_b" })),
      (context) => context.setTarget(target({ status: "revoked" })),
      (context) => context.setTarget(null),
    ];
    for (const mutate of mutations) {
      const context = fixture();
      const prepared = await context.coordinator.prepareRevision(request());
      mutate(context);
      await expect(
        context.coordinator.activatePreparedRevision?.({
          ...request(),
          ...prepared,
        }),
      ).rejects.toBeTruthy();
      expect(
        context.provider.calls.filter(
          (call) => call.method === "createDeployment",
        ),
      ).toHaveLength(0);
    }
  });

  it("rejects a sibling target guess before provider access", async () => {
    const context = fixture();

    await expect(
      context.coordinator.prepareRevision(
        request({ shipletId: "shiplet_b", targetId: "target_a" }),
      ),
    ).rejects.toMatchObject({ code: "target_not_found" });
    expect(context.provider.calls).toHaveLength(0);
  });

  it.each([
    ["version", "provider_version_other", `sha256:${"a".repeat(64)}`],
    ["digest", "provider_version_candidate", `sha256:${"b".repeat(64)}`],
  ])(
    "rejects mismatched candidate proof: %s",
    async (_label, versionId, digest) => {
      const provider = new FakeProvider();
      provider.proofVersionId = versionId;
      provider.proofPackageDigest = digest;
      const context = fixture({ provider });

      await expect(
        context.coordinator.prepareRevision(request()),
      ).rejects.toMatchObject({ code: "candidate_proof_mismatch" });
      expect(context.store.records).toHaveLength(0);
      expect(
        provider.calls.filter((call) => call.method === "createDeployment"),
      ).toHaveLength(0);
    },
  );

  it("surfaces ambiguous activation and refuses to repeat provider traffic", async () => {
    const provider = new FakeProvider();
    provider.activationFailure = new Error("opaque provider failure");
    const context = fixture({ provider });
    const prepared = await context.coordinator.prepareRevision(request());

    await expect(
      context.coordinator.activatePreparedRevision?.({
        ...request(),
        ...prepared,
      }),
    ).rejects.toMatchObject({ code: "provider_activation_ambiguous" });
    await expect(
      context.coordinator.activatePreparedRevision?.({
        ...request(),
        ...prepared,
      }),
    ).rejects.toMatchObject({ code: "provider_activation_ambiguous" });
    expect(
      provider.calls.filter((call) => call.method === "createDeployment"),
    ).toHaveLength(1);
  });

  it("restores the exact scoped prior known-good version once", async () => {
    const context = fixture();
    const prepared = await context.coordinator.prepareRevision(request());
    await context.coordinator.activatePreparedRevision?.({
      ...request(),
      ...prepared,
    });

    const restoration = {
      ...request(),
      ...prepared,
      previousDeployment: {
        deploymentId: "deployment_prior",
        providerVersionId: "provider_version_prior",
        providerResourceName: "shiplet-a-app",
      },
    };
    await context.coordinator.restorePriorRevision?.(restoration);
    await context.coordinator.restorePriorRevision?.(restoration);

    const activations = context.provider.calls.filter(
      (call) => call.method === "createDeployment",
    );
    expect(activations).toHaveLength(2);
    expect(activations[1]?.input.request).toEqual({
      actorId: "user_a",
      shipletId: "shiplet_a",
      targetId: "target_a",
      accountId: "account_a",
      scriptName: "shiplet-a-app",
      versionId: "provider_version_prior",
      percentage: 100,
      revisionId: "revision_a1",
      packageDigest: `sha256:${"b".repeat(64)}`,
    });
  });

  it("rejects unscoped or caller-invented restoration destinations", async () => {
    const context = fixture();
    const prepared = await context.coordinator.prepareRevision(request());
    const base = {
      ...request(),
      ...prepared,
    };

    await expect(
      context.coordinator.restorePriorRevision?.({
        ...base,
        previousDeployment: {
          deploymentId: "deployment_missing",
          providerVersionId: "provider_version_prior",
          providerResourceName: "shiplet-a-app",
        },
      }),
    ).rejects.toMatchObject({ code: "prior_deployment_not_found" });
    await expect(
      context.coordinator.restorePriorRevision?.({
        ...base,
        previousDeployment: {
          deploymentId: "deployment_prior",
          providerVersionId: "provider_version_guessed",
          providerResourceName: "sibling-script",
        },
      }),
    ).rejects.toMatchObject({ code: "prior_deployment_binding_mismatch" });
  });

  it("abandons a prepared candidate without activating it and cleans up best-effort", async () => {
    const context = fixture();
    const prepared = await context.coordinator.prepareRevision(request());

    await context.coordinator.abandonPreparedRevision?.({
      ...request(),
      ...prepared,
    });
    await context.coordinator.abandonPreparedRevision?.({
      ...request(),
      ...prepared,
    });

    expect(
      context.provider.calls.filter(
        (call) => call.method === "createDeployment",
      ),
    ).toHaveLength(0);
    expect(
      context.provider.calls.filter((call) => call.method === "cleanupVersion"),
    ).toHaveLength(1);
    expect(context.store.records.get(prepared.deploymentId)?.state).toBe(
      "abandoned",
    );
  });

  it("rejects package scope and cross-target resource projection", async () => {
    const wrongBundle = fixture({
      bundle: revision({ shipletId: "shiplet_b" }),
    });
    await expect(
      wrongBundle.coordinator.prepareRevision(request()),
    ).rejects.toMatchObject({ code: "revision_not_found" });

    const wrongResource = fixture({
      resources: [
        {
          id: "resource_a",
          shipletId: "shiplet_b",
          targetId: "target_a",
          name: "APP_DATA",
          kind: "d1",
          providerResourceId: "provider_resource_a",
        },
      ],
    });
    await expect(
      wrongResource.coordinator.prepareRevision(request()),
    ).rejects.toMatchObject({ code: "target_resource_scope_mismatch" });
  });
});
