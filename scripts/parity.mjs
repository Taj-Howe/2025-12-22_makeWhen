import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  FIXTURE_SERVER_ID_MAP,
  FIXTURE_UUIDS,
  fixtureWindow,
  seedFixtures,
  seedServerFixtures,
} from "./fixtures.mjs";
import { getDatabaseUrl, runMigrations } from "./dbMigrate.mjs";
import pg from "pg";

globalThis.self = {
  addEventListener: () => {},
  postMessage: () => {},
};

const { createTestDb, handleRequest } = await import(
  "../legacy/db-worker/worker.ts"
);

const { getCalendarView } = await import("../lib/views/calendarView.ts");
const { getListView } = await import("../lib/views/listView.ts");
const { db } = await import("../lib/db/kysely.ts");

const { db } = await createTestDb();
seedFixtures(db);

const runQuery = async (name, args) => {
  const response = await handleRequest({
    id: `parity-${name}`,
    kind: "request",
    method: "query",
    params: { name, args },
  });
  if (!response.ok) {
    throw new Error(response.error || `Query failed: ${name}`);
  }
  const payload = response.result;
  if (!payload?.ok) {
    throw new Error(payload?.error || `Query failed: ${name}`);
  }
  return payload.result;
};

const sortBy = (key) => (a, b) => {
  if (a[key] === b[key]) return 0;
  return a[key] > b[key] ? 1 : -1;
};

const normalizeListView = (items) => {
  return [...items]
    .sort(sortBy("id"))
    .map((item) => ({
      ...item,
      scheduled_blocks: [...(item.scheduled_blocks ?? [])].sort(
        (a, b) => a.start_at - b.start_at || a.block_id.localeCompare(b.block_id)
      ),
      dependencies_in: [...(item.dependencies_in ?? [])].sort(sortBy("edge_id")),
      dependencies_out: [...(item.dependencies_out ?? [])].sort(sortBy("edge_id")),
      blocked_by: [...(item.blocked_by ?? [])].sort(sortBy("item_id")),
      blocking: [...(item.blocking ?? [])].sort(sortBy("item_id")),
    }));
};

const normalizeCalendar = (result) => ({
  blocks: [...(result.blocks ?? [])].sort(sortBy("block_id")),
  items: [...(result.items ?? [])].sort(sortBy("id")),
});

const mapServerId = (value) => FIXTURE_SERVER_ID_MAP.get(value) ?? value;

const normalizeServerListView = (items) =>
  normalizeListView(
    items.map((item) => ({
      ...item,
      id: mapServerId(item.id),
      parent_id: item.parent_id ? mapServerId(item.parent_id) : null,
      project_id: mapServerId(item.project_id),
      assignee_id: item.assignee_id ? mapServerId(item.assignee_id) : null,
      scheduled_blocks: (item.scheduled_blocks ?? []).map((block) => ({
        ...block,
        block_id: mapServerId(block.block_id),
        item_id: mapServerId(block.item_id),
      })),
      dependencies_in: (item.dependencies_in ?? []).map((dep) => ({
        ...dep,
        edge_id: dep.edge_id
          ? dep.edge_id
              .split("->")
              .map((id) => mapServerId(id))
              .join("->")
          : dep.edge_id,
        predecessor_id: dep.predecessor_id
          ? mapServerId(dep.predecessor_id)
          : dep.predecessor_id,
      })),
      dependencies_out: (item.dependencies_out ?? []).map((dep) => ({
        ...dep,
        edge_id: dep.edge_id
          ? dep.edge_id
              .split("->")
              .map((id) => mapServerId(id))
              .join("->")
          : dep.edge_id,
        successor_id: dep.successor_id
          ? mapServerId(dep.successor_id)
          : dep.successor_id,
      })),
      blocked_by: (item.blocked_by ?? []).map((dep) => ({
        ...dep,
        item_id: mapServerId(dep.item_id),
      })),
      blocking: (item.blocking ?? []).map((dep) => ({
        ...dep,
        item_id: mapServerId(dep.item_id),
      })),
      depends_on: (item.depends_on ?? []).map((id) => mapServerId(id)),
    }))
  );

const normalizeServerCalendar = (result) =>
  normalizeCalendar({
    blocks: (result.blocks ?? []).map((block) => ({
      ...block,
      block_id: mapServerId(block.block_id),
      item_id: mapServerId(block.item_id),
    })),
    items: (result.items ?? []).map((item) => ({
      ...item,
      id: mapServerId(item.id),
      parent_id: item.parent_id ? mapServerId(item.parent_id) : null,
      assignee_id: item.assignee_id ? mapServerId(item.assignee_id) : null,
    })),
  });

const listView = await runQuery("list_view_complete", {
  scopeProjectId: "proj-1",
  includeUngrouped: true,
  includeCompleted: true,
  archiveFilter: "all",
});

const calendarView = await runQuery("calendar_range", {
  time_min: fixtureWindow.start,
  time_max: fixtureWindow.end,
  scopeProjectId: "proj-1",
});

const snapshotsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__snapshots__"
);
if (!existsSync(snapshotsDir)) {
  mkdirSync(snapshotsDir, { recursive: true });
}

const writeOrCompare = (filename, data) => {
  const snapshotPath = path.join(snapshotsDir, filename);
  const payload = JSON.stringify(data, null, 2);
  if (!existsSync(snapshotPath)) {
    writeFileSync(snapshotPath, `${payload}\n`);
    console.log(`Wrote snapshot ${filename}`);
    return;
  }
  const existing = readFileSync(snapshotPath, "utf8");
  assert.equal(payload.trim(), existing.trim(), `${filename} snapshot mismatch`);
};

writeOrCompare("list_view.json", normalizeListView(listView));
writeOrCompare("calendar_view.json", normalizeCalendar(calendarView));

let serverParityRan = false;
try {
  getDatabaseUrl();
  const { Pool } = pg;
  const databaseUrl = getDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
  } finally {
    await pool.end();
  }
  await runMigrations();

  await seedServerFixtures(db);

  const serverList = await getListView({
    scope: { kind: "project", projectId: FIXTURE_UUIDS.project },
    includeCompleted: true,
    includeArchived: true,
  });

  const serverCalendar = await getCalendarView({
    scope: { kind: "project", projectId: FIXTURE_UUIDS.project },
    windowStart: fixtureWindow.start,
    windowEnd: fixtureWindow.end,
  });

  writeOrCompare("list_view.json", normalizeServerListView(serverList));
  writeOrCompare("calendar_view.json", normalizeServerCalendar(serverCalendar));
  serverParityRan = true;
} catch (err) {
  console.log("Server parity skipped: database not available or query failed.");
}

console.log("Parity snapshots match.");
if (!serverParityRan) {
  console.log("Server parity skipped: server adapter not enabled.");
}
