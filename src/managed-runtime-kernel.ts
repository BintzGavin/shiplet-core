import type { ShipletActor } from "./self-owned/revisions";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const OPERATION_ID = /^managed_main_[A-Za-z0-9_-]{43}$/;

type ManagedRuntimeOperationRow = {
  id: string;
  project_id: string;
  kind: "promote" | "rollback";
  candidate_revision_id: string;
  candidate_package_digest: string;
  prior_revision_id: string;
  expected_remote_generation: number;
  remote_generation: number | null;
  status: "prepared" | "remote_committed" | "committed";
  actor_kind: ShipletActor["kind"];
  actor_id: string;
};

type ManagedRuntimeOperationTerminalRow = {
  operation_id: string;
  outcome: "not_dispatched" | "remote_rejected";
  actor_kind: ShipletActor["kind"];
  actor_id: string;
  failure_code: string | null;
  failure_status: number | null;
};

type ManagedRuntimeStateRow = {
  project_id: string;
  active_revision_id: string;
  active_package_digest: string;
  remote_generation: number;
  last_operation_id: string;
};

function validActor(actor: ShipletActor) {
  return (
    (actor.kind === "human" ||
      actor.kind === "agent" ||
      actor.kind === "shiplet") &&
    IDENTIFIER.test(actor.id)
  );
}

function validGeneration(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

export async function ensureManagedRuntimeKernelSchema(db: D1Database) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_managed_runtime_state (
        project_id TEXT PRIMARY KEY,
        active_revision_id TEXT NOT NULL,
        active_package_digest TEXT NOT NULL,
        remote_generation INTEGER NOT NULL,
        last_operation_id TEXT NOT NULL,
        updated_on TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (active_revision_id) REFERENCES shiplet_revisions(id)
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_managed_runtime_operations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('promote', 'rollback')),
        candidate_revision_id TEXT NOT NULL,
        candidate_package_digest TEXT NOT NULL,
        prior_revision_id TEXT NOT NULL,
        expected_remote_generation INTEGER NOT NULL,
        remote_generation INTEGER,
        status TEXT NOT NULL CHECK(status IN ('prepared', 'remote_committed', 'committed')),
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'agent', 'shiplet')),
        actor_id TEXT NOT NULL,
        created_on TEXT NOT NULL,
        updated_on TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (candidate_revision_id) REFERENCES shiplet_revisions(id),
        FOREIGN KEY (prior_revision_id) REFERENCES shiplet_revisions(id)
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_managed_runtime_operation_terminals (
        operation_id TEXT PRIMARY KEY,
        outcome TEXT NOT NULL CHECK(outcome IN ('not_dispatched', 'remote_rejected')),
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'agent', 'shiplet')),
        actor_id TEXT NOT NULL,
        created_on TEXT NOT NULL,
        FOREIGN KEY (operation_id) REFERENCES shiplet_managed_runtime_operations(id)
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_managed_runtime_operation_dispatches (
        operation_id TEXT PRIMARY KEY,
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'agent', 'shiplet')),
        actor_id TEXT NOT NULL,
        created_on TEXT NOT NULL,
        FOREIGN KEY (operation_id) REFERENCES shiplet_managed_runtime_operations(id)
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_managed_runtime_schema_versions (
        version INTEGER PRIMARY KEY,
        installed_on TEXT NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_managed_runtime_state_no_delete
       BEFORE DELETE ON shiplet_managed_runtime_state
       BEGIN SELECT RAISE(ABORT, 'managed runtime state is immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_managed_runtime_operations_no_delete
       BEFORE DELETE ON shiplet_managed_runtime_operations
       BEGIN SELECT RAISE(ABORT, 'managed runtime operations are immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_managed_runtime_operation_terminals_no_delete
       BEFORE DELETE ON shiplet_managed_runtime_operation_terminals
       BEGIN SELECT RAISE(ABORT, 'managed runtime operation terminals are immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_managed_runtime_operation_terminals_no_update
       BEFORE UPDATE ON shiplet_managed_runtime_operation_terminals
       BEGIN SELECT RAISE(ABORT, 'managed runtime operation terminals are immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_managed_runtime_operation_dispatches_no_delete
       BEFORE DELETE ON shiplet_managed_runtime_operation_dispatches
       BEGIN SELECT RAISE(ABORT, 'managed runtime operation dispatches are immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_managed_runtime_operation_dispatches_no_update
       BEFORE UPDATE ON shiplet_managed_runtime_operation_dispatches
       BEGIN SELECT RAISE(ABORT, 'managed runtime operation dispatches are immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_managed_runtime_schema_versions_no_delete
       BEFORE DELETE ON shiplet_managed_runtime_schema_versions
       BEGIN SELECT RAISE(ABORT, 'managed runtime schema versions are immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_managed_runtime_schema_versions_no_update
       BEFORE UPDATE ON shiplet_managed_runtime_schema_versions
       BEGIN SELECT RAISE(ABORT, 'managed runtime schema versions are immutable'); END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_managed_runtime_operation_binding_immutable
       BEFORE UPDATE OF project_id, kind, candidate_revision_id,
         candidate_package_digest, prior_revision_id,
         expected_remote_generation, actor_kind, actor_id
       ON shiplet_managed_runtime_operations
       BEGIN SELECT RAISE(ABORT, 'managed runtime operation binding is immutable'); END`,
    ),
  ]);
  const terminalAware = await db
    .prepare(
      `SELECT version FROM shiplet_managed_runtime_schema_versions
       WHERE version = 2`,
    )
    .first<{ version: number }>();
  if (terminalAware?.version !== 2) {
    try {
      await db.batch([
        db.prepare("DROP INDEX IF EXISTS idx_shiplet_managed_runtime_pending"),
        db.prepare(
          `CREATE TRIGGER IF NOT EXISTS shiplet_managed_runtime_one_pending
           BEFORE INSERT ON shiplet_managed_runtime_operations
           WHEN EXISTS (
             SELECT 1 FROM shiplet_managed_runtime_operations existing
             WHERE existing.project_id = NEW.project_id
               AND existing.status != 'committed'
               AND NOT EXISTS (
                 SELECT 1 FROM shiplet_managed_runtime_operation_terminals terminal
                 WHERE terminal.operation_id = existing.id
               )
           )
           BEGIN SELECT RAISE(ABORT, 'managed runtime operation pending'); END`,
        ),
        db.prepare(
          "DROP TRIGGER IF EXISTS shiplet_managed_runtime_activation_fence",
        ),
        db.prepare(
          `CREATE TRIGGER shiplet_managed_runtime_activation_fence
           BEFORE UPDATE OF active_revision_id ON projects
           WHEN EXISTS (
             SELECT 1 FROM shiplet_managed_runtime_operations operation
             WHERE operation.project_id = OLD.id
               AND operation.status IN ('prepared', 'remote_committed')
               AND NOT EXISTS (
                 SELECT 1 FROM shiplet_managed_runtime_operation_terminals terminal
                 WHERE terminal.operation_id = operation.id
               )
               AND NEW.active_revision_id != operation.candidate_revision_id
           )
           BEGIN SELECT RAISE(ABORT, 'managed runtime activation fence'); END`,
        ),
        db
          .prepare(
            `INSERT INTO shiplet_managed_runtime_schema_versions
             (version, installed_on) VALUES (2, ?)`,
          )
          .bind(new Date().toISOString()),
      ]);
    } catch (error) {
      const raced = await db
        .prepare(
          `SELECT version FROM shiplet_managed_runtime_schema_versions
           WHERE version = 2`,
        )
        .first<{ version: number }>();
      if (raced?.version !== 2) throw error;
    }
  }
  const strictPreparedFence = await db
    .prepare(
      `SELECT version FROM shiplet_managed_runtime_schema_versions
       WHERE version = 3`,
    )
    .first<{ version: number }>();
  if (strictPreparedFence?.version !== 3) {
    try {
      await db.batch([
        db.prepare(
          "DROP TRIGGER IF EXISTS shiplet_managed_runtime_activation_fence",
        ),
        db.prepare(
          `CREATE TRIGGER shiplet_managed_runtime_activation_fence
         BEFORE UPDATE OF active_revision_id ON projects
         WHEN EXISTS (
           SELECT 1 FROM shiplet_managed_runtime_operations operation
           WHERE operation.project_id = OLD.id
             AND operation.status IN ('prepared', 'remote_committed')
             AND NOT EXISTS (
               SELECT 1 FROM shiplet_managed_runtime_operation_terminals terminal
               WHERE terminal.operation_id = operation.id
             )
             AND (
               operation.status = 'prepared'
               OR NEW.active_revision_id != operation.candidate_revision_id
             )
         )
         BEGIN SELECT RAISE(ABORT, 'managed runtime activation fence'); END`,
        ),
        db
          .prepare(
            `INSERT INTO shiplet_managed_runtime_schema_versions
           (version, installed_on) VALUES (3, ?)`,
          )
          .bind(new Date().toISOString()),
      ]);
    } catch (error) {
      const raced = await db
        .prepare(
          `SELECT version FROM shiplet_managed_runtime_schema_versions
         WHERE version = 3`,
        )
        .first<{ version: number }>();
      if (raced?.version !== 3) throw error;
    }
  }
  const terminalFailureReplay = await db
    .prepare(
      `SELECT version FROM shiplet_managed_runtime_schema_versions
       WHERE version = 4`,
    )
    .first<{ version: number }>();
  if (terminalFailureReplay?.version === 4) return;
  try {
    await db.batch([
      db.prepare(
        "ALTER TABLE shiplet_managed_runtime_operation_terminals ADD COLUMN failure_code TEXT",
      ),
      db.prepare(
        "ALTER TABLE shiplet_managed_runtime_operation_terminals ADD COLUMN failure_status INTEGER",
      ),
      db
        .prepare(
          `INSERT INTO shiplet_managed_runtime_schema_versions
           (version, installed_on) VALUES (4, ?)`,
        )
        .bind(new Date().toISOString()),
    ]);
  } catch (error) {
    const raced = await db
      .prepare(
        `SELECT version FROM shiplet_managed_runtime_schema_versions
         WHERE version = 4`,
      )
      .first<{ version: number }>();
    if (raced?.version !== 4) throw error;
  }
}

function exactOperation(
  row: ManagedRuntimeOperationRow,
  input: {
    operationId: string;
    projectId: string;
    kind: "promote" | "rollback";
    candidateRevisionId: string;
    candidatePackageDigest: string;
    priorRevisionId: string;
    actor: ShipletActor;
  },
) {
  return (
    row.id === input.operationId &&
    row.project_id === input.projectId &&
    row.kind === input.kind &&
    row.candidate_revision_id === input.candidateRevisionId &&
    row.candidate_package_digest === input.candidatePackageDigest &&
    row.prior_revision_id === input.priorRevisionId &&
    row.actor_kind === input.actor.kind &&
    row.actor_id === input.actor.id &&
    validGeneration(row.expected_remote_generation)
  );
}

function operationResult(row: ManagedRuntimeOperationRow) {
  return Object.freeze({
    operationId: row.id,
    status: row.status,
    expectedRemoteGeneration: row.expected_remote_generation,
    ...(row.remote_generation === null
      ? {}
      : { remoteGeneration: row.remote_generation }),
  });
}

async function refuseTerminalOperation(db: D1Database, operationId: string) {
  const terminal = await db
    .prepare(
      `SELECT operation_id FROM shiplet_managed_runtime_operation_terminals
       WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<{ operation_id: string }>();
  if (terminal) {
    throw new Error("managed_runtime_operation_terminal");
  }
}

export async function beginManagedRuntimeActivation(input: {
  db: D1Database;
  operationId: string;
  projectId: string;
  kind: "promote" | "rollback";
  candidateRevisionId: string;
  candidatePackageDigest: string;
  priorRevisionId: string;
  actor: ShipletActor;
}) {
  if (
    !OPERATION_ID.test(input.operationId) ||
    !IDENTIFIER.test(input.projectId) ||
    !IDENTIFIER.test(input.candidateRevisionId) ||
    !PACKAGE_DIGEST.test(input.candidatePackageDigest) ||
    !IDENTIFIER.test(input.priorRevisionId) ||
    !validActor(input.actor)
  ) {
    throw new TypeError("managed_runtime_operation_invalid");
  }
  await ensureManagedRuntimeKernelSchema(input.db);
  const existing = await input.db
    .prepare("SELECT * FROM shiplet_managed_runtime_operations WHERE id = ?")
    .bind(input.operationId)
    .first<ManagedRuntimeOperationRow>();
  if (existing) {
    if (!exactOperation(existing, input)) {
      throw new Error("managed_runtime_operation_conflict");
    }
    await refuseTerminalOperation(input.db, input.operationId);
    return operationResult(existing);
  }
  const now = new Date().toISOString();
  try {
    const inserted = await input.db
      .prepare(
        `INSERT INTO shiplet_managed_runtime_operations (
          id, project_id, kind, candidate_revision_id,
          candidate_package_digest, prior_revision_id,
          expected_remote_generation, remote_generation, status,
          actor_kind, actor_id, created_on, updated_on
        )
        SELECT ?, project.id, ?, candidate.id, ?, ?,
          COALESCE(state.remote_generation, 0), NULL, 'prepared', ?, ?, ?, ?
        FROM projects project
        JOIN shiplet_revisions candidate
          ON candidate.project_id = project.id AND candidate.id = ?
        LEFT JOIN shiplet_managed_runtime_state state
          ON state.project_id = project.id
        WHERE project.id = ? AND project.active_revision_id = ?
          AND candidate.package_digest = ?
          AND (
            state.project_id IS NULL OR (
              typeof(state.remote_generation) = 'integer'
              AND state.remote_generation >= 0
            )
          )`,
      )
      .bind(
        input.operationId,
        input.kind,
        input.candidatePackageDigest,
        input.priorRevisionId,
        input.actor.kind,
        input.actor.id,
        now,
        now,
        input.candidateRevisionId,
        input.projectId,
        input.priorRevisionId,
        input.candidatePackageDigest.slice("sha256:".length),
      )
      .run();
    if (inserted.meta.changes !== 1) {
      throw new Error("managed_runtime_operation_conflict");
    }
  } catch {
    const raced = await input.db
      .prepare("SELECT * FROM shiplet_managed_runtime_operations WHERE id = ?")
      .bind(input.operationId)
      .first<ManagedRuntimeOperationRow>();
    if (!raced || !exactOperation(raced, input)) {
      throw new Error("managed_runtime_operation_conflict");
    }
    await refuseTerminalOperation(input.db, input.operationId);
    return operationResult(raced);
  }
  const inserted = await input.db
    .prepare("SELECT * FROM shiplet_managed_runtime_operations WHERE id = ?")
    .bind(input.operationId)
    .first<ManagedRuntimeOperationRow>();
  if (
    !inserted ||
    !exactOperation(inserted, input) ||
    inserted.status !== "prepared" ||
    !validGeneration(inserted.expected_remote_generation)
  ) {
    throw new Error("managed_runtime_operation_conflict");
  }
  return operationResult(inserted);
}

export async function abortManagedRuntimeActivation(input: {
  db: D1Database;
  operationId: string;
  outcome: "not_dispatched" | "remote_rejected";
  actor: ShipletActor;
  failure?: Readonly<{ code: string; status: number }>;
}) {
  if (
    !OPERATION_ID.test(input.operationId) ||
    (input.outcome !== "not_dispatched" &&
      input.outcome !== "remote_rejected") ||
    !validActor(input.actor) ||
    (input.failure !== undefined &&
      (!/^[a-z][a-z0-9_]{0,127}$/.test(input.failure.code) ||
        !Number.isSafeInteger(input.failure.status) ||
        input.failure.status < 400 ||
        input.failure.status > 599))
  ) {
    throw new TypeError("managed_runtime_abort_invalid");
  }
  await ensureManagedRuntimeKernelSchema(input.db);
  const changed = await input.db
    .prepare(
      `INSERT INTO shiplet_managed_runtime_operation_terminals (
         operation_id, outcome, actor_kind, actor_id, created_on,
         failure_code, failure_status
       )
       SELECT id, ?, ?, ?, ?, ?, ?
       FROM shiplet_managed_runtime_operations operation
       WHERE operation.id = ? AND operation.status = 'prepared'
         AND operation.actor_kind = ? AND operation.actor_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM shiplet_managed_runtime_operation_terminals terminal
           WHERE terminal.operation_id = operation.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM shiplet_managed_runtime_operation_dispatches dispatch
           WHERE dispatch.operation_id = operation.id
         )`,
    )
    .bind(
      input.outcome,
      input.actor.kind,
      input.actor.id,
      new Date().toISOString(),
      input.failure?.code ?? null,
      input.failure?.status ?? null,
      input.operationId,
      input.actor.kind,
      input.actor.id,
    )
    .run();
  const terminal = await input.db
    .prepare(
      `SELECT operation_id, outcome, actor_kind, actor_id,
              failure_code, failure_status
       FROM shiplet_managed_runtime_operation_terminals
       WHERE operation_id = ?`,
    )
    .bind(input.operationId)
    .first<ManagedRuntimeOperationTerminalRow>();
  if (
    (changed.meta.changes !== 1 &&
      (terminal?.outcome !== input.outcome ||
        terminal.actor_kind !== input.actor.kind ||
        terminal.actor_id !== input.actor.id ||
        terminal.failure_code !== (input.failure?.code ?? null) ||
        terminal.failure_status !== (input.failure?.status ?? null))) ||
    !terminal
  ) {
    throw new Error("managed_runtime_abort_conflict");
  }
  return Object.freeze({
    operationId: input.operationId,
    status: "aborted" as const,
    outcome: input.outcome,
    ...(terminal.failure_code && terminal.failure_status
      ? {
          failure: Object.freeze({
            code: terminal.failure_code,
            status: terminal.failure_status,
          }),
        }
      : {}),
  });
}

export async function loadManagedRuntimeActivationTerminal(input: {
  db: D1Database;
  operationId: string;
  actor: ShipletActor;
}) {
  if (!OPERATION_ID.test(input.operationId) || !validActor(input.actor)) {
    throw new TypeError("managed_runtime_terminal_invalid");
  }
  await ensureManagedRuntimeKernelSchema(input.db);
  const terminal = await input.db
    .prepare(
      `SELECT terminal.operation_id, terminal.outcome,
              terminal.actor_kind, terminal.actor_id,
              terminal.failure_code, terminal.failure_status,
              operation.prior_revision_id
       FROM shiplet_managed_runtime_operation_terminals terminal
       JOIN shiplet_managed_runtime_operations operation
         ON operation.id = terminal.operation_id
       WHERE terminal.operation_id = ?
         AND terminal.actor_kind = ? AND terminal.actor_id = ?`,
    )
    .bind(input.operationId, input.actor.kind, input.actor.id)
    .first<
      ManagedRuntimeOperationTerminalRow & {
        prior_revision_id: string;
      }
    >();
  if (!terminal) return null;
  if (
    (terminal.failure_code === null) !== (terminal.failure_status === null) ||
    (terminal.failure_code !== null &&
      (!/^[a-z][a-z0-9_]{0,127}$/.test(terminal.failure_code) ||
        !Number.isSafeInteger(terminal.failure_status) ||
        terminal.failure_status! < 400 ||
        terminal.failure_status! > 599))
  ) {
    throw new Error("managed_runtime_terminal_corrupt");
  }
  return Object.freeze({
    operationId: terminal.operation_id,
    outcome: terminal.outcome,
    priorRevisionId: terminal.prior_revision_id,
    ...(terminal.failure_code && terminal.failure_status
      ? {
          failure: Object.freeze({
            code: terminal.failure_code,
            status: terminal.failure_status,
          }),
        }
      : {}),
  });
}

export async function markManagedRuntimeActivationDispatching(input: {
  db: D1Database;
  operationId: string;
  actor: ShipletActor;
}) {
  if (!OPERATION_ID.test(input.operationId) || !validActor(input.actor)) {
    throw new TypeError("managed_runtime_dispatch_invalid");
  }
  await ensureManagedRuntimeKernelSchema(input.db);
  const changed = await input.db
    .prepare(
      `INSERT INTO shiplet_managed_runtime_operation_dispatches (
         operation_id, actor_kind, actor_id, created_on
       )
       SELECT operation.id, ?, ?, ?
       FROM shiplet_managed_runtime_operations operation
       WHERE operation.id = ? AND operation.status = 'prepared'
         AND operation.actor_kind = ? AND operation.actor_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM shiplet_managed_runtime_operation_terminals terminal
           WHERE terminal.operation_id = operation.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM shiplet_managed_runtime_operation_dispatches dispatch
           WHERE dispatch.operation_id = operation.id
         )`,
    )
    .bind(
      input.actor.kind,
      input.actor.id,
      new Date().toISOString(),
      input.operationId,
      input.actor.kind,
      input.actor.id,
    )
    .run();
  const dispatch = await input.db
    .prepare(
      `SELECT actor_kind, actor_id
       FROM shiplet_managed_runtime_operation_dispatches
       WHERE operation_id = ?`,
    )
    .bind(input.operationId)
    .first<{ actor_kind: ShipletActor["kind"]; actor_id: string }>();
  if (
    (changed.meta.changes !== 1 &&
      (dispatch?.actor_kind !== input.actor.kind ||
        dispatch.actor_id !== input.actor.id)) ||
    !dispatch
  ) {
    throw new Error("managed_runtime_dispatch_conflict");
  }
  return Object.freeze({
    operationId: input.operationId,
    status: "dispatching" as const,
  });
}

export async function markManagedRuntimeRemoteCommitted(input: {
  db: D1Database;
  operationId: string;
  expectedRemoteGeneration: number;
  remoteGeneration: number;
}) {
  if (
    !OPERATION_ID.test(input.operationId) ||
    !validGeneration(input.expectedRemoteGeneration) ||
    input.remoteGeneration !== input.expectedRemoteGeneration + 1
  ) {
    throw new TypeError("managed_runtime_remote_commit_invalid");
  }
  const changed = await input.db
    .prepare(
      `UPDATE shiplet_managed_runtime_operations
       SET status = 'remote_committed', remote_generation = ?, updated_on = ?
       WHERE id = ? AND status = 'prepared'
         AND expected_remote_generation = ? AND remote_generation IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM shiplet_managed_runtime_operation_terminals terminal
           WHERE terminal.operation_id = shiplet_managed_runtime_operations.id
         )
         AND EXISTS (
           SELECT 1 FROM shiplet_managed_runtime_operation_dispatches dispatch
           WHERE dispatch.operation_id = shiplet_managed_runtime_operations.id
         )`,
    )
    .bind(
      input.remoteGeneration,
      new Date().toISOString(),
      input.operationId,
      input.expectedRemoteGeneration,
    )
    .run();
  const row = await input.db
    .prepare("SELECT * FROM shiplet_managed_runtime_operations WHERE id = ?")
    .bind(input.operationId)
    .first<ManagedRuntimeOperationRow>();
  if (
    (changed.meta.changes !== 1 &&
      row?.status !== "remote_committed" &&
      row?.status !== "committed") ||
    row?.expected_remote_generation !== input.expectedRemoteGeneration ||
    row.remote_generation !== input.remoteGeneration
  ) {
    throw new Error("managed_runtime_remote_commit_conflict");
  }
  return operationResult(row);
}

function bindingFromOperation(row: ManagedRuntimeOperationRow) {
  if (
    row.remote_generation === null ||
    !validGeneration(row.remote_generation)
  ) {
    throw new Error("managed_runtime_state_corrupt");
  }
  return Object.freeze({
    shipletId: row.project_id,
    revisionId: row.candidate_revision_id,
    packageDigest: row.candidate_package_digest,
    activationGeneration: row.remote_generation,
  });
}

export async function commitManagedRuntimeActivation(input: {
  db: D1Database;
  operationId: string;
}) {
  if (!OPERATION_ID.test(input.operationId)) {
    throw new TypeError("managed_runtime_operation_invalid");
  }
  const operation = await input.db
    .prepare("SELECT * FROM shiplet_managed_runtime_operations WHERE id = ?")
    .bind(input.operationId)
    .first<ManagedRuntimeOperationRow>();
  if (
    !operation ||
    (operation.status !== "remote_committed" &&
      operation.status !== "committed") ||
    operation.remote_generation === null ||
    operation.remote_generation !== operation.expected_remote_generation + 1
  ) {
    throw new Error("managed_runtime_operation_not_committable");
  }
  const project = await input.db
    .prepare("SELECT active_revision_id FROM projects WHERE id = ?")
    .bind(operation.project_id)
    .first<{ active_revision_id: string | null }>();
  if (project?.active_revision_id !== operation.candidate_revision_id) {
    throw new Error("managed_runtime_local_activation_uncommitted");
  }
  if (operation.status === "committed") return bindingFromOperation(operation);
  const now = new Date().toISOString();
  const results = await input.db.batch([
    input.db
      .prepare(
        `INSERT INTO shiplet_managed_runtime_state (
          project_id, active_revision_id, active_package_digest,
          remote_generation, last_operation_id, updated_on
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          active_revision_id = excluded.active_revision_id,
          active_package_digest = excluded.active_package_digest,
          remote_generation = excluded.remote_generation,
          last_operation_id = excluded.last_operation_id,
          updated_on = excluded.updated_on
        WHERE shiplet_managed_runtime_state.remote_generation = ?`,
      )
      .bind(
        operation.project_id,
        operation.candidate_revision_id,
        operation.candidate_package_digest,
        operation.remote_generation,
        operation.id,
        now,
        operation.expected_remote_generation,
      ),
    input.db
      .prepare(
        `UPDATE shiplet_managed_runtime_operations
         SET status = 'committed', updated_on = ?
         WHERE id = ? AND status = 'remote_committed'`,
      )
      .bind(now, operation.id),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    const raced = await input.db
      .prepare("SELECT * FROM shiplet_managed_runtime_operations WHERE id = ?")
      .bind(input.operationId)
      .first<ManagedRuntimeOperationRow>();
    const state = await input.db
      .prepare(
        "SELECT * FROM shiplet_managed_runtime_state WHERE project_id = ?",
      )
      .bind(operation.project_id)
      .first<ManagedRuntimeStateRow>();
    if (
      raced?.status !== "committed" ||
      state?.active_revision_id !== operation.candidate_revision_id ||
      state.active_package_digest !== operation.candidate_package_digest ||
      state.remote_generation !== operation.remote_generation ||
      state.last_operation_id !== operation.id
    ) {
      throw new Error("managed_runtime_activation_conflict");
    }
  }
  return bindingFromOperation({ ...operation, status: "committed" });
}

export async function loadManagedRuntimeInvocationBinding(input: {
  db: D1Database;
  projectId: string;
  revisionId: string;
  packageDigest: string;
}) {
  if (
    !IDENTIFIER.test(input.projectId) ||
    !IDENTIFIER.test(input.revisionId) ||
    !PACKAGE_DIGEST.test(input.packageDigest)
  ) {
    return null;
  }
  const project = await input.db
    .prepare("SELECT active_revision_id FROM projects WHERE id = ?")
    .bind(input.projectId)
    .first<{ active_revision_id: string | null }>();
  if (project?.active_revision_id !== input.revisionId) return null;
  const state = await input.db
    .prepare(
      `SELECT project_id, active_revision_id, active_package_digest,
              remote_generation, last_operation_id
       FROM shiplet_managed_runtime_state WHERE project_id = ?`,
    )
    .bind(input.projectId)
    .first<ManagedRuntimeStateRow>();
  if (
    state?.active_revision_id === input.revisionId &&
    state.active_package_digest === input.packageDigest &&
    validGeneration(state.remote_generation) &&
    state.remote_generation > 0
  ) {
    return Object.freeze({
      shipletId: input.projectId,
      revisionId: input.revisionId,
      packageDigest: input.packageDigest,
      activationGeneration: state.remote_generation,
    });
  }
  const recovering = await input.db
    .prepare(
      `SELECT * FROM shiplet_managed_runtime_operations
       WHERE project_id = ? AND candidate_revision_id = ?
         AND candidate_package_digest = ? AND status = 'remote_committed'
       ORDER BY updated_on DESC LIMIT 1`,
    )
    .bind(input.projectId, input.revisionId, input.packageDigest)
    .first<ManagedRuntimeOperationRow>();
  return recovering ? bindingFromOperation(recovering) : null;
}
