ALTER TABLE managed_revisions
ADD COLUMN state_scope_namespace TEXT;

ALTER TABLE managed_revisions
ADD COLUMN state_permissions_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS managed_runtime_state_namespaces (
  state_namespace TEXT PRIMARY KEY,
  shiplet_id TEXT NOT NULL UNIQUE,
  scope_kind TEXT NOT NULL CHECK (scope_kind = 'shiplet'),
  quota_bytes INTEGER NOT NULL CHECK (quota_bytes = 262144),
  entry_limit INTEGER NOT NULL CHECK (entry_limit = 128),
  bytes_used INTEGER NOT NULL DEFAULT 0 CHECK (bytes_used >= 0 AND bytes_used <= quota_bytes),
  entry_count INTEGER NOT NULL DEFAULT 0 CHECK (entry_count >= 0 AND entry_count <= entry_limit),
  created_on TEXT NOT NULL,
  updated_on TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_runtime_state_entries (
  state_namespace TEXT NOT NULL,
  state_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_bytes INTEGER NOT NULL CHECK (value_bytes > 0 AND value_bytes <= 32768),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_on TEXT NOT NULL,
  PRIMARY KEY (state_namespace, state_key),
  FOREIGN KEY (state_namespace)
    REFERENCES managed_runtime_state_namespaces(state_namespace)
);

CREATE TABLE IF NOT EXISTS managed_runtime_state_operations (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0 AND sequence <= 64),
  state_namespace TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'shiplet', 'system')),
  actor_id TEXT NOT NULL,
  shiplet_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  activation_generation INTEGER NOT NULL CHECK (activation_generation > 0),
  invocation_kind TEXT NOT NULL CHECK (invocation_kind IN ('active', 'preview')),
  effect TEXT NOT NULL CHECK (effect IN ('read', 'write')),
  operation TEXT NOT NULL CHECK (operation IN ('get', 'put', 'delete')),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'hit', 'missing')),
  key_digest TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  UNIQUE (invocation_id, sequence),
  FOREIGN KEY (state_namespace)
    REFERENCES managed_runtime_state_namespaces(state_namespace)
);

CREATE INDEX IF NOT EXISTS idx_managed_runtime_state_operations_shiplet
ON managed_runtime_state_operations(shiplet_id, occurred_on);

CREATE TRIGGER IF NOT EXISTS managed_runtime_state_revision_contract_immutable
BEFORE UPDATE ON managed_revisions
WHEN NEW.state_scope_namespace IS NOT OLD.state_scope_namespace
  OR NEW.state_permissions_json != OLD.state_permissions_json
BEGIN
  SELECT RAISE(ABORT, 'managed runtime state revision contract is immutable');
END;

CREATE TRIGGER IF NOT EXISTS managed_runtime_state_namespace_identity_immutable
BEFORE UPDATE ON managed_runtime_state_namespaces
WHEN NEW.state_namespace != OLD.state_namespace
  OR NEW.shiplet_id != OLD.shiplet_id
  OR NEW.scope_kind != OLD.scope_kind
  OR NEW.quota_bytes != OLD.quota_bytes
  OR NEW.entry_limit != OLD.entry_limit
  OR NEW.created_on != OLD.created_on
BEGIN
  SELECT RAISE(ABORT, 'managed runtime state namespace identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS managed_runtime_state_namespace_no_delete
BEFORE DELETE ON managed_runtime_state_namespaces
BEGIN
  SELECT RAISE(ABORT, 'managed runtime state namespace cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS managed_runtime_state_entry_insert_quota
BEFORE INSERT ON managed_runtime_state_entries
WHEN NOT EXISTS (
  SELECT 1 FROM managed_runtime_state_entries
  WHERE state_namespace = NEW.state_namespace AND state_key = NEW.state_key
)
BEGIN
  SELECT RAISE(ABORT, 'managed runtime state quota exceeded')
  WHERE NOT EXISTS (
    SELECT 1 FROM managed_runtime_state_namespaces
    WHERE state_namespace = NEW.state_namespace
      AND entry_count + 1 <= entry_limit
      AND bytes_used + NEW.value_bytes <= quota_bytes
  );
END;

CREATE TRIGGER IF NOT EXISTS managed_runtime_state_entry_update_quota
BEFORE UPDATE ON managed_runtime_state_entries
BEGIN
  SELECT RAISE(ABORT, 'managed runtime state quota exceeded')
  WHERE NEW.state_namespace != OLD.state_namespace
    OR NEW.state_key != OLD.state_key
    OR NOT EXISTS (
      SELECT 1 FROM managed_runtime_state_namespaces
      WHERE state_namespace = OLD.state_namespace
        AND bytes_used - OLD.value_bytes + NEW.value_bytes <= quota_bytes
    );
END;

CREATE TRIGGER IF NOT EXISTS managed_runtime_state_entry_usage_insert
AFTER INSERT ON managed_runtime_state_entries
BEGIN
  UPDATE managed_runtime_state_namespaces
  SET entry_count = entry_count + 1,
      bytes_used = bytes_used + NEW.value_bytes,
      updated_on = NEW.updated_on
  WHERE state_namespace = NEW.state_namespace;
END;

CREATE TRIGGER IF NOT EXISTS managed_runtime_state_entry_usage_update
AFTER UPDATE ON managed_runtime_state_entries
BEGIN
  UPDATE managed_runtime_state_namespaces
  SET bytes_used = bytes_used - OLD.value_bytes + NEW.value_bytes,
      updated_on = NEW.updated_on
  WHERE state_namespace = NEW.state_namespace;
END;

CREATE TRIGGER IF NOT EXISTS managed_runtime_state_entry_usage_delete
AFTER DELETE ON managed_runtime_state_entries
BEGIN
  UPDATE managed_runtime_state_namespaces
  SET entry_count = entry_count - 1,
      bytes_used = bytes_used - OLD.value_bytes,
      updated_on = OLD.updated_on
  WHERE state_namespace = OLD.state_namespace;
END;

CREATE TRIGGER IF NOT EXISTS managed_runtime_state_operations_immutable_update
BEFORE UPDATE ON managed_runtime_state_operations
BEGIN
  SELECT RAISE(ABORT, 'managed runtime state operations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS managed_runtime_state_operations_immutable_delete
BEFORE DELETE ON managed_runtime_state_operations
BEGIN
  SELECT RAISE(ABORT, 'managed runtime state operations are immutable');
END;
