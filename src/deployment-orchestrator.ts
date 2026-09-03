/** Trusted-kernel deployment orchestration for immutable Shiplet revisions. */

import {
  CLOUDFLARE_OAUTH_SCOPES,
  type CloudflareOAuthScope,
} from "./cloudflare-oauth";

export type DeploymentActor = { kind: "human"; id: string };

export const CLOUDFLARE_TEMPORARY_ACCOUNT_POLICIES = Object.freeze({
  termsOfService: "https://www.cloudflare.com/terms/",
  privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
});

export type CloudflareTemporaryAccountPolicyAcceptance = {
  termsOfService: typeof CLOUDFLARE_TEMPORARY_ACCOUNT_POLICIES.termsOfService;
  privacyPolicy: typeof CLOUDFLARE_TEMPORARY_ACCOUNT_POLICIES.privacyPolicy;
  acceptTermsOfService: "yes";
};

export type DeploymentTargetResource = {
  name: string;
  kind: "d1" | "r2" | "durable_object" | "plain_text";
  providerResourceId?: string;
  value?: string;
  ownerShipletId: string;
  ownerTargetId: string;
};

export type KernelDeploymentResource = {
  id: string;
  shipletId: string;
  targetId: string;
  name: string;
  kind: "d1" | "r2" | "durable_object" | "plain_text";
  providerResourceId?: string;
  value?: string;
  visibility?: "public" | "private";
};

export type CloudflareDeploymentTarget = {
  id: string;
  shipletId: string;
  kind: "customer_cloudflare" | "temporary_claim";
  ownerUserId: string;
  connectionId: string | null;
  providerAccountId: string;
  providerScriptName: string;
  status: "connected" | "revoked" | "claimed";
  resourceBindingRefs?: string[];
  resourceBindings: DeploymentTargetResource[];
};

export type ImmutableRevisionBundle = {
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  /** Kernel-derived package entrypoint; required when more than one module exists. */
  mainModule?: string;
  modules: Array<{
    name: string;
    mediaType: string;
    content: string;
    encoding?: "utf8" | "base64";
  }>;
  staticAssets: Array<{
    path: string;
    mediaType: string;
    content: string;
    encoding?: "utf8" | "base64";
  }>;
};

const CUSTOMER_WORKER_LIMITS = Object.freeze({ cpuMs: 25, subRequests: 8 });
const CUSTOMER_WORKER_EGRESS = Object.freeze({
  status: "customer_controlled_unrestricted" as const,
});

export type ShipletDeploymentRecord = {
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

type OperationJournal = Record<string, unknown> & {
  id?: string;
  status: string;
  resultDeploymentId?: string;
  publicResult?: Record<string, unknown>;
};

export type TargetMutationOperation =
  | "deploy"
  | "rollback"
  | "claim_create"
  | "promotion"
  | "restoration";

export type DeploymentEffectEvent = Record<string, unknown> & {
  eventId: string;
  eventKind: string;
  shipletId: string;
  targetId: string;
  revisionId: string;
  actorKind: "human";
  actorId: string;
  outcome: string;
  occurredAt: number;
};

export interface DeploymentRepository {
  getTargetScoped(input: {
    shipletId: string;
    targetId: string;
  }): Promise<CloudflareDeploymentTarget | null>;
  getKnownGood(targetId: string): Promise<ShipletDeploymentRecord | null>;
  getDeploymentScoped(input: {
    shipletId: string;
    targetId: string;
    deploymentId: string;
  }): Promise<ShipletDeploymentRecord | null>;
  resolveRevisionPackageDigest?(input: {
    shipletId: string;
    revisionId: string;
  }): Promise<string | null>;
  resolveTargetResources(input: {
    shipletId: string;
    targetId: string;
    resourceRefs: string[];
  }): Promise<KernelDeploymentResource[] | null>;
  reserveTargetOperation(input: {
    shipletId: string;
    targetId: string;
    expectedKnownGoodDeploymentId: string | null;
    idempotencyKey: string;
    operation: TargetMutationOperation;
    revisionId: string;
    intentDigest: string;
  }): Promise<
    | { ok: true; replay: boolean; journal: OperationJournal }
    | { ok: false; reason: "operation_in_progress" | string }
  >;
  finalizeTargetOperation(input: {
    journalId: string;
    record: ShipletDeploymentRecord;
    effectEvent?: DeploymentEffectEvent;
  }): Promise<boolean>;
  recheckTargetOperation?(input: {
    journalId: string;
    shipletId: string;
    targetId: string;
    expectedKnownGoodDeploymentId: string | null;
    allowReconcileRequired?: boolean;
  }): Promise<boolean>;
  completeTargetOperation?(input: {
    journalId: string;
    resultDeploymentId: string;
    status: "finalized" | "compensated";
  }): Promise<boolean>;
  markTargetOperationCompensated(input: { journalId: string }): Promise<void>;
  abortTargetOperation(input: {
    journalId: string;
    status: "failed" | "aborted" | "reconcile_required";
    reason: string;
  }): Promise<void>;
  finalizeTemporaryClaimOperation(input: {
    journalId: string;
    publicResult: Record<string, unknown>;
    effectEvent?: DeploymentEffectEvent;
  }): Promise<boolean>;
  recordTemporaryClaim(
    input: Record<string, unknown> & { targetId: string },
  ): Promise<void>;
  markTemporaryClaimDelivered(input: {
    targetId: string;
    expectedStatus: "awaiting_claim";
    delivery: {
      eventId: string;
      shipletId: string;
      revisionId: string;
      actor: DeploymentActor;
      occurredAt: number;
    };
  }): Promise<boolean>;
  recordFailure(event: Record<string, unknown>): Promise<void>;
  getTemporaryClaim?(targetId: string): Promise<Record<string, unknown> | null>;
  temporaryClaims?: Map<string, Record<string, unknown>>;
}

export type ProviderAuthorization = {
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
  operationId?: string;
};

export interface DeploymentConnectionAuthorizer {
  authorize(input: {
    connectionId: string;
    userId: string;
    shipletId: string;
    accountId: string;
    operation: string;
    requiredScopes: CloudflareDeploymentScope[];
    targetId: string;
    scriptName: string;
    revisionId: string;
    packageDigest: string;
    requestDigest: string;
  }): Promise<
    | {
        ok: true;
        grantRef: string;
        authorization: ProviderAuthorization;
      }
    | { ok: false; reason: "connection_revoked" | string }
  >;
}

export const CLOUDFLARE_TEMPORARY_DEPLOYMENT_SCOPES = Object.freeze({
  create: Object.freeze([
    "temporary.accounts.create",
    "temporary.workers.deploy",
  ]),
  cleanup: Object.freeze(["temporary.workers.cleanup"]),
});

export interface TemporaryDeploymentAuthorizer {
  authorize(input: {
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
  }): Promise<
    | { ok: true; authorization: ProviderAuthorization }
    | { ok: false; reason: string }
  >;
}

export interface CloudflareDeploymentProvider {
  hasScript(input: Record<string, unknown>): Promise<boolean>;
  initializeScript(
    input: Record<string, unknown>,
  ): Promise<{ versionId: string }>;
  uploadVersion(input: Record<string, unknown>): Promise<{ versionId: string }>;
  proveCandidate(
    input: Record<string, unknown>,
  ): Promise<{ healthy: boolean; observedVersionId: string }>;
  createDeployment(
    input: Record<string, unknown>,
  ): Promise<{ deploymentId: string }>;
  createTemporaryDeployment(input: Record<string, unknown>): Promise<{
    providerDeploymentId: string;
    providerVersionId: string;
    temporaryAuthorization: object;
    claimUrl: URL;
    expiresAt: number;
  }>;
  cleanupTemporaryDeployment(input: Record<string, unknown>): Promise<void>;
}

export interface TemporaryClaimVault {
  store(input: {
    targetId: string;
    temporaryAuthorization: object;
    claimUrl: URL;
    expiresAt: number;
  }): Promise<string>;
  consumeForBackendRedirect(input: {
    ref: string;
    now: number;
    markDelivered: (delivery: {
      operationId: string;
      deliveryEventId: string;
      deploymentId: string;
      userId: string;
      shipletId: string;
      targetId: string;
      revisionId: string;
    }) => Promise<boolean>;
  }): Promise<
    | {
        ok: true;
        redirect: {
          kind: "trusted_backend_redirect";
          opaqueHandle: string;
        };
      }
    | { ok: false; reason: string }
  >;
  redeemBackendRedirect(input: {
    opaqueHandle: string;
  }): Promise<Response | null>;
}

type DeploymentDependencies = {
  repository: DeploymentRepository;
  provider: CloudflareDeploymentProvider;
  connectionAuthorizer: DeploymentConnectionAuthorizer;
  temporaryDeploymentAuthorizer?: TemporaryDeploymentAuthorizer;
  claimVault: TemporaryClaimVault;
  now: () => number;
  audit: (event: Record<string, unknown>) => Promise<void>;
  telemetry: (event: Record<string, unknown>) => Promise<void>;
};

type CustomerDeploymentInput = {
  actor: DeploymentActor;
  shipletId: string;
  targetId: string;
  revision: ImmutableRevisionBundle;
  idempotencyKey?: string;
  cloudflarePolicyAcceptance?: CloudflareTemporaryAccountPolicyAcceptance;
};

type RollbackInput = {
  actor: DeploymentActor;
  shipletId: string;
  targetId: string;
  toDeploymentId: string;
  expectedKnownGoodDeploymentId: string;
  idempotencyKey?: string;
};

type ProviderBinding = {
  name: string;
  kind: KernelDeploymentResource["kind"];
  providerResourceId?: string;
  value?: string;
};

type CloudflareDeploymentScope = Extract<
  CloudflareOAuthScope,
  "workers.scripts.read" | "workers.scripts.write"
>;

const LEGACY_SCOPE_BY_CANONICAL: Readonly<
  Partial<Record<CloudflareOAuthScope, string>>
> = {
  [CLOUDFLARE_OAUTH_SCOPES.workerScriptRead]: "workers_scripts_read",
  [CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite]: "workers_scripts_write",
};

const CANONICAL_SCOPE_BY_LEGACY: Readonly<
  Record<string, CloudflareOAuthScope>
> = {
  workers_scripts_read: CLOUDFLARE_OAUTH_SCOPES.workerScriptRead,
  workers_scripts_write: CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite,
};

const RESERVED_PROVIDER_BINDING_NAMES = new Set([
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_OAUTH_TOKEN",
  "PLATFORM_DB",
  "SHARED_D1",
  "SHARED_R2",
  "SHARED_DO",
]);

const ALLOWED_RESOURCE_KINDS = new Set<KernelDeploymentResource["kind"]>([
  "d1",
  "r2",
  "durable_object",
  "plain_text",
]);

function deploymentId() {
  return `deployment_${crypto.randomUUID()}`;
}

function normalizedScopes(scopes: string[]) {
  return [
    ...new Set(
      scopes.map((scope) => {
        const normalized = scope.trim().toLowerCase();
        return CANONICAL_SCOPE_BY_LEGACY[normalized] ?? normalized;
      }),
    ),
  ]
    .filter(Boolean)
    .sort();
}

function isSafeFutureTimestamp(value: number, now: number) {
  return Number.isSafeInteger(value) && value > now;
}

function validProviderIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
  );
}

function hasCompensatableTemporaryIdentity(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  providerDeploymentId: string;
  providerVersionId: string;
} {
  return (
    validProviderIdentifier(value.providerDeploymentId) &&
    validProviderIdentifier(value.providerVersionId)
  );
}

function validTemporaryProviderResult(
  value: unknown,
  now: number,
): value is Awaited<
  ReturnType<CloudflareDeploymentProvider["createTemporaryDeployment"]>
> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    hasCompensatableTemporaryIdentity(result) &&
    typeof result.temporaryAuthorization === "object" &&
    result.temporaryAuthorization !== null &&
    result.claimUrl instanceof URL &&
    (result.claimUrl.protocol === "https:" ||
      result.claimUrl.protocol === "http:") &&
    isSafeFutureTimestamp(Number(result.expiresAt), now)
  );
}

function safeTemporaryClaimReplay(
  value: Record<string, unknown>,
  expected: { targetId: string; revisionId: string; now: number },
) {
  const deployment = value.deployment;
  if (
    value.ok !== true ||
    !deployment ||
    typeof deployment !== "object" ||
    Array.isArray(deployment)
  ) {
    return null;
  }
  const record = deployment as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.targetId !== expected.targetId ||
    record.revisionId !== expected.revisionId ||
    typeof record.providerDeploymentId !== "string" ||
    typeof record.providerVersionId !== "string" ||
    record.status !== "awaiting_claim" ||
    !isSafeFutureTimestamp(Number(record.expiresAt), expected.now) ||
    record.requiresOAuthConnectionForUpdates !== true
  ) {
    return null;
  }
  return {
    ok: true as const,
    deployment: {
      id: record.id,
      targetId: expected.targetId,
      revisionId: expected.revisionId,
      providerDeploymentId: record.providerDeploymentId,
      providerVersionId: record.providerVersionId,
      status: "awaiting_claim" as const,
      expiresAt: Number(record.expiresAt),
      requiresOAuthConnectionForUpdates: true as const,
    },
  };
}

function snapshotCustomerDeploymentInput(
  input: CustomerDeploymentInput,
): CustomerDeploymentInput {
  return {
    actor: structuredClone(input.actor),
    shipletId: input.shipletId,
    targetId: input.targetId,
    revision: structuredClone(input.revision),
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.idempotencyKey }),
    ...(input.cloudflarePolicyAcceptance === undefined
      ? {}
      : {
          cloudflarePolicyAcceptance: structuredClone(
            input.cloudflarePolicyAcceptance,
          ),
        }),
  };
}

export function hasExactCloudflareTemporaryAccountPolicyAcceptance(
  value: unknown,
): value is CloudflareTemporaryAccountPolicyAcceptance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const acceptance = value as Record<string, unknown>;
  return (
    Object.keys(acceptance).length === 3 &&
    acceptance.termsOfService ===
      CLOUDFLARE_TEMPORARY_ACCOUNT_POLICIES.termsOfService &&
    acceptance.privacyPolicy ===
      CLOUDFLARE_TEMPORARY_ACCOUNT_POLICIES.privacyPolicy &&
    acceptance.acceptTermsOfService === "yes"
  );
}

function authorizationCovers(
  authorization: ProviderAuthorization,
  input: {
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
    now: number;
    operationId?: string;
  },
) {
  const granted = new Set(normalizedScopes(authorization.scopes));
  return (
    Boolean(authorization.handle) &&
    authorization.userId === input.userId &&
    authorization.shipletId === input.shipletId &&
    authorization.accountId === input.accountId &&
    authorization.operation === input.operation &&
    authorization.targetId === input.targetId &&
    authorization.scriptName === input.scriptName &&
    authorization.revisionId === input.revisionId &&
    authorization.packageDigest === input.packageDigest &&
    authorization.requestDigest === input.requestDigest &&
    (input.operationId === undefined ||
      authorization.operationId === input.operationId) &&
    Number.isSafeInteger(authorization.expiresAt) &&
    authorization.expiresAt > input.now &&
    normalizedScopes(input.requiredScopes).every((scope) => granted.has(scope))
  );
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
  return JSON.stringify(value) ?? "null";
}

async function sha256Digest(value: unknown) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function providerEnvelope(
  authorization: ProviderAuthorization,
  request: Record<string, unknown>,
) {
  return {
    authorization: structuredClone(authorization),
    request: structuredClone(request),
    ...structuredClone(request),
  };
}

function legacyResourceLabelsAreScoped(target: CloudflareDeploymentTarget) {
  return target.resourceBindings.every(
    (resource) =>
      resource.ownerShipletId === target.shipletId &&
      resource.ownerTargetId === target.id,
  );
}

function projectBindings(
  resources: KernelDeploymentResource[],
  target: Pick<CloudflareDeploymentTarget, "id" | "shipletId">,
) {
  const bindings: ProviderBinding[] = [];
  const names = new Set<string>();
  for (const resource of resources) {
    if (
      resource.shipletId !== target.shipletId ||
      resource.targetId !== target.id ||
      !ALLOWED_RESOURCE_KINDS.has(resource.kind) ||
      typeof resource.name !== "string" ||
      resource.name.length === 0 ||
      resource.name.trim() !== resource.name ||
      names.has(resource.name) ||
      RESERVED_PROVIDER_BINDING_NAMES.has(resource.name.toUpperCase())
    ) {
      return {
        ok: false as const,
        reason: "target_resource_projection_invalid" as const,
      };
    }
    names.add(resource.name);
    if (resource.kind === "plain_text") {
      if (resource.visibility !== "public") {
        return {
          ok: false as const,
          reason: "plain_text_configuration_not_public" as const,
        };
      }
      if (typeof resource.value !== "string") {
        return {
          ok: false as const,
          reason: "target_resource_projection_invalid" as const,
        };
      }
      bindings.push({
        name: resource.name,
        kind: resource.kind,
        value: resource.value,
      });
      continue;
    }
    if (
      typeof resource.providerResourceId !== "string" ||
      resource.providerResourceId.length === 0 ||
      resource.providerResourceId.trim() !== resource.providerResourceId
    ) {
      return {
        ok: false as const,
        reason: "target_resource_projection_invalid" as const,
      };
    }
    bindings.push({
      name: resource.name,
      kind: resource.kind,
      providerResourceId: resource.providerResourceId,
    });
  }
  return { ok: true as const, bindings };
}

function revisionRequest(
  target: CloudflareDeploymentTarget,
  actor: DeploymentActor,
  revision: ImmutableRevisionBundle,
  bindings: ProviderBinding[],
) {
  const mainModule =
    revision.modules.length === 0
      ? "__shiplet_static.mjs"
      : (revision.mainModule ??
        (revision.modules.length === 1 ? revision.modules[0]!.name : null));
  if (
    !mainModule ||
    (revision.modules.length > 0 &&
      revision.modules.filter((module) => module.name === mainModule).length !==
        1)
  ) {
    throw new Error("revision_main_module_invalid");
  }
  return {
    actorId: actor.id,
    shipletId: target.shipletId,
    targetId: target.id,
    accountId: target.providerAccountId,
    scriptName: target.providerScriptName,
    revisionId: revision.revisionId,
    packageDigest: revision.packageDigest,
    modules: structuredClone(revision.modules),
    staticAssets: canonicalProviderStaticAssets(revision.staticAssets),
    bindings: structuredClone(bindings),
    mainModule,
    limits: structuredClone(CUSTOMER_WORKER_LIMITS),
    egress: structuredClone(CUSTOMER_WORKER_EGRESS),
  };
}

function canonicalProviderStaticAssets(
  staticAssets: ImmutableRevisionBundle["staticAssets"],
) {
  return structuredClone(staticAssets).map((asset) => ({
    ...asset,
    path: asset.path.startsWith("/") ? asset.path : `/${asset.path}`,
  }));
}

export function createDeploymentOrchestrator(
  dependencies: DeploymentDependencies,
) {
  const recordFailure = async (
    input: CustomerDeploymentInput,
    reason: string,
  ) => {
    const event = {
      eventKind: "cloudflare.deployment.failed",
      shipletId: input.shipletId,
      targetId: input.targetId,
      revisionId: input.revision.revisionId,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      outcome: "failed",
      reason,
      occurredAt: dependencies.now(),
    };
    try {
      await dependencies.repository.recordFailure(event);
    } catch {
      return false;
    }
    try {
      await dependencies.audit(event);
    } catch {
      return false;
    }
    return true;
  };

  const abortOperation = async (
    journalId: string,
    status: "failed" | "aborted" | "reconcile_required",
    reason: string,
  ) => {
    try {
      await dependencies.repository.abortTargetOperation({
        journalId,
        status,
        reason,
      });
    } catch {
      // The caller still returns a sanitized failure; reconciliation owns repair.
    }
  };

  const authorizeProvider = async (
    target: CloudflareDeploymentTarget,
    actor: DeploymentActor,
    revisionId: string,
    packageDigest: string,
    operation: string,
    requiredScopes: CloudflareDeploymentScope[],
    request: Record<string, unknown>,
  ) => {
    if (!target.connectionId) {
      return {
        ok: false as const,
        reason: "oauth_connection_required" as const,
      };
    }
    const requestDigest = await sha256Digest(request);
    let result: Awaited<
      ReturnType<DeploymentConnectionAuthorizer["authorize"]>
    >;
    try {
      result = await dependencies.connectionAuthorizer.authorize({
        connectionId: target.connectionId,
        userId: actor.id,
        shipletId: target.shipletId,
        accountId: target.providerAccountId,
        operation,
        requiredScopes,
        targetId: target.id,
        scriptName: target.providerScriptName,
        revisionId,
        packageDigest,
        requestDigest,
      });
    } catch {
      return {
        ok: false as const,
        reason: "provider_authorization_unavailable" as const,
      };
    }
    if (!result.ok) return result;
    if (
      !authorizationCovers(result.authorization, {
        userId: actor.id,
        shipletId: target.shipletId,
        accountId: target.providerAccountId,
        operation,
        requiredScopes,
        targetId: target.id,
        scriptName: target.providerScriptName,
        revisionId,
        packageDigest,
        requestDigest,
        now: dependencies.now(),
      })
    ) {
      return {
        ok: false as const,
        reason: "provider_authorization_invalid" as const,
      };
    }
    const authorization = structuredClone(result.authorization);
    authorization.scopes = normalizedScopes(authorization.scopes);
    // The broker request and provider envelope use the canonical vocabulary.
    // Preserve legacy labels on the broker-returned compatibility object while
    // older durable grant readers are migrated independently.
    result.authorization.scopes = result.authorization.scopes.map((scope) => {
      const canonical = normalizedScopes([scope])[0] as
        | CloudflareOAuthScope
        | undefined;
      return canonical
        ? (LEGACY_SCOPE_BY_CANONICAL[canonical] ?? canonical)
        : scope;
    });
    return { ok: true as const, authorization };
  };

  const authorizeTemporaryProvider = async (
    target: CloudflareDeploymentTarget,
    actor: DeploymentActor,
    revision: Pick<ImmutableRevisionBundle, "revisionId" | "packageDigest">,
    operation: "temporary.deployment.create" | "temporary.deployment.cleanup",
    requiredScopes: readonly string[],
    request: Record<string, unknown>,
  ) => {
    const operationId = request.operationId;
    if (typeof operationId !== "string") {
      return {
        ok: false as const,
        reason: "temporary_capability_invalid" as const,
      };
    }
    if (!dependencies.temporaryDeploymentAuthorizer) {
      return {
        ok: false as const,
        reason: "temporary_capability_unavailable" as const,
      };
    }
    const requestDigest = await sha256Digest(request);
    let result: Awaited<ReturnType<TemporaryDeploymentAuthorizer["authorize"]>>;
    try {
      result = await dependencies.temporaryDeploymentAuthorizer.authorize({
        operationId,
        userId: actor.id,
        shipletId: target.shipletId,
        accountHandle: target.providerAccountId,
        targetId: target.id,
        scriptName: target.providerScriptName,
        revisionId: revision.revisionId,
        packageDigest: revision.packageDigest,
        operation,
        requiredScopes,
        requestDigest,
      });
    } catch {
      return {
        ok: false as const,
        reason: "temporary_capability_unavailable" as const,
      };
    }
    if (!result.ok) return result;
    if (
      !authorizationCovers(result.authorization, {
        userId: actor.id,
        shipletId: target.shipletId,
        accountId: target.providerAccountId,
        operation,
        requiredScopes: [...requiredScopes],
        targetId: target.id,
        scriptName: target.providerScriptName,
        revisionId: revision.revisionId,
        packageDigest: revision.packageDigest,
        requestDigest,
        now: dependencies.now(),
        operationId,
      })
    ) {
      return {
        ok: false as const,
        reason: "temporary_capability_invalid" as const,
      };
    }
    return {
      ok: true as const,
      authorization: structuredClone(result.authorization),
    };
  };

  const resolveCustomerTarget = async (input: CustomerDeploymentInput) => {
    const target = await dependencies.repository.getTargetScoped({
      shipletId: input.shipletId,
      targetId: input.targetId,
    });
    if (!target || target.ownerUserId !== input.actor.id) {
      return { ok: false as const, reason: "target_not_found" as const };
    }
    if (input.revision.shipletId !== input.shipletId) {
      return {
        ok: false as const,
        reason: "revision_scope_mismatch" as const,
      };
    }
    if (!target.connectionId) {
      return {
        ok: false as const,
        reason: "oauth_connection_required" as const,
      };
    }
    if (target.status === "revoked") {
      return { ok: false as const, reason: "connection_revoked" as const };
    }
    if (!legacyResourceLabelsAreScoped(target)) {
      return {
        ok: false as const,
        reason: "target_resource_scope_mismatch" as const,
      };
    }
    const resources = await dependencies.repository.resolveTargetResources({
      shipletId: target.shipletId,
      targetId: target.id,
      resourceRefs: [...(target.resourceBindingRefs ?? [])],
    });
    if (!resources) {
      return {
        ok: false as const,
        reason: "target_resource_scope_mismatch" as const,
      };
    }
    const projected = projectBindings(resources, target);
    if (!projected.ok) return projected;
    return { ok: true as const, target, bindings: projected.bindings };
  };

  const revalidateTargetAttachment = async (input: {
    original: CloudflareDeploymentTarget;
    actor: DeploymentActor;
    bindings?: ProviderBinding[];
  }) => {
    let current: CloudflareDeploymentTarget | null;
    try {
      current = await dependencies.repository.getTargetScoped({
        shipletId: input.original.shipletId,
        targetId: input.original.id,
      });
    } catch {
      return {
        ok: false as const,
        reason: "deployment_reconciliation_required" as const,
      };
    }
    if (
      !current ||
      current.kind !== input.original.kind ||
      current.ownerUserId !== input.actor.id ||
      current.connectionId !== input.original.connectionId ||
      current.providerAccountId !== input.original.providerAccountId ||
      current.providerScriptName !== input.original.providerScriptName ||
      current.status !== "connected" ||
      canonicalJson(current.resourceBindingRefs ?? []) !==
        canonicalJson(input.original.resourceBindingRefs ?? []) ||
      !legacyResourceLabelsAreScoped(current)
    ) {
      return {
        ok: false as const,
        reason: "connection_revoked" as const,
      };
    }
    if (current.kind === "temporary_claim") {
      return { ok: true as const, target: current, bindings: [] };
    }
    let resources: KernelDeploymentResource[] | null;
    try {
      resources = await dependencies.repository.resolveTargetResources({
        shipletId: current.shipletId,
        targetId: current.id,
        resourceRefs: [...(current.resourceBindingRefs ?? [])],
      });
    } catch {
      return {
        ok: false as const,
        reason: "deployment_reconciliation_required" as const,
      };
    }
    if (!resources) {
      return {
        ok: false as const,
        reason: "target_resource_scope_mismatch" as const,
      };
    }
    const projected = projectBindings(resources, current);
    if (!projected.ok) return projected;
    if (
      input.bindings &&
      canonicalJson(projected.bindings) !== canonicalJson(input.bindings)
    ) {
      return {
        ok: false as const,
        reason: "target_resource_scope_mismatch" as const,
      };
    }
    return { ok: true as const, target: current, bindings: projected.bindings };
  };

  const recheckOperation = async (input: {
    journalId: string;
    shipletId: string;
    targetId: string;
    expectedKnownGoodDeploymentId: string | null;
    allowReconcileRequired?: boolean;
  }) => {
    if (!dependencies.repository.recheckTargetOperation) return true;
    try {
      return await dependencies.repository.recheckTargetOperation(input);
    } catch {
      return false;
    }
  };

  const reserveOperation = async (
    target: CloudflareDeploymentTarget,
    input: {
      idempotencyKey: string;
      operation: TargetMutationOperation;
      revisionId: string;
      expectedKnownGoodDeploymentId: string | null;
      intent: Record<string, unknown>;
    },
  ) => {
    const reservation = await dependencies.repository.reserveTargetOperation({
      shipletId: target.shipletId,
      targetId: target.id,
      expectedKnownGoodDeploymentId: input.expectedKnownGoodDeploymentId,
      idempotencyKey: input.idempotencyKey,
      operation: input.operation,
      revisionId: input.revisionId,
      intentDigest: await sha256Digest(input.intent),
    });
    if (!reservation.ok) return reservation;
    if (
      reservation.replay &&
      reservation.journal.status === "reconcile_required" &&
      input.operation === "claim_create" &&
      !reservation.journal.resultDeploymentId &&
      !reservation.journal.publicResult &&
      reservation.journal.id
    ) {
      return {
        ok: true as const,
        journalId: reservation.journal.id,
        recovering: true as const,
      };
    }
    if (
      reservation.replay &&
      (reservation.journal.status === "reserved" ||
        reservation.journal.status === "reconcile_required") &&
      !reservation.journal.resultDeploymentId &&
      !reservation.journal.publicResult
    ) {
      return { ok: false as const, reason: "operation_in_progress" as const };
    }
    if (reservation.replay && reservation.journal.publicResult) {
      return {
        ok: true as const,
        cachedPublic: structuredClone(reservation.journal.publicResult),
      };
    }
    if (reservation.replay && reservation.journal.resultDeploymentId) {
      const replay = await dependencies.repository.getDeploymentScoped({
        shipletId: target.shipletId,
        targetId: target.id,
        deploymentId: reservation.journal.resultDeploymentId,
      });
      if (replay) {
        return {
          ok: true as const,
          cached: { ok: true as const, deployment: replay },
        };
      }
    }
    if (!reservation.journal.id) {
      return { ok: false as const, reason: "journal_reservation_failed" };
    }
    return {
      ok: true as const,
      journalId: reservation.journal.id,
    };
  };

  const compensateProvider = async (
    target: CloudflareDeploymentTarget,
    actor: DeploymentActor,
    providerVersionId: string | null,
    journalId: string,
    revisionId: string,
    packageDigest: string,
  ) => {
    if (!providerVersionId) return false;
    const request = {
      actorId: actor.id,
      shipletId: target.shipletId,
      targetId: target.id,
      accountId: target.providerAccountId,
      scriptName: target.providerScriptName,
      versionId: providerVersionId,
      percentage: 100 as const,
      revisionId,
      packageDigest,
    };
    const authorized = await authorizeProvider(
      target,
      actor,
      revisionId,
      packageDigest,
      "worker.deployment.compensate",
      [CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite],
      request,
    );
    if (!authorized.ok) return false;
    try {
      await dependencies.provider.createDeployment(
        providerEnvelope(authorized.authorization, request),
      );
      await dependencies.repository.markTargetOperationCompensated({
        journalId,
      });
      return true;
    } catch {
      return false;
    }
  };

  const deployCustomerRevision = async (input: CustomerDeploymentInput) => {
    input = snapshotCustomerDeploymentInput(input);
    if (input.revision.modules.length > 0) {
      return {
        ok: false as const,
        reason: "customer_advanced_runtime_egress_unavailable" as const,
      };
    }
    const resolved = await resolveCustomerTarget(input);
    if (!resolved.ok) return resolved;
    const { target } = resolved;
    let { bindings } = resolved;
    const prior = await dependencies.repository.getKnownGood(target.id);
    let compensationRevisionId = input.revision.revisionId;
    let compensationPackageDigest = input.revision.packageDigest;
    if (prior) {
      const priorPackageDigest =
        await dependencies.repository.resolveRevisionPackageDigest?.({
          shipletId: input.shipletId,
          revisionId: prior.revisionId,
        });
      if (!priorPackageDigest) {
        return {
          ok: false as const,
          reason: "revision_package_digest_unavailable" as const,
        };
      }
      compensationRevisionId = prior.revisionId;
      compensationPackageDigest = priorPackageDigest;
    }
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
    const reservation = await reserveOperation(target, {
      idempotencyKey,
      operation: "deploy",
      revisionId: input.revision.revisionId,
      expectedKnownGoodDeploymentId: prior?.id ?? null,
      intent: {
        operation: "deploy",
        shipletId: input.shipletId,
        targetId: target.id,
        accountId: target.providerAccountId,
        scriptName: target.providerScriptName,
        revisionId: input.revision.revisionId,
        packageDigest: input.revision.packageDigest,
      },
    });
    if (!reservation.ok) return reservation;
    if (reservation.cached) return reservation.cached;
    const journalId = reservation.journalId!;

    const inspectRequest = {
      actorId: input.actor.id,
      shipletId: input.shipletId,
      targetId: target.id,
      accountId: target.providerAccountId,
      scriptName: target.providerScriptName,
    };
    const inspectAuthorization = await authorizeProvider(
      target,
      input.actor,
      input.revision.revisionId,
      input.revision.packageDigest,
      "worker.inspect",
      [CLOUDFLARE_OAUTH_SCOPES.workerScriptRead],
      inspectRequest,
    );
    if (!inspectAuthorization.ok) {
      await abortOperation(journalId, "aborted", inspectAuthorization.reason);
      return inspectAuthorization;
    }

    let exists: boolean;
    try {
      exists = await dependencies.provider.hasScript(
        providerEnvelope(inspectAuthorization.authorization, inspectRequest),
      );
    } catch {
      await recordFailure(input, "provider_upload_failed");
      await abortOperation(journalId, "failed", "provider_upload_failed");
      return { ok: false as const, reason: "provider_upload_failed" as const };
    }

    let currentTarget: CloudflareDeploymentTarget | null;
    try {
      currentTarget = await dependencies.repository.getTargetScoped({
        shipletId: input.shipletId,
        targetId: input.targetId,
      });
    } catch {
      await abortOperation(
        journalId,
        "reconcile_required",
        "target_revalidation_failed",
      );
      return {
        ok: false as const,
        reason: "deployment_reconciliation_required" as const,
      };
    }
    if (
      !currentTarget ||
      currentTarget.ownerUserId !== input.actor.id ||
      currentTarget.connectionId !== target.connectionId ||
      currentTarget.providerAccountId !== target.providerAccountId ||
      currentTarget.providerScriptName !== target.providerScriptName ||
      currentTarget.status === "revoked" ||
      !legacyResourceLabelsAreScoped(currentTarget)
    ) {
      await abortOperation(
        journalId,
        "aborted",
        "target_resource_scope_mismatch",
      );
      return {
        ok: false as const,
        reason: "target_resource_scope_mismatch" as const,
      };
    }
    let currentResources: KernelDeploymentResource[] | null;
    try {
      currentResources = await dependencies.repository.resolveTargetResources({
        shipletId: currentTarget.shipletId,
        targetId: currentTarget.id,
        resourceRefs: [...(currentTarget.resourceBindingRefs ?? [])],
      });
    } catch {
      await abortOperation(
        journalId,
        "reconcile_required",
        "resource_revalidation_failed",
      );
      return {
        ok: false as const,
        reason: "deployment_reconciliation_required" as const,
      };
    }
    if (!currentResources) {
      await abortOperation(
        journalId,
        "aborted",
        "target_resource_scope_mismatch",
      );
      return {
        ok: false as const,
        reason: "target_resource_scope_mismatch" as const,
      };
    }
    const currentProjection = projectBindings(currentResources, currentTarget);
    if (!currentProjection.ok) {
      await abortOperation(journalId, "aborted", currentProjection.reason);
      return currentProjection;
    }
    bindings = currentProjection.bindings;

    let compensationVersionId = prior?.providerVersionId ?? null;
    if (!exists) {
      const initializeRequest = {
        actorId: input.actor.id,
        shipletId: input.shipletId,
        targetId: target.id,
        accountId: target.providerAccountId,
        scriptName: target.providerScriptName,
        bootstrap: { kind: "inert_known_good" as const },
        bindings: structuredClone(bindings),
      };
      const initializeAuthorization = await authorizeProvider(
        target,
        input.actor,
        input.revision.revisionId,
        input.revision.packageDigest,
        "worker.script.initialize",
        [CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite],
        initializeRequest,
      );
      if (!initializeAuthorization.ok) {
        await abortOperation(
          journalId,
          "aborted",
          initializeAuthorization.reason,
        );
        return initializeAuthorization;
      }
      try {
        const initialized = await dependencies.provider.initializeScript(
          providerEnvelope(
            initializeAuthorization.authorization,
            initializeRequest,
          ),
        );
        compensationVersionId = initialized.versionId;
      } catch {
        await recordFailure(input, "provider_upload_failed");
        await abortOperation(journalId, "failed", "provider_upload_failed");
        return {
          ok: false as const,
          reason: "provider_upload_failed" as const,
        };
      }
    }

    let uploadRequest: ReturnType<typeof revisionRequest>;
    try {
      uploadRequest = revisionRequest(
        target,
        input.actor,
        input.revision,
        bindings,
      );
    } catch {
      await abortOperation(journalId, "aborted", "revision_package_invalid");
      return {
        ok: false as const,
        reason: "revision_package_invalid" as const,
      };
    }
    const uploadAuthorization = await authorizeProvider(
      target,
      input.actor,
      input.revision.revisionId,
      input.revision.packageDigest,
      "worker.version.upload",
      [CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite],
      uploadRequest,
    );
    if (!uploadAuthorization.ok) {
      await abortOperation(journalId, "aborted", uploadAuthorization.reason);
      return uploadAuthorization;
    }
    let uploaded: { versionId: string };
    try {
      uploaded = await dependencies.provider.uploadVersion(
        providerEnvelope(uploadAuthorization.authorization, uploadRequest),
      );
    } catch {
      await recordFailure(input, "provider_upload_failed");
      await abortOperation(journalId, "failed", "provider_upload_failed");
      return { ok: false as const, reason: "provider_upload_failed" as const };
    }

    const proofRequest = {
      actorId: input.actor.id,
      shipletId: input.shipletId,
      targetId: target.id,
      accountId: target.providerAccountId,
      scriptName: target.providerScriptName,
      versionId: uploaded.versionId,
      revisionId: input.revision.revisionId,
      packageDigest: input.revision.packageDigest,
      healthCheck: {
        path: "/__shiplet/health" as const,
        expectedStatus: 200 as const,
      },
    };
    const proofAuthorization = await authorizeProvider(
      target,
      input.actor,
      input.revision.revisionId,
      input.revision.packageDigest,
      "worker.candidate.prove",
      [CLOUDFLARE_OAUTH_SCOPES.workerScriptRead],
      proofRequest,
    );
    if (!proofAuthorization.ok) {
      await abortOperation(journalId, "aborted", proofAuthorization.reason);
      return proofAuthorization;
    }
    let proof: { healthy: boolean; observedVersionId: string };
    try {
      proof = await dependencies.provider.proveCandidate(
        providerEnvelope(proofAuthorization.authorization, proofRequest),
      );
    } catch {
      await recordFailure(input, "candidate_proof_failed");
      await abortOperation(journalId, "failed", "candidate_proof_failed");
      return { ok: false as const, reason: "candidate_proof_failed" as const };
    }
    if (!proof.healthy) {
      await recordFailure(input, "candidate_unhealthy");
      await abortOperation(journalId, "failed", "candidate_unhealthy");
      return { ok: false as const, reason: "candidate_unhealthy" as const };
    }
    if (proof.observedVersionId !== uploaded.versionId) {
      await recordFailure(input, "candidate_version_mismatch");
      await abortOperation(journalId, "failed", "candidate_version_mismatch");
      return {
        ok: false as const,
        reason: "candidate_version_mismatch" as const,
      };
    }

    const promotionRequest = {
      actorId: input.actor.id,
      shipletId: input.shipletId,
      targetId: target.id,
      accountId: target.providerAccountId,
      scriptName: target.providerScriptName,
      versionId: uploaded.versionId,
      percentage: 100 as const,
      revisionId: input.revision.revisionId,
      packageDigest: input.revision.packageDigest,
    };
    const promotionAuthorization = await authorizeProvider(
      target,
      input.actor,
      input.revision.revisionId,
      input.revision.packageDigest,
      "worker.deployment.promote",
      [CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite],
      promotionRequest,
    );
    if (!promotionAuthorization.ok) {
      await abortOperation(journalId, "aborted", promotionAuthorization.reason);
      return promotionAuthorization;
    }
    const immediatelyCurrent = await revalidateTargetAttachment({
      original: target,
      actor: input.actor,
      bindings,
    });
    if (!immediatelyCurrent.ok) {
      await abortOperation(
        journalId,
        immediatelyCurrent.reason === "deployment_reconciliation_required"
          ? "reconcile_required"
          : "aborted",
        immediatelyCurrent.reason,
      );
      return immediatelyCurrent;
    }
    if (
      !(await recheckOperation({
        journalId,
        shipletId: input.shipletId,
        targetId: target.id,
        expectedKnownGoodDeploymentId: prior?.id ?? null,
      }))
    ) {
      await abortOperation(journalId, "aborted", "deployment_conflict");
      return { ok: false as const, reason: "deployment_conflict" as const };
    }
    let providerDeployment: { deploymentId: string };
    try {
      providerDeployment = await dependencies.provider.createDeployment(
        providerEnvelope(
          promotionAuthorization.authorization,
          promotionRequest,
        ),
      );
    } catch {
      await recordFailure(input, "deployment_reconciliation_required");
      await abortOperation(
        journalId,
        "reconcile_required",
        "provider_deployment_outcome_ambiguous",
      );
      return {
        ok: false as const,
        reason: "deployment_reconciliation_required" as const,
      };
    }

    const record: ShipletDeploymentRecord = {
      id: deploymentId(),
      targetId: target.id,
      revisionId: input.revision.revisionId,
      providerVersionId: uploaded.versionId,
      providerDeploymentId: providerDeployment.deploymentId,
      status: "known_good",
      supersedesDeploymentId: prior?.id ?? null,
      deployedAt: dependencies.now(),
    };
    const effectEvent: DeploymentEffectEvent = {
      eventId: `effect_${crypto.randomUUID()}`,
      eventKind: "cloudflare.deployment.promoted",
      shipletId: input.shipletId,
      targetId: target.id,
      revisionId: input.revision.revisionId,
      deploymentId: record.id,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      outcome: "success",
      occurredAt: dependencies.now(),
    };
    let finalized: boolean;
    try {
      finalized = await dependencies.repository.finalizeTargetOperation({
        journalId,
        record,
        effectEvent,
      });
    } catch {
      await compensateProvider(
        target,
        input.actor,
        compensationVersionId,
        journalId,
        compensationRevisionId,
        compensationPackageDigest,
      );
      await recordFailure(input, "deployment_reconciliation_required");
      await abortOperation(
        journalId,
        "reconcile_required",
        "repository_finalize_failed",
      );
      return {
        ok: false as const,
        reason: "deployment_reconciliation_required" as const,
      };
    }
    if (!finalized) {
      const compensated = await compensateProvider(
        target,
        input.actor,
        compensationVersionId,
        journalId,
        compensationRevisionId,
        compensationPackageDigest,
      );
      if (!compensated) {
        await abortOperation(
          journalId,
          "reconcile_required",
          "deployment_conflict",
        );
      }
      await recordFailure(input, "deployment_conflict");
      return { ok: false as const, reason: "deployment_conflict" as const };
    }
    const result = { ok: true as const, deployment: record };
    try {
      await dependencies.audit(effectEvent);
    } catch {
      await abortOperation(
        journalId,
        "reconcile_required",
        "audit_write_failed",
      );
      return {
        ok: false as const,
        reason: "deployment_reconciliation_required" as const,
      };
    }
    return result;
  };

  const rollbackCustomerRevision = async (input: RollbackInput) => {
    input = structuredClone(input);
    const target = await dependencies.repository.getTargetScoped({
      shipletId: input.shipletId,
      targetId: input.targetId,
    });
    if (!target || target.ownerUserId !== input.actor.id) {
      return { ok: false as const, reason: "target_not_found" as const };
    }
    if (!target.connectionId) {
      return {
        ok: false as const,
        reason: "oauth_connection_required" as const,
      };
    }
    if (target.status === "revoked") {
      return { ok: false as const, reason: "connection_revoked" as const };
    }
    const current = await dependencies.repository.getKnownGood(target.id);
    if (!current || current.id !== input.expectedKnownGoodDeploymentId) {
      return { ok: false as const, reason: "deployment_conflict" as const };
    }
    const selected = await dependencies.repository.getDeploymentScoped({
      shipletId: input.shipletId,
      targetId: target.id,
      deploymentId: input.toDeploymentId,
    });
    if (!selected || selected.status !== "known_good") {
      return {
        ok: false as const,
        reason: "known_good_deployment_not_found" as const,
      };
    }
    const [selectedPackageDigest, currentPackageDigest] = await Promise.all([
      dependencies.repository.resolveRevisionPackageDigest?.({
        shipletId: input.shipletId,
        revisionId: selected.revisionId,
      }),
      dependencies.repository.resolveRevisionPackageDigest?.({
        shipletId: input.shipletId,
        revisionId: current.revisionId,
      }),
    ]);
    if (!selectedPackageDigest || !currentPackageDigest) {
      return {
        ok: false as const,
        reason: "revision_package_digest_unavailable" as const,
      };
    }
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
    const reservation = await reserveOperation(target, {
      idempotencyKey,
      operation: "rollback",
      revisionId: selected.revisionId,
      expectedKnownGoodDeploymentId: current.id,
      intent: {
        operation: "rollback",
        shipletId: input.shipletId,
        targetId: target.id,
        accountId: target.providerAccountId,
        scriptName: target.providerScriptName,
        revisionId: selected.revisionId,
        rollbackDestinationDeploymentId: selected.id,
        rollbackDestinationVersionId: selected.providerVersionId,
        expectedKnownGoodDeploymentId: current.id,
      },
    });
    if (!reservation.ok) return reservation;
    if (reservation.cached) return reservation.cached;
    const journalId = reservation.journalId!;

    const rollbackRequest = {
      actorId: input.actor.id,
      shipletId: input.shipletId,
      targetId: target.id,
      accountId: target.providerAccountId,
      scriptName: target.providerScriptName,
      versionId: selected.providerVersionId,
      percentage: 100 as const,
      revisionId: selected.revisionId,
      packageDigest: selectedPackageDigest,
    };
    const authorization = await authorizeProvider(
      target,
      input.actor,
      selected.revisionId,
      selectedPackageDigest,
      "worker.deployment.rollback",
      [CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite],
      rollbackRequest,
    );
    if (!authorization.ok) {
      await abortOperation(journalId, "aborted", authorization.reason);
      return authorization;
    }
    let currentTarget: CloudflareDeploymentTarget | null;
    try {
      currentTarget = await dependencies.repository.getTargetScoped({
        shipletId: input.shipletId,
        targetId: input.targetId,
      });
    } catch {
      await abortOperation(journalId, "aborted", "connection_revoked");
      return { ok: false as const, reason: "connection_revoked" as const };
    }
    if (
      !currentTarget ||
      currentTarget.ownerUserId !== input.actor.id ||
      currentTarget.connectionId !== target.connectionId ||
      currentTarget.providerAccountId !== target.providerAccountId ||
      currentTarget.providerScriptName !== target.providerScriptName ||
      currentTarget.status === "revoked"
    ) {
      await abortOperation(journalId, "aborted", "connection_revoked");
      return { ok: false as const, reason: "connection_revoked" as const };
    }
    const reauthorization = await authorizeProvider(
      currentTarget,
      input.actor,
      selected.revisionId,
      selectedPackageDigest,
      "worker.deployment.rollback",
      [CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite],
      rollbackRequest,
    );
    if (!reauthorization.ok) {
      await abortOperation(journalId, "aborted", reauthorization.reason);
      return reauthorization;
    }
    const immediatelyCurrent = await revalidateTargetAttachment({
      original: target,
      actor: input.actor,
    });
    if (!immediatelyCurrent.ok) {
      await abortOperation(
        journalId,
        immediatelyCurrent.reason === "deployment_reconciliation_required"
          ? "reconcile_required"
          : "aborted",
        immediatelyCurrent.reason,
      );
      return immediatelyCurrent;
    }
    if (
      !(await recheckOperation({
        journalId,
        shipletId: input.shipletId,
        targetId: target.id,
        expectedKnownGoodDeploymentId: current.id,
      }))
    ) {
      await abortOperation(journalId, "aborted", "deployment_conflict");
      return { ok: false as const, reason: "deployment_conflict" as const };
    }
    let providerDeployment: { deploymentId: string };
    try {
      providerDeployment = await dependencies.provider.createDeployment(
        providerEnvelope(reauthorization.authorization, rollbackRequest),
      );
    } catch {
      await abortOperation(
        journalId,
        "reconcile_required",
        "provider_deployment_outcome_ambiguous",
      );
      return {
        ok: false as const,
        reason: "deployment_reconciliation_required" as const,
      };
    }
    const record: ShipletDeploymentRecord = {
      id: deploymentId(),
      targetId: target.id,
      revisionId: selected.revisionId,
      providerVersionId: selected.providerVersionId,
      providerDeploymentId: providerDeployment.deploymentId,
      status: "known_good",
      supersedesDeploymentId: current.id,
      deployedAt: dependencies.now(),
    };
    const effectEvent: DeploymentEffectEvent = {
      eventId: `effect_${crypto.randomUUID()}`,
      eventKind: "cloudflare.deployment.rolled_back",
      shipletId: input.shipletId,
      targetId: target.id,
      revisionId: selected.revisionId,
      deploymentId: record.id,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      outcome: "success",
      occurredAt: dependencies.now(),
    };
    let finalized: boolean;
    try {
      finalized = await dependencies.repository.finalizeTargetOperation({
        journalId,
        record,
        effectEvent,
      });
    } catch {
      await compensateProvider(
        target,
        input.actor,
        current.providerVersionId,
        journalId,
        current.revisionId,
        currentPackageDigest,
      );
      await abortOperation(
        journalId,
        "reconcile_required",
        "repository_finalize_failed",
      );
      return {
        ok: false as const,
        reason: "deployment_reconciliation_required" as const,
      };
    }
    if (!finalized) {
      const compensated = await compensateProvider(
        target,
        input.actor,
        current.providerVersionId,
        journalId,
        current.revisionId,
        currentPackageDigest,
      );
      if (!compensated) {
        await abortOperation(
          journalId,
          "reconcile_required",
          "deployment_conflict",
        );
      }
      return { ok: false as const, reason: "deployment_conflict" as const };
    }
    const result = { ok: true as const, deployment: record };
    try {
      await dependencies.audit(effectEvent);
    } catch {
      await abortOperation(
        journalId,
        "reconcile_required",
        "audit_write_failed",
      );
      return {
        ok: false as const,
        reason: "deployment_reconciliation_required" as const,
      };
    }
    return result;
  };

  const getTemporaryClaimRecord = async (targetId: string) =>
    dependencies.repository.getTemporaryClaim
      ? dependencies.repository.getTemporaryClaim(targetId)
      : (dependencies.repository.temporaryClaims?.get(targetId) ?? null);

  const cleanupTemporaryClaimFailure = async (input: {
    target: CloudflareDeploymentTarget;
    actor: DeploymentActor;
    shipletId: string;
    revisionId: string;
    packageDigest: string;
    journalId: string;
    created: Awaited<
      ReturnType<CloudflareDeploymentProvider["createTemporaryDeployment"]>
    >;
    vaultRef: string | null;
    failureReason: string;
  }) => {
    let providerCleaned = false;
    try {
      const cleanupRequest = {
        operationId: input.journalId,
        actorId: input.actor.id,
        shipletId: input.target.shipletId,
        targetId: input.target.id,
        accountId: input.target.providerAccountId,
        scriptName: input.target.providerScriptName,
        revisionId: input.revisionId,
        packageDigest: input.packageDigest,
        providerDeploymentId: input.created.providerDeploymentId,
        providerVersionId: input.created.providerVersionId,
      };
      const cleanupAuthorization = await authorizeTemporaryProvider(
        input.target,
        input.actor,
        {
          revisionId: input.revisionId,
          packageDigest: input.packageDigest,
        },
        "temporary.deployment.cleanup",
        CLOUDFLARE_TEMPORARY_DEPLOYMENT_SCOPES.cleanup,
        cleanupRequest,
      );
      if (!cleanupAuthorization.ok) throw new Error("cleanup_denied");
      await dependencies.provider.cleanupTemporaryDeployment(
        providerEnvelope(cleanupAuthorization.authorization, cleanupRequest),
      );
      providerCleaned = true;
    } catch {
      providerCleaned = false;
    }

    if (!providerCleaned || input.vaultRef !== null) {
      try {
        await dependencies.repository.recordTemporaryClaim({
          targetId: input.target.id,
          shipletId: input.shipletId,
          revisionId: input.revisionId,
          vaultRef: input.vaultRef,
          providerDeploymentId: input.created.providerDeploymentId,
          providerVersionId: input.created.providerVersionId,
          status: "cleanup_retry",
          expiresAt: Number.isSafeInteger(input.created.expiresAt)
            ? input.created.expiresAt
            : null,
          providerCleaned,
          failureReason: input.failureReason,
        });
      } catch {
        await abortOperation(
          input.journalId,
          "reconcile_required",
          "claim_cleanup_journal_failed",
        );
        return {
          ok: false as const,
          reason: "claim_cleanup_reconciliation_required" as const,
        };
      }
      await abortOperation(
        input.journalId,
        "reconcile_required",
        "claim_cleanup_retry_required",
      );
      return {
        ok: false as const,
        reason: "claim_cleanup_retry_required" as const,
      };
    }

    await abortOperation(input.journalId, "failed", input.failureReason);
    return { ok: false as const, reason: input.failureReason };
  };

  const createTemporaryClaimDeployment = async (
    input: CustomerDeploymentInput,
  ) => {
    input = snapshotCustomerDeploymentInput(input);
    const target = await dependencies.repository.getTargetScoped({
      shipletId: input.shipletId,
      targetId: input.targetId,
    });
    if (
      !target ||
      target.kind !== "temporary_claim" ||
      target.ownerUserId !== input.actor.id
    ) {
      return { ok: false as const, reason: "target_not_found" as const };
    }
    if (input.revision.shipletId !== input.shipletId) {
      return {
        ok: false as const,
        reason: "revision_scope_mismatch" as const,
      };
    }
    if (target.status === "claimed") {
      return { ok: false as const, reason: "claim_already_claimed" as const };
    }
    if (target.status === "revoked") {
      return { ok: false as const, reason: "target_revoked" as const };
    }
    if (
      !hasExactCloudflareTemporaryAccountPolicyAcceptance(
        input.cloudflarePolicyAcceptance,
      )
    ) {
      return {
        ok: false as const,
        reason: "cloudflare_policy_acceptance_required" as const,
      };
    }
    const policyAcceptance = input.cloudflarePolicyAcceptance;
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
    const reservation = await reserveOperation(target, {
      idempotencyKey,
      operation: "claim_create",
      revisionId: input.revision.revisionId,
      expectedKnownGoodDeploymentId: null,
      intent: {
        operation: "claim_create",
        shipletId: input.shipletId,
        targetId: target.id,
        accountId: target.providerAccountId,
        scriptName: target.providerScriptName,
        revisionId: input.revision.revisionId,
        packageDigest: input.revision.packageDigest,
        cloudflarePolicyAcceptance: policyAcceptance,
      },
    });
    if (!reservation.ok) return reservation;
    if (reservation.cachedPublic) {
      return (
        safeTemporaryClaimReplay(reservation.cachedPublic, {
          targetId: target.id,
          revisionId: input.revision.revisionId,
          now: dependencies.now(),
        }) ?? {
          ok: false as const,
          reason: "claim_replay_corrupt" as const,
        }
      );
    }
    if (reservation.cached) return reservation.cached;
    const journalId = reservation.journalId!;
    const recovering = reservation.recovering === true;
    let existingClaim: Record<string, unknown> | null;
    try {
      existingClaim = await getTemporaryClaimRecord(target.id);
    } catch {
      await abortOperation(
        journalId,
        "reconcile_required",
        "claim_state_read_failed",
      );
      return {
        ok: false as const,
        reason: "claim_cleanup_reconciliation_required" as const,
      };
    }
    if (existingClaim && !recovering) {
      const reason =
        existingClaim.status === "delivered"
          ? ("claim_already_delivered" as const)
          : ("claim_already_exists" as const);
      await abortOperation(journalId, "aborted", reason);
      return { ok: false as const, reason };
    }
    let created: Awaited<
      ReturnType<CloudflareDeploymentProvider["createTemporaryDeployment"]>
    >;
    const temporaryRequest = {
      operationId: journalId,
      termsOfService: policyAcceptance.termsOfService,
      privacyPolicy: policyAcceptance.privacyPolicy,
      acceptTermsOfService: policyAcceptance.acceptTermsOfService,
      actorId: input.actor.id,
      shipletId: input.shipletId,
      targetId: target.id,
      accountId: target.providerAccountId,
      scriptName: target.providerScriptName,
      revisionId: input.revision.revisionId,
      packageDigest: input.revision.packageDigest,
      modules: structuredClone(input.revision.modules),
      staticAssets: canonicalProviderStaticAssets(input.revision.staticAssets),
      bindings: [],
    };
    const temporaryAuthorization = await authorizeTemporaryProvider(
      target,
      input.actor,
      input.revision,
      "temporary.deployment.create",
      CLOUDFLARE_TEMPORARY_DEPLOYMENT_SCOPES.create,
      temporaryRequest,
    );
    if (!temporaryAuthorization.ok) {
      await abortOperation(journalId, "aborted", temporaryAuthorization.reason);
      return temporaryAuthorization;
    }
    const immediatelyCurrent = await revalidateTargetAttachment({
      original: target,
      actor: input.actor,
      bindings: [],
    });
    if (!immediatelyCurrent.ok) {
      await abortOperation(
        journalId,
        immediatelyCurrent.reason === "deployment_reconciliation_required"
          ? "reconcile_required"
          : "aborted",
        immediatelyCurrent.reason,
      );
      return immediatelyCurrent;
    }
    if (
      !(await recheckOperation({
        journalId,
        shipletId: input.shipletId,
        targetId: target.id,
        expectedKnownGoodDeploymentId: null,
        allowReconcileRequired: recovering,
      }))
    ) {
      await abortOperation(journalId, "aborted", "operation_in_progress");
      return { ok: false as const, reason: "operation_in_progress" as const };
    }
    try {
      created = await dependencies.provider.createTemporaryDeployment(
        providerEnvelope(
          temporaryAuthorization.authorization,
          temporaryRequest,
        ),
      );
    } catch {
      await abortOperation(
        journalId,
        "reconcile_required",
        "temporary_provider_outcome_ambiguous",
      );
      return {
        ok: false as const,
        reason: "claim_cleanup_reconciliation_required" as const,
      };
    }
    if (!validTemporaryProviderResult(created, dependencies.now())) {
      const structurallyInvalid = created as unknown as Record<string, unknown>;
      if (!hasCompensatableTemporaryIdentity(structurallyInvalid)) {
        await abortOperation(
          journalId,
          "reconcile_required",
          "temporary_provider_outcome_ambiguous",
        );
        return {
          ok: false as const,
          reason: "claim_cleanup_reconciliation_required" as const,
        };
      }
      return cleanupTemporaryClaimFailure({
        target,
        actor: input.actor,
        shipletId: input.shipletId,
        revisionId: input.revision.revisionId,
        packageDigest: input.revision.packageDigest,
        journalId,
        created: created as Awaited<
          ReturnType<CloudflareDeploymentProvider["createTemporaryDeployment"]>
        >,
        vaultRef: null,
        failureReason: isSafeFutureTimestamp(
          Number(structurallyInvalid.expiresAt),
          dependencies.now(),
        )
          ? "temporary_provider_response_invalid"
          : "temporary_provider_expiry_invalid",
      });
    }

    let vaultRef: string;
    try {
      vaultRef = await dependencies.claimVault.store({
        targetId: target.id,
        temporaryAuthorization: created.temporaryAuthorization,
        claimUrl: created.claimUrl,
        expiresAt: created.expiresAt,
      });
    } catch {
      return cleanupTemporaryClaimFailure({
        target,
        actor: input.actor,
        shipletId: input.shipletId,
        revisionId: input.revision.revisionId,
        packageDigest: input.revision.packageDigest,
        journalId,
        created,
        vaultRef: null,
        failureReason: "claim_vault_failed",
      });
    }

    try {
      if (!existingClaim) await dependencies.repository.recordTemporaryClaim({
        operationId: journalId,
        targetId: target.id,
        shipletId: input.shipletId,
        revisionId: input.revision.revisionId,
        vaultRef,
        status: "awaiting_claim",
        expiresAt: created.expiresAt,
        providerDeploymentId: created.providerDeploymentId,
        providerVersionId: created.providerVersionId,
      });
    } catch {
      return cleanupTemporaryClaimFailure({
        target,
        actor: input.actor,
        shipletId: input.shipletId,
        revisionId: input.revision.revisionId,
        packageDigest: input.revision.packageDigest,
        journalId,
        created,
        vaultRef,
        failureReason: "claim_persistence_failed",
      });
    }
    const publicDeployment = {
      id: deploymentId(),
      targetId: target.id,
      revisionId: input.revision.revisionId,
      providerDeploymentId: created.providerDeploymentId,
      providerVersionId: created.providerVersionId,
      status: "awaiting_claim" as const,
      expiresAt: created.expiresAt,
      requiresOAuthConnectionForUpdates: true,
    };
    const safeEvent = {
      eventId: `effect_${crypto.randomUUID()}`,
      eventKind: "cloudflare.temporary_deployment.created",
      shipletId: input.shipletId,
      targetId: target.id,
      revisionId: input.revision.revisionId,
      deploymentId: publicDeployment.id,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      outcome: "success",
      cloudflarePolicyAcceptance: policyAcceptance,
      expiresAt: created.expiresAt,
      occurredAt: dependencies.now(),
    };
    const result = { ok: true as const, deployment: publicDeployment };
    let finalized = false;
    try {
      finalized = await dependencies.repository.finalizeTemporaryClaimOperation(
        {
          journalId,
          publicResult: result,
          effectEvent: safeEvent,
        },
      );
    } catch {
      finalized = false;
    }
    if (!finalized) {
      return cleanupTemporaryClaimFailure({
        target,
        actor: input.actor,
        shipletId: input.shipletId,
        revisionId: input.revision.revisionId,
        packageDigest: input.revision.packageDigest,
        journalId,
        created,
        vaultRef,
        failureReason: "temporary_claim_finalize_failed",
      });
    }
    try {
      await dependencies.audit(safeEvent);
      await dependencies.telemetry(safeEvent);
    } catch {
      await abortOperation(
        journalId,
        "reconcile_required",
        "temporary_claim_event_failed",
      );
      return {
        ok: false as const,
        reason: "claim_cleanup_reconciliation_required" as const,
      };
    }
    return result;
  };

  const prepareTemporaryClaimRedirect = async (input: {
    actor: DeploymentActor;
    shipletId: string;
    targetId: string;
  }) => {
    const target = await dependencies.repository.getTargetScoped({
      shipletId: input.shipletId,
      targetId: input.targetId,
    });
    if (
      !target ||
      target.kind !== "temporary_claim" ||
      target.ownerUserId !== input.actor.id
    ) {
      return { ok: false as const, reason: "claim_not_found" as const };
    }
    if (target.status === "claimed") {
      return { ok: false as const, reason: "claim_already_claimed" as const };
    }
    const record = await getTemporaryClaimRecord(target.id);
    if (!record || typeof record.vaultRef !== "string") {
      return { ok: false as const, reason: "claim_not_found" as const };
    }
    if (
      record.shipletId !== input.shipletId ||
      typeof record.operationId !== "string" ||
      typeof record.revisionId !== "string" ||
      record.revisionId.length === 0 ||
      record.revisionId.length > 256
    ) {
      return { ok: false as const, reason: "claim_scope_invalid" as const };
    }
    const claimRevisionId = record.revisionId;
    if (
      typeof record.expiresAt !== "number" ||
      !Number.isSafeInteger(record.expiresAt)
    ) {
      return { ok: false as const, reason: "claim_expiry_invalid" as const };
    }
    if (dependencies.now() >= record.expiresAt) {
      return { ok: false as const, reason: "claim_expired" as const };
    }
    if (record.status !== "awaiting_claim" && record.status !== "delivered") {
      return { ok: false as const, reason: "claim_not_available" as const };
    }
    let consumed: Awaited<
      ReturnType<TemporaryClaimVault["consumeForBackendRedirect"]>
    >;
    try {
      const occurredAt = dependencies.now();
      consumed = await dependencies.claimVault.consumeForBackendRedirect({
        ref: record.vaultRef,
        now: occurredAt,
        markDelivered: (delivery) => {
          if (
            delivery.operationId !== record.operationId ||
            delivery.deploymentId !== record.vaultRef ||
            delivery.userId !== input.actor.id ||
            delivery.shipletId !== input.shipletId ||
            delivery.targetId !== target.id ||
            delivery.revisionId !== claimRevisionId
          ) {
            return Promise.resolve(false);
          }
          return dependencies.repository.markTemporaryClaimDelivered({
            targetId: target.id,
            expectedStatus: "awaiting_claim",
            delivery: {
              eventId: delivery.deliveryEventId,
              shipletId: input.shipletId,
              revisionId: claimRevisionId,
              actor: input.actor,
              occurredAt,
            },
          });
        },
      });
    } catch {
      return {
        ok: false as const,
        reason: "claim_delivery_conflict" as const,
      };
    }
    if (!consumed.ok) {
      if (record.status === "delivered" && consumed.reason === "claim_not_found") {
        return {
          ok: false as const,
          reason: "claim_already_consumed" as const,
        };
      }
      return { ok: false as const, reason: consumed.reason };
    }
    return { ok: true as const, redirect: consumed.redirect };
  };

  const consumeTemporaryClaim = async (input: {
    actor: DeploymentActor;
    shipletId: string;
    targetId: string;
  }) => {
    const prepared = await prepareTemporaryClaimRedirect(input);
    if (!prepared.ok) return prepared;
    return { ok: true as const, status: "redirect_ready" as const };
  };

  const redeemTemporaryClaim = async (input: {
    actor: DeploymentActor;
    shipletId: string;
    targetId: string;
  }) => {
    const prepared = await prepareTemporaryClaimRedirect(input);
    if (!prepared.ok) {
      return new Response(null, {
        status: prepared.reason === "claim_not_found" ? 404 : 410,
      });
    }
    let response: Response | null;
    try {
      response = await dependencies.claimVault.redeemBackendRedirect({
        opaqueHandle: prepared.redirect.opaqueHandle,
      });
    } catch {
      response = null;
    }
    const location = response?.headers.get("location");
    if (!response || response.status !== 303 || !location) {
      return new Response(null, { status: 410 });
    }
    return new Response(null, {
      status: 303,
      headers: { location },
    });
  };

  return {
    deployCustomerRevision,
    rollbackCustomerRevision,
    createTemporaryClaimDeployment,
    consumeTemporaryClaim,
    redeemTemporaryClaim,
  };
}

export function createManagedInvocationPolicy(input: {
  shipletId: string;
  revisionId: string;
  deploymentId: string;
  invocationId: string;
  limits: { cpuMs: number; subRequests: number };
  trustedMaximums: { cpuMs: number; subRequests: number };
  egressGrantIds: string[];
  authorizedEgressGrants: Array<{
    id: string;
    status: string;
    shipletId: string;
    revisionId: string;
    deploymentId: string;
  }>;
}) {
  if (
    !Number.isInteger(input.limits.cpuMs) ||
    input.limits.cpuMs <= 0 ||
    !Number.isInteger(input.limits.subRequests) ||
    input.limits.subRequests < 0
  ) {
    throw new Error("invalid_managed_invocation_limits");
  }
  if (
    input.limits.cpuMs > input.trustedMaximums.cpuMs ||
    input.limits.subRequests > input.trustedMaximums.subRequests
  ) {
    throw new Error("managed_limit_exceeded");
  }
  for (const grantId of input.egressGrantIds) {
    const grant = input.authorizedEgressGrants.find(
      (candidate) => candidate.id === grantId,
    );
    if (
      !grant ||
      grant.status !== "active" ||
      grant.shipletId !== input.shipletId ||
      grant.revisionId !== input.revisionId ||
      grant.deploymentId !== input.deploymentId
    ) {
      throw new Error("egress_grant_not_authorized");
    }
  }
  return {
    limits: {
      cpuMs: input.limits.cpuMs,
      subRequests: input.limits.subRequests,
    },
    bindings: [] as never[],
    outbound: {
      mode:
        input.egressGrantIds.length === 0
          ? ("deny_all" as const)
          : ("brokered" as const),
      metadata: {
        invocationId: input.invocationId,
        egressGrantIds: [...input.egressGrantIds],
      },
    },
  };
}
