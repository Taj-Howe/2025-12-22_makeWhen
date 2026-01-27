CREATE INDEX IF NOT EXISTS idx_items_title_nocase
  ON items(title COLLATE NOCASE);
