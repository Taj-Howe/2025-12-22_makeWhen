# Staging/Prod Auth + Sync Rollout

Goal: get browser app + auth + sync DB working end-to-end for real users.

## Exact env vars

### Sync server (`apps/sync-server/.env`)

```bash
PORT=8787
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB_NAME
AUTH_MODE=oauth
CORS_ORIGIN=https://app-staging.makewhen.example

SYNC_MAX_BODY_BYTES=262144
SYNC_MAX_BATCH_OPS=500
SYNC_RATE_LIMIT_WINDOW_MS=60000
SYNC_RATE_LIMIT_IP=180
SYNC_RATE_LIMIT_USER=240
SYNC_RATE_LIMIT_TEAM=320

AUTH_SESSION_TTL_HOURS=720
AUTH_COOKIE_SECURE=true

OAUTH_AUTHORIZE_URL=https://YOUR_PROVIDER/authorize
OAUTH_TOKEN_URL=https://YOUR_PROVIDER/token
OAUTH_USERINFO_URL=https://YOUR_PROVIDER/userinfo
OAUTH_CLIENT_ID=YOUR_CLIENT_ID
OAUTH_CLIENT_SECRET=YOUR_CLIENT_SECRET
OAUTH_REDIRECT_URI=https://sync-staging.makewhen.example/auth/oauth/callback
OAUTH_SCOPE=openid profile email

OAUTH_DEFAULT_TEAM_ID=team_default
OAUTH_DEFAULT_TEAM_NAME=Default Team
OAUTH_DEFAULT_ROLE=editor
```

### Browser app (`.env.local` for staging build)

```bash
VITE_AUTH_MODE=oauth
VITE_AUTH_REMOTE_BASE_URL=https://sync-staging.makewhen.example
VITE_AUTH_OAUTH_CALLBACK_PATH=/auth/callback

VITE_SYNC_MODE=remote
VITE_SYNC_REMOTE_BASE_URL=https://sync-staging.makewhen.example
```

## Staging: next 10 commands

Run from repo root unless noted.

1. `git checkout codex/auth-team-foundation`
2. `pnpm install`
3. `cp apps/sync-server/.env.example apps/sync-server/.env`
4. `pnpm --dir apps/sync-server migrate`
5. `pnpm --dir apps/sync-server verify`
6. `pnpm --dir apps/sync-server dev`
7. `cat > .env.local <<'EOF'\nVITE_AUTH_MODE=oauth\nVITE_AUTH_REMOTE_BASE_URL=https://sync-staging.makewhen.example\nVITE_AUTH_OAUTH_CALLBACK_PATH=/auth/callback\nVITE_SYNC_MODE=remote\nVITE_SYNC_REMOTE_BASE_URL=https://sync-staging.makewhen.example\nEOF`
8. `pnpm dev`
9. `pnpm -s verify`
10. `pnpm --dir apps/sync-server e2e`

Notes:
- Command 6 and command 8 should run in separate terminals.
- Before command 4, fill `apps/sync-server/.env` with real staging values above.

## Production promote: 10 commands

1. `git checkout master`
2. `git pull origin master`
3. `pnpm install`
4. `pnpm -s verify`
5. `cp apps/sync-server/.env.example apps/sync-server/.env`
6. `pnpm --dir apps/sync-server migrate`
7. `pnpm --dir apps/sync-server verify`
8. `pnpm --dir apps/sync-server start`
9. `pnpm -s build`
10. `pnpm --dir apps/sync-server e2e`

Notes:
- Use production env values in `apps/sync-server/.env` and production frontend env in your deploy system.
- OAuth provider must include exact production callback URL:
  `https://sync.makewhen.example/auth/oauth/callback`

## Go/no-go quick checks (must pass)

- Auth:
  - Login redirects to provider and returns to app.
  - `GET /auth/session` returns `authenticated: true` after login.
- Sync:
  - New task on Browser A appears on Browser B after sync.
  - No cross-team access.
- Ops:
  - `GET /health/live` is `200`.
  - `GET /health/ready` is `200`.
  - `/admin/metrics?team_id=...` accessible for owner and shows counters.
