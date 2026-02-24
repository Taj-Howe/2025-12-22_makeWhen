CREATE TABLE IF NOT EXISTS client_info (
  client_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS op_outbox (
  op_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  op_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  last_error TEXT,
  server_seq INTEGER
);

CREATE INDEX IF NOT EXISTS idx_op_outbox_team_status_created
  ON op_outbox(team_id, status, created_at);

CREATE TABLE IF NOT EXISTS op_applied (
  team_id TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY(team_id, server_seq)
);
