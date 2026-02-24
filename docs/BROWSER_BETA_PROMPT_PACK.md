# Browser Beta Prompt Pack (A-I)

Use these in order. Each prompt assumes the previous one is complete and merged.

## Global instructions to prepend to every prompt

```text
You are Codex GPT-5 in the makeWhen repo.
Branch naming: codex/<short-task-name>.
Verification command: pnpm -s typecheck && pnpm -s build && pnpm -s smoke.
Do not refactor unrelated code.
Keep behavior backward-compatible unless explicitly requested.
Always update docs for any new env vars/endpoints.
```

---

## Prompt A — Sync Server Scaffold + Cloud Schema + Health Checks

```text
Goal:
Create a minimal production sync server skeleton (no full domain logic yet) with a real cloud DB schema and basic health endpoints.

Tasks:
1) Create a new server workspace (e.g. apps/sync-server or server/sync-server).
2) Pick one framework and keep it simple:
   - Fastify + TypeScript preferred.
3) Add env/config loading:
   - PORT
   - DATABASE_URL
   - AUTH_MODE (local|oauth; default local)
   - CORS_ORIGIN
4) Add health endpoints:
   - GET /health/live
   - GET /health/ready (checks DB connectivity)
5) Add DB migration system for server DB (Postgres):
   - teams (if needed for standalone server)
   - users (if needed)
   - team_members
   - sessions (or session lookup table if external auth provider)
   - team_seq
   - team_oplog
   Constraints:
   - UNIQUE(team_id, op_id)
   - PRIMARY KEY(team_id, server_seq)
6) Add minimal DB access layer and typed query helpers.
7) Add README for server run/dev commands.
8) Add one smoke script that starts server dependencies or validates DB schema presence.

Acceptance:
- Server runs locally.
- /health/live and /health/ready both work.
- DB migrations apply cleanly.
- verify command passes.

Output required:
- File list of new server module.
- Exact run commands.
```

---

## Prompt B — Auth Middleware + Session Verification + Team Membership Checks

```text
Goal:
Add production auth boundary in sync server so all sync endpoints can trust identity + team role checks.

Tasks:
1) Implement auth middleware for sync server:
   - Reads session token/cookie (or bearer token if easier for now).
   - Resolves authenticated user_id.
   - Rejects unauthenticated requests with 401.
2) Implement authorization helper module:
   - requireTeamMember(user_id, team_id)
   - requireRoleAtLeast(role, requiredRole)
   - roles: owner > editor > viewer
3) Add request context typing:
   - request.auth.user_id
   - request.auth.session_id (if available)
4) Add tests or smoke checks for:
   - unauthenticated => 401
   - non-member => 403
   - viewer attempting write => 403
5) Document auth assumptions in server README.

Acceptance:
- Auth middleware in place and used by sync routes.
- Team membership and role checks reusable and centralized.
- verify command passes.

Output required:
- Explicitly list middleware file and authz helper file paths.
```

---

## Prompt C — Implement POST /sync/push (Idempotent Append + Validation)

```text
Goal:
Implement /sync/push per docs/SYNC_SERVER_CONTRACT.md with idempotency and per-op validation/rejection.

Tasks:
1) Add POST /sync/push endpoint:
   Request shape:
   - team_id
   - client_id
   - ops: OpEnvelope[]
2) Enforce auth + authz:
   - user must be editor+ for target team.
3) For each op in request order:
   - validate envelope shape
   - validate op.team_id matches request.team_id
   - validate op_name allowlist (start with currently supported ops)
   - validate payload schema minimally per op_name
4) Idempotency:
   - if (team_id, op_id) already exists, return existing server_seq in acked.
5) New valid op:
   - assign next server_seq atomically per team
   - write to team_oplog
   - include acked mapping
6) Invalid op:
   - add to rejected[] with stable reason code/message
   - do not write to oplog
7) Return:
   - { acked: [{op_id, server_seq}], rejected: [{op_id, reason}] }
8) Add contract tests for:
   - duplicate op_id idempotency
   - mixed ack/reject batch
   - role enforcement

Acceptance:
- Endpoint matches contract and is deterministic.
- Duplicate pushes do not duplicate rows.
- verify command passes.

Output required:
- Example curl for push and expected responses.
```

---

## Prompt D — Implement GET /sync/pull (Seq Cursor Semantics)

```text
Goal:
Implement /sync/pull with strict server_seq ordering and team scoping.

Tasks:
1) Add GET /sync/pull endpoint:
   Query:
   - team_id
   - since_seq (integer, default 0)
2) Enforce auth + authz:
   - user must be viewer+ for target team.
3) Return:
   - ops: [{ server_seq, op }], sorted ASC by server_seq
   - latest_seq: max seq for team (0 if none)
4) Add validation for malformed since_seq and team_id.
5) Add paging safeguards:
   - optional limit (e.g. default 500, max 5000) to prevent huge pulls
   - document continuation behavior if limited
6) Add tests:
   - empty pull
   - pull after cursor
   - role and team boundary enforcement

Acceptance:
- Pull returns strictly ordered ops and correct latest_seq.
- Team isolation confirmed.
- verify command passes.

Output required:
- Example curl for pull and sample response.
```

---

## Prompt E — Browser Client Remote Adapter + SYNC_MODE Integration

```text
Goal:
Wire browser app to real remote sync while preserving local/mock behavior.

Tasks:
1) Add config seam:
   - SYNC_MODE=mock|remote (default mock)
   - base URL for remote sync server in remote mode.
2) Add client sync transport module:
   - push(team_id, client_id, ops)
   - pull(team_id, since_seq)
   - in mock mode, keep existing local/mock flow
   - in remote mode, call HTTP endpoints
3) Integrate with existing sync.runOnce trigger path:
   - keep outbox state machine (`queued|sending|acked|failed`)
   - preserve retry/backoff behavior
4) Ensure auth cookies/tokens are sent in remote mode.
5) Add minimal UI/console status surfacing for sync failures.
6) Update docs with new env vars.

Acceptance:
- Switching SYNC_MODE toggles transport without breaking app.
- Existing local mode behavior unchanged.
- verify command passes.

Output required:
- Exact env vars and sample .env.local entries.
```

---

## Prompt F — End-to-End Multi-Device Convergence Harness

```text
Goal:
Prove that create/edit/schedule/dependency changes converge across two clients against real sync server.

Tasks:
1) Add deterministic E2E simulation script/test suite:
   - Device A and Device B identities (distinct client_id, same team)
2) Scenario set:
   - A creates project/task -> push
   - B pulls -> item appears with same IDs
   - A schedules block -> push
   - B pulls -> block appears and one-block-per-item invariant holds
   - A adds dependency
   - B pulls -> dependency appears
3) Concurrency scenario:
   - A and B edit same field near-concurrently
   - verify last server_seq wins
4) Replay/idempotency scenario:
   - resend same op_id
   - verify no duplicate side effects
5) Generate readable test report output.

Acceptance:
- Demonstrates: A change appears on B.
- Deterministic convergence in seq order.
- verify command passes (or dedicated e2e command + docs).

Output required:
- Command to run E2E harness and sample success output.
```

---

## Prompt G — Security Hardening Pass (Internet Exposure Ready)

```text
Goal:
Harden sync/auth paths to match docs/SECURITY_MODEL.md before external beta users.

Tasks:
1) Add robust request validation:
   - strict schema validation for push/pull payloads
   - clear error responses
2) Add abuse controls:
   - rate limiting per IP/user/team for sync endpoints
   - payload size and batch length limits
3) Session/cookie hardening:
   - secure, httpOnly, sameSite settings
   - CSRF strategy for cookie-auth writes
4) Add op allowlist + per-op payload validator registration.
5) Add structured security logging:
   - auth failures
   - authorization denials
   - rejected ops with reason codes
6) Add tests for negative cases:
   - malformed payload
   - cross-team attempt
   - insufficient role
   - oversized payload

Acceptance:
- Security checks enforce documented model.
- No regressions in happy path sync.
- verify command passes.

Output required:
- Security checklist with each control and file path.
```

---

## Prompt H — Observability, Alerts, and Operations Runbook

```text
Goal:
Make production sync/auth operable with clear telemetry and on-call response steps.

Tasks:
1) Add structured logs with correlation IDs:
   - request_id
   - user_id (when present)
   - team_id
   - endpoint
2) Add metrics (at minimum):
   - push success/failure counts
   - pull success/failure counts
   - rejected ops by reason
   - queue lag proxy (latest_seq - last_applied_seq where available)
   - auth failure rates
3) Add alert thresholds (doc-level if infra not yet wired):
   - error-rate spike
   - sustained rejected-op spike
   - auth failure surge
4) Add docs/operations runbook:
   - incident triage
   - rollback steps
   - DB restore steps
   - known failure modes and mitigation
5) Add lightweight admin debug endpoint(s) if needed, behind auth.

Acceptance:
- Telemetry is sufficient to detect and triage launch issues.
- Runbook exists and is actionable.
- verify command passes.

Output required:
- Metrics/events table and alert threshold table.
```

---

## Prompt I — Launch Checklist + Staged Rollout Controls

```text
Goal:
Prepare a controlled browser beta launch with clear go/no-go gates and rollback criteria.

Tasks:
1) Create docs/BETA_LAUNCH_CHECKLIST.md with:
   - prelaunch checks (auth, sync, security, ops, legal)
   - go/no-go criteria
   - rollback triggers and owner
2) Add rollout plan:
   - Stage 1 internal
   - Stage 2 private beta (10-30 users)
   - Stage 3 expanded beta
3) Add support process:
   - bug intake template
   - severity levels
   - SLA targets
4) Add post-launch daily review checklist:
   - auth success
   - sync success
   - rejected ops
   - user-reported blockers
5) Add minimal product analytics event plan for onboarding and sync pain points.

Acceptance:
- Checklist and rollout plan are complete and executable.
- Roles/ownership defined for launch operations.
- No code regressions.

Output required:
- Final launch readiness summary with blockers list (if any).
```

---

## Optional Prompt J — OAuth Provider Implementation Behind Existing Auth Boundary

```text
Goal:
Replace local sign-in behavior with real OAuth while preserving the existing UI auth boundary (`src/auth/authProvider.ts`).

Tasks:
1) Implement oauth mode in auth provider:
   - signIn -> redirect/start OAuth flow
   - getSession -> read server-backed session
   - signOut -> invalidate server session
2) Add callback route handling and session bootstrap.
3) Keep local mode available for development.
4) Ensure UI surfaces unchanged except for auth flow behavior.

Acceptance:
- AUTH_MODE=oauth works end-to-end.
- AUTH_MODE=local still works for local dev.
- verify command passes.
```
