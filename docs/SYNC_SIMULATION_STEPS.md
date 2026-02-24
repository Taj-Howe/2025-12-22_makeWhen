# Sync Simulation Steps (Mock Remote)

This project now has a local mock remote op-log in SQLite (`mock_remote_oplog`) and a sync runner RPC.

## Preconditions

1. Start the app (`pnpm run dev`).
2. Open browser DevTools Console on the app page.
3. Load RPC helpers:

```js
const rpc = await import('/src/rpc/clientSingleton.ts');
```

## 1) Create local state change (Device A)

Create a task from the UI (or use the existing add-task flow).

Check outbox status:

```js
await rpc.query('sync.status', {});
```

Expected:
- `queued_count >= 1`

Run one sync cycle as device A:

```js
await rpc.query('sync.runOnce', { client_id: 'device_a' });
await rpc.query('sync.status', {});
```

Expected:
- first call returns non-zero `pushed_count`
- `queued_count` drops (typically to `0`)
- `last_applied_seq` increases

## 2) Deterministic/idempotent replay checks

Run sync again with same client:

```js
await rpc.query('sync.runOnce', { client_id: 'device_a' });
```

Expected:
- `pushed_count` should be `0` when no new changes
- state does not duplicate

Run sync with another client id in the same local DB:

```js
await rpc.query('sync.runOnce', { client_id: 'device_b' });
```

Expected:
- no duplicate task creation
- previously applied server sequences remain stable (`last_applied_seq` monotonic)

## Notes on multi-device simulation

- In this phase, `mock_remote_oplog` is local SQLite state, so true cross-browser/cross-machine propagation requires a real shared remote service.
- The current simulation validates the core sync loop (push -> pull -> ordered apply), sequence ordering, and idempotency behavior on one local dataset.
