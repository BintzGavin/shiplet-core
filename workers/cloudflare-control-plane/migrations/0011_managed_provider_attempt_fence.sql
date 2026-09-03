-- One applying operation is one provider dispatch attempt. A response can be
-- lost while Cloudflare is still committing the mutation, so neither a newer
-- Worker nor a rolled-back Worker may reclaim the row by moving its apply
-- timestamp and redispatching the same logical operation.
CREATE TRIGGER IF NOT EXISTS managed_deployment_apply_fence_immutable
BEFORE UPDATE OF applying_on ON managed_deployment_operations
WHEN OLD.status = 'applying'
  AND NOT (NEW.applying_on IS OLD.applying_on)
BEGIN
  SELECT RAISE(ABORT, 'managed deployment provider attempt is immutable');
END;

-- The shared platform reservation cannot be released until the exact provider
-- dispatch recorded by the lease has reached the operation's terminal state.
CREATE TRIGGER IF NOT EXISTS managed_platform_operation_lease_terminal_release
BEFORE UPDATE OF status ON managed_platform_operation_leases
WHEN OLD.status = 'active' AND NEW.status = 'released'
  AND NOT EXISTS (
    SELECT 1 FROM managed_deployment_operations operation
    WHERE operation.operation_id = OLD.operation_id
      AND operation.status = 'succeeded'
      AND operation.applying_on = OLD.created_on
      AND operation.succeeded_on IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'managed platform operation attempt is not terminal');
END;

-- Defense in depth: retirement is fenced by every exact dispatched operation,
-- not just by the lifecycle label on its shared authority lease.
CREATE TRIGGER IF NOT EXISTS managed_platform_retirement_no_dispatched_attempt
BEFORE INSERT ON managed_platform_connection_retirements
WHEN EXISTS (
  SELECT 1
  FROM managed_platform_operation_leases lease
  JOIN managed_deployment_operations operation
    ON operation.operation_id = lease.operation_id
  WHERE lease.reservation_operation_id = NEW.reservation_operation_id
    AND lease.connection_id = NEW.connection_id
    AND lease.account_id = NEW.account_id
    AND lease.user_id = NEW.user_id
    AND lease.status = 'active'
    AND operation.status = 'applying'
    AND operation.applying_on = lease.created_on
    AND operation.succeeded_on IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'managed platform retirement has a dispatched attempt');
END;
