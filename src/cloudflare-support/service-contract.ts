export const SUPPORT_ENTRYPOINTS = Object.freeze([
  Object.freeze({
    service: "shiplet-cloudflare-control-plane",
    entrypoint: "CloudflareOAuthControlPlane",
  }),
  Object.freeze({
    service: "shiplet-cloudflare-control-plane",
    entrypoint: "CloudflareGrantVaultRpc",
  }),
  Object.freeze({
    service: "shiplet-cloudflare-control-plane",
    entrypoint: "CloudflareTemporaryAccountRpc",
  }),
  Object.freeze({
    service: "shiplet-managed-runtime-gateway",
    entrypoint: "CloudflareVersionHealthRpc",
  }),
  Object.freeze({
    service: "shiplet-managed-runtime-gateway",
    entrypoint: "CustomMcpRuntimeRpc",
  }),
  Object.freeze({
    service: "shiplet-managed-runtime-gateway",
    entrypoint: "ManagedRuntimeGateway",
  }),
] as const);

/**
 * Support entrypoints used only inside the managed-runtime trust boundary.
 * They are intentionally separate from SUPPORT_ENTRYPOINTS because the main
 * kernel never receives these bindings directly.
 */
export const INTERNAL_SUPPORT_ENTRYPOINTS = Object.freeze([
  Object.freeze({
    service: "shiplet-cloudflare-control-plane",
    entrypoint: "CloudflareManagedDeploymentBrokerRpc",
  }),
  Object.freeze({
    service: "shiplet-deny-egress",
    entrypoint: "DenyEgressContractRpc",
  }),
] as const);

type SupportEntrypoint = (typeof SUPPORT_ENTRYPOINTS)[number];

export type SupportEntrypointContract = Readonly<{
  schemaVersion: "shiplet.support/v1";
  service: SupportEntrypoint["service"];
  entrypoint: SupportEntrypoint["entrypoint"];
  versionId: string;
  versionTag?: string;
}>;

export type SupportReleaseExpectation = Readonly<{
  versionId: string;
  versionTag: string;
}>;

export type ManagedRuntimeReleaseExpectation = Readonly<{
  gateway: SupportReleaseExpectation;
  deploymentBroker: SupportReleaseExpectation;
  denyEgress: SupportReleaseExpectation;
}>;

type InternalSupportEntrypoint =
  (typeof INTERNAL_SUPPORT_ENTRYPOINTS)[number];

export type InternalSupportEntrypointContract = Readonly<{
  schemaVersion: "shiplet.internal-support/v1";
  service: InternalSupportEntrypoint["service"];
  entrypoint: InternalSupportEntrypoint["entrypoint"];
  versionId: string;
  versionTag?: string;
}>;

const VERSION_ID =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const VERSION_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertSupportReleaseExpectation(
  metadata: { id: string; tag?: string },
  expectation: SupportReleaseExpectation,
) {
  if (
    !VERSION_ID.test(expectation?.versionId) ||
    !VERSION_TAG.test(expectation?.versionTag) ||
    metadata.id.toLowerCase() !== expectation.versionId.toLowerCase() ||
    metadata.tag !== expectation.versionTag
  ) {
    throw new TypeError("support_release_mismatch");
  }
}

function expectedEntrypoint(service: string, entrypoint: string) {
  return SUPPORT_ENTRYPOINTS.some(
    (expected) =>
      expected.service === service && expected.entrypoint === entrypoint,
  );
}

export function createSupportEntrypointContract(
  input: SupportEntrypoint & {
    metadata: { id: string; tag?: string };
  },
): SupportEntrypointContract {
  if (
    !expectedEntrypoint(input.service, input.entrypoint) ||
    !VERSION_ID.test(input.metadata.id) ||
    (input.metadata.tag !== undefined && !VERSION_TAG.test(input.metadata.tag))
  ) {
    throw new TypeError("support_version_metadata_invalid");
  }
  return Object.freeze({
    schemaVersion: "shiplet.support/v1" as const,
    service: input.service,
    entrypoint: input.entrypoint,
    versionId: input.metadata.id.toLowerCase(),
    ...(input.metadata.tag ? { versionTag: input.metadata.tag } : {}),
  });
}

function expectedInternalEntrypoint(service: string, entrypoint: string) {
  return INTERNAL_SUPPORT_ENTRYPOINTS.some(
    (expected) =>
      expected.service === service && expected.entrypoint === entrypoint,
  );
}

export function createInternalSupportEntrypointContract(
  input: InternalSupportEntrypoint & {
    metadata: { id: string; tag?: string };
  },
): InternalSupportEntrypointContract {
  if (
    !expectedInternalEntrypoint(input.service, input.entrypoint) ||
    !VERSION_ID.test(input.metadata.id) ||
    (input.metadata.tag !== undefined && !VERSION_TAG.test(input.metadata.tag))
  ) {
    throw new TypeError("internal_support_version_metadata_invalid");
  }
  return Object.freeze({
    schemaVersion: "shiplet.internal-support/v1" as const,
    service: input.service,
    entrypoint: input.entrypoint,
    versionId: input.metadata.id.toLowerCase(),
    ...(input.metadata.tag ? { versionTag: input.metadata.tag } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function verifyInternalSupportEntrypointContract(
  candidate: unknown,
  expected: InternalSupportEntrypoint | undefined,
  release: SupportReleaseExpectation,
):
  | { ok: true }
  | { ok: false; reason: "internal_support_contract_mismatch" } {
  if (
    !isRecord(candidate) ||
    !expected ||
    Object.keys(candidate).sort().join(",") !==
      "entrypoint,schemaVersion,service,versionId,versionTag" ||
    candidate.schemaVersion !== "shiplet.internal-support/v1" ||
    candidate.service !== expected.service ||
    candidate.entrypoint !== expected.entrypoint ||
    typeof candidate.versionId !== "string" ||
    typeof candidate.versionTag !== "string" ||
    !VERSION_ID.test(release.versionId) ||
    !VERSION_TAG.test(release.versionTag) ||
    candidate.versionId.toLowerCase() !== release.versionId.toLowerCase() ||
    candidate.versionTag !== release.versionTag
  ) {
    return { ok: false, reason: "internal_support_contract_mismatch" };
  }
  return { ok: true };
}

export function verifySupportEntrypointContracts(input: {
  contracts: readonly unknown[];
  expectedControlPlaneVersionId: string;
  expectedRuntimeGatewayVersionId: string;
  expectedVersionTag: string;
}):
  | { ok: true; contracts: readonly SupportEntrypointContract[] }
  | { ok: false; reason: "support_contract_mismatch" } {
  if (
    !VERSION_ID.test(input.expectedControlPlaneVersionId) ||
    !VERSION_ID.test(input.expectedRuntimeGatewayVersionId) ||
    !VERSION_TAG.test(input.expectedVersionTag) ||
    input.contracts.length !== SUPPORT_ENTRYPOINTS.length
  ) {
    return { ok: false, reason: "support_contract_mismatch" };
  }
  const contracts: SupportEntrypointContract[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of input.contracts.entries()) {
    if (!isRecord(candidate)) {
      return { ok: false, reason: "support_contract_mismatch" };
    }
    const keys = Object.keys(candidate).sort();
    if (
      keys.some(
        (key) =>
          ![
            "entrypoint",
            "schemaVersion",
            "service",
            "versionId",
            "versionTag",
          ].includes(key),
      ) ||
      candidate.schemaVersion !== "shiplet.support/v1" ||
      typeof candidate.service !== "string" ||
      typeof candidate.entrypoint !== "string" ||
      typeof candidate.versionId !== "string" ||
      !VERSION_ID.test(candidate.versionId) ||
      (candidate.versionTag !== undefined &&
        (typeof candidate.versionTag !== "string" ||
          !VERSION_TAG.test(candidate.versionTag))) ||
      candidate.versionTag !== input.expectedVersionTag ||
      !expectedEntrypoint(candidate.service, candidate.entrypoint) ||
      candidate.service !== SUPPORT_ENTRYPOINTS[index]?.service ||
      candidate.entrypoint !== SUPPORT_ENTRYPOINTS[index]?.entrypoint
    ) {
      return { ok: false, reason: "support_contract_mismatch" };
    }
    const key = `${candidate.service}#${candidate.entrypoint}`;
    if (seen.has(key)) {
      return { ok: false, reason: "support_contract_mismatch" };
    }
    seen.add(key);
    const expectedVersion =
      candidate.service === "shiplet-cloudflare-control-plane"
        ? input.expectedControlPlaneVersionId
        : input.expectedRuntimeGatewayVersionId;
    if (candidate.versionId.toLowerCase() !== expectedVersion.toLowerCase()) {
      return { ok: false, reason: "support_contract_mismatch" };
    }
    contracts.push(candidate as SupportEntrypointContract);
  }
  if (
    SUPPORT_ENTRYPOINTS.some(
      (expected) => !seen.has(`${expected.service}#${expected.entrypoint}`),
    )
  ) {
    return { ok: false, reason: "support_contract_mismatch" };
  }
  return { ok: true, contracts: Object.freeze(contracts) };
}

export function verifySupportHealthAttestation(
  value: unknown,
  expectation: SupportReleaseExpectation,
):
  | { ok: true }
  | { ok: false; reason: "support_health_mismatch" } {
  const normalized = normalizeSupportHealthAttestation(value, expectation);
  return normalized.ok && normalized.health.status === "healthy"
    ? { ok: true }
    : { ok: false, reason: "support_health_mismatch" };
}

export type NormalizedSupportHealthAttestation = Readonly<{
  schemaVersion: "shiplet.support-health/v1";
  status: "healthy" | "degraded";
  schemaReady: boolean;
  credentialContinuity: "verified" | "unavailable";
  reconciliation: Readonly<{
    status: "missing" | "running" | "success" | "failure";
    fresh: boolean;
    completedAt: number | null;
  }>;
  backlog: Readonly<{
    cleanupPending: number;
    revocationPending: number;
    temporaryAmbiguous: number;
    temporaryAmbiguityExpired: number;
    boundedAt: 101;
  }>;
  release: Readonly<{ versionId: string; versionTag: string }>;
}>;

function exactKeys(value: Record<string, unknown>, expected: string) {
  return Object.keys(value).sort().join(",") === expected;
}

function boundedCount(value: unknown) {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 101
  );
}

/**
 * Treats support-Worker health as untrusted RPC input and returns only the
 * versioned, non-secret contract. Degraded evidence is valid data for an
 * operator response, while the healthy-only verifier remains the rollout gate.
 */
export function normalizeSupportHealthAttestation(
  value: unknown,
  expectation: SupportReleaseExpectation,
):
  | { ok: true; health: NormalizedSupportHealthAttestation }
  | { ok: false; reason: "support_health_mismatch" } {
  if (!isRecord(value)) {
    return { ok: false, reason: "support_health_mismatch" };
  }
  const release = value.release;
  const reconciliation = value.reconciliation;
  const backlog = value.backlog;
  if (
    !exactKeys(
      value,
      "backlog,credentialContinuity,reconciliation,release,schemaReady,schemaVersion,status",
    ) ||
    value.schemaVersion !== "shiplet.support-health/v1" ||
    !["healthy", "degraded"].includes(String(value.status)) ||
    typeof value.schemaReady !== "boolean" ||
    !["verified", "unavailable"].includes(String(value.credentialContinuity)) ||
    !isRecord(release) ||
    !exactKeys(release, "versionId,versionTag") ||
    typeof release.versionId !== "string" ||
    typeof release.versionTag !== "string" ||
    !VERSION_ID.test(expectation.versionId) ||
    !VERSION_TAG.test(expectation.versionTag) ||
    release.versionId.toLowerCase() !== expectation.versionId.toLowerCase() ||
    release.versionTag !== expectation.versionTag ||
    !isRecord(reconciliation) ||
    !exactKeys(reconciliation, "completedAt,fresh,status") ||
    !["missing", "running", "success", "failure"].includes(
      String(reconciliation.status),
    ) ||
    typeof reconciliation.fresh !== "boolean" ||
    (reconciliation.completedAt !== null &&
      (!Number.isSafeInteger(reconciliation.completedAt) ||
        (reconciliation.completedAt as number) < 0)) ||
    !isRecord(backlog) ||
    !exactKeys(
      backlog,
      "boundedAt,cleanupPending,revocationPending,temporaryAmbiguityExpired,temporaryAmbiguous",
    ) ||
    backlog.boundedAt !== 101 ||
    !boundedCount(backlog.cleanupPending) ||
    !boundedCount(backlog.revocationPending) ||
    !boundedCount(backlog.temporaryAmbiguous) ||
    !boundedCount(backlog.temporaryAmbiguityExpired)
  ) {
    return { ok: false, reason: "support_health_mismatch" };
  }

  const reconciliationShapeValid =
    reconciliation.status === "success"
      ? reconciliation.completedAt !== null
      : reconciliation.status === "failure"
        ? reconciliation.completedAt !== null && reconciliation.fresh === false
        : reconciliation.completedAt === null && reconciliation.fresh === false;
  const genuinelyHealthy =
    value.schemaReady === true &&
    value.credentialContinuity === "verified" &&
    reconciliation.status === "success" &&
    reconciliation.fresh === true &&
    backlog.cleanupPending === 0 &&
    backlog.revocationPending === 0 &&
    backlog.temporaryAmbiguous === 0 &&
    backlog.temporaryAmbiguityExpired === 0;
  if (
    !reconciliationShapeValid ||
    (value.schemaReady === false &&
      value.credentialContinuity !== "unavailable") ||
    value.status !== (genuinelyHealthy ? "healthy" : "degraded")
  ) {
    return { ok: false, reason: "support_health_mismatch" };
  }

  return {
    ok: true,
    health: Object.freeze({
      schemaVersion: "shiplet.support-health/v1" as const,
      status: value.status as "healthy" | "degraded",
      schemaReady: value.schemaReady,
      credentialContinuity: value.credentialContinuity as
        | "verified"
        | "unavailable",
      reconciliation: Object.freeze({
        status: reconciliation.status as
          | "missing"
          | "running"
          | "success"
          | "failure",
        fresh: reconciliation.fresh,
        completedAt: reconciliation.completedAt as number | null,
      }),
      backlog: Object.freeze({
        cleanupPending: backlog.cleanupPending as number,
        revocationPending: backlog.revocationPending as number,
        temporaryAmbiguous: backlog.temporaryAmbiguous as number,
        temporaryAmbiguityExpired: backlog.temporaryAmbiguityExpired as number,
        boundedAt: 101 as const,
      }),
      release: Object.freeze({
        versionId: release.versionId.toLowerCase(),
        versionTag: release.versionTag,
      }),
    }),
  };
}
