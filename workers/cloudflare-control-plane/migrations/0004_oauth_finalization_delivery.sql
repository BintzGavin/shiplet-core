ALTER TABLE oauth_flows ADD COLUMN delivery_handle_digest TEXT;
ALTER TABLE oauth_flows ADD COLUMN delivery_expires_at INTEGER;
ALTER TABLE oauth_flows ADD COLUMN delivery_result_json TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_flows_delivery_handle
  ON oauth_flows(delivery_handle_digest)
  WHERE delivery_handle_digest IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_flows_unacknowledged_delivery
  ON oauth_flows(status, delivery_expires_at)
  WHERE status = 'completed' AND delivery_handle_digest IS NOT NULL;
