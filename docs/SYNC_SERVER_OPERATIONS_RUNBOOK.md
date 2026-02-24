# Sync Server Operations Runbook

## Scope

This runbook covers production operations for sync/auth paths in `apps/sync-server`.

## Telemetry Inventory

### Metrics

| Metric | Description | Source |
|---|---|---|
| `push_success_total` | Count of successful `POST /sync/push` requests | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/observability/metrics.ts` |
| `push_failure_total` | Count of failed `POST /sync/push` requests (4xx/5xx) | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/observability/metrics.ts` |
| `pull_success_total` | Count of successful `GET /sync/pull` requests | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/observability/metrics.ts` |
| `pull_failure_total` | Count of failed `GET /sync/pull` requests (4xx/5xx) | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/observability/metrics.ts` |
| `auth_failure_total` | Count of unauthenticated requests | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/observability/metrics.ts` |
| `rejected_ops_by_reason[]` | Per-reason rejected op counts (for example `unknown_op`, `validation_failed`, `cross_team_access`) | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/observability/metrics.ts` |
| `queue_lag_proxy[]` | Per-team lag proxy based on pull cursor (`latest_seq - since_seq`) with `last`, `max`, `avg` | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/observability/metrics.ts` |

### Structured Events

| Event | Trigger | Required correlation fields | Source |
|---|---|---|---|
| `sync_pull_succeeded` | Successful `GET /sync/pull` | `request_id`, `endpoint`, `user_id`, `team_id` | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/routes/sync.ts` |
| `sync_push_succeeded` | Successful `POST /sync/push` | `request_id`, `endpoint`, `user_id`, `team_id` | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/routes/sync.ts` |
| `admin_metrics_viewed` | Access to `GET /admin/metrics` | `request_id`, `endpoint`, `user_id`, `team_id` | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/routes/admin.ts` |
| `auth_failure` | Missing/invalid session | `request_id`, `endpoint` | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/app.ts` |
| `authz_denied` | Membership/role denied | `request_id`, `endpoint`, `user_id` | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/app.ts` |
| `rate_limited` | Request exceeded rate limits | `request_id`, `endpoint`, `user_id` (if known) | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/app.ts` |
| `csrf_failed` | Cookie-auth write missing/invalid CSRF token | `request_id`, `endpoint`, `user_id` (if known) | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/app.ts` |
| `op_rejected` | Individual push op rejected | `request_id`, `endpoint`, `user_id`, `team_id`, `op_id`, `reason_code` | `/Users/tajhowe/Dropbox/Personal/Coding Projects/2025-12-22_makeWhen/apps/sync-server/src/routes/sync.ts` |

## Alert Thresholds

| Alert | Threshold | Window | Severity | Action |
|---|---|---|---|---|
| Sync error-rate spike | `(push_failure + pull_failure) / (push_success + pull_success + failures) > 5%` | 5 min | P1 | Start incident triage, check recent deploy/config changes |
| Rejected-op spike | `rejected_ops_by_reason.total > 50` or `> 10% of push ops` | 10 min | P1 | Inspect `op_rejected` reasons, check client/server contract drift |
| Auth failure surge | `auth_failure_total` rate > 30/min and at least 3x 1h baseline | 10 min | P2 | Check auth provider/session expiry/cookie settings |
| Lag growth | `queue_lag_proxy.max > 500` for a team | 15 min | P2 | Check pull cadence, server load, and failed push backlog |

## Admin Debug Endpoint

- Endpoint: `GET /admin/metrics?team_id=<team_id>`
- Access: authenticated `owner` of target team.
- Use this endpoint during incidents to inspect in-memory counters and lag proxy quickly.

## Incident Triage

1. Confirm scope: affected teams, endpoints (`/sync/push`, `/sync/pull`), and start time.
2. Pull recent structured logs by `request_id`, `team_id`, and event type.
3. Check `GET /health/ready`; if failing, treat as DB incident first.
4. Query `GET /admin/metrics?team_id=<team_id>` for hot-path counters and lag proxy.
5. Classify incident:
   - auth/session incident (`auth_failure`, `csrf_failed`)
   - authorization incident (`authz_denied`)
   - payload contract drift (`op_rejected`, `validation_failed`, `unknown_op`)
   - traffic overload (`rate_limited`, elevated failures)
6. Mitigate according to known failure modes below.

## Rollback Steps

1. Identify last known-good server revision/commit.
2. Deploy previous revision.
3. Run smoke verification:
   - `pnpm --dir apps/sync-server smoke`
4. Confirm:
   - `GET /health/live` is 200
   - `GET /health/ready` is 200 (with DB configured)
   - sync failures and rejected-op spikes return to baseline.

## DB Restore Steps (Postgres)

1. Put sync service in maintenance mode or stop write traffic.
2. Restore from most recent verified backup to a restore target DB.
3. Validate schema and constraints:
   - `team_oplog` has `PRIMARY KEY (team_id, server_seq)`
   - `team_oplog` has `UNIQUE (team_id, op_id)`
4. Run migration status check:
   - `pnpm --dir apps/sync-server migrate`
5. Point service to restored DB and re-run smoke checks.
6. Resume traffic and monitor alert thresholds for 30 minutes.

## Known Failure Modes and Mitigations

| Failure mode | Symptoms | Mitigation |
|---|---|---|
| Client/server op schema drift | `op_rejected` with `unknown_op` or `validation_failed` spikes | Roll back client or deploy server validator update; keep allowlist aligned with contract |
| Session cookie misconfiguration | `auth_failure` surge, users appear logged out | Verify cookie domain, `Secure`, `SameSite`, CSRF header propagation |
| Role/membership mismatch | `authz_denied` spikes for writes | Confirm `team_members` rows and role assignments (`owner/editor/viewer`) |
| Traffic burst / abuse | `RATE_LIMITED` errors increase | Temporarily raise `SYNC_RATE_LIMIT_*` thresholds, add edge rate limiting, identify abusive keys |
| Pull lag growth | Increasing `queue_lag_proxy.max` | Validate pull frequency, check backend latency and failed pushes |
| DB connectivity degradation | `/health/ready` failing | Fail over DB, restore connectivity, then verify migrations and sync paths |

## Verification Command

- `pnpm -s verify`
