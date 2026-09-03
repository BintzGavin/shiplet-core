import {
  assertShipletPackageAuthoritySafe,
  declaredValidationChecks,
  digestShipletPackage,
  digestShipletPackageContent,
  packageFileContentBase64,
  packageFileContentBytes,
  parseShipletPackage,
  serializeShipletPackage,
  shipletPackageProvenanceParentRevisionId,
  ShipletPackageError,
  withShipletPackageProvenanceParent,
  type ValidatedShipletPackage,
} from "./package";

export type ShipletActor = {
  kind: "human" | "agent" | "shiplet" | "system";
  id: string;
};

export type RevisionDeploymentRequest = {
  shipletId: string;
  revisionId: string;
  targetId: string;
  reason: "promotion" | "rollback";
};

export type PreparedRevisionDeployment = {
  deploymentId: string;
  providerVersionId: string;
  providerResourceName?: string;
  status: "healthy";
};

export type RevisionDeploymentCoordinator = {
  prepareRevision(
    request: RevisionDeploymentRequest,
  ): Promise<PreparedRevisionDeployment>;
  activatePreparedRevision?(
    request: RevisionDeploymentRequest & PreparedRevisionDeployment,
  ): Promise<void>;
  assertPreparedRevisionCommitAllowed?(
    request: RevisionDeploymentRequest & PreparedRevisionDeployment,
  ): Promise<void>;
  commitPreparedRevision?(
    request: RevisionDeploymentRequest & PreparedRevisionDeployment,
  ): Promise<void>;
  restorePriorRevision?(
    request: RevisionDeploymentRequest &
      PreparedRevisionDeployment & {
        previousDeployment: {
          deploymentId: string;
          providerVersionId: string;
          providerResourceName: string;
        };
      },
  ): Promise<void>;
  abandonPreparedRevision?(
    request: RevisionDeploymentRequest & PreparedRevisionDeployment,
  ): Promise<void>;
};

export type RevisionValidationError = {
  code: string;
  path?: string;
  checkId?: string;
};

export type RevisionValidationRunner = {
  validate(input: {
    shipletId: string;
    draftId: string;
    draftVersion: number;
    package: ValidatedShipletPackage;
    signal: AbortSignal;
  }): Promise<{ ok: boolean; errors: RevisionValidationError[] }>;
};

export type RevisionMcpManifestValidator = {
  validate(input: {
    shipletId: string;
    revisionId: string;
    package: ValidatedShipletPackage;
    signal: AbortSignal;
  }): Promise<{ ok: boolean; errors: RevisionValidationError[] }>;
};

export type RevisionKernelAction =
  | "revision.create_initial"
  | "revision.read"
  | "draft.read"
  | "package.export"
  | "revision.fork"
  | "revision.update_draft"
  | "revision.validate_draft"
  | "revision.promote"
  | "revision.rollback"
  | "revision.recover_operation";

export type RevisionKernelAuthorizationBinding = {
  shipletId: string;
  actor: ShipletActor;
  action: RevisionKernelAction;
};

export type RevisionKernelAuthorizer = {
  authorize(input: RevisionKernelAuthorizationBinding): Promise<{
    authorizationId: string;
    binding: RevisionKernelAuthorizationBinding;
  }>;
};

export type RevisionServiceOptions = {
  db: D1Database;
  deploymentCoordinator?: RevisionDeploymentCoordinator;
  validationRunner?: RevisionValidationRunner;
  mcpManifestValidator?: RevisionMcpManifestValidator;
  validationTimeoutMs?: number;
  kernelAuthorizer?: RevisionKernelAuthorizer;
  packageStore?: RevisionPackageStore;
};

export type RevisionPackageStore = {
  putText(key: string, value: string): Promise<void>;
  getText(key: string): Promise<string | null>;
  putBytes(key: string, value: Uint8Array): Promise<void>;
};

type StoredRevisionFile = {
  objectKey: string | null;
  contentBase64: string | null;
};

type DraftRow = {
  id: string;
  project_id: string;
  base_revision_id: string;
  package_json: string;
  package_digest: string | null;
  version: number;
  validation_state: string;
  validation_report_json: string | null;
  validated_revision_id: string | null;
  created_by_actor_kind: ShipletActor["kind"];
  created_by_actor_id: string;
  created_on: string;
  updated_on: string;
};

type RevisionRow = {
  id: string;
  project_id: string;
  parent_revision_id: string | null;
  package_json: string;
  package_digest: string;
  content_digest: string | null;
  runtime_compatibility: string;
  validation_report_json: string;
  custom_mcp_projection_json: string | null;
  created_by_actor_kind: ShipletActor["kind"];
  created_by_actor_id: string;
  created_on: string;
};

type ProjectActiveRow = {
  id: string;
  active_revision_id: string | null;
  active_revision_generation: number;
  deployment_target_generation: number;
  revision_operation_id: string | null;
};

type DeploymentTargetRow = {
  id: string;
  project_id: string;
};

type DeploymentRow = {
  id: string;
  revision_id: string;
  provider_version_id: string;
  provider_resource_name: string;
};

export type ShipletDraft = {
  id: string;
  shipletId: string;
  baseRevisionId: string;
  version: number;
  validationState: string;
  validatedRevisionId: string | null;
};

export type ShipletRevision = {
  id: string;
  shipletId: string;
  parentRevisionId: string | null;
  digest: string;
  contentDigest: string;
  package: ValidatedShipletPackage;
  createdOn: string;
};

type RevisionOperationStatus =
  | "prepared"
  | "activating"
  | "committing"
  | "committed"
  | "reconciliation_required"
  | "restoring"
  | "compensated";

type RevisionOperationRow = {
  id: string;
  project_id: string;
  kind: "promotion" | "rollback";
  candidate_revision_id: string;
  prior_revision_id: string;
  status: RevisionOperationStatus;
  target_generation: number;
  target_ids_json: string;
  deployment_ids_json: string;
  prepared_json: string;
  reconciliation_json: string;
  lease_expires_on: string | null;
  idempotency_key: string;
  last_error_code: string | null;
  created_on: string;
  updated_on: string;
};

export type DraftValidationResult = {
  ok: boolean;
  draftVersion: number;
  revisionId: string;
  errors: RevisionValidationError[];
};

export class RevisionLifecycleError extends Error {
  readonly code: string;
  readonly [key: string]: unknown;

  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.name = "RevisionLifecycleError";
    this.code = code;
    Object.assign(this, details);
  }
}

function lifecycleFailure(
  code: string,
  details: Record<string, unknown> = {},
): never {
  throw new RevisionLifecycleError(code, details);
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function assertActor(actor: ShipletActor) {
  if (
    !actor ||
    !(["human", "agent", "shiplet", "system"] as string[]).includes(
      actor.kind,
    ) ||
    typeof actor.id !== "string" ||
    actor.id.length === 0
  ) {
    lifecycleFailure("invalid_actor");
  }
}

async function authorizeRevisionAction(
  authorizer: RevisionKernelAuthorizer | undefined,
  input: RevisionKernelAuthorizationBinding,
) {
  if (!authorizer) lifecycleFailure("kernel_authorizer_required");
  let authorization: Awaited<ReturnType<RevisionKernelAuthorizer["authorize"]>>;
  try {
    authorization = await authorizer.authorize({
      shipletId: input.shipletId,
      actor: { ...input.actor },
      action: input.action,
    });
  } catch {
    lifecycleFailure("authorization_denied");
  }
  if (
    !authorization ||
    typeof authorization.authorizationId !== "string" ||
    authorization.authorizationId.length === 0 ||
    !authorization.binding ||
    authorization.binding.shipletId !== input.shipletId ||
    authorization.binding.action !== input.action ||
    authorization.binding.actor?.kind !== input.actor.kind ||
    authorization.binding.actor.id !== input.actor.id
  ) {
    lifecycleFailure("authorization_binding_mismatch");
  }
  return authorization.authorizationId;
}

async function addColumnIfMissing(
  db: D1Database,
  table: string,
  column: string,
  ddl: string,
) {
  const columns = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>();
  if (!columns.results.some((candidate) => candidate.name === column)) {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
  }
}

export async function ensureRevisionSchema(db: D1Database) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_revisions (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				parent_revision_id TEXT,
				package_json TEXT NOT NULL,
				package_digest TEXT NOT NULL,
				content_digest TEXT,
				runtime_compatibility TEXT NOT NULL,
				validation_report_json TEXT NOT NULL,
				custom_mcp_projection_json TEXT,
				created_by_actor_kind TEXT NOT NULL,
				created_by_actor_id TEXT NOT NULL,
				created_on TEXT NOT NULL,
				UNIQUE (project_id, parent_revision_id, package_digest),
				FOREIGN KEY (project_id) REFERENCES projects(id),
				FOREIGN KEY (parent_revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_drafts (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				base_revision_id TEXT NOT NULL,
				package_json TEXT NOT NULL,
				package_digest TEXT,
				version INTEGER NOT NULL,
				validation_state TEXT NOT NULL,
				validation_report_json TEXT,
				validated_revision_id TEXT,
				created_by_actor_kind TEXT NOT NULL,
				created_by_actor_id TEXT NOT NULL,
				created_on TEXT NOT NULL,
				updated_on TEXT NOT NULL,
				FOREIGN KEY (project_id) REFERENCES projects(id),
				FOREIGN KEY (base_revision_id) REFERENCES shiplet_revisions(id),
				FOREIGN KEY (validated_revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_revision_files (
				revision_id TEXT NOT NULL,
				path TEXT NOT NULL,
				media_type TEXT NOT NULL,
				size INTEGER NOT NULL,
				sha256 TEXT,
				object_key TEXT,
				content_base64 TEXT,
				PRIMARY KEY (revision_id, path),
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_revision_seals (
				revision_id TEXT PRIMARY KEY,
				sealed_on TEXT NOT NULL,
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_revision_activations (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				revision_id TEXT NOT NULL,
				previous_revision_id TEXT,
				kind TEXT NOT NULL,
				activated_on TEXT NOT NULL,
				FOREIGN KEY (project_id) REFERENCES projects(id),
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id),
				FOREIGN KEY (previous_revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_revision_preview_receipts (
				project_id TEXT NOT NULL,
				draft_id TEXT NOT NULL,
				revision_id TEXT NOT NULL,
				draft_version INTEGER NOT NULL,
				actor_kind TEXT NOT NULL,
				actor_id TEXT NOT NULL,
				previewed_on TEXT NOT NULL,
				PRIMARY KEY (
					project_id, draft_id, revision_id, draft_version,
					actor_kind, actor_id
				),
				FOREIGN KEY (project_id) REFERENCES projects(id),
				FOREIGN KEY (draft_id) REFERENCES shiplet_drafts(id),
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_revision_preview_receipts_v2 (
				project_id TEXT NOT NULL,
				draft_id TEXT NOT NULL,
				revision_id TEXT NOT NULL,
				draft_version INTEGER NOT NULL,
				actor_kind TEXT NOT NULL,
				actor_id TEXT NOT NULL,
				session_binding_digest TEXT NOT NULL CHECK (
					length(session_binding_digest) = 64 AND
					session_binding_digest NOT GLOB '*[^a-f0-9]*'
				),
				previewed_on TEXT NOT NULL,
				PRIMARY KEY (
					project_id, draft_id, revision_id, draft_version,
					actor_kind, actor_id, session_binding_digest
				),
				FOREIGN KEY (project_id) REFERENCES projects(id),
				FOREIGN KEY (draft_id) REFERENCES shiplet_drafts(id),
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_capability_grants (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				revision_id TEXT,
				actor_kind TEXT NOT NULL,
				actor_id TEXT NOT NULL,
				capability TEXT NOT NULL,
				resource_json TEXT NOT NULL,
				constraints_json TEXT NOT NULL,
				issued_on TEXT NOT NULL,
				expires_on TEXT,
				revoked_on TEXT,
				FOREIGN KEY (project_id) REFERENCES projects(id),
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_audit_events (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				revision_id TEXT,
				deployment_id TEXT,
				actor_kind TEXT NOT NULL,
				actor_id TEXT NOT NULL,
				event_kind TEXT NOT NULL,
				summary TEXT NOT NULL,
				status_category TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				occurred_on TEXT NOT NULL,
				recorded_on TEXT NOT NULL,
				FOREIGN KEY (project_id) REFERENCES projects(id),
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS deployment_targets (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				owner_kind TEXT NOT NULL,
				owner_id TEXT NOT NULL,
				connection_id TEXT,
				provider_account_id TEXT,
				configuration_json TEXT NOT NULL,
				created_on TEXT NOT NULL,
				detached_on TEXT,
				FOREIGN KEY (project_id) REFERENCES projects(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_deployments (
				id TEXT PRIMARY KEY,
				target_id TEXT NOT NULL,
				revision_id TEXT NOT NULL,
				provider_resource_name TEXT NOT NULL,
				provider_version_id TEXT NOT NULL,
				status TEXT NOT NULL,
				health_json TEXT NOT NULL,
				deployed_on TEXT,
				failed_on TEXT,
				supersedes_deployment_id TEXT,
				FOREIGN KEY (target_id) REFERENCES deployment_targets(id),
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id),
				FOREIGN KEY (supersedes_deployment_id) REFERENCES shiplet_deployments(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_state (
				project_id TEXT NOT NULL,
				deployment_id TEXT NOT NULL,
				namespace TEXT NOT NULL,
				key TEXT NOT NULL,
				value_json TEXT NOT NULL,
				byte_size INTEGER NOT NULL,
				version INTEGER NOT NULL,
				updated_on TEXT NOT NULL,
				PRIMARY KEY (project_id, deployment_id, namespace, key),
				FOREIGN KEY (project_id) REFERENCES projects(id),
				FOREIGN KEY (deployment_id) REFERENCES shiplet_deployments(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_revision_operations (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				candidate_revision_id TEXT NOT NULL,
				prior_revision_id TEXT NOT NULL,
				status TEXT NOT NULL,
				target_generation INTEGER NOT NULL,
				target_ids_json TEXT NOT NULL,
				deployment_ids_json TEXT NOT NULL,
				prepared_json TEXT NOT NULL,
				reconciliation_json TEXT NOT NULL,
				lease_expires_on TEXT,
				idempotency_key TEXT NOT NULL UNIQUE,
				last_error_code TEXT,
				created_on TEXT NOT NULL,
				updated_on TEXT NOT NULL,
				FOREIGN KEY (project_id) REFERENCES projects(id),
				FOREIGN KEY (candidate_revision_id) REFERENCES shiplet_revisions(id),
				FOREIGN KEY (prior_revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_kernel_purge_authorizations (
				project_id TEXT PRIMARY KEY,
				authorized_on TEXT NOT NULL
			)`,
    ),
  ]);

  await addColumnIfMissing(
    db,
    "shiplet_revisions",
    "content_digest",
    "content_digest TEXT",
  );

  await addColumnIfMissing(
    db,
    "projects",
    "active_revision_id",
    "active_revision_id TEXT",
  );
  await addColumnIfMissing(
    db,
    "projects",
    "active_revision_generation",
    "active_revision_generation INTEGER NOT NULL DEFAULT 0",
  );
  await addColumnIfMissing(
    db,
    "projects",
    "revision_migrated_on",
    "revision_migrated_on TEXT",
  );
  await addColumnIfMissing(
    db,
    "projects",
    "deployment_target_generation",
    "deployment_target_generation INTEGER NOT NULL DEFAULT 0",
  );
  await addColumnIfMissing(
    db,
    "projects",
    "revision_operation_id",
    "revision_operation_id TEXT",
  );

  await db.batch([
    db.prepare(`DROP TRIGGER IF EXISTS shiplet_revision_activations_no_delete`),
    db.prepare(`DROP TRIGGER IF EXISTS shiplet_audit_events_no_delete`),
    db.prepare(`DROP TRIGGER IF EXISTS shiplet_revisions_no_delete`),
    db.prepare(`DROP TRIGGER IF EXISTS shiplet_revision_files_no_delete`),
    db.prepare(`DROP TRIGGER IF EXISTS shiplet_revision_seals_no_delete`),
    db.prepare(
      `INSERT OR IGNORE INTO shiplet_revision_seals (revision_id, sealed_on)
			 SELECT id, created_on FROM shiplet_revisions`,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO shiplet_revision_activations (
				id, project_id, revision_id, previous_revision_id, kind, activated_on
			) SELECT 'activation_migrated_' || id, id, active_revision_id, NULL,
			 'migration', COALESCE(revision_migrated_on, modified_on)
			 FROM projects WHERE active_revision_id IS NOT NULL`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_shiplet_drafts_project
			 ON shiplet_drafts(project_id, updated_on)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_shiplet_revisions_project
			 ON shiplet_revisions(project_id, created_on)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_shiplet_deployments_target
			 ON shiplet_deployments(target_id, deployed_on)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_shiplet_activations_revision
			 ON shiplet_revision_activations(project_id, revision_id, activated_on)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_shiplet_revision_preview_receipts_v2_actor
			 ON shiplet_revision_preview_receipts_v2(
				project_id, actor_kind, actor_id, session_binding_digest, previewed_on
			 )`,
    ),
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_shiplet_one_root_revision
			 ON shiplet_revisions(project_id) WHERE parent_revision_id IS NULL`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_shiplet_revision_operations_project
			 ON shiplet_revision_operations(project_id, created_on)`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS deployment_targets_generation_insert
			 AFTER INSERT ON deployment_targets
			 BEGIN
				UPDATE projects SET deployment_target_generation =
				 deployment_target_generation + 1 WHERE id = NEW.project_id;
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS deployment_targets_generation_update
			 AFTER UPDATE OF detached_on, project_id ON deployment_targets
			 WHEN OLD.detached_on IS NOT NEW.detached_on OR OLD.project_id != NEW.project_id
			 BEGIN
				UPDATE projects SET deployment_target_generation =
				 deployment_target_generation + 1 WHERE id = OLD.project_id;
				UPDATE projects SET deployment_target_generation =
				 deployment_target_generation + 1 WHERE id = NEW.project_id
				 AND NEW.project_id != OLD.project_id;
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS deployment_targets_generation_delete
			 AFTER DELETE ON deployment_targets
			 BEGIN
				UPDATE projects SET deployment_target_generation =
				 deployment_target_generation + 1 WHERE id = OLD.project_id;
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revisions_project_parent_insert
			 BEFORE INSERT ON shiplet_revisions
			 WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM shiplet_revisions parent
				 WHERE parent.id = NEW.parent_revision_id
				 AND parent.project_id = NEW.project_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'revision parent crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_drafts_project_revision_insert
			 BEFORE INSERT ON shiplet_drafts
			 WHEN NOT EXISTS (
				SELECT 1 FROM shiplet_revisions base
				 WHERE base.id = NEW.base_revision_id AND base.project_id = NEW.project_id
			 ) OR (
				NEW.validated_revision_id IS NOT NULL AND NOT EXISTS (
				 SELECT 1 FROM shiplet_revisions validated
				 WHERE validated.id = NEW.validated_revision_id
				 AND validated.project_id = NEW.project_id
				)
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'draft revision crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_drafts_project_revision_update
			 BEFORE UPDATE OF base_revision_id, validated_revision_id, project_id
			 ON shiplet_drafts
			 WHEN NOT EXISTS (
				SELECT 1 FROM shiplet_revisions base
				 WHERE base.id = NEW.base_revision_id AND base.project_id = NEW.project_id
			 ) OR (
				NEW.validated_revision_id IS NOT NULL AND NOT EXISTS (
				 SELECT 1 FROM shiplet_revisions validated
				 WHERE validated.id = NEW.validated_revision_id
				 AND validated.project_id = NEW.project_id
				)
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'draft revision crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_activations_project_insert
			 BEFORE INSERT ON shiplet_revision_activations
			 WHEN NOT EXISTS (
				SELECT 1 FROM shiplet_revisions revision
				 WHERE revision.id = NEW.revision_id
				 AND revision.project_id = NEW.project_id
			 ) OR (
				NEW.previous_revision_id IS NOT NULL AND NOT EXISTS (
				 SELECT 1 FROM shiplet_revisions previous
				 WHERE previous.id = NEW.previous_revision_id
				 AND previous.project_id = NEW.project_id
				)
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'activation revision crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revision_preview_receipts_v2_scope_insert
			 BEFORE INSERT ON shiplet_revision_preview_receipts_v2
			 WHEN NEW.draft_version < 1 OR NOT EXISTS (
				SELECT 1
				FROM shiplet_drafts draft
				JOIN shiplet_revisions revision
				  ON revision.id = draft.validated_revision_id
				 AND revision.project_id = draft.project_id
				WHERE draft.id = NEW.draft_id
				  AND draft.project_id = NEW.project_id
				  AND draft.version = NEW.draft_version
				  AND draft.validation_state = 'validated'
				  AND draft.validated_revision_id = NEW.revision_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'revision preview receipt scope mismatch');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_grants_project_insert
			 BEFORE INSERT ON shiplet_capability_grants
			 WHEN NEW.revision_id IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM shiplet_revisions revision
				 WHERE revision.id = NEW.revision_id
				 AND revision.project_id = NEW.project_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'grant revision crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_grants_project_update
			 BEFORE UPDATE OF project_id, revision_id ON shiplet_capability_grants
			 WHEN NEW.project_id != OLD.project_id OR (
				NEW.revision_id IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM shiplet_revisions revision
				 WHERE revision.id = NEW.revision_id
				 AND revision.project_id = NEW.project_id
				)
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'grant revision crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_deployments_project_insert
			 BEFORE INSERT ON shiplet_deployments
			 WHEN NOT EXISTS (
				SELECT 1 FROM deployment_targets target
				 JOIN shiplet_revisions revision
				 ON revision.project_id = target.project_id
				 WHERE target.id = NEW.target_id AND revision.id = NEW.revision_id
			 ) OR (
				NEW.supersedes_deployment_id IS NOT NULL AND NOT EXISTS (
				 SELECT 1 FROM shiplet_deployments previous
				 WHERE previous.id = NEW.supersedes_deployment_id
				 AND previous.target_id = NEW.target_id
				)
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'deployment revision crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_state_project_insert
			 BEFORE INSERT ON shiplet_state
			 WHEN NOT EXISTS (
				SELECT 1 FROM shiplet_deployments deployment
				 JOIN deployment_targets target ON target.id = deployment.target_id
				 WHERE deployment.id = NEW.deployment_id
				 AND target.project_id = NEW.project_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'state deployment crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_deployments_project_update
			 BEFORE UPDATE OF target_id, revision_id, supersedes_deployment_id
			 ON shiplet_deployments
			 WHEN NOT EXISTS (
				SELECT 1 FROM deployment_targets target
				 JOIN shiplet_revisions revision
				 ON revision.project_id = target.project_id
				 WHERE target.id = NEW.target_id AND revision.id = NEW.revision_id
			 ) OR (
				NEW.supersedes_deployment_id IS NOT NULL AND NOT EXISTS (
				 SELECT 1 FROM shiplet_deployments previous
				 WHERE previous.id = NEW.supersedes_deployment_id
				 AND previous.target_id = NEW.target_id
				)
			 ) OR EXISTS (
				SELECT 1 FROM shiplet_state state
				 JOIN deployment_targets target ON target.id = NEW.target_id
				 WHERE state.deployment_id = OLD.id
				 AND state.project_id != target.project_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'deployment revision crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_state_project_update
			 BEFORE UPDATE OF project_id, deployment_id ON shiplet_state
			 WHEN NOT EXISTS (
				SELECT 1 FROM shiplet_deployments deployment
				 JOIN deployment_targets target ON target.id = deployment.target_id
				 WHERE deployment.id = NEW.deployment_id
				 AND target.project_id = NEW.project_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'state deployment crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS deployment_targets_project_update
			 BEFORE UPDATE OF project_id ON deployment_targets
			 WHEN NEW.project_id != OLD.project_id
			 BEGIN
				SELECT RAISE(ABORT, 'deployment target crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS projects_active_revision_project_update
			 BEFORE UPDATE OF active_revision_id ON projects
			 WHEN NEW.active_revision_id IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM shiplet_revisions revision
				 WHERE revision.id = NEW.active_revision_id
				 AND revision.project_id = NEW.id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'active revision crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revision_operations_project_insert
			 BEFORE INSERT ON shiplet_revision_operations
			 WHEN NOT EXISTS (
				SELECT 1 FROM shiplet_revisions candidate
				 JOIN shiplet_revisions prior ON prior.project_id = candidate.project_id
				 WHERE candidate.id = NEW.candidate_revision_id
				 AND prior.id = NEW.prior_revision_id
				 AND candidate.project_id = NEW.project_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'revision operation crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revision_operations_project_update
			 BEFORE UPDATE OF project_id, candidate_revision_id, prior_revision_id
			 ON shiplet_revision_operations
			 WHEN NEW.project_id != OLD.project_id
			 OR NEW.candidate_revision_id != OLD.candidate_revision_id
			 OR NEW.prior_revision_id != OLD.prior_revision_id
			 BEGIN
				SELECT RAISE(ABORT, 'revision operation scope is immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revision_activations_no_update
			 BEFORE UPDATE ON shiplet_revision_activations
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet revision activations are immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revision_activations_no_delete
			 BEFORE DELETE ON shiplet_revision_activations
			 WHEN NOT EXISTS (
				SELECT 1 FROM shiplet_kernel_purge_authorizations purge
				WHERE purge.project_id = OLD.project_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet revision activations are immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revision_preview_receipts_v2_no_update
			 BEFORE UPDATE ON shiplet_revision_preview_receipts_v2
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet revision preview receipts are immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revision_preview_receipts_v2_no_delete
			 BEFORE DELETE ON shiplet_revision_preview_receipts_v2
			 WHEN NOT EXISTS (
				SELECT 1 FROM shiplet_kernel_purge_authorizations purge
				WHERE purge.project_id = OLD.project_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet revision preview receipts are immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_audit_events_project_insert
			 BEFORE INSERT ON shiplet_audit_events
			 WHEN (
				NEW.revision_id IS NOT NULL AND NOT EXISTS (
				 SELECT 1 FROM shiplet_revisions revision
				 WHERE revision.id = NEW.revision_id
				 AND revision.project_id = NEW.project_id
				)
			 ) OR (
				NEW.deployment_id IS NOT NULL AND NOT EXISTS (
				 SELECT 1 FROM shiplet_deployments deployment
				 JOIN deployment_targets target ON target.id = deployment.target_id
				 WHERE deployment.id = NEW.deployment_id
				 AND target.project_id = NEW.project_id
				)
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'audit relationship crosses project boundary');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_audit_events_no_update
			 BEFORE UPDATE ON shiplet_audit_events
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet audit events are immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_audit_events_no_delete
			 BEFORE DELETE ON shiplet_audit_events
			 WHEN NOT EXISTS (
				SELECT 1 FROM shiplet_kernel_purge_authorizations purge
				WHERE purge.project_id = OLD.project_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet audit events are immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revisions_no_update
			 BEFORE UPDATE ON shiplet_revisions
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet revisions are immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revisions_no_delete
			 BEFORE DELETE ON shiplet_revisions
			 WHEN NOT EXISTS (
				SELECT 1 FROM shiplet_kernel_purge_authorizations purge
				WHERE purge.project_id = OLD.project_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet revisions are immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revision_files_no_update
			 BEFORE UPDATE ON shiplet_revision_files
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet revision files are immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revision_files_no_delete
			 BEFORE DELETE ON shiplet_revision_files
			 WHEN NOT EXISTS (
				SELECT 1 FROM shiplet_kernel_purge_authorizations purge
				JOIN shiplet_revisions revision ON revision.id = OLD.revision_id
				WHERE purge.project_id = revision.project_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet revision files are immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revision_files_no_insert_after_seal
			 BEFORE INSERT ON shiplet_revision_files
			 WHEN EXISTS (
				SELECT 1 FROM shiplet_revision_seals
				WHERE revision_id = NEW.revision_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet revision files are sealed');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revision_seals_no_update
			 BEFORE UPDATE ON shiplet_revision_seals
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet revision seals are immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_revision_seals_no_delete
			 BEFORE DELETE ON shiplet_revision_seals
			 WHEN NOT EXISTS (
				SELECT 1 FROM shiplet_kernel_purge_authorizations purge
				JOIN shiplet_revisions revision ON revision.id = OLD.revision_id
				WHERE purge.project_id = revision.project_id
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'shiplet revision seals are immutable');
			 END`,
    ),
  ]);
  await addColumnIfMissing(
    db,
    "shiplet_revisions",
    "custom_mcp_projection_json",
    "custom_mcp_projection_json TEXT",
  );
  await addColumnIfMissing(
    db,
    "shiplet_revision_files",
    "sha256",
    "sha256 TEXT",
  );
}

function auditStatement(
  db: D1Database,
  input: {
    shipletId: string;
    revisionId?: string | null;
    deploymentId?: string | null;
    actor: ShipletActor;
    eventKind: string;
    summary: string;
    statusCategory: string;
    payload?: Record<string, unknown>;
    conditionalOnPreviousChange?: boolean;
  },
) {
  const timestamp = nowIso();
  const condition = input.conditionalOnPreviousChange
    ? " WHERE changes() = 1"
    : "";
  return db
    .prepare(
      `INSERT INTO shiplet_audit_events (
				id, project_id, revision_id, deployment_id, actor_kind, actor_id,
				event_kind, summary, status_category, payload_json, occurred_on,
				recorded_on
			) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${condition}`,
    )
    .bind(
      newId("audit"),
      input.shipletId,
      input.revisionId ?? null,
      input.deploymentId ?? null,
      input.actor.kind,
      input.actor.id,
      input.eventKind,
      input.summary,
      input.statusCategory,
      JSON.stringify(input.payload ?? {}),
      timestamp,
      timestamp,
    );
}

function activationStatement(
  db: D1Database,
  input: {
    shipletId: string;
    revisionId: string;
    previousRevisionId: string | null;
    kind: "initial" | "promotion" | "rollback";
  },
) {
  return db
    .prepare(
      `INSERT INTO shiplet_revision_activations (
				id, project_id, revision_id, previous_revision_id, kind, activated_on
			) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    )
    .bind(
      newId("activation"),
      input.shipletId,
      input.revisionId,
      input.previousRevisionId,
      input.kind,
      nowIso(),
    );
}

const STORED_PACKAGE_REFERENCE_VERSION = "shiplet.package.storage/r2-v1";

function revisionStorageKey(
  shipletId: string,
  kind: "revision" | "draft",
  id: string,
  suffix: string,
) {
  return `self-owned/${encodeURIComponent(shipletId)}/${kind}/${encodeURIComponent(id)}/${suffix}`;
}

async function persistPackageJson(
  packageStore: RevisionPackageStore | undefined,
  key: string,
  serialized: string,
) {
  if (!packageStore) return serialized;
  await packageStore.putText(key, serialized);
  return JSON.stringify({
    storage: STORED_PACKAGE_REFERENCE_VERSION,
    key,
  });
}

async function loadPackageJson(
  packageStore: RevisionPackageStore | undefined,
  stored: string,
) {
  const parsed = JSON.parse(stored) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).storage !==
      STORED_PACKAGE_REFERENCE_VERSION
  ) {
    return stored;
  }
  const key = (parsed as Record<string, unknown>).key;
  if (typeof key !== "string" || !packageStore) {
    lifecycleFailure("package_storage_unavailable");
  }
  const serialized = await packageStore.getText(key);
  if (serialized === null) lifecycleFailure("package_storage_unavailable");
  return serialized;
}

async function persistRevisionFiles(
  packageStore: RevisionPackageStore | undefined,
  shipletId: string,
  revisionId: string,
  packageValue: ValidatedShipletPackage,
) {
  const stored = new Map<string, StoredRevisionFile>();
  for (const file of packageValue.files) {
    if (!packageStore) {
      stored.set(file.path, {
        objectKey: null,
        contentBase64: packageFileContentBase64(file),
      });
      continue;
    }
    const objectKey = revisionStorageKey(
      shipletId,
      "revision",
      revisionId,
      `files/${file.path}`,
    );
    await packageStore.putBytes(objectKey, packageFileContentBytes(file));
    stored.set(file.path, { objectKey, contentBase64: null });
  }
  return stored;
}

function revisionInsertStatements(
  db: D1Database,
  input: {
    id: string;
    shipletId: string;
    parentRevisionId: string | null;
    package: ValidatedShipletPackage;
    packageJson: string;
    digest: string;
    contentDigest: string;
    validationReportJson: string;
    actor: ShipletActor;
    createdOn: string;
    storedFiles: ReadonlyMap<string, StoredRevisionFile>;
    draftGuard?: { draftId: string; expectedVersion: number };
  },
) {
  const customMcpProjection = customMcpProjectionJson(input.package);
  const revisionInsert = input.draftGuard
    ? db
        .prepare(
          `INSERT INTO shiplet_revisions (
						id, project_id, parent_revision_id, package_json, package_digest,
						content_digest, custom_mcp_projection_json,
						runtime_compatibility, validation_report_json,
						created_by_actor_kind, created_by_actor_id, created_on
					) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					 WHERE EXISTS (
						SELECT 1 FROM shiplet_drafts
						WHERE id = ? AND project_id = ? AND version = ?
					 )`,
        )
        .bind(
          input.id,
          input.shipletId,
          input.parentRevisionId,
          input.packageJson,
          input.digest,
          input.contentDigest,
          customMcpProjection,
          input.package.manifest.runtimeCompatibility,
          input.validationReportJson,
          input.actor.kind,
          input.actor.id,
          input.createdOn,
          input.draftGuard.draftId,
          input.shipletId,
          input.draftGuard.expectedVersion,
        )
    : db
        .prepare(
          `INSERT INTO shiplet_revisions (
						id, project_id, parent_revision_id, package_json, package_digest,
						content_digest, custom_mcp_projection_json,
						runtime_compatibility, validation_report_json,
						created_by_actor_kind, created_by_actor_id, created_on
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.id,
          input.shipletId,
          input.parentRevisionId,
          input.packageJson,
          input.digest,
          input.contentDigest,
          customMcpProjection,
          input.package.manifest.runtimeCompatibility,
          input.validationReportJson,
          input.actor.kind,
          input.actor.id,
          input.createdOn,
        );
  return [
    revisionInsert,
    ...input.package.files.map((file) => {
      const stored = input.storedFiles.get(file.path);
      if (!stored) lifecycleFailure("package_storage_unavailable");
      return db
        .prepare(
          `INSERT INTO shiplet_revision_files (
						revision_id, path, media_type, size, sha256, object_key, content_base64
					) SELECT ?, ?, ?, ?, ?, ?, ?
					 WHERE EXISTS (SELECT 1 FROM shiplet_revisions WHERE id = ?)`,
        )
        .bind(
          input.id,
          file.path,
          file.mediaType,
          file.size,
          file.sha256,
          stored.objectKey,
          stored.contentBase64,
          input.id,
        );
    }),
    db
      .prepare(
        `INSERT INTO shiplet_revision_seals (revision_id, sealed_on)
				 SELECT ?, ? WHERE EXISTS (
					SELECT 1 FROM shiplet_revisions WHERE id = ?
				 )`,
      )
      .bind(input.id, input.createdOn, input.id),
  ];
}

function draftView(row: DraftRow): ShipletDraft {
  return {
    id: row.id,
    shipletId: row.project_id,
    baseRevisionId: row.base_revision_id,
    version: row.version,
    validationState: row.validation_state,
    validatedRevisionId: row.validated_revision_id,
  };
}

async function revisionView(
  row: RevisionRow,
  packageStore?: RevisionPackageStore,
): Promise<ShipletRevision> {
  return {
    id: row.id,
    shipletId: row.project_id,
    parentRevisionId: row.parent_revision_id,
    digest: row.package_digest,
    contentDigest: row.content_digest ?? row.package_digest,
    package: await parseShipletPackage(
      JSON.parse(await loadPackageJson(packageStore, row.package_json)),
    ),
    createdOn: row.created_on,
  };
}

async function projectActive(db: D1Database, shipletId: string) {
  const project = await db
    .prepare(
      `SELECT id, active_revision_id, active_revision_generation,
			 deployment_target_generation,
			 revision_operation_id
			 FROM projects WHERE id = ?`,
    )
    .bind(shipletId)
    .first<ProjectActiveRow>();
  if (!project) lifecycleFailure("shiplet_not_found", { shipletId });
  return project;
}

async function scopedDraft(db: D1Database, shipletId: string, draftId: string) {
  const draft = await db
    .prepare(`SELECT * FROM shiplet_drafts WHERE id = ? AND project_id = ?`)
    .bind(draftId, shipletId)
    .first<DraftRow>();
  if (!draft) lifecycleFailure("draft_not_found", { shipletId, draftId });
  return draft;
}

async function scopedRevision(
  db: D1Database,
  shipletId: string,
  revisionId: string,
) {
  const revision = await db
    .prepare(`SELECT * FROM shiplet_revisions WHERE id = ? AND project_id = ?`)
    .bind(revisionId, shipletId)
    .first<RevisionRow>();
  if (!revision) {
    lifecycleFailure("revision_not_found", { shipletId, revisionId });
  }
  return revision;
}

async function scopedTarget(
  db: D1Database,
  shipletId: string,
  targetId: string,
) {
  const target = await db
    .prepare(
      `SELECT id, project_id FROM deployment_targets
			 WHERE id = ? AND project_id = ? AND detached_on IS NULL`,
    )
    .bind(targetId, shipletId)
    .first<DeploymentTargetRow>();
  if (!target) lifecycleFailure("deployment_target_not_found", { targetId });
  return target;
}

async function latestHealthyDeployment(db: D1Database, targetId: string) {
  return db
    .prepare(
      `SELECT id, revision_id, provider_version_id, provider_resource_name
			 FROM shiplet_deployments
			 WHERE target_id = ? AND status = 'healthy'
			 ORDER BY deployed_on DESC, rowid DESC LIMIT 1`,
    )
    .bind(targetId)
    .first<DeploymentRow>();
}

async function attachedTargets(db: D1Database, shipletId: string) {
  const targets = await db
    .prepare(
      `SELECT id, project_id FROM deployment_targets
			 WHERE project_id = ? AND kind = 'customer_cloudflare'
			 AND detached_on IS NULL ORDER BY id`,
    )
    .bind(shipletId)
    .all<DeploymentTargetRow>();
  return targets.results;
}

async function isKnownGoodRevision(
  db: D1Database,
  shipletId: string,
  revisionId: string,
) {
  const activation = await db
    .prepare(
      `SELECT id FROM shiplet_revision_activations
			 WHERE project_id = ? AND revision_id = ? LIMIT 1`,
    )
    .bind(shipletId, revisionId)
    .first<{ id: string }>();
  return Boolean(activation);
}

type PreparedTarget = {
  request: RevisionDeploymentRequest;
  prepared: PreparedRevisionDeployment;
  previousDeployment: DeploymentRow | null;
};

type RestorationOutcome = {
  targetId: string;
  status: "restored" | "failed";
  code?:
    | "prior_deployment_missing"
    | "provider_restore_unavailable"
    | "local_compensation_failed";
};

class ProviderFinalizationError extends Error {
  readonly finalizedTargets: PreparedTarget[];
  readonly ambiguousTargetIds: string[];
  readonly restorationOutcomes: RestorationOutcome[];

  constructor(input: {
    cause: unknown;
    finalizedTargets: PreparedTarget[];
    ambiguousTargetIds: string[];
    restorationOutcomes: RestorationOutcome[];
  }) {
    super("provider finalization failed", { cause: input.cause });
    this.name = "ProviderFinalizationError";
    this.finalizedTargets = input.finalizedTargets;
    this.ambiguousTargetIds = input.ambiguousTargetIds;
    this.restorationOutcomes = input.restorationOutcomes;
  }
}

async function restorePreparedTargets(
  coordinator: RevisionDeploymentCoordinator | undefined,
  targets: PreparedTarget[],
) {
  const outcomes: RestorationOutcome[] = [];
  for (const target of [...targets].reverse()) {
    if (!target.previousDeployment) {
      outcomes.push({
        targetId: target.request.targetId,
        status: "failed",
        code: "prior_deployment_missing",
      });
      continue;
    }
    if (!coordinator?.restorePriorRevision) {
      outcomes.push({
        targetId: target.request.targetId,
        status: "failed",
        code: "provider_restore_unavailable",
      });
      continue;
    }
    try {
      await coordinator.restorePriorRevision({
        ...target.request,
        ...target.prepared,
        previousDeployment: {
          deploymentId: target.previousDeployment.id,
          providerVersionId: target.previousDeployment.provider_version_id,
          providerResourceName:
            target.previousDeployment.provider_resource_name,
        },
      });
      outcomes.push({
        targetId: target.request.targetId,
        status: "restored",
      });
    } catch {
      outcomes.push({
        targetId: target.request.targetId,
        status: "failed",
        code: "provider_restore_unavailable",
      });
    }
  }
  return outcomes;
}

async function finalizePreparedTargets(
  coordinator: RevisionDeploymentCoordinator | undefined,
  targets: PreparedTarget[],
) {
  const finalized: PreparedTarget[] = [];
  if (!coordinator?.activatePreparedRevision) return finalized;
  for (const target of targets) {
    try {
      await coordinator.activatePreparedRevision({
        ...target.request,
        ...target.prepared,
      });
      finalized.push(target);
    } catch (cause) {
      const atRiskTargets = [...finalized, target];
      throw new ProviderFinalizationError({
        cause,
        finalizedTargets: atRiskTargets,
        ambiguousTargetIds: [target.request.targetId],
        restorationOutcomes: await restorePreparedTargets(
          coordinator,
          atRiskTargets,
        ),
      });
    }
  }
  return finalized;
}

async function assertPreparedTargetCommitsAllowed(
  coordinator: RevisionDeploymentCoordinator | undefined,
  targets: PreparedTarget[],
) {
  if (targets.length === 0) return false;
  const assertAllowed = coordinator?.assertPreparedRevisionCommitAllowed;
  const commit = coordinator?.commitPreparedRevision;
  if (!assertAllowed && !commit) return false;
  if (!assertAllowed || !commit) {
    throw new Error("incomplete revision deployment commit coordinator");
  }
  for (const target of targets) {
    await assertAllowed({ ...target.request, ...target.prepared });
  }
  return true;
}

async function commitPreparedTargets(
  coordinator: RevisionDeploymentCoordinator | undefined,
  targets: PreparedTarget[],
) {
  if (!coordinator?.commitPreparedRevision) return;
  for (const target of targets) {
    await coordinator.commitPreparedRevision({
      ...target.request,
      ...target.prepared,
    });
  }
}

async function abandonPreparedTargets(
  coordinator: RevisionDeploymentCoordinator | undefined,
  targets: PreparedTarget[],
) {
  if (!coordinator?.abandonPreparedRevision) return;
  for (const target of targets) {
    try {
      await coordinator.abandonPreparedRevision({
        ...target.request,
        ...target.prepared,
      });
    } catch {
      // The kernel still fails closed; reconciliation can retry from audit state.
    }
  }
}

function draftConflict(currentVersion: number): never {
  return lifecycleFailure("draft_conflict", { currentVersion });
}

function declaredPackageValidationErrors(
  validatedPackage: ValidatedShipletPackage,
): RevisionValidationError[] {
  const packagePaths = new Set(validatedPackage.files.map((file) => file.path));
  return declaredValidationChecks(validatedPackage)
    .filter(
      (check) => check.kind === "file-exists" && !packagePaths.has(check.path),
    )
    .map((check) => ({
      code: "declared_check_failed",
      path: "validation/manifest.json",
      ...(check.id ? { checkId: check.id } : {}),
    }));
}

const MAX_VALIDATION_REPORT_BYTES = 16_384;
const MAX_VALIDATION_ERRORS = 128;
const MAX_VALIDATION_CODE_LENGTH = 128;
const MAX_VALIDATION_PATH_LENGTH = 512;
const MAX_VALIDATION_CHECK_ID_LENGTH = 128;
const DEFAULT_VALIDATION_TIMEOUT_MS = 10_000;
const MAX_VALIDATION_TIMEOUT_MS = 30_000;

function deepFreeze<T>(input: T, seen = new WeakSet<object>()): T {
  if (typeof input !== "object" || input === null || seen.has(input))
    return input;
  seen.add(input);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(input);
}

function ownDataRecord(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return null;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function sanitizeValidationResult(
  value: unknown,
): { ok: boolean; errors: RevisionValidationError[] } | null {
  const result = ownDataRecord(value);
  if (
    !result ||
    !Object.keys(result).every((key) => key === "ok" || key === "errors") ||
    typeof result.ok !== "boolean" ||
    !Array.isArray(result.errors) ||
    result.errors.length > MAX_VALIDATION_ERRORS
  ) {
    return null;
  }
  const errors: RevisionValidationError[] = [];
  for (const candidate of result.errors) {
    const error = ownDataRecord(candidate);
    if (
      !error ||
      !Object.keys(error).every(
        (key) => key === "code" || key === "path" || key === "checkId",
      ) ||
      typeof error.code !== "string" ||
      error.code.length === 0 ||
      error.code.length > MAX_VALIDATION_CODE_LENGTH ||
      (error.path !== undefined &&
        (typeof error.path !== "string" ||
          error.path.length > MAX_VALIDATION_PATH_LENGTH)) ||
      (error.checkId !== undefined &&
        (typeof error.checkId !== "string" ||
          error.checkId.length > MAX_VALIDATION_CHECK_ID_LENGTH))
    ) {
      return null;
    }
    errors.push({
      code: error.code,
      ...(typeof error.path === "string" ? { path: error.path } : {}),
      ...(typeof error.checkId === "string" ? { checkId: error.checkId } : {}),
    });
  }
  if ((result.ok && errors.length > 0) || (!result.ok && errors.length === 0)) {
    return null;
  }
  if (
    new TextEncoder().encode(JSON.stringify({ ok: result.ok, errors }))
      .byteLength > MAX_VALIDATION_REPORT_BYTES
  ) {
    return null;
  }
  return { ok: result.ok, errors };
}

async function customPackageValidationErrors(
  validationRunner: RevisionValidationRunner | undefined,
  input: {
    shipletId: string;
    draftId: string;
    draftVersion: number;
    package: ValidatedShipletPackage;
  },
  timeoutMs: number,
) {
  if (!validationRunner) return [];
  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const isolatedPackage = deepFreeze(
      await parseShipletPackage(
        JSON.parse(await serializeShipletPackage(input.package)),
      ),
    );
    const digestBeforeValidation = await digestShipletPackage(isolatedPackage);
    const outcome = await Promise.race([
      validationRunner
        .validate({
          ...input,
          package: isolatedPackage,
          signal: abortController.signal,
        })
        .then(
          (value) => ({ kind: "result" as const, value }),
          () => ({ kind: "runner_error" as const }),
        ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort("validation_timeout");
          resolve({ kind: "timeout" });
        }, timeoutMs);
      }),
    ]);
    if (outcome.kind === "timeout") return [{ code: "validation_timeout" }];
    if (outcome.kind === "runner_error") {
      return [{ code: "validation_runner_failed" }];
    }
    const rawResult = outcome.value;
    if (
      (await digestShipletPackage(isolatedPackage)) !== digestBeforeValidation
    ) {
      return [{ code: "validation_snapshot_changed" }];
    }
    const result = sanitizeValidationResult(rawResult);
    if (!result) return [{ code: "validation_report_invalid" }];
    if (result.ok && result.errors.length === 0) return [];
    return result.errors.length > 0
      ? result.errors
      : [{ code: "validation_runner_failed" }];
  } catch {
    return [{ code: "validation_runner_failed" }];
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function packageDeclaresCustomMcp(
  validatedPackage: ValidatedShipletPackage,
): boolean {
  const manifestPath = validatedPackage.manifest.entrypoints.mcp;
  const manifestFile = validatedPackage.files.find(
    (file) => file.path === manifestPath,
  );
  if (!manifestFile) return false;
  let manifestText: string;
  if (manifestFile.encoding === "utf8") {
    manifestText = manifestFile.content;
  } else {
    const binary = atob(manifestFile.content);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    manifestText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  const manifest = JSON.parse(manifestText) as { tools?: unknown };
  return Array.isArray(manifest.tools) && manifest.tools.length > 0;
}

function customMcpProjectionJson(packageValue: ValidatedShipletPackage) {
  if (!packageDeclaresCustomMcp(packageValue)) return null;
  const manifestPath = packageValue.manifest.entrypoints.mcp;
  const workflowPath = packageValue.manifest.entrypoints.workflow;
  const manifestFile = packageValue.files.find(
    (file) => file.path === manifestPath,
  );
  const workflowFile = packageValue.files.find(
    (file) => file.path === workflowPath,
  );
  if (!manifestFile || !workflowFile) return null;
  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      packageFileContentBytes(manifestFile),
    ),
  ) as { tools?: Array<{ handler?: unknown }> };
  const referencedHandlerPaths = new Set(
    Array.isArray(manifest.tools)
      ? manifest.tools.flatMap((tool) =>
          typeof tool.handler === "string" ? [tool.handler] : [],
        )
      : [],
  );
  return JSON.stringify({
    schemaVersion: "shiplet.custom-mcp-projection/v1",
    manifest: {
      path: manifestFile.path,
      sha256: manifestFile.sha256,
      size: manifestFile.size,
    },
    workflow: {
      path: workflowFile.path,
      sha256: workflowFile.sha256,
      size: workflowFile.size,
    },
    packageRequestedCapabilities: [
      ...packageValue.manifest.requestedCapabilities,
    ],
    handlers: packageValue.files
      .filter(
        (file) =>
          referencedHandlerPaths.has(file.path) &&
          file.path.startsWith("mcp/handlers/") &&
          file.path.endsWith(".js"),
      )
      .map((file) => ({
        path: file.path,
        sha256: file.sha256,
        size: file.size,
      })),
  });
}

async function strictMcpPackageValidationErrors(
  mcpManifestValidator: RevisionMcpManifestValidator | undefined,
  input: {
    shipletId: string;
    revisionId: string;
    package: ValidatedShipletPackage;
  },
  timeoutMs: number,
): Promise<{ required: boolean; errors: RevisionValidationError[] }> {
  if (!packageDeclaresCustomMcp(input.package)) {
    return { required: false, errors: [] };
  }
  const manifestPath = input.package.manifest.entrypoints.mcp;
  if (!mcpManifestValidator) {
    return {
      required: true,
      errors: [{ code: "mcp_validator_unavailable", path: manifestPath }],
    };
  }
  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const isolatedPackage = deepFreeze(
      await parseShipletPackage(
        JSON.parse(await serializeShipletPackage(input.package)),
      ),
    );
    const digestBeforeValidation = await digestShipletPackage(isolatedPackage);
    const outcome = await Promise.race([
      mcpManifestValidator
        .validate({
          ...input,
          package: isolatedPackage,
          signal: abortController.signal,
        })
        .then(
          (value) => ({ kind: "result" as const, value }),
          () => ({ kind: "validator_error" as const }),
        ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort("mcp_validation_timeout");
          resolve({ kind: "timeout" });
        }, timeoutMs);
      }),
    ]);
    if (outcome.kind === "timeout") {
      return { required: true, errors: [{ code: "mcp_validation_timeout" }] };
    }
    if (outcome.kind === "validator_error") {
      return { required: true, errors: [{ code: "mcp_validator_failed" }] };
    }
    if (
      (await digestShipletPackage(isolatedPackage)) !== digestBeforeValidation
    ) {
      return {
        required: true,
        errors: [{ code: "mcp_validation_snapshot_changed" }],
      };
    }
    const result = sanitizeValidationResult(outcome.value);
    if (!result) {
      return {
        required: true,
        errors: [{ code: "mcp_validation_report_invalid" }],
      };
    }
    return {
      required: true,
      errors:
        result.ok && result.errors.length === 0
          ? []
          : result.errors.length > 0
            ? result.errors
            : [{ code: "mcp_validator_failed" }],
    };
  } catch {
    return { required: true, errors: [{ code: "mcp_validator_failed" }] };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function provenanceMismatchError(
  validatedPackage: ValidatedShipletPackage,
  expectedParentRevisionId: string | null,
) {
  const declaredParentRevisionId =
    shipletPackageProvenanceParentRevisionId(validatedPackage);
  if (
    declaredParentRevisionId !== null &&
    declaredParentRevisionId !== expectedParentRevisionId
  ) {
    return {
      code: "provenance_lineage_mismatch",
      path: "provenance.json.lineage.parentRevisionId",
      expectedParentRevisionId,
    };
  }
  return null;
}

async function canonicalPackageForParent(
  validatedPackage: ValidatedShipletPackage,
  expectedParentRevisionId: string | null,
) {
  const mismatch = provenanceMismatchError(
    validatedPackage,
    expectedParentRevisionId,
  );
  if (mismatch) return { mismatch, package: validatedPackage };
  return {
    mismatch: null,
    package:
      expectedParentRevisionId === null
        ? validatedPackage
        : await withShipletPackageProvenanceParent(
            validatedPackage,
            expectedParentRevisionId,
          ),
  };
}

async function recordDeploymentFailure(
  db: D1Database,
  input: {
    shipletId: string;
    revisionId: string;
    actor: ShipletActor;
    reason: "promotion" | "rollback";
    code: string;
    operationId?: string;
    targetIds?: string[];
    deploymentIds?: string[];
    providerVersionIds?: string[];
    ambiguousTargetIds?: string[];
    restoredTargetIds?: string[];
    reconciliationRequiredTargetIds?: string[];
    restorationOutcomes?: RestorationOutcome[];
  },
) {
  await db.batch([
    auditStatement(db, {
      shipletId: input.shipletId,
      revisionId: input.revisionId,
      actor: input.actor,
      eventKind:
        input.reason === "rollback"
          ? "revision.rollback_failed"
          : "revision.promotion_failed",
      summary: "Provider activation failed",
      statusCategory: "blocked",
      payload: {
        code: input.code,
        ...(input.operationId ? { operationId: input.operationId } : {}),
        ...(input.targetIds ? { targetIds: input.targetIds } : {}),
        ...(input.deploymentIds ? { deploymentIds: input.deploymentIds } : {}),
        ...(input.providerVersionIds
          ? { providerVersionIds: input.providerVersionIds }
          : {}),
        ...(input.ambiguousTargetIds
          ? { ambiguousTargetIds: input.ambiguousTargetIds }
          : {}),
        ...(input.restoredTargetIds
          ? { restoredTargetIds: input.restoredTargetIds }
          : {}),
        ...(input.reconciliationRequiredTargetIds
          ? {
              reconciliationRequiredTargetIds:
                input.reconciliationRequiredTargetIds,
            }
          : {}),
        ...(input.restorationOutcomes
          ? { restorationOutcomes: input.restorationOutcomes }
          : {}),
      },
    }),
  ]);
}

function leaseExpiryIso() {
  return new Date(Date.now() + 60_000).toISOString();
}

function preparedTargetsJson(targets: PreparedTarget[]) {
  return JSON.stringify(
    targets.map((target) => ({
      request: target.request,
      prepared: target.prepared,
      previousDeployment: target.previousDeployment,
    })),
  );
}

async function reserveRevisionOperation(
  db: D1Database,
  input: {
    shipletId: string;
    expectedActiveRevisionId: string;
    expectedTargetGeneration: number;
    kind: "promotion" | "rollback";
    candidateRevisionId: string;
    preparedTargets: PreparedTarget[];
    idempotencyKey?: string;
  },
) {
  const operationId = newId("revision_operation");
  const timestamp = nowIso();
  const targetIds = input.preparedTargets.map(
    (target) => target.request.targetId,
  );
  const deploymentIds = input.preparedTargets.map(
    (target) => target.prepared.deploymentId,
  );
  const results = await db.batch([
    db
      .prepare(
        `UPDATE projects SET revision_operation_id = ?
				 WHERE id = ? AND active_revision_id = ?
				 AND deployment_target_generation = ?
				 AND revision_operation_id IS NULL`,
      )
      .bind(
        operationId,
        input.shipletId,
        input.expectedActiveRevisionId,
        input.expectedTargetGeneration,
      ),
    db
      .prepare(
        `INSERT INTO shiplet_revision_operations (
					id, project_id, kind, candidate_revision_id, prior_revision_id,
					status, target_generation, target_ids_json, deployment_ids_json,
					prepared_json, reconciliation_json, lease_expires_on,
					idempotency_key, last_error_code, created_on, updated_on
				) SELECT ?, ?, ?, ?, ?, 'activating', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
				 WHERE EXISTS (
					SELECT 1 FROM projects WHERE id = ? AND revision_operation_id = ?
				 )`,
      )
      .bind(
        operationId,
        input.shipletId,
        input.kind,
        input.candidateRevisionId,
        input.expectedActiveRevisionId,
        input.expectedTargetGeneration,
        JSON.stringify(targetIds),
        JSON.stringify(deploymentIds),
        preparedTargetsJson(input.preparedTargets),
        JSON.stringify({
          ambiguousTargetIds: [],
          restoredTargetIds: [],
          reconciliationRequiredTargetIds: [],
          restorationOutcomes: [],
        }),
        leaseExpiryIso(),
        input.idempotencyKey ?? operationId,
        timestamp,
        timestamp,
        input.shipletId,
        operationId,
      ),
  ]);
  if (results[0].meta.changes === 1 && results[1].meta.changes === 1) {
    return operationId;
  }
  const current = await projectActive(db, input.shipletId);
  if (current.deployment_target_generation !== input.expectedTargetGeneration) {
    lifecycleFailure("deployment_target_conflict");
  }
  lifecycleFailure("revision_conflict", {
    expectedRevisionId: input.expectedActiveRevisionId,
    currentRevisionId: current.active_revision_id,
  });
}

function operationCorrelation(targets: PreparedTarget[]) {
  return {
    targetIds: targets.map((target) => target.request.targetId),
    deploymentIds: targets.map((target) => target.prepared.deploymentId),
    providerVersionIds: targets.map(
      (target) => target.prepared.providerVersionId,
    ),
  };
}

async function recordOperationCompensation(
  db: D1Database,
  input: {
    operationId: string;
    shipletId: string;
    revisionId: string;
    actor: ShipletActor;
    reason: "promotion" | "rollback";
    preparedTargets: PreparedTarget[];
    ambiguousTargetIds: string[];
    restorationOutcomes: RestorationOutcome[];
  },
) {
  const restored = new Set(
    input.restorationOutcomes
      .filter((outcome) => outcome.status === "restored")
      .map((outcome) => outcome.targetId),
  );
  const reconciliationRequired = new Set(
    input.restorationOutcomes
      .filter((outcome) => outcome.status === "failed")
      .map((outcome) => outcome.targetId),
  );
  const restoredTargetIds = input.preparedTargets
    .map((target) => target.request.targetId)
    .filter((targetId) => restored.has(targetId));
  const reconciliationRequiredTargetIds = input.preparedTargets
    .map((target) => target.request.targetId)
    .filter((targetId) => reconciliationRequired.has(targetId));
  const status: RevisionOperationStatus =
    reconciliationRequiredTargetIds.length > 0
      ? "reconciliation_required"
      : "compensated";
  const lastErrorCode =
    status === "reconciliation_required"
      ? "provider_restore_failed"
      : "deployment_activation_failed";
  const reconciliation = {
    ambiguousTargetIds: input.ambiguousTargetIds,
    restoredTargetIds,
    reconciliationRequiredTargetIds,
    restorationOutcomes: input.restorationOutcomes,
  };
  const statements = [
    db
      .prepare(
        `UPDATE shiplet_revision_operations
				 SET status = ?, reconciliation_json = ?, lease_expires_on = NULL,
				 last_error_code = ?, updated_on = ?
				 WHERE id = ? AND project_id = ?`,
      )
      .bind(
        status,
        JSON.stringify(reconciliation),
        lastErrorCode,
        nowIso(),
        input.operationId,
        input.shipletId,
      ),
  ];
  if (status === "compensated") {
    statements.push(
      db
        .prepare(
          `UPDATE projects SET revision_operation_id = NULL
					 WHERE id = ? AND revision_operation_id = ?`,
        )
        .bind(input.shipletId, input.operationId),
    );
  }
  await db.batch(statements);
  const correlation = operationCorrelation(input.preparedTargets);
  await recordDeploymentFailure(db, {
    shipletId: input.shipletId,
    revisionId: input.revisionId,
    actor: input.actor,
    reason: input.reason,
    code: lastErrorCode,
    operationId: input.operationId,
    ...correlation,
    ambiguousTargetIds: input.ambiguousTargetIds,
    restoredTargetIds,
    reconciliationRequiredTargetIds,
    restorationOutcomes: input.restorationOutcomes,
  });
  return { status, reconciliation };
}

async function compensateFailedPreparedCommit(
  db: D1Database,
  input: {
    coordinator: RevisionDeploymentCoordinator | undefined;
    operationId: string;
    shipletId: string;
    candidateRevisionId: string;
    priorRevisionId: string;
    actor: ShipletActor;
    reason: "promotion" | "rollback";
    preparedTargets: PreparedTarget[];
    finalizedTargets: PreparedTarget[];
    localCommitApplied: boolean;
  },
) {
  let localCompensated = true;
  if (input.localCommitApplied) {
    localCompensated = await compensateLocalRevisionCommit(db, {
      operationId: input.operationId,
      shipletId: input.shipletId,
      candidateRevisionId: input.candidateRevisionId,
      priorRevisionId: input.priorRevisionId,
      preparedTargets: input.preparedTargets,
    });
  }
  const restorationOutcomes = localCompensated
    ? await restorePreparedTargets(input.coordinator, input.finalizedTargets)
    : input.finalizedTargets.map((target) => ({
        targetId: target.request.targetId,
        status: "failed" as const,
        code: "local_compensation_failed" as const,
      }));
  await abandonPreparedTargets(input.coordinator, input.preparedTargets);
  await recordOperationCompensation(db, {
    operationId: input.operationId,
    shipletId: input.shipletId,
    revisionId: input.candidateRevisionId,
    actor: input.actor,
    reason: input.reason,
    preparedTargets: input.preparedTargets,
    ambiguousTargetIds: localCompensated
      ? []
      : input.finalizedTargets.map((target) => target.request.targetId),
    restorationOutcomes,
  });
}

function operationCommitStatement(
  db: D1Database,
  shipletId: string,
  operationId: string,
  expectedStatus: "activating" | "committing" = "activating",
) {
  return db
    .prepare(
      `UPDATE shiplet_revision_operations
			 SET status = 'committed', lease_expires_on = NULL,
			 last_error_code = NULL, updated_on = ?
			 WHERE id = ? AND project_id = ? AND status = ?`,
    )
    .bind(nowIso(), operationId, shipletId, expectedStatus);
}

function operationCommittingStatement(
  db: D1Database,
  shipletId: string,
  operationId: string,
) {
  return db
    .prepare(
      `UPDATE shiplet_revision_operations
			 SET status = 'committing', updated_on = ?
			 WHERE id = ? AND project_id = ? AND status = 'activating'`,
    )
    .bind(nowIso(), operationId, shipletId);
}

async function compensateLocalRevisionCommit(
  db: D1Database,
  input: {
    operationId: string;
    shipletId: string;
    candidateRevisionId: string;
    priorRevisionId: string;
    preparedTargets: PreparedTarget[];
  },
) {
  const timestamp = nowIso();
  const statements = [
    db
      .prepare(
        `UPDATE projects SET active_revision_id = ?,
			 active_revision_generation = active_revision_generation + 1,
			 modified_on = ?
			 WHERE id = ? AND active_revision_id = ?
			 AND revision_operation_id = ?`,
      )
      .bind(
        input.priorRevisionId,
        timestamp,
        input.shipletId,
        input.candidateRevisionId,
        input.operationId,
      ),
    activationStatement(db, {
      shipletId: input.shipletId,
      revisionId: input.priorRevisionId,
      previousRevisionId: input.candidateRevisionId,
      kind: "rollback",
    }),
  ];
  for (const target of input.preparedTargets) {
    statements.push(
      db
        .prepare(
          `UPDATE shiplet_deployments
				 SET status = 'failed', health_json = ?, failed_on = ?
				 WHERE id = ? AND target_id = ? AND revision_id = ?
				 AND status = 'healthy' AND EXISTS (
				  SELECT 1 FROM projects project
				  WHERE project.id = ? AND project.active_revision_id = ?
				  AND project.revision_operation_id = ?
				 )`,
        )
        .bind(
          JSON.stringify({
            status: "failed",
            code: "deployment_commit_compensated",
          }),
          timestamp,
          target.prepared.deploymentId,
          target.request.targetId,
          input.candidateRevisionId,
          input.shipletId,
          input.priorRevisionId,
          input.operationId,
        ),
    );
  }
  try {
    const results = await db.batch(statements);
    return (
      results[0]?.meta.changes === 1 &&
      results[1]?.meta.changes === 1 &&
      results.slice(2).every((result) => result.meta.changes === 1)
    );
  } catch {
    return false;
  }
}

async function scopedRevisionOperation(
  db: D1Database,
  shipletId: string,
  operationId: string,
) {
  const operation = await db
    .prepare(
      `SELECT * FROM shiplet_revision_operations
			 WHERE id = ? AND project_id = ?`,
    )
    .bind(operationId, shipletId)
    .first<RevisionOperationRow>();
  if (!operation) {
    lifecycleFailure("revision_operation_not_found", {
      shipletId,
      operationId,
    });
  }
  return operation;
}

function exactRecordKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function boundedJournalString(value: unknown, maximum = 512) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

async function operationPreparedTargets(
  db: D1Database,
  operation: RevisionOperationRow,
) {
  let targets: unknown;
  let targetIds: unknown;
  let deploymentIds: unknown;
  try {
    targets = JSON.parse(operation.prepared_json);
    targetIds = JSON.parse(operation.target_ids_json);
    deploymentIds = JSON.parse(operation.deployment_ids_json);
  } catch {
    lifecycleFailure("revision_operation_corrupt", {
      operationId: operation.id,
    });
  }
  if (
    !Array.isArray(targets) ||
    !Array.isArray(targetIds) ||
    !Array.isArray(deploymentIds) ||
    targets.length > 128 ||
    targets.length !== targetIds.length ||
    targets.length !== deploymentIds.length ||
    targetIds.some((id) => !boundedJournalString(id)) ||
    deploymentIds.some((id) => !boundedJournalString(id))
  ) {
    lifecycleFailure("revision_operation_corrupt", {
      operationId: operation.id,
    });
  }
  const normalized: PreparedTarget[] = [];
  const seenTargets = new Set<string>();
  const seenDeployments = new Set<string>();
  for (const [index, target] of targets.entries()) {
    if (
      typeof target !== "object" ||
      target === null ||
      Array.isArray(target)
    ) {
      lifecycleFailure("revision_operation_corrupt", {
        operationId: operation.id,
      });
    }
    const candidate = target as Record<string, unknown>;
    const request = candidate.request;
    const prepared = candidate.prepared;
    const previous = candidate.previousDeployment;
    if (
      !exactRecordKeys(candidate, [
        "request",
        "prepared",
        "previousDeployment",
      ]) ||
      typeof request !== "object" ||
      request === null ||
      Array.isArray(request) ||
      typeof prepared !== "object" ||
      prepared === null ||
      Array.isArray(prepared) ||
      (previous !== null &&
        (typeof previous !== "object" ||
          previous === null ||
          Array.isArray(previous)))
    ) {
      lifecycleFailure("revision_operation_corrupt", {
        operationId: operation.id,
      });
    }
    const requestRecord = request as Record<string, unknown>;
    const preparedRecord = prepared as Record<string, unknown>;
    const previousRecord = previous as Record<string, unknown> | null;
    const expectedReason =
      operation.kind === "rollback" ? "rollback" : "promotion";
    if (
      !exactRecordKeys(requestRecord, [
        "shipletId",
        "revisionId",
        "targetId",
        "reason",
      ]) ||
      !exactRecordKeys(
        preparedRecord,
        ["deploymentId", "providerVersionId", "status"],
        ["providerResourceName"],
      ) ||
      requestRecord.shipletId !== operation.project_id ||
      requestRecord.revisionId !== operation.candidate_revision_id ||
      requestRecord.reason !== expectedReason ||
      requestRecord.targetId !== targetIds[index] ||
      preparedRecord.deploymentId !== deploymentIds[index] ||
      preparedRecord.status !== "healthy" ||
      !boundedJournalString(requestRecord.targetId) ||
      !boundedJournalString(preparedRecord.deploymentId) ||
      !boundedJournalString(preparedRecord.providerVersionId) ||
      (preparedRecord.providerResourceName !== undefined &&
        !boundedJournalString(preparedRecord.providerResourceName)) ||
      seenTargets.has(requestRecord.targetId as string) ||
      seenDeployments.has(preparedRecord.deploymentId as string)
    ) {
      lifecycleFailure("revision_operation_corrupt", {
        operationId: operation.id,
      });
    }
    const targetRow = await db
      .prepare(
        `SELECT id FROM deployment_targets
			 WHERE id = ? AND project_id = ? LIMIT 1`,
      )
      .bind(requestRecord.targetId, operation.project_id)
      .first<{ id: string }>();
    if (!targetRow) {
      lifecycleFailure("revision_operation_corrupt", {
        operationId: operation.id,
      });
    }
    let normalizedPrevious: DeploymentRow | null = null;
    if (previousRecord) {
      if (
        !exactRecordKeys(previousRecord, [
          "id",
          "revision_id",
          "provider_version_id",
          "provider_resource_name",
        ]) ||
        !boundedJournalString(previousRecord.id) ||
        !boundedJournalString(previousRecord.revision_id) ||
        !boundedJournalString(previousRecord.provider_version_id) ||
        !boundedJournalString(previousRecord.provider_resource_name)
      ) {
        lifecycleFailure("revision_operation_corrupt", {
          operationId: operation.id,
        });
      }
      const persisted = await db
        .prepare(
          `SELECT deployment.id, deployment.revision_id,
				 deployment.provider_version_id, deployment.provider_resource_name
			 FROM shiplet_deployments deployment
			 JOIN shiplet_revisions revision ON revision.id = deployment.revision_id
			 WHERE deployment.id = ? AND deployment.target_id = ?
			 AND revision.project_id = ? LIMIT 1`,
        )
        .bind(previousRecord.id, requestRecord.targetId, operation.project_id)
        .first<DeploymentRow>();
      if (
        !persisted ||
        persisted.revision_id !== previousRecord.revision_id ||
        persisted.provider_version_id !== previousRecord.provider_version_id ||
        persisted.provider_resource_name !==
          previousRecord.provider_resource_name
      ) {
        lifecycleFailure("revision_operation_corrupt", {
          operationId: operation.id,
        });
      }
      normalizedPrevious = persisted;
    }
    seenTargets.add(requestRecord.targetId as string);
    seenDeployments.add(preparedRecord.deploymentId as string);
    normalized.push({
      request: {
        shipletId: operation.project_id,
        revisionId: operation.candidate_revision_id,
        targetId: requestRecord.targetId as string,
        reason: expectedReason,
      },
      prepared: {
        deploymentId: preparedRecord.deploymentId as string,
        providerVersionId: preparedRecord.providerVersionId as string,
        ...(typeof preparedRecord.providerResourceName === "string"
          ? { providerResourceName: preparedRecord.providerResourceName }
          : {}),
        status: "healthy",
      },
      previousDeployment: normalizedPrevious,
    });
  }
  return normalized;
}

async function recordValidationFailure(
  db: D1Database,
  input: {
    shipletId: string;
    draftId: string;
    expectedVersion: number;
    actor: ShipletActor;
    draft: DraftRow;
    errors: RevisionValidationError[];
  },
): Promise<DraftValidationResult> {
  const reportJson = JSON.stringify({ ok: false, errors: input.errors });
  const results = await db.batch([
    db
      .prepare(
        `UPDATE shiplet_drafts SET validation_state = 'failed',
				 validation_report_json = ?, validated_revision_id = NULL,
				 updated_on = ?
				 WHERE id = ? AND project_id = ? AND version = ?`,
      )
      .bind(
        reportJson,
        nowIso(),
        input.draftId,
        input.shipletId,
        input.expectedVersion,
      ),
    auditStatement(db, {
      shipletId: input.shipletId,
      revisionId: input.draft.base_revision_id,
      actor: input.actor,
      eventKind: "revision.validation_failed",
      summary: "Draft validation failed",
      statusCategory: "blocked",
      payload: {
        draftId: input.draftId,
        errorCode: input.errors[0]?.code ?? "validation_failed",
      },
      conditionalOnPreviousChange: true,
    }),
  ]);
  if (results[0].meta.changes !== 1) {
    const latest = await scopedDraft(db, input.shipletId, input.draftId);
    draftConflict(latest.version);
  }
  return {
    ok: false,
    draftVersion: input.draft.version,
    revisionId: "",
    errors: input.errors,
  };
}

async function prepareDeployment(
  db: D1Database,
  coordinator: RevisionDeploymentCoordinator | undefined,
  input: RevisionDeploymentRequest,
  actor: ShipletActor,
) {
  await scopedTarget(db, input.shipletId, input.targetId);
  if (!coordinator) {
    await db.batch([
      auditStatement(db, {
        shipletId: input.shipletId,
        revisionId: input.revisionId,
        actor,
        eventKind:
          input.reason === "rollback"
            ? "revision.rollback_failed"
            : "revision.promotion_failed",
        summary: "Deployment preparation failed",
        statusCategory: "blocked",
        payload: { targetId: input.targetId, code: "deployment_failed" },
      }),
    ]);
    lifecycleFailure("deployment_failed");
  }
  try {
    const prepared = await coordinator.prepareRevision(input);
    if (
      prepared.status !== "healthy" ||
      typeof prepared.deploymentId !== "string" ||
      prepared.deploymentId.length === 0 ||
      typeof prepared.providerVersionId !== "string" ||
      prepared.providerVersionId.length === 0
    ) {
      throw new Error("invalid deployment result");
    }
    return prepared;
  } catch (error) {
    const failureCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "customer_advanced_runtime_egress_unavailable"
        ? error.code
        : "deployment_failed";
    await db.batch([
      auditStatement(db, {
        shipletId: input.shipletId,
        revisionId: input.revisionId,
        actor,
        eventKind:
          input.reason === "rollback"
            ? "revision.rollback_failed"
            : "revision.promotion_failed",
        summary: "Deployment preparation failed",
        statusCategory: "blocked",
        payload: { targetId: input.targetId, code: failureCode },
      }),
    ]);
    lifecycleFailure(failureCode);
  }
}

function deploymentInsertStatement(
  db: D1Database,
  input: {
    prepared: PreparedRevisionDeployment;
    targetId: string;
    revisionId: string;
    shipletId: string;
    supersedesDeploymentId: string | null;
  },
) {
  return db
    .prepare(
      `INSERT INTO shiplet_deployments (
				id, target_id, revision_id, provider_resource_name,
				provider_version_id, status, health_json, deployed_on,
				failed_on, supersedes_deployment_id
			) SELECT ?, ?, ?, ?, ?, 'healthy', '{"status":"healthy"}', ?, NULL, ?
			 WHERE changes() = 1`,
    )
    .bind(
      input.prepared.deploymentId,
      input.targetId,
      input.revisionId,
      input.prepared.providerResourceName ?? `shiplet-${input.shipletId}`,
      input.prepared.providerVersionId,
      nowIso(),
      input.supersedesDeploymentId,
    );
}

export function createRevisionService(options: RevisionServiceOptions) {
  const {
    db,
    deploymentCoordinator,
    validationRunner,
    mcpManifestValidator,
    kernelAuthorizer,
    packageStore,
  } = options;
  const validationTimeoutMs =
    options.validationTimeoutMs === undefined
      ? DEFAULT_VALIDATION_TIMEOUT_MS
      : options.validationTimeoutMs;
  if (
    !Number.isInteger(validationTimeoutMs) ||
    validationTimeoutMs < 1 ||
    validationTimeoutMs > MAX_VALIDATION_TIMEOUT_MS
  ) {
    throw new TypeError(
      "validationTimeoutMs must be an integer from 1 to 30000",
    );
  }

  return {
    async createInitialRevision(input: {
      shipletId: string;
      package: unknown;
      actor: ShipletActor;
    }) {
      assertActor(input.actor);
      await authorizeRevisionAction(kernelAuthorizer, {
        shipletId: input.shipletId,
        actor: input.actor,
        action: "revision.create_initial",
      });
      const active = await projectActive(db, input.shipletId);
      if (active.active_revision_id) {
        lifecycleFailure("revision_conflict", {
          currentRevisionId: active.active_revision_id,
        });
      }
      let validatedPackage = await parseShipletPackage(input.package);
      const lineage = await canonicalPackageForParent(validatedPackage, null);
      if (lineage.mismatch) {
        const { code, ...details } = lineage.mismatch;
        lifecycleFailure(code, details);
      }
      validatedPackage = lineage.package;
      const revisionId = newId("revision");
      const declaredErrors = declaredPackageValidationErrors(validatedPackage);
      const strictMcpValidation = await strictMcpPackageValidationErrors(
        mcpManifestValidator,
        {
          shipletId: input.shipletId,
          revisionId,
          package: validatedPackage,
        },
        validationTimeoutMs,
      );
      const customErrors = await customPackageValidationErrors(
        validationRunner,
        {
          shipletId: input.shipletId,
          draftId: `initial:${input.shipletId}`,
          draftVersion: 0,
          package: validatedPackage,
        },
        validationTimeoutMs,
      );
      const validationErrors = [
        ...declaredErrors,
        ...strictMcpValidation.errors,
        ...customErrors,
      ];
      if (validationErrors.length > 0) {
        lifecycleFailure("initial_validation_failed", {
          errors: validationErrors,
        });
      }
      const serializedPackage = await serializeShipletPackage(validatedPackage);
      const digest = await digestShipletPackage(validatedPackage);
      const contentDigest = await digestShipletPackageContent(validatedPackage);
      const createdOn = nowIso();
      const packageJson = await persistPackageJson(
        packageStore,
        revisionStorageKey(
          input.shipletId,
          "revision",
          revisionId,
          "package.json",
        ),
        serializedPackage,
      );
      const storedFiles = await persistRevisionFiles(
        packageStore,
        input.shipletId,
        revisionId,
        validatedPackage,
      );
      const validationReportJson = JSON.stringify({ ok: true, errors: [] });
      const statements = revisionInsertStatements(db, {
        id: revisionId,
        shipletId: input.shipletId,
        parentRevisionId: null,
        package: validatedPackage,
        packageJson,
        digest,
        contentDigest,
        validationReportJson,
        actor: input.actor,
        createdOn,
        storedFiles,
      });
      const activationIndex = statements.length;
      statements.push(
        db
          .prepare(
            `UPDATE projects SET active_revision_id = ?,
						 active_revision_generation = active_revision_generation + 1,
						 revision_migrated_on = ?, modified_on = ?
						 WHERE id = ? AND active_revision_id IS NULL`,
          )
          .bind(revisionId, createdOn, createdOn, input.shipletId),
        activationStatement(db, {
          shipletId: input.shipletId,
          revisionId,
          previousRevisionId: null,
          kind: "initial",
        }),
        auditStatement(db, {
          shipletId: input.shipletId,
          revisionId,
          actor: input.actor,
          eventKind: "revision.initialized",
          summary: "Initial revision activated",
          statusCategory: "informational",
          payload: { packageDigest: digest },
          conditionalOnPreviousChange: true,
        }),
      );
      let results: D1Result[];
      try {
        results = await db.batch(statements);
      } catch (error) {
        const current = await projectActive(db, input.shipletId);
        if (current.active_revision_id) {
          lifecycleFailure("revision_conflict", {
            currentRevisionId: current.active_revision_id,
          });
        }
        throw error;
      }
      if (results[activationIndex].meta.changes !== 1) {
        const current = await projectActive(db, input.shipletId);
        lifecycleFailure("revision_conflict", {
          currentRevisionId: current.active_revision_id,
        });
      }
      return revisionView(
        {
          id: revisionId,
          project_id: input.shipletId,
          parent_revision_id: null,
          package_json: packageJson,
          package_digest: digest,
          content_digest: contentDigest,
          custom_mcp_projection_json: customMcpProjectionJson(validatedPackage),
          runtime_compatibility: validatedPackage.manifest.runtimeCompatibility,
          validation_report_json: validationReportJson,
          created_by_actor_kind: input.actor.kind,
          created_by_actor_id: input.actor.id,
          created_on: createdOn,
        },
        packageStore,
      );
    },

    async forkRevision(input: {
      shipletId: string;
      revisionId: string;
      actor: ShipletActor;
    }) {
      assertActor(input.actor);
      await authorizeRevisionAction(kernelAuthorizer, {
        shipletId: input.shipletId,
        actor: input.actor,
        action: "revision.fork",
      });
      const revision = await scopedRevision(
        db,
        input.shipletId,
        input.revisionId,
      );
      const forkPackage = await withShipletPackageProvenanceParent(
        await parseShipletPackage(
          JSON.parse(
            await loadPackageJson(packageStore, revision.package_json),
          ),
        ),
        input.revisionId,
      );
      const serializedForkPackage = await serializeShipletPackage(forkPackage);
      const forkDigest = await digestShipletPackage(forkPackage);
      const draftId = newId("draft");
      const forkPackageJson = await persistPackageJson(
        packageStore,
        revisionStorageKey(input.shipletId, "draft", draftId, "v1.json"),
        serializedForkPackage,
      );
      const timestamp = nowIso();
      await db.batch([
        db
          .prepare(
            `INSERT INTO shiplet_drafts (
							id, project_id, base_revision_id, package_json, package_digest,
							version, validation_state, validation_report_json,
							validated_revision_id, created_by_actor_kind,
							created_by_actor_id, created_on, updated_on
						) VALUES (?, ?, ?, ?, ?, 1, 'pending', NULL, NULL, ?, ?, ?, ?)`,
          )
          .bind(
            draftId,
            input.shipletId,
            input.revisionId,
            forkPackageJson,
            forkDigest,
            input.actor.kind,
            input.actor.id,
            timestamp,
            timestamp,
          ),
        auditStatement(db, {
          shipletId: input.shipletId,
          revisionId: input.revisionId,
          actor: input.actor,
          eventKind: "revision.forked",
          summary: "Revision forked into isolated draft",
          statusCategory: "informational",
          payload: { draftId },
        }),
      ]);
      return {
        id: draftId,
        shipletId: input.shipletId,
        baseRevisionId: input.revisionId,
        version: 1,
        validationState: "pending",
        validatedRevisionId: null,
      } satisfies ShipletDraft;
    },

    async updateDraft(input: {
      shipletId: string;
      draftId: string;
      expectedVersion: number;
      package: unknown;
      actor: ShipletActor;
    }) {
      assertActor(input.actor);
      await authorizeRevisionAction(kernelAuthorizer, {
        shipletId: input.shipletId,
        actor: input.actor,
        action: "revision.update_draft",
      });
      const packageSnapshot = assertShipletPackageAuthoritySafe(input.package);
      const current = await scopedDraft(db, input.shipletId, input.draftId);
      if (current.version !== input.expectedVersion) {
        draftConflict(current.version);
      }
      let packageJson: string;
      try {
        packageJson = await persistPackageJson(
          packageStore,
          revisionStorageKey(
            input.shipletId,
            "draft",
            input.draftId,
            `v${input.expectedVersion + 1}.json`,
          ),
          JSON.stringify(packageSnapshot),
        );
      } catch {
        lifecycleFailure("invalid_package");
      }
      const updatedOn = nowIso();
      const results = await db.batch([
        db
          .prepare(
            `UPDATE shiplet_drafts
						 SET package_json = ?, package_digest = NULL, version = version + 1,
						 validation_state = 'pending', validation_report_json = NULL,
						 validated_revision_id = NULL, updated_on = ?
						 WHERE id = ? AND project_id = ? AND version = ?`,
          )
          .bind(
            packageJson,
            updatedOn,
            input.draftId,
            input.shipletId,
            input.expectedVersion,
          ),
        auditStatement(db, {
          shipletId: input.shipletId,
          revisionId: current.base_revision_id,
          actor: input.actor,
          eventKind: "draft.updated",
          summary: "Draft package updated",
          statusCategory: "informational",
          payload: { draftId: input.draftId },
          conditionalOnPreviousChange: true,
        }),
      ]);
      if (results[0].meta.changes !== 1) {
        const latest = await scopedDraft(db, input.shipletId, input.draftId);
        draftConflict(latest.version);
      }
      return {
        ...draftView(current),
        version: input.expectedVersion + 1,
        validationState: "pending",
        validatedRevisionId: null,
      };
    },

    async validateDraft(input: {
      shipletId: string;
      draftId: string;
      expectedVersion: number;
      actor: ShipletActor;
    }): Promise<DraftValidationResult> {
      assertActor(input.actor);
      await authorizeRevisionAction(kernelAuthorizer, {
        shipletId: input.shipletId,
        actor: input.actor,
        action: "revision.validate_draft",
      });
      const draft = await scopedDraft(db, input.shipletId, input.draftId);
      if (draft.version !== input.expectedVersion) draftConflict(draft.version);
      if (
        draft.validation_state === "validated" &&
        draft.validated_revision_id
      ) {
        return {
          ok: true,
          draftVersion: draft.version,
          revisionId: draft.validated_revision_id,
          errors: [],
        };
      }

      let validatedPackage: ValidatedShipletPackage;
      try {
        validatedPackage = await parseShipletPackage(
          JSON.parse(await loadPackageJson(packageStore, draft.package_json)),
        );
      } catch (error) {
        if (!(error instanceof ShipletPackageError)) throw error;
        const errors = [
          { code: error.code, ...(error.path ? { path: error.path } : {}) },
        ];
        return recordValidationFailure(db, {
          ...input,
          draft,
          errors,
        });
      }
      try {
        const lineage = await canonicalPackageForParent(
          validatedPackage,
          draft.base_revision_id,
        );
        if (lineage.mismatch) {
          return recordValidationFailure(db, {
            ...input,
            draft,
            errors: [lineage.mismatch],
          });
        }
        validatedPackage = lineage.package;
      } catch (error) {
        if (!(error instanceof ShipletPackageError)) throw error;
        return recordValidationFailure(db, {
          ...input,
          draft,
          errors: [
            {
              code: error.code,
              ...(error.path ? { path: error.path } : {}),
            },
          ],
        });
      }

      const declaredErrors = declaredPackageValidationErrors(validatedPackage);
      if (declaredErrors.length > 0) {
        return recordValidationFailure(db, {
          ...input,
          draft,
          errors: declaredErrors,
        });
      }
      const serializedPackage = await serializeShipletPackage(validatedPackage);
      const digest = await digestShipletPackage(validatedPackage);
      const contentDigest = await digestShipletPackageContent(validatedPackage);
      let revision = await db
        .prepare(
          `SELECT * FROM shiplet_revisions
					 WHERE project_id = ? AND parent_revision_id = ?
					 AND package_digest = ?`,
        )
        .bind(input.shipletId, draft.base_revision_id, digest)
        .first<RevisionRow>();
      const candidateRevisionId = revision?.id ?? newId("revision");
      const strictMcpValidation = await strictMcpPackageValidationErrors(
        mcpManifestValidator,
        {
          shipletId: input.shipletId,
          revisionId: candidateRevisionId,
          package: validatedPackage,
        },
        validationTimeoutMs,
      );
      if (strictMcpValidation.errors.length > 0) {
        return recordValidationFailure(db, {
          ...input,
          draft,
          errors: strictMcpValidation.errors,
        });
      }
      const runnerErrors = await customPackageValidationErrors(
        validationRunner,
        {
          shipletId: input.shipletId,
          draftId: input.draftId,
          draftVersion: input.expectedVersion,
          package: validatedPackage,
        },
        validationTimeoutMs,
      );
      if (runnerErrors.length > 0) {
        return recordValidationFailure(db, {
          ...input,
          draft,
          errors: runnerErrors,
        });
      }
      if (validationRunner || strictMcpValidation.required) {
        const latest = await scopedDraft(db, input.shipletId, input.draftId);
        if (latest.version !== input.expectedVersion)
          draftConflict(latest.version);
      }

      const reportJson = JSON.stringify({ ok: true, errors: [] });
      if (!revision) {
        const revisionId = candidateRevisionId;
        const createdOn = nowIso();
        const packageJson = await persistPackageJson(
          packageStore,
          revisionStorageKey(
            input.shipletId,
            "revision",
            revisionId,
            "package.json",
          ),
          serializedPackage,
        );
        const storedFiles = await persistRevisionFiles(
          packageStore,
          input.shipletId,
          revisionId,
          validatedPackage,
        );
        const statements = revisionInsertStatements(db, {
          id: revisionId,
          shipletId: input.shipletId,
          parentRevisionId: draft.base_revision_id,
          package: validatedPackage,
          packageJson,
          digest,
          contentDigest,
          validationReportJson: reportJson,
          actor: input.actor,
          createdOn,
          storedFiles,
          draftGuard: {
            draftId: input.draftId,
            expectedVersion: input.expectedVersion,
          },
        });
        const draftUpdateIndex = statements.length;
        statements.push(
          db
            .prepare(
              `UPDATE shiplet_drafts SET package_digest = ?,
							 validation_state = 'validated', validation_report_json = ?,
							 validated_revision_id = ?, updated_on = ?
							 WHERE id = ? AND project_id = ? AND version = ?`,
            )
            .bind(
              digest,
              reportJson,
              revisionId,
              createdOn,
              input.draftId,
              input.shipletId,
              input.expectedVersion,
            ),
          auditStatement(db, {
            shipletId: input.shipletId,
            revisionId,
            actor: input.actor,
            eventKind: "revision.validated",
            summary: "Draft validated as immutable revision",
            statusCategory: "informational",
            payload: { draftId: input.draftId, packageDigest: digest },
            conditionalOnPreviousChange: true,
          }),
        );
        const results = await db.batch(statements);
        if (results[draftUpdateIndex].meta.changes !== 1) {
          const latest = await scopedDraft(db, input.shipletId, input.draftId);
          draftConflict(latest.version);
        }
        revision = {
          id: revisionId,
          project_id: input.shipletId,
          parent_revision_id: draft.base_revision_id,
          package_json: packageJson,
          package_digest: digest,
          content_digest: contentDigest,
          runtime_compatibility: validatedPackage.manifest.runtimeCompatibility,
          validation_report_json: reportJson,
          custom_mcp_projection_json: customMcpProjectionJson(validatedPackage),
          created_by_actor_kind: input.actor.kind,
          created_by_actor_id: input.actor.id,
          created_on: createdOn,
        };
      } else {
        const results = await db.batch([
          db
            .prepare(
              `UPDATE shiplet_drafts SET package_digest = ?,
							 validation_state = 'validated', validation_report_json = ?,
							 validated_revision_id = ?, updated_on = ?
							 WHERE id = ? AND project_id = ? AND version = ?`,
            )
            .bind(
              digest,
              reportJson,
              revision.id,
              nowIso(),
              input.draftId,
              input.shipletId,
              input.expectedVersion,
            ),
          auditStatement(db, {
            shipletId: input.shipletId,
            revisionId: revision.id,
            actor: input.actor,
            eventKind: "revision.validated",
            summary: "Draft validated as immutable revision",
            statusCategory: "informational",
            payload: { draftId: input.draftId, packageDigest: digest },
            conditionalOnPreviousChange: true,
          }),
        ]);
        if (results[0].meta.changes !== 1) {
          const latest = await scopedDraft(db, input.shipletId, input.draftId);
          draftConflict(latest.version);
        }
      }

      return {
        ok: true,
        draftVersion: draft.version,
        revisionId: revision.id,
        errors: [],
      };
    },

    async promoteDraft(input: {
      shipletId: string;
      draftId: string;
      expectedBaseRevisionId: string;
      targetId?: string;
      targetIds?: string[];
      idempotencyKey?: string;
      actor: ShipletActor;
    }) {
      assertActor(input.actor);
      await authorizeRevisionAction(kernelAuthorizer, {
        shipletId: input.shipletId,
        actor: input.actor,
        action: "revision.promote",
      });
      const draft = await scopedDraft(db, input.shipletId, input.draftId);
      if (
        draft.validation_state !== "validated" ||
        !draft.validated_revision_id
      ) {
        lifecycleFailure("draft_not_validated", { draftId: input.draftId });
      }
      const active = await projectActive(db, input.shipletId);
      if (
        draft.base_revision_id !== input.expectedBaseRevisionId ||
        active.active_revision_id !== input.expectedBaseRevisionId
      ) {
        lifecycleFailure("revision_conflict", {
          expectedRevisionId: input.expectedBaseRevisionId,
          currentRevisionId: active.active_revision_id,
        });
      }
      const candidateRevision = await scopedRevision(
        db,
        input.shipletId,
        draft.validated_revision_id,
      );
      const strictMcpValidation = await strictMcpPackageValidationErrors(
        mcpManifestValidator,
        {
          shipletId: input.shipletId,
          revisionId: candidateRevision.id,
          package: await parseShipletPackage(
            JSON.parse(
              await loadPackageJson(
                packageStore,
                candidateRevision.package_json,
              ),
            ),
          ),
        },
        validationTimeoutMs,
      );
      if (strictMcpValidation.errors.length > 0) {
        await recordValidationFailure(db, {
          shipletId: input.shipletId,
          draftId: input.draftId,
          expectedVersion: draft.version,
          actor: input.actor,
          draft,
          errors: strictMcpValidation.errors,
        });
        lifecycleFailure("draft_validation_failed", {
          errors: strictMcpValidation.errors,
        });
      }

      const attached = await attachedTargets(db, input.shipletId);
      const expectedTargetGeneration = active.deployment_target_generation;
      const suppliedTargetIds = [
        ...(input.targetIds ?? []),
        ...(input.targetId ? [input.targetId] : []),
      ].filter((targetId, index, values) => values.indexOf(targetId) === index);
      const missingTarget = attached.find(
        (target) => !suppliedTargetIds.includes(target.id),
      );
      if (missingTarget) {
        lifecycleFailure("deployment_target_required", {
          targetId: missingTarget.id,
        });
      }
      const unexpectedTarget = suppliedTargetIds.find(
        (targetId) => !attached.some((target) => target.id === targetId),
      );
      if (unexpectedTarget) {
        lifecycleFailure("deployment_target_not_found", {
          targetId: unexpectedTarget,
        });
      }

      const preparedTargets: PreparedTarget[] = [];
      try {
        for (const targetId of suppliedTargetIds) {
          const request: RevisionDeploymentRequest = {
            shipletId: input.shipletId,
            revisionId: draft.validated_revision_id,
            targetId,
            reason: "promotion",
          };
          const previousDeployment = await latestHealthyDeployment(
            db,
            targetId,
          );
          if (!previousDeployment) {
            lifecycleFailure("deployment_baseline_required", { targetId });
          }
          const prepared = await prepareDeployment(
            db,
            deploymentCoordinator,
            request,
            input.actor,
          );
          preparedTargets.push({
            request,
            prepared,
            previousDeployment,
          });
        }
      } catch (error) {
        await abandonPreparedTargets(deploymentCoordinator, preparedTargets);
        throw error;
      }
      const topologyAfterPreparation = await projectActive(db, input.shipletId);
      if (
        topologyAfterPreparation.deployment_target_generation !==
        expectedTargetGeneration
      ) {
        await abandonPreparedTargets(deploymentCoordinator, preparedTargets);
        lifecycleFailure("deployment_target_conflict");
      }
      let operationId: string;
      try {
        operationId = await reserveRevisionOperation(db, {
          shipletId: input.shipletId,
          expectedActiveRevisionId: input.expectedBaseRevisionId,
          expectedTargetGeneration,
          kind: "promotion",
          candidateRevisionId: draft.validated_revision_id,
          preparedTargets,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        await abandonPreparedTargets(deploymentCoordinator, preparedTargets);
        throw error;
      }

      let finalizedTargets: PreparedTarget[];
      try {
        finalizedTargets = await finalizePreparedTargets(
          deploymentCoordinator,
          preparedTargets,
        );
      } catch (error) {
        const failure =
          error instanceof ProviderFinalizationError
            ? error
            : new ProviderFinalizationError({
                cause: error,
                finalizedTargets: preparedTargets,
                ambiguousTargetIds: preparedTargets.map(
                  (target) => target.request.targetId,
                ),
                restorationOutcomes: await restorePreparedTargets(
                  deploymentCoordinator,
                  preparedTargets,
                ),
              });
        await abandonPreparedTargets(deploymentCoordinator, preparedTargets);
        await recordOperationCompensation(db, {
          operationId,
          shipletId: input.shipletId,
          revisionId: draft.validated_revision_id,
          actor: input.actor,
          reason: "promotion",
          preparedTargets,
          ambiguousTargetIds: failure.ambiguousTargetIds,
          restorationOutcomes: failure.restorationOutcomes,
        });
        lifecycleFailure("deployment_failed");
      }

      let usesFencedCommit = false;
      try {
        usesFencedCommit = await assertPreparedTargetCommitsAllowed(
          deploymentCoordinator,
          finalizedTargets,
        );
      } catch {
        await compensateFailedPreparedCommit(db, {
          coordinator: deploymentCoordinator,
          operationId,
          shipletId: input.shipletId,
          candidateRevisionId: draft.validated_revision_id,
          priorRevisionId: input.expectedBaseRevisionId,
          actor: input.actor,
          reason: "promotion",
          preparedTargets,
          finalizedTargets,
          localCommitApplied: false,
        });
        lifecycleFailure("deployment_failed");
      }

      const timestamp = nowIso();
      const statements = [
        db
          .prepare(
            usesFencedCommit
              ? `UPDATE projects SET active_revision_id = ?,
					 active_revision_generation = active_revision_generation + 1,
					 modified_on = ?
					 WHERE id = ? AND active_revision_id = ?
					 AND deployment_target_generation = ?
					 AND revision_operation_id = ?`
              : `UPDATE projects SET active_revision_id = ?,
					 active_revision_generation = active_revision_generation + 1,
					 modified_on = ?,
					 revision_operation_id = NULL
						 WHERE id = ? AND active_revision_id = ?
						 AND deployment_target_generation = ?
						 AND revision_operation_id = ?`,
          )
          .bind(
            draft.validated_revision_id,
            timestamp,
            input.shipletId,
            input.expectedBaseRevisionId,
            expectedTargetGeneration,
            operationId,
          ),
        activationStatement(db, {
          shipletId: input.shipletId,
          revisionId: draft.validated_revision_id,
          previousRevisionId: input.expectedBaseRevisionId,
          kind: "promotion",
        }),
      ];
      for (const target of preparedTargets) {
        statements.push(
          deploymentInsertStatement(db, {
            prepared: target.prepared,
            targetId: target.request.targetId,
            revisionId: draft.validated_revision_id,
            shipletId: input.shipletId,
            supersedesDeploymentId: target.previousDeployment?.id ?? null,
          }),
        );
      }
      if (usesFencedCommit) {
        statements.push(
          operationCommittingStatement(db, input.shipletId, operationId),
        );
      } else {
        statements.push(
          auditStatement(db, {
            shipletId: input.shipletId,
            revisionId: draft.validated_revision_id,
            deploymentId: preparedTargets[0]?.prepared.deploymentId,
            actor: input.actor,
            eventKind: "revision.promoted",
            summary: "Validated revision promoted",
            statusCategory: "informational",
            payload: {
              previousRevisionId: input.expectedBaseRevisionId,
              packageDigest: draft.package_digest,
              operationId,
              ...operationCorrelation(preparedTargets),
            },
            conditionalOnPreviousChange: true,
          }),
          operationCommitStatement(db, input.shipletId, operationId),
        );
      }
      let results: D1Result[];
      try {
        results = await db.batch(statements);
      } catch (error) {
        const restorationOutcomes = await restorePreparedTargets(
          deploymentCoordinator,
          finalizedTargets,
        );
        await abandonPreparedTargets(deploymentCoordinator, preparedTargets);
        await recordOperationCompensation(db, {
          operationId,
          shipletId: input.shipletId,
          revisionId: draft.validated_revision_id,
          actor: input.actor,
          reason: "promotion",
          preparedTargets,
          ambiguousTargetIds: [],
          restorationOutcomes,
        });
        throw error;
      }
      if (results[0].meta.changes !== 1) {
        const restorationOutcomes = await restorePreparedTargets(
          deploymentCoordinator,
          finalizedTargets,
        );
        await abandonPreparedTargets(deploymentCoordinator, preparedTargets);
        await recordOperationCompensation(db, {
          operationId,
          shipletId: input.shipletId,
          revisionId: draft.validated_revision_id,
          actor: input.actor,
          reason: "promotion",
          preparedTargets,
          ambiguousTargetIds: [],
          restorationOutcomes,
        });
        const current = await projectActive(db, input.shipletId);
        if (current.deployment_target_generation !== expectedTargetGeneration) {
          lifecycleFailure("deployment_target_conflict");
        }
        lifecycleFailure("revision_conflict", {
          expectedRevisionId: input.expectedBaseRevisionId,
          currentRevisionId: current.active_revision_id,
        });
      }
      if (usesFencedCommit) {
        try {
          await commitPreparedTargets(deploymentCoordinator, finalizedTargets);
          const committed = await db.batch([
            db
              .prepare(
                `UPDATE projects SET revision_operation_id = NULL
					 WHERE id = ? AND active_revision_id = ?
					 AND revision_operation_id = ?`,
              )
              .bind(input.shipletId, draft.validated_revision_id, operationId),
            operationCommitStatement(
              db,
              input.shipletId,
              operationId,
              "committing",
            ),
            auditStatement(db, {
              shipletId: input.shipletId,
              revisionId: draft.validated_revision_id,
              deploymentId: preparedTargets[0]?.prepared.deploymentId,
              actor: input.actor,
              eventKind: "revision.promoted",
              summary: "Validated revision promoted",
              statusCategory: "informational",
              payload: {
                previousRevisionId: input.expectedBaseRevisionId,
                packageDigest: draft.package_digest,
                operationId,
                ...operationCorrelation(preparedTargets),
              },
              conditionalOnPreviousChange: true,
            }),
          ]);
          if (
            committed[0]?.meta.changes !== 1 ||
            committed[1]?.meta.changes !== 1 ||
            committed[2]?.meta.changes !== 1
          ) {
            throw new Error("revision operation commit was not durable");
          }
        } catch {
          await compensateFailedPreparedCommit(db, {
            coordinator: deploymentCoordinator,
            operationId,
            shipletId: input.shipletId,
            candidateRevisionId: draft.validated_revision_id,
            priorRevisionId: input.expectedBaseRevisionId,
            actor: input.actor,
            reason: "promotion",
            preparedTargets,
            finalizedTargets,
            localCommitApplied: true,
          });
          lifecycleFailure("deployment_failed");
        }
      }
      return {
        operationId,
        operationStatus: "committed" as const,
        revisionId: draft.validated_revision_id,
        previousRevisionId: input.expectedBaseRevisionId,
        deploymentId: preparedTargets[0]?.prepared.deploymentId ?? null,
        deploymentIds: preparedTargets.map(
          (target) => target.prepared.deploymentId,
        ),
      };
    },

    async rollbackRevision(input: {
      shipletId: string;
      revisionId: string;
      expectedActiveRevisionId: string;
      targetId?: string;
      targetIds?: string[];
      idempotencyKey?: string;
      actor: ShipletActor;
    }) {
      assertActor(input.actor);
      await authorizeRevisionAction(kernelAuthorizer, {
        shipletId: input.shipletId,
        actor: input.actor,
        action: "revision.rollback",
      });
      await scopedRevision(db, input.shipletId, input.revisionId);
      if (!(await isKnownGoodRevision(db, input.shipletId, input.revisionId))) {
        lifecycleFailure("revision_not_known_good", {
          revisionId: input.revisionId,
        });
      }
      const active = await projectActive(db, input.shipletId);
      if (active.active_revision_id !== input.expectedActiveRevisionId) {
        lifecycleFailure("revision_conflict", {
          expectedRevisionId: input.expectedActiveRevisionId,
          currentRevisionId: active.active_revision_id,
        });
      }
      const attached = await attachedTargets(db, input.shipletId);
      const expectedTargetGeneration = active.deployment_target_generation;
      const suppliedTargetIds = [
        ...(input.targetIds ?? []),
        ...(input.targetId ? [input.targetId] : []),
      ].filter((targetId, index, values) => values.indexOf(targetId) === index);
      const missingTarget = attached.find(
        (target) => !suppliedTargetIds.includes(target.id),
      );
      if (missingTarget) {
        lifecycleFailure("deployment_target_required", {
          targetId: missingTarget.id,
        });
      }
      const unexpectedTarget = suppliedTargetIds.find(
        (targetId) => !attached.some((target) => target.id === targetId),
      );
      if (unexpectedTarget) {
        lifecycleFailure("deployment_target_not_found", {
          targetId: unexpectedTarget,
        });
      }

      const preparedTargets: PreparedTarget[] = [];
      try {
        for (const targetId of suppliedTargetIds) {
          const request: RevisionDeploymentRequest = {
            shipletId: input.shipletId,
            revisionId: input.revisionId,
            targetId,
            reason: "rollback",
          };
          const previousDeployment = await latestHealthyDeployment(
            db,
            targetId,
          );
          if (!previousDeployment) {
            lifecycleFailure("deployment_baseline_required", { targetId });
          }
          const prepared = await prepareDeployment(
            db,
            deploymentCoordinator,
            request,
            input.actor,
          );
          preparedTargets.push({
            request,
            prepared,
            previousDeployment,
          });
        }
      } catch (error) {
        await abandonPreparedTargets(deploymentCoordinator, preparedTargets);
        throw error;
      }
      const topologyAfterPreparation = await projectActive(db, input.shipletId);
      if (
        topologyAfterPreparation.deployment_target_generation !==
        expectedTargetGeneration
      ) {
        await abandonPreparedTargets(deploymentCoordinator, preparedTargets);
        lifecycleFailure("deployment_target_conflict");
      }
      let operationId: string;
      try {
        operationId = await reserveRevisionOperation(db, {
          shipletId: input.shipletId,
          expectedActiveRevisionId: input.expectedActiveRevisionId,
          expectedTargetGeneration,
          kind: "rollback",
          candidateRevisionId: input.revisionId,
          preparedTargets,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        await abandonPreparedTargets(deploymentCoordinator, preparedTargets);
        throw error;
      }

      let finalizedTargets: PreparedTarget[];
      try {
        finalizedTargets = await finalizePreparedTargets(
          deploymentCoordinator,
          preparedTargets,
        );
      } catch (error) {
        const failure =
          error instanceof ProviderFinalizationError
            ? error
            : new ProviderFinalizationError({
                cause: error,
                finalizedTargets: preparedTargets,
                ambiguousTargetIds: preparedTargets.map(
                  (target) => target.request.targetId,
                ),
                restorationOutcomes: await restorePreparedTargets(
                  deploymentCoordinator,
                  preparedTargets,
                ),
              });
        await abandonPreparedTargets(deploymentCoordinator, preparedTargets);
        await recordOperationCompensation(db, {
          operationId,
          shipletId: input.shipletId,
          revisionId: input.revisionId,
          actor: input.actor,
          reason: "rollback",
          preparedTargets,
          ambiguousTargetIds: failure.ambiguousTargetIds,
          restorationOutcomes: failure.restorationOutcomes,
        });
        lifecycleFailure("deployment_failed");
      }

      let usesFencedCommit = false;
      try {
        usesFencedCommit = await assertPreparedTargetCommitsAllowed(
          deploymentCoordinator,
          finalizedTargets,
        );
      } catch {
        await compensateFailedPreparedCommit(db, {
          coordinator: deploymentCoordinator,
          operationId,
          shipletId: input.shipletId,
          candidateRevisionId: input.revisionId,
          priorRevisionId: input.expectedActiveRevisionId,
          actor: input.actor,
          reason: "rollback",
          preparedTargets,
          finalizedTargets,
          localCommitApplied: false,
        });
        lifecycleFailure("deployment_failed");
      }

      const statements = [
        db
          .prepare(
            usesFencedCommit
              ? `UPDATE projects SET active_revision_id = ?,
					 active_revision_generation = active_revision_generation + 1,
					 modified_on = ?
					 WHERE id = ? AND active_revision_id = ?
					 AND deployment_target_generation = ?
					 AND revision_operation_id = ?`
              : `UPDATE projects SET active_revision_id = ?,
					 active_revision_generation = active_revision_generation + 1,
					 modified_on = ?,
					 revision_operation_id = NULL
						 WHERE id = ? AND active_revision_id = ?
						 AND deployment_target_generation = ?
						 AND revision_operation_id = ?`,
          )
          .bind(
            input.revisionId,
            nowIso(),
            input.shipletId,
            input.expectedActiveRevisionId,
            expectedTargetGeneration,
            operationId,
          ),
        activationStatement(db, {
          shipletId: input.shipletId,
          revisionId: input.revisionId,
          previousRevisionId: input.expectedActiveRevisionId,
          kind: "rollback",
        }),
      ];
      for (const target of preparedTargets) {
        statements.push(
          deploymentInsertStatement(db, {
            prepared: target.prepared,
            targetId: target.request.targetId,
            revisionId: input.revisionId,
            shipletId: input.shipletId,
            supersedesDeploymentId: target.previousDeployment?.id ?? null,
          }),
        );
      }
      if (usesFencedCommit) {
        statements.push(
          operationCommittingStatement(db, input.shipletId, operationId),
        );
      } else {
        statements.push(
          auditStatement(db, {
            shipletId: input.shipletId,
            revisionId: input.revisionId,
            deploymentId: preparedTargets[0]?.prepared.deploymentId,
            actor: input.actor,
            eventKind: "revision.rolled_back",
            summary: "Known-good revision restored",
            statusCategory: "informational",
            payload: {
              previousRevisionId: input.expectedActiveRevisionId,
              operationId,
              ...operationCorrelation(preparedTargets),
            },
            conditionalOnPreviousChange: true,
          }),
          operationCommitStatement(db, input.shipletId, operationId),
        );
      }
      let results: D1Result[];
      try {
        results = await db.batch(statements);
      } catch (error) {
        const restorationOutcomes = await restorePreparedTargets(
          deploymentCoordinator,
          finalizedTargets,
        );
        await abandonPreparedTargets(deploymentCoordinator, preparedTargets);
        await recordOperationCompensation(db, {
          operationId,
          shipletId: input.shipletId,
          revisionId: input.revisionId,
          actor: input.actor,
          reason: "rollback",
          preparedTargets,
          ambiguousTargetIds: [],
          restorationOutcomes,
        });
        throw error;
      }
      if (results[0].meta.changes !== 1) {
        const restorationOutcomes = await restorePreparedTargets(
          deploymentCoordinator,
          finalizedTargets,
        );
        await abandonPreparedTargets(deploymentCoordinator, preparedTargets);
        await recordOperationCompensation(db, {
          operationId,
          shipletId: input.shipletId,
          revisionId: input.revisionId,
          actor: input.actor,
          reason: "rollback",
          preparedTargets,
          ambiguousTargetIds: [],
          restorationOutcomes,
        });
        const current = await projectActive(db, input.shipletId);
        if (current.deployment_target_generation !== expectedTargetGeneration) {
          lifecycleFailure("deployment_target_conflict");
        }
        lifecycleFailure("revision_conflict", {
          expectedRevisionId: input.expectedActiveRevisionId,
          currentRevisionId: current.active_revision_id,
        });
      }
      if (usesFencedCommit) {
        try {
          await commitPreparedTargets(deploymentCoordinator, finalizedTargets);
          const committed = await db.batch([
            db
              .prepare(
                `UPDATE projects SET revision_operation_id = NULL
					 WHERE id = ? AND active_revision_id = ?
					 AND revision_operation_id = ?`,
              )
              .bind(input.shipletId, input.revisionId, operationId),
            operationCommitStatement(
              db,
              input.shipletId,
              operationId,
              "committing",
            ),
            auditStatement(db, {
              shipletId: input.shipletId,
              revisionId: input.revisionId,
              deploymentId: preparedTargets[0]?.prepared.deploymentId,
              actor: input.actor,
              eventKind: "revision.rolled_back",
              summary: "Known-good revision restored",
              statusCategory: "informational",
              payload: {
                previousRevisionId: input.expectedActiveRevisionId,
                operationId,
                ...operationCorrelation(preparedTargets),
              },
              conditionalOnPreviousChange: true,
            }),
          ]);
          if (
            committed[0]?.meta.changes !== 1 ||
            committed[1]?.meta.changes !== 1 ||
            committed[2]?.meta.changes !== 1
          ) {
            throw new Error("revision operation commit was not durable");
          }
        } catch {
          await compensateFailedPreparedCommit(db, {
            coordinator: deploymentCoordinator,
            operationId,
            shipletId: input.shipletId,
            candidateRevisionId: input.revisionId,
            priorRevisionId: input.expectedActiveRevisionId,
            actor: input.actor,
            reason: "rollback",
            preparedTargets,
            finalizedTargets,
            localCommitApplied: true,
          });
          lifecycleFailure("deployment_failed");
        }
      }
      return {
        operationId,
        operationStatus: "committed" as const,
        activeRevisionId: input.revisionId,
        previousRevisionId: input.expectedActiveRevisionId,
        deploymentId: preparedTargets[0]?.prepared.deploymentId ?? null,
        deploymentIds: preparedTargets.map(
          (target) => target.prepared.deploymentId,
        ),
      };
    },

    async recoverRevisionOperation(input: {
      shipletId: string;
      operationId: string;
      actor: ShipletActor;
    }) {
      assertActor(input.actor);
      await authorizeRevisionAction(kernelAuthorizer, {
        shipletId: input.shipletId,
        actor: input.actor,
        action: "revision.recover_operation",
      });
      let operation = await scopedRevisionOperation(
        db,
        input.shipletId,
        input.operationId,
      );
      if (
        operation.status === "compensated" ||
        operation.status === "committed"
      ) {
        return { operationId: operation.id, status: operation.status };
      }
      const timestamp = nowIso();
      const lease = leaseExpiryIso();
      const acquired = await db
        .prepare(
          `UPDATE shiplet_revision_operations
					 SET status = 'restoring', lease_expires_on = ?, updated_on = ?
					 WHERE id = ? AND project_id = ? AND (
						status = 'reconciliation_required' OR (
						 status IN ('restoring', 'activating')
						 AND lease_expires_on IS NOT NULL AND lease_expires_on <= ?
						)
					 )`,
        )
        .bind(lease, timestamp, input.operationId, input.shipletId, timestamp)
        .run();
      if (acquired.meta.changes !== 1) {
        operation = await scopedRevisionOperation(
          db,
          input.shipletId,
          input.operationId,
        );
        if (
          operation.status === "compensated" ||
          operation.status === "committed"
        ) {
          return { operationId: operation.id, status: operation.status };
        }
        lifecycleFailure("revision_operation_in_progress", {
          operationId: operation.id,
        });
      }

      const preparedTargets = await operationPreparedTargets(db, operation);
      let reconciliation: {
        ambiguousTargetIds?: string[];
        reconciliationRequiredTargetIds?: string[];
      } = {};
      try {
        reconciliation = JSON.parse(
          operation.reconciliation_json,
        ) as typeof reconciliation;
      } catch {
        lifecycleFailure("revision_operation_corrupt", {
          operationId: operation.id,
        });
      }
      const requiredTargetIds = new Set(
        reconciliation.reconciliationRequiredTargetIds?.length
          ? reconciliation.reconciliationRequiredTargetIds
          : preparedTargets.map((target) => target.request.targetId),
      );
      const targetsToRestore = preparedTargets.filter((target) =>
        requiredTargetIds.has(target.request.targetId),
      );
      const restorationOutcomes = await restorePreparedTargets(
        deploymentCoordinator,
        targetsToRestore,
      );
      const failedTargetIds = preparedTargets
        .map((target) => target.request.targetId)
        .filter((targetId) =>
          restorationOutcomes.some(
            (outcome) =>
              outcome.targetId === targetId && outcome.status === "failed",
          ),
        );
      const restoredTargetIds = preparedTargets
        .map((target) => target.request.targetId)
        .filter((targetId) =>
          restorationOutcomes.some(
            (outcome) =>
              outcome.targetId === targetId && outcome.status === "restored",
          ),
        );
      const nextReconciliation = {
        ambiguousTargetIds: reconciliation.ambiguousTargetIds ?? [],
        restoredTargetIds,
        reconciliationRequiredTargetIds: failedTargetIds,
        restorationOutcomes,
      };
      if (failedTargetIds.length > 0) {
        await db.batch([
          db
            .prepare(
              `UPDATE shiplet_revision_operations
							 SET status = 'reconciliation_required', reconciliation_json = ?,
							 lease_expires_on = NULL, last_error_code = 'provider_restore_failed',
							 updated_on = ? WHERE id = ? AND project_id = ?
							 AND status = 'restoring'`,
            )
            .bind(
              JSON.stringify(nextReconciliation),
              nowIso(),
              operation.id,
              input.shipletId,
            ),
          auditStatement(db, {
            shipletId: input.shipletId,
            revisionId: operation.candidate_revision_id,
            actor: input.actor,
            eventKind: "revision.operation_recovery_failed",
            summary: "Revision operation recovery requires reconciliation",
            statusCategory: "blocked",
            payload: {
              operationId: operation.id,
              ...operationCorrelation(preparedTargets),
              ...nextReconciliation,
            },
          }),
        ]);
        lifecycleFailure("provider_restore_failed", {
          operationId: operation.id,
        });
      }

      await db.batch([
        db
          .prepare(
            `UPDATE shiplet_revision_operations
						 SET status = 'compensated', reconciliation_json = ?,
						 lease_expires_on = NULL, last_error_code = NULL, updated_on = ?
						 WHERE id = ? AND project_id = ? AND status = 'restoring'`,
          )
          .bind(
            JSON.stringify(nextReconciliation),
            nowIso(),
            operation.id,
            input.shipletId,
          ),
        db
          .prepare(
            `UPDATE projects SET revision_operation_id = NULL
						 WHERE id = ? AND revision_operation_id = ?`,
          )
          .bind(input.shipletId, operation.id),
        auditStatement(db, {
          shipletId: input.shipletId,
          revisionId: operation.candidate_revision_id,
          actor: input.actor,
          eventKind: "revision.operation_recovered",
          summary: "Revision operation provider state restored",
          statusCategory: "informational",
          payload: {
            operationId: operation.id,
            ...operationCorrelation(preparedTargets),
            ...nextReconciliation,
          },
        }),
      ]);
      return { operationId: operation.id, status: "compensated" as const };
    },

    async getActiveRevision(input: { shipletId: string; actor: ShipletActor }) {
      assertActor(input.actor);
      await authorizeRevisionAction(kernelAuthorizer, {
        shipletId: input.shipletId,
        actor: input.actor,
        action: "revision.read",
      });
      const project = await projectActive(db, input.shipletId);
      if (!project.active_revision_id) {
        lifecycleFailure("active_revision_not_found", {
          shipletId: input.shipletId,
        });
      }
      return revisionView(
        await scopedRevision(db, input.shipletId, project.active_revision_id),
        packageStore,
      );
    },

    async getRevision(input: {
      shipletId: string;
      revisionId: string;
      actor: ShipletActor;
    }) {
      assertActor(input.actor);
      await authorizeRevisionAction(kernelAuthorizer, {
        shipletId: input.shipletId,
        actor: input.actor,
        action: "revision.read",
      });
      return revisionView(
        await scopedRevision(db, input.shipletId, input.revisionId),
        packageStore,
      );
    },

    async exportDraftPackage(input: {
      shipletId: string;
      draftId: string;
      actor: ShipletActor;
    }) {
      assertActor(input.actor);
      await authorizeRevisionAction(kernelAuthorizer, {
        shipletId: input.shipletId,
        actor: input.actor,
        action: "draft.read",
      });
      const draft = await scopedDraft(db, input.shipletId, input.draftId);
      return serializeShipletPackage(
        JSON.parse(await loadPackageJson(packageStore, draft.package_json)),
      );
    },

    async exportRevisionPackage(input: {
      shipletId: string;
      revisionId: string;
      actor: ShipletActor;
    }) {
      assertActor(input.actor);
      await authorizeRevisionAction(kernelAuthorizer, {
        shipletId: input.shipletId,
        actor: input.actor,
        action: "package.export",
      });
      const revision = await scopedRevision(
        db,
        input.shipletId,
        input.revisionId,
      );
      return serializeShipletPackage(
        JSON.parse(await loadPackageJson(packageStore, revision.package_json)),
      );
    },
  };
}
