# Legacy App (Archived)

This folder contains the **deprecated** offline-first Vite app and SQLite/Web Worker
implementation. It is archived for reference only and is **not used** by the
current Next.js + Postgres system.

Why it is deprecated:
- The active system is server-authoritative (Postgres + /api/ops + /api/query).
- Client code should not depend on Web Workers, OPFS, or SQLite-WASM.
- Keeping this code separate prevents accidental imports in Next.js builds.

Contents:
- `legacy/db-worker/` - SQLite worker implementation + migrations (archived)
- `legacy/rpc/`       - Worker RPC client (archived)
- `legacy/vite/`      - Vite entrypoint + config (archived)

Do not build new features on this code path.
