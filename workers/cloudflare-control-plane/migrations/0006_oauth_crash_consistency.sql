CREATE TABLE IF NOT EXISTS oauth_provider_exchange_recoveries (
  connection_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  generation INTEGER NOT NULL,
  credential_ref TEXT NOT NULL UNIQUE,
  credential_expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'cleaning', 'attached', 'cleaned')),
  created_on TEXT NOT NULL,
  attached_on TEXT,
  provider_revoked_on TEXT,
  credential_retired_on TEXT,
  cleaned_on TEXT,
  last_attempt_on TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (credential_ref) REFERENCES encrypted_records(id)
);

CREATE TABLE IF NOT EXISTS oauth_start_reservations (
  id TEXT PRIMARY KEY,
  shiplet_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_binding_digest TEXT NOT NULL,
  expected_account_id TEXT,
  delivery_handle_digest TEXT NOT NULL UNIQUE,
  return_key TEXT NOT NULL UNIQUE,
  support_version_id TEXT NOT NULL,
  support_version_tag TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
  state_digest TEXT UNIQUE,
  created_on TEXT NOT NULL,
  consumed_on TEXT,
  released_on TEXT,
  CHECK (
    (status = 'reserved' AND state_digest IS NULL AND consumed_on IS NULL AND released_on IS NULL)
    OR (status = 'consumed' AND state_digest IS NOT NULL AND consumed_on IS NOT NULL AND released_on IS NULL)
    OR (status = 'released' AND state_digest IS NULL AND consumed_on IS NULL AND released_on IS NOT NULL)
  )
);

ALTER TABLE oauth_flows ADD COLUMN start_reservation_id TEXT
  REFERENCES oauth_start_reservations(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_flows_start_reservation
  ON oauth_flows(start_reservation_id)
  WHERE start_reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_start_reservations_scope_quota
  ON oauth_start_reservations(user_id, shiplet_id, status, expires_at, created_on);

CREATE INDEX IF NOT EXISTS idx_oauth_exchange_recovery_cleanup
  ON oauth_provider_exchange_recoveries(status, created_on, connection_id)
  WHERE status IN ('staged', 'cleaning');

CREATE INDEX IF NOT EXISTS idx_oauth_flows_scope_quota
  ON oauth_flows(user_id, shiplet_id, status, expires_at, created_on);

CREATE INDEX IF NOT EXISTS idx_oauth_state_retention
  ON cloudflare_oauth_state_refs(expires_at, consumed_on, created_on);

CREATE INDEX IF NOT EXISTS idx_encrypted_record_retention
  ON encrypted_records(status, purpose, retired_on, id)
  WHERE status = 'retired';

CREATE TRIGGER IF NOT EXISTS oauth_exchange_recovery_binding_immutable
BEFORE UPDATE ON oauth_provider_exchange_recoveries
WHEN NEW.connection_id != OLD.connection_id
  OR NEW.user_id != OLD.user_id
  OR NEW.account_id != OLD.account_id
  OR NEW.account_label != OLD.account_label
  OR NEW.scopes_json != OLD.scopes_json
  OR NEW.generation != OLD.generation
  OR NEW.credential_ref != OLD.credential_ref
  OR NEW.credential_expires_at != OLD.credential_expires_at
  OR NEW.created_on != OLD.created_on
  OR (OLD.attached_on IS NOT NULL AND NEW.attached_on IS NOT OLD.attached_on)
  OR (OLD.provider_revoked_on IS NOT NULL AND NEW.provider_revoked_on IS NOT OLD.provider_revoked_on)
  OR (OLD.credential_retired_on IS NOT NULL AND NEW.credential_retired_on IS NOT OLD.credential_retired_on)
  OR (OLD.cleaned_on IS NOT NULL AND NEW.cleaned_on IS NOT OLD.cleaned_on)
BEGIN
  SELECT RAISE(ABORT, 'OAuth exchange recovery binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS oauth_exchange_recovery_legal_transition
BEFORE UPDATE OF status ON oauth_provider_exchange_recoveries
WHEN NEW.status != OLD.status AND NOT (
  (OLD.status = 'staged' AND NEW.status IN ('cleaning', 'attached'))
  OR (OLD.status = 'cleaning' AND NEW.status = 'cleaned')
)
BEGIN
  SELECT RAISE(ABORT, 'illegal OAuth exchange recovery transition');
END;

CREATE TRIGGER IF NOT EXISTS oauth_start_reservation_binding_immutable
BEFORE UPDATE ON oauth_start_reservations
WHEN NEW.id != OLD.id
  OR NEW.shiplet_id != OLD.shiplet_id
  OR NEW.user_id != OLD.user_id
  OR NEW.session_binding_digest != OLD.session_binding_digest
  OR NEW.expected_account_id IS NOT OLD.expected_account_id
  OR NEW.delivery_handle_digest != OLD.delivery_handle_digest
  OR NEW.return_key != OLD.return_key
  OR NEW.support_version_id != OLD.support_version_id
  OR NEW.support_version_tag != OLD.support_version_tag
  OR NEW.expires_at != OLD.expires_at
  OR NEW.created_on != OLD.created_on
  OR (OLD.state_digest IS NOT NULL AND NEW.state_digest IS NOT OLD.state_digest)
  OR (OLD.consumed_on IS NOT NULL AND NEW.consumed_on IS NOT OLD.consumed_on)
  OR (OLD.released_on IS NOT NULL AND NEW.released_on IS NOT OLD.released_on)
BEGIN
  SELECT RAISE(ABORT, 'OAuth start reservation binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS oauth_start_reservation_legal_transition
BEFORE UPDATE OF status ON oauth_start_reservations
WHEN NEW.status != OLD.status AND NOT (
  OLD.status = 'reserved' AND NEW.status IN ('consumed', 'released')
)
BEGIN
  SELECT RAISE(ABORT, 'illegal OAuth start reservation transition');
END;
