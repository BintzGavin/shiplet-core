ALTER TABLE temporary_deployments ADD COLUMN shiplet_id TEXT;
ALTER TABLE temporary_deployments ADD COLUMN operation_id TEXT;
ALTER TABLE temporary_deployments ADD COLUMN delivery_event_id TEXT;
ALTER TABLE temporary_deployments ADD COLUMN delivery_started_on TEXT;

ALTER TABLE backend_redirects ADD COLUMN delivery_event_id TEXT;
ALTER TABLE backend_redirects ADD COLUMN handle_ref TEXT;

CREATE TABLE IF NOT EXISTS temporary_provider_operations (
  operation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (
    operation_kind = 'temporary.deployment.create'
  ),
  user_id TEXT NOT NULL,
  shiplet_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  script_name TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'reserved', 'provisioning', 'account_ready', 'deploying', 'active',
    'cleanup_pending', 'cleaned', 'ambiguity_expired'
  )),
  account_id TEXT,
  authorization_ref TEXT,
  claim_ref TEXT,
  account_expires_at INTEGER,
  claim_expires_at INTEGER,
  provider_deployment_id TEXT,
  provider_version_id TEXT,
  workers_dev_url TEXT,
  serialized_body_bytes INTEGER,
  failure_reason TEXT,
  ambiguity_expires_at INTEGER NOT NULL,
  created_on TEXT NOT NULL,
  updated_on TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_temporary_deployments_operation
  ON temporary_deployments(operation_id)
  WHERE operation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_temporary_deployments_delivery_event
  ON temporary_deployments(delivery_event_id)
  WHERE delivery_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_temporary_deployments_shiplet_scope
  ON temporary_deployments (
    shiplet_id, user_id, target_id, revision_id, provider_deployment_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_redirects_delivery_event
  ON backend_redirects(delivery_event_id)
  WHERE delivery_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_redirects_deployment_delivery
  ON backend_redirects(temporary_deployment_id)
  WHERE delivery_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_redirects_handle_ref
  ON backend_redirects(handle_ref)
  WHERE handle_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_temporary_provider_operations_recovery
  ON temporary_provider_operations(state, updated_on, operation_id);

CREATE TRIGGER IF NOT EXISTS temporary_deployment_identity_immutable
BEFORE UPDATE ON temporary_deployments
WHEN NEW.id != OLD.id
  OR NEW.user_id != OLD.user_id
  OR NOT (NEW.shiplet_id IS OLD.shiplet_id)
  OR NEW.target_id != OLD.target_id
  OR NEW.revision_id != OLD.revision_id
  OR NEW.package_digest != OLD.package_digest
  OR NEW.account_id != OLD.account_id
  OR NEW.script_name != OLD.script_name
  OR NEW.request_digest != OLD.request_digest
  OR NEW.provider_deployment_id != OLD.provider_deployment_id
  OR NEW.provider_version_id != OLD.provider_version_id
  OR NEW.workers_dev_url != OLD.workers_dev_url
  OR NOT (NEW.operation_id IS OLD.operation_id)
  OR NEW.account_expires_at != OLD.account_expires_at
  OR NEW.claim_expires_at != OLD.claim_expires_at
  OR NEW.created_on != OLD.created_on
BEGIN
  SELECT RAISE(ABORT, 'temporary deployment identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS temporary_deployment_legal_transition
BEFORE UPDATE OF status ON temporary_deployments
WHEN NEW.status != OLD.status AND NOT (
  (OLD.status = 'active' AND NEW.status IN ('claim_delivered', 'expired', 'cleaned'))
  OR (OLD.status = 'claim_delivered' AND NEW.status IN ('expired', 'cleaned'))
  OR (OLD.status = 'expired' AND NEW.status = 'cleaned')
)
BEGIN
  SELECT RAISE(ABORT, 'illegal temporary deployment transition');
END;

CREATE TRIGGER IF NOT EXISTS temporary_claim_delivery_binding_immutable
BEFORE UPDATE OF delivery_event_id, delivery_started_on ON temporary_deployments
WHEN NOT (
  (NEW.delivery_event_id IS OLD.delivery_event_id
    AND NEW.delivery_started_on IS OLD.delivery_started_on)
  OR (
    OLD.delivery_event_id IS NULL
    AND OLD.delivery_started_on IS NULL
    AND NEW.delivery_event_id IS NOT NULL
    AND NEW.delivery_started_on IS NOT NULL
    AND OLD.status = 'active'
    AND NEW.status = 'claim_delivered'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'temporary claim delivery binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS backend_redirect_binding_immutable
BEFORE UPDATE ON backend_redirects
WHEN NEW.handle_digest != OLD.handle_digest
  OR NEW.temporary_deployment_id != OLD.temporary_deployment_id
  OR NEW.user_id != OLD.user_id
  OR NEW.expires_at != OLD.expires_at
  OR NEW.created_on != OLD.created_on
  OR NOT (NEW.delivery_event_id IS OLD.delivery_event_id)
  OR NOT (NEW.handle_ref IS OLD.handle_ref)
  OR (OLD.consumed_on IS NOT NULL AND NEW.consumed_on IS NOT OLD.consumed_on)
BEGIN
  SELECT RAISE(ABORT, 'backend redirect binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS temporary_provider_operation_binding_immutable
BEFORE UPDATE ON temporary_provider_operations
WHEN NEW.operation_id != OLD.operation_id
  OR NEW.operation_kind != OLD.operation_kind
  OR NEW.user_id != OLD.user_id
  OR NEW.shiplet_id != OLD.shiplet_id
  OR NEW.target_id != OLD.target_id
  OR NEW.revision_id != OLD.revision_id
  OR NEW.package_digest != OLD.package_digest
  OR NEW.script_name != OLD.script_name
  OR NEW.request_digest != OLD.request_digest
  OR NEW.ambiguity_expires_at != OLD.ambiguity_expires_at
  OR NEW.created_on != OLD.created_on
  OR (OLD.account_id IS NOT NULL AND NEW.account_id IS NOT OLD.account_id)
  OR (OLD.authorization_ref IS NOT NULL AND NEW.authorization_ref IS NOT OLD.authorization_ref)
  OR (OLD.claim_ref IS NOT NULL AND NEW.claim_ref IS NOT OLD.claim_ref)
  OR (OLD.account_expires_at IS NOT NULL AND NEW.account_expires_at IS NOT OLD.account_expires_at)
  OR (OLD.claim_expires_at IS NOT NULL AND NEW.claim_expires_at IS NOT OLD.claim_expires_at)
  OR (OLD.provider_deployment_id IS NOT NULL AND NEW.provider_deployment_id IS NOT OLD.provider_deployment_id)
  OR (OLD.provider_version_id IS NOT NULL AND NEW.provider_version_id IS NOT OLD.provider_version_id)
  OR (OLD.workers_dev_url IS NOT NULL AND NEW.workers_dev_url IS NOT OLD.workers_dev_url)
  OR (OLD.serialized_body_bytes IS NOT NULL AND NEW.serialized_body_bytes IS NOT OLD.serialized_body_bytes)
BEGIN
  SELECT RAISE(ABORT, 'temporary provider operation binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS temporary_provider_operation_legal_transition
BEFORE UPDATE OF state ON temporary_provider_operations
WHEN NEW.state != OLD.state AND NOT (
  (OLD.state = 'reserved' AND NEW.state = 'provisioning')
  OR (OLD.state = 'provisioning' AND NEW.state IN ('account_ready', 'ambiguity_expired'))
  OR (OLD.state = 'account_ready' AND NEW.state IN ('deploying', 'cleanup_pending'))
  OR (OLD.state = 'deploying' AND NEW.state IN ('active', 'cleanup_pending'))
  OR (OLD.state = 'active' AND NEW.state = 'cleanup_pending')
  OR (OLD.state = 'cleanup_pending' AND NEW.state = 'cleaned')
)
BEGIN
  SELECT RAISE(ABORT, 'illegal temporary provider operation transition');
END;

CREATE TRIGGER IF NOT EXISTS temporary_provider_operation_no_delete
BEFORE DELETE ON temporary_provider_operations
BEGIN
  SELECT RAISE(ABORT, 'temporary provider operation history is durable');
END;
