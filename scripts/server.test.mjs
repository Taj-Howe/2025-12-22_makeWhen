import assert from "node:assert/strict";
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { getDatabaseUrl, runMigrations } from "./dbMigrate.mjs";
import { applyOps } from "../lib/domain/ops.ts";

const { Pool } = pg;

const createDb = () => {
  const databaseUrl = getDatabaseUrl();
  return new Kysely({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: databaseUrl }),
    }),
  });
};

const resetDb = async () => {
  const databaseUrl = getDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
  } finally {
    await pool.end();
  }
  await runMigrations();
};

const seedUser = async (db, email) => {
  const row = await db
    .insertInto("users")
    .values({ email, name: email })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return row.id;
};

const applySingle = async (db, userId, opName, args) => {
  const result = await applyOps(db, {
    userId,
    ops: [{ opName, args }],
  });
  const opResult = result.results[0];
  assert.equal(opResult.ok, true);
  return opResult.result;
};

const tests = [];

const test = (name, fn) => {
  tests.push({ name, fn });
};

let db;
let userId;
let otherUserId;

const setup = async () => {
  await resetDb();
  db = createDb();
  userId = await seedUser(db, "owner@example.com");
  otherUserId = await seedUser(db, "viewer@example.com");
};

const teardown = async () => {
  if (db) {
    await db.destroy();
  }
};

test("project + item + scheduled block ops", async () => {
  const project = await applySingle(db, userId, "project.create", {
    title: "Test Project",
  });
  const item = await applySingle(db, userId, "item.create", {
    projectId: project.id,
    type: "task",
    title: "Task A",
  });

  const block = await applySingle(db, userId, "scheduled_block.create", {
    itemId: item.id,
    startAt: new Date().toISOString(),
    durationMinutes: 30,
  });

  await applySingle(db, userId, "scheduled_block.move", {
    blockId: block.id,
    startAt: new Date(Date.now() + 60_000).toISOString(),
  });

  await applySingle(db, userId, "scheduled_block.resize", {
    blockId: block.id,
    durationMinutes: 45,
  });
});

test("dependency cycle detection rejects cycles", async () => {
  const project = await applySingle(db, userId, "project.create", {
    title: "Cycle Project",
  });
  const itemA = await applySingle(db, userId, "item.create", {
    projectId: project.id,
    type: "task",
    title: "Task A",
  });
  const itemB = await applySingle(db, userId, "item.create", {
    projectId: project.id,
    type: "task",
    title: "Task B",
  });

  await applySingle(db, userId, "dependency.add", {
    itemId: itemA.id,
    dependsOnId: itemB.id,
  });

  await assert.rejects(
    () =>
      applyOps(db, {
        userId,
        ops: [
          {
            opName: "dependency.add",
            args: { itemId: itemB.id, dependsOnId: itemA.id },
          },
        ],
      }),
    /cycle/
  );
});

test("archive + restore + bulk delete", async () => {
  const project = await applySingle(db, userId, "project.create", {
    title: "Archive Project",
  });
  const parent = await applySingle(db, userId, "item.create", {
    projectId: project.id,
    type: "task",
    title: "Parent",
  });
  const child = await applySingle(db, userId, "item.create", {
    projectId: project.id,
    type: "subtask",
    parentId: parent.id,
    title: "Child",
  });

  await applySingle(db, userId, "item.archive", { itemId: child.id });
  await applySingle(db, userId, "item.restore", { itemId: child.id });

  await applySingle(db, userId, "item.bulk_delete", { ids: [parent.id] });

  const remaining = await db
    .selectFrom("items")
    .select(["id"])
    .where("project_id", "=", project.id)
    .execute();
  assert.equal(remaining.length, 0);
});

test("time entry start/stop", async () => {
  const project = await applySingle(db, userId, "project.create", {
    title: "Time Project",
  });
  const item = await applySingle(db, userId, "item.create", {
    projectId: project.id,
    type: "task",
    title: "Timer Task",
  });

  const entry = await applySingle(db, userId, "time_entry.start", {
    itemId: item.id,
  });

  const stopped = await applySingle(db, userId, "time_entry.stop", {
    timeEntryId: entry.id,
  });

  const row = await db
    .selectFrom("time_entries")
    .select(["duration_minutes", "end_at"])
    .where("id", "=", stopped.id)
    .executeTakeFirstOrThrow();
  assert.ok(row.end_at);
});

test("permission denial for viewer role", async () => {
  const project = await applySingle(db, userId, "project.create", {
    title: "Permission Project",
  });

  await db
    .insertInto("project_members")
    .values({
      project_id: project.id,
      user_id: otherUserId,
      role: "viewer",
    })
    .execute();

  await assert.rejects(
    () =>
      applyOps(db, {
        userId: otherUserId,
        ops: [
          {
            opName: "item.create",
            args: { projectId: project.id, type: "task", title: "Nope" },
          },
        ],
      }),
    /forbidden/
  );
});

const run = async () => {
  await setup();
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      // eslint-disable-next-line no-console
      console.log(`✓ ${name}`);
    } catch (error) {
      failures += 1;
      // eslint-disable-next-line no-console
      console.error(`✗ ${name}`);
      // eslint-disable-next-line no-console
      console.error(error);
    }
  }
  await teardown();
  if (failures > 0) {
    process.exitCode = 1;
  }
};

run();
