import type {
  CloudflareDeploymentTarget,
  DeploymentRepository,
  DeploymentTargetResource,
  KernelDeploymentResource,
  ShipletDeploymentRecord,
  TargetMutationOperation,
} from "./deployment-orchestrator";

type TargetRow = {
  id: string;
  project_id: string;
  kind: string;
  owner_kind: string;
  owner_id: string;
  connection_id: string | null;
  provider_account_id: string | null;
  configuration_json: string;
};

type ResourceRow = {
  id: string;
  project_id: string;
  target_id: string;
  name: string;
  kind: KernelDeploymentResource["kind"];
  provider_resource_id: string | null;
  value: string | null;
  visibility: "public" | "private";
};

type DeploymentRow = {
  id: string;
  target_id: string;
  revision_id: string;
  provider_version_id: string;
  provider_deployment_id: string | null;
  status: string;
  supersedes_deployment_id: string | null;
  deployed_on: string | null;
  deployed_at_ms: number | null;
  failure_reason: string | null;
};

type JournalRow = {
  id: string;
  project_id: string;
  target_id: string;
  expected_known_good_deployment_id: string | null;
  idempotency_key: string;
  operation: TargetMutationOperation;
  revision_id: string;
  intent_digest: string;
  status: string;
  result_deployment_id: string | null;
  public_result_json: string | null;
  failure_reason: string | null;
};

type TargetConfiguration = {
  scriptName: string;
  status: "connected" | "revoked" | "claimed";
  resourceBindingRefs: string[];
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function validId(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function parseConfiguration(value: string): TargetConfiguration | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const scriptName = parsed.scriptName;
    const status = parsed.status ?? "connected";
    const refs = parsed.resourceBindingRefs ?? [];
    if (
      !validId(scriptName) ||
      (status !== "connected" &&
        status !== "revoked" &&
        status !== "claimed") ||
      !Array.isArray(refs) ||
      refs.length > 64 ||
      refs.some((ref) => !validId(ref)) ||
      new Set(refs).size !== refs.length
    ) {
      return null;
    }
    return { scriptName, status, resourceBindingRefs: [...refs] as string[] };
  } catch {
    return null;
  }
}

function publicResource(row: ResourceRow): KernelDeploymentResource {
  return Object.freeze({
    id: row.id,
    shipletId: row.project_id,
    targetId: row.target_id,
    name: row.name,
    kind: row.kind,
    ...(row.provider_resource_id
      ? { providerResourceId: row.provider_resource_id }
      : {}),
    ...(row.value !== null ? { value: row.value } : {}),
    visibility: row.visibility,
  });
}

function publicTargetResource(row: ResourceRow): DeploymentTargetResource {
  return Object.freeze({
    name: row.name,
    kind: row.kind,
    ...(row.provider_resource_id
      ? { providerResourceId: row.provider_resource_id }
      : {}),
    ...(row.value !== null ? { value: row.value } : {}),
    ownerShipletId: row.project_id,
    ownerTargetId: row.target_id,
  });
}

function publicDeployment(row: DeploymentRow): ShipletDeploymentRecord {
  return Object.freeze({
    id: row.id,
    targetId: row.target_id,
    revisionId: row.revision_id,
    providerVersionId: row.provider_version_id,
    providerDeploymentId: row.provider_deployment_id || "provider_unavailable",
    status: row.status === "healthy" ? "known_good" : "failed",
    supersedesDeploymentId: row.supersedes_deployment_id,
    ...(row.deployed_at_ms !== null
      ? { deployedAt: row.deployed_at_ms }
      : row.deployed_on
        ? { deployedAt: new Date(row.deployed_on).getTime() }
        : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
  });
}

function publicJournal(row: JournalRow) {
  return Object.freeze({
    id: row.id,
    shipletId: row.project_id,
    targetId: row.target_id,
    expectedKnownGoodDeploymentId: row.expected_known_good_deployment_id,
    idempotencyKey: row.idempotency_key,
    operation: row.operation,
    revisionId: row.revision_id,
    intentDigest: row.intent_digest,
    status: row.status,
    ...(row.result_deployment_id
      ? { resultDeploymentId: row.result_deployment_id }
      : {}),
    ...(row.public_result_json
      ? {
          publicResult: JSON.parse(row.public_result_json) as Record<
            string,
            unknown
          >,
        }
      : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
  });
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

export async function ensureD1DeploymentRepositorySchema(db: D1Database) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS deployment_target_resources (
			 id TEXT PRIMARY KEY,
			 project_id TEXT NOT NULL,
			 target_id TEXT NOT NULL,
			 name TEXT NOT NULL,
			 kind TEXT NOT NULL,
			 provider_resource_id TEXT,
			 value TEXT,
			 visibility TEXT NOT NULL,
			 UNIQUE (target_id, name),
			 FOREIGN KEY (project_id) REFERENCES projects(id),
			 FOREIGN KEY (target_id) REFERENCES deployment_targets(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS deployment_operation_journals (
			 id TEXT PRIMARY KEY,
			 project_id TEXT NOT NULL,
			 target_id TEXT NOT NULL,
			 expected_known_good_deployment_id TEXT,
			 idempotency_key TEXT NOT NULL,
			 operation TEXT NOT NULL,
			 revision_id TEXT NOT NULL,
			 intent_digest TEXT NOT NULL,
			 status TEXT NOT NULL,
			 result_deployment_id TEXT,
			 public_result_json TEXT,
			 failure_reason TEXT,
			 created_at_ms INTEGER NOT NULL,
			 updated_at_ms INTEGER NOT NULL,
			 UNIQUE (project_id, target_id, idempotency_key),
			 FOREIGN KEY (project_id) REFERENCES projects(id),
			 FOREIGN KEY (target_id) REFERENCES deployment_targets(id),
			 FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS deployment_temporary_claims (
			 target_id TEXT PRIMARY KEY,
			 shiplet_id TEXT NOT NULL,
			 revision_id TEXT,
			 status TEXT NOT NULL,
			 vault_ref TEXT NOT NULL,
			 expires_at_ms INTEGER NOT NULL,
			 payload_json TEXT NOT NULL,
			 delivery_event_id TEXT,
			 delivered_actor_id TEXT,
			 delivered_on TEXT,
			 updated_at_ms INTEGER NOT NULL
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS deployment_failure_events (
			 id TEXT PRIMARY KEY,
			 project_id TEXT,
			 target_id TEXT,
			 event_json TEXT NOT NULL,
			 recorded_at_ms INTEGER NOT NULL
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS deployment_effect_outbox (
			 id TEXT PRIMARY KEY,
			 journal_id TEXT NOT NULL UNIQUE,
			 project_id TEXT NOT NULL,
			 target_id TEXT NOT NULL,
			 event_kind TEXT NOT NULL,
			 event_json TEXT NOT NULL,
			 recorded_at_ms INTEGER NOT NULL,
			 FOREIGN KEY (journal_id) REFERENCES deployment_operation_journals(id),
			 FOREIGN KEY (project_id) REFERENCES projects(id),
			 FOREIGN KEY (target_id) REFERENCES deployment_targets(id)
			)`,
    ),
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_journal_active_target
			 ON deployment_operation_journals(target_id)
			 WHERE status = 'reserved'`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS guard_unresolved_deployment_target_insert_v1
			 BEFORE INSERT ON deployment_operation_journals
			 WHEN NEW.status IN ('reserved', 'reconcile_required')
			  AND EXISTS (
			   SELECT 1 FROM deployment_operation_journals existing
			   WHERE existing.target_id = NEW.target_id
			    AND existing.status IN ('reserved', 'reconcile_required')
			  )
			 BEGIN
			  SELECT RAISE(IGNORE);
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS guard_unresolved_deployment_target_update_v1
			 BEFORE UPDATE OF status, target_id ON deployment_operation_journals
			 WHEN NEW.status IN ('reserved', 'reconcile_required')
			  AND EXISTS (
			   SELECT 1 FROM deployment_operation_journals existing
			   WHERE existing.target_id = NEW.target_id
			    AND existing.id <> NEW.id
			    AND existing.status IN ('reserved', 'reconcile_required')
			  )
			 BEGIN
			  SELECT RAISE(ABORT, 'deployment_target_reconciliation_required');
			 END`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_deployment_resources_scope
			 ON deployment_target_resources(project_id, target_id, id)`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS deployment_effect_outbox_no_update_v1
			 BEFORE UPDATE ON deployment_effect_outbox
			 BEGIN SELECT RAISE(ABORT, 'deployment effect outbox is immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS deployment_effect_outbox_no_delete_v1
			 BEFORE DELETE ON deployment_effect_outbox
			 BEGIN SELECT RAISE(ABORT, 'deployment effect outbox is immutable'); END`,
    ),
  ]);
  await addColumnIfMissing(
    db,
    "shiplet_deployments",
    "provider_deployment_id",
    "provider_deployment_id TEXT",
  );
  await addColumnIfMissing(
    db,
    "shiplet_deployments",
    "deployed_at_ms",
    "deployed_at_ms INTEGER",
  );
  await addColumnIfMissing(
    db,
    "shiplet_deployments",
    "failure_reason",
    "failure_reason TEXT",
  );
  await addColumnIfMissing(
    db,
    "deployment_temporary_claims",
    "revision_id",
    "revision_id TEXT",
  );
  await addColumnIfMissing(
    db,
    "deployment_temporary_claims",
    "delivery_event_id",
    "delivery_event_id TEXT",
  );
  await addColumnIfMissing(
    db,
    "deployment_temporary_claims",
    "delivered_actor_id",
    "delivered_actor_id TEXT",
  );
  await addColumnIfMissing(
    db,
    "deployment_temporary_claims",
    "delivered_on",
    "delivered_on TEXT",
  );
  await db
    .prepare(
      `CREATE TRIGGER IF NOT EXISTS audit_temporary_claim_delivery_v1
			 AFTER UPDATE OF status ON deployment_temporary_claims
			 WHEN OLD.status = 'awaiting_claim' AND NEW.status = 'delivered'
			 BEGIN
				INSERT INTO shiplet_audit_events (
				 id, project_id, revision_id, deployment_id, actor_kind, actor_id,
				 event_kind, summary, status_category, payload_json,
				 occurred_on, recorded_on
				) VALUES (
				 NEW.delivery_event_id, NEW.shiplet_id, NEW.revision_id, NULL,
				 'human', NEW.delivered_actor_id,
				 'cloudflare.temporary_claim.delivered',
				 'Temporary Cloudflare claim handoff delivered',
				 'informational', json_object('targetId', NEW.target_id),
				 NEW.delivered_on, NEW.delivered_on
				);
			 END`,
    )
    .run();
}

export function createD1DeploymentRepository(input: {
  db: D1Database;
  now: () => number;
}): DeploymentRepository {
  const { db } = input;
  const now = () => {
    const value = input.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Deployment repository clock unavailable");
    }
    return value;
  };
  const effectOutboxStatement = (
    journal: JournalRow,
    effectEvent: Record<string, unknown>,
  ) => {
    const serialized = JSON.stringify(effectEvent);
    if (
      !validId(effectEvent.eventId) ||
      !validId(effectEvent.eventKind) ||
      effectEvent.shipletId !== journal.project_id ||
      effectEvent.targetId !== journal.target_id ||
      effectEvent.revisionId !== journal.revision_id ||
      effectEvent.actorKind !== "human" ||
      !validId(effectEvent.actorId) ||
      !Number.isSafeInteger(effectEvent.occurredAt) ||
      Number(effectEvent.occurredAt) < 0 ||
      new TextEncoder().encode(serialized).byteLength > 16_384
    ) {
      throw new TypeError("Invalid deployment effect event");
    }
    return db
      .prepare(
        `INSERT INTO deployment_effect_outbox (
				 id, journal_id, project_id, target_id, event_kind, event_json,
				 recorded_at_ms
				) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      )
      .bind(
        effectEvent.eventId,
        journal.id,
        journal.project_id,
        journal.target_id,
        effectEvent.eventKind,
        serialized,
        now(),
      );
  };

  const getTargetScoped = async (scope: {
    shipletId: string;
    targetId: string;
  }): Promise<CloudflareDeploymentTarget | null> => {
    if (!validId(scope.shipletId) || !validId(scope.targetId)) return null;
    const row = await db
      .prepare(
        `SELECT id, project_id, kind, owner_kind, owner_id, connection_id,
				 provider_account_id, configuration_json
				 FROM deployment_targets
				 WHERE id = ? AND project_id = ? AND detached_on IS NULL LIMIT 1`,
      )
      .bind(scope.targetId, scope.shipletId)
      .first<TargetRow>();
    if (
      !row ||
      (row.kind !== "customer_cloudflare" && row.kind !== "temporary_claim") ||
      row.owner_kind !== "human" ||
      !validId(row.owner_id) ||
      !validId(row.provider_account_id)
    ) {
      return null;
    }
    const configuration = parseConfiguration(row.configuration_json);
    if (!configuration) return null;
    const resourceBindings = await Promise.all(
      configuration.resourceBindingRefs.map(async (resourceId) => {
        const resource = await db
          .prepare(
            `SELECT * FROM deployment_target_resources
						 WHERE id = ? AND project_id = ? AND target_id = ? LIMIT 1`,
          )
          .bind(resourceId, row.project_id, row.id)
          .first<ResourceRow>();
        return resource ? publicTargetResource(resource) : null;
      }),
    );
    if (resourceBindings.some((resource) => resource === null)) return null;
    return Object.freeze({
      id: row.id,
      shipletId: row.project_id,
      kind: row.kind,
      ownerUserId: row.owner_id,
      connectionId: row.connection_id,
      providerAccountId: row.provider_account_id,
      providerScriptName: configuration.scriptName,
      status: configuration.status,
      resourceBindingRefs: [...configuration.resourceBindingRefs],
      resourceBindings: resourceBindings.filter(
        (resource): resource is DeploymentTargetResource => resource !== null,
      ),
    });
  };

  const getDeployment = async (
    where: string,
    bindings: unknown[],
  ): Promise<ShipletDeploymentRecord | null> => {
    const row = await db
      .prepare(
        `SELECT deployment.id, deployment.target_id, deployment.revision_id,
				 deployment.provider_version_id, deployment.provider_deployment_id,
				 deployment.status, deployment.supersedes_deployment_id,
				 deployment.deployed_on, deployment.deployed_at_ms,
				 deployment.failure_reason
				 FROM shiplet_deployments deployment
				 JOIN deployment_targets target ON target.id = deployment.target_id
				 WHERE ${where} LIMIT 1`,
      )
      .bind(...bindings)
      .first<DeploymentRow>();
    return row ? publicDeployment(row) : null;
  };

  const repository: DeploymentRepository = {
    getTargetScoped,

    getKnownGood(targetId) {
      return getDeployment(
        "deployment.target_id = ? AND deployment.status = 'healthy' ORDER BY deployment.deployed_on DESC, deployment.rowid DESC",
        [targetId],
      );
    },

    async getDeploymentScoped(scope) {
      return getDeployment(
        `target.project_id = ? AND deployment.target_id = ?
				 AND deployment.id = ?`,
        [scope.shipletId, scope.targetId, scope.deploymentId],
      );
    },

    async resolveRevisionPackageDigest(scope) {
      if (!validId(scope.shipletId) || !validId(scope.revisionId)) return null;
      const row = await db
        .prepare(
          `SELECT package_digest FROM shiplet_revisions
					 WHERE id = ? AND project_id = ? LIMIT 1`,
        )
        .bind(scope.revisionId, scope.shipletId)
        .first<{ package_digest: string }>();
      return row && /^[a-f0-9]{64}$/.test(row.package_digest)
        ? `sha256:${row.package_digest}`
        : null;
    },

    async resolveTargetResources(scope) {
      if (
        !validId(scope.shipletId) ||
        !validId(scope.targetId) ||
        !Array.isArray(scope.resourceRefs) ||
        scope.resourceRefs.length > 64 ||
        new Set(scope.resourceRefs).size !== scope.resourceRefs.length
      ) {
        return null;
      }
      const resources: KernelDeploymentResource[] = [];
      for (const ref of scope.resourceRefs) {
        if (!validId(ref)) return null;
        const row = await db
          .prepare(
            `SELECT * FROM deployment_target_resources
						 WHERE id = ? AND project_id = ? AND target_id = ? LIMIT 1`,
          )
          .bind(ref, scope.shipletId, scope.targetId)
          .first<ResourceRow>();
        if (!row) return null;
        resources.push(publicResource(row));
      }
      return resources;
    },

    async reserveTargetOperation(reservation) {
      if (
        !validId(reservation.shipletId) ||
        !validId(reservation.targetId) ||
        !validId(reservation.idempotencyKey) ||
        !validId(reservation.revisionId) ||
        !DIGEST.test(reservation.intentDigest) ||
        !(
          [
            "deploy",
            "rollback",
            "claim_create",
            "promotion",
            "restoration",
          ] as string[]
        ).includes(reservation.operation)
      ) {
        return { ok: false as const, reason: "invalid_reservation" };
      }
      const existing = await db
        .prepare(
          `SELECT * FROM deployment_operation_journals
					 WHERE project_id = ? AND target_id = ? AND idempotency_key = ?`,
        )
        .bind(
          reservation.shipletId,
          reservation.targetId,
          reservation.idempotencyKey,
        )
        .first<JournalRow>();
      if (existing) {
        return existing.intent_digest === reservation.intentDigest &&
          existing.operation === reservation.operation &&
          existing.revision_id === reservation.revisionId &&
          existing.expected_known_good_deployment_id ===
            reservation.expectedKnownGoodDeploymentId
          ? {
              ok: true as const,
              replay: true,
              journal: publicJournal(existing),
            }
          : { ok: false as const, reason: "idempotency_intent_mismatch" };
      }
      const journalId = `deployment_journal_${crypto.randomUUID()}`;
      const timestamp = now();
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO deployment_operation_journals (
					 id, project_id, target_id, expected_known_good_deployment_id,
					 idempotency_key, operation, revision_id, intent_digest, status,
					 result_deployment_id, public_result_json, failure_reason,
					 created_at_ms, updated_at_ms
					) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, NULL, NULL, ?, ?
					 WHERE EXISTS (
					  SELECT 1 FROM deployment_targets
					  WHERE id = ? AND project_id = ? AND detached_on IS NULL
					 ) AND EXISTS (
					  SELECT 1 FROM shiplet_revisions
					  WHERE id = ? AND project_id = ?
					 )`,
        )
        .bind(
          journalId,
          reservation.shipletId,
          reservation.targetId,
          reservation.expectedKnownGoodDeploymentId,
          reservation.idempotencyKey,
          reservation.operation,
          reservation.revisionId,
          reservation.intentDigest,
          timestamp,
          timestamp,
          reservation.targetId,
          reservation.shipletId,
          reservation.revisionId,
          reservation.shipletId,
        )
        .run();
      if (result.meta.changes !== 1) {
        const raced = await db
          .prepare(
            `SELECT * FROM deployment_operation_journals
						 WHERE project_id = ? AND target_id = ? AND idempotency_key = ?`,
          )
          .bind(
            reservation.shipletId,
            reservation.targetId,
            reservation.idempotencyKey,
          )
          .first<JournalRow>();
        if (raced) {
          return raced.intent_digest === reservation.intentDigest
            ? { ok: true as const, replay: true, journal: publicJournal(raced) }
            : { ok: false as const, reason: "idempotency_intent_mismatch" };
        }
        return { ok: false as const, reason: "operation_in_progress" };
      }
      const journal = await db
        .prepare("SELECT * FROM deployment_operation_journals WHERE id = ?")
        .bind(journalId)
        .first<JournalRow>();
      if (!journal) return { ok: false as const, reason: "reservation_failed" };
      return {
        ok: true as const,
        replay: false,
        journal: publicJournal(journal),
      };
    },

    async recheckTargetOperation(recheck) {
      if (
        !validId(recheck.journalId) ||
        !validId(recheck.shipletId) ||
        !validId(recheck.targetId) ||
        (recheck.expectedKnownGoodDeploymentId !== null &&
          !validId(recheck.expectedKnownGoodDeploymentId))
      ) {
        return false;
      }
      const valid = await db
        .prepare(
          `SELECT 1 AS valid FROM deployment_operation_journals journal
					 WHERE journal.id = ? AND journal.project_id = ?
					 AND journal.target_id = ?
					 AND (journal.status = 'reserved'
					  OR (? = 1 AND journal.status = 'reconcile_required'))
					 AND ((? IS NULL AND journal.expected_known_good_deployment_id IS NULL)
					  OR journal.expected_known_good_deployment_id = ?)
					 AND EXISTS (
					  SELECT 1 FROM deployment_targets target
					  WHERE target.id = journal.target_id
					  AND target.project_id = journal.project_id
					  AND target.detached_on IS NULL
					 )
					 AND (
					  (? IS NULL AND NOT EXISTS (
					   SELECT 1 FROM shiplet_deployments current
					   WHERE current.target_id = journal.target_id
					   AND current.status = 'healthy'
					  )) OR ? = (
					   SELECT current.id FROM shiplet_deployments current
					   WHERE current.target_id = journal.target_id
					   AND current.status = 'healthy'
					   ORDER BY current.deployed_on DESC, current.rowid DESC LIMIT 1
					  )
					 ) LIMIT 1`,
        )
        .bind(
          recheck.journalId,
          recheck.shipletId,
          recheck.targetId,
          recheck.allowReconcileRequired === true ? 1 : 0,
          recheck.expectedKnownGoodDeploymentId,
          recheck.expectedKnownGoodDeploymentId,
          recheck.expectedKnownGoodDeploymentId,
          recheck.expectedKnownGoodDeploymentId,
        )
        .first<{ valid: number }>();
      return valid?.valid === 1;
    },

    async finalizeTargetOperation({ journalId, record, effectEvent }) {
      if (
        !validId(journalId) ||
        !validId(record.id) ||
        record.status !== "known_good"
      ) {
        return false;
      }
      const journal = await db
        .prepare("SELECT * FROM deployment_operation_journals WHERE id = ?")
        .bind(journalId)
        .first<JournalRow>();
      if (
        !journal ||
        journal.status !== "reserved" ||
        journal.target_id !== record.targetId ||
        journal.revision_id !== record.revisionId
      ) {
        return false;
      }
      const target = await getTargetScoped({
        shipletId: journal.project_id,
        targetId: journal.target_id,
      });
      if (!target) return false;
      const deployedAt = record.deployedAt ?? now();
      if (
        effectEvent &&
        (effectEvent.deploymentId !== record.id ||
          effectEvent.revisionId !== record.revisionId)
      ) {
        return false;
      }
      const statements = [
        db
          .prepare(
            `INSERT INTO shiplet_deployments (
						 id, target_id, revision_id, provider_resource_name,
						 provider_version_id, provider_deployment_id, status, health_json,
						 deployed_on, deployed_at_ms, failed_on, supersedes_deployment_id,
						 failure_reason
						) SELECT ?, ?, ?, ?, ?, ?, 'healthy', '{"status":"healthy"}',
						 ?, ?, NULL, ?, NULL
						 WHERE EXISTS (
						  SELECT 1 FROM deployment_operation_journals journal
						  WHERE journal.id = ? AND journal.status = 'reserved'
						    AND journal.target_id = ? AND journal.revision_id = ?
						    AND (
						      (journal.expected_known_good_deployment_id IS NULL AND NOT EXISTS (
						        SELECT 1 FROM shiplet_deployments prior
						        WHERE prior.target_id = journal.target_id AND prior.status = 'healthy'
						      )) OR journal.expected_known_good_deployment_id = (
						        SELECT prior.id FROM shiplet_deployments prior
						        WHERE prior.target_id = journal.target_id AND prior.status = 'healthy'
						        ORDER BY prior.deployed_on DESC, prior.rowid DESC LIMIT 1
						      )
						    )
						 )`,
          )
          .bind(
            record.id,
            record.targetId,
            record.revisionId,
            target.providerScriptName,
            record.providerVersionId,
            record.providerDeploymentId,
            new Date(deployedAt).toISOString(),
            deployedAt,
            record.supersedesDeploymentId,
            journalId,
            record.targetId,
            record.revisionId,
          ),
        db
          .prepare(
            `UPDATE deployment_operation_journals
						 SET status = 'finalized', result_deployment_id = ?, updated_at_ms = ?
						 WHERE id = ? AND status = 'reserved'
						   AND EXISTS (
						    SELECT 1 FROM shiplet_deployments
						    WHERE id = ? AND target_id = ? AND revision_id = ?
						   )`,
          )
          .bind(
            record.id,
            now(),
            journalId,
            record.id,
            record.targetId,
            record.revisionId,
          ),
      ];
      if (effectEvent) {
        statements.push(effectOutboxStatement(journal, effectEvent));
      }
      const results = await db.batch(statements);
      return results.every((result) => result.meta.changes === 1);
    },

    async markTargetOperationCompensated({ journalId }) {
      await db
        .prepare(
          `UPDATE deployment_operation_journals
					 SET status = 'compensated', updated_at_ms = ?
					 WHERE id = ? AND status IN ('reserved','reconcile_required')`,
        )
        .bind(now(), journalId)
        .run();
    },

    async completeTargetOperation({ journalId, resultDeploymentId, status }) {
      if (!validId(journalId) || !validId(resultDeploymentId)) return false;
      const result = await db
        .prepare(
          `UPDATE deployment_operation_journals
					 SET status = ?, result_deployment_id = ?, updated_at_ms = ?
					 WHERE id = ? AND status IN ('reserved','reconcile_required')
					 AND EXISTS (
					  SELECT 1 FROM shiplet_deployments deployment
					  WHERE deployment.id = ?
					  AND deployment.target_id = deployment_operation_journals.target_id
					  AND deployment.status = 'healthy'
					 )`,
        )
        .bind(status, resultDeploymentId, now(), journalId, resultDeploymentId)
        .run();
      if (result.meta.changes === 1) return true;
      const completed = await db
        .prepare(
          `SELECT 1 AS completed FROM deployment_operation_journals
						 WHERE id = ? AND status = ? AND result_deployment_id = ? LIMIT 1`,
        )
        .bind(journalId, status, resultDeploymentId)
        .first<{ completed: number }>();
      return completed?.completed === 1;
    },

    async abortTargetOperation({ journalId, status, reason }) {
      await db
        .prepare(
          `UPDATE deployment_operation_journals
						 SET status = ?, failure_reason = ?, updated_at_ms = ?
						 WHERE id = ? AND (
						  status IN ('reserved','finalized')
						  OR (status = 'reconcile_required' AND ? = 'reconcile_required')
						 )`,
        )
        .bind(status, reason.slice(0, 256), now(), journalId, status)
        .run();
    },

    async finalizeTemporaryClaimOperation({
      journalId,
      publicResult,
      effectEvent,
    }) {
      const serialized = JSON.stringify(publicResult);
      if (new TextEncoder().encode(serialized).byteLength > 8_192) return false;
      const journal = await db
        .prepare("SELECT * FROM deployment_operation_journals WHERE id = ?")
        .bind(journalId)
        .first<JournalRow>();
      if (
        !journal ||
        journal.operation !== "claim_create" ||
        !["reserved", "reconcile_required"].includes(journal.status)
      ) {
        return false;
      }
      const statements = [
        db
          .prepare(
            `UPDATE deployment_operation_journals
						 SET status = 'finalized', public_result_json = ?, updated_at_ms = ?
						 WHERE id = ? AND status IN ('reserved','reconcile_required')
						 AND operation = 'claim_create'`,
          )
          .bind(serialized, now(), journalId),
      ];
      if (effectEvent) {
        statements.push(effectOutboxStatement(journal, effectEvent));
      }
      const results = await db.batch(statements);
      return results.every((result) => result.meta.changes === 1);
    },

    async recordTemporaryClaim(claim) {
      const targetId = claim.targetId;
      const shipletId = claim.shipletId;
      const revisionId = claim.revisionId;
      const status = claim.status;
      const vaultRef = claim.vaultRef;
      const expiresAt = claim.expiresAt;
      const providerDeploymentId = claim.providerDeploymentId;
      const providerVersionId = claim.providerVersionId;
      const operationId = claim.operationId;
      const awaitingClaim = status === "awaiting_claim";
      const cleanupRetry = status === "cleanup_retry";
      if (
        !validId(targetId) ||
        !validId(shipletId) ||
        (!awaitingClaim && !cleanupRetry) ||
        !validId(revisionId) ||
        (awaitingClaim && !validId(operationId)) ||
        !validId(providerDeploymentId) ||
        !validId(providerVersionId) ||
        (awaitingClaim &&
          (!validId(vaultRef) ||
            typeof expiresAt !== "number" ||
            !Number.isSafeInteger(expiresAt) ||
            expiresAt <= now())) ||
        (cleanupRetry &&
          ((vaultRef !== null && !validId(vaultRef)) ||
            (expiresAt !== null &&
              (typeof expiresAt !== "number" ||
                !Number.isSafeInteger(expiresAt) ||
                expiresAt < 0)) ||
            typeof claim.providerCleaned !== "boolean" ||
            typeof claim.failureReason !== "string" ||
            claim.failureReason.length === 0 ||
            claim.failureReason.length > 256))
      ) {
        throw new TypeError("Invalid temporary claim record");
      }
      const payload = JSON.stringify({
        targetId,
        shipletId,
        revisionId,
        status,
        vaultRef,
        expiresAt,
        providerDeploymentId,
        providerVersionId,
        ...(awaitingClaim ? { operationId } : {}),
        ...(cleanupRetry
          ? {
              providerCleaned: claim.providerCleaned,
              failureReason: claim.failureReason,
            }
          : {}),
      });
      if (new TextEncoder().encode(payload).byteLength > 8_192) {
        throw new TypeError("Invalid temporary claim record");
      }
      const result = await db
        .prepare(
          `INSERT INTO deployment_temporary_claims (
					 target_id, shiplet_id, revision_id, status, vault_ref, expires_at_ms,
					 payload_json, updated_at_ms
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(target_id) DO UPDATE SET
					 shiplet_id = excluded.shiplet_id, revision_id = excluded.revision_id,
					 status = excluded.status,
					 vault_ref = excluded.vault_ref, expires_at_ms = excluded.expires_at_ms,
					 payload_json = excluded.payload_json,
					 updated_at_ms = excluded.updated_at_ms
					 WHERE excluded.status = 'cleanup_retry'
					 AND deployment_temporary_claims.status = 'awaiting_claim'
					 AND deployment_temporary_claims.shiplet_id = excluded.shiplet_id`,
        )
        .bind(
          targetId,
          shipletId,
          revisionId,
          status,
          vaultRef ?? "vault_unavailable",
          expiresAt ?? 0,
          payload,
          now(),
        )
        .run();
      if (result.meta.changes !== 1) {
        throw new Error("Temporary claim already exists");
      }
    },

    async markTemporaryClaimDelivered({ targetId, expectedStatus, delivery }) {
      if (
        !validId(targetId) ||
        !validId(delivery.eventId) ||
        !validId(delivery.shipletId) ||
        !validId(delivery.revisionId) ||
        delivery.actor.kind !== "human" ||
        !validId(delivery.actor.id) ||
        !Number.isSafeInteger(delivery.occurredAt) ||
        delivery.occurredAt < 0
      ) {
        return false;
      }
      const deliveredOn = new Date(delivery.occurredAt).toISOString();
      await db
        .prepare(
          `UPDATE deployment_temporary_claims
					 SET status = 'delivered', delivery_event_id = ?,
					 delivered_actor_id = ?, delivered_on = ?, updated_at_ms = ?
					 WHERE target_id = ? AND shiplet_id = ? AND revision_id = ?
					 AND status = ? AND expires_at_ms > ?
					 AND EXISTS (
						SELECT 1 FROM deployment_targets target
						WHERE target.id = deployment_temporary_claims.target_id
						AND target.project_id = deployment_temporary_claims.shiplet_id
						AND target.owner_kind = 'human' AND target.owner_id = ?
						AND target.detached_on IS NULL
					 )`,
        )
        .bind(
          delivery.eventId,
          delivery.actor.id,
          deliveredOn,
          now(),
          targetId,
          delivery.shipletId,
          delivery.revisionId,
          expectedStatus,
          now(),
          delivery.actor.id,
        )
        .run();
      const delivered = await db
        .prepare(
          `SELECT 1 AS delivered FROM deployment_temporary_claims
					 WHERE target_id = ? AND delivery_event_id = ? AND status = 'delivered'
					 LIMIT 1`,
        )
        .bind(targetId, delivery.eventId)
        .first<{ delivered: number }>();
      return delivered?.delivered === 1;
    },

    async getTemporaryClaim(targetId) {
      const row = await db
        .prepare(
          `SELECT payload_json, status FROM deployment_temporary_claims
					 WHERE target_id = ? LIMIT 1`,
        )
        .bind(targetId)
        .first<{ payload_json: string; status: string }>();
      if (!row) return null;
      return {
        ...(JSON.parse(row.payload_json) as Record<string, unknown>),
        status: row.status,
      };
    },

    async recordFailure(event) {
      const serialized = JSON.stringify(event);
      if (new TextEncoder().encode(serialized).byteLength > 16_384) {
        throw new TypeError("Deployment failure event too large");
      }
      await db
        .prepare(
          `INSERT INTO deployment_failure_events (
					 id, project_id, target_id, event_json, recorded_at_ms
					) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          `deployment_failure_${crypto.randomUUID()}`,
          typeof event.shipletId === "string" ? event.shipletId : null,
          typeof event.targetId === "string" ? event.targetId : null,
          serialized,
          now(),
        )
        .run();
    },
  };
  return Object.freeze(repository);
}
