import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { RpcRequest, RpcResponse } from "../rpc/types";
import initSql from "./migrations/0001_init.sql?raw";

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

const DB_FILENAME = "makewhen.sqlite3";
const VFS_NAME = "opfs-sahpool";

type DbInfoPayload =
  | {
      ok: true;
      vfs: string;
      filename: string;
      schemaVersion: number;
    }
  | {
      ok: false;
      error: string;
    };

type DbState = {
  info: DbInfoPayload | null;
  error: string | null;
};

type MutateEnvelope = {
  op_id: string;
  op_name: string;
  actor_type: string;
  actor_id?: string;
  ts: number;
  args?: unknown;
};

type MutateResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
  warnings?: string[];
  invalidate?: string[];
};

type QueryEnvelope = {
  name: string;
  args?: unknown;
};

type QueryResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

const dbState: DbState = {
  info: null,
  error: null,
};

let initPromise: Promise<void> | null = null;
let dbHandle: any = null;

const migrations = [
  {
    version: 1,
    sql: initSql,
  },
];

const ensureString = (value: unknown, name: string) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
};

const ensureNumber = (value: unknown, name: string) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  return value;
};

const ensureArray = (value: unknown, name: string) => {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value;
};

const ensureOptionalString = (value: unknown, name: string) => {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string or null`);
  }
  return value;
};

const ensureOptionalNumber = (value: unknown, name: string) => {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number or null`);
  }
  return value;
};

const getSettings = (db: any) => {
  const rows = db.exec({
    sql: "SELECT key, value_json FROM settings;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string]>;

  const settings = new Map<string, unknown>();
  for (const row of rows) {
    try {
      settings.set(row[0], JSON.parse(row[1]));
    } catch {
      settings.set(row[0], row[1]);
    }
  }
  return settings;
};

const exportData = (db: any) => {
  const itemsRows = db.exec({
    sql: "SELECT id, type, title, parent_id, status, priority, due_at, estimate_mode, estimate_minutes, health, health_mode, notes, created_at, updated_at FROM items;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<
    [
      string,
      string,
      string,
      string | null,
      string,
      number,
      number,
      string,
      number,
      string,
      string,
      string | null,
      number,
      number
    ]
  >;

  const dependencyRows = db.exec({
    sql: "SELECT item_id, depends_on_id FROM dependencies;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string]>;

  const blockerRows = db.exec({
    sql: "SELECT blocker_id, item_id, reason, created_at, cleared_at FROM blockers;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string, string | null, number, number | null]>;

  const blockRows = db.exec({
    sql: "SELECT block_id, item_id, start_at, duration_minutes, locked, source FROM scheduled_blocks;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string, number, number, number, string]>;

  const timeRows = db.exec({
    sql: "SELECT entry_id, item_id, start_at, end_at, duration_minutes, note, source FROM time_entries;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string, number, number, number, string | null, string]>;

  const tagRows = db.exec({
    sql: "SELECT item_id, tag FROM item_tags;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string]>;

  const assigneeRows = db.exec({
    sql: "SELECT item_id, assignee_id FROM item_assignees;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string]>;

  const settings = Array.from(getSettings(db).entries()).map(([key, value]) => ({
    key,
    value,
  }));

  return {
    exported_at: Date.now(),
    items: itemsRows.map((row) => ({
      id: row[0],
      type: row[1],
      title: row[2],
      parent_id: row[3],
      status: row[4],
      priority: row[5],
      due_at: row[6],
      estimate_mode: row[7],
      estimate_minutes: row[8],
      health: row[9],
      health_mode: row[10],
      notes: row[11],
      created_at: row[12],
      updated_at: row[13],
    })),
    dependencies: dependencyRows.map((row) => ({
      item_id: row[0],
      depends_on_id: row[1],
    })),
    blockers: blockerRows.map((row) => ({
      blocker_id: row[0],
      item_id: row[1],
      reason: row[2],
      created_at: row[3],
      cleared_at: row[4],
    })),
    scheduled_blocks: blockRows.map((row) => ({
      block_id: row[0],
      item_id: row[1],
      start_at: row[2],
      duration_minutes: row[3],
      locked: row[4],
      source: row[5],
    })),
    time_entries: timeRows.map((row) => ({
      entry_id: row[0],
      item_id: row[1],
      start_at: row[2],
      end_at: row[3],
      duration_minutes: row[4],
      note: row[5],
      source: row[6],
    })),
    item_tags: tagRows.map((row) => ({
      item_id: row[0],
      tag: row[1],
    })),
    item_assignees: assigneeRows.map((row) => ({
      item_id: row[0],
      assignee_id: row[1],
    })),
    settings,
  };
};

const computeDueMetrics = (dueAt: number, now: number) => {
  const dayMs = 24 * 60 * 60 * 1000;
  const diffMs = dueAt - now;
  const isOverdue = diffMs < 0;
  return {
    is_overdue: isOverdue,
    days_until_due: isOverdue ? 0 : Math.ceil(diffMs / dayMs),
    days_overdue: isOverdue ? Math.ceil(Math.abs(diffMs) / dayMs) : 0,
  };
};

const computeHealth = (
  isOverdue: boolean,
  remainingMinutes: number,
  daysUntilDue: number,
  capacityPerDay: number | null
) => {
  if (isOverdue) {
    return "behind";
  }
  if (!capacityPerDay || remainingMinutes <= 0) {
    return "on_track";
  }
  const requiredPerDay = remainingMinutes / Math.max(1, daysUntilDue);
  if (requiredPerDay > capacityPerDay) {
    return "behind";
  }
  if (requiredPerDay >= capacityPerDay * 0.8) {
    return "at_risk";
  }
  return "on_track";
};

const hasDependencyCycle = (db: any, itemId: string, dependsOnId: string) => {
  const rows = db.exec({
    sql: `WITH RECURSIVE deps(id) AS (
      SELECT depends_on_id FROM dependencies WHERE item_id = ?
      UNION ALL
      SELECT d.depends_on_id FROM dependencies d JOIN deps ON d.item_id = deps.id
    )
    SELECT 1 FROM deps WHERE id = ? LIMIT 1;`,
    rowMode: "array",
    returnValue: "resultRows",
    bind: [dependsOnId, itemId],
  }) as Array<[number]>;

  return rows.length > 0;
};

const insertAuditLog = (
  db: any,
  envelope: MutateEnvelope,
  result: MutateResult
) => {
  const logId = crypto.randomUUID();
  const payload = JSON.stringify(envelope);
  const output = JSON.stringify(result);

  db.exec(
    "INSERT INTO audit_log (log_id, op_id, op_name, actor, ts, args_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?);",
    {
      bind: [
        logId,
        envelope.op_id,
        envelope.op_name,
        envelope.actor_id
          ? `${envelope.actor_type}:${envelope.actor_id}`
          : envelope.actor_type,
        envelope.ts,
        payload,
        output,
      ],
    }
  );
};

const withTransaction = (db: any, fn: () => MutateResult) => {
  db.exec("BEGIN;");
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
};

const runMigrations = (db: any) => {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);");
  const rows = db.exec({
    sql: "SELECT version FROM schema_version LIMIT 1;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[number]>;

  let currentVersion = rows.length === 0 ? 0 : Number(rows[0][0]);

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      db.exec(migration.sql);
      currentVersion = migration.version;
      if (rows.length === 0) {
        db.exec("INSERT INTO schema_version (version) VALUES (?);", {
          bind: [currentVersion],
        });
        rows.push([currentVersion]);
      } else {
        db.exec("UPDATE schema_version SET version = ?;", {
          bind: [currentVersion],
        });
      }
    }
  }

  return currentVersion;
};

const initDb = async () => {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      const sqlite3 = await sqlite3InitModule({
        print: () => {},
        printErr: () => {},
      });
      const poolUtil = await sqlite3.installOpfsSAHPoolVfs({
        name: VFS_NAME,
      });
      const db = new poolUtil.OpfsSAHPoolDb(DB_FILENAME);
      dbHandle = db;
      const schemaVersion = runMigrations(db);

      dbState.info = {
        ok: true,
        vfs: VFS_NAME,
        filename: DB_FILENAME,
        schemaVersion,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dbState.error = message;
      dbState.info = { ok: false, error: message };
    }
  })();

  return initPromise;
};

const handleMutate = (envelope: MutateEnvelope): MutateResult => {
  if (!dbHandle) {
    return { ok: false, error: "DB not initialized" };
  }

  return withTransaction(dbHandle, () => {
    const args = (envelope.args ?? {}) as Record<string, unknown>;
    let result: MutateResult = { ok: false, error: "Unknown error" };

    try {
      switch (envelope.op_name) {
        case "create_item": {
          const type = ensureString(args.type, "type");
          if (!["project", "milestone", "task"].includes(type)) {
            result = {
              ok: false,
              error: "type must be project, milestone, or task",
            };
            break;
          }
          const title = ensureString(args.title, "title");
          const dueAt = ensureNumber(args.due_at, "due_at");
          const estimateMinutes = ensureNumber(
            args.estimate_minutes,
            "estimate_minutes"
          );
          const id = crypto.randomUUID();
          const now = Date.now();
          const estimateMode =
            typeof args.estimate_mode === "string"
              ? args.estimate_mode
              : type === "task"
              ? "manual"
              : "rollup";
          const parentId =
            typeof args.parent_id === "string" ? args.parent_id : null;
          const status =
            typeof args.status === "string" ? args.status : "backlog";
          const priority =
            typeof args.priority === "number" ? args.priority : 0;
          const health =
            typeof args.health === "string" ? args.health : "unknown";
          const healthMode =
            typeof args.health_mode === "string" ? args.health_mode : "auto";
          const notes = typeof args.notes === "string" ? args.notes : null;

          dbHandle.exec(
            "INSERT INTO items (id, type, title, parent_id, status, priority, due_at, estimate_mode, estimate_minutes, health, health_mode, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
            {
              bind: [
                id,
                type,
                title,
                parentId,
                status,
                priority,
                dueAt,
                estimateMode,
                estimateMinutes,
                health,
                healthMode,
                notes,
                now,
                now,
              ],
            }
          );

          result = {
            ok: true,
            result: { id },
            invalidate: ["items", `item:${id}`],
          };
          break;
        }
        case "update_item_fields": {
          const id = ensureString(args.id, "id");
          const fields = args.fields as Record<string, unknown>;
          if (!fields || typeof fields !== "object") {
            result = { ok: false, error: "fields must be an object" };
            break;
          }
          const allowed = new Set([
            "title",
            "parent_id",
            "due_at",
            "estimate_minutes",
            "estimate_mode",
            "priority",
            "health",
            "health_mode",
            "notes",
          ]);
          const numericFields = new Set([
            "due_at",
            "estimate_minutes",
            "priority",
          ]);
          const updates: string[] = [];
          const bind: unknown[] = [];

          for (const [key, value] of Object.entries(fields)) {
            if (!allowed.has(key)) {
              continue;
            }
            if (numericFields.has(key)) {
              ensureNumber(value, key);
            }
            updates.push(`${key} = ?`);
            bind.push(value ?? null);
          }

          if (updates.length === 0) {
            result = { ok: false, error: "no valid fields to update" };
            break;
          }

          updates.push("updated_at = ?");
          bind.push(Date.now());
          bind.push(id);

          dbHandle.exec(
            `UPDATE items SET ${updates.join(", ")} WHERE id = ?;`,
            {
              bind,
            }
          );

          result = {
            ok: true,
            result: { id },
            invalidate: ["items", `item:${id}`],
          };
          break;
        }
        case "set_status": {
          const id = ensureString(args.id, "id");
          const status = ensureString(args.status, "status");
          dbHandle.exec(
            "UPDATE items SET status = ?, updated_at = ? WHERE id = ?;",
            {
              bind: [status, Date.now(), id],
            }
          );
          result = {
            ok: true,
            result: { id },
            invalidate: ["items", `item:${id}`],
          };
          break;
        }
        case "create_block": {
          const itemId = ensureString(args.item_id, "item_id");
          const startAt = ensureNumber(args.start_at, "start_at");
          const durationMinutes = ensureNumber(
            args.duration_minutes,
            "duration_minutes"
          );
          const blockId = crypto.randomUUID();
          const locked = typeof args.locked === "number" ? args.locked : 0;
          const source = typeof args.source === "string" ? args.source : "manual";
          dbHandle.exec(
            "INSERT INTO scheduled_blocks (block_id, item_id, start_at, duration_minutes, locked, source) VALUES (?, ?, ?, ?, ?, ?);",
            {
              bind: [blockId, itemId, startAt, durationMinutes, locked, source],
            }
          );
          result = {
            ok: true,
            result: { block_id: blockId },
            invalidate: ["blocks", `item:${itemId}`],
          };
          break;
        }
        case "move_block": {
          const blockId = ensureString(args.block_id, "block_id");
          const startAt = ensureNumber(args.start_at, "start_at");
          dbHandle.exec(
            "UPDATE scheduled_blocks SET start_at = ? WHERE block_id = ?;",
            { bind: [startAt, blockId] }
          );
          result = {
            ok: true,
            result: { block_id: blockId },
            invalidate: ["blocks"],
          };
          break;
        }
        case "resize_block": {
          const blockId = ensureString(args.block_id, "block_id");
          const durationMinutes = ensureNumber(
            args.duration_minutes,
            "duration_minutes"
          );
          dbHandle.exec(
            "UPDATE scheduled_blocks SET duration_minutes = ? WHERE block_id = ?;",
            { bind: [durationMinutes, blockId] }
          );
          result = {
            ok: true,
            result: { block_id: blockId },
            invalidate: ["blocks"],
          };
          break;
        }
        case "delete_block": {
          const blockId = ensureString(args.block_id, "block_id");
          dbHandle.exec("DELETE FROM scheduled_blocks WHERE block_id = ?;", {
            bind: [blockId],
          });
          result = {
            ok: true,
            result: { block_id: blockId },
            invalidate: ["blocks"],
          };
          break;
        }
        case "add_time_entry": {
          const itemId = ensureString(args.item_id, "item_id");
          const startAt = ensureNumber(args.start_at, "start_at");
          const endAt = ensureNumber(args.end_at, "end_at");
          const durationMinutes = ensureNumber(
            args.duration_minutes,
            "duration_minutes"
          );
          const entryId = crypto.randomUUID();
          const note = typeof args.note === "string" ? args.note : null;
          const source = typeof args.source === "string" ? args.source : "manual";
          dbHandle.exec(
            "INSERT INTO time_entries (entry_id, item_id, start_at, end_at, duration_minutes, note, source) VALUES (?, ?, ?, ?, ?, ?, ?);",
            {
              bind: [
                entryId,
                itemId,
                startAt,
                endAt,
                durationMinutes,
                note,
                source,
              ],
            }
          );
          result = {
            ok: true,
            result: { entry_id: entryId },
            invalidate: ["time_entries", `item:${itemId}`],
          };
          break;
        }
        case "set_setting": {
          const key = ensureString(args.key, "key");
          const value = args.value as unknown;
          const payload = JSON.stringify(value ?? null);
          dbHandle.exec(
            "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json;",
            {
              bind: [key, payload],
            }
          );
          result = {
            ok: true,
            result: { key },
            invalidate: ["settings"],
          };
          break;
        }
        case "export_data": {
          const data = exportData(dbHandle);
          result = {
            ok: true,
            result: data,
            invalidate: [],
          };
          break;
        }
        case "import_data": {
          const payload = args.payload as unknown;
          if (!payload || typeof payload !== "object") {
            result = { ok: false, error: "payload must be an object" };
            break;
          }

          const record = payload as Record<string, unknown>;
          const items = ensureArray(record.items, "items").map((value, index) => {
            if (!value || typeof value !== "object") {
              throw new Error(`items[${index}] must be an object`);
            }
            const item = value as Record<string, unknown>;
            return {
              id: ensureString(item.id, `items[${index}].id`),
              type: ensureString(item.type, `items[${index}].type`),
              title: ensureString(item.title, `items[${index}].title`),
              parent_id: ensureOptionalString(
                item.parent_id ?? null,
                `items[${index}].parent_id`
              ),
              status: ensureString(item.status, `items[${index}].status`),
              priority: ensureNumber(item.priority, `items[${index}].priority`),
              due_at: ensureNumber(item.due_at, `items[${index}].due_at`),
              estimate_mode: ensureString(
                item.estimate_mode,
                `items[${index}].estimate_mode`
              ),
              estimate_minutes: ensureNumber(
                item.estimate_minutes,
                `items[${index}].estimate_minutes`
              ),
              health: ensureString(item.health, `items[${index}].health`),
              health_mode: ensureString(
                item.health_mode,
                `items[${index}].health_mode`
              ),
              notes: ensureOptionalString(item.notes ?? null, `items[${index}].notes`),
              created_at: ensureNumber(item.created_at, `items[${index}].created_at`),
              updated_at: ensureNumber(item.updated_at, `items[${index}].updated_at`),
            };
          });

          const dependencies = ensureArray(record.dependencies, "dependencies").map(
            (value, index) => {
              if (!value || typeof value !== "object") {
                throw new Error(`dependencies[${index}] must be an object`);
              }
              const dep = value as Record<string, unknown>;
              return {
                item_id: ensureString(dep.item_id, `dependencies[${index}].item_id`),
                depends_on_id: ensureString(
                  dep.depends_on_id,
                  `dependencies[${index}].depends_on_id`
                ),
              };
            }
          );

          const blockers = ensureArray(record.blockers, "blockers").map(
            (value, index) => {
              if (!value || typeof value !== "object") {
                throw new Error(`blockers[${index}] must be an object`);
              }
              const blocker = value as Record<string, unknown>;
              return {
                blocker_id: ensureString(
                  blocker.blocker_id,
                  `blockers[${index}].blocker_id`
                ),
                item_id: ensureString(
                  blocker.item_id,
                  `blockers[${index}].item_id`
                ),
                reason: ensureOptionalString(
                  blocker.reason ?? null,
                  `blockers[${index}].reason`
                ),
                created_at: ensureNumber(
                  blocker.created_at,
                  `blockers[${index}].created_at`
                ),
                cleared_at: ensureOptionalNumber(
                  blocker.cleared_at ?? null,
                  `blockers[${index}].cleared_at`
                ),
              };
            }
          );

          const scheduledBlocks = ensureArray(
            record.scheduled_blocks,
            "scheduled_blocks"
          ).map((value, index) => {
            if (!value || typeof value !== "object") {
              throw new Error(`scheduled_blocks[${index}] must be an object`);
            }
            const block = value as Record<string, unknown>;
            return {
              block_id: ensureString(
                block.block_id,
                `scheduled_blocks[${index}].block_id`
              ),
              item_id: ensureString(
                block.item_id,
                `scheduled_blocks[${index}].item_id`
              ),
              start_at: ensureNumber(
                block.start_at,
                `scheduled_blocks[${index}].start_at`
              ),
              duration_minutes: ensureNumber(
                block.duration_minutes,
                `scheduled_blocks[${index}].duration_minutes`
              ),
              locked: ensureNumber(block.locked, `scheduled_blocks[${index}].locked`),
              source: ensureString(
                block.source,
                `scheduled_blocks[${index}].source`
              ),
            };
          });

          const timeEntries = ensureArray(record.time_entries, "time_entries").map(
            (value, index) => {
              if (!value || typeof value !== "object") {
                throw new Error(`time_entries[${index}] must be an object`);
              }
              const entry = value as Record<string, unknown>;
              return {
                entry_id: ensureString(
                  entry.entry_id,
                  `time_entries[${index}].entry_id`
                ),
                item_id: ensureString(
                  entry.item_id,
                  `time_entries[${index}].item_id`
                ),
                start_at: ensureNumber(
                  entry.start_at,
                  `time_entries[${index}].start_at`
                ),
                end_at: ensureNumber(
                  entry.end_at,
                  `time_entries[${index}].end_at`
                ),
                duration_minutes: ensureNumber(
                  entry.duration_minutes,
                  `time_entries[${index}].duration_minutes`
                ),
                note: ensureOptionalString(
                  entry.note ?? null,
                  `time_entries[${index}].note`
                ),
                source: ensureString(
                  entry.source,
                  `time_entries[${index}].source`
                ),
              };
            }
          );

          const itemTags = ensureArray(record.item_tags, "item_tags").map(
            (value, index) => {
              if (!value || typeof value !== "object") {
                throw new Error(`item_tags[${index}] must be an object`);
              }
              const tag = value as Record<string, unknown>;
              return {
                item_id: ensureString(tag.item_id, `item_tags[${index}].item_id`),
                tag: ensureString(tag.tag, `item_tags[${index}].tag`),
              };
            }
          );

          const itemAssignees = ensureArray(
            record.item_assignees,
            "item_assignees"
          ).map((value, index) => {
            if (!value || typeof value !== "object") {
              throw new Error(`item_assignees[${index}] must be an object`);
            }
            const assignee = value as Record<string, unknown>;
            return {
              item_id: ensureString(
                assignee.item_id,
                `item_assignees[${index}].item_id`
              ),
              assignee_id: ensureString(
                assignee.assignee_id,
                `item_assignees[${index}].assignee_id`
              ),
            };
          });

          const settings = ensureArray(record.settings, "settings").map(
            (value, index) => {
              if (!value || typeof value !== "object") {
                throw new Error(`settings[${index}] must be an object`);
              }
              const setting = value as Record<string, unknown>;
              return {
                key: ensureString(setting.key, `settings[${index}].key`),
                value: setting.value ?? null,
              };
            }
          );

          dbHandle.exec("DELETE FROM item_assignees;");
          dbHandle.exec("DELETE FROM item_tags;");
          dbHandle.exec("DELETE FROM dependencies;");
          dbHandle.exec("DELETE FROM blockers;");
          dbHandle.exec("DELETE FROM scheduled_blocks;");
          dbHandle.exec("DELETE FROM time_entries;");
          dbHandle.exec("DELETE FROM items;");
          dbHandle.exec("DELETE FROM settings;");

          for (const item of items) {
            dbHandle.exec(
              "INSERT INTO items (id, type, title, parent_id, status, priority, due_at, estimate_mode, estimate_minutes, health, health_mode, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
              {
                bind: [
                  item.id,
                  item.type,
                  item.title,
                  item.parent_id,
                  item.status,
                  item.priority,
                  item.due_at,
                  item.estimate_mode,
                  item.estimate_minutes,
                  item.health,
                  item.health_mode,
                  item.notes,
                  item.created_at,
                  item.updated_at,
                ],
              }
            );
          }

          for (const dep of dependencies) {
            dbHandle.exec(
              "INSERT INTO dependencies (item_id, depends_on_id) VALUES (?, ?);",
              { bind: [dep.item_id, dep.depends_on_id] }
            );
          }

          for (const blocker of blockers) {
            dbHandle.exec(
              "INSERT INTO blockers (blocker_id, item_id, reason, created_at, cleared_at) VALUES (?, ?, ?, ?, ?);",
              {
                bind: [
                  blocker.blocker_id,
                  blocker.item_id,
                  blocker.reason,
                  blocker.created_at,
                  blocker.cleared_at,
                ],
              }
            );
          }

          for (const block of scheduledBlocks) {
            dbHandle.exec(
              "INSERT INTO scheduled_blocks (block_id, item_id, start_at, duration_minutes, locked, source) VALUES (?, ?, ?, ?, ?, ?);",
              {
                bind: [
                  block.block_id,
                  block.item_id,
                  block.start_at,
                  block.duration_minutes,
                  block.locked,
                  block.source,
                ],
              }
            );
          }

          for (const entry of timeEntries) {
            dbHandle.exec(
              "INSERT INTO time_entries (entry_id, item_id, start_at, end_at, duration_minutes, note, source) VALUES (?, ?, ?, ?, ?, ?, ?);",
              {
                bind: [
                  entry.entry_id,
                  entry.item_id,
                  entry.start_at,
                  entry.end_at,
                  entry.duration_minutes,
                  entry.note,
                  entry.source,
                ],
              }
            );
          }

          for (const tag of itemTags) {
            dbHandle.exec("INSERT INTO item_tags (item_id, tag) VALUES (?, ?);", {
              bind: [tag.item_id, tag.tag],
            });
          }

          for (const assignee of itemAssignees) {
            dbHandle.exec(
              "INSERT INTO item_assignees (item_id, assignee_id) VALUES (?, ?);",
              { bind: [assignee.item_id, assignee.assignee_id] }
            );
          }

          for (const setting of settings) {
            dbHandle.exec(
              "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json;",
              { bind: [setting.key, JSON.stringify(setting.value ?? null)] }
            );
          }

          result = {
            ok: true,
            result: {
              counts: {
                items: items.length,
                dependencies: dependencies.length,
                blockers: blockers.length,
                scheduled_blocks: scheduledBlocks.length,
                time_entries: timeEntries.length,
                item_tags: itemTags.length,
                item_assignees: itemAssignees.length,
                settings: settings.length,
              },
            },
            invalidate: [
              "items",
              "dependencies",
              "blockers",
              "blocks",
              "time_entries",
              "settings",
            ],
          };
          break;
        }
        case "add_dependency": {
          const itemId = ensureString(args.item_id, "item_id");
          const dependsOnId = ensureString(args.depends_on_id, "depends_on_id");
          if (itemId === dependsOnId) {
            result = { ok: false, error: "cannot depend on itself" };
            break;
          }
          if (hasDependencyCycle(dbHandle, itemId, dependsOnId)) {
            result = { ok: false, error: "dependency cycle detected" };
            break;
          }
          dbHandle.exec(
            "INSERT OR IGNORE INTO dependencies (item_id, depends_on_id) VALUES (?, ?);",
            {
              bind: [itemId, dependsOnId],
            }
          );
          result = {
            ok: true,
            result: { item_id: itemId, depends_on_id: dependsOnId },
            invalidate: ["items", `item:${itemId}`, "dependencies"],
          };
          break;
        }
        case "remove_dependency": {
          const itemId = ensureString(args.item_id, "item_id");
          const dependsOnId = ensureString(args.depends_on_id, "depends_on_id");
          dbHandle.exec(
            "DELETE FROM dependencies WHERE item_id = ? AND depends_on_id = ?;",
            {
              bind: [itemId, dependsOnId],
            }
          );
          result = {
            ok: true,
            result: { item_id: itemId, depends_on_id: dependsOnId },
            invalidate: ["items", `item:${itemId}`, "dependencies"],
          };
          break;
        }
        case "add_blocker": {
          const itemId = ensureString(args.item_id, "item_id");
          const kind = ensureString(args.kind, "kind");
          const text = typeof args.text === "string" ? args.text.trim() : "";
          const reason = text ? `${kind}: ${text}` : kind;
          const blockerId = crypto.randomUUID();
          dbHandle.exec(
            "INSERT INTO blockers (blocker_id, item_id, reason, created_at, cleared_at) VALUES (?, ?, ?, ?, ?);",
            {
              bind: [blockerId, itemId, reason, envelope.ts, null],
            }
          );
          result = {
            ok: true,
            result: { blocker_id: blockerId },
            invalidate: ["items", `item:${itemId}`, "blockers"],
          };
          break;
        }
        case "clear_blocker": {
          const blockerId = ensureString(args.blocker_id, "blocker_id");
          dbHandle.exec("UPDATE blockers SET cleared_at = ? WHERE blocker_id = ?;", {
            bind: [envelope.ts, blockerId],
          });
          result = {
            ok: true,
            result: { blocker_id: blockerId },
            invalidate: ["items", "blockers"],
          };
          break;
        }
        default:
          result = { ok: false, error: `Unknown operation: ${envelope.op_name}` };
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: message };
    }

    insertAuditLog(dbHandle, envelope, result);
    return result;
  });
};

const handleRequest = async (message: RpcRequest): Promise<RpcResponse> => {
  if (message.method === "ping") {
    return {
      id: message.id,
      kind: "response",
      ok: true,
      result: {
        now: Date.now(),
        version: "v1",
      },
    };
  }

  if (message.method === "dbInfo") {
    return {
      id: message.id,
      kind: "response",
      ok: true,
      result: dbState.info ?? { ok: false, error: "DB not initialized" },
    };
  }

  if (message.method === "listTables") {
    if (!dbHandle) {
      return {
        id: message.id,
        kind: "response",
        ok: false,
        error: "DB not initialized",
      };
    }

    const tables = dbHandle.exec({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
      rowMode: "array",
      returnValue: "resultRows",
    }) as Array<[string]>;

    return {
      id: message.id,
      kind: "response",
      ok: true,
      result: tables.map((row) => row[0]),
    };
  }

  if (message.method === "listAudit") {
    if (!dbHandle) {
      return {
        id: message.id,
        kind: "response",
        ok: false,
        error: "DB not initialized",
      };
    }

    const rows = dbHandle.exec({
      sql: "SELECT log_id, op_id, op_name, actor, ts, args_json, result_json FROM audit_log ORDER BY ts DESC LIMIT 20;",
      rowMode: "array",
      returnValue: "resultRows",
    }) as Array<[string, string, string, string, number, string, string]>;

    return {
      id: message.id,
      kind: "response",
      ok: true,
      result: rows.map((row) => ({
        log_id: row[0],
        op_id: row[1],
        op_name: row[2],
        actor: row[3],
        ts: row[4],
        args_json: row[5],
        result_json: row[6],
      })),
    };
  }

  if (message.method === "mutate") {
    if (!dbHandle) {
      return {
        id: message.id,
        kind: "response",
        ok: false,
        error: "DB not initialized",
      };
    }

    const envelope = message.params as MutateEnvelope;
    try {
      ensureString(envelope.op_id, "op_id");
      ensureString(envelope.op_name, "op_name");
      ensureString(envelope.actor_type, "actor_type");
      ensureNumber(envelope.ts, "ts");
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      return {
        id: message.id,
        kind: "response",
        ok: true,
        result: { ok: false, error: messageText },
      };
    }

    try {
      const result = handleMutate(envelope);
      return {
        id: message.id,
        kind: "response",
        ok: true,
        result,
      };
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      const fallback: MutateResult = { ok: false, error: messageText };
      return {
        id: message.id,
        kind: "response",
        ok: true,
        result: fallback,
      };
    }
  }

  if (message.method === "query") {
    if (!dbHandle) {
      return {
        id: message.id,
        kind: "response",
        ok: false,
        error: "DB not initialized",
      };
    }

    const envelope = message.params as QueryEnvelope;
    if (!envelope || typeof envelope.name !== "string") {
      return {
        id: message.id,
        kind: "response",
        ok: true,
        result: { ok: false, error: "name must be provided" },
      };
    }

    try {
      const args = (envelope.args ?? {}) as Record<string, unknown>;
      let result: QueryResult = { ok: false, error: "Unknown query" };

      switch (envelope.name) {
        case "getItemDetails": {
          const itemId = ensureString(args.itemId, "itemId");
          const rows = dbHandle.exec({
            sql: "SELECT id, type, title, parent_id, status, priority, due_at, estimate_mode, estimate_minutes, health, health_mode, notes FROM items WHERE id = ? LIMIT 1;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string, string, string, string | null, string, number, number, string, number, string, string, string | null]>;

          if (rows.length === 0) {
            result = { ok: true, result: null };
            break;
          }

          const depsRows = dbHandle.exec({
            sql: "SELECT d.depends_on_id, i.status FROM dependencies d LEFT JOIN items i ON i.id = d.depends_on_id WHERE d.item_id = ?;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string, string | null]>;

          const blockersRows = dbHandle.exec({
            sql: "SELECT blocker_id, reason, created_at, cleared_at FROM blockers WHERE item_id = ? ORDER BY created_at DESC;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string, string | null, number, number | null]>;

          const hasActiveBlocker = blockersRows.some((row) => row[3] === null);
          const hasUnmetDep = depsRows.some(
            (row) => row[1] === null || row[1] !== "done"
          );

          const settings = getSettings(dbHandle);
          const capacityPerDay =
            typeof settings.get("capacity_minutes_per_day") === "number"
              ? (settings.get("capacity_minutes_per_day") as number)
              : null;
          const now = Date.now();
          const dueMetrics = computeDueMetrics(rows[0][6], now);
          const actualRows = dbHandle.exec({
            sql: "SELECT SUM(duration_minutes) FROM time_entries WHERE item_id = ?;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[number | null]>;
          const actualMinutes = actualRows[0]?.[0] ? Number(actualRows[0][0]) : 0;
          const remainingMinutes = Math.max(0, rows[0][8] - actualMinutes);
          const health = computeHealth(
            dueMetrics.is_overdue,
            remainingMinutes,
            dueMetrics.days_until_due,
            capacityPerDay
          );

          result = {
            ok: true,
            result: {
              id: rows[0][0],
              type: rows[0][1],
              title: rows[0][2],
              parent_id: rows[0][3],
              status: rows[0][4],
              priority: rows[0][5],
              due_at: rows[0][6],
              estimate_mode: rows[0][7],
              estimate_minutes: rows[0][8],
              health: rows[0][9],
              health_mode: rows[0][10],
              notes: rows[0][11],
              dependencies: depsRows.map((row) => row[0]),
              blockers: blockersRows.map((row) => ({
                blocker_id: row[0],
                reason: row[1],
                created_at: row[2],
                cleared_at: row[3],
              })),
              is_blocked: hasActiveBlocker || hasUnmetDep,
              days_until_due: dueMetrics.days_until_due,
              days_overdue: dueMetrics.days_overdue,
              is_overdue: dueMetrics.is_overdue,
              rollup_actual_minutes: actualMinutes,
              rollup_remaining_minutes: remainingMinutes,
              health_auto: health,
            },
          };
          break;
        }
        case "getProjectTree": {
          const projectId = ensureString(args.projectId, "projectId");
          const rows = dbHandle.exec({
            sql: `WITH RECURSIVE tree AS (
              SELECT * FROM items WHERE id = ?
              UNION ALL
              SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
            )
            SELECT id, type, title, parent_id, status, priority, due_at, estimate_mode, estimate_minutes, health, health_mode, notes
            FROM tree
            ORDER BY due_at ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: [projectId],
          }) as Array<[string, string, string, string | null, string, number, number, string, number, string, string, string | null]>;

          const ids = rows.map((row) => row[0]);
          const settings = getSettings(dbHandle);
          const capacityPerDay =
            typeof settings.get("capacity_minutes_per_day") === "number"
              ? (settings.get("capacity_minutes_per_day") as number)
              : null;
          const now = Date.now();

          const timeMap = new Map<string, number>();
          if (ids.length > 0) {
            const placeholders = ids.map(() => "?").join(", ");
            const timeRows = dbHandle.exec({
              sql: `SELECT item_id, SUM(duration_minutes) FROM time_entries WHERE item_id IN (${placeholders}) GROUP BY item_id;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: ids,
            }) as Array<[string, number]>;
            for (const row of timeRows) {
              timeMap.set(row[0], Number(row[1]));
            }
          }

          const nodeMap = new Map(
            rows.map((row) => [
              row[0],
              {
                id: row[0],
                type: row[1],
                title: row[2],
                parent_id: row[3],
                status: row[4],
                priority: row[5],
                due_at: row[6],
                estimate_mode: row[7],
                estimate_minutes: row[8],
                health: row[9],
                health_mode: row[10],
                notes: row[11],
                children: [] as string[],
                totalEstimate: 0,
                totalActual: 0,
              },
            ])
          );

          for (const node of nodeMap.values()) {
            if (node.parent_id && nodeMap.has(node.parent_id)) {
              nodeMap.get(node.parent_id)!.children.push(node.id);
            }
          }

          const computeTotals = (id: string): { estimate: number; actual: number } => {
            const node = nodeMap.get(id);
            if (!node) {
              return { estimate: 0, actual: 0 };
            }
            let estimate = node.estimate_minutes;
            let actual = timeMap.get(id) ?? 0;
            for (const childId of node.children) {
              const childTotals = computeTotals(childId);
              estimate += childTotals.estimate;
              actual += childTotals.actual;
            }
            node.totalEstimate = estimate;
            node.totalActual = actual;
            return { estimate, actual };
          };

          computeTotals(projectId);

          result = {
            ok: true,
            result: rows.map((row) => {
              const node = nodeMap.get(row[0]);
              const totalEstimate = node ? node.totalEstimate : row[8];
              const totalActual = node ? node.totalActual : timeMap.get(row[0]) ?? 0;
              const rollupEstimate =
                row[1] === "task" ? row[8] : Math.max(0, totalEstimate - row[8]);
              const rollupActual = row[1] === "task" ? totalActual : totalActual;
              const rollupRemaining = Math.max(0, rollupEstimate - rollupActual);
              const dueMetrics = computeDueMetrics(row[6], now);
              const health = computeHealth(
                dueMetrics.is_overdue,
                rollupRemaining,
                dueMetrics.days_until_due,
                capacityPerDay
              );

              return {
                id: row[0],
                type: row[1],
                title: row[2],
                parent_id: row[3],
                status: row[4],
                priority: row[5],
                due_at: row[6],
                estimate_mode: row[7],
                estimate_minutes: row[8],
                health: row[9],
                health_mode: row[10],
                notes: row[11],
                rollup_estimate_minutes: rollupEstimate,
                rollup_actual_minutes: rollupActual,
                rollup_remaining_minutes: rollupRemaining,
                days_until_due: dueMetrics.days_until_due,
                days_overdue: dueMetrics.days_overdue,
                is_overdue: dueMetrics.is_overdue,
                health_auto: health,
              };
            }),
          };
          break;
        }
        case "listKanban": {
          const projectId =
            typeof args.projectId === "string" ? args.projectId : null;
          const rows = dbHandle.exec({
            sql: projectId
              ? `SELECT id, type, title, parent_id, status, priority, due_at,
                (
                  EXISTS(SELECT 1 FROM blockers b WHERE b.item_id = items.id AND b.cleared_at IS NULL)
                  OR EXISTS(
                    SELECT 1 FROM dependencies d
                    LEFT JOIN items di ON di.id = d.depends_on_id
                    WHERE d.item_id = items.id AND (di.id IS NULL OR di.status != 'done')
                  )
                ) AS is_blocked
                FROM items WHERE parent_id = ? ORDER BY due_at ASC;`
              : `SELECT id, type, title, parent_id, status, priority, due_at,
                (
                  EXISTS(SELECT 1 FROM blockers b WHERE b.item_id = items.id AND b.cleared_at IS NULL)
                  OR EXISTS(
                    SELECT 1 FROM dependencies d
                    LEFT JOIN items di ON di.id = d.depends_on_id
                    WHERE d.item_id = items.id AND (di.id IS NULL OR di.status != 'done')
                  )
                ) AS is_blocked
                FROM items ORDER BY due_at ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<[string, string, string, string | null, string, number, number, number]>;

          result = {
            ok: true,
            result: rows.map((row) => ({
              id: row[0],
              type: row[1],
              title: row[2],
              parent_id: row[3],
              status: row[4],
              priority: row[5],
              due_at: row[6],
              is_blocked: Boolean(row[7]),
            })),
          };
          break;
        }
        case "listOverdue": {
          const now = Date.now();
          const rows = dbHandle.exec({
            sql: "SELECT id, type, title, parent_id, status, priority, due_at FROM items WHERE due_at < ? AND status NOT IN ('done', 'canceled') ORDER BY due_at ASC;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [now],
          }) as Array<[string, string, string, string | null, string, number, number]>;

          result = {
            ok: true,
            result: rows.map((row) => {
              const dueMetrics = computeDueMetrics(row[6], now);
              return {
                id: row[0],
                type: row[1],
                title: row[2],
                parent_id: row[3],
                status: row[4],
                priority: row[5],
                due_at: row[6],
                days_overdue: dueMetrics.days_overdue,
              };
            }),
          };
          break;
        }
        case "listDueSoon": {
          const days = ensureNumber(args.days, "days");
          const now = Date.now();
          const end = now + days * 24 * 60 * 60 * 1000;
          const rows = dbHandle.exec({
            sql: "SELECT id, type, title, parent_id, status, priority, due_at FROM items WHERE due_at >= ? AND due_at <= ? ORDER BY due_at ASC;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [now, end],
          }) as Array<[string, string, string, string | null, string, number, number]>;

          result = {
            ok: true,
            result: rows.map((row) => {
              const dueMetrics = computeDueMetrics(row[6], now);
              return {
                id: row[0],
                type: row[1],
                title: row[2],
                parent_id: row[3],
                status: row[4],
                priority: row[5],
                due_at: row[6],
                days_until_due: dueMetrics.days_until_due,
              };
            }),
          };
          break;
        }
        case "getSettings": {
          const settings = getSettings(dbHandle);
          result = {
            ok: true,
            result: Object.fromEntries(settings.entries()),
          };
          break;
        }
        case "listCalendarBlocks": {
          const startAt = ensureNumber(args.startAt, "startAt");
          const endAt = ensureNumber(args.endAt, "endAt");
          const rows = dbHandle.exec({
            sql: "SELECT block_id, item_id, start_at, duration_minutes, locked, source FROM scheduled_blocks WHERE start_at BETWEEN ? AND ? ORDER BY start_at ASC;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [startAt, endAt],
          }) as Array<[string, string, number, number, number, string]>;

          result = {
            ok: true,
            result: rows.map((row) => ({
              block_id: row[0],
              item_id: row[1],
              start_at: row[2],
              duration_minutes: row[3],
              locked: row[4],
              source: row[5],
            })),
          };
          break;
        }
        default:
          result = { ok: false, error: `Unknown query: ${envelope.name}` };
          break;
      }

      return {
        id: message.id,
        kind: "response",
        ok: true,
        result,
      };
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      return {
        id: message.id,
        kind: "response",
        ok: true,
        result: { ok: false, error: messageText },
      };
    }
  }

  return {
    id: message.id,
    kind: "response",
    ok: false,
    error: `Unknown method: ${message.method}`,
  };
};

ctx.addEventListener("message", (event: MessageEvent<RpcRequest>) => {
  const message = event.data;

  if (!message || message.kind !== "request") {
    return;
  }

  if (
    message.method === "dbInfo" ||
    message.method === "listTables" ||
    message.method === "listAudit" ||
    message.method === "mutate" ||
    message.method === "query"
  ) {
    void initDb().then(async () => {
      const response = await handleRequest(message);
      ctx.postMessage(response);
    });
    return;
  }

  void (async () => {
    const response = await handleRequest(message);
    ctx.postMessage(response);
  })();
});
