CREATE TABLE IF NOT EXISTS running_timers (
  item_id TEXT PRIMARY KEY,
  start_at INTEGER NOT NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_running_timers_start_at ON running_timers(start_at);
