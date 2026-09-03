CREATE TABLE IF NOT EXISTS managed_platform_connection_reservations (
  operation_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose = 'managed_wfp_provider'),
  connection_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  reserved_at INTEGER NOT NULL,
  created_on TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_platform_active_purpose
  ON managed_platform_connection_reservations(purpose)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_managed_platform_active_binding
  ON managed_platform_connection_reservations(
    connection_id, account_id, user_id, purpose, status
  );

CREATE TRIGGER IF NOT EXISTS managed_platform_reservation_immutable
BEFORE UPDATE ON managed_platform_connection_reservations
WHEN NEW.operation_id != OLD.operation_id
  OR NEW.purpose != OLD.purpose
  OR NEW.connection_id != OLD.connection_id
  OR NEW.account_id != OLD.account_id
  OR NEW.user_id != OLD.user_id
  OR NEW.reserved_at != OLD.reserved_at
  OR NEW.created_on != OLD.created_on
  OR OLD.status != 'active'
  OR NEW.status != 'retired'
BEGIN
  SELECT RAISE(ABORT, 'managed platform reservation is immutable');
END;

CREATE TRIGGER IF NOT EXISTS managed_platform_reservation_no_delete
BEFORE DELETE ON managed_platform_connection_reservations
BEGIN
  SELECT RAISE(ABORT, 'managed platform reservation history is immutable');
END;
