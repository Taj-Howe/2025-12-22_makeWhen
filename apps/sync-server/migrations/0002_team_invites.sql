CREATE TABLE IF NOT EXISTS team_invites (
  invite_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  invitee_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')) DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_invites_team_status_created
  ON team_invites(team_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_team_invites_token_hash
  ON team_invites(token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_invites_pending_unique
  ON team_invites(team_id, invitee_email)
  WHERE status = 'pending';
