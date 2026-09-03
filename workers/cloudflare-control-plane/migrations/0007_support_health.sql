CREATE TABLE IF NOT EXISTS credential_continuity (
  sentinel_id TEXT PRIMARY KEY CHECK (sentinel_id = 'credential-root-v1'),
  purpose TEXT NOT NULL CHECK (purpose = 'credential_continuity'),
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_on TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS credential_continuity_immutable
BEFORE UPDATE ON credential_continuity
BEGIN
  SELECT RAISE(ABORT, 'credential continuity evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS credential_continuity_no_delete
BEFORE DELETE ON credential_continuity
BEGIN
  SELECT RAISE(ABORT, 'credential continuity evidence is immutable');
END;

CREATE TABLE IF NOT EXISTS support_reconciliation_runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failure')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error_code TEXT,
  cleanup_pending INTEGER,
  revocation_pending INTEGER,
  temporary_ambiguous INTEGER,
  temporary_ambiguity_expired INTEGER,
  CHECK (
    (status = 'running' AND completed_at IS NULL AND error_code IS NULL)
    OR (status = 'success' AND completed_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failure' AND completed_at IS NOT NULL
      AND error_code = 'scheduled_reconciliation_failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_support_reconciliation_runs_latest
  ON support_reconciliation_runs(started_at DESC, run_id);

CREATE TRIGGER IF NOT EXISTS support_reconciliation_run_binding_immutable
BEFORE UPDATE ON support_reconciliation_runs
WHEN NEW.run_id != OLD.run_id
  OR NEW.started_at != OLD.started_at
  OR OLD.status != 'running'
  OR NEW.status NOT IN ('success', 'failure')
BEGIN
  SELECT RAISE(ABORT, 'support reconciliation evidence is immutable');
END;
