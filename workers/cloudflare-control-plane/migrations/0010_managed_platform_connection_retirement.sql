CREATE TABLE IF NOT EXISTS managed_platform_connection_retirements (
  operation_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose = 'managed_wfp_provider'),
  reservation_operation_id TEXT NOT NULL UNIQUE,
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  retired_at INTEGER NOT NULL,
  created_on TEXT NOT NULL,
  FOREIGN KEY (reservation_operation_id)
    REFERENCES managed_platform_connection_reservations(operation_id)
);

CREATE INDEX IF NOT EXISTS idx_managed_platform_retirement_binding
  ON managed_platform_connection_retirements(
    connection_id, account_id, user_id, purpose
  );

CREATE TABLE IF NOT EXISTS managed_platform_operation_leases (
  operation_id TEXT PRIMARY KEY,
  reservation_operation_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released')),
  acquired_at INTEGER NOT NULL,
  released_at INTEGER,
  created_on TEXT NOT NULL,
  FOREIGN KEY (operation_id)
    REFERENCES managed_deployment_operations(operation_id),
  FOREIGN KEY (reservation_operation_id)
    REFERENCES managed_platform_connection_reservations(operation_id),
  CHECK (
    (status = 'active' AND released_at IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_managed_platform_operation_lease_authority
  ON managed_platform_operation_leases(
    reservation_operation_id, connection_id, account_id, user_id, status
  );

-- An operation already applying when this additive migration lands has an
-- ambiguous provider outcome. Fence retirement until the exact operation is
-- reconciled by the new broker rather than assuming the provider did nothing.
INSERT OR IGNORE INTO managed_platform_operation_leases (
  operation_id, reservation_operation_id, connection_id, account_id, user_id,
  status, acquired_at, released_at, created_on
)
SELECT operation.operation_id, reservation.operation_id,
       reservation.connection_id, reservation.account_id, reservation.user_id,
       'active',
       COALESCE(CAST(strftime('%s', operation.applying_on) AS INTEGER) * 1000, 0),
       NULL, operation.applying_on
FROM managed_deployment_operations operation
JOIN managed_platform_connection_reservations reservation
  ON reservation.account_id = operation.account_id
 AND reservation.purpose = 'managed_wfp_provider'
 AND reservation.status = 'active'
WHERE operation.status = 'applying'
  AND operation.applying_on IS NOT NULL
  AND operation.succeeded_on IS NULL;

CREATE TRIGGER IF NOT EXISTS managed_platform_retirement_immutable
BEFORE UPDATE ON managed_platform_connection_retirements
BEGIN
  SELECT RAISE(ABORT, 'managed platform retirement is immutable');
END;

CREATE TRIGGER IF NOT EXISTS managed_platform_retirement_no_delete
BEFORE DELETE ON managed_platform_connection_retirements
BEGIN
  SELECT RAISE(ABORT, 'managed platform retirement history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS managed_platform_retirement_exact_binding
BEFORE INSERT ON managed_platform_connection_retirements
WHEN NOT EXISTS (
  SELECT 1 FROM managed_platform_connection_reservations reservation
  WHERE reservation.operation_id = NEW.reservation_operation_id
    AND reservation.purpose = NEW.purpose
    AND reservation.connection_id = NEW.connection_id
    AND reservation.account_id = NEW.account_id
    AND reservation.user_id = NEW.user_id
    AND reservation.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'managed platform retirement binding is invalid');
END;

CREATE TRIGGER IF NOT EXISTS managed_platform_retirement_no_active_lease
BEFORE INSERT ON managed_platform_connection_retirements
WHEN EXISTS (
  SELECT 1 FROM managed_platform_operation_leases lease
  WHERE lease.reservation_operation_id = NEW.reservation_operation_id
    AND lease.connection_id = NEW.connection_id
    AND lease.account_id = NEW.account_id
    AND lease.user_id = NEW.user_id
    AND lease.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'managed platform retirement has an in-flight operation');
END;

CREATE TRIGGER IF NOT EXISTS managed_platform_reservation_retirement_guard
BEFORE UPDATE OF status ON managed_platform_connection_reservations
WHEN OLD.status = 'active' AND NEW.status = 'retired'
  AND NOT EXISTS (
    SELECT 1 FROM managed_platform_connection_retirements retirement
    WHERE retirement.reservation_operation_id = OLD.operation_id
      AND retirement.purpose = OLD.purpose
      AND retirement.connection_id = OLD.connection_id
      AND retirement.account_id = OLD.account_id
      AND retirement.user_id = OLD.user_id
  )
BEGIN
  SELECT RAISE(ABORT, 'managed platform retirement evidence is required');
END;

CREATE TRIGGER IF NOT EXISTS managed_platform_operation_lease_immutable
BEFORE UPDATE ON managed_platform_operation_leases
WHEN NEW.operation_id != OLD.operation_id
  OR NEW.reservation_operation_id != OLD.reservation_operation_id
  OR NEW.connection_id != OLD.connection_id
  OR NEW.account_id != OLD.account_id
  OR NEW.user_id != OLD.user_id
  OR NEW.acquired_at != OLD.acquired_at
  OR NEW.created_on != OLD.created_on
  OR OLD.status != 'active'
  OR NEW.status != 'released'
  OR OLD.released_at IS NOT NULL
  OR NEW.released_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'managed platform operation lease is immutable');
END;

CREATE TRIGGER IF NOT EXISTS managed_platform_operation_lease_no_delete
BEFORE DELETE ON managed_platform_operation_leases
BEGIN
  SELECT RAISE(ABORT, 'managed platform operation lease history is immutable');
END;
