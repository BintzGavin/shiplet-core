ALTER TABLE oauth_flows ADD COLUMN exchange_started_on TEXT;
ALTER TABLE oauth_flows ADD COLUMN exchange_committed_on TEXT;
ALTER TABLE oauth_flows ADD COLUMN exchange_ambiguity_on TEXT;
ALTER TABLE oauth_flows ADD COLUMN return_key TEXT;

CREATE INDEX IF NOT EXISTS idx_oauth_flows_exchange_recovery
  ON oauth_flows(status, expires_at, exchange_started_on)
  WHERE status = 'pending' AND exchange_started_on IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_flows_return_key
  ON oauth_flows(return_key)
  WHERE return_key IS NOT NULL;
