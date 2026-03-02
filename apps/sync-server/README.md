# Sync Server

Production sync/auth backend for MakeWhen browser beta.

- HTTP runtime: Node + TypeScript (`node --experimental-strip-types`)
- DB: Postgres (Neon-ready)
- Auth mode for this wave: `local` or `clerk`
- Collaboration model: team membership + invite links

## Environment

Copy `.env.example` to `.env` and set values:

- `PORT` server port (default `8787`)
- `DATABASE_URL` Postgres connection string
- `AUTH_MODE` `local` or `clerk` (default `local`)
- `CORS_ORIGIN` browser origin (default `*`)
- `CLERK_SECRET_KEY` required for `AUTH_MODE=clerk`
- `CLERK_AUTHORIZED_PARTIES` optional CSV of allowed audiences
- `CLERK_AUDIENCE` optional CSV audience validation values
- `CLERK_JWT_KEY` optional Clerk JWT verification key
- `CLERK_JWT_ISSUER` optional issuer marker (documented for ops)
- `AUTH_DEFAULT_TEAM_ID` default team for first-time Clerk exchange
- `AUTH_DEFAULT_TEAM_NAME` default team display name
- `AUTH_DEFAULT_TEAM_ROLE` default membership role (`owner|editor|viewer`)
- `SYNC_MAX_BODY_BYTES` max sync write body size (default `262144`)
- `SYNC_MAX_BATCH_OPS` max ops per push (default `500`)
- `SYNC_RATE_LIMIT_WINDOW_MS` fixed rate-limit window (default `60000`)
- `SYNC_RATE_LIMIT_IP` max sync reqs/window per IP (default `180`)
- `SYNC_RATE_LIMIT_USER` max sync reqs/window per user (default `240`)
- `SYNC_RATE_LIMIT_TEAM` max sync reqs/window per team (default `320`)
- `AUTH_SESSION_TTL_HOURS` session lifetime in hours (default `720`)
- `AUTH_COOKIE_SECURE` `true|false` override (default auto)

## Commands

From repo root:

```bash
pnpm --dir apps/sync-server migrate
pnpm --dir apps/sync-server dev
pnpm --dir apps/sync-server smoke
pnpm --dir apps/sync-server e2e
pnpm --dir apps/sync-server verify
```

## Core Endpoints

Health:

- `GET /health/live`
- `GET /health/ready`

Auth/session:

- `GET /auth/session`
- `POST /auth/clerk/exchange` (Clerk bearer JWT -> internal app session)
- `POST /auth/logout`

Sync:

- `POST /sync/push` (editor+)
- `GET /sync/pull?team_id=<id>&since_seq=<n>&limit=<n>` (viewer+)

Team collaboration:

- `GET /teams/:team_id/members`
- `GET /teams/:team_id/invites`
- `POST /teams/:team_id/invites`
- `POST /teams/:team_id/invites/:invite_id/revoke`
- `POST /invites/:invite_token/accept`

Admin metrics:

- `GET /admin/metrics?team_id=<id>` (owner)

## Auth Model

- Server issues internal `sessions.session_id` tokens and `mw_session` cookie.
- Browser app can use cookie auth or bearer (`Authorization: Bearer <session_id>`).
- Cookie-authenticated writes require CSRF double-submit:
  - cookie: `mw_csrf=<token>`
  - header: `X-CSRF-Token: <token>`
- Team boundary is enforced by `team_members` role checks:
  - `owner > editor > viewer`

## Notes

- `verify` runs smoke + deterministic sync e2e harness.
- If `DATABASE_URL` is missing, `/health/ready` returns `503` and migrations are skipped.
