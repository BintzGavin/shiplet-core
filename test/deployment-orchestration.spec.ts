import { describe, expect, it } from "vitest";
import {
  createDeploymentOrchestrator,
  createManagedInvocationPolicy,
  type CloudflareDeploymentProvider,
  type TargetMutationOperation,
  type TemporaryClaimVault,
} from "../src/deployment-orchestrator";
import {
  createCloudflareOpaqueTemporaryAuthorizationHandle,
  createCloudflareTemporaryClaimHandle,
  createCloudflareCustomerDeploymentProvider,
  parseCloudflareJsonBytesBounded,
  type CloudflareRedactingFetch,
} from "../src/cloudflare-production-adapters";
import customerTargetFixture from "./fixtures/cloudflare/customer-target.json";
import kernelResourcesFixture from "./fixtures/cloudflare/kernel-resources.json";
import managedInvocationFixture from "./fixtures/cloudflare/managed-invocation.json";
import revisionWorkerFixture from "./fixtures/cloudflare/revision-worker.json";
import scopeContract from "./fixtures/cloudflare/scope-contract.json";

type HumanActor = { kind: "human"; id: string };

type TargetResource = {
  name: string;
  kind: "d1" | "r2" | "durable_object" | "plain_text";
  providerResourceId?: string;
  value?: string;
  ownerShipletId: string;
  ownerTargetId: string;
};

type DeploymentTarget = {
  id: string;
  shipletId: string;
  kind: "customer_cloudflare" | "temporary_claim";
  ownerUserId: string;
  connectionId: string | null;
  providerAccountId: string;
  providerScriptName: string;
  status: "connected" | "revoked" | "claimed";
  resourceBindingRefs?: string[];
  resourceBindings: TargetResource[];
};

type KernelResource = {
  id: string;
  shipletId: string;
  targetId: string;
  name: string;
  kind: "d1" | "r2" | "durable_object" | "plain_text";
  providerResourceId?: string;
  visibility?: "public" | "private";
  value?: string;
};

type RevisionBundle = {
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  modules: Array<{ name: string; mediaType: string; content: string }>;
  staticAssets: Array<{ path: string; mediaType: string; content: string }>;
};

type DeploymentRecord = {
  id: string;
  targetId: string;
  revisionId: string;
  providerVersionId: string;
  providerDeploymentId: string;
  status: "known_good" | "failed";
  supersedesDeploymentId: string | null;
  deployedAt?: number;
  failureReason?: string;
};

function runtimeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function actorFor(target: DeploymentTarget): HumanActor {
  return { kind: "human", id: target.ownerUserId };
}

function cloneTarget(): DeploymentTarget {
  return structuredClone(customerTargetFixture) as DeploymentTarget;
}

function cloneRevision(): RevisionBundle {
  const revision = structuredClone(revisionWorkerFixture) as RevisionBundle;
  return { ...revision, modules: [] };
}

function acceptedCloudflareTemporaryAccountPolicies() {
  return {
    cloudflarePolicyAcceptance: {
      termsOfService: "https://www.cloudflare.com/terms/" as const,
      privacyPolicy: "https://www.cloudflare.com/privacypolicy/" as const,
      acceptTermsOfService: "yes" as const,
    },
  };
}

class MemoryDeploymentRepository {
  readonly targets = new Map<string, DeploymentTarget>();
  readonly deployments = new Map<string, DeploymentRecord>();
  readonly failures: Array<Record<string, unknown>> = [];
  readonly state = new Map<string, unknown>();
  readonly currentByTarget = new Map<string, string>();
  readonly resources = new Map<string, KernelResource>();
  readonly reservations: Array<Record<string, unknown>> = [];
  readonly journals = new Map<
    string,
    Record<string, unknown> & { status: string }
  >();
  readonly temporaryClaims = new Map<string, Record<string, unknown>>();
  readonly temporaryClaimHistory: Array<Record<string, unknown>> = [];
  readonly temporaryClaimDeliveryAudits: Array<Record<string, unknown>> = [];
  readonly timeline: string[] = [];
  private readonly activeReservationByTarget = new Map<string, string>();
  private readonly journalByIdempotency = new Map<string, string>();
  private targetLookupGate: DeploymentGate | null = null;
  failNextCommit = false;
  finalizeThrows = false;
  recordFailureThrows = false;
  recordTemporaryClaimThrows = false;
  recordTemporaryClaimFailuresRemaining = 0;
  markTemporaryClaimDeliveredFails = false;
  finalizeTemporaryClaimFails = false;

  constructor() {
    for (const resource of kernelResourcesFixture.resources as KernelResource[]) {
      this.resources.set(resource.id, structuredClone(resource));
    }
  }

  async getTargetScoped(input: { shipletId: string; targetId: string }) {
    if (this.targetLookupGate) await this.targetLookupGate.wait();
    const target = this.targets.get(input.targetId);
    return target?.shipletId === input.shipletId
      ? structuredClone(target)
      : null;
  }

  async getKnownGood(targetId: string) {
    const id = this.currentByTarget.get(targetId);
    const deployment = id ? this.deployments.get(id) : undefined;
    return deployment ? structuredClone(deployment) : null;
  }

  async getDeploymentScoped(input: {
    shipletId: string;
    targetId: string;
    deploymentId: string;
  }) {
    const target = await this.getTargetScoped(input);
    const deployment = this.deployments.get(input.deploymentId);
    return target && deployment?.targetId === input.targetId
      ? structuredClone(deployment)
      : null;
  }

  async resolveRevisionPackageDigest(input: {
    shipletId: string;
    revisionId: string;
  }) {
    const target = [...this.targets.values()].find(
      (candidate) => candidate.shipletId === input.shipletId,
    );
    if (!target) return null;
    return `sha256-${input.revisionId.replaceAll("_", "-")}`;
  }

  async commitKnownGood(input: {
    record: DeploymentRecord;
    expectedKnownGoodDeploymentId: string | null;
  }) {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      return false;
    }
    const current = this.currentByTarget.get(input.record.targetId) ?? null;
    if (current !== input.expectedKnownGoodDeploymentId) return false;
    this.deployments.set(input.record.id, structuredClone(input.record));
    this.currentByTarget.set(input.record.targetId, input.record.id);
    return true;
  }

  async recordFailure(event: Record<string, unknown>) {
    if (this.recordFailureThrows)
      throw new Error("repository_failure_write_failed");
    this.failures.push(structuredClone(event));
  }

  async resolveTargetResources(input: {
    shipletId: string;
    targetId: string;
    resourceRefs: string[];
  }) {
    const resources: KernelResource[] = [];
    for (const ref of input.resourceRefs) {
      const resource = this.resources.get(ref);
      if (
        !resource ||
        resource.shipletId !== input.shipletId ||
        resource.targetId !== input.targetId
      ) {
        return null;
      }
      resources.push(structuredClone(resource));
    }
    return resources;
  }

  async reserveTargetOperation(input: {
    shipletId: string;
    targetId: string;
    expectedKnownGoodDeploymentId: string | null;
    idempotencyKey: string;
    operation: TargetMutationOperation;
    revisionId: string;
    intentDigest: string;
  }) {
    this.timeline.push("repository.reserve");
    this.reservations.push(structuredClone(input));
    const idempotencyIndex = `${input.shipletId}:${input.targetId}:${input.idempotencyKey}`;
    const priorJournalId = this.journalByIdempotency.get(idempotencyIndex);
    if (priorJournalId) {
      const prior = this.journals.get(priorJournalId)!;
      if (
        typeof input.intentDigest !== "string" ||
        input.intentDigest.length === 0 ||
        prior.intentDigest !== input.intentDigest
      ) {
        return {
          ok: false as const,
          reason: "idempotency_intent_mismatch" as const,
        };
      }
      return { ok: true as const, replay: true as const, journal: prior };
    }
    const existingId = this.activeReservationByTarget.get(input.targetId);
    if (existingId) {
      const existing = this.journals.get(existingId)!;
      return { ok: false as const, reason: "operation_in_progress" as const };
    }
    const journalId = runtimeId("journal");
    const journal = {
      id: journalId,
      ...structuredClone(input),
      status: "reserved",
    };
    this.journals.set(journalId, journal);
    this.journalByIdempotency.set(idempotencyIndex, journalId);
    this.activeReservationByTarget.set(input.targetId, journalId);
    return { ok: true as const, replay: false as const, journal };
  }

  async finalizeTargetOperation(input: {
    journalId: string;
    record: DeploymentRecord;
  }) {
    if (this.finalizeThrows) throw new Error("repository_finalize_failed");
    const journal = this.journals.get(input.journalId);
    if (!journal) return false;
    if (this.failNextCommit) {
      this.failNextCommit = false;
      journal.status = "reconcile_required";
      return false;
    }
    this.deployments.set(input.record.id, structuredClone(input.record));
    this.currentByTarget.set(input.record.targetId, input.record.id);
    journal.status = "finalized";
    journal.resultDeploymentId = input.record.id;
    this.activeReservationByTarget.delete(input.record.targetId);
    return true;
  }

  async recheckTargetOperation(input: {
    journalId: string;
    shipletId: string;
    targetId: string;
    expectedKnownGoodDeploymentId: string | null;
    allowReconcileRequired?: boolean;
  }) {
    const journal = this.journals.get(input.journalId);
    const current = this.currentByTarget.get(input.targetId) ?? null;
    return (
      journal?.shipletId === input.shipletId &&
      journal.targetId === input.targetId &&
      journal.expectedKnownGoodDeploymentId ===
        input.expectedKnownGoodDeploymentId &&
      current === input.expectedKnownGoodDeploymentId &&
      (journal.status === "reserved" ||
        (input.allowReconcileRequired === true &&
          journal.status === "reconcile_required"))
    );
  }

  async finalizeTemporaryClaimOperation(input: {
    journalId: string;
    publicResult: Record<string, unknown>;
  }) {
    if (this.finalizeTemporaryClaimFails) return false;
    const journal = this.journals.get(input.journalId);
    if (!journal) return false;
    journal.status = "finalized";
    journal.publicResult = structuredClone(input.publicResult);
    this.activeReservationByTarget.delete(String(journal.targetId));
    return true;
  }

  async markTargetOperationCompensated(input: { journalId: string }) {
    const journal = this.journals.get(input.journalId);
    if (journal) {
      journal.status = "compensated";
      this.activeReservationByTarget.delete(String(journal.targetId));
    }
  }

  async abortTargetOperation(input: {
    journalId: string;
    status: "failed" | "aborted" | "reconcile_required";
    reason: string;
  }) {
    const journal = this.journals.get(input.journalId);
    if (!journal) return;
    if (
      journal.status === "reconcile_required" &&
      input.status !== "reconcile_required"
    ) {
      return;
    }
    journal.status = input.status;
    journal.failureReason = input.reason;
    if (input.status !== "reconcile_required") {
      this.activeReservationByTarget.delete(String(journal.targetId));
    }
  }

  async recordTemporaryClaim(
    input: Record<string, unknown> & { targetId: string },
  ) {
    if (
      this.recordTemporaryClaimThrows ||
      this.recordTemporaryClaimFailuresRemaining > 0
    ) {
      if (this.recordTemporaryClaimFailuresRemaining > 0) {
        this.recordTemporaryClaimFailuresRemaining -= 1;
      }
      throw new Error("temporary_claim_repository_failed");
    }
    this.temporaryClaimHistory.push(structuredClone(input));
    this.temporaryClaims.set(input.targetId, structuredClone(input));
  }

  async markTemporaryClaimDelivered(input: {
    targetId: string;
    expectedStatus: "awaiting_claim";
    delivery: Record<string, unknown>;
  }) {
    if (this.markTemporaryClaimDeliveredFails) return false;
    const record = this.temporaryClaims.get(input.targetId);
    if (!record) return false;
    if (record.status === "delivered") {
      return record.deliveryEventId === input.delivery.eventId;
    }
    if (record.status !== input.expectedStatus) return false;
    record.status = "delivered";
    record.deliveryEventId = input.delivery.eventId;
    this.temporaryClaimDeliveryAudits.push(structuredClone(input.delivery));
    return true;
  }

  seedKnownGood(record: DeploymentRecord) {
    this.deployments.set(record.id, structuredClone(record));
    this.currentByTarget.set(record.targetId, record.id);
  }

  pauseTargetLookup() {
    const gate = new DeploymentGate();
    this.targetLookupGate = gate;
    return gate;
  }
}

class FakeConnectionAuthorizer {
  status: "active" | "revoked" = "active";
  throwOnAuthorize = false;
  statusSequence: Array<"active" | "revoked"> = [];
  readonly requests: Array<Record<string, unknown>> = [];
  afterAuthorize: ((input: Record<string, unknown>) => void) | null = null;
  readonly grants = new Map<
    string,
    {
      handle: string;
      userId: string;
      shipletId: string;
      accountId: string;
      expiresAt: number;
      operation: string;
      scopes: string[];
      targetId?: string;
      scriptName?: string;
      revisionId?: string;
      packageDigest?: string;
      requestDigest?: string;
    }
  >();

  async authorize(input: {
    connectionId: string;
    userId: string;
    shipletId: string;
    accountId: string;
    operation?: string;
    requiredScopes?: string[];
    targetId?: string;
    scriptName?: string;
    revisionId?: string;
    packageDigest?: string;
    requestDigest?: string;
  }) {
    this.requests.push(structuredClone(input));
    if (this.throwOnAuthorize) throw new Error("authorization_store_failed");
    const status = this.statusSequence.shift() ?? this.status;
    if (status !== "active") {
      return { ok: false as const, reason: "connection_revoked" as const };
    }
    const handle = runtimeId("grant");
    const authorization = {
      handle,
      userId: input.userId,
      shipletId: input.shipletId,
      accountId: input.accountId,
      expiresAt: 50_000,
      operation: input.operation ?? "unspecified",
      scopes: [...(input.requiredScopes ?? [])],
      targetId: input.targetId,
      scriptName: input.scriptName,
      revisionId: input.revisionId,
      packageDigest: input.packageDigest,
      requestDigest: input.requestDigest,
    };
    this.grants.set(handle, authorization);
    this.afterAuthorize?.(structuredClone(input));
    return { ok: true as const, grantRef: handle, authorization };
  }
}

class FakeTemporaryDeploymentAuthorizer {
  status: "active" | "revoked" = "active";
  readonly requests: Array<Record<string, unknown>> = [];
  readonly grants = new Map<string, Record<string, unknown>>();

  async authorize(input: {
    operationId: string;
    userId: string;
    shipletId: string;
    accountHandle: string;
    targetId: string;
    scriptName: string;
    revisionId: string;
    packageDigest: string;
    operation: "temporary.deployment.create" | "temporary.deployment.cleanup";
    requiredScopes: readonly string[];
    requestDigest: string;
  }) {
    this.requests.push(structuredClone(input));
    if (this.status !== "active") {
      return { ok: false as const, reason: "temporary_capability_revoked" };
    }
    const handle = runtimeId("temporary_grant");
    const authorization = {
      handle,
      userId: input.userId,
      shipletId: input.shipletId,
      accountId: input.accountHandle,
      expiresAt: 50_000,
      operation: input.operation,
      scopes: [...input.requiredScopes],
      targetId: input.targetId,
      scriptName: input.scriptName,
      revisionId: input.revisionId,
      packageDigest: input.packageDigest,
      requestDigest: input.requestDigest,
      operationId: input.operationId,
    };
    this.grants.set(handle, structuredClone(authorization));
    return { ok: true as const, authorization };
  }
}

class DeploymentGate {
  readonly entered: Promise<void>;
  private signalEntered!: () => void;
  private readonly released: Promise<void>;
  private signalReleased!: () => void;

  constructor() {
    this.entered = new Promise((resolve) => {
      this.signalEntered = resolve;
    });
    this.released = new Promise((resolve) => {
      this.signalReleased = resolve;
    });
  }

  async wait() {
    this.signalEntered();
    await this.released;
  }

  release() {
    this.signalReleased();
  }
}

class FakeCloudflareDeploymentProvider {
  scriptExists = false;
  hasScriptSucceeds = true;
  uploadSucceeds = true;
  proofSucceeds = true;
  previewHealthy = true;
  previewObservedVersionId: string | null = null;
  deploymentSucceeds = true;
  temporaryDeploymentSucceeds = true;
  temporaryExpiresAt = 60_000;
  temporaryResultOverride: Record<string, unknown> | null = null;
  cleanupSucceeds = true;
  liveVersionId: string | null = null;
  private deploymentCallCount = 0;
  private readonly deploymentCountWaiters = new Map<number, () => void>();
  private deploymentGate: { call: number; gate: DeploymentGate } | null = null;
  private inspectGate: DeploymentGate | null = null;
  private temporaryDeploymentCallCount = 0;
  private readonly temporaryDeploymentCountWaiters = new Map<
    number,
    () => void
  >();
  private temporaryDeploymentGate: {
    call: number;
    gate: DeploymentGate;
  } | null = null;
  readonly operations: Array<{
    kind: string;
    input: Record<string, unknown>;
  }> = [];
  readonly temporaryAuthorization = Object.freeze(Object.create(null));
  readonly claimUrl = new URL(
    `https://provider.invalid/claim/${crypto.randomUUID()}`,
  );

  async hasScript(input: Record<string, unknown>) {
    this.operations.push({ kind: "has_script", input: structuredClone(input) });
    if (!this.hasScriptSucceeds) throw new Error("provider_inspect_failed");
    if (this.inspectGate) await this.inspectGate.wait();
    return this.scriptExists;
  }

  async initializeScript(input: Record<string, unknown>) {
    this.operations.push({
      kind: "initialize_script",
      input: structuredClone(input),
    });
    return { versionId: runtimeId("version") };
  }

  async uploadVersion(input: Record<string, unknown>) {
    this.operations.push({
      kind: "upload_version",
      input: structuredClone(input),
    });
    if (!this.uploadSucceeds) throw new Error("provider_upload_failed");
    return { versionId: runtimeId("version") };
  }

  async proveCandidate(input: {
    accountId: string;
    scriptName: string;
    versionId: string;
    packageDigest: string;
  }) {
    const request =
      "request" in input ? (input.request as typeof input) : input;
    this.operations.push({
      kind: "prove_candidate",
      input: structuredClone(input),
    });
    if (!this.proofSucceeds) throw new Error("provider_proof_failed");
    return {
      healthy: this.previewHealthy,
      observedVersionId: this.previewObservedVersionId ?? request.versionId,
    };
  }

  async createDeployment(input: {
    accountId: string;
    scriptName: string;
    versionId: string;
    percentage: 100;
  }) {
    const request =
      "request" in input ? (input.request as typeof input) : input;
    this.deploymentCallCount += 1;
    this.operations.push({
      kind: "create_deployment",
      input: structuredClone(input),
    });
    if (!this.deploymentSucceeds) throw new Error("provider_deployment_failed");
    this.liveVersionId = request.versionId;
    this.deploymentCountWaiters.get(this.deploymentCallCount)?.();
    if (this.deploymentGate?.call === this.deploymentCallCount) {
      await this.deploymentGate.gate.wait();
    }
    return { deploymentId: runtimeId("provider_deployment") };
  }

  async createTemporaryDeployment(input: Record<string, unknown>) {
    this.temporaryDeploymentCallCount += 1;
    this.operations.push({
      kind: "create_temporary_deployment",
      input: structuredClone(input),
    });
    if (!this.temporaryDeploymentSucceeds) {
      throw new Error("temporary_provider_failed");
    }
    this.temporaryDeploymentCountWaiters.get(
      this.temporaryDeploymentCallCount,
    )?.();
    if (
      this.temporaryDeploymentGate?.call === this.temporaryDeploymentCallCount
    ) {
      await this.temporaryDeploymentGate.gate.wait();
    }
    if (this.temporaryResultOverride) {
      return structuredClone(this.temporaryResultOverride) as never;
    }
    return {
      providerDeploymentId: runtimeId("temporary_deployment"),
      providerVersionId: runtimeId("temporary_version"),
      temporaryAuthorization: this.temporaryAuthorization,
      claimUrl: this.claimUrl,
      expiresAt: this.temporaryExpiresAt,
    };
  }

  async cleanupTemporaryDeployment(input: Record<string, unknown>) {
    this.operations.push({
      kind: "cleanup_temporary_deployment",
      input: structuredClone(input),
    });
    if (!this.cleanupSucceeds) throw new Error("temporary_cleanup_failed");
  }

  pauseDeployment(call: number) {
    const gate = new DeploymentGate();
    this.deploymentGate = { call, gate };
    return gate;
  }

  pauseInspect() {
    const gate = new DeploymentGate();
    this.inspectGate = gate;
    return gate;
  }

  pauseTemporaryDeployment(call: number) {
    const gate = new DeploymentGate();
    this.temporaryDeploymentGate = { call, gate };
    return gate;
  }

  waitForDeploymentCount(count: number) {
    if (this.deploymentCallCount >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.deploymentCountWaiters.set(count, resolve);
    });
  }

  waitForTemporaryDeploymentCount(count: number) {
    if (this.temporaryDeploymentCallCount >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.temporaryDeploymentCountWaiters.set(count, resolve);
    });
  }
}

class MemoryClaimVault {
  readonly records: Array<{
    ref: string;
    targetId: string;
    temporaryAuthorization: object;
    claimUrl: URL;
    expiresAt: number;
  }> = [];
  readonly deliveries: Array<{
    ref: string;
    redirect: { kind: "trusted_backend_redirect"; opaqueHandle: string };
  }> = [];
  readonly erasedRefs: string[] = [];
  private readonly redemptionLocations = new Map<
    string,
    { location: URL; ref: string }
  >();
  private readonly preparedDeliveries = new Map<
    string,
    {
      event: Parameters<
        TemporaryClaimVault["consumeForBackendRedirect"]
      >[0]["markDelivered"] extends (delivery: infer Delivery) => unknown
        ? Delivery
        : never;
      redirect: { kind: "trusted_backend_redirect"; opaqueHandle: string };
    }
  >();
  storeSucceeds = true;
  deliveryDeploymentIdOverride: string | null = null;
  private readonly consumed = new Set<string>();

  constructor(private readonly repository: MemoryDeploymentRepository) {}

  async store(input: {
    targetId: string;
    temporaryAuthorization: object;
    claimUrl: URL;
    expiresAt: number;
  }) {
    if (!this.storeSucceeds) throw new Error("claim_vault_failed");
    const ref = runtimeId("claim_ref");
    this.records.push({ ref, ...input });
    return ref;
  }

  async consume(ref: string, now: number) {
    const record = this.records.find((candidate) => candidate.ref === ref);
    if (!record) return { ok: false as const, reason: "claim_not_found" };
    if (this.consumed.has(ref)) {
      return { ok: false as const, reason: "claim_already_consumed" };
    }
    if (now > record.expiresAt) {
      return { ok: false as const, reason: "claim_expired" };
    }
    this.consumed.add(ref);
    return {
      ok: true as const,
      temporaryAuthorization: record.temporaryAuthorization,
      claimUrl: record.claimUrl,
    };
  }

  async consumeForBackendRedirect(input: {
    ref: string;
    now: number;
    markDelivered: Parameters<
      TemporaryClaimVault["consumeForBackendRedirect"]
    >[0]["markDelivered"];
  }) {
    const { ref, now } = input;
    const recordIndex = this.records.findIndex(
      (candidate) => candidate.ref === ref,
    );
    const record = this.records[recordIndex];
    if (!record) return { ok: false as const, reason: "claim_not_found" };
    if (now >= record.expiresAt) {
      return { ok: false as const, reason: "claim_expired" };
    }
    const claim = [...this.repository.temporaryClaims.values()].find(
      (candidate) => candidate.vaultRef === ref,
    );
    const target = this.repository.targets.get(record.targetId);
    const prepared = this.preparedDeliveries.get(ref);
    const event = prepared?.event ??
      (claim && target && typeof claim.operationId === "string" &&
      typeof claim.shipletId === "string" &&
      typeof claim.revisionId === "string"
        ? {
            operationId: claim.operationId,
            deliveryEventId: runtimeId("claim_delivery_event"),
            deploymentId: this.deliveryDeploymentIdOverride ?? ref,
            userId: target.ownerUserId,
            shipletId: claim.shipletId,
            targetId: record.targetId,
            revisionId: claim.revisionId,
          }
        : null);
    if (
      !claim ||
      !target ||
      !event ||
      !(await input.markDelivered(event))
    ) {
      return { ok: false as const, reason: "claim_delivery_conflict" };
    }
    const redirect =
      prepared?.redirect ??
      ({
        kind: "trusted_backend_redirect" as const,
        opaqueHandle: runtimeId("claim_delivery"),
      } as const);
    if (!prepared) {
      this.preparedDeliveries.set(ref, { event, redirect });
      this.deliveries.push({ ref, redirect });
      this.redemptionLocations.set(redirect.opaqueHandle, {
        location: record.claimUrl,
        ref,
      });
    }
    return { ok: true as const, redirect };
  }

  async redeemBackendRedirect(input: { opaqueHandle: string }) {
    const redemption = this.redemptionLocations.get(input.opaqueHandle);
    if (!redemption) return null;
    return new Response(null, {
      status: 303,
      headers: { location: redemption.location.toString() },
    });
  }
}

function setup() {
  let now = 40_000;
  const repository = new MemoryDeploymentRepository();
  const provider = new FakeCloudflareDeploymentProvider();
  const connectionAuthorizer = new FakeConnectionAuthorizer();
  const temporaryDeploymentAuthorizer = new FakeTemporaryDeploymentAuthorizer();
  const claimVault = new MemoryClaimVault(repository);
  const audit: Array<Record<string, unknown>> = [];
  const telemetry: Array<Record<string, unknown>> = [];
  const auditControl: { throwOnceFor: string | null } = { throwOnceFor: null };
  const target = cloneTarget();
  repository.targets.set(target.id, target);
  const dependencies = {
    repository,
    provider,
    connectionAuthorizer,
    temporaryDeploymentAuthorizer,
    claimVault,
    now: () => now,
    audit: async (event: Record<string, unknown>) => {
      if (auditControl.throwOnceFor === event.eventKind) {
        auditControl.throwOnceFor = null;
        throw new Error("audit_write_failed");
      }
      audit.push(structuredClone(event));
    },
    telemetry: async (event: Record<string, unknown>) => {
      telemetry.push(structuredClone(event));
    },
  };
  const orchestrator = createDeploymentOrchestrator(dependencies);
  return {
    orchestrator,
    createOrchestrator: () => createDeploymentOrchestrator(dependencies),
    createOrchestratorWithProvider: (
      replacement: CloudflareDeploymentProvider,
    ) =>
      createDeploymentOrchestrator({ ...dependencies, provider: replacement }),
    repository,
    provider,
    connectionAuthorizer,
    temporaryDeploymentAuthorizer,
    claimVault,
    audit,
    telemetry,
    auditControl,
    target,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function knownGood(
  target: DeploymentTarget,
  revisionId: string,
  providerVersionId: string,
): DeploymentRecord {
  return {
    id: runtimeId("deployment"),
    targetId: target.id,
    revisionId,
    providerVersionId,
    providerDeploymentId: runtimeId("provider_deployment"),
    status: "known_good",
    supersedesDeploymentId: null,
    deployedAt: 30_000,
  };
}

function containsReference(value: unknown, reference: unknown): boolean {
  if (value === reference) return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((child) =>
    containsReference(child, reference),
  );
}

function allKeys(value: unknown, keys = new Set<string>()) {
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key.toLowerCase());
    allKeys(child, keys);
  }
  return keys;
}

function providerRequest(input: Record<string, unknown>) {
  return (
    input.request && typeof input.request === "object" ? input.request : input
  ) as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((child) => canonicalJson(child)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Digest(value: unknown) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function deployWithOperation(
  context: ReturnType<typeof setup>,
  input: CustomerDeploymentOperation,
) {
  const deploy = context.orchestrator.deployCustomerRevision as unknown as (
    request: CustomerDeploymentOperation,
  ) => Promise<{
    ok: boolean;
    reason?: string;
    deployment?: DeploymentRecord;
  }>;
  return deploy(input);
}

type CustomerDeploymentOperation = {
  actor: HumanActor;
  shipletId: string;
  targetId: string;
  revision: RevisionBundle;
  idempotencyKey: string;
};

type RollbackOperation = {
  actor: HumanActor;
  shipletId: string;
  targetId: string;
  toDeploymentId: string;
  expectedKnownGoodDeploymentId: string;
  idempotencyKey: string;
};

function rollbackWithOperation(
  context: ReturnType<typeof setup>,
  input: RollbackOperation,
) {
  const rollback = context.orchestrator.rollbackCustomerRevision as unknown as (
    request: RollbackOperation,
  ) => Promise<{
    ok: boolean;
    reason?: string;
    deployment?: DeploymentRecord;
  }>;
  return rollback(input);
}

describe("customer-owned Cloudflare deployment orchestration", () => {
  it("runs the exact orchestrator contract through the production Cloudflare adapter before traffic promotion", async () => {
    const context = setup();
    const revision: RevisionBundle = {
      shipletId: context.target.shipletId,
      revisionId: "revision_prod_adapter",
      packageDigest: `sha256:${"a".repeat(64)}`,
      modules: [],
      staticAssets: [
        {
          path: "index.html",
          mediaType: "text/html",
          content: "<!doctype html><title>Adapter integration</title>",
        },
      ],
    };
    const candidateVersionId = "11111111-1111-4111-8111-111111111111";
    const providerDeploymentId = "22222222-2222-4222-8222-222222222222";
    const requests: Array<Record<string, unknown>> = [];
    const bounded = (status: number, body: unknown) =>
      parseCloudflareJsonBytesBounded(
        {
          status,
          bytes: new TextEncoder().encode(JSON.stringify(body)),
        },
        1024 * 1024,
      );
    const fetch: CloudflareRedactingFetch = {
      async uploadStaticAssets(input) {
        requests.push({ kind: "assets", ...structuredClone(input) });
        return {
          completion: Object.freeze(Object.create(null)),
          manifestDigest: revision.packageDigest,
          serializedBodyBytes: 256,
        };
      },
      async request(input) {
        requests.push({ kind: "request", ...structuredClone(input) });
        if (input.url.endsWith("/script-settings")) {
          return bounded(200, { success: true, result: {} });
        }
        if (
          input.method === "POST" &&
          input.url.endsWith(
            `/workers/scripts/${context.target.providerScriptName}/versions`,
          )
        ) {
          return bounded(200, {
            success: true,
            result: { id: candidateVersionId },
          });
        }
        if (
          input.method === "GET" &&
          input.url.endsWith(`/versions/${candidateVersionId}`)
        ) {
          return bounded(200, {
            success: true,
            result: {
              id: candidateVersionId,
              annotations: { "workers/tag": revision.packageDigest },
              urls: ["https://candidate-prod-adapter.workers.dev/"],
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
        throw new Error("unexpected Cloudflare transport request");
      },
    };
    const provider = createCloudflareCustomerDeploymentProvider({
      now: () => 40_000,
      grants: {
        async withGrant(binding, operation) {
          const stored = context.connectionAuthorizer.grants.get(
            binding.handle,
          );
          expect(stored).toMatchObject({
            userId: binding.userId,
            shipletId: context.target.shipletId,
            accountId: binding.accountId,
            targetId: binding.targetId,
            scriptName: binding.scriptName,
            revisionId: binding.revisionId,
            packageDigest: revision.packageDigest,
            operation: binding.operation,
            requestDigest: binding.requestDigest,
          });
          return operation(fetch);
        },
      },
      versionHealthVerifier: {
        async execute(input) {
          expect(input).toMatchObject({
            targetId: context.target.id,
            revisionId: revision.revisionId,
            packageDigest: revision.packageDigest,
            versionId: candidateVersionId,
            path: "/__shiplet/health",
          });
          return bounded(200, {
            ok: true,
            versionId: candidateVersionId,
            revisionId: revision.revisionId,
            packageDigest: revision.packageDigest,
          });
        },
      },
    });
    const orchestrator = context.createOrchestratorWithProvider(provider);

    const result = await orchestrator.deployCustomerRevision({
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision,
      idempotencyKey: "adapter-production-contract",
    });

    expect(result).toMatchObject({
      ok: true,
      deployment: {
        revisionId: revision.revisionId,
        providerVersionId: candidateVersionId,
        providerDeploymentId,
        status: "known_good",
      },
    });
    const serialized = JSON.stringify(requests);
    expect(serialized).not.toMatch(
      /(workos|oauth.?token|authorization|cookie|shared_d1|shared_r2)/i,
    );
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "assets",
          assets: [expect.objectContaining({ path: "/index.html" })],
        }),
        expect.objectContaining({
          kind: "request",
          body: expect.objectContaining({
            kind: "worker_version",
            metadata: expect.objectContaining({
              main_module: "__shiplet_static.mjs",
              limits: { cpu_ms: 25, subrequests: 8 },
            }),
          }),
        }),
      ]),
    );
  });

  it("bootstraps a missing Worker with inert known-good code before uploading and proving the real candidate", async () => {
    const context = setup();
    const revision = cloneRevision();

    const result = await context.orchestrator.deployCustomerRevision({
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision,
    });

    expect(result).toMatchObject({
      ok: true,
      deployment: {
        targetId: context.target.id,
        revisionId: revision.revisionId,
        status: "known_good",
      },
    });
    expect(
      context.provider.operations.map((operation) => operation.kind),
    ).toEqual([
      "has_script",
      "initialize_script",
      "upload_version",
      "prove_candidate",
      "create_deployment",
    ]);
    const promotion = providerRequest(
      context.provider.operations.at(-1)!.input,
    );
    expect(promotion).toMatchObject({
      actorId: context.target.ownerUserId,
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      percentage: 100,
      revisionId: revision.revisionId,
      packageDigest: revision.packageDigest,
    });
    const bootstrap = providerRequest(context.provider.operations[1].input);
    expect(bootstrap).toMatchObject({
      actorId: context.target.ownerUserId,
      targetId: context.target.id,
      accountId: context.target.providerAccountId,
      scriptName: context.target.providerScriptName,
      bootstrap: { kind: "inert_known_good" },
    });
    expect(JSON.stringify(bootstrap)).not.toContain(revision.packageDigest);
    expect(JSON.stringify(bootstrap)).not.toContain(
      revision.staticAssets[0].content,
    );
    const uploadMetadata = providerRequest(
      context.provider.operations[2].input,
    );
    expect(uploadMetadata).toMatchObject({
      actorId: context.target.ownerUserId,
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      mainModule: "__shiplet_static.mjs",
      limits: { cpuMs: 25, subRequests: 8 },
      egress: { status: "customer_controlled_unrestricted" },
      staticAssets: [expect.objectContaining({ path: "/index.html" })],
    });
    const proof = providerRequest(context.provider.operations[3].input);
    expect(proof).toMatchObject({
      actorId: context.target.ownerUserId,
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revisionId: revision.revisionId,
      healthCheck: { path: "/__shiplet/health", expectedStatus: 200 },
    });
    const upload = providerRequest(context.provider.operations[2].input);
    expect(upload).toMatchObject({
      accountId: context.target.providerAccountId,
      scriptName: context.target.providerScriptName,
      packageDigest: revision.packageDigest,
    });
  });

  it("uploads an undeployed immutable version for later revisions", async () => {
    const context = setup();
    context.provider.scriptExists = true;
    const prior = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    context.repository.seedKnownGood(prior);

    const result = await context.orchestrator.deployCustomerRevision({
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
    });

    expect(result.ok).toBe(true);
    expect(
      context.provider.operations.map((operation) => operation.kind),
    ).toEqual([
      "has_script",
      "upload_version",
      "prove_candidate",
      "create_deployment",
    ]);
    const current = await context.repository.getKnownGood(context.target.id);
    expect(current?.supersedesDeploymentId).toBe(prior.id);
  });

  it("requires preview proof that the exact candidate version executed", async () => {
    const context = setup();
    const prior = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    context.repository.seedKnownGood(prior);
    context.provider.previewObservedVersionId = runtimeId("different_version");

    const result = await context.orchestrator.deployCustomerRevision({
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "candidate_version_mismatch",
    });
    expect(
      context.provider.operations.map((operation) => operation.kind),
    ).not.toContain("create_deployment");
    expect((await context.repository.getKnownGood(context.target.id))?.id).toBe(
      prior.id,
    );
  });

  it("leaves the prior known-good deployment untouched when health or provider promotion fails", async () => {
    for (const failure of ["health", "deployment"] as const) {
      const context = setup();
      const prior = knownGood(
        context.target,
        "revision_a1",
        "provider_version_a1",
      );
      context.repository.seedKnownGood(prior);
      if (failure === "health") context.provider.previewHealthy = false;
      if (failure === "deployment") context.provider.deploymentSucceeds = false;

      const result = await context.orchestrator.deployCustomerRevision({
        actor: actorFor(context.target),
        shipletId: context.target.shipletId,
        targetId: context.target.id,
        revision: cloneRevision(),
      });

      expect(result.ok, failure).toBe(false);
      expect(
        (await context.repository.getKnownGood(context.target.id))?.id,
      ).toBe(prior.id);
      expect(context.repository.failures).toHaveLength(1);
    }
  });

  it("rolls back by creating a new provider deployment and does not rewind namespaced state", async () => {
    const context = setup();
    const revisionOne = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    const revisionTwo = knownGood(
      context.target,
      "revision_a2",
      "provider_version_a2",
    );
    revisionTwo.supersedesDeploymentId = revisionOne.id;
    context.repository.deployments.set(revisionOne.id, revisionOne);
    context.repository.seedKnownGood(revisionTwo);
    context.repository.state.set(
      `${context.target.shipletId}:${context.target.id}:app:key`,
      { value: "current-state", version: 7 },
    );
    const beforeState = structuredClone([...context.repository.state]);

    const result = await context.orchestrator.rollbackCustomerRevision({
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      toDeploymentId: revisionOne.id,
      expectedKnownGoodDeploymentId: revisionTwo.id,
    });

    expect(result).toMatchObject({
      ok: true,
      deployment: {
        revisionId: revisionOne.revisionId,
        providerVersionId: revisionOne.providerVersionId,
        supersedesDeploymentId: revisionTwo.id,
      },
    });
    expect(result.ok && result.deployment.id).not.toBe(revisionOne.id);
    expect(context.provider.operations).toHaveLength(1);
    expect(context.provider.operations[0]).toMatchObject({
      kind: "create_deployment",
      input: { versionId: revisionOne.providerVersionId, percentage: 100 },
    });
    expect([...context.repository.state]).toEqual(beforeState);
  });

  it("blocks a revoked connection without stopping or deleting the last customer runtime", async () => {
    const context = setup();
    const prior = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    context.repository.seedKnownGood(prior);
    context.connectionAuthorizer.status = "revoked";

    const result = await context.orchestrator.deployCustomerRevision({
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
    });

    expect(result).toEqual({ ok: false, reason: "connection_revoked" });
    expect(context.provider.operations).toHaveLength(0);
    expect((await context.repository.getKnownGood(context.target.id))?.id).toBe(
      prior.id,
    );
  });

  it("refuses guessed sibling targets and target resources owned by another scope", async () => {
    const context = setup();
    const siblingTarget = cloneTarget();
    siblingTarget.id = "target_customer_b";
    siblingTarget.shipletId = "shiplet_b";
    context.repository.targets.set(siblingTarget.id, siblingTarget);

    const guessed = await context.orchestrator.deployCustomerRevision({
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: siblingTarget.id,
      revision: cloneRevision(),
    });
    expect(guessed).toEqual({ ok: false, reason: "target_not_found" });

    context.target.resourceBindings.push({
      name: "FOREIGN_STATE",
      kind: "d1",
      providerResourceId: "customer_b_state",
      ownerShipletId: siblingTarget.shipletId,
      ownerTargetId: siblingTarget.id,
    });
    context.repository.targets.set(context.target.id, context.target);
    const crossScopedBinding =
      await context.orchestrator.deployCustomerRevision({
        actor: actorFor(context.target),
        shipletId: context.target.shipletId,
        targetId: context.target.id,
        revision: cloneRevision(),
      });

    expect(crossScopedBinding).toEqual({
      ok: false,
      reason: "target_resource_scope_mismatch",
    });
    expect(context.provider.operations).toHaveLength(0);
  });

  it("builds customer Workers only with validated target-owned resources and public configuration", async () => {
    const context = setup();

    await context.orchestrator.deployCustomerRevision({
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
    });

    const uploadOperation = context.provider.operations.find(
      (operation) => operation.kind === "initialize_script",
    )!;
    const upload = providerRequest(uploadOperation.input);
    expect(upload.bindings).toEqual([
      {
        name: "APP_STATE",
        kind: "d1",
        providerResourceId: "customer_a_state",
      },
      {
        name: "PUBLIC_CONFIGURATION",
        kind: "plain_text",
        value: "review-enabled",
      },
    ]);
    const serialized = JSON.stringify(upload).toLowerCase();
    for (const forbidden of [
      "workos",
      "oauth",
      "platform_db",
      "shared_d1",
      "shared_r2",
      "shared_do",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("binds every provider call to a non-optional owner/account/expiry grant with operation-specific scopes", async () => {
    const context = setup();
    context.provider.scriptExists = true;
    const prior = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    context.repository.seedKnownGood(prior);

    await deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("operation"),
    });

    const expectedAuthority = new Map([
      ["has_script", ["workers_scripts_read"]],
      ["upload_version", ["workers_scripts_write"]],
      ["prove_candidate", ["workers_scripts_read"]],
      ["create_deployment", ["workers_scripts_write"]],
    ]);
    for (const operation of context.provider.operations) {
      const expectedScopes = expectedAuthority.get(operation.kind);
      if (!expectedScopes) continue;
      const authorization = operation.input.authorization as
        | { handle?: string; operation?: string }
        | undefined;
      expect(authorization?.handle, operation.kind).toBeTruthy();
      const grant = authorization?.handle
        ? context.connectionAuthorizer.grants.get(authorization.handle)
        : undefined;
      expect(grant, operation.kind).toMatchObject({
        userId: context.target.ownerUserId,
        accountId: context.target.providerAccountId,
        operation: authorization?.operation,
        scopes: expectedScopes,
      });
      expect(grant?.expiresAt, operation.kind).toBeGreaterThan(40_000);
      expect(providerRequest(operation.input)).not.toHaveProperty(
        "authorization",
      );
    }
    expect(
      context.connectionAuthorizer.requests.map((request) => request.operation),
    ).toEqual([
      "worker.inspect",
      "worker.version.upload",
      "worker.candidate.prove",
      "worker.deployment.promote",
    ]);
  });

  it("reserves a per-target journal before provider mutation and rejects a concurrent deploy before a second provider activation", async () => {
    const context = setup();
    context.provider.scriptExists = true;
    const prior = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    context.repository.seedKnownGood(prior);
    context.provider.liveVersionId = prior.providerVersionId;
    const gate = context.provider.pauseDeployment(1);
    const firstRevision = cloneRevision();
    const secondRevision = {
      ...cloneRevision(),
      revisionId: "revision_a3",
      packageDigest: "sha256-revision-a3",
    };
    const first = deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: firstRevision,
      idempotencyKey: runtimeId("operation"),
    });
    await gate.entered;
    const second = deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: secondRevision,
      idempotencyKey: runtimeId("operation"),
    });
    const observation = await Promise.race([
      second.then((result) => ({ kind: "result" as const, result })),
      context.provider
        .waitForDeploymentCount(2)
        .then(() => ({ kind: "provider_called_twice" as const })),
    ]);
    gate.release();
    await first;
    const secondResult = await second;

    expect(observation.kind).toBe("result");
    expect(secondResult).toEqual({
      ok: false,
      reason: "operation_in_progress",
    });
    expect(
      context.provider.operations.filter(
        (operation) => operation.kind === "create_deployment",
      ),
    ).toHaveLength(1);
    expect(context.repository.reservations).toHaveLength(2);
    const current = await context.repository.getKnownGood(context.target.id);
    expect(context.provider.liveVersionId).toBe(current?.providerVersionId);
  });

  it("replays an idempotent deployment result without another provider mutation", async () => {
    const context = setup();
    context.provider.scriptExists = true;
    const prior = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    context.repository.seedKnownGood(prior);
    const operation = {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("operation"),
    };

    const first = await deployWithOperation(context, operation);
    const second = await deployWithOperation(context, operation);

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(
      context.provider.operations.filter(
        (providerOperation) => providerOperation.kind === "create_deployment",
      ),
    ).toHaveLength(1);
  });

  it("compensates a failed finalize so provider live version and repository known-good cannot diverge", async () => {
    const context = setup();
    context.provider.scriptExists = true;
    const prior = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    context.repository.seedKnownGood(prior);
    context.provider.liveVersionId = prior.providerVersionId;
    context.repository.failNextCommit = true;

    const result = await deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("operation"),
    });

    expect(result).toEqual({ ok: false, reason: "deployment_conflict" });
    expect(
      context.provider.operations.filter(
        (operation) => operation.kind === "create_deployment",
      ),
    ).toHaveLength(2);
    expect(context.provider.liveVersionId).toBe(prior.providerVersionId);
    expect((await context.repository.getKnownGood(context.target.id))?.id).toBe(
      prior.id,
    );
    expect(
      [...context.repository.journals.values()].map(
        (journal) => journal.status,
      ),
    ).toContain("compensated");
  });

  it("serializes concurrent rollback before provider mutation", async () => {
    const context = setup();
    const revisionOne = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    const revisionTwo = knownGood(
      context.target,
      "revision_a2",
      "provider_version_a2",
    );
    const revisionThree = knownGood(
      context.target,
      "revision_a3",
      "provider_version_a3",
    );
    context.repository.deployments.set(revisionOne.id, revisionOne);
    context.repository.deployments.set(revisionTwo.id, revisionTwo);
    context.repository.seedKnownGood(revisionThree);
    context.provider.liveVersionId = revisionThree.providerVersionId;
    const gate = context.provider.pauseDeployment(1);
    const first = rollbackWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      toDeploymentId: revisionOne.id,
      expectedKnownGoodDeploymentId: revisionThree.id,
      idempotencyKey: runtimeId("operation"),
    });
    await gate.entered;
    const second = rollbackWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      toDeploymentId: revisionTwo.id,
      expectedKnownGoodDeploymentId: revisionThree.id,
      idempotencyKey: runtimeId("operation"),
    });
    const observation = await Promise.race([
      second.then((result) => ({ kind: "result" as const, result })),
      context.provider
        .waitForDeploymentCount(2)
        .then(() => ({ kind: "provider_called_twice" as const })),
    ]);
    gate.release();
    await first;
    const secondResult = await second;

    expect(observation.kind).toBe("result");
    expect(secondResult).toEqual({
      ok: false,
      reason: "operation_in_progress",
    });
    expect(
      context.provider.operations.filter(
        (operation) => operation.kind === "create_deployment",
      ),
    ).toHaveLength(1);
    const current = await context.repository.getKnownGood(context.target.id);
    expect(context.provider.liveVersionId).toBe(current?.providerVersionId);
  });

  it("resolves bindings from kernel resource records rather than trusting self-described owner labels", async () => {
    const context = setup();
    context.target.resourceBindings = [
      {
        name: "APP_STATE",
        kind: "d1",
        providerResourceId: "customer_b_state",
        ownerShipletId: context.target.shipletId,
        ownerTargetId: context.target.id,
      },
    ];
    context.repository.targets.set(context.target.id, context.target);

    await deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("operation"),
    });

    const upload = context.provider.operations.find(
      (operation) => operation.kind === "upload_version",
    );
    const candidate =
      upload ??
      context.provider.operations.find(
        (operation) => operation.kind === "initialize_script",
      )!;
    expect(providerRequest(candidate.input).bindings).toEqual([
      {
        name: "APP_STATE",
        kind: "d1",
        providerResourceId: "customer_a_state",
      },
      {
        name: "PUBLIC_CONFIGURATION",
        kind: "plain_text",
        value: "review-enabled",
      },
    ]);
  });

  it("rejects plain-text configuration unless the kernel resource record marks it public", async () => {
    const context = setup();
    context.target.resourceBindingRefs = [
      "resource_customer_a_private_configuration",
    ];
    context.repository.targets.set(context.target.id, context.target);

    const result = await deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("operation"),
    });

    expect(result).toEqual({
      ok: false,
      reason: "plain_text_configuration_not_public",
    });
    expect(context.provider.operations).toHaveLength(0);
  });

  it.each(["revision", "script", "operation"] as const)(
    "rejects idempotency reuse when the canonical %s intent changes",
    async (mutation) => {
      const context = setup();
      context.provider.scriptExists = true;
      const prior = knownGood(
        context.target,
        "revision_a1",
        "provider_version_a1",
      );
      context.repository.seedKnownGood(prior);
      const idempotencyKey = runtimeId("canonical_intent");
      const revision = cloneRevision();
      const first = await deployWithOperation(context, {
        actor: actorFor(context.target),
        shipletId: context.target.shipletId,
        targetId: context.target.id,
        revision,
        idempotencyKey,
      });
      expect(first.ok).toBe(true);

      let second: { ok: boolean; reason?: string };
      if (mutation === "operation") {
        second = await rollbackWithOperation(context, {
          actor: actorFor(context.target),
          shipletId: context.target.shipletId,
          targetId: context.target.id,
          toDeploymentId: prior.id,
          expectedKnownGoodDeploymentId: first.deployment!.id,
          idempotencyKey,
        });
      } else {
        if (mutation === "script") {
          const changedTarget = cloneTarget();
          changedTarget.providerScriptName = "shiplet-a-target-a-renamed";
          context.repository.targets.set(changedTarget.id, changedTarget);
        }
        const changedRevision =
          mutation === "revision"
            ? {
                ...cloneRevision(),
                revisionId: "revision_a3",
                packageDigest: "sha256-revision-a3",
              }
            : revision;
        second = await deployWithOperation(context, {
          actor: actorFor(context.target),
          shipletId: context.target.shipletId,
          targetId: context.target.id,
          revision: changedRevision,
          idempotencyKey,
        });
      }

      expect(second, mutation).toEqual({
        ok: false,
        reason: "idempotency_intent_mismatch",
      });
      expect(context.repository.reservations[0], mutation).toMatchObject({
        intentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(
        context.provider.operations.filter(
          (operation) => operation.kind === "create_deployment",
        ),
        mutation,
      ).toHaveLength(1);
    },
  );

  it("replays finalized idempotent work from the durable journal across orchestrator instances", async () => {
    const context = setup();
    context.provider.scriptExists = true;
    context.repository.seedKnownGood(
      knownGood(context.target, "revision_a1", "provider_version_a1"),
    );
    const operation = {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("durable_idempotency"),
    };
    const first = await deployWithOperation(context, operation);
    const freshOrchestrator = context.createOrchestrator();
    const freshDeploy = freshOrchestrator.deployCustomerRevision as unknown as (
      input: CustomerDeploymentOperation,
    ) => Promise<{
      ok: boolean;
      reason?: string;
      deployment?: DeploymentRecord;
    }>;

    const replay = await freshDeploy(operation);

    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(
      context.provider.operations.filter(
        (operation) => operation.kind === "create_deployment",
      ),
    ).toHaveLength(1);
  });

  it("authorizes every provider request for the exact target, script, revision, and canonical request digest", async () => {
    const context = setup();
    context.provider.scriptExists = true;
    context.repository.seedKnownGood(
      knownGood(context.target, "revision_a1", "provider_version_a1"),
    );
    const revision = cloneRevision();

    const result = await deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision,
      idempotencyKey: runtimeId("bound_authorization"),
    });

    expect(result.ok).toBe(true);
    for (const operation of context.provider.operations) {
      if (
        ![
          "has_script",
          "upload_version",
          "prove_candidate",
          "create_deployment",
        ].includes(operation.kind)
      ) {
        continue;
      }
      const authorization = operation.input.authorization as
        | { handle?: string }
        | undefined;
      const grant = authorization?.handle
        ? context.connectionAuthorizer.grants.get(authorization.handle)
        : undefined;
      const request = providerRequest(operation.input);
      expect(grant, operation.kind).toMatchObject({
        targetId: context.target.id,
        scriptName: context.target.providerScriptName,
        revisionId: revision.revisionId,
        packageDigest: revision.packageDigest,
        requestDigest: await sha256Digest(request),
      });
    }
  });

  it("binds rollback authorization to the selected revision and exact provider request", async () => {
    const context = setup();
    const selected = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    const current = knownGood(
      context.target,
      "revision_a2",
      "provider_version_a2",
    );
    context.repository.deployments.set(selected.id, selected);
    context.repository.seedKnownGood(current);

    const result = await rollbackWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      toDeploymentId: selected.id,
      expectedKnownGoodDeploymentId: current.id,
      idempotencyKey: runtimeId("bound_rollback_authorization"),
    });

    expect(result.ok).toBe(true);
    const providerOperation = context.provider.operations.find(
      (operation) => operation.kind === "create_deployment",
    )!;
    const authorization = providerOperation.input.authorization as {
      handle: string;
    };
    const request = providerRequest(providerOperation.input);
    expect(request).toMatchObject({
      revisionId: selected.revisionId,
      packageDigest: "sha256-revision-a1",
    });
    expect(
      context.connectionAuthorizer.grants.get(authorization.handle),
    ).toMatchObject({
      targetId: context.target.id,
      scriptName: context.target.providerScriptName,
      revisionId: selected.revisionId,
      packageDigest: "sha256-revision-a1",
      requestDigest: await sha256Digest(request),
    });
  });

  it("revalidates kernel-owned resource records after reservation and immediately before upload", async () => {
    const context = setup();
    context.provider.scriptExists = true;
    context.repository.seedKnownGood(
      knownGood(context.target, "revision_a1", "provider_version_a1"),
    );
    const gate = context.provider.pauseInspect();
    const deployment = deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("resource_revalidation"),
    });
    await gate.entered;
    const resource = context.repository.resources.get(
      "resource_customer_a_state",
    )!;
    resource.shipletId = "shiplet_b";
    resource.targetId = "target_customer_b";
    resource.providerResourceId = "customer_b_state";
    gate.release();

    const result = await deployment;

    expect(result).toEqual({
      ok: false,
      reason: "target_resource_scope_mismatch",
    });
    expect(
      context.provider.operations.map((operation) => operation.kind),
    ).not.toContain("upload_version");
    expect(
      [...context.repository.journals.values()].map(
        (journal) => journal.status,
      ),
    ).toEqual(["aborted"]);
  });

  it.each([
    "authorization_denied",
    "authorization_throw",
    "inspect",
    "upload",
    "proof",
    "promotion",
    "repository_failure_write",
    "repository_finalize",
    "audit",
  ] as const)("durably classifies and fences a %s fault", async (fault) => {
    const context = setup();
    context.provider.scriptExists = true;
    context.repository.seedKnownGood(
      knownGood(context.target, "revision_a1", "provider_version_a1"),
    );
    if (fault === "authorization_denied") {
      context.connectionAuthorizer.status = "revoked";
    }
    if (fault === "authorization_throw") {
      context.connectionAuthorizer.throwOnAuthorize = true;
    }
    if (fault === "inspect") context.provider.hasScriptSucceeds = false;
    if (fault === "upload") context.provider.uploadSucceeds = false;
    if (fault === "proof") context.provider.proofSucceeds = false;
    if (fault === "promotion") context.provider.deploymentSucceeds = false;
    if (fault === "repository_failure_write") {
      context.provider.hasScriptSucceeds = false;
      context.repository.recordFailureThrows = true;
    }
    if (fault === "repository_finalize")
      context.repository.finalizeThrows = true;
    if (fault === "audit") {
      context.auditControl.throwOnceFor = "cloudflare.deployment.promoted";
    }
    const idempotencyKey = runtimeId(`fault_${fault}`);
    const first = deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
      idempotencyKey,
    });

    const settled = await first.then(
      (value) => ({ kind: "resolved" as const, value }),
      () => ({ kind: "rejected" as const }),
    );
    expect(settled.kind, fault).toBe("resolved");
    const journal = [...context.repository.journals.values()].find(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    if (fault === "promotion") {
      expect(journal).toMatchObject({
        status: "reconcile_required",
        failureReason: "provider_deployment_outcome_ambiguous",
      });
    } else {
      expect(["failed", "aborted", "reconcile_required"], fault).toContain(
        journal?.status,
      );
    }

    context.connectionAuthorizer.status = "active";
    context.connectionAuthorizer.throwOnAuthorize = false;
    context.provider.hasScriptSucceeds = true;
    context.provider.uploadSucceeds = true;
    context.provider.proofSucceeds = true;
    context.provider.deploymentSucceeds = true;
    context.repository.recordFailureThrows = false;
    context.repository.finalizeThrows = false;
    const retry = await deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: {
        ...cloneRevision(),
        revisionId: `revision_retry_${fault}`,
        packageDigest: `sha256-retry-${fault}`,
      },
      idempotencyKey: runtimeId(`retry_${fault}`),
    });
    if (fault === "promotion") {
      expect(settled).toMatchObject({
        kind: "resolved",
        value: {
          ok: false,
          reason: "deployment_reconciliation_required",
        },
      });
      expect(retry).toEqual({
        ok: false,
        reason: "operation_in_progress",
      });
    } else {
      expect(retry.reason, fault).not.toBe("operation_in_progress");
    }
  });

  it("fences rollback after an ambiguous provider mutation until reconciliation", async () => {
    const context = setup();
    const selected = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    const current = knownGood(
      context.target,
      "revision_a2",
      "provider_version_a2",
    );
    context.repository.deployments.set(selected.id, selected);
    context.repository.seedKnownGood(current);
    context.provider.deploymentSucceeds = false;
    const idempotencyKey = runtimeId("rollback_fault");

    const failed = await rollbackWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      toDeploymentId: selected.id,
      expectedKnownGoodDeploymentId: current.id,
      idempotencyKey,
    });
    const journal = [...context.repository.journals.values()].find(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    context.provider.deploymentSucceeds = true;
    const retry = await deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("rollback_fault_retry"),
    });

    expect(failed).toEqual({
      ok: false,
      reason: "deployment_reconciliation_required",
    });
    expect(journal).toMatchObject({
      status: "reconcile_required",
      failureReason: "provider_deployment_outcome_ambiguous",
    });
    expect(retry).toEqual({
      ok: false,
      reason: "operation_in_progress",
    });
  });

  it("revalidates the exact target attachment immediately after promotion authorization", async () => {
    const context = setup();
    context.provider.scriptExists = true;
    context.repository.seedKnownGood(
      knownGood(context.target, "revision_a1", "provider_version_a1"),
    );
    context.connectionAuthorizer.afterAuthorize = (authorization) => {
      if (authorization.operation === "worker.deployment.promote") {
        const current = context.repository.targets.get(context.target.id)!;
        current.status = "revoked";
      }
    };

    const result = await deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("promotion_attachment_revalidation"),
    });

    expect(result).toEqual({ ok: false, reason: "connection_revoked" });
    expect(
      context.provider.operations.filter(
        (operation) => operation.kind === "create_deployment",
      ),
    ).toHaveLength(0);
  });
});

describe("managed Workers for Platforms invocation policy", () => {
  it("uses only current cpuMs/subRequests limits and deny-by-default outbound metadata", () => {
    const policy = createManagedInvocationPolicy(
      structuredClone(managedInvocationFixture),
    );

    expect(policy.limits).toEqual({ cpuMs: 50, subRequests: 4 });
    expect(Object.keys(policy.limits).sort()).toEqual(["cpuMs", "subRequests"]);
    expect(policy.bindings).toEqual([]);
    expect(policy.outbound).toEqual({
      mode: "deny_all",
      metadata: {
        invocationId: managedInvocationFixture.invocationId,
        egressGrantIds: [],
      },
    });
    const metadataKeys = allKeys(policy.outbound.metadata);
    for (const forbidden of ["shipletid", "revisionid", "deploymentid"]) {
      expect(metadataKeys.has(forbidden), forbidden).toBe(false);
    }
  });

  it("rejects requested CPU or subrequest limits above trusted kernel maxima", () => {
    const input = structuredClone(
      managedInvocationFixture,
    ) as typeof managedInvocationFixture & {
      trustedMaximums: { cpuMs: number; subRequests: number };
    };
    input.limits.cpuMs = input.trustedMaximums.cpuMs + 1;

    expect(() => createManagedInvocationPolicy(input)).toThrow(
      "managed_limit_exceeded",
    );
  });

  it("rejects undeclared, revoked, or cross-scope egress grant IDs", () => {
    for (const grant of [
      { status: "missing" },
      {
        status: "revoked",
        shipletId: managedInvocationFixture.shipletId,
        revisionId: managedInvocationFixture.revisionId,
        deploymentId: managedInvocationFixture.deploymentId,
      },
      {
        status: "active",
        shipletId: "shiplet_b",
        revisionId: managedInvocationFixture.revisionId,
        deploymentId: managedInvocationFixture.deploymentId,
      },
    ] as const) {
      const grantId = runtimeId("egress_grant");
      const input = {
        ...structuredClone(managedInvocationFixture),
        egressGrantIds: [grantId],
        authorizedEgressGrants:
          grant.status === "missing" ? [] : [{ id: grantId, ...grant }],
      };

      expect(() => createManagedInvocationPolicy(input), grant.status).toThrow(
        "egress_grant_not_authorized",
      );
    }
  });

  it("passes only opaque IDs for active grants bound to the exact managed invocation scope", () => {
    const grantId = runtimeId("egress_grant");
    const input = {
      ...structuredClone(managedInvocationFixture),
      egressGrantIds: [grantId],
      authorizedEgressGrants: [
        {
          id: grantId,
          status: "active",
          shipletId: managedInvocationFixture.shipletId,
          revisionId: managedInvocationFixture.revisionId,
          deploymentId: managedInvocationFixture.deploymentId,
        },
      ],
    };

    const policy = createManagedInvocationPolicy(input);

    expect(policy.outbound).toEqual({
      mode: "brokered",
      metadata: {
        invocationId: managedInvocationFixture.invocationId,
        egressGrantIds: [grantId],
      },
    });
    expect(allKeys(policy.outbound.metadata).has("shipletid")).toBe(false);
  });
});

describe("temporary preview-and-claim orchestration", () => {
  it("canonicalizes persisted static paths through the real production temporary adapter", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_production_adapter",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    let brokerRequest: Record<string, unknown> | null = null;
    const provider = createCloudflareCustomerDeploymentProvider({
      now: () => 40_000,
      grants: {
        async withGrant() {
          throw new Error("customer_grant_not_expected");
        },
      },
      temporaryAccounts: {
        async createAndDeploy(input) {
          brokerRequest = structuredClone(input.request);
          const authorization = input.authorization;
          const providerVersionId = crypto.randomUUID();
          return {
            providerDeploymentId: crypto.randomUUID(),
            providerVersionId,
            selectedVersionId: providerVersionId,
            temporaryAuthorizationHandle:
              createCloudflareOpaqueTemporaryAuthorizationHandle(),
            claimHandle: createCloudflareTemporaryClaimHandle(),
            binding: {
              userId: authorization.userId,
              shipletId: authorization.shipletId,
              accountHandle: authorization.accountHandle,
              targetId: authorization.targetId,
              scriptName: authorization.scriptName,
              revisionId: authorization.revisionId,
              packageDigest: authorization.packageDigest,
              requestDigest: authorization.requestDigest,
              operationId: authorization.operationId,
            },
            expiresAt: 50_000,
            serializedBodyBytes: 512,
          };
        },
        async cleanup(input) {
          const authorization = input.authorization;
          return {
            success: true,
            selectedVersionId: String(input.request.providerVersionId),
            binding: {
              userId: authorization.userId,
              shipletId: authorization.shipletId,
              accountHandle: authorization.accountHandle,
              targetId: authorization.targetId,
              scriptName: authorization.scriptName,
              revisionId: authorization.revisionId,
              packageDigest: authorization.packageDigest,
              requestDigest: authorization.requestDigest,
              operationId: authorization.operationId,
            },
            serializedBodyBytes: 128,
          };
        },
      },
      trustedControlPlaneOrigin: "https://shiplet.invalid",
    });
    const orchestrator = context.createOrchestratorWithProvider(provider);

    const result = await orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: {
        shipletId: target.shipletId,
        revisionId: "revision_temporary_adapter",
        packageDigest: `sha256:${"c".repeat(64)}`,
        modules: [],
        staticAssets: [
          {
            path: "index.html",
            mediaType: "text/html",
            content: "<h1>Temporary adapter</h1>",
          },
        ],
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(brokerRequest).toMatchObject({
      staticAssets: [expect.objectContaining({ path: "/index.html" })],
    });
  });

  it("refuses to contact the provider without exact human policy acceptance", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_policy",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);

    const result = await context.orchestrator.createTemporaryClaimDeployment({
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "cloudflare_policy_acceptance_required",
    });
    expect(
      context.provider.operations.filter(
        (operation) => operation.kind === "create_temporary_deployment",
      ),
    ).toHaveLength(0);
    expect(context.repository.reservations).toHaveLength(0);
  });

  it("vaults temporary authorization and claim location while excluding them from public, audit, telemetry, and Worker data", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_a",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);

    const result = await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
    });

    const createOperation = context.provider.operations.find(
      (operation) => operation.kind === "create_temporary_deployment",
    )!;
    const createAuthorization = createOperation.input.authorization as {
      handle: string;
    };
    const createRequest = providerRequest(createOperation.input);
    expect(createRequest).toMatchObject({
      actorId: target.ownerUserId,
      targetId: target.id,
      revisionId: "revision_a2",
      packageDigest: "sha256-revision-a2",
      bindings: [],
    });
    expect(
      context.temporaryDeploymentAuthorizer.grants.get(
        createAuthorization.handle,
      ),
    ).toMatchObject({
      userId: target.ownerUserId,
      targetId: target.id,
      revisionId: "revision_a2",
      packageDigest: "sha256-revision-a2",
      operation: "temporary.deployment.create",
      requestDigest: await sha256Digest(createRequest),
    });

    expect(result).toMatchObject({
      ok: true,
      deployment: {
        targetId: target.id,
        requiresOAuthConnectionForUpdates: true,
        expiresAt: 60_000,
      },
    });
    expect(context.claimVault.records).toHaveLength(1);
    expect(context.claimVault.records[0].temporaryAuthorization).toBe(
      context.provider.temporaryAuthorization,
    );
    expect(context.claimVault.records[0].claimUrl).toBe(
      context.provider.claimUrl,
    );
    expect(context.repository.temporaryClaims.get(target.id)).toMatchObject({
      vaultRef: context.claimVault.records[0].ref,
      status: "awaiting_claim",
      expiresAt: 60_000,
    });

    for (const surface of [result, context.audit, context.telemetry]) {
      expect(
        containsReference(surface, context.provider.temporaryAuthorization),
      ).toBe(false);
      expect(containsReference(surface, context.provider.claimUrl)).toBe(false);
      const keys = allKeys(surface);
      for (const forbidden of [
        "temporaryauthorization",
        "claimurl",
        "credential",
        "authorizationcode",
      ]) {
        expect(keys.has(forbidden), forbidden).toBe(false);
      }
    }

    const providerInput = context.provider.operations[0].input;
    expect(
      containsReference(providerInput, context.provider.temporaryAuthorization),
    ).toBe(false);
    expect(containsReference(providerInput, context.provider.claimUrl)).toBe(
      false,
    );
  });

  it("requires a separate normal OAuth connection for every post-claim update", async () => {
    const context = setup();
    const claimedTarget: DeploymentTarget = {
      ...context.target,
      id: "target_claimed_a",
      kind: "temporary_claim",
      connectionId: null,
      status: "claimed",
      resourceBindings: [],
    };
    context.repository.targets.set(claimedTarget.id, claimedTarget);

    const result = await context.orchestrator.deployCustomerRevision({
      actor: actorFor(claimedTarget),
      shipletId: claimedTarget.shipletId,
      targetId: claimedTarget.id,
      revision: cloneRevision(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "oauth_connection_required",
    });
    expect(context.provider.operations).toHaveLength(0);
  });

  it("replays one prepared backend redirect without returning claim material", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_once",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
    });
    const consume = (
      context.orchestrator as unknown as {
        consumeTemporaryClaim(input: {
          actor: HumanActor;
          shipletId: string;
          targetId: string;
        }): Promise<Record<string, unknown>>;
      }
    ).consumeTemporaryClaim.bind(context.orchestrator);

    const first = await consume({
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
    });
    const second = await consume({
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
    });

    expect(first).toEqual({ ok: true, status: "redirect_ready" });
    expect(second).toEqual({ ok: true, status: "redirect_ready" });
    for (const forbidden of [
      "claimurl",
      "temporaryauthorization",
      "vaultref",
    ]) {
      expect(allKeys(first).has(forbidden), forbidden).toBe(false);
    }
  });

  it("rejects expired or already-claimed temporary claim consumption", async () => {
    for (const scenario of ["expired", "claimed"] as const) {
      const context = setup();
      const target: DeploymentTarget = {
        ...context.target,
        id: `target_temporary_${scenario}`,
        kind: "temporary_claim",
        connectionId: null,
        status: "connected",
        resourceBindings: [],
      };
      context.repository.targets.set(target.id, target);
      await context.orchestrator.createTemporaryClaimDeployment({
        ...acceptedCloudflareTemporaryAccountPolicies(),
        actor: actorFor(target),
        shipletId: target.shipletId,
        targetId: target.id,
        revision: cloneRevision(),
      });
      if (scenario === "expired") context.advance(20_001);
      if (scenario === "claimed") {
        target.status = "claimed";
        context.repository.targets.set(target.id, target);
      }
      const consume = (
        context.orchestrator as unknown as {
          consumeTemporaryClaim(input: {
            actor: HumanActor;
            shipletId: string;
            targetId: string;
          }): Promise<Record<string, unknown>>;
        }
      ).consumeTemporaryClaim.bind(context.orchestrator);

      const result = await consume({
        actor: actorFor(target),
        shipletId: target.shipletId,
        targetId: target.id,
      });

      expect(result).toEqual({
        ok: false,
        reason:
          scenario === "expired" ? "claim_expired" : "claim_already_claimed",
      });
    }
  });

  it("rejects temporary claim delivery at the exact expiration boundary", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_exact_expiry",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
    });
    context.advance(20_000);
    const consume = (
      context.orchestrator as unknown as {
        consumeTemporaryClaim(input: {
          actor: HumanActor;
          shipletId: string;
          targetId: string;
        }): Promise<Record<string, unknown>>;
      }
    ).consumeTemporaryClaim.bind(context.orchestrator);

    await expect(
      consume({
        actor: actorFor(target),
        shipletId: target.shipletId,
        targetId: target.id,
      }),
    ).resolves.toEqual({ ok: false, reason: "claim_expired" });
  });

  it("cleans up a provider temporary deployment when claim vault persistence fails", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_vault_failure",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    context.claimVault.storeSucceeds = false;

    const result = context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
    });

    await expect(result).resolves.toEqual({
      ok: false,
      reason: "claim_vault_failed",
    });
    expect(
      context.provider.operations.map((operation) => operation.kind),
    ).toEqual(["create_temporary_deployment", "cleanup_temporary_deployment"]);
    const cleanupRequest = providerRequest(
      context.provider.operations[1].input,
    );
    expect(cleanupRequest).toMatchObject({
      actorId: target.ownerUserId,
      targetId: target.id,
      revisionId: "revision_a2",
      packageDigest: "sha256-revision-a2",
      providerDeploymentId: expect.stringMatching(/^temporary_deployment_/),
      providerVersionId: expect.stringMatching(/^temporary_version_/),
    });
  });

  it("retains a target-wide reconciliation fence after an ambiguous temporary provider throw", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_provider_failure",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    context.provider.temporaryDeploymentSucceeds = false;

    const idempotencyKey = runtimeId("temporary_provider_failure");
    const operation = {
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
      idempotencyKey,
    };

    const result =
      context.orchestrator.createTemporaryClaimDeployment(operation);

    await expect(result).resolves.toEqual({
      ok: false,
      reason: "claim_cleanup_reconciliation_required",
    });
    expect(context.claimVault.records).toHaveLength(0);
    expect(context.repository.temporaryClaims.size).toBe(0);
    expect(
      [...context.repository.journals.values()].find(
        (journal) => journal.idempotencyKey === idempotencyKey,
      ),
    ).toMatchObject({
      status: "reconcile_required",
      failureReason: "temporary_provider_outcome_ambiguous",
    });

    const sameKeyRetry =
      await context.orchestrator.createTemporaryClaimDeployment(operation);
    context.provider.temporaryDeploymentSucceeds = true;
    const differentKeyRetry =
      await context.orchestrator.createTemporaryClaimDeployment({
        ...operation,
        idempotencyKey: runtimeId("temporary_provider_retry"),
      });
    expect(sameKeyRetry).toEqual({
      ok: false,
      reason: "claim_cleanup_reconciliation_required",
    });
    expect(differentKeyRetry).toEqual({
      ok: false,
      reason: "operation_in_progress",
    });
    expect(
      context.provider.operations.filter(
        (entry) => entry.kind === "create_temporary_deployment",
      ),
    ).toHaveLength(2);
  });

  it("fences a structurally invalid temporary provider result that cannot be compensated", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_structural_failure",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    context.provider.temporaryResultOverride = {
      providerDeploymentId: "",
      providerVersionId: "",
      temporaryAuthorization: {},
      claimUrl: "not-a-url",
      expiresAt: 60_000,
    };

    const first = await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("temporary_structural_failure"),
    });
    const retry = await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("temporary_structural_retry"),
    });

    expect(first).toEqual({
      ok: false,
      reason: "claim_cleanup_reconciliation_required",
    });
    expect(retry).toEqual({ ok: false, reason: "operation_in_progress" });
    expect(
      context.provider.operations.filter(
        (entry) => entry.kind === "create_temporary_deployment",
      ),
    ).toHaveLength(1);
  });

  it("journals a retryable cleanup when both claim persistence and provider cleanup fail", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_cleanup_retry",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    context.claimVault.storeSucceeds = false;
    context.provider.cleanupSucceeds = false;

    const result = context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
    });

    await expect(result).resolves.toEqual({
      ok: false,
      reason: "claim_cleanup_retry_required",
    });
    expect(context.repository.temporaryClaims.get(target.id)).toMatchObject({
      status: "cleanup_retry",
    });
  });

  it("serializes temporary claim creation per target before the provider is called twice", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_serialized",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    const gate = context.provider.pauseTemporaryDeployment(1);
    const first = context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("temporary_first"),
    });
    await gate.entered;
    const second = context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: {
        ...cloneRevision(),
        revisionId: "revision_temporary_second",
        packageDigest: "sha256-temporary-second",
      },
      idempotencyKey: runtimeId("temporary_second"),
    });
    const observation = await Promise.race([
      second.then((result) => ({ kind: "result" as const, result })),
      context.provider
        .waitForTemporaryDeploymentCount(2)
        .then(() => ({ kind: "provider_called_twice" as const })),
    ]);
    gate.release();
    await first;
    const secondResult = await second;

    expect(observation.kind).toBe("result");
    expect(secondResult).toEqual({
      ok: false,
      reason: "operation_in_progress",
    });
    expect(
      context.provider.operations.filter(
        (operation) => operation.kind === "create_temporary_deployment",
      ),
    ).toHaveLength(1);
  });

  it("replays a temporary claim creation with the same canonical intent and idempotency key", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_idempotent",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    const operation = {
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("temporary_idempotency"),
    };

    const first =
      await context.orchestrator.createTemporaryClaimDeployment(operation);
    const replay = await context
      .createOrchestrator()
      .createTemporaryClaimDeployment(operation);

    expect(replay).toEqual(first);
    expect(
      context.provider.operations.filter(
        (providerOperation) =>
          providerOperation.kind === "create_temporary_deployment",
      ),
    ).toHaveLength(1);
    expect(context.repository.reservations[0]).toMatchObject({
      operation: "claim_create",
      intentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it("rejects temporary claim idempotency reuse for a different revision", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_idempotency_mismatch",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    const idempotencyKey = runtimeId("temporary_idempotency_mismatch");
    await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
      idempotencyKey,
    });

    const mismatch = await context
      .createOrchestrator()
      .createTemporaryClaimDeployment({
        ...acceptedCloudflareTemporaryAccountPolicies(),
        actor: actorFor(target),
        shipletId: target.shipletId,
        targetId: target.id,
        revision: {
          ...cloneRevision(),
          revisionId: "revision_temporary_changed",
          packageDigest: "sha256-temporary-changed",
        },
        idempotencyKey,
      });

    expect(mismatch).toEqual({
      ok: false,
      reason: "idempotency_intent_mismatch",
    });
    expect(
      context.provider.operations.filter(
        (operation) => operation.kind === "create_temporary_deployment",
      ),
    ).toHaveLength(1);
  });

  it("delivers claim material only through a trusted backend redirect and retains its vault reference for response-loss recovery", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_delivery",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("temporary_delivery"),
    });
    const vaultRef = context.claimVault.records[0].ref;
    const consume = (
      context.orchestrator as unknown as {
        consumeTemporaryClaim(input: {
          actor: HumanActor;
          shipletId: string;
          targetId: string;
        }): Promise<Record<string, unknown>>;
      }
    ).consumeTemporaryClaim.bind(context.orchestrator);

    const publicResult = await consume({
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
    });

    expect(publicResult).toEqual({ ok: true, status: "redirect_ready" });
    expect(context.repository.temporaryClaims.get(target.id)).toMatchObject({
      status: "delivered",
    });
    expect(context.claimVault.records).toHaveLength(1);
    expect(context.claimVault.erasedRefs).toEqual([]);
    expect(context.claimVault.deliveries).toEqual([
      {
        ref: vaultRef,
        redirect: {
          kind: "trusted_backend_redirect",
          opaqueHandle: expect.stringMatching(/^claim_delivery_/),
        },
      },
    ]);
    expect(context.repository.temporaryClaimDeliveryAudits).toContainEqual(
      expect.objectContaining({
        shipletId: target.shipletId,
        revisionId: "revision_a2",
        actor: { kind: "human", id: target.ownerUserId },
      }),
    );
    for (const forbidden of [
      "claimurl",
      "temporaryauthorization",
      "vaultref",
      "redirect",
      "opaquehandle",
    ]) {
      expect(allKeys(publicResult).has(forbidden), forbidden).toBe(false);
    }

    const update = await context.orchestrator.deployCustomerRevision({
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: {
        ...cloneRevision(),
        revisionId: "revision_after_claim",
        packageDigest: "sha256-after-claim",
      },
    });
    expect(update).toEqual({
      ok: false,
      reason: "oauth_connection_required",
    });
  });

  it("retains claim material and creates no redirect when the atomic delivered-state transition conflicts", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_delivery_conflict",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
    });
    const vaultRef = context.claimVault.records[0].ref;
    context.repository.markTemporaryClaimDeliveredFails = true;
    const consume = (
      context.orchestrator as unknown as {
        consumeTemporaryClaim(input: {
          actor: HumanActor;
          shipletId: string;
          targetId: string;
        }): Promise<Record<string, unknown>>;
      }
    ).consumeTemporaryClaim.bind(context.orchestrator);

    const result = await consume({
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
    });

    expect(result).toEqual({ ok: false, reason: "claim_delivery_conflict" });
    expect(context.repository.temporaryClaims.get(target.id)).toMatchObject({
      status: "awaiting_claim",
    });
    expect(context.claimVault.records.map((record) => record.ref)).toContain(
      vaultRef,
    );
    expect(context.claimVault.erasedRefs).toHaveLength(0);
    expect(context.claimVault.deliveries).toHaveLength(0);
  });

  it("rejects a claim delivery callback rebound to a different support deployment", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_wrong_support_deployment",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
    });
    context.claimVault.deliveryDeploymentIdOverride =
      "temporary_deployment_sibling";
    const consume = (
      context.orchestrator as unknown as {
        consumeTemporaryClaim(input: {
          actor: HumanActor;
          shipletId: string;
          targetId: string;
        }): Promise<Record<string, unknown>>;
      }
    ).consumeTemporaryClaim.bind(context.orchestrator);

    await expect(
      consume({
        actor: actorFor(target),
        shipletId: target.shipletId,
        targetId: target.id,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "claim_delivery_conflict",
    });
    expect(context.repository.temporaryClaims.get(target.id)).toMatchObject({
      status: "awaiting_claim",
    });
  });

  it("sanitizes a cleanup-journal write failure without leaking or rejecting", async () => {
    const context = setup();
    const target: DeploymentTarget = {
      ...context.target,
      id: "target_temporary_cleanup_journal_failure",
      kind: "temporary_claim",
      connectionId: null,
      status: "connected",
      resourceBindings: [],
    };
    context.repository.targets.set(target.id, target);
    context.claimVault.storeSucceeds = false;
    context.provider.cleanupSucceeds = false;
    context.repository.recordTemporaryClaimThrows = true;

    const settled = await context.orchestrator
      .createTemporaryClaimDeployment({
        ...acceptedCloudflareTemporaryAccountPolicies(),
        actor: actorFor(target),
        shipletId: target.shipletId,
        targetId: target.id,
        revision: cloneRevision(),
      })
      .then(
        (value) => ({ kind: "resolved" as const, value }),
        () => ({ kind: "rejected" as const }),
      );

    expect(settled).toEqual({
      kind: "resolved",
      value: {
        ok: false,
        reason: "claim_cleanup_reconciliation_required",
      },
    });
    expect(JSON.stringify(settled)).not.toContain(
      "temporary_claim_repository_failed",
    );
  });
});

function temporaryTarget(
  context: ReturnType<typeof setup>,
  id: string,
): DeploymentTarget {
  return {
    ...context.target,
    id,
    kind: "temporary_claim",
    connectionId: null,
    status: "connected",
    resourceBindings: [],
  };
}

describe("Cloudflare deployment integration hardening", () => {
  it("uses one typed dot-delimited scope vocabulary for every deployment authorization", async () => {
    const context = setup();
    context.provider.scriptExists = true;
    context.repository.seedKnownGood(
      knownGood(context.target, "revision_a1", "provider_version_a1"),
    );

    const result = await deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("typed_scope_contract"),
    });

    expect(result.ok).toBe(true);
    const scopes = context.connectionAuthorizer.requests.flatMap(
      (request) => request.requiredScopes as string[],
    );
    expect(new Set(scopes)).toEqual(
      new Set([
        scopeContract.workerScriptRead,
        scopeContract.workerScriptWrite,
      ]),
    );
    expect(scopes.every((scope) => scope.includes("."))).toBe(true);
  });

  it("prevents a sequential second temporary claim for the same target", async () => {
    const context = setup();
    const target = temporaryTarget(context, "target_temporary_sequential_cas");
    context.repository.targets.set(target.id, target);
    const first = await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
      idempotencyKey: runtimeId("first_claim"),
    });

    const second = await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: {
        ...cloneRevision(),
        revisionId: "revision_second_claim",
        packageDigest: "sha256-second-claim",
      },
      idempotencyKey: runtimeId("second_claim"),
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "claim_already_exists" });
    expect(
      context.provider.operations.filter(
        (operation) => operation.kind === "create_temporary_deployment",
      ),
    ).toHaveLength(1);
  });

  it.each(["claimed", "delivered", "revoked"] as const)(
    "rejects temporary claim creation for a %s target",
    async (state) => {
      const context = setup();
      const target = temporaryTarget(context, `target_temporary_${state}_cas`);
      if (state === "claimed" || state === "revoked") target.status = state;
      context.repository.targets.set(target.id, target);
      if (state === "delivered") {
        context.repository.temporaryClaims.set(target.id, {
          targetId: target.id,
          status: "delivered",
          vaultRef: runtimeId("retired_claim_ref"),
          expiresAt: 60_000,
        });
      }

      const result = await context.orchestrator.createTemporaryClaimDeployment({
        ...acceptedCloudflareTemporaryAccountPolicies(),
        actor: actorFor(target),
        shipletId: target.shipletId,
        targetId: target.id,
        revision: cloneRevision(),
        idempotencyKey: runtimeId(`${state}_claim`),
      });

      expect(result).toEqual({
        ok: false,
        reason:
          state === "claimed"
            ? "claim_already_claimed"
            : state === "delivered"
              ? "claim_already_delivered"
              : "target_revoked",
      });
      expect(context.provider.operations).toHaveLength(0);
    },
  );

  it("snapshots the complete immutable revision and binds its digest before the first await", async () => {
    const context = setup();
    context.provider.scriptExists = true;
    context.repository.seedKnownGood(
      knownGood(context.target, "revision_a1", "provider_version_a1"),
    );
    const revision = cloneRevision();
    const original = structuredClone(revision);
    const gate = context.repository.pauseTargetLookup();
    const operation = deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision,
      idempotencyKey: runtimeId("immutable_snapshot"),
    });
    await gate.entered;
    revision.revisionId = "revision_mutated_after_call";
    revision.packageDigest = "sha256-mutated-after-call";
    revision.staticAssets[0].content = "mutated";
    gate.release();

    const result = await operation;
    const upload = context.provider.operations.find(
      (candidate) => candidate.kind === "upload_version",
    )!;
    const request = providerRequest(upload.input);

    expect(result).toMatchObject({
      ok: true,
      deployment: { revisionId: original.revisionId },
    });
    expect(request).toMatchObject({
      revisionId: original.revisionId,
      packageDigest: original.packageDigest,
      modules: original.modules,
      staticAssets: original.staticAssets.map((asset) => ({
        ...asset,
        path: `/${asset.path}`,
      })),
    });
    expect(revision).not.toEqual(original);
    expect(original.staticAssets[0]?.path).toBe("index.html");
    expect(context.repository.reservations[0]).toMatchObject({
      revisionId: original.revisionId,
    });
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    40_000,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "rejects an invalid temporary claim expiry before persistence: %s",
    async (expiresAt) => {
      const context = setup();
      const target = temporaryTarget(
        context,
        runtimeId("target_invalid_claim_expiry"),
      );
      context.repository.targets.set(target.id, target);
      context.provider.temporaryExpiresAt = expiresAt;

      const result = await context.orchestrator.createTemporaryClaimDeployment({
        ...acceptedCloudflareTemporaryAccountPolicies(),
        actor: actorFor(target),
        shipletId: target.shipletId,
        targetId: target.id,
        revision: cloneRevision(),
      });

      expect(result).toEqual({
        ok: false,
        reason: "temporary_provider_expiry_invalid",
      });
      expect(context.claimVault.records).toHaveLength(0);
      expect(context.repository.temporaryClaims.has(target.id)).toBe(false);
      expect(
        context.provider.operations.map((operation) => operation.kind),
      ).toEqual([
        "create_temporary_deployment",
        "cleanup_temporary_deployment",
      ]);
    },
  );

  it("rejects a corrupt non-finite claim expiry before trusted redemption", async () => {
    const context = setup();
    const target = temporaryTarget(context, "target_corrupt_claim_expiry");
    context.repository.targets.set(target.id, target);
    const vaultRef = await context.claimVault.store({
      targetId: target.id,
      temporaryAuthorization: context.provider.temporaryAuthorization,
      claimUrl: context.provider.claimUrl,
      expiresAt: Number.POSITIVE_INFINITY,
    });
    context.repository.temporaryClaims.set(target.id, {
      targetId: target.id,
      shipletId: target.shipletId,
      revisionId: "revision_a2",
      status: "awaiting_claim",
      vaultRef,
      expiresAt: Number.POSITIVE_INFINITY,
      operationId: "deployment_journal_corrupt_expiry",
    });
    const consume = (
      context.orchestrator as unknown as {
        consumeTemporaryClaim(input: {
          actor: HumanActor;
          shipletId: string;
          targetId: string;
        }): Promise<Record<string, unknown>>;
      }
    ).consumeTemporaryClaim.bind(context.orchestrator);

    await expect(
      consume({
        actor: actorFor(target),
        shipletId: target.shipletId,
        targetId: target.id,
      }),
    ).resolves.toEqual({ ok: false, reason: "claim_expiry_invalid" });
    expect(context.claimVault.deliveries).toHaveLength(0);
  });

  it("fails rollback closed when the target is locally revoked", async () => {
    const context = setup();
    const selected = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    const current = knownGood(
      context.target,
      "revision_a2",
      "provider_version_a2",
    );
    context.repository.deployments.set(selected.id, selected);
    context.repository.seedKnownGood(current);
    context.target.status = "revoked";
    context.repository.targets.set(context.target.id, context.target);

    const result = await rollbackWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      toDeploymentId: selected.id,
      expectedKnownGoodDeploymentId: current.id,
      idempotencyKey: runtimeId("revoked_rollback"),
    });

    expect(result).toEqual({ ok: false, reason: "connection_revoked" });
    expect(context.repository.reservations).toHaveLength(0);
    expect(context.provider.operations).toHaveLength(0);
  });

  it("revalidates rollback authorization immediately before provider mutation", async () => {
    const context = setup();
    const selected = knownGood(
      context.target,
      "revision_a1",
      "provider_version_a1",
    );
    const current = knownGood(
      context.target,
      "revision_a2",
      "provider_version_a2",
    );
    context.repository.deployments.set(selected.id, selected);
    context.repository.seedKnownGood(current);
    context.connectionAuthorizer.statusSequence = ["active", "revoked"];

    const result = await rollbackWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      toDeploymentId: selected.id,
      expectedKnownGoodDeploymentId: current.id,
      idempotencyKey: runtimeId("rollback_revalidation"),
    });

    expect(result).toEqual({ ok: false, reason: "connection_revoked" });
    expect(
      context.connectionAuthorizer.requests.filter(
        (request) => request.operation === "worker.deployment.rollback",
      ),
    ).toHaveLength(2);
    expect(context.provider.operations).toHaveLength(0);
  });

  it("durably records every provider reference when claim vaulting and cleanup both fail", async () => {
    const context = setup();
    const target = temporaryTarget(context, "target_claim_cleanup_refs");
    context.repository.targets.set(target.id, target);
    context.claimVault.storeSucceeds = false;
    context.provider.cleanupSucceeds = false;

    await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
    });

    expect(context.repository.temporaryClaims.get(target.id)).toMatchObject({
      status: "cleanup_retry",
      vaultRef: null,
      providerDeploymentId: expect.stringMatching(/^temporary_deployment_/),
      providerVersionId: expect.stringMatching(/^temporary_version_/),
    });
  });

  it.each(["claim_record", "claim_finalize"] as const)(
    "durably records provider and vault references after a %s partial failure",
    async (failure) => {
      const context = setup();
      const target = temporaryTarget(context, `target_partial_${failure}`);
      context.repository.targets.set(target.id, target);
      context.provider.cleanupSucceeds = false;
      if (failure === "claim_record") {
        context.repository.recordTemporaryClaimFailuresRemaining = 1;
      } else {
        context.repository.finalizeTemporaryClaimFails = true;
      }

      const result = await context.orchestrator.createTemporaryClaimDeployment({
        ...acceptedCloudflareTemporaryAccountPolicies(),
        actor: actorFor(target),
        shipletId: target.shipletId,
        targetId: target.id,
        revision: cloneRevision(),
      });

      expect(result.ok).toBe(false);
      expect(
        context.provider.operations.map((operation) => operation.kind),
      ).toContain("cleanup_temporary_deployment");
      expect(context.repository.temporaryClaimHistory.at(-1)).toMatchObject({
        targetId: target.id,
        status: "cleanup_retry",
        vaultRef: expect.stringMatching(/^claim_ref_/),
        providerDeploymentId: expect.stringMatching(/^temporary_deployment_/),
        providerVersionId: expect.stringMatching(/^temporary_version_/),
      });
    },
  );

  it("replays only the same trusted backend redirect after a lost response", async () => {
    const context = setup();
    const target = temporaryTarget(context, "target_trusted_redemption");
    context.repository.targets.set(target.id, target);
    await context.orchestrator.createTemporaryClaimDeployment({
      ...acceptedCloudflareTemporaryAccountPolicies(),
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
      revision: cloneRevision(),
    });
    const redeem = (
      context.orchestrator as unknown as {
        redeemTemporaryClaim(input: {
          actor: HumanActor;
          shipletId: string;
          targetId: string;
        }): Promise<Response>;
      }
    ).redeemTemporaryClaim;

    const first = await redeem({
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
    });
    const second = await redeem({
      actor: actorFor(target),
      shipletId: target.shipletId,
      targetId: target.id,
    });

    expect(first).toBeInstanceOf(Response);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe(
      context.provider.claimUrl.toString(),
    );
    expect(second).toBeInstanceOf(Response);
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe(
      context.provider.claimUrl.toString(),
    );
  });

  it.each(["duplicate_name", "missing_provider_id", "reserved_name"] as const)(
    "independently rejects an invalid %s kernel resource projection",
    async (failure) => {
      const context = setup();
      context.provider.scriptExists = true;
      context.repository.seedKnownGood(
        knownGood(context.target, "revision_a1", "provider_version_a1"),
      );
      const state = context.repository.resources.get(
        "resource_customer_a_state",
      )!;
      if (failure === "missing_provider_id") {
        delete state.providerResourceId;
      }
      if (failure === "reserved_name") state.name = "WORKOS_API_KEY";
      if (failure === "duplicate_name") {
        context.repository.resources.set("resource_customer_a_duplicate", {
          ...structuredClone(state),
          id: "resource_customer_a_duplicate",
          providerResourceId: "customer_a_duplicate_state",
        });
        context.target.resourceBindingRefs = [
          ...(context.target.resourceBindingRefs ?? []),
          "resource_customer_a_duplicate",
        ];
        context.repository.targets.set(context.target.id, context.target);
      }

      const result = await deployWithOperation(context, {
        actor: actorFor(context.target),
        shipletId: context.target.shipletId,
        targetId: context.target.id,
        revision: cloneRevision(),
        idempotencyKey: runtimeId(`projection_${failure}`),
      });

      expect(result).toEqual({
        ok: false,
        reason: "target_resource_projection_invalid",
      });
      expect(context.provider.operations).toHaveLength(0);
    },
  );

  it("scopes durable journal keys and canonical intent digests to the Shiplet", async () => {
    const context = setup();
    context.provider.scriptExists = true;
    context.repository.seedKnownGood(
      knownGood(context.target, "revision_a1", "provider_version_a1"),
    );
    const revision = cloneRevision();

    await deployWithOperation(context, {
      actor: actorFor(context.target),
      shipletId: context.target.shipletId,
      targetId: context.target.id,
      revision,
      idempotencyKey: runtimeId("shiplet_scoped_journal"),
    });

    expect(context.repository.reservations[0]).toMatchObject({
      shipletId: context.target.shipletId,
      intentDigest: await sha256Digest({
        operation: "deploy",
        shipletId: context.target.shipletId,
        targetId: context.target.id,
        accountId: context.target.providerAccountId,
        scriptName: context.target.providerScriptName,
        revisionId: revision.revisionId,
        packageDigest: revision.packageDigest,
      }),
    });
  });
});
