ALTER TABLE items ADD COLUMN completed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_items_completed_at ON items(completed_at);
