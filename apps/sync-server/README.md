# Sync Server

Minimal production sync server scaffold for MakeWhen.

This scaffold uses Node's built-in HTTP server and `psql` CLI for DB checks/migrations so it can run in constrained/offline environments.
You can swap the transport layer to Fastify later without changing schema/migration contracts.

## Environment

Copy `.env.example` to `.env` and set values:

- `PORT` server port (default `8787`)
- `DATABASE_URL` Postgres connection string (required for DB ready/migrations)
- `AUTH_MODE` `local` or `oauth` (default `local`)
- `CORS_ORIGIN` allowed browser origin (default `*`)
- `SYNC_MAX_BODY_BYTES` max request body size in bytes for sync writes (default `262144`)
- `SYNC_MAX_BATCH_OPS` max ops per push request (default `500`)
- `SYNC_RATE_LIMIT_WINDOW_MS` fixed window size for sync rate limiting (default `60000`)
- `SYNC_RATE_LIMIT_IP` max sync requests per window per IP (default `180`)
- `SYNC_RATE_LIMIT_USER` max sync requests per window per user (default `240`)
- `SYNC_RATE_LIMIT_TEAM` max sync requests per window per team (default `320`)
- `AUTH_SESSION_TTL_HOURS` session lifetime for auth cookies/tokens (default `720`)
- `AUTH_COOKIE_SECURE` force secure cookies: `true|false` (default auto: true except localhost)
- `OAUTH_AUTHORIZE_URL` OAuth authorize endpoint (optional in dev)
- `OAUTH_TOKEN_URL` OAuth token endpoint (optional in dev)
- `OAUTH_USERINFO_URL` OAuth userinfo endpoint (required for provider mode)
- `OAUTH_CLIENT_ID` OAuth client id
- `OAUTH_CLIENT_SECRET` OAuth client secret
- `OAUTH_REDIRECT_URI` callback URL on sync server (default `http://127.0.0.1:8787/auth/oauth/callback`)
- `OAUTH_SCOPE` OAuth scope string (default `openid profile email`)
- `OAUTH_DEFAULT_TEAM_ID` team assigned to authenticated users (default `team_default`)
- `OAUTH_DEFAULT_TEAM_NAME` display name for default team (default `Default Team`)
- `OAUTH_DEFAULT_ROLE` role for default membership (`owner|editor|viewer`, default `editor`)
- `OAUTH_DEV_USER_ID` dev fallback user id for oauth mode without provider config
- `OAUTH_DEV_USER_NAME` dev fallback display name
- `OAUTH_DEV_USER_EMAIL` dev fallback email

## Commands

From repo root:

```bash
pnpm --dir apps/sync-server dev
pnpm --dir apps/sync-server migrate
pnpm --dir apps/sync-server smoke
pnpm --dir apps/sync-server e2e
```

Health endpoints:

- `GET /health/live`
- `GET /health/ready`
- `GET /sync/pull?team_id=<team_id>` (auth required)
- `POST /sync/push` (auth + editor/owner required)
- `GET /admin/metrics?team_id=<team_id>` (auth + owner required)
- `GET /auth/session` (current server-backed auth session)
- `GET /auth/oauth/start` (start OAuth flow)
- `GET /auth/oauth/callback` (OAuth callback endpoint)
- `POST /auth/logout` (revoke session + clear auth cookies)

Build/start placeholders:

```bash
pnpm --dir apps/sync-server build
pnpm --dir apps/sync-server start
```

`/health/ready` checks DB connectivity (`SELECT 1`).
If `DATABASE_URL` is missing, `/health/ready` returns `503` with a reason.

## Auth assumptions (current)

- Sync endpoints require a session token from `Authorization: Bearer <session_id>` or `Cookie: mw_session=<session_id>`.
- Session is resolved from `sessions.session_id` and must not be revoked/expired.
- OAuth mode keeps server session as authority (`/auth/session`) and browser app bootstraps local worker session from that response.
- Team authorization is centralized in `src/auth/authz.ts`.
- Membership is required for all sync reads (`requireTeamMember`).
- Write operations require at least `editor` role (`requireRoleAtLeast`).
- Role order is `owner > editor > viewer`.
- Cookie-authenticated writes require CSRF double-submit:
- cookie: `mw_csrf=<token>`
- header: `X-CSRF-Token: <same token>`
- Session cookie policy (when server sets it) is `Secure; HttpOnly; SameSite=Lax; Path=/`.
- Pull query supports `since_seq` (default `0`) and `limit` (default `500`, max `5000`).
- When a pull is limited, continue by calling pull again with `since_seq` equal to the last returned `server_seq`.
- Admin metrics endpoint requires team `owner` role and returns in-memory operational counters for launch triage.

## Observability

- Correlation IDs:
- inbound `X-Request-Id` is honored when valid, otherwise server generates one.
- server returns `X-Request-Id` on all responses.
- structured logs include `request_id`, `endpoint`, and when available `user_id` + `team_id`.
- Metrics tracked in-memory:
- sync pull/push success and failure counters
- rejected ops grouped by reason code
- auth failure counter and per-minute rate
- queue lag proxy per team (`latest_seq - since_seq` observed on pull)

Push request body shape:

```json
{
  "team_id": "team_123",
  "client_id": "device_a",
  "ops": [
    {
      "op_id": "uuid",
      "team_id": "team_123",
      "actor_user_id": "user_1",
      "created_at": 1730000000000,
      "op_name": "create_item",
      "payload": {
        "id": "item_1",
        "project_id": "project_1",
        "type": "task"
      }
    }
  ]
}
```

## Migration tables and constraints

`migrations/0001_sync_schema.sql` creates:
- `teams`
- `users`
- `team_members`
- `sessions`
- `team_seq`
- `team_oplog`

Key constraints:
- `PRIMARY KEY (team_id, server_seq)` on `team_oplog`
- `UNIQUE (team_id, op_id)` on `team_oplog`

## E2E convergence harness

Run:

```bash
pnpm --dir apps/sync-server e2e
```

This runs a deterministic two-device simulation (`Device A` and `Device B`) against the sync HTTP handler and validates:

- create -> push/pull convergence
- scheduled block convergence with one-block-per-item invariant
- dependency convergence
- near-concurrent edits converging by last `server_seq`
- replay idempotency (`op_id` resend has no duplicate side effects)
