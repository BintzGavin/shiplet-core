CREATE TABLE IF NOT EXISTS managed_deployment_operations (
  operation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('upload', 'delete')),
  account_id TEXT NOT NULL,
  namespace_name TEXT NOT NULL CHECK (
    namespace_name IN ('shiplet-managed-staging', 'shiplet-managed-production')
  ),
  script_name TEXT NOT NULL,
  shiplet_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  operation_tag TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'applying', 'succeeded')),
  created_on TEXT NOT NULL,
  applying_on TEXT,
  succeeded_on TEXT,
  CHECK (
    (operation_kind = 'upload' AND operation_tag IS NOT NULL)
    OR (operation_kind = 'delete' AND operation_tag IS NULL)
  ),
  CHECK (
    (status = 'reserved' AND applying_on IS NULL AND succeeded_on IS NULL)
    OR (status = 'applying' AND applying_on IS NOT NULL AND succeeded_on IS NULL)
    OR (status = 'succeeded' AND applying_on IS NOT NULL AND succeeded_on IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_deployment_upload_owner
  ON managed_deployment_operations(account_id, namespace_name, script_name)
  WHERE operation_kind = 'upload';

CREATE INDEX IF NOT EXISTS idx_managed_deployment_identity
  ON managed_deployment_operations(
    account_id, namespace_name, script_name, shiplet_id, revision_id, package_digest,
    operation_kind, status
  );

CREATE TRIGGER IF NOT EXISTS managed_deployment_operation_binding_immutable
BEFORE UPDATE ON managed_deployment_operations
WHEN NEW.operation_id != OLD.operation_id
  OR NEW.operation_kind != OLD.operation_kind
  OR NEW.account_id != OLD.account_id
  OR NEW.namespace_name != OLD.namespace_name
  OR NEW.script_name != OLD.script_name
  OR NEW.shiplet_id != OLD.shiplet_id
  OR NEW.revision_id != OLD.revision_id
  OR NEW.package_digest != OLD.package_digest
  OR NEW.request_digest != OLD.request_digest
  OR COALESCE(NEW.operation_tag, '') != COALESCE(OLD.operation_tag, '')
  OR NEW.created_on != OLD.created_on
  OR OLD.status = 'succeeded'
  OR (OLD.status = 'applying' AND NEW.status NOT IN ('applying', 'succeeded'))
  OR (OLD.status = 'reserved' AND NEW.status != 'applying')
BEGIN
  SELECT RAISE(ABORT, 'managed deployment operation binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS managed_deployment_operation_no_delete
BEFORE DELETE ON managed_deployment_operations
BEGIN
  SELECT RAISE(ABORT, 'managed deployment operation history is immutable');
END;
