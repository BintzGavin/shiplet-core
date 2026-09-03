ALTER TABLE managed_runtime_state_entries
ADD COLUMN last_operation_id TEXT;

ALTER TABLE managed_revisions
ADD COLUMN stage_operation_id TEXT;

ALTER TABLE managed_revisions
ADD COLUMN stage_lease_id TEXT;

ALTER TABLE managed_revisions
ADD COLUMN stage_lease_expires_on TEXT;

CREATE INDEX IF NOT EXISTS idx_managed_revisions_stage_lease
ON managed_revisions(stage_status, stage_lease_expires_on);
