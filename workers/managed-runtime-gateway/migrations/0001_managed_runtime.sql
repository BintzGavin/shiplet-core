PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS managed_revisions (
  shiplet_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  script_name TEXT NOT NULL UNIQUE,
  state_namespace TEXT NOT NULL UNIQUE,
  policy_json TEXT NOT NULL,
  stage_status TEXT NOT NULL CHECK (stage_status IN ('staging', 'validated', 'failed')),
  staged_on TEXT NOT NULL,
  validated_on TEXT,
  PRIMARY KEY (shiplet_id, revision_id)
);

CREATE TABLE IF NOT EXISTS managed_activations (
  shiplet_id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  script_name TEXT NOT NULL,
  generation INTEGER NOT NULL,
  activated_on TEXT NOT NULL,
  FOREIGN KEY (shiplet_id, revision_id)
    REFERENCES managed_revisions(shiplet_id, revision_id)
);

CREATE TABLE IF NOT EXISTS managed_activation_history (
  id TEXT PRIMARY KEY,
  shiplet_id TEXT NOT NULL,
  from_revision_id TEXT,
  to_revision_id TEXT NOT NULL,
  from_generation INTEGER,
  to_generation INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('promote', 'rollback')),
  occurred_on TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS managed_revision_identity_immutable
BEFORE UPDATE ON managed_revisions
WHEN NEW.shiplet_id != OLD.shiplet_id
  OR NEW.revision_id != OLD.revision_id
  OR NEW.package_digest != OLD.package_digest
  OR NEW.script_name != OLD.script_name
  OR NEW.state_namespace != OLD.state_namespace
  OR NEW.policy_json != OLD.policy_json
  OR NEW.staged_on != OLD.staged_on
BEGIN
  SELECT RAISE(ABORT, 'managed revision identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS managed_activation_history_immutable_update
BEFORE UPDATE ON managed_activation_history
BEGIN
  SELECT RAISE(ABORT, 'managed activation history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS managed_activation_history_immutable_delete
BEFORE DELETE ON managed_activation_history
BEGIN
  SELECT RAISE(ABORT, 'managed activation history is immutable');
END;
