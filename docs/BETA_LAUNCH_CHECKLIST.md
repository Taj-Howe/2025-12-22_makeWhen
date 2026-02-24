# Beta Launch Checklist

Purpose: controlled browser beta launch with explicit go/no-go gates, staged rollout controls, and rollback criteria.

## 1) Launch Ownership

| Function | Primary owner | Backup owner | Responsibilities |
|---|---|---|---|
| Release manager | Product lead | Engineering lead | Run go/no-go, approve rollout stage transitions |
| Sync backend | Backend lead | Full-stack engineer | Sync API health, oplog integrity, migration safety |
| Auth + permissions | Security lead | Backend lead | Auth/session health, team boundary enforcement |
| Client app quality | Frontend lead | Full-stack engineer | Browser UX regressions, onboarding flow quality |
| Operations/on-call | Ops lead | Backend lead | Alerts, incident command, rollback execution |
| Support triage | Support lead | Product lead | User bug intake, severity assignment, SLA tracking |
| Legal/privacy | Legal owner | Product lead | Terms/privacy readiness and response process |

## 2) Prelaunch Checks

All items must be checked before launch to external users.

### Auth

- [ ] Sign-in works for new and returning users in production environment.
- [ ] Sign-out revokes active session for subsequent API access.
- [ ] Expired/invalid session returns clear unauthenticated error.
- [ ] Team membership + role checks enforced for sync endpoints.
- [ ] Cookie/session settings validated (`Secure`, `HttpOnly`, `SameSite`, CSRF for cookie-auth writes).

### Sync

- [ ] `POST /sync/push` idempotency verified (`team_id + op_id`).
- [ ] `GET /sync/pull` ordering verified (strict ascending `server_seq`).
- [ ] Multi-device convergence test passes (A change appears on B).
- [ ] Duplicate/replay ops produce no duplicate side effects.
- [ ] Client retry/backoff behavior tested for intermittent network failure.

### Security

- [ ] Request schema validation enabled for push/pull payloads.
- [ ] Rate limits enabled (IP/user/team) and thresholds documented.
- [ ] Payload size + batch length limits enabled.
- [ ] Structured security logs include request/user/team context.
- [ ] Cross-team access attempts rejected and auditable.

### Operations

- [ ] `/health/live` and `/health/ready` integrated with monitoring.
- [ ] Metrics visible for push/pull success/failure, auth failures, rejected ops.
- [ ] Alert routing configured to on-call owner.
- [ ] Backup + restore drill completed successfully in staging or production-like env.
- [ ] Rollback playbook tested on current deployment path.

### Legal

- [ ] Privacy policy published and linked from app/site.
- [ ] Terms of service published and linked from app/site.
- [ ] Support contact channel published for beta users.
- [ ] Data handling statement for beta users reviewed.

## 3) Go / No-Go Criteria

### Go criteria

- [ ] All prelaunch checks complete.
- [ ] `pnpm -s verify` passes on launch candidate.
- [ ] Sync error-rate below 2% in prelaunch soak window (24h).
- [ ] No open P0/P1 defects affecting auth, sync integrity, or data loss.
- [ ] On-call schedule and incident commander assigned for launch window.

### No-go criteria

- [ ] Any unresolved P0 or unresolved security vulnerability with internet exposure risk.
- [ ] Sync convergence failure in latest E2E run.
- [ ] Auth outage risk (session validation instability) not mitigated.
- [ ] Monitoring/alerting coverage missing for sync/auth core paths.

## 4) Rollback Triggers And Owner

| Trigger | Threshold | Owner | Immediate action |
|---|---|---|---|
| Sync failure spike | `push/pull` failures > 5% for 10 min | Ops lead | Freeze rollout, initiate incident, evaluate rollback |
| Rejected-op surge | Rejected ops > 10% of pushes for 10 min | Backend lead | Inspect reason codes, disable new rollout cohort |
| Auth failure surge | Auth failures > 3x baseline for 10 min | Security lead | Validate session/cookie system, rollback auth changes if needed |
| Data integrity risk | Any reproducible data loss/cross-team access issue | Release manager | Immediate rollback and incident P0 |
| Major UX blocker | >20% of new beta users blocked in onboarding day 1 | Product lead | Pause expansion, hotfix or rollback |

Rollback decision authority: `Release manager` with `Ops lead` approval; either can declare emergency rollback for P0 events.

## 5) Staged Rollout Plan

### Stage 1: Internal (team-only)

- Cohort: internal contributors.
- Duration: 3-7 days.
- Entry criteria:
- prelaunch checks complete except legal external comms.
- success criteria:
- no P0/P1 for 72 hours, sync success >= 98%, auth success >= 99%.
- exit gate:
- release manager signs off after daily review checklist is clean for 3 consecutive days.

### Stage 2: Private beta (10-30 users)

- Cohort: invited design partners.
- Duration: 1-2 weeks.
- Entry criteria:
- Stage 1 success criteria met.
- success criteria:
- no confirmed data-loss incident, P1 volume < 3 open > 48h, onboarding completion >= 80%.
- exit gate:
- weekly review approves scale-up based on incidents and retention signal.

### Stage 3: Expanded beta

- Cohort: broader waiting list/users.
- Duration: ongoing until GA decision.
- Entry criteria:
- Stage 2 success criteria met + runbook exercised at least once.
- success criteria:
- stable error rates within thresholds for 14 days and support SLA compliance >= 95%.

## 6) Support Process

### Bug intake template

Use this template for every report:

- Reporter:
- Account/team id:
- Environment: (`browser`, OS, app version/build sha)
- Time observed (UTC):
- Severity guess: (`P0`, `P1`, `P2`, `P3`)
- What happened:
- Expected behavior:
- Repro steps:
- Attachments: (screenshots/video/log snippets/request id)
- Data impact: (`none`, `possible loss`, `confirmed loss`, `cross-team visibility`)

### Severity levels

| Severity | Definition | Examples |
|---|---|---|
| P0 | Critical trust/safety or outage | data loss, cross-team data leak, full auth outage |
| P1 | Major function broken, no safe workaround | sync consistently failing for active users |
| P2 | Important issue with workaround | intermittent failures, degraded UX |
| P3 | Minor defect | cosmetic issues, non-blocking copy/interaction bugs |

### SLA targets

| Severity | First response | Triage complete | Mitigation/fix target |
|---|---|---|---|
| P0 | 15 minutes | 30 minutes | same day / immediate mitigation |
| P1 | 1 hour | 4 hours | 24 hours |
| P2 | 1 business day | 2 business days | 5 business days |
| P3 | 2 business days | 5 business days | backlog/prioritized sprint |

## 7) Post-Launch Daily Review Checklist

Run once daily during beta, recorded by release manager.

- [ ] Auth success rate reviewed; no abnormal failure surge.
- [ ] Sync success/failure trend reviewed for push/pull.
- [ ] Rejected-op reasons reviewed; no unexplained spike.
- [ ] Queue lag proxy reviewed for top active teams.
- [ ] Top user-reported blockers triaged and assigned owners.
- [ ] Open P0/P1 status reviewed with ETA and mitigation plan.
- [ ] Rollout stage status confirmed (continue, hold, or rollback).

## 8) Minimal Product Analytics Plan

Goal: measure onboarding friction and sync pain points with low event volume.

### Events

| Event name | Trigger | Required properties | Why it matters |
|---|---|---|---|
| `onboarding_started` | User starts first-run onboarding | `user_id`, `team_id`, `entry_point` | Funnel top |
| `onboarding_completed` | User reaches first usable state | `user_id`, `team_id`, `duration_ms` | Funnel completion |
| `first_project_created` | First project created | `user_id`, `team_id`, `project_id` | Activation |
| `first_task_scheduled` | First schedule block created | `user_id`, `team_id`, `item_id` | Core value reached |
| `sync_push_attempted` | Push initiated | `user_id`, `team_id`, `op_count` | Volume baseline |
| `sync_push_failed` | Push failed | `user_id`, `team_id`, `error_code` | Reliability pain |
| `sync_pull_attempted` | Pull initiated | `user_id`, `team_id`, `since_seq` | Pull cadence |
| `sync_pull_failed` | Pull failed | `user_id`, `team_id`, `error_code` | Reliability pain |
| `sync_op_rejected` | Op rejected by server | `user_id`, `team_id`, `reason_code`, `op_name` | Contract drift signal |
| `onboarding_abandoned` | No completion after threshold window | `user_id`, `team_id`, `step_name` | UX friction |

### Analytics guardrails

- Keep payload minimal; avoid sensitive free-form content.
- Use stable `error_code` and `reason_code` values for aggregation.
- Add `request_id` to failed sync events when available for cross-linking with logs.

## 9) Launch-Day Command Set

- Verify build and smoke:
- `pnpm -s verify`
- Sync-server checks:
- `pnpm --dir apps/sync-server verify`
- `pnpm --dir apps/sync-server e2e`

## 10) Launch Readiness Decision Record

Use this section for the final launch meeting.

- Date:
- Candidate version/build:
- Decision: (`GO` / `NO-GO`)
- Known risks accepted:
- Immediate follow-ups:
- Sign-offs: (Release manager, Ops lead, Security lead, Product lead)
