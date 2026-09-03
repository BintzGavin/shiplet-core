ALTER TABLE managed_activations ADD COLUMN operation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_activations_operation_id
ON managed_activations(operation_id)
WHERE operation_id IS NOT NULL;
