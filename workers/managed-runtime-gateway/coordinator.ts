import {
  createManagedDispatchInvocation,
  type ActiveManagedRevision,
  type ManagedRevisionBinding,
} from "../../src/cloudflare-support/managed-runtime";
import {
  INTERNAL_SUPPORT_ENTRYPOINTS,
  assertSupportReleaseExpectation,
  verifyInternalSupportEntrypointContract,
  type ManagedRuntimeReleaseExpectation,
  type SupportReleaseExpectation,
} from "../../src/cloudflare-support/service-contract";
import {
  ensureManagedRuntimeStateNamespace,
  extractManagedRuntimeStatePermissions,
  managedRuntimeStateMode,
  type ManagedRuntimeStatePermission,
} from "../../src/managed-runtime/state";

export type RuntimeModule = Readonly<{
  name: string;
  mediaType: string;
  content: string;
  encoding?: "utf8" | "base64";
}>;

export type ManagedPolicy = Readonly<{
  cpuMs: number;
  subRequests: number;
}>;

export type StageRevisionInput = Readonly<{
  actorId: string;
  operationId?: string;
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  mainModule: string;
  modules: readonly RuntimeModule[];
  policy: ManagedPolicy;
}>;

export type ActivateRevisionInput = Readonly<{
  actorId: string;
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  expectedActivationGeneration: number;
}>;

export type AcknowledgeActivationInput = ActivateRevisionInput &
  Readonly<{ reason: "promote" | "rollback" }>;

export type ManagedDeploymentNamespace =
  | "shiplet-managed-staging"
  | "shiplet-managed-production";

type ManagedDeploymentIdentity = Readonly<{
  operationId: string;
  namespace: ManagedDeploymentNamespace;
  scriptName: string;
  shipletId: string;
  revisionId: string;
  packageDigest: string;
}>;

export type ManagedDeploymentInspectInput = ManagedDeploymentIdentity &
  Readonly<{ schemaVersion: "shiplet.managed-deployment-inspect/v1" }>;

export type ManagedDeploymentDeleteInput = ManagedDeploymentIdentity &
  Readonly<{ schemaVersion: "shiplet.managed-deployment-delete/v1" }>;

export type ManagedDeploymentUploadInput = ManagedDeploymentIdentity &
  Readonly<{
    schemaVersion: "shiplet.managed-deployment/v1";
    mainModule: string;
    compatibilityDate: "2026-08-07";
    modules: readonly Readonly<{
      name: string;
      mediaType: string;
      bytes: Uint8Array;
    }>[];
    bindings: readonly [];
  }>;

export type ManagedDeploymentProof = ManagedDeploymentIdentity &
  Readonly<{
    schemaVersion: "shiplet.managed-deployment-proof/v1";
    status: "present" | "absent";
  }>;

export type ManagedDeploymentReadiness = Readonly<{
  schemaVersion: "shiplet.managed-deployment-readiness/v1";
  operations: readonly ["inspect", "upload", "delete"];
  namespaces: readonly [
    Readonly<{
      name: "shiplet-managed-staging";
      trustedWorkers: false;
    }>,
    Readonly<{
      name: "shiplet-managed-production";
      trustedWorkers: false;
    }>,
  ];
}>;

export interface ManagedDeploymentBroker {
  contract(): Promise<unknown>;
  assertPlatformReservation(
    expectation: SupportReleaseExpectation,
  ): Promise<unknown>;
  readiness(expectation: SupportReleaseExpectation): Promise<unknown>;
  inspect(
    input: ManagedDeploymentInspectInput,
    expectation: SupportReleaseExpectation,
  ): Promise<unknown>;
  upload(
    input: ManagedDeploymentUploadInput,
    expectation: SupportReleaseExpectation,
  ): Promise<unknown>;
  delete(
    input: ManagedDeploymentDeleteInput,
    expectation: SupportReleaseExpectation,
  ): Promise<unknown>;
}

export interface InternalContractBinding {
  contract(): Promise<unknown>;
}

type RuntimeDatabase = Pick<D1Database, "prepare" | "batch">;

export interface ManagedRuntimeCoordinatorEnv {
  RUNTIME_DB: RuntimeDatabase;
  STAGING_DISPATCH: DispatchNamespace;
  PRODUCTION_DISPATCH: DispatchNamespace;
  MANAGED_DEPLOYMENT_BROKER: ManagedDeploymentBroker;
  DENY_EGRESS_CONTRACT: InternalContractBinding;
  CF_VERSION_METADATA: { id: string; tag?: string };
}

type ManagedRevisionRow = {
  shiplet_id: string;
  revision_id: string;
  package_digest: string;
  script_name: string;
  state_namespace: string;
  state_scope_namespace: string | null;
  state_permissions_json: string;
  policy_json: string;
  stage_status: "staging" | "validated" | "failed";
  stage_operation_id?: string | null;
  stage_lease_id?: string | null;
  stage_lease_expires_on?: string | null;
};

type ManagedActivationRow = {
  shiplet_id: string;
  revision_id: string;
  package_digest: string;
  script_name: string;
  generation: number;
  operation_id: string | null;
};

type ManagedActivationHistoryRow = {
  id: string;
  shiplet_id: string;
  to_revision_id: string;
  to_generation: number;
  actor_id: string;
  reason: "promote" | "rollback";
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MODULE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,255}$/;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const OPERATION_ID = /^managed_[A-Za-z0-9_-]{43}$/;
const MAX_MODULES = 1_000;
const MAX_MODULE_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const MAX_HEALTH_BYTES = 64 * 1024;
const STAGE_LEASE_MS = 15 * 60 * 1_000;
const STAGING_NAMESPACE = "shiplet-managed-staging" as const;
const PRODUCTION_NAMESPACE = "shiplet-managed-production" as const;
const COMPATIBILITY_DATE = "2026-08-07" as const;
const NO_AMBIENT_BINDINGS: readonly [] = Object.freeze([]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string) {
  return Object.keys(value).sort().join(",") === expected;
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function encodeBase64(bytes: Uint8Array) {
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 16_384) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(output);
}

function decodeBase64(value: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new TypeError("managed_module_invalid");
  }
  try {
    const bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
    if (encodeBase64(bytes) !== value) {
      throw new TypeError("managed_module_invalid");
    }
    return bytes;
  } catch {
    throw new TypeError("managed_module_invalid");
  }
}

function moduleBytes(module: RuntimeModule) {
  const bytes =
    module.encoding === "base64"
      ? decodeBase64(module.content)
      : new TextEncoder().encode(module.content);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MODULE_BYTES) {
    throw new TypeError("managed_module_invalid");
  }
  return bytes;
}

function validPolicy(policy: ManagedPolicy) {
  return (
    Number.isSafeInteger(policy.cpuMs) &&
    policy.cpuMs > 0 &&
    policy.cpuMs <= 30_000 &&
    Number.isSafeInteger(policy.subRequests) &&
    policy.subRequests >= 0 &&
    policy.subRequests <= 1_000
  );
}

function validateStage(input: StageRevisionInput) {
  if (
    !IDENTIFIER.test(input.actorId) ||
    (input.operationId !== undefined &&
      !OPERATION_ID.test(input.operationId)) ||
    !IDENTIFIER.test(input.shipletId) ||
    !IDENTIFIER.test(input.revisionId) ||
    !PACKAGE_DIGEST.test(input.packageDigest) ||
    !MODULE_NAME.test(input.mainModule) ||
    !Array.isArray(input.modules) ||
    input.modules.length === 0 ||
    input.modules.length > MAX_MODULES ||
    !validPolicy(input.policy)
  ) {
    throw new TypeError("managed_revision_invalid");
  }
  const names = new Set<string>();
  let total = 0;
  const modules = input.modules.map((module) => {
    if (
      !MODULE_NAME.test(module.name) ||
      names.has(module.name) ||
      !MEDIA_TYPE.test(module.mediaType) ||
      typeof module.content !== "string" ||
      (module.encoding !== undefined &&
        module.encoding !== "utf8" &&
        module.encoding !== "base64")
    ) {
      throw new TypeError("managed_module_invalid");
    }
    names.add(module.name);
    const bytes = moduleBytes(module);
    total += bytes.byteLength;
    if (total > MAX_BUNDLE_BYTES) {
      throw new TypeError("managed_bundle_too_large");
    }
    return Object.freeze({
      name: module.name,
      mediaType: module.mediaType,
      bytes,
    });
  });
  if (!names.has(input.mainModule)) {
    throw new TypeError("managed_main_module_invalid");
  }
  return Object.freeze(modules);
}

async function digest(value: string) {
  return encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

async function operationId(parts: readonly string[]) {
  return `managed_${await digest(parts.join("\u0000"))}`;
}

async function runtimeNames(
  input: StageRevisionInput,
  statePermissions: readonly ManagedRuntimeStatePermission[],
) {
  const value = await digest(
    `${input.shipletId}\u0000${input.revisionId}\u0000${input.packageDigest}`,
  );
  return Object.freeze({
    scriptName: `shiplet-${value}`,
    stateNamespace: `state-${value}`,
    stateScopeNamespace:
      statePermissions.length === 0
        ? null
        : `state-${await digest(`shiplet-state\u0000${input.shipletId}`)}`,
    statePermissionsJson: JSON.stringify(statePermissions),
  });
}

function validRevisionBinding(value: ManagedRevisionBinding) {
  return (
    isRecord(value) &&
    IDENTIFIER.test(value.shipletId) &&
    IDENTIFIER.test(value.revisionId) &&
    PACKAGE_DIGEST.test(value.packageDigest) &&
    Number.isSafeInteger(value.activationGeneration) &&
    value.activationGeneration > 0
  );
}

function normalizeDeploymentProof(
  value: unknown,
  expected: ManagedDeploymentIdentity,
): ManagedDeploymentProof {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      "namespace,operationId,packageDigest,revisionId,schemaVersion,scriptName,shipletId,status",
    ) ||
    !OPERATION_ID.test(expected.operationId) ||
    value.schemaVersion !== "shiplet.managed-deployment-proof/v1" ||
    value.operationId !== expected.operationId ||
    value.namespace !== expected.namespace ||
    value.scriptName !== expected.scriptName ||
    value.shipletId !== expected.shipletId ||
    value.revisionId !== expected.revisionId ||
    value.packageDigest !== expected.packageDigest ||
    (value.status !== "present" && value.status !== "absent")
  ) {
    throw new Error("managed_deployment_proof_mismatch");
  }
  return Object.freeze(value as ManagedDeploymentProof);
}

function normalizeDeploymentReadiness(value: unknown) {
  if (
    !isRecord(value) ||
    !exactKeys(value, "namespaces,operations,schemaVersion") ||
    value.schemaVersion !== "shiplet.managed-deployment-readiness/v1" ||
    !Array.isArray(value.operations) ||
    value.operations.length !== 3 ||
    value.operations[0] !== "inspect" ||
    value.operations[1] !== "upload" ||
    value.operations[2] !== "delete" ||
    !Array.isArray(value.namespaces) ||
    value.namespaces.length !== 2
  ) {
    throw new Error("managed_runtime_dependency_mismatch");
  }
  const [staging, production] = value.namespaces;
  if (
    !isRecord(staging) ||
    !exactKeys(staging, "name,trustedWorkers") ||
    staging.name !== STAGING_NAMESPACE ||
    staging.trustedWorkers !== false ||
    !isRecord(production) ||
    !exactKeys(production, "name,trustedWorkers") ||
    production.name !== PRODUCTION_NAMESPACE ||
    production.trustedWorkers !== false
  ) {
    throw new Error("managed_runtime_dependency_mismatch");
  }
  return Object.freeze(value as ManagedDeploymentReadiness);
}

function normalizePlatformReservationAssertion(value: unknown) {
  if (!isRecord(value) || !exactKeys(value, "ok") || value.ok !== true) {
    throw new Error("managed_platform_reservation_unavailable");
  }
  return Object.freeze({ ok: true as const });
}

async function readBounded(response: Response, maximumBytes: number) {
  if (!response.body || maximumBytes <= 0 || maximumBytes > MAX_HEALTH_BYTES) {
    throw new Error("managed_health_failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error("managed_health_failed");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parsePolicy(value: string): ManagedPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("managed_policy_corrupt");
  }
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, "cpuMs,subRequests") ||
    !validPolicy(parsed as ManagedPolicy)
  ) {
    throw new Error("managed_policy_corrupt");
  }
  return Object.freeze(parsed as ManagedPolicy);
}

function exactRevisionRow(
  row: ManagedRevisionRow,
  input: StageRevisionInput,
  names: {
    scriptName: string;
    stateNamespace: string;
    stateScopeNamespace: string | null;
    statePermissionsJson: string;
  },
) {
  return (
    row.shiplet_id === input.shipletId &&
    row.revision_id === input.revisionId &&
    row.package_digest === input.packageDigest &&
    row.script_name === names.scriptName &&
    row.state_namespace === names.stateNamespace &&
    row.state_scope_namespace === names.stateScopeNamespace &&
    row.state_permissions_json === names.statePermissionsJson &&
    row.policy_json === JSON.stringify(input.policy)
  );
}

function statePermissions(row: ManagedRevisionRow) {
  let value: unknown;
  try {
    value = JSON.parse(row.state_permissions_json) as unknown;
  } catch {
    throw new Error("managed_state_contract_corrupt");
  }
  if (
    !Array.isArray(value) ||
    value.length > 2 ||
    value.some((item) => item !== "read" && item !== "write") ||
    [...new Set(value)].sort().join(",") !== value.join(",") ||
    (value.length === 0) !== (row.state_scope_namespace === null)
  ) {
    throw new Error("managed_state_contract_corrupt");
  }
  return Object.freeze(value as ManagedRuntimeStatePermission[]);
}

function invocationOptions(input: {
  options: Readonly<Record<string, unknown>>;
  revision: ManagedRevisionRow;
  binding: ManagedRevisionBinding;
  invocationKind: "active" | "preview";
}) {
  const permissions = statePermissions(input.revision);
  return Object.freeze({
    ...input.options,
    outbound: Object.freeze({
      policy: "deny_by_default" as const,
      shiplet: input.binding.shipletId,
      revision: input.binding.revisionId,
      generation: String(input.binding.activationGeneration),
      packageDigest: input.binding.packageDigest,
      invocationId: `invocation_${crypto.randomUUID()}`,
      invocationKind: input.invocationKind,
      stateMode: managedRuntimeStateMode(permissions, input.invocationKind),
      stateNamespace: input.revision.state_scope_namespace ?? "none",
    }),
  });
}

function deploymentIdentity(input: {
  operationId: string;
  namespace: ManagedDeploymentNamespace;
  scriptName: string;
  revision: StageRevisionInput;
}): ManagedDeploymentIdentity {
  return Object.freeze({
    operationId: input.operationId,
    namespace: input.namespace,
    scriptName: input.scriptName,
    shipletId: input.revision.shipletId,
    revisionId: input.revision.revisionId,
    packageDigest: input.revision.packageDigest,
  });
}

function deploymentOptions(
  policy: ManagedPolicy,
  binding: ManagedRevisionBinding,
) {
  return Object.freeze({
    limits: Object.freeze({
      cpuMs: policy.cpuMs,
      subRequests: policy.subRequests,
    }),
    outbound: Object.freeze({
      policy: "deny_by_default" as const,
      shiplet: binding.shipletId,
      revision: binding.revisionId,
      generation: String(binding.activationGeneration),
    }),
  });
}

function runtimeDispatchArgs(binding: ManagedRevisionBinding) {
  return Object.freeze({
    SHIPLET_RUNTIME: Object.freeze({
      shipletId: binding.shipletId,
      revisionId: binding.revisionId,
      packageDigest: binding.packageDigest,
      activationGeneration: binding.activationGeneration,
    }),
  });
}

async function proveRevision(input: {
  dispatcher: DispatchNamespace;
  scriptName: string;
  revision: Pick<
    StageRevisionInput,
    "shipletId" | "revisionId" | "packageDigest"
  >;
  policy: ManagedPolicy;
  activationGeneration: number;
}) {
  const binding: ManagedRevisionBinding = {
    shipletId: input.revision.shipletId,
    revisionId: input.revision.revisionId,
    packageDigest: input.revision.packageDigest,
    activationGeneration: input.activationGeneration,
  };
  const worker = input.dispatcher.get(
    input.scriptName,
    runtimeDispatchArgs(binding),
    deploymentOptions(input.policy, binding),
  );
  const response = await worker.fetch(
    new Request("https://managed-runtime.invalid/__shiplet/health", {
      headers: {
        accept: "application/json",
        "x-shiplet-package-digest": input.revision.packageDigest,
      },
      redirect: "manual",
    }),
  );
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readBounded(response, MAX_HEALTH_BYTES),
      ),
    ) as unknown;
  } catch {
    throw new Error("managed_health_failed");
  }
  if (
    response.status !== 200 ||
    !isRecord(body) ||
    !exactKeys(
      body,
      "activationGeneration,ok,packageDigest,revisionId,shipletId",
    ) ||
    body.ok !== true ||
    body.shipletId !== input.revision.shipletId ||
    body.revisionId !== input.revision.revisionId ||
    body.packageDigest !== input.revision.packageDigest ||
    body.activationGeneration !== input.activationGeneration
  ) {
    throw new Error("managed_health_failed");
  }
}

export class ManagedRuntimeCoordinator {
  readonly #env: ManagedRuntimeCoordinatorEnv;

  constructor(env: ManagedRuntimeCoordinatorEnv) {
    this.#env = env;
  }

  async attestInvocationDependencies(
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(
      this.#env.CF_VERSION_METADATA,
      expectation.gateway,
    );
    const broker = await this.#env.MANAGED_DEPLOYMENT_BROKER.contract();
    const brokerAttestation = verifyInternalSupportEntrypointContract(
      broker,
      INTERNAL_SUPPORT_ENTRYPOINTS[0],
      expectation.deploymentBroker,
    );
    if (!brokerAttestation.ok) {
      throw new Error("managed_runtime_dependency_mismatch");
    }
    normalizePlatformReservationAssertion(
      await this.#env.MANAGED_DEPLOYMENT_BROKER.assertPlatformReservation(
        expectation.deploymentBroker,
      ),
    );
    const denyEgress = await this.#env.DENY_EGRESS_CONTRACT.contract();
    const denyEgressAttestation = verifyInternalSupportEntrypointContract(
      denyEgress,
      INTERNAL_SUPPORT_ENTRYPOINTS[1],
      expectation.denyEgress,
    );
    if (!denyEgressAttestation.ok) {
      throw new Error("managed_runtime_dependency_mismatch");
    }
    return Object.freeze({ ok: true as const });
  }

  async attestDependencies(expectation: ManagedRuntimeReleaseExpectation) {
    await this.attestInvocationDependencies(expectation);
    normalizeDeploymentReadiness(
      await this.#env.MANAGED_DEPLOYMENT_BROKER.readiness(
        expectation.deploymentBroker,
      ),
    );
    return Object.freeze({ ok: true as const });
  }

  async #inspect(
    identity: ManagedDeploymentIdentity,
    expectation: SupportReleaseExpectation,
  ) {
    const input: ManagedDeploymentInspectInput = Object.freeze({
      schemaVersion: "shiplet.managed-deployment-inspect/v1",
      ...identity,
    });
    return normalizeDeploymentProof(
      await this.#env.MANAGED_DEPLOYMENT_BROKER.inspect(input, expectation),
      identity,
    );
  }

  async #ensureUploaded(input: {
    namespace: ManagedDeploymentNamespace;
    scriptName: string;
    revision: StageRevisionInput;
    modules: ManagedDeploymentUploadInput["modules"];
    expectation: SupportReleaseExpectation;
  }) {
    const inspectIdentity = deploymentIdentity({
      operationId: await operationId([
        "inspect",
        input.namespace,
        input.revision.shipletId,
        input.revision.revisionId,
        input.revision.packageDigest,
      ]),
      namespace: input.namespace,
      scriptName: input.scriptName,
      revision: input.revision,
    });
    const before = await this.#inspect(inspectIdentity, input.expectation);
    if (before.status === "present") return;

    const uploadIdentity = deploymentIdentity({
      operationId: await operationId([
        "upload",
        input.namespace,
        input.revision.shipletId,
        input.revision.revisionId,
        input.revision.packageDigest,
      ]),
      namespace: input.namespace,
      scriptName: input.scriptName,
      revision: input.revision,
    });
    const upload: ManagedDeploymentUploadInput = Object.freeze({
      schemaVersion: "shiplet.managed-deployment/v1",
      ...uploadIdentity,
      mainModule: input.revision.mainModule,
      compatibilityDate: COMPATIBILITY_DATE,
      modules: input.modules,
      bindings: NO_AMBIENT_BINDINGS,
    });
    try {
      const proof = normalizeDeploymentProof(
        await this.#env.MANAGED_DEPLOYMENT_BROKER.upload(
          upload,
          input.expectation,
        ),
        uploadIdentity,
      );
      if (proof.status !== "present") {
        throw new Error("managed_deployment_proof_mismatch");
      }
    } catch {
      const recoveryIdentity = deploymentIdentity({
        operationId: await operationId([
          "recover-upload",
          input.namespace,
          input.revision.shipletId,
          input.revision.revisionId,
          input.revision.packageDigest,
        ]),
        namespace: input.namespace,
        scriptName: input.scriptName,
        revision: input.revision,
      });
      const recovered = await this.#inspect(
        recoveryIdentity,
        input.expectation,
      );
      if (recovered.status !== "present") {
        throw new Error("managed_upload_failed");
      }
    }
  }

  async #deleteExact(input: {
    namespace: ManagedDeploymentNamespace;
    scriptName: string;
    revision: StageRevisionInput;
    expectation: SupportReleaseExpectation;
  }) {
    const deleteIdentity = deploymentIdentity({
      operationId: await operationId([
        "delete",
        input.namespace,
        input.revision.shipletId,
        input.revision.revisionId,
        input.revision.packageDigest,
      ]),
      namespace: input.namespace,
      scriptName: input.scriptName,
      revision: input.revision,
    });
    const request: ManagedDeploymentDeleteInput = Object.freeze({
      schemaVersion: "shiplet.managed-deployment-delete/v1",
      ...deleteIdentity,
    });
    try {
      const proof = normalizeDeploymentProof(
        await this.#env.MANAGED_DEPLOYMENT_BROKER.delete(
          request,
          input.expectation,
        ),
        deleteIdentity,
      );
      if (proof.status !== "absent") {
        throw new Error("managed_cleanup_unproven");
      }
      return;
    } catch {
      const recoveryIdentity = deploymentIdentity({
        operationId: await operationId([
          "recover-delete",
          input.namespace,
          input.revision.shipletId,
          input.revision.revisionId,
          input.revision.packageDigest,
        ]),
        namespace: input.namespace,
        scriptName: input.scriptName,
        revision: input.revision,
      });
      const recovered = await this.#inspect(
        recoveryIdentity,
        input.expectation,
      );
      if (recovered.status !== "absent") {
        throw new Error("managed_cleanup_unproven");
      }
    }
  }

  async #readStagedRevision(shipletId: string, revisionId: string) {
    return await this.#env.RUNTIME_DB.prepare(
      `SELECT shiplet_id, revision_id, package_digest, script_name,
              state_namespace, state_scope_namespace, state_permissions_json,
              policy_json, stage_status, stage_operation_id, stage_lease_id,
              stage_lease_expires_on
       FROM managed_revisions
       WHERE shiplet_id = ? AND revision_id = ?`,
    )
      .bind(shipletId, revisionId)
      .first<ManagedRevisionRow>();
  }

  async #renewStageLease(input: {
    shipletId: string;
    revisionId: string;
    packageDigest: string;
    operationId: string;
    leaseId: string;
  }) {
    const renewed = await this.#env.RUNTIME_DB.prepare(
      `UPDATE managed_revisions
       SET stage_lease_expires_on = ?
       WHERE shiplet_id = ? AND revision_id = ? AND package_digest = ?
         AND stage_status = 'staging'
         AND stage_operation_id = ? AND stage_lease_id = ?`,
    )
      .bind(
        new Date(Date.now() + STAGE_LEASE_MS).toISOString(),
        input.shipletId,
        input.revisionId,
        input.packageDigest,
        input.operationId,
        input.leaseId,
      )
      .run();
    return renewed.meta.changes === 1;
  }

  async stageRevision(
    input: StageRevisionInput,
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    const modules = validateStage(input);
    const declaredStatePermissions =
      input.mainModule === "__shiplet_runtime.mjs"
        ? extractManagedRuntimeStatePermissions(input.modules, input.mainModule)
        : Object.freeze([] as ManagedRuntimeStatePermission[]);
    const names = await runtimeNames(input, declaredStatePermissions);
    await this.attestDependencies(expectation);
    const stageOperationId =
      input.operationId ??
      (await operationId([
        "stage",
        input.actorId,
        input.shipletId,
        input.revisionId,
        input.packageDigest,
      ]));
    const stageLeaseId = await operationId([
      "stage-lease",
      stageOperationId,
      crypto.randomUUID(),
    ]);

    const current = await this.#readStagedRevision(
      input.shipletId,
      input.revisionId,
    );
    if (current && !exactRevisionRow(current, input, names)) {
      throw new Error("managed_revision_conflict");
    }
    if (names.stateScopeNamespace) {
      await ensureManagedRuntimeStateNamespace({
        db: this.#env.RUNTIME_DB,
        stateNamespace: names.stateScopeNamespace,
        shipletId: input.shipletId,
      });
    }
    if (current?.stage_status === "validated") {
      return Object.freeze({
        ok: true as const,
        status: "validated" as const,
        scriptName: current.script_name,
      });
    }

    const now = new Date().toISOString();
    const leaseExpiresOn = new Date(Date.now() + STAGE_LEASE_MS).toISOString();
    const inserted = await this.#env.RUNTIME_DB.prepare(
      `INSERT INTO managed_revisions (
        shiplet_id, revision_id, package_digest, script_name,
        state_namespace, state_scope_namespace, state_permissions_json,
        policy_json, stage_status, staged_on, validated_on,
        stage_operation_id, stage_lease_id, stage_lease_expires_on
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?, NULL, ?, ?, ?)
      ON CONFLICT(shiplet_id, revision_id) DO NOTHING`,
    )
      .bind(
        input.shipletId,
        input.revisionId,
        input.packageDigest,
        names.scriptName,
        names.stateNamespace,
        names.stateScopeNamespace,
        names.statePermissionsJson,
        JSON.stringify(input.policy),
        now,
        stageOperationId,
        stageLeaseId,
        leaseExpiresOn,
      )
      .run();
    let ownsLease = inserted.meta.changes === 1;
    if (!ownsLease) {
      const acquired = await this.#env.RUNTIME_DB.prepare(
        `UPDATE managed_revisions
         SET stage_status = 'staging', validated_on = NULL,
             stage_operation_id = ?, stage_lease_id = ?,
             stage_lease_expires_on = ?
         WHERE shiplet_id = ? AND revision_id = ? AND package_digest = ?
           AND stage_status != 'validated'
           AND (
             stage_status = 'failed' OR stage_lease_id IS NULL
             OR stage_lease_expires_on IS NULL OR stage_lease_expires_on <= ?
           )`,
      )
        .bind(
          stageOperationId,
          stageLeaseId,
          leaseExpiresOn,
          input.shipletId,
          input.revisionId,
          input.packageDigest,
          now,
        )
        .run();
      ownsLease = acquired.meta.changes === 1;
    }
    const persisted = await this.#readStagedRevision(
      input.shipletId,
      input.revisionId,
    );
    if (!persisted || !exactRevisionRow(persisted, input, names)) {
      throw new Error("managed_revision_conflict");
    }
    if (persisted.stage_status === "validated") {
      return Object.freeze({
        ok: true as const,
        status: "validated" as const,
        scriptName: persisted.script_name,
      });
    }
    ownsLease = ownsLease || persisted.stage_lease_id === stageLeaseId;
    if (
      !ownsLease ||
      persisted.stage_operation_id !== stageOperationId ||
      persisted.stage_lease_id !== stageLeaseId
    ) {
      throw new Error("managed_revision_stage_in_progress");
    }

    const lease = {
      shipletId: input.shipletId,
      revisionId: input.revisionId,
      packageDigest: input.packageDigest,
      operationId: stageOperationId,
      leaseId: stageLeaseId,
    } as const;
    const renewOrThrow = async () => {
      if (!(await this.#renewStageLease(lease))) {
        throw new Error("managed_revision_stage_lease_lost");
      }
    };

    try {
      await this.#ensureUploaded({
        namespace: STAGING_NAMESPACE,
        scriptName: names.scriptName,
        revision: input,
        modules,
        expectation: expectation.deploymentBroker,
      });
      await renewOrThrow();
      await proveRevision({
        dispatcher: this.#env.STAGING_DISPATCH,
        scriptName: names.scriptName,
        revision: input,
        policy: input.policy,
        activationGeneration: 1,
      });
      await renewOrThrow();
      await this.#ensureUploaded({
        namespace: PRODUCTION_NAMESPACE,
        scriptName: names.scriptName,
        revision: input,
        modules,
        expectation: expectation.deploymentBroker,
      });
      await renewOrThrow();
      await proveRevision({
        dispatcher: this.#env.PRODUCTION_DISPATCH,
        scriptName: names.scriptName,
        revision: input,
        policy: input.policy,
        activationGeneration: 1,
      });
      await renewOrThrow();
      const validated = await this.#env.RUNTIME_DB.prepare(
        `UPDATE managed_revisions
         SET stage_status = 'validated', validated_on = ?,
             stage_lease_id = NULL, stage_lease_expires_on = NULL
         WHERE shiplet_id = ? AND revision_id = ?
           AND package_digest = ? AND stage_status = 'staging'
           AND stage_operation_id = ? AND stage_lease_id = ?`,
      )
        .bind(
          new Date().toISOString(),
          input.shipletId,
          input.revisionId,
          input.packageDigest,
          stageOperationId,
          stageLeaseId,
        )
        .run();
      if (validated.meta.changes !== 1) {
        const raced = await this.#readStagedRevision(
          input.shipletId,
          input.revisionId,
        );
        if (
          !raced ||
          raced.stage_status !== "validated" ||
          !exactRevisionRow(raced, input, names)
        ) {
          throw new Error("managed_revision_conflict");
        }
      }
      return Object.freeze({
        ok: true as const,
        status: "validated" as const,
        scriptName: names.scriptName,
      });
    } catch {
      if (await this.#renewStageLease(lease)) {
        const cleanup = await Promise.allSettled([
          this.#deleteExact({
            namespace: STAGING_NAMESPACE,
            scriptName: names.scriptName,
            revision: input,
            expectation: expectation.deploymentBroker,
          }),
          this.#deleteExact({
            namespace: PRODUCTION_NAMESPACE,
            scriptName: names.scriptName,
            revision: input,
            expectation: expectation.deploymentBroker,
          }),
        ]);
        if (cleanup.some((result) => result.status === "rejected")) {
          throw new Error("managed_cleanup_unproven");
        }
        const failed = await this.#env.RUNTIME_DB.prepare(
          `UPDATE managed_revisions
           SET stage_status = 'failed', stage_lease_id = NULL,
               stage_lease_expires_on = NULL
           WHERE shiplet_id = ? AND revision_id = ? AND package_digest = ?
             AND stage_status = 'staging'
             AND stage_operation_id = ? AND stage_lease_id = ?`,
        )
          .bind(
            input.shipletId,
            input.revisionId,
            input.packageDigest,
            stageOperationId,
            stageLeaseId,
          )
          .run();
        if (failed.meta.changes === 1) {
          throw new Error("managed_revision_stage_failed");
        }
      }
      const raced = await this.#readStagedRevision(
        input.shipletId,
        input.revisionId,
      );
      if (
        raced?.stage_status === "validated" &&
        exactRevisionRow(raced, input, names)
      ) {
        return Object.freeze({
          ok: true as const,
          status: "validated" as const,
          scriptName: names.scriptName,
        });
      }
      if (raced?.stage_status === "staging") {
        throw new Error("managed_revision_stage_in_progress");
      }
      throw new Error("managed_revision_stage_failed");
    }
  }

  async #recoverActivation(input: {
    operationId: string;
    activation: ActivateRevisionInput;
    reason: "promote" | "rollback";
  }) {
    const nextGeneration = input.activation.expectedActivationGeneration + 1;
    const active = await this.#env.RUNTIME_DB.prepare(
      `SELECT shiplet_id, revision_id, package_digest, script_name,
              generation, operation_id
       FROM managed_activations WHERE shiplet_id = ?`,
    )
      .bind(input.activation.shipletId)
      .first<ManagedActivationRow>();
    const history = await this.#env.RUNTIME_DB.prepare(
      `SELECT id, shiplet_id, to_revision_id, to_generation, actor_id, reason
       FROM managed_activation_history WHERE id = ?`,
    )
      .bind(input.operationId)
      .first<ManagedActivationHistoryRow>();
    if (
      active?.shiplet_id === input.activation.shipletId &&
      active.revision_id === input.activation.revisionId &&
      active.package_digest === input.activation.packageDigest &&
      active.generation === nextGeneration &&
      active.operation_id === input.operationId &&
      history?.id === input.operationId &&
      history.shiplet_id === input.activation.shipletId &&
      history.to_revision_id === input.activation.revisionId &&
      history.to_generation === nextGeneration &&
      history.actor_id === input.activation.actorId &&
      history.reason === input.reason
    ) {
      return Object.freeze({
        ok: true as const,
        shipletId: input.activation.shipletId,
        revisionId: input.activation.revisionId,
        packageDigest: input.activation.packageDigest,
        activationGeneration: nextGeneration,
      });
    }
    return null;
  }

  async #activationOperationId(
    input: ActivateRevisionInput,
    reason: "promote" | "rollback",
  ) {
    return operationId([
      reason,
      input.actorId,
      input.shipletId,
      input.revisionId,
      input.packageDigest,
      String(input.expectedActivationGeneration),
    ]);
  }

  async #changeActivation(
    input: ActivateRevisionInput,
    reason: "promote" | "rollback",
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    if (
      !IDENTIFIER.test(input.actorId) ||
      !IDENTIFIER.test(input.shipletId) ||
      !IDENTIFIER.test(input.revisionId) ||
      !PACKAGE_DIGEST.test(input.packageDigest) ||
      !Number.isSafeInteger(input.expectedActivationGeneration) ||
      input.expectedActivationGeneration < 0
    ) {
      throw new TypeError("managed_activation_invalid");
    }
    await this.attestDependencies(expectation);
    const activationOperationId = await this.#activationOperationId(
      input,
      reason,
    );
    const recovered = await this.#recoverActivation({
      operationId: activationOperationId,
      activation: input,
      reason,
    });
    if (recovered) return recovered;

    const revision = await this.#env.RUNTIME_DB.prepare(
      `SELECT shiplet_id, revision_id, package_digest, script_name,
              state_namespace, state_scope_namespace, state_permissions_json,
              policy_json, stage_status
       FROM managed_revisions
       WHERE shiplet_id = ? AND revision_id = ? AND stage_status = 'validated'`,
    )
      .bind(input.shipletId, input.revisionId)
      .first<ManagedRevisionRow>();
    if (
      !revision ||
      revision.shiplet_id !== input.shipletId ||
      revision.revision_id !== input.revisionId ||
      revision.package_digest !== input.packageDigest
    ) {
      throw new Error("managed_revision_not_validated");
    }
    const current = await this.#env.RUNTIME_DB.prepare(
      `SELECT shiplet_id, revision_id, package_digest, script_name,
              generation, operation_id
       FROM managed_activations WHERE shiplet_id = ?`,
    )
      .bind(input.shipletId)
      .first<ManagedActivationRow>();
    const currentGeneration = current?.generation ?? 0;
    if (currentGeneration !== input.expectedActivationGeneration) {
      throw new Error("managed_activation_conflict");
    }
    const nextGeneration = currentGeneration + 1;

    const inspectIdentity = deploymentIdentity({
      operationId: await operationId([
        "activate-inspect",
        PRODUCTION_NAMESPACE,
        input.shipletId,
        input.revisionId,
        input.packageDigest,
        String(nextGeneration),
      ]),
      namespace: PRODUCTION_NAMESPACE,
      scriptName: revision.script_name,
      revision: {
        actorId: input.actorId,
        shipletId: input.shipletId,
        revisionId: input.revisionId,
        packageDigest: input.packageDigest,
        mainModule: "unused.js",
        modules: [],
        policy: parsePolicy(revision.policy_json),
      },
    });
    const deployed = await this.#inspect(
      inspectIdentity,
      expectation.deploymentBroker,
    );
    if (deployed.status !== "present") {
      throw new Error("managed_revision_not_deployed");
    }
    const policy = parsePolicy(revision.policy_json);
    await proveRevision({
      dispatcher: this.#env.PRODUCTION_DISPATCH,
      scriptName: revision.script_name,
      revision: input,
      policy,
      activationGeneration: nextGeneration,
    });

    const now = new Date().toISOString();
    let results: D1Result<unknown>[];
    try {
      results = await this.#env.RUNTIME_DB.batch([
        this.#env.RUNTIME_DB.prepare(
          `INSERT INTO managed_activations (
            shiplet_id, revision_id, package_digest, script_name,
            generation, activated_on, operation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(shiplet_id) DO UPDATE SET
            revision_id = excluded.revision_id,
            package_digest = excluded.package_digest,
            script_name = excluded.script_name,
            generation = excluded.generation,
            activated_on = excluded.activated_on,
            operation_id = excluded.operation_id
          WHERE managed_activations.generation = ?`,
        ).bind(
          input.shipletId,
          input.revisionId,
          input.packageDigest,
          revision.script_name,
          nextGeneration,
          now,
          activationOperationId,
          currentGeneration,
        ),
        this.#env.RUNTIME_DB.prepare(
          `INSERT INTO managed_activation_history (
            id, shiplet_id, from_revision_id, to_revision_id,
            from_generation, to_generation, actor_id, reason, occurred_on
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM managed_activations
              WHERE shiplet_id = ? AND generation = ? AND operation_id = ?
            )
          ON CONFLICT(id) DO NOTHING`,
        ).bind(
          activationOperationId,
          input.shipletId,
          current?.revision_id ?? null,
          input.revisionId,
          currentGeneration === 0 ? null : currentGeneration,
          nextGeneration,
          input.actorId,
          reason,
          now,
          input.shipletId,
          nextGeneration,
          activationOperationId,
        ),
      ]);
    } catch {
      const afterLoss = await this.#recoverActivation({
        operationId: activationOperationId,
        activation: input,
        reason,
      });
      if (afterLoss) return afterLoss;
      throw new Error("managed_activation_response_unknown");
    }
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      const afterConflict = await this.#recoverActivation({
        operationId: activationOperationId,
        activation: input,
        reason,
      });
      if (afterConflict) return afterConflict;
      throw new Error("managed_activation_conflict");
    }
    return Object.freeze({
      ok: true as const,
      shipletId: input.shipletId,
      revisionId: input.revisionId,
      packageDigest: input.packageDigest,
      activationGeneration: nextGeneration,
    });
  }

  promote(
    input: ActivateRevisionInput,
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    return this.#changeActivation(input, "promote", expectation);
  }

  rollback(
    input: ActivateRevisionInput,
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    return this.#changeActivation(input, "rollback", expectation);
  }

  async acknowledgeActivation(
    input: AcknowledgeActivationInput,
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    if (
      (input.reason !== "promote" && input.reason !== "rollback") ||
      !IDENTIFIER.test(input.actorId) ||
      !IDENTIFIER.test(input.shipletId) ||
      !IDENTIFIER.test(input.revisionId) ||
      !PACKAGE_DIGEST.test(input.packageDigest) ||
      !Number.isSafeInteger(input.expectedActivationGeneration) ||
      input.expectedActivationGeneration < 0
    ) {
      throw new TypeError("managed_activation_acknowledgement_invalid");
    }
    await this.attestInvocationDependencies(expectation);
    const activationOperationId = await this.#activationOperationId(
      input,
      input.reason,
    );
    const nextGeneration = input.expectedActivationGeneration + 1;
    const history = await this.#env.RUNTIME_DB.prepare(
      `SELECT history.id, history.shiplet_id, history.to_revision_id,
              history.to_generation, history.actor_id, history.reason
       FROM managed_activation_history history
       JOIN managed_revisions revision
         ON revision.shiplet_id = history.shiplet_id
        AND revision.revision_id = history.to_revision_id
       WHERE history.id = ? AND history.shiplet_id = ?
         AND history.to_revision_id = ? AND history.to_generation = ?
         AND history.actor_id = ? AND history.reason = ?
         AND revision.package_digest = ?`,
    )
      .bind(
        activationOperationId,
        input.shipletId,
        input.revisionId,
        nextGeneration,
        input.actorId,
        input.reason,
        input.packageDigest,
      )
      .first<ManagedActivationHistoryRow>();
    if (!history) {
      throw new Error("managed_activation_acknowledgement_conflict");
    }
    const changed = await this.#env.RUNTIME_DB.prepare(
      `UPDATE managed_activations SET operation_id = NULL
       WHERE shiplet_id = ? AND revision_id = ? AND package_digest = ?
         AND generation = ? AND operation_id = ?`,
    )
      .bind(
        input.shipletId,
        input.revisionId,
        input.packageDigest,
        nextGeneration,
        activationOperationId,
      )
      .run();
    if (changed.meta.changes !== 1) {
      const acknowledged = await this.#env.RUNTIME_DB.prepare(
        `SELECT shiplet_id, revision_id, package_digest, script_name,
                generation, operation_id
         FROM managed_activations WHERE shiplet_id = ?`,
      )
        .bind(input.shipletId)
        .first<ManagedActivationRow>();
      if (
        acknowledged?.revision_id !== input.revisionId ||
        acknowledged.package_digest !== input.packageDigest ||
        acknowledged.generation !== nextGeneration ||
        acknowledged.operation_id !== null
      ) {
        throw new Error("managed_activation_acknowledgement_conflict");
      }
    }
    return Object.freeze({ ok: true as const });
  }

  async invokeValidatedRevision(
    input: { expected: ManagedRevisionBinding; request: Request },
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    if (
      !validRevisionBinding(input.expected) ||
      !(input.request instanceof Request)
    ) {
      throw new TypeError("managed_revision_binding_mismatch");
    }
    await this.attestInvocationDependencies(expectation);
    const revision = await this.#env.RUNTIME_DB.prepare(
      `SELECT shiplet_id, revision_id, package_digest, script_name,
              state_namespace, state_scope_namespace, state_permissions_json,
              policy_json, stage_status
       FROM managed_revisions
       WHERE shiplet_id = ? AND revision_id = ? AND stage_status = 'validated'`,
    )
      .bind(input.expected.shipletId, input.expected.revisionId)
      .first<ManagedRevisionRow>();
    if (
      !revision ||
      revision.shiplet_id !== input.expected.shipletId ||
      revision.revision_id !== input.expected.revisionId ||
      revision.package_digest !== input.expected.packageDigest
    ) {
      throw new Error("managed_revision_unavailable");
    }
    const validatedBinding: ActiveManagedRevision = {
      ...input.expected,
      scriptName: revision.script_name,
    };
    const invocation = await createManagedDispatchInvocation({
      request: input.request,
      expected: input.expected,
      active: validatedBinding,
      limits: parsePolicy(revision.policy_json),
    });
    const worker = this.#env.PRODUCTION_DISPATCH.get(
      invocation.scriptName,
      runtimeDispatchArgs(input.expected),
      invocationOptions({
        options: invocation.options,
        revision,
        binding: input.expected,
        invocationKind: "preview",
      }),
    );
    return worker.fetch(invocation.request);
  }

  async invoke(
    input: { expected: ManagedRevisionBinding; request: Request },
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    if (
      !validRevisionBinding(input.expected) ||
      !(input.request instanceof Request)
    ) {
      throw new TypeError("managed_revision_binding_mismatch");
    }
    await this.attestInvocationDependencies(expectation);
    const active = await this.#env.RUNTIME_DB.prepare(
      `SELECT shiplet_id, revision_id, package_digest, script_name,
              generation, operation_id
       FROM managed_activations WHERE shiplet_id = ?`,
    )
      .bind(input.expected.shipletId)
      .first<ManagedActivationRow>();
    if (!active) throw new Error("managed_revision_unavailable");
    let selected: ActiveManagedRevision | null =
      active.shiplet_id === input.expected.shipletId &&
      active.revision_id === input.expected.revisionId &&
      active.package_digest === input.expected.packageDigest &&
      active.generation === input.expected.activationGeneration
        ? {
            shipletId: active.shiplet_id,
            revisionId: active.revision_id,
            packageDigest: active.package_digest,
            activationGeneration: active.generation,
            scriptName: active.script_name,
          }
        : null;
    if (!selected && active.operation_id) {
      const prior = await this.#env.RUNTIME_DB.prepare(
        `SELECT history.shiplet_id, history.from_revision_id,
                history.from_generation, revision.package_digest,
                revision.script_name
         FROM managed_activation_history history
         JOIN managed_revisions revision
           ON revision.shiplet_id = history.shiplet_id
          AND revision.revision_id = history.from_revision_id
         JOIN managed_revisions candidate
           ON candidate.shiplet_id = history.shiplet_id
          AND candidate.revision_id = history.to_revision_id
         WHERE history.id = ? AND history.shiplet_id = ?
           AND history.from_revision_id = ? AND history.from_generation = ?
           AND history.to_revision_id = ? AND history.to_generation = ?
           AND revision.package_digest = ?
           AND candidate.package_digest = ? AND candidate.script_name = ?
           AND candidate.stage_status = 'validated'`,
      )
        .bind(
          active.operation_id,
          input.expected.shipletId,
          input.expected.revisionId,
          input.expected.activationGeneration,
          active.revision_id,
          active.generation,
          input.expected.packageDigest,
          active.package_digest,
          active.script_name,
        )
        .first<{
          shiplet_id: string;
          from_revision_id: string;
          from_generation: number;
          package_digest: string;
          script_name: string;
        }>();
      if (prior) {
        selected = {
          shipletId: prior.shiplet_id,
          revisionId: prior.from_revision_id,
          packageDigest: prior.package_digest,
          activationGeneration: prior.from_generation,
          scriptName: prior.script_name,
        };
      }
    }
    if (!selected) throw new TypeError("managed_revision_binding_mismatch");
    const revision = await this.#env.RUNTIME_DB.prepare(
      `SELECT shiplet_id, revision_id, package_digest, script_name,
              state_namespace, state_scope_namespace, state_permissions_json,
              policy_json, stage_status
       FROM managed_revisions
       WHERE shiplet_id = ? AND revision_id = ? AND stage_status = 'validated'`,
    )
      .bind(selected.shipletId, selected.revisionId)
      .first<ManagedRevisionRow>();
    if (
      !revision ||
      revision.shiplet_id !== selected.shipletId ||
      revision.revision_id !== selected.revisionId ||
      revision.package_digest !== selected.packageDigest ||
      revision.script_name !== selected.scriptName
    ) {
      throw new Error("managed_revision_unavailable");
    }
    const invocation = await createManagedDispatchInvocation({
      request: input.request,
      expected: input.expected,
      active: selected,
      limits: parsePolicy(revision.policy_json),
    });
    const worker = this.#env.PRODUCTION_DISPATCH.get(
      invocation.scriptName,
      runtimeDispatchArgs(selected),
      invocationOptions({
        options: invocation.options,
        revision,
        binding: selected,
        invocationKind: "active",
      }),
    );
    return worker.fetch(invocation.request);
  }
}
