CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS team_seq (
  team_id TEXT PRIMARY KEY REFERENCES teams(team_id) ON DELETE CASCADE,
  latest_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_oplog (
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  server_seq BIGINT NOT NULL,
  op_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  client_id TEXT,
  created_at BIGINT NOT NULL,
  op_name TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, server_seq),
  UNIQUE (team_id, op_id)
);

CREATE INDEX IF NOT EXISTS idx_team_oplog_team_received_at
  ON team_oplog(team_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_oplog_team_op_name
  ON team_oplog(team_id, op_name);
