/**
 * Two-phase customer-Cloudflare deployment adapter for immutable revisions.
 *
 * Preparing may upload an undeployed version, but only activation and restoration
 * are allowed to create provider traffic deployments. Opaque kernel records bind
 * every later action to the exact actor, target generation, revision, package,
 * provider resource, and candidate version that the kernel prepared.
 */

import { CLOUDFLARE_OAUTH_SCOPES } from "./cloudflare-oauth";
import type {
  CloudflareDeploymentProvider,
  CloudflareDeploymentTarget,
  DeploymentActor,
  DeploymentConnectionAuthorizer,
  DeploymentRepository,
  ImmutableRevisionBundle,
  KernelDeploymentResource,
  ProviderAuthorization,
  ShipletDeploymentRecord,
} from "./deployment-orchestrator";
import type {
  PreparedRevisionDeployment,
  RevisionDeploymentCoordinator,
  RevisionDeploymentRequest,
} from "./self-owned/revisions";

type PreparationState =
  | "prepared"
  | "activating"
  | "activated"
  | "restoring"
  | "restored"
  | "abandoning"
  | "abandoned"
  | "reconciliation_required";

export type RevisionDeploymentPreparation = {
  id: string;
  version: number;
  state: PreparationState;
  shipletId: string;
  targetId: string;
  revisionId: string;
  reason: RevisionDeploymentRequest["reason"];
  actorId: string;
  targetGeneration: number;
  targetFingerprint: string;
  connectionId: string;
  providerAccountId: string;
  providerResourceName: string;
  providerVersionId: string;
  packageDigest: string;
  createdAt: number;
  mutationFenceId?: string;
  expectedKnownGoodDeploymentId?: string | null;
  providerDeploymentId?: string;
  restoredPriorDeploymentId?: string;
  restorationProviderDeploymentId?: string;
};

/** Implement this with a durable compare-and-set store in production. */
export interface RevisionDeploymentPreparationStore {
  insert(record: RevisionDeploymentPreparation): Promise<boolean>;
  get(id: string): Promise<RevisionDeploymentPreparation | null>;
  compareAndSet(input: {
    id: string;
    expectedVersion: number;
    next: RevisionDeploymentPreparation;
  }): Promise<boolean>;
}

type RevisionDeploymentPreparationRow = {
  id: string;
  version: number;
  state: PreparationState;
  shiplet_id: string;
  target_id: string;
  revision_id: string;
  reason: RevisionDeploymentRequest["reason"];
  actor_id: string;
  target_generation: number;
  target_fingerprint: string;
  connection_id: string;
  provider_account_id: string;
  provider_resource_name: string;
  provider_version_id: string;
  package_digest: string;
  created_at: number;
  mutation_fence_id: string | null;
  expected_known_good_deployment_id: string | null;
  provider_deployment_id: string | null;
  restored_prior_deployment_id: string | null;
  restoration_provider_deployment_id: string | null;
};

const PREPARATION_STATES: readonly PreparationState[] = Object.freeze([
  "prepared",
  "activating",
  "activated",
  "restoring",
  "restored",
  "abandoning",
  "abandoned",
  "reconciliation_required",
]);

function preparationFromRow(
  row: RevisionDeploymentPreparationRow,
): RevisionDeploymentPreparation {
  return {
    id: row.id,
    version: row.version,
    state: row.state,
    shipletId: row.shiplet_id,
    targetId: row.target_id,
    revisionId: row.revision_id,
    reason: row.reason,
    actorId: row.actor_id,
    targetGeneration: row.target_generation,
    targetFingerprint: row.target_fingerprint,
    connectionId: row.connection_id,
    providerAccountId: row.provider_account_id,
    providerResourceName: row.provider_resource_name,
    providerVersionId: row.provider_version_id,
    packageDigest: row.package_digest,
    createdAt: row.created_at,
    ...(row.mutation_fence_id
      ? { mutationFenceId: row.mutation_fence_id }
      : {}),
    ...(row.mutation_fence_id
      ? {
          expectedKnownGoodDeploymentId: row.expected_known_good_deployment_id,
        }
      : {}),
    ...(row.provider_deployment_id
      ? { providerDeploymentId: row.provider_deployment_id }
      : {}),
    ...(row.restored_prior_deployment_id
      ? { restoredPriorDeploymentId: row.restored_prior_deployment_id }
      : {}),
    ...(row.restoration_provider_deployment_id
      ? {
          restorationProviderDeploymentId:
            row.restoration_provider_deployment_id,
        }
      : {}),
  };
}

function assertPreparationRecord(record: RevisionDeploymentPreparation) {
  if (
    !validIdentifier(record.id) ||
    !Number.isSafeInteger(record.version) ||
    record.version <= 0 ||
    !PREPARATION_STATES.includes(record.state) ||
    !validIdentifier(record.shipletId) ||
    !validIdentifier(record.targetId) ||
    !validIdentifier(record.revisionId) ||
    (record.reason !== "promotion" && record.reason !== "rollback") ||
    !validIdentifier(record.actorId) ||
    !Number.isSafeInteger(record.targetGeneration) ||
    record.targetGeneration < 0 ||
    !DIGEST.test(record.targetFingerprint) ||
    !validIdentifier(record.connectionId) ||
    !validIdentifier(record.providerAccountId) ||
    !validIdentifier(record.providerResourceName) ||
    !validIdentifier(record.providerVersionId) ||
    !DIGEST.test(record.packageDigest) ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0 ||
    (record.mutationFenceId !== undefined &&
      !validIdentifier(record.mutationFenceId)) ||
    (record.expectedKnownGoodDeploymentId !== undefined &&
      record.expectedKnownGoodDeploymentId !== null &&
      !validIdentifier(record.expectedKnownGoodDeploymentId)) ||
    (record.providerDeploymentId !== undefined &&
      !validIdentifier(record.providerDeploymentId)) ||
    (record.restoredPriorDeploymentId !== undefined &&
      !validIdentifier(record.restoredPriorDeploymentId)) ||
    (record.restorationProviderDeploymentId !== undefined &&
      !validIdentifier(record.restorationProviderDeploymentId))
  ) {
    throw new TypeError("invalid revision deployment preparation");
  }
}

function samePreparationAuthority(
  left: RevisionDeploymentPreparation,
  right: RevisionDeploymentPreparation,
) {
  return (
    left.id === right.id &&
    left.shipletId === right.shipletId &&
    left.targetId === right.targetId &&
    left.revisionId === right.revisionId &&
    left.reason === right.reason &&
    left.actorId === right.actorId &&
    left.targetGeneration === right.targetGeneration &&
    left.targetFingerprint === right.targetFingerprint &&
    left.connectionId === right.connectionId &&
    left.providerAccountId === right.providerAccountId &&
    left.providerResourceName === right.providerResourceName &&
    left.providerVersionId === right.providerVersionId &&
    left.packageDigest === right.packageDigest &&
    left.createdAt === right.createdAt
  );
}

async function addColumnIfMissing(
  db: D1Database,
  table: string,
  column: string,
  definition: string,
) {
  const columns = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>();
  if (!columns.results.some((entry) => entry.name === column)) {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`).run();
  }
}

export async function ensureRevisionDeploymentCoordinatorSchema(
  db: D1Database,
) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS revision_deployment_preparations (
			 id TEXT PRIMARY KEY,
			 version INTEGER NOT NULL,
			 state TEXT NOT NULL CHECK (state IN (
			  'prepared','activating','activated','restoring','restored',
			  'abandoning','abandoned','reconciliation_required'
			 )),
			 shiplet_id TEXT NOT NULL,
			 target_id TEXT NOT NULL,
			 revision_id TEXT NOT NULL,
			 reason TEXT NOT NULL CHECK (reason IN ('promotion','rollback')),
			 actor_id TEXT NOT NULL,
			 target_generation INTEGER NOT NULL,
			 target_fingerprint TEXT NOT NULL,
			 connection_id TEXT NOT NULL,
			 provider_account_id TEXT NOT NULL,
			 provider_resource_name TEXT NOT NULL,
			 provider_version_id TEXT NOT NULL,
			 package_digest TEXT NOT NULL,
			 created_at INTEGER NOT NULL,
			 mutation_fence_id TEXT,
			 expected_known_good_deployment_id TEXT,
			 provider_deployment_id TEXT,
			 restored_prior_deployment_id TEXT,
			 restoration_provider_deployment_id TEXT
			)`,
    ),
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS
			 idx_revision_deployment_preparation_active
			 ON revision_deployment_preparations(
			  shiplet_id, target_id, revision_id, reason
			 ) WHERE state != 'abandoned'`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS
			 revision_deployment_preparation_authority_immutable
			 BEFORE UPDATE ON revision_deployment_preparations
			 WHEN NEW.id IS NOT OLD.id
			 OR NEW.shiplet_id IS NOT OLD.shiplet_id
			 OR NEW.target_id IS NOT OLD.target_id
			 OR NEW.revision_id IS NOT OLD.revision_id
			 OR NEW.reason IS NOT OLD.reason
			 OR NEW.actor_id IS NOT OLD.actor_id
			 OR NEW.target_generation IS NOT OLD.target_generation
			 OR NEW.target_fingerprint IS NOT OLD.target_fingerprint
			 OR NEW.connection_id IS NOT OLD.connection_id
			 OR NEW.provider_account_id IS NOT OLD.provider_account_id
			 OR NEW.provider_resource_name IS NOT OLD.provider_resource_name
			 OR NEW.provider_version_id IS NOT OLD.provider_version_id
			 OR NEW.package_digest IS NOT OLD.package_digest
			 OR NEW.created_at IS NOT OLD.created_at
			 BEGIN SELECT RAISE(ABORT, 'Preparation authority tuple is immutable'); END`,
    ),
  ]);
  await addColumnIfMissing(
    db,
    "revision_deployment_preparations",
    "mutation_fence_id",
    "mutation_fence_id TEXT",
  );
  await addColumnIfMissing(
    db,
    "revision_deployment_preparations",
    "expected_known_good_deployment_id",
    "expected_known_good_deployment_id TEXT",
  );
}

export function createD1RevisionDeploymentPreparationStore(input: {
  db: D1Database;
}): RevisionDeploymentPreparationStore {
  return {
    async insert(record) {
      assertPreparationRecord(record);
      const result = await input.db
        .prepare(
          `INSERT OR IGNORE INTO revision_deployment_preparations (
					 id, version, state, shiplet_id, target_id, revision_id, reason,
					 actor_id, target_generation, target_fingerprint, connection_id,
					 provider_account_id, provider_resource_name, provider_version_id,
					 package_digest, created_at, mutation_fence_id,
					 expected_known_good_deployment_id, provider_deployment_id,
					 restored_prior_deployment_id,
					 restoration_provider_deployment_id
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          record.id,
          record.version,
          record.state,
          record.shipletId,
          record.targetId,
          record.revisionId,
          record.reason,
          record.actorId,
          record.targetGeneration,
          record.targetFingerprint,
          record.connectionId,
          record.providerAccountId,
          record.providerResourceName,
          record.providerVersionId,
          record.packageDigest,
          record.createdAt,
          record.mutationFenceId ?? null,
          record.expectedKnownGoodDeploymentId ?? null,
          record.providerDeploymentId ?? null,
          record.restoredPriorDeploymentId ?? null,
          record.restorationProviderDeploymentId ?? null,
        )
        .run();
      return result.meta.changes === 1;
    },

    async get(id) {
      if (!validIdentifier(id)) return null;
      const row = await input.db
        .prepare(
          "SELECT * FROM revision_deployment_preparations WHERE id = ? LIMIT 1",
        )
        .bind(id)
        .first<RevisionDeploymentPreparationRow>();
      return row ? preparationFromRow(row) : null;
    },

    async compareAndSet(update) {
      assertPreparationRecord(update.next);
      if (
        update.id !== update.next.id ||
        !Number.isSafeInteger(update.expectedVersion) ||
        update.expectedVersion <= 0 ||
        update.next.version !== update.expectedVersion + 1
      ) {
        throw new TypeError("invalid preparation compare-and-set");
      }
      const current = await this.get(update.id);
      if (!current || current.version !== update.expectedVersion) return false;
      if (!samePreparationAuthority(current, update.next)) {
        throw new Error("Preparation authority tuple mismatch");
      }
      if (
        current.mutationFenceId !== undefined &&
        (update.next.mutationFenceId !== current.mutationFenceId ||
          update.next.expectedKnownGoodDeploymentId !==
            current.expectedKnownGoodDeploymentId)
      ) {
        throw new Error("Preparation mutation fence tuple mismatch");
      }
      const result = await input.db
        .prepare(
          `UPDATE revision_deployment_preparations SET
						 version = ?, state = ?, provider_deployment_id = ?,
						 mutation_fence_id = ?, expected_known_good_deployment_id = ?,
						 restored_prior_deployment_id = ?,
					 restoration_provider_deployment_id = ?
					 WHERE id = ? AND version = ?`,
        )
        .bind(
          update.next.version,
          update.next.state,
          update.next.providerDeploymentId ?? null,
          update.next.mutationFenceId ?? null,
          update.next.expectedKnownGoodDeploymentId ?? null,
          update.next.restoredPriorDeploymentId ?? null,
          update.next.restorationProviderDeploymentId ?? null,
          update.id,
          update.expectedVersion,
        )
        .run();
      return result.meta.changes === 1;
    },
  };
}

export interface RevisionDeploymentProvider extends CloudflareDeploymentProvider {
  cleanupVersion?(input: Record<string, unknown>): Promise<void>;
}

export type RevisionDeploymentCoordinatorDependencies = {
  repository: DeploymentRepository;
  provider: RevisionDeploymentProvider;
  connectionAuthorizer: DeploymentConnectionAuthorizer;
  preparations: RevisionDeploymentPreparationStore;
  loadRevisionBundle(input: {
    shipletId: string;
    revisionId: string;
  }): Promise<ImmutableRevisionBundle | null>;
  resolveHumanActor(
    request: RevisionDeploymentRequest,
  ): Promise<DeploymentActor | null>;
  loadTargetGeneration(input: {
    shipletId: string;
    targetId: string;
  }): Promise<number | null>;
  limits: { cpuMs: number; subRequests: number };
  now(): number;
  audit(event: Record<string, unknown>): Promise<void>;
};

export type RevisionDeploymentMutationFenceCoordinator =
  RevisionDeploymentCoordinator & {
    assertPreparedRevisionCommitAllowed(input: PreparedInput): Promise<void>;
    commitPreparedRevision(input: PreparedInput): Promise<void>;
  };

export class RevisionDeploymentCoordinatorError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RevisionDeploymentCoordinatorError";
    this.code = code;
  }
}

type ProviderBinding = {
  name: string;
  kind: KernelDeploymentResource["kind"];
  providerResourceId?: string;
  value?: string;
};

type TargetSnapshot = {
  target: CloudflareDeploymentTarget;
  actor: DeploymentActor;
  generation: number;
  bindings: ProviderBinding[];
  fingerprint: string;
};

type PreparedInput = RevisionDeploymentRequest & PreparedRevisionDeployment;
type WorkerDeploymentScope =
  | typeof CLOUDFLARE_OAUTH_SCOPES.workerScriptRead
  | typeof CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_PACKAGE_FILES = 10_000;
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const RESERVED_BINDING_NAMES = new Set([
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_OAUTH_TOKEN",
  "PLATFORM_DB",
  "SHARED_D1",
  "SHARED_R2",
  "SHARED_DO",
]);

function failure(code: string): never {
  throw new RevisionDeploymentCoordinatorError(code);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function assertRequest(request: RevisionDeploymentRequest) {
  if (
    !request ||
    !validIdentifier(request.shipletId) ||
    !validIdentifier(request.targetId) ||
    !validIdentifier(request.revisionId) ||
    (request.reason !== "promotion" && request.reason !== "rollback")
  ) {
    failure("invalid_deployment_request");
  }
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

function validClock(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    failure("kernel_clock_invalid");
  return value;
}

function publicBindings(
  resources: KernelDeploymentResource[],
  target: Pick<CloudflareDeploymentTarget, "id" | "shipletId">,
) {
  const names = new Set<string>();
  const bindings: ProviderBinding[] = [];
  for (const resource of resources) {
    if (
      resource.shipletId !== target.shipletId ||
      resource.targetId !== target.id ||
      !validIdentifier(resource.name) ||
      names.has(resource.name) ||
      RESERVED_BINDING_NAMES.has(resource.name.toUpperCase())
    ) {
      failure("target_resource_scope_mismatch");
    }
    names.add(resource.name);
    if (resource.kind === "plain_text") {
      if (
        resource.visibility !== "public" ||
        typeof resource.value !== "string"
      ) {
        failure("target_resource_scope_mismatch");
      }
      bindings.push({
        name: resource.name,
        kind: resource.kind,
        value: resource.value,
      });
      continue;
    }
    if (
      (resource.kind !== "d1" &&
        resource.kind !== "r2" &&
        resource.kind !== "durable_object") ||
      !validIdentifier(resource.providerResourceId)
    ) {
      failure("target_resource_scope_mismatch");
    }
    bindings.push({
      name: resource.name,
      kind: resource.kind,
      providerResourceId: resource.providerResourceId,
    });
  }
  return bindings;
}

function assertBundle(
  bundle: ImmutableRevisionBundle | null,
  request: RevisionDeploymentRequest,
): asserts bundle is ImmutableRevisionBundle {
  if (
    !bundle ||
    bundle.shipletId !== request.shipletId ||
    bundle.revisionId !== request.revisionId ||
    !DIGEST.test(bundle.packageDigest) ||
    !Array.isArray(bundle.modules) ||
    !Array.isArray(bundle.staticAssets)
  ) {
    failure("revision_not_found");
  }
  const files = [...bundle.modules, ...bundle.staticAssets];
  if (files.length > MAX_PACKAGE_FILES)
    failure("revision_package_limit_exceeded");
  let bytes = 0;
  const names = new Set<string>();
  for (const file of files) {
    const name = "name" in file ? file.name : file.path;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      names.has(name) ||
      typeof file.mediaType !== "string" ||
      typeof file.content !== "string" ||
      (file.encoding !== undefined &&
        file.encoding !== "utf8" &&
        file.encoding !== "base64")
    ) {
      failure("revision_package_invalid");
    }
    names.add(name);
    bytes += new TextEncoder().encode(file.content).byteLength;
    if (bytes > MAX_PACKAGE_BYTES) failure("revision_package_limit_exceeded");
  }
  if (
    bundle.modules.length > 1 &&
    (typeof bundle.mainModule !== "string" ||
      bundle.modules.filter((module) => module.name === bundle.mainModule)
        .length !== 1)
  ) {
    failure("revision_package_invalid");
  }
}

function bundleMainModule(bundle: ImmutableRevisionBundle) {
  if (bundle.modules.length === 0) return "__shiplet_static.mjs";
  const mainModule =
    bundle.mainModule ??
    (bundle.modules.length === 1 ? bundle.modules[0]!.name : null);
  if (
    !mainModule ||
    bundle.modules.filter((module) => module.name === mainModule).length !== 1
  ) {
    failure("revision_package_invalid");
  }
  return mainModule;
}

function authorizationCovers(
  authorization: ProviderAuthorization,
  input: {
    actorId: string;
    target: CloudflareDeploymentTarget;
    operation: string;
    revisionId: string;
    packageDigest: string;
    requestDigest: string;
    requiredScopes: string[];
    now: number;
  },
) {
  const scopes = new Set(
    authorization.scopes.map((scope) => scope.trim().toLowerCase()),
  );
  return (
    validIdentifier(authorization.handle) &&
    authorization.userId === input.actorId &&
    authorization.shipletId === input.target.shipletId &&
    authorization.accountId === input.target.providerAccountId &&
    authorization.operation === input.operation &&
    authorization.targetId === input.target.id &&
    authorization.scriptName === input.target.providerScriptName &&
    authorization.revisionId === input.revisionId &&
    authorization.packageDigest === input.packageDigest &&
    authorization.requestDigest === input.requestDigest &&
    Number.isSafeInteger(authorization.expiresAt) &&
    authorization.expiresAt > input.now &&
    input.requiredScopes.every((scope) => scopes.has(scope))
  );
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

function nextPreparation(
  current: RevisionDeploymentPreparation,
  state: PreparationState,
  extra: Partial<RevisionDeploymentPreparation> = {},
): RevisionDeploymentPreparation {
  return {
    ...structuredClone(current),
    ...structuredClone(extra),
    state,
    version: current.version + 1,
  };
}

export function createRevisionDeploymentCoordinator(
  dependencies: RevisionDeploymentCoordinatorDependencies,
): RevisionDeploymentMutationFenceCoordinator {
  if (
    !Number.isSafeInteger(dependencies.limits.cpuMs) ||
    dependencies.limits.cpuMs <= 0 ||
    !Number.isSafeInteger(dependencies.limits.subRequests) ||
    dependencies.limits.subRequests < 0
  ) {
    throw new TypeError("invalid_revision_deployment_limits");
  }
  const executionLimits = Object.freeze({ ...dependencies.limits });

  const readActor = async (request: RevisionDeploymentRequest) => {
    let actor: DeploymentActor | null;
    try {
      actor = await dependencies.resolveHumanActor(structuredClone(request));
    } catch {
      failure("actor_authority_unavailable");
    }
    if (!actor || actor.kind !== "human" || !validIdentifier(actor.id)) {
      failure("human_actor_required");
    }
    return structuredClone(actor);
  };

  const loadSnapshot = async (
    request: RevisionDeploymentRequest,
  ): Promise<TargetSnapshot> => {
    const actor = await readActor(request);
    let target: CloudflareDeploymentTarget | null;
    try {
      target = await dependencies.repository.getTargetScoped({
        shipletId: request.shipletId,
        targetId: request.targetId,
      });
    } catch {
      failure("target_authority_unavailable");
    }
    if (
      !target ||
      target.shipletId !== request.shipletId ||
      target.id !== request.targetId ||
      target.kind !== "customer_cloudflare" ||
      target.ownerUserId !== actor.id
    ) {
      failure("target_not_found");
    }
    if (target.status === "revoked") failure("connection_revoked");
    if (
      target.status !== "connected" ||
      !validIdentifier(target.connectionId)
    ) {
      failure("oauth_connection_required");
    }
    if (
      !validIdentifier(target.providerAccountId) ||
      !validIdentifier(target.providerScriptName)
    ) {
      failure("target_configuration_invalid");
    }
    if (
      !Array.isArray(target.resourceBindingRefs) ||
      new Set(target.resourceBindingRefs).size !==
        target.resourceBindingRefs.length ||
      target.resourceBindingRefs.some((ref) => !validIdentifier(ref))
    ) {
      failure("target_resource_scope_mismatch");
    }
    let resources: KernelDeploymentResource[] | null;
    try {
      resources = await dependencies.repository.resolveTargetResources({
        shipletId: request.shipletId,
        targetId: request.targetId,
        resourceRefs: [...target.resourceBindingRefs],
      });
    } catch {
      failure("target_authority_unavailable");
    }
    if (!resources) failure("target_resource_scope_mismatch");
    const bindings = publicBindings(resources, target);
    let generation: number | null;
    try {
      generation = await dependencies.loadTargetGeneration({
        shipletId: request.shipletId,
        targetId: request.targetId,
      });
    } catch {
      failure("target_authority_unavailable");
    }
    if (!Number.isSafeInteger(generation) || (generation ?? -1) < 0) {
      failure("target_not_found");
    }
    const fingerprint = await sha256Digest({
      shipletId: target.shipletId,
      targetId: target.id,
      connectionId: target.connectionId,
      providerAccountId: target.providerAccountId,
      providerScriptName: target.providerScriptName,
      resourceBindingRefs: target.resourceBindingRefs,
      bindings,
      generation,
    });
    return {
      target: structuredClone(target),
      actor,
      generation: generation as number,
      bindings,
      fingerprint,
    };
  };

  const authorize = async (
    snapshot: TargetSnapshot,
    revisionId: string,
    packageDigest: string,
    operation: string,
    requiredScopes: WorkerDeploymentScope[],
    providerRequest: Record<string, unknown>,
  ) => {
    const requestDigest = await sha256Digest(providerRequest);
    let authorizationResult: Awaited<
      ReturnType<DeploymentConnectionAuthorizer["authorize"]>
    >;
    try {
      authorizationResult = await dependencies.connectionAuthorizer.authorize({
        connectionId: snapshot.target.connectionId!,
        userId: snapshot.actor.id,
        shipletId: snapshot.target.shipletId,
        accountId: snapshot.target.providerAccountId,
        operation,
        requiredScopes,
        targetId: snapshot.target.id,
        scriptName: snapshot.target.providerScriptName,
        revisionId,
        packageDigest,
        requestDigest,
      });
    } catch {
      failure("provider_authorization_unavailable");
    }
    if (!authorizationResult.ok) {
      failure(
        authorizationResult.reason === "connection_revoked"
          ? "connection_revoked"
          : "provider_authorization_denied",
      );
    }
    if (
      !authorizationCovers(authorizationResult.authorization, {
        actorId: snapshot.actor.id,
        target: snapshot.target,
        operation,
        revisionId,
        packageDigest,
        requestDigest,
        requiredScopes,
        now: validClock(dependencies.now()),
      })
    ) {
      failure("provider_authorization_invalid");
    }
    return structuredClone(authorizationResult.authorization);
  };

  const assertCurrentSnapshot = async (
    request: RevisionDeploymentRequest,
    preparation: RevisionDeploymentPreparation,
  ) => {
    const snapshot = await loadSnapshot(request);
    if (
      snapshot.actor.id !== preparation.actorId ||
      snapshot.generation !== preparation.targetGeneration ||
      snapshot.fingerprint !== preparation.targetFingerprint ||
      snapshot.target.connectionId !== preparation.connectionId ||
      snapshot.target.providerAccountId !== preparation.providerAccountId ||
      snapshot.target.providerScriptName !== preparation.providerResourceName
    ) {
      failure("target_generation_conflict");
    }
    return snapshot;
  };

  const transition = async (
    current: RevisionDeploymentPreparation,
    state: PreparationState,
    extra: Partial<RevisionDeploymentPreparation> = {},
  ) => {
    const next = nextPreparation(current, state, extra);
    let updated: boolean;
    try {
      updated = await dependencies.preparations.compareAndSet({
        id: current.id,
        expectedVersion: current.version,
        next,
      });
    } catch {
      failure("preparation_store_unavailable");
    }
    if (!updated) failure("preparation_conflict");
    return next;
  };

  const abortMutationFence = async (
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
      if (status !== "reconcile_required") {
        failure("deployment_reconciliation_required");
      }
    }
  };

  const recheckMutationFence = async (
    preparation: RevisionDeploymentPreparation,
    allowReconcileRequired = false,
  ) => {
    if (
      !preparation.mutationFenceId ||
      preparation.expectedKnownGoodDeploymentId === undefined ||
      !dependencies.repository.recheckTargetOperation
    ) {
      return false;
    }
    try {
      return await dependencies.repository.recheckTargetOperation({
        journalId: preparation.mutationFenceId,
        shipletId: preparation.shipletId,
        targetId: preparation.targetId,
        expectedKnownGoodDeploymentId:
          preparation.expectedKnownGoodDeploymentId,
        allowReconcileRequired,
      });
    } catch {
      return false;
    }
  };

  const reserveMutationFence = async (
    preparation: RevisionDeploymentPreparation,
  ) => {
    let knownGood: ShipletDeploymentRecord | null;
    try {
      knownGood = await dependencies.repository.getKnownGood(
        preparation.targetId,
      );
    } catch {
      failure("target_mutation_fence_unavailable");
    }
    const expectedKnownGoodDeploymentId = knownGood?.id ?? null;
    let reservation: Awaited<
      ReturnType<DeploymentRepository["reserveTargetOperation"]>
    >;
    try {
      reservation = await dependencies.repository.reserveTargetOperation({
        shipletId: preparation.shipletId,
        targetId: preparation.targetId,
        expectedKnownGoodDeploymentId,
        idempotencyKey: preparation.id,
        operation: "promotion",
        revisionId: preparation.revisionId,
        intentDigest: await sha256Digest({
          operation: "promotion",
          preparationId: preparation.id,
          shipletId: preparation.shipletId,
          targetId: preparation.targetId,
          revisionId: preparation.revisionId,
          providerVersionId: preparation.providerVersionId,
          expectedKnownGoodDeploymentId,
        }),
      });
    } catch {
      failure("target_mutation_fence_unavailable");
    }
    if (!reservation.ok || !validIdentifier(reservation.journal.id)) {
      failure("target_mutation_in_progress");
    }
    if (reservation.replay && reservation.journal.status !== "reserved") {
      failure("target_mutation_in_progress");
    }
    return {
      journalId: reservation.journal.id,
      expectedKnownGoodDeploymentId,
    };
  };

  const readPrepared = async (input: PreparedInput) => {
    assertRequest(input);
    if (
      !validIdentifier(input.deploymentId) ||
      !validIdentifier(input.providerVersionId) ||
      input.status !== "healthy"
    ) {
      failure("preparation_binding_mismatch");
    }
    let record: RevisionDeploymentPreparation | null;
    try {
      record = await dependencies.preparations.get(input.deploymentId);
    } catch {
      failure("preparation_store_unavailable");
    }
    if (
      !record ||
      record.id !== input.deploymentId ||
      record.shipletId !== input.shipletId ||
      record.targetId !== input.targetId ||
      record.revisionId !== input.revisionId ||
      record.reason !== input.reason ||
      record.providerVersionId !== input.providerVersionId ||
      record.providerResourceName !== input.providerResourceName
    ) {
      failure("preparation_binding_mismatch");
    }
    return record;
  };

  const bestEffortCleanup = async (
    snapshot: TargetSnapshot,
    revisionId: string,
    packageDigest: string,
    providerVersionId: string,
  ) => {
    if (!dependencies.provider.cleanupVersion) return;
    const cleanupRequest = {
      actorId: snapshot.actor.id,
      shipletId: snapshot.target.shipletId,
      targetId: snapshot.target.id,
      accountId: snapshot.target.providerAccountId,
      scriptName: snapshot.target.providerScriptName,
      versionId: providerVersionId,
      revisionId,
      packageDigest,
    };
    try {
      const authorization = await authorize(
        snapshot,
        revisionId,
        packageDigest,
        "worker.version.cleanup",
        [CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite],
        cleanupRequest,
      );
      await dependencies.provider.cleanupVersion(
        providerEnvelope(authorization, cleanupRequest),
      );
    } catch {
      // A candidate version is inert. Cleanup is explicitly best-effort.
    }
  };

  const prepareRevision = async (
    request: RevisionDeploymentRequest,
  ): Promise<PreparedRevisionDeployment> => {
    request = structuredClone(request);
    assertRequest(request);
    const snapshot = await loadSnapshot(request);
    let bundle: ImmutableRevisionBundle | null;
    try {
      bundle = await dependencies.loadRevisionBundle({
        shipletId: request.shipletId,
        revisionId: request.revisionId,
      });
    } catch {
      failure("revision_store_unavailable");
    }
    assertBundle(bundle, request);
    if (bundle.modules.length > 0) {
      failure("customer_advanced_runtime_egress_unavailable");
    }
    const inspectRequest = {
      actorId: snapshot.actor.id,
      shipletId: snapshot.target.shipletId,
      targetId: snapshot.target.id,
      accountId: snapshot.target.providerAccountId,
      scriptName: snapshot.target.providerScriptName,
    };
    const inspectAuthorization = await authorize(
      snapshot,
      request.revisionId,
      bundle.packageDigest,
      "worker.inspect",
      [CLOUDFLARE_OAUTH_SCOPES.workerScriptRead],
      inspectRequest,
    );
    let scriptExists: boolean;
    try {
      scriptExists = await dependencies.provider.hasScript(
        providerEnvelope(inspectAuthorization, inspectRequest),
      );
    } catch {
      failure("provider_inspection_failed");
    }
    if (!scriptExists) {
      const initializationRequest = {
        actorId: snapshot.actor.id,
        shipletId: snapshot.target.shipletId,
        targetId: snapshot.target.id,
        accountId: snapshot.target.providerAccountId,
        scriptName: snapshot.target.providerScriptName,
        bootstrap: { kind: "inert_known_good" as const },
        bindings: structuredClone(snapshot.bindings),
      };
      const initializationAuthorization = await authorize(
        snapshot,
        request.revisionId,
        bundle.packageDigest,
        "worker.script.initialize",
        [CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite],
        initializationRequest,
      );
      try {
        const initialized = await dependencies.provider.initializeScript(
          providerEnvelope(initializationAuthorization, initializationRequest),
        );
        if (!validIdentifier(initialized.versionId)) {
          failure("provider_initialization_failed");
        }
      } catch (error) {
        if (error instanceof RevisionDeploymentCoordinatorError) throw error;
        failure("provider_initialization_failed");
      }
    }
    await assertCurrentSnapshot(request, {
      id: "preparation_revalidation",
      version: 0,
      state: "prepared",
      shipletId: request.shipletId,
      targetId: request.targetId,
      revisionId: request.revisionId,
      reason: request.reason,
      actorId: snapshot.actor.id,
      targetGeneration: snapshot.generation,
      targetFingerprint: snapshot.fingerprint,
      connectionId: snapshot.target.connectionId!,
      providerAccountId: snapshot.target.providerAccountId,
      providerResourceName: snapshot.target.providerScriptName,
      providerVersionId: "unassigned",
      packageDigest: bundle.packageDigest,
      createdAt: validClock(dependencies.now()),
    });
    const uploadRequest = {
      actorId: snapshot.actor.id,
      shipletId: snapshot.target.shipletId,
      targetId: snapshot.target.id,
      accountId: snapshot.target.providerAccountId,
      scriptName: snapshot.target.providerScriptName,
      revisionId: bundle.revisionId,
      packageDigest: bundle.packageDigest,
      modules: structuredClone(bundle.modules),
      staticAssets: structuredClone(bundle.staticAssets).map((asset) => ({
        ...asset,
        path: asset.path.startsWith("/") ? asset.path : `/${asset.path}`,
      })),
      bindings: structuredClone(snapshot.bindings),
      limits: structuredClone(executionLimits),
      mainModule: bundleMainModule(bundle),
      egress: { status: "customer_controlled_unrestricted" as const },
    };
    const uploadAuthorization = await authorize(
      snapshot,
      request.revisionId,
      bundle.packageDigest,
      "worker.version.upload",
      [CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite],
      uploadRequest,
    );
    let uploaded: { versionId: string };
    try {
      uploaded = await dependencies.provider.uploadVersion(
        providerEnvelope(uploadAuthorization, uploadRequest),
      );
    } catch {
      failure("provider_upload_failed");
    }
    if (!validIdentifier(uploaded.versionId)) failure("provider_upload_failed");
    try {
      await assertCurrentSnapshot(request, {
        id: "preparation_revalidation",
        version: 0,
        state: "prepared",
        shipletId: request.shipletId,
        targetId: request.targetId,
        revisionId: request.revisionId,
        reason: request.reason,
        actorId: snapshot.actor.id,
        targetGeneration: snapshot.generation,
        targetFingerprint: snapshot.fingerprint,
        connectionId: snapshot.target.connectionId!,
        providerAccountId: snapshot.target.providerAccountId,
        providerResourceName: snapshot.target.providerScriptName,
        providerVersionId: uploaded.versionId,
        packageDigest: bundle.packageDigest,
        createdAt: validClock(dependencies.now()),
      });
    } catch (error) {
      await bestEffortCleanup(
        snapshot,
        request.revisionId,
        bundle.packageDigest,
        uploaded.versionId,
      );
      throw error;
    }
    const proofRequest = {
      actorId: snapshot.actor.id,
      shipletId: snapshot.target.shipletId,
      targetId: snapshot.target.id,
      accountId: snapshot.target.providerAccountId,
      scriptName: snapshot.target.providerScriptName,
      versionId: uploaded.versionId,
      revisionId: bundle.revisionId,
      packageDigest: bundle.packageDigest,
      healthCheck: {
        path: "/__shiplet/health" as const,
        expectedStatus: 200 as const,
      },
    };
    const proofAuthorization = await authorize(
      snapshot,
      request.revisionId,
      bundle.packageDigest,
      "worker.candidate.prove",
      [CLOUDFLARE_OAUTH_SCOPES.workerScriptRead],
      proofRequest,
    );
    let proof: {
      healthy: boolean;
      observedVersionId: string;
      observedPackageDigest?: string;
    };
    try {
      proof = await dependencies.provider.proveCandidate(
        providerEnvelope(proofAuthorization, proofRequest),
      );
    } catch {
      await bestEffortCleanup(
        snapshot,
        request.revisionId,
        bundle.packageDigest,
        uploaded.versionId,
      );
      failure("candidate_proof_failed");
    }
    if (
      !proof.healthy ||
      proof.observedVersionId !== uploaded.versionId ||
      proof.observedPackageDigest !== bundle.packageDigest
    ) {
      await bestEffortCleanup(
        snapshot,
        request.revisionId,
        bundle.packageDigest,
        uploaded.versionId,
      );
      failure("candidate_proof_mismatch");
    }
    const preparation: RevisionDeploymentPreparation = {
      id: `deployment_${crypto.randomUUID()}`,
      version: 1,
      state: "prepared",
      shipletId: request.shipletId,
      targetId: request.targetId,
      revisionId: request.revisionId,
      reason: request.reason,
      actorId: snapshot.actor.id,
      targetGeneration: snapshot.generation,
      targetFingerprint: snapshot.fingerprint,
      connectionId: snapshot.target.connectionId!,
      providerAccountId: snapshot.target.providerAccountId,
      providerResourceName: snapshot.target.providerScriptName,
      providerVersionId: uploaded.versionId,
      packageDigest: bundle.packageDigest,
      createdAt: validClock(dependencies.now()),
    };
    let inserted: boolean;
    try {
      inserted = await dependencies.preparations.insert(preparation);
    } catch {
      await bestEffortCleanup(
        snapshot,
        request.revisionId,
        bundle.packageDigest,
        uploaded.versionId,
      );
      failure("preparation_store_unavailable");
    }
    if (!inserted) {
      await bestEffortCleanup(
        snapshot,
        request.revisionId,
        bundle.packageDigest,
        uploaded.versionId,
      );
      failure("preparation_conflict");
    }
    try {
      await dependencies.audit({
        eventKind: "cloudflare.revision_candidate.prepared",
        shipletId: request.shipletId,
        targetId: request.targetId,
        revisionId: request.revisionId,
        deploymentId: preparation.id,
        providerVersionId: preparation.providerVersionId,
        actorKind: "human",
        actorId: snapshot.actor.id,
        outcome: "success",
        occurredAt: validClock(dependencies.now()),
      });
    } catch {
      try {
        await transition(preparation, "abandoned");
      } catch {
        // The durable record remains non-active and can be reconciled.
      }
      await bestEffortCleanup(
        snapshot,
        request.revisionId,
        bundle.packageDigest,
        uploaded.versionId,
      );
      failure("audit_unavailable");
    }
    return Object.freeze({
      deploymentId: preparation.id,
      providerVersionId: preparation.providerVersionId,
      providerResourceName: preparation.providerResourceName,
      status: "healthy" as const,
    });
  };

  const activatePreparedRevision = async (input: PreparedInput) => {
    input = structuredClone(input);
    let preparation = await readPrepared(input);
    if (preparation.state === "activated") return;
    if (
      preparation.state === "activating" ||
      preparation.state === "reconciliation_required"
    ) {
      failure("provider_activation_ambiguous");
    }
    if (preparation.state !== "prepared") failure("preparation_not_active");
    const snapshot = await assertCurrentSnapshot(input, preparation);
    const activationRequest = {
      actorId: snapshot.actor.id,
      shipletId: snapshot.target.shipletId,
      targetId: snapshot.target.id,
      accountId: preparation.providerAccountId,
      scriptName: preparation.providerResourceName,
      versionId: preparation.providerVersionId,
      percentage: 100 as const,
      revisionId: preparation.revisionId,
      packageDigest: preparation.packageDigest,
    };
    let authorization: ProviderAuthorization;
    authorization = await authorize(
      snapshot,
      preparation.revisionId,
      preparation.packageDigest,
      "worker.deployment.promote",
      [CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite],
      activationRequest,
    );
    const fence = await reserveMutationFence(preparation);
    preparation = await transition(preparation, "activating", {
      mutationFenceId: fence.journalId,
      expectedKnownGoodDeploymentId: fence.expectedKnownGoodDeploymentId,
    });
    try {
      await assertCurrentSnapshot(input, preparation);
    } catch (error) {
      await abortMutationFence(
        fence.journalId,
        "aborted",
        "target_generation_conflict",
      );
      try {
        await transition(preparation, "abandoned");
      } catch {
        failure("deployment_reconciliation_required");
      }
      throw error;
    }
    if (!(await recheckMutationFence(preparation))) {
      await abortMutationFence(
        fence.journalId,
        "reconcile_required",
        "target_mutation_fence_conflict",
      );
      try {
        await transition(preparation, "reconciliation_required");
      } catch {
        // Both durable paths remain fenced for reconciliation.
      }
      failure("deployment_reconciliation_required");
    }
    let providerDeployment: { deploymentId: string };
    try {
      providerDeployment = await dependencies.provider.createDeployment(
        providerEnvelope(authorization, activationRequest),
      );
    } catch {
      await abortMutationFence(
        fence.journalId,
        "reconcile_required",
        "provider_activation_outcome_ambiguous",
      );
      try {
        await transition(preparation, "reconciliation_required");
      } catch {
        // Both paths require reconciliation; never retry the provider call.
      }
      failure("provider_activation_ambiguous");
    }
    if (!validIdentifier(providerDeployment.deploymentId)) {
      await abortMutationFence(
        fence.journalId,
        "reconcile_required",
        "provider_activation_outcome_ambiguous",
      );
      try {
        await transition(preparation, "reconciliation_required");
      } catch {
        // Both paths require reconciliation; never retry the provider call.
      }
      failure("provider_activation_ambiguous");
    }
    try {
      preparation = await transition(preparation, "activated", {
        providerDeploymentId: providerDeployment.deploymentId,
      });
    } catch {
      await abortMutationFence(
        fence.journalId,
        "reconcile_required",
        "preparation_commit_failed",
      );
      failure("deployment_reconciliation_required");
    }
    try {
      await dependencies.audit({
        eventKind: "cloudflare.revision_candidate.activated",
        shipletId: preparation.shipletId,
        targetId: preparation.targetId,
        revisionId: preparation.revisionId,
        deploymentId: preparation.id,
        providerVersionId: preparation.providerVersionId,
        actorKind: "human",
        actorId: preparation.actorId,
        outcome: "success",
        occurredAt: validClock(dependencies.now()),
      });
    } catch {
      await abortMutationFence(
        fence.journalId,
        "reconcile_required",
        "activation_audit_failed",
      );
      try {
        await transition(preparation, "reconciliation_required");
      } catch {
        // Provider traffic already moved; reconciliation is mandatory either way.
      }
      failure("deployment_reconciliation_required");
    }
  };

  const restorePriorRevision = async (
    input: PreparedInput & {
      previousDeployment: {
        deploymentId: string;
        providerVersionId: string;
        providerResourceName: string;
      };
    },
  ) => {
    input = structuredClone(input);
    let preparation = await readPrepared(input);
    if (
      preparation.state === "restored" &&
      preparation.restoredPriorDeploymentId ===
        input.previousDeployment.deploymentId
    ) {
      return;
    }
    if (
      preparation.state === "restoring" ||
      preparation.state === "abandoning"
    ) {
      failure("restoration_reconciliation_required");
    }
    if (preparation.state === "abandoned") failure("preparation_not_active");
    const snapshot = await assertCurrentSnapshot(input, preparation);
    let prior;
    try {
      prior = await dependencies.repository.getDeploymentScoped({
        shipletId: preparation.shipletId,
        targetId: preparation.targetId,
        deploymentId: input.previousDeployment.deploymentId,
      });
    } catch {
      failure("prior_deployment_authority_unavailable");
    }
    if (!prior || prior.status !== "known_good") {
      failure("prior_deployment_not_found");
    }
    if (
      prior.targetId !== preparation.targetId ||
      prior.providerVersionId !== input.previousDeployment.providerVersionId ||
      input.previousDeployment.providerResourceName !==
        preparation.providerResourceName ||
      input.previousDeployment.providerResourceName !==
        snapshot.target.providerScriptName
    ) {
      failure("prior_deployment_binding_mismatch");
    }
    const priorPackageDigest =
      await dependencies.repository.resolveRevisionPackageDigest?.({
        shipletId: preparation.shipletId,
        revisionId: prior.revisionId,
      });
    if (!priorPackageDigest) failure("prior_deployment_authority_unavailable");
    const priorState = preparation.state;
    preparation = await transition(preparation, "restoring");
    const restorationRequest = {
      actorId: snapshot.actor.id,
      shipletId: snapshot.target.shipletId,
      targetId: snapshot.target.id,
      accountId: preparation.providerAccountId,
      scriptName: preparation.providerResourceName,
      versionId: prior.providerVersionId,
      percentage: 100 as const,
      revisionId: prior.revisionId,
      packageDigest: priorPackageDigest,
    };
    let authorization: ProviderAuthorization;
    try {
      authorization = await authorize(
        snapshot,
        prior.revisionId,
        priorPackageDigest,
        "worker.deployment.rollback",
        [CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite],
        restorationRequest,
      );
    } catch (error) {
      try {
        await transition(preparation, priorState);
      } catch {
        failure("restoration_reconciliation_required");
      }
      throw error;
    }
    try {
      await assertCurrentSnapshot(input, preparation);
    } catch (error) {
      if (preparation.mutationFenceId) {
        await abortMutationFence(
          preparation.mutationFenceId,
          "aborted",
          "target_generation_conflict",
        );
      }
      try {
        await transition(preparation, "abandoned");
      } catch {
        failure("restoration_reconciliation_required");
      }
      throw error;
    }
    if (preparation.mutationFenceId) {
      await abortMutationFence(
        preparation.mutationFenceId,
        "reconcile_required",
        "provider_restoration_started",
      );
    }
    if (!(await recheckMutationFence(preparation, true))) {
      try {
        await transition(preparation, "reconciliation_required");
      } catch {
        // Both paths require explicit reconciliation.
      }
      failure("restoration_reconciliation_required");
    }
    let restored: { deploymentId: string };
    try {
      restored = await dependencies.provider.createDeployment(
        providerEnvelope(authorization, restorationRequest),
      );
    } catch {
      if (preparation.mutationFenceId) {
        await abortMutationFence(
          preparation.mutationFenceId,
          "reconcile_required",
          "provider_restoration_outcome_ambiguous",
        );
      }
      try {
        await transition(preparation, "reconciliation_required");
      } catch {
        // Provider outcome is ambiguous; reconciliation owns the target.
      }
      failure("restoration_reconciliation_required");
    }
    if (!validIdentifier(restored.deploymentId)) {
      if (preparation.mutationFenceId) {
        await abortMutationFence(
          preparation.mutationFenceId,
          "reconcile_required",
          "provider_restoration_outcome_ambiguous",
        );
      }
      try {
        await transition(preparation, "reconciliation_required");
      } catch {
        // Provider outcome is ambiguous; reconciliation owns the target.
      }
      failure("restoration_reconciliation_required");
    }
    try {
      preparation = await transition(preparation, "restored", {
        restoredPriorDeploymentId: prior.id,
        restorationProviderDeploymentId: restored.deploymentId,
      });
    } catch {
      if (preparation.mutationFenceId) {
        await abortMutationFence(
          preparation.mutationFenceId,
          "reconcile_required",
          "restoration_preparation_commit_failed",
        );
      }
      failure("restoration_reconciliation_required");
    }
    try {
      await dependencies.audit({
        eventKind: "cloudflare.revision_candidate.restored",
        shipletId: preparation.shipletId,
        targetId: preparation.targetId,
        revisionId: prior.revisionId,
        deploymentId: preparation.id,
        providerVersionId: prior.providerVersionId,
        actorKind: "human",
        actorId: preparation.actorId,
        outcome: "success",
        occurredAt: validClock(dependencies.now()),
      });
    } catch {
      if (preparation.mutationFenceId) {
        await abortMutationFence(
          preparation.mutationFenceId,
          "reconcile_required",
          "restoration_audit_failed",
        );
      }
      try {
        await transition(preparation, "reconciliation_required");
      } catch {
        // Prior traffic is restored, but audit reconciliation is still required.
      }
      failure("restoration_reconciliation_required");
    }
    if (!preparation.mutationFenceId) {
      failure("restoration_reconciliation_required");
    }
    try {
      await dependencies.repository.markTargetOperationCompensated({
        journalId: preparation.mutationFenceId,
      });
    } catch {
      await abortMutationFence(
        preparation.mutationFenceId,
        "reconcile_required",
        "restoration_fence_commit_failed",
      );
      failure("restoration_reconciliation_required");
    }
  };

  const abandonPreparedRevision = async (input: PreparedInput) => {
    input = structuredClone(input);
    let preparation = await readPrepared(input);
    if (preparation.state === "abandoned") return;
    if (preparation.state !== "prepared" && preparation.state !== "restored") {
      failure(
        preparation.state === "reconciliation_required" ||
          preparation.state === "activating" ||
          preparation.state === "restoring"
          ? "deployment_reconciliation_required"
          : "preparation_not_abandonable",
      );
    }
    const priorState = preparation.state;
    preparation = await transition(preparation, "abandoning");
    let snapshot: TargetSnapshot | null = null;
    try {
      snapshot = await assertCurrentSnapshot(input, preparation);
    } catch {
      // A detached/revoked target cannot authorize cleanup; no candidate traffic
      // was active in either permitted source state.
    }
    if (snapshot) {
      await bestEffortCleanup(
        snapshot,
        preparation.revisionId,
        preparation.packageDigest,
        preparation.providerVersionId,
      );
    }
    try {
      await dependencies.audit({
        eventKind: "cloudflare.revision_candidate.abandoned",
        shipletId: preparation.shipletId,
        targetId: preparation.targetId,
        revisionId: preparation.revisionId,
        deploymentId: preparation.id,
        providerVersionId: preparation.providerVersionId,
        actorKind: "human",
        actorId: preparation.actorId,
        outcome: "success",
        occurredAt: validClock(dependencies.now()),
      });
    } catch {
      try {
        await transition(preparation, priorState);
      } catch {
        failure("deployment_reconciliation_required");
      }
      failure("audit_unavailable");
    }
    await transition(preparation, "abandoned");
  };

  const assertPreparedRevisionCommitAllowed = async (input: PreparedInput) => {
    input = structuredClone(input);
    const preparation = await readPrepared(input);
    if (preparation.state !== "activated") {
      failure("deployment_reconciliation_required");
    }
    await assertCurrentSnapshot(input, preparation);
    if (!(await recheckMutationFence(preparation))) {
      if (preparation.mutationFenceId) {
        await abortMutationFence(
          preparation.mutationFenceId,
          "reconcile_required",
          "local_commit_fence_conflict",
        );
      }
      failure("deployment_reconciliation_required");
    }
  };

  const commitPreparedRevision = async (input: PreparedInput) => {
    input = structuredClone(input);
    const preparation = await readPrepared(input);
    if (
      preparation.state !== "activated" ||
      !preparation.mutationFenceId ||
      !dependencies.repository.completeTargetOperation
    ) {
      failure("deployment_reconciliation_required");
    }
    let committed: boolean;
    try {
      committed = await dependencies.repository.completeTargetOperation({
        journalId: preparation.mutationFenceId,
        resultDeploymentId: preparation.id,
        status: "finalized",
      });
    } catch {
      committed = false;
    }
    if (!committed) failure("deployment_reconciliation_required");
  };

  return Object.freeze({
    prepareRevision,
    activatePreparedRevision,
    restorePriorRevision,
    abandonPreparedRevision,
    assertPreparedRevisionCommitAllowed,
    commitPreparedRevision,
  });
}
