# Sync Server Contract

Status: design contract only (no cloud implementation yet).  
Source of truth for client/server sync API and conflict behavior.

## Scope

This contract matches the current local-first model:
- client writes local state via mutate ops
- each successful mutate is written to local `op_outbox`
- sync transports `OpEnvelope` entries to/from a server op log

## Canonical Op Envelope

```ts
type OpEnvelope = {
  op_id: string;
  team_id: string;
  actor_user_id: string;
  created_at: number; // epoch ms, client clock
  op_name: string;
  payload: Record<string, unknown>; // intent-only args
};
```

Rules:
- `op_id` is globally unique and idempotency key.
- `payload` must contain deterministic IDs for create-like ops (`id`, `block_id`, `entry_id`, etc.) when required.
- Server sequence (`server_seq`) is the ordering authority, not `created_at`.

## Auth + Authorization

- All sync endpoints require authenticated session token/cookie.
- Server resolves authenticated `user_id` from token/session, never trusts `actor_user_id` blindly.
- Team boundary is enforced on every request.
- Caller must be a member of requested `team_id`.
- Push requires role `editor` or `owner`.
- Pull requires role `viewer` or higher.

## Endpoints

### POST `/sync/push`

Push local queued ops for one team.

Request body:

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
      "payload": { "id": "item_1", "type": "task", "title": "Draft" }
    }
  ]
}
```

Response body:

```json
{
  "acked": [{ "op_id": "uuid", "server_seq": 42 }],
  "rejected": [{ "op_id": "uuid2", "reason": "validation_failed" }]
}
```

Server behavior:
- Process ops in request order.
- Idempotent by `op_id`:
  - if already present in server log for team, return existing `server_seq` in `acked`.
- For new valid op:
  - validate + authorize
  - apply domain rules
  - append to team op log with next monotonic `server_seq`
  - return `acked` mapping.
- For invalid/conflicting op:
  - do not append
  - return `rejected` with reason.

### GET `/sync/pull?team_id=<id>&since_seq=<n>`

Pull ops after `since_seq` for one team.

Response body:

```json
{
  "ops": [
    {
      "server_seq": 43,
      "op": {
        "op_id": "uuid3",
        "team_id": "team_123",
        "actor_user_id": "user_2",
        "created_at": 1730000005000,
        "op_name": "scheduled_block.create",
        "payload": { "block_id": "b1", "item_id": "item_1", "start_at": 1730003600000, "duration_minutes": 60 }
      }
    }
  ],
  "latest_seq": 43
}
```

Server behavior:
- Return ops sorted ascending by `server_seq`.
- `latest_seq` is max seq for team (even if `ops` is empty).

### Optional GET `/sync/stream`

Server-Sent Events for near-real-time updates.

Query params:
- `team_id`
- `since_seq` (optional)

Event payload shape:
- same as pull entry (`{ server_seq, op }`)

Fallback:
- clients may continue polling `/sync/pull` on interval.

## Server Storage Shape

Minimum tables (logical):

```sql
CREATE TABLE team_oplog (
  team_id TEXT NOT NULL,
  server_seq BIGINT NOT NULL,
  op_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  client_id TEXT,
  created_at BIGINT NOT NULL,
  op_name TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  received_at BIGINT NOT NULL,
  PRIMARY KEY (team_id, server_seq),
  UNIQUE (team_id, op_id)
);

CREATE TABLE team_seq (
  team_id TEXT PRIMARY KEY,
  latest_seq BIGINT NOT NULL
);
```

Notes:
- `UNIQUE (team_id, op_id)` guarantees idempotent push.
- `server_seq` is monotonic per team.

## Conflict Policy

1. Last op wins for same field:
- When two valid ops target same field/entity, larger `server_seq` is authoritative.

2. Reject dependency cycles:
- Dependency-changing ops that introduce cycles are rejected at push apply time.

3. Scheduled block upsert (one per item):
- Treat scheduled block as single-slot resource per item.
- New/updated block for item overwrites prior scheduled block for that item.

4. Team mismatch:
- Reject op if envelope/payload implies cross-team mutation.

## Validation Rules

Server must re-validate every op (client is untrusted):
- op schema + required payload fields per `op_name`
- actor membership and role in `team_id`
- entity existence and ownership
- invariant checks (no cycles, one block per item, etc.)

## Error Model

HTTP:
- `401` unauthenticated
- `403` authenticated but not authorized for team/action
- `400` malformed request
- `409` conflict/invariant rejection (optional for whole-request failures)

Per-op rejection reason examples:
- `not_team_member`
- `insufficient_role`
- `cross_team_access`
- `validation_failed`
- `dependency_cycle`
- `unknown_op`

## Determinism Requirements

- Applying the same ordered sequence (`server_seq`) must converge to the same state.
- Ops must be idempotent by `op_id`.
- Create-like ops must use stable IDs from payload.

## Compatibility Notes

This contract is intentionally aligned with current local tables/types:
- `op_outbox` (`queued|sending|acked|failed`)
- `op_applied` cursor tracking
- `OpEnvelope` shape in client/worker types
