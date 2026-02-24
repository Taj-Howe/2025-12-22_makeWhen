import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Check = {
  name: string;
  ok: boolean;
  details?: string;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const migrationsDir = path.join(repoRoot, "src", "db-worker", "migrations");
const workerFile = path.join(repoRoot, "src", "db-worker", "worker.ts");

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort((a, b) => a.localeCompare(b));

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "makewhen-smoke-"));
const dbFile = path.join(tmpDir, "smoke.sqlite3");
const checks: Check[] = [];

const runSql = (sql: string) =>
  execFileSync("sqlite3", [dbFile], {
    encoding: "utf8",
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

const requireCheck = (name: string, ok: boolean, details?: string) => {
  checks.push({ name, ok, details });
  if (!ok) {
    throw new Error(details ? `${name}: ${details}` : name);
  }
};

try {
  requireCheck(
    "sqlite3 installed",
    Boolean(execFileSync("sqlite3", ["--version"], { encoding: "utf8" }).trim()),
    "sqlite3 binary is required for smoke checks"
  );

  for (const file of migrationFiles) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    runSql(sql);
  }
  requireCheck(
    "migrations applied",
    migrationFiles.length > 0,
    "No migration files were found"
  );

  const tableRows = runSql(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC;"
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const tableSet = new Set(tableRows);
  for (const tableName of [
    "items",
    "scheduled_blocks",
    "dependencies",
    "teams",
    "users",
    "team_members",
    "sessions",
    "client_info",
    "op_outbox",
    "op_applied",
    "mock_remote_oplog",
  ]) {
    requireCheck(
      `table exists: ${tableName}`,
      tableSet.has(tableName),
      `Missing table ${tableName}`
    );
  }

  const itemColumnRows = runSql("PRAGMA table_info(items);")
    .split("\n")
    .map((line) => line.split("|"))
    .filter((parts) => parts.length >= 2);
  const itemColumns = new Set(itemColumnRows.map((parts) => parts[1]));
  for (const columnName of ["id", "type", "parent_id", "team_id", "status"]) {
    requireCheck(
      `items column exists: ${columnName}`,
      itemColumns.has(columnName),
      `Missing items.${columnName}`
    );
  }

  const now = Date.now();
  runSql(`
    INSERT INTO teams (team_id, name, created_at, updated_at)
    VALUES ('team_default', 'My Team', ${now}, ${now})
    ON CONFLICT(team_id) DO NOTHING;

    INSERT INTO users (user_id, display_name, avatar_url, created_at, updated_at)
    VALUES ('u_smoke', 'Smoke User', NULL, ${now}, ${now})
    ON CONFLICT(user_id) DO NOTHING;

    INSERT INTO team_members (team_id, user_id, role, created_at)
    VALUES ('team_default', 'u_smoke', 'owner', ${now})
    ON CONFLICT(team_id, user_id) DO NOTHING;

    INSERT INTO sessions (session_id, user_id, team_id, created_at, updated_at, is_active)
    VALUES ('s_smoke', 'u_smoke', 'team_default', ${now}, ${now}, 1)
    ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at, is_active = 1;

    INSERT INTO items (
      id, type, title, parent_id, team_id, status, priority, due_at, estimate_mode,
      estimate_minutes, health, health_mode, notes, created_at, updated_at
    ) VALUES (
      'p_smoke', 'project', 'Smoke Project', NULL, 'team_default', 'ready', 0, NULL,
      'rollup', 0, 'unknown', 'auto', NULL, ${now}, ${now}
    )
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO items (
      id, type, title, parent_id, team_id, status, priority, due_at, estimate_mode,
      estimate_minutes, health, health_mode, notes, created_at, updated_at
    ) VALUES (
      't_smoke_a', 'task', 'Smoke Task A', 'p_smoke', 'team_default', 'ready', 1, NULL,
      'manual', 60, 'unknown', 'auto', NULL, ${now}, ${now}
    )
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO items (
      id, type, title, parent_id, team_id, status, priority, due_at, estimate_mode,
      estimate_minutes, health, health_mode, notes, created_at, updated_at
    ) VALUES (
      't_smoke_b', 'task', 'Smoke Task B', 'p_smoke', 'team_default', 'ready', 1, NULL,
      'manual', 30, 'unknown', 'auto', NULL, ${now}, ${now}
    )
    ON CONFLICT(id) DO NOTHING;

    INSERT OR IGNORE INTO dependencies (item_id, depends_on_id, type, lag_minutes)
    VALUES ('t_smoke_b', 't_smoke_a', 'FS', 0);

    INSERT OR IGNORE INTO item_assignees (item_id, assignee_id)
    VALUES ('t_smoke_a', 'u_smoke');

    INSERT OR IGNORE INTO scheduled_blocks (
      block_id, item_id, start_at, duration_minutes, locked, source
    ) VALUES (
      'b_smoke', 't_smoke_a', ${now}, 60, 0, 'manual'
    );
  `);

  const smokeCount = Number(
    runSql("SELECT COUNT(*) FROM items WHERE team_id = 'team_default';")
  );
  requireCheck(
    "round-trip seed data",
    Number.isFinite(smokeCount) && smokeCount >= 3,
    `Expected seeded team items, got ${smokeCount}`
  );
  const activeSessionCount = Number(
    runSql("SELECT COUNT(*) FROM sessions WHERE is_active = 1;")
  );
  requireCheck(
    "active session exists",
    Number.isFinite(activeSessionCount) && activeSessionCount >= 1,
    `Expected active session, got ${activeSessionCount}`
  );

  const workerSource = readFileSync(workerFile, "utf8");
  for (const requiredNeedle of [
    "const handleMutate",
    "const handleRequest",
    'case "create_item"',
    'case "listItems"',
    'case "team.current"',
    'case "users_list"',
    'case "auth.session.current"',
    'case "auth.session.set"',
    'case "auth.logout"',
    'case "sync.outbox.status"',
    'case "sync.status"',
    'case "sync.runOnce"',
  ]) {
    requireCheck(
      `worker seam exists: ${requiredNeedle}`,
      workerSource.includes(requiredNeedle),
      `Missing ${requiredNeedle} in worker RPC registry`
    );
  }

  console.log("Smoke checks passed.");
  for (const check of checks) {
    console.log(`- OK: ${check.name}`);
  }
} catch (error) {
  console.error("Smoke checks failed.");
  for (const check of checks) {
    const prefix = check.ok ? "OK" : "FAIL";
    console.error(`- ${prefix}: ${check.name}${check.details ? ` (${check.details})` : ""}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failure: ${message}`);
  process.exitCode = 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
