# Local-First Multi-Platform Architecture

This document describes the target architecture for shipping MakeWhen across:

- Browser
- macOS / Windows desktop app
- iOS / Android mobile app

## Core principle

Each device owns a local SQLite database and can run fully offline.
Sync is optional and incremental.

## Local storage by platform

- Browser: SQLite WASM + OPFS (`opfs-sahpool`), with in-memory fallback when OPFS is unavailable.
- Desktop: native SQLite file on disk.
- Mobile: native SQLite in app sandbox.

## Shared contract

All clients share:

- Same domain schema
- Same migration semantics
- Same mutation envelope shape (`op_id`, `op_name`, actor, timestamp, args)
- Same conflict-resolution policy

## Sync strategy (recommended)

Use operation-log sync:

1. Client records mutations locally.
2. Client pushes unsynced ops to server.
3. Client pulls remote ops since cursor.
4. Client applies ops idempotently by `op_id`.
5. Client stores updated cursor.

Avoid syncing raw DB files as the main strategy for multi-device editing.

## Initial rollout phases

1. Local-only (current): browser OPFS + full offline operation.
2. Storage abstraction hardened: per-platform SQLite adapter.
3. Auth + device identity.
4. Push/pull sync API + cursor persistence.
5. Background sync + retry/backoff + conflict telemetry.
