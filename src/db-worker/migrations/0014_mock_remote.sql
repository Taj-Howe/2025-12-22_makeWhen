CREATE TABLE IF NOT EXISTS mock_remote_oplog (
  team_id TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  op_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(team_id, server_seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mock_remote_oplog_team_op_id
  ON mock_remote_oplog(team_id, op_id);
