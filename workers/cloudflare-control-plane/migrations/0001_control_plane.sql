PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS encrypted_records (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'cleanup')),
  expires_at INTEGER,
  created_on TEXT NOT NULL,
  retired_on TEXT
);

CREATE TABLE IF NOT EXISTS oauth_flows (
  state_digest TEXT PRIMARY KEY,
  shiplet_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_binding_digest TEXT NOT NULL,
  expected_account_id TEXT,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'consumed', 'denied')),
  connection_id TEXT,
  created_on TEXT NOT NULL,
  completed_on TEXT,
  consumed_on TEXT
);

CREATE TABLE IF NOT EXISTS cloudflare_oauth_state_refs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_binding_digest TEXT NOT NULL,
  redirect_uri_digest TEXT NOT NULL,
  secret_ref TEXT,
  expires_at INTEGER NOT NULL,
  created_on TEXT NOT NULL,
  consumed_on TEXT
);

CREATE TABLE IF NOT EXISTS cloudflare_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revoked_at INTEGER,
  generation INTEGER NOT NULL,
  created_on TEXT NOT NULL,
  refreshed_at INTEGER,
  FOREIGN KEY (credential_ref) REFERENCES encrypted_records(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloudflare_connections_active_account
  ON cloudflare_connections(user_id, account_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS cloudflare_refresh_reservations (
  connection_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_on TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES cloudflare_connections(id)
);

CREATE TABLE IF NOT EXISTS cloudflare_control_audit_outbox (
  id TEXT PRIMARY KEY,
  event_json TEXT NOT NULL,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'delivered')),
  created_on TEXT NOT NULL,
  delivered_on TEXT
);

CREATE TABLE IF NOT EXISTS grant_consumptions (
  grant_digest TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_on TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES cloudflare_connections(id)
);

CREATE TABLE IF NOT EXISTS temporary_grant_consumptions (
  grant_digest TEXT PRIMARY KEY,
  handle_digest TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN (
    'temporary.deployment.create',
    'temporary.deployment.cleanup'
  )),
  expires_at INTEGER NOT NULL,
  consumed_on TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS temporary_deployments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  account_id TEXT NOT NULL,
  script_name TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  provider_deployment_id TEXT NOT NULL UNIQUE,
  provider_version_id TEXT NOT NULL,
  workers_dev_url TEXT NOT NULL,
  authorization_ref TEXT,
  claim_ref TEXT,
  account_expires_at INTEGER NOT NULL,
  claim_expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'claim_delivered', 'expired', 'cleaned')),
  created_on TEXT NOT NULL,
  claim_delivered_on TEXT,
  cleaned_on TEXT,
  FOREIGN KEY (authorization_ref) REFERENCES encrypted_records(id),
  FOREIGN KEY (claim_ref) REFERENCES encrypted_records(id)
);

CREATE TABLE IF NOT EXISTS backend_redirects (
  handle_digest TEXT PRIMARY KEY,
  temporary_deployment_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_on TEXT,
  created_on TEXT NOT NULL,
  FOREIGN KEY (temporary_deployment_id) REFERENCES temporary_deployments(id)
);

CREATE TABLE IF NOT EXISTS control_audit_outbox (
  id TEXT PRIMARY KEY,
  event_json TEXT NOT NULL,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'delivered')),
  created_on TEXT NOT NULL,
  delivered_on TEXT
);

CREATE TRIGGER IF NOT EXISTS control_audit_content_immutable
BEFORE UPDATE ON control_audit_outbox
WHEN NEW.id != OLD.id
  OR NEW.event_json != OLD.event_json
  OR NEW.created_on != OLD.created_on
  OR OLD.delivery_status != 'pending'
  OR NEW.delivery_status != 'delivered'
BEGIN
  SELECT RAISE(ABORT, 'control audit content is immutable');
END;

CREATE TRIGGER IF NOT EXISTS cloudflare_oauth_state_refs_binding_immutable
BEFORE UPDATE ON cloudflare_oauth_state_refs
WHEN NEW.id != OLD.id
  OR NEW.user_id != OLD.user_id
  OR NEW.session_binding_digest != OLD.session_binding_digest
  OR NEW.redirect_uri_digest != OLD.redirect_uri_digest
  OR NEW.expires_at != OLD.expires_at
  OR NEW.created_on != OLD.created_on
BEGIN
  SELECT RAISE(ABORT, 'OAuth state binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS cloudflare_control_audit_content_immutable
BEFORE UPDATE ON cloudflare_control_audit_outbox
WHEN NEW.id != OLD.id
  OR NEW.event_json != OLD.event_json
  OR NEW.created_on != OLD.created_on
  OR OLD.delivery_status != 'pending'
  OR NEW.delivery_status != 'delivered'
BEGIN
  SELECT RAISE(ABORT, 'Cloudflare audit content is immutable');
END;

CREATE TRIGGER IF NOT EXISTS cloudflare_control_audit_no_delete
BEFORE DELETE ON cloudflare_control_audit_outbox
BEGIN
  SELECT RAISE(ABORT, 'Cloudflare audit history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS control_audit_no_delete
BEFORE DELETE ON control_audit_outbox
BEGIN
  SELECT RAISE(ABORT, 'control audit history is immutable');
END;
