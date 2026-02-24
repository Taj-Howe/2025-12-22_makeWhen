# Security Model

Status: policy document for upcoming cloud sync/auth rollout.

## Core Principles

1. Client is untrusted.
- Browser/Desktop/Mobile clients may be modified by users.
- All authorization and data-integrity checks must run server-side.

2. Team is the primary security boundary.
- Data and operations are partitioned by `team_id`.
- No cross-team reads or writes are allowed.

3. Session-backed identity.
- Requests are authenticated with session token/cookie.
- Server derives `user_id` from session, not from client payload claims.

## Threat Model (High Level)

Assume attacker can:
- forge HTTP requests
- alter client code
- replay previously observed requests
- submit malformed op payloads

Assume attacker cannot:
- forge valid server-issued session tokens (without compromise)

## Authorization Model

Team roles:
- `owner`
- `editor`
- `viewer`

Policy:
- read operations: member (`viewer+`)
- write operations (mutations/push): `editor+`
- admin/team-management operations: `owner` (or explicit policy overrides)

Server checks per request:
- authenticated session exists
- session user is member of target `team_id`
- role is sufficient for action

## Sync-Specific Security Rules

For each pushed op:
- validate envelope schema (`op_id`, `team_id`, `op_name`, `payload`, etc.)
- enforce team scope on every referenced entity
- enforce role for mutation intent
- reject disallowed or unknown op names
- reject invariant violations (dependency cycle, cross-team parent link, etc.)

Idempotency + replay safety:
- dedupe by `(team_id, op_id)`
- repeated push of same op must not duplicate side effects

Ordering:
- server assigns monotonic `server_seq` per team
- pull/stream ordered by `server_seq` only

## Data Isolation Requirements

- Every team-scoped table/query must include team filter or team-owned join path.
- Never trust `team_id` in payload without membership checks.
- Background jobs/workers must execute with same team constraints.

## Input Validation Requirements

- Strict payload validation by `op_name` schema.
- Reject unknown fields where practical for hardening.
- Enforce stable IDs for create-like ops when determinism requires it.
- Limit payload sizes and batch lengths to reduce abuse risk.

## Audit + Observability

Log at least:
- request identity (`session_id`, `user_id`)
- team_id
- op_id/op_name
- allow/deny result
- denial reason code

Security-relevant metrics:
- rejected ops by reason
- unauthorized access attempts
- cross-team access attempts
- replay/dedup rates

## Recommended Hardening Controls

- HTTPS-only transport
- secure, httpOnly, sameSite cookies
- CSRF protection for cookie-auth endpoints
- rate limits on sync endpoints
- payload size limits
- structured allowlist for op names
- migration + rollback procedures with integrity checks

## Residual Risk Notes

- Client clocks are not trusted for ordering; use server sequence.
- Offline edits can still produce semantic conflicts; policy resolves by deterministic server apply rules.
- Local device compromise exposes local cached data; full disk/device protections remain user responsibility.
