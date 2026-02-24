# Browser Beta Launch Roadmap

Purpose: complete high-level list to get from current local-first build to a real browser beta with cloud sync + auth, ready for external users.

## 1) Target Outcome

Launch a hosted browser app where users can:
- sign in reliably
- belong to teams
- create/update data on multiple devices/browsers
- sync changes consistently and safely
- recover from normal errors without data loss

## 2) Current State Snapshot

Already in place:
- local-first SQLite worker architecture
- team/session model in worker
- role-based checks (owner/editor/viewer)
- durable local outbox (`op_outbox`) + applied cursor (`op_applied`)
- mock remote op-log + local sync run loop
- auth provider UI seam (`AUTH_MODE=local|oauth`)
- server contract and security docs

Not yet production-ready:
- real hosted auth system
- real hosted sync server + persistent cloud DB
- browser client wired to remote sync transport
- production observability, SLOs, incident/support tooling
- security hardening and abuse controls

## 3) Definition Of Beta Ready

Must all be true:
- external users can sign in and access their team data from a different browser/device
- sync convergence works for normal concurrent edits
- major invariants are enforced server-side
- operational visibility exists (logs, metrics, alerts)
- rollback/recovery playbook exists
- critical legal/privacy pages exist (minimum viable)

## 4) Workstreams (Comprehensive)

W1. Product + launch scope control
- Freeze beta scope: what is in, what is deferred.
- Define supported platforms for beta (browser first).
- Define user cohorts (internal alpha, trusted beta, open beta).
- Publish clear non-goals for beta to prevent feature drift.

W2. Identity and auth (production)
- Choose auth provider stack (managed or custom).
- Implement real OAuth/session flow behind `authProvider` boundary.
- Server-side session verification middleware.
- Team membership bootstrap flow for first sign-in.
- Account lifecycle basics: sign-in, sign-out, session expiry, re-auth.

W3. Cloud sync backend
- Build server endpoints from `docs/SYNC_SERVER_CONTRACT.md`:
  - `POST /sync/push`
  - `GET /sync/pull`
  - optional `GET /sync/stream` (SSE)
- Implement team-scoped op-log persistence in cloud DB.
- Enforce idempotency by `(team_id, op_id)`.
- Enforce monotonic `server_seq` per team.
- Implement per-op validation + rejection reasons.

W4. Server-side domain enforcement
- Apply same domain invariants as local worker, server-side.
- Confirm conflict policy behavior:
  - last-op-wins for field conflicts
  - reject dependency cycles
  - scheduled block one-per-item upsert semantics
- Ensure deterministic replay guarantees.

W5. Client sync transport integration
- Add `SYNC_MODE=mock|remote` config seam.
- Implement remote push/pull adapter for browser client.
- Keep local outbox state machine robust (`queued|sending|acked|failed`).
- Add retry/backoff and network failure handling.
- Preserve offline-first behavior when remote unavailable.

W6. Multi-device correctness validation
- E2E scenario matrix:
  - A creates -> B sees after sync
  - A/B edit same item near-concurrently
  - reconnect after offline burst
  - duplicate push replay
  - partial failure and recovery
- Verify convergence and no duplicate entities.

W7. Permissions and collaboration model
- Team-wide access model for beta (as planned).
- Ensure role gating is consistent across all API operations.
- Team member invite/join flow (minimum viable for beta).
- Admin controls for team owner (minimal but sufficient).

W8. Security hardening
- Implement controls from `docs/SECURITY_MODEL.md`.
- CSRF/session/cookie hardening.
- Rate limits and payload size limits.
- Input schema validation for every op.
- Audit log for auth + sync decisions.
- Secrets management and environment hygiene.

W9. Reliability and operations
- Production deployment topology (app + API + DB).
- Migration strategy for cloud DB.
- Backups + restore drill.
- Error budgets / SLO definitions.
- Alerting for sync/auth failure patterns.
- Incident response runbook.

W10. Observability + analytics
- Structured logs with request/team/user correlation IDs.
- Core metrics:
  - sync success/failure rates
  - queue depth and retry counts
  - pull lag (`latest_seq - last_applied_seq`)
  - auth/session error rates
- Minimal product analytics for onboarding friction.

W11. UX readiness for real users
- First-run onboarding copy.
- Empty/error/loading states for auth and sync.
- User-visible sync status indicators.
- Clear recoverable error messaging.
- Data export path for trust/safety.

W12. QA and release process
- CI gates for type/build/smoke + API contract tests.
- Staging environment parity with prod.
- Regression pass for key views and flows.
- Launch checklist and rollback criteria.
- Canary rollout plan.

W13. Legal/privacy basics (beta minimum)
- Terms of service draft.
- Privacy policy draft.
- Cookie/session disclosure as needed.
- Contact/support policy for beta users.

W14. Post-launch feedback loop
- Bug intake triage cadence.
- User interview cadence.
- Top-issue dashboard.
- Decision rubric for beta -> GA milestones.

## 5) Critical Path (Order)

1. W1 scope freeze  
2. W2 auth production foundation  
3. W3 sync backend endpoints + DB  
4. W4 server invariant enforcement  
5. W5 client remote sync integration  
6. W6 multi-device correctness validation  
7. W8 security hardening for internet exposure  
8. W9 ops readiness (alerts, backup, recovery)  
9. W12 staged rollout + beta launch

## 6) Suggested Milestone Gates

M0: Architecture-ready gate
- contracts/docs finalized
- local outbox + mock sync validated

M1: Auth-ready gate
- real sign-in works in staging
- team membership authz checks enforced

M2: Sync-ready gate
- push/pull works against real DB
- idempotency + seq ordering validated

M3: Reliability-ready gate
- retries/recovery and observability in place
- alerting + runbook tested

M4: Beta launch gate
- external users onboard successfully
- no critical data-loss or auth vulnerabilities open

## 7) Risks To Manage Early

- R1: divergence between worker rules and server rules
- R2: missing deterministic IDs in create ops
- R3: hidden cross-team access in less-used endpoints
- R4: sync retries causing duplicate/partial side effects
- R5: low visibility into silent sync failures
- R6: auth edge cases (session expiry, revoked membership)

## 8) Prompt Engineering Structure (for ChatGPT step plans)

Use one prompt per milestone, not one giant prompt.

Recommended sequence:
1. Prompt A: scaffold sync server + schema + health checks
2. Prompt B: auth middleware + session verification + team membership checks
3. Prompt C: implement `/sync/push` idempotent append + validation
4. Prompt D: implement `/sync/pull` with seq cursor semantics
5. Prompt E: client remote adapter + `SYNC_MODE` integration
6. Prompt F: E2E multi-device test harness + deterministic convergence tests
7. Prompt G: security hardening pass + rate limits + payload validation
8. Prompt H: observability + dashboards + alerts + runbooks
9. Prompt I: launch checklist + staged rollout controls

## 9) Practical Launch Plan (People Using It)

Phase 1: internal dogfood (you + close collaborators)  
Phase 2: private beta (10-30 users)  
Phase 3: expanded beta (50-200 users) with support cadence

Each phase requires:
- explicit entry criteria
- explicit rollback criteria
- bug triage SLA
- daily sync/auth health review

## 10) Success Metrics (Beta)

- Auth success rate for sign-in sessions
- Sync success rate for push/pull cycles
- Median sync latency (online)
- Conflict rejection rate (and resolution quality)
- Data-loss incidents (target: zero)
- Weekly active users and retention signal

## 11) What You Can Safely Defer Until After Beta

- Fine-grained project-level permissions
- Advanced live-collab transport beyond polling/SSE
- Complex enterprise auth features
- Deep billing/subscription systems
- Non-critical UI polish unrelated to trust/reliability
