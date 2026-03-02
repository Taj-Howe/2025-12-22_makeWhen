# Staging/Prod Auth + Sync Rollout (Clerk + Neon)

Goal: launch browser beta with Clerk auth, Neon-backed sync, and invite-based team collaboration.

## Env Vars

### Sync server (`apps/sync-server/.env`)

```bash
PORT=8787
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB_NAME
AUTH_MODE=clerk
CORS_ORIGIN=https://app-staging.makewhen.example

CLERK_SECRET_KEY=sk_live_or_test
# Optional hardening:
# CLERK_AUTHORIZED_PARTIES=https://app-staging.makewhen.example
# CLERK_AUDIENCE=
# CLERK_JWT_KEY=
# CLERK_JWT_ISSUER=

AUTH_DEFAULT_TEAM_ID=team_default
AUTH_DEFAULT_TEAM_NAME=Default Team
AUTH_DEFAULT_TEAM_ROLE=editor

SYNC_MAX_BODY_BYTES=262144
SYNC_MAX_BATCH_OPS=500
SYNC_RATE_LIMIT_WINDOW_MS=60000
SYNC_RATE_LIMIT_IP=180
SYNC_RATE_LIMIT_USER=240
SYNC_RATE_LIMIT_TEAM=320

AUTH_SESSION_TTL_HOURS=720
AUTH_COOKIE_SECURE=true
```

### Browser app (`.env.local`)

```bash
VITE_AUTH_MODE=clerk
VITE_CLERK_PUBLISHABLE_KEY=pk_live_or_test
VITE_AUTH_REMOTE_BASE_URL=https://sync-staging.makewhen.example

VITE_SYNC_MODE=remote
VITE_SYNC_REMOTE_BASE_URL=https://sync-staging.makewhen.example
```

## Staging Runbook

1. `git checkout codex/auth-team-foundation`
2. `pnpm install`
3. `cp apps/sync-server/.env.example apps/sync-server/.env`
4. Fill `apps/sync-server/.env` with staging values.
5. `pnpm --dir apps/sync-server migrate`
6. `pnpm --dir apps/sync-server verify`
7. `pnpm --dir apps/sync-server dev`
8. Set browser env vars in `.env.local`.
9. `pnpm dev`
10. `pnpm -s verify`

## Required Scenario Matrix

- Clerk sign-in:
  - App starts signed-out.
  - Clerk sign-in completes.
  - `POST /auth/clerk/exchange` sets app session cookie.
  - `GET /auth/session` returns `authenticated: true`.
- Sync:
  - Browser A creates task -> sync push.
  - Browser B pulls -> task appears.
- Invites:
  - Owner/editor creates invite.
  - Second Clerk account accepts invite token.
  - Invitee can read/write based on role.
- Security:
  - Cross-team access denied.
  - Viewer write denied.
  - Invalid payload rejected.

## Production Promote

1. `git checkout master`
2. `git pull origin master`
3. `pnpm install`
4. `pnpm -s verify`
5. Configure production env for sync server + browser.
6. `pnpm --dir apps/sync-server migrate`
7. `pnpm --dir apps/sync-server verify`
8. Deploy/start sync server.
9. Deploy browser build.
10. Run two-account smoke scenarios in production.

## Go/No-Go

Go if all pass:

- `/health/live` and `/health/ready` return `200`.
- Clerk exchange/session works end-to-end.
- Sync push/pull works across two browsers.
- Invite creation + acceptance works.
- No elevated auth/security errors in metrics/logs.
