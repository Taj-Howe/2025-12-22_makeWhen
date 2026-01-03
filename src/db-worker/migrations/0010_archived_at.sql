ALTER TABLE items ADD COLUMN archived_at INTEGER NULL;
CREATE INDEX IF NOT EXISTS idx_items_archived_at ON items(archived_at);
