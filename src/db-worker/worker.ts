import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { RpcRequest, RpcResponse, Scope, QueryFilters } from "../rpc/types";
import initSql from "./migrations/0001_init.sql?raw";
import blockersKindTextSql from "./migrations/0002_blockers_kind_text.sql?raw";
import runningTimersSql from "./migrations/0003_running_timers.sql?raw";
import sortOrderSql from "./migrations/0004_sort_order.sql?raw";
import projectIdSql from "./migrations/0005_project_id.sql?raw";
import scheduledForSql from "./migrations/0006_scheduled_for.sql?raw";

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
  error?: string | { code: string; message: string };
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

const resolveScope = (args: Record<string, unknown>): Scope | null => {
  const scope = args.scope;
  if (scope && typeof scope === "object") {
    const scoped = scope as { kind?: unknown; id?: unknown };
    if (typeof scoped.kind === "string" && typeof scoped.id === "string") {
      return scoped as Scope;
    }
  }
  if (typeof args.projectId === "string") {
    return { kind: "project", id: args.projectId };
  }
  return null;
};

const resolveFilters = (args: Record<string, unknown>): QueryFilters => {
  const filters = args.filters;
  if (!filters || typeof filters !== "object") {
    return {};
  }
  return filters as QueryFilters;
};

const ensureProjectScope = (scope: Scope | null) => {
  if (!scope) {
    return null;
  }
  if (scope.kind !== "project") {
    throw new Error(`Scope kind not implemented: ${scope.kind}`);
  }
  return scope.id;
};

const backfillProjectIds = (db: any) => {
  db.exec("UPDATE items SET project_id = id WHERE type = 'project';");
  db.exec({
    sql: `WITH RECURSIVE chain(id, parent_id, project_id) AS (
      SELECT id, parent_id,
        CASE WHEN type = 'project' THEN id ELSE NULL END
      FROM items
      UNION ALL
      SELECT c.id, p.parent_id,
        COALESCE(c.project_id, CASE WHEN p.type = 'project' THEN p.id ELSE p.project_id END)
      FROM chain c
      JOIN items p ON p.id = c.parent_id
      WHERE c.project_id IS NULL AND c.parent_id IS NOT NULL
    )
    UPDATE items
    SET project_id = (
      SELECT chain.project_id
      FROM chain
      WHERE chain.id = items.id AND chain.project_id IS NOT NULL
      LIMIT 1
    )
    WHERE project_id IS NULL;`,
  });
};

const resolveProjectIdFromParent = (db: any, parentId: string) => {
  const rows = db.exec({
    sql: "SELECT id, type, project_id FROM items WHERE id = ? LIMIT 1;",
    rowMode: "array",
    returnValue: "resultRows",
    bind: [parentId],
  }) as Array<[string, string, string | null]>;
  if (rows.length === 0) {
    throw new Error("parent item not found");
  }
  const [id, type, projectId] = rows[0];
  if (type === "project") {
    return id;
  }
  if (projectId) {
    return projectId;
  }
  throw new Error("parent project_id not found");
};

const migrations = [
  {
    version: 1,
    sql: initSql,
  },
  {
    version: 2,
    sql: blockersKindTextSql,
  },
  {
    version: 3,
    sql: runningTimersSql,
  },
  {
    version: 4,
    sql: sortOrderSql,
  },
  {
    version: 5,
    sql: projectIdSql,
  },
  {
    version: 6,
    sql: scheduledForSql,
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

const ensureInteger = (value: unknown, name: string) => {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
};

const minNullable = (a: number | null, b: number | null) => {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
};

const maxNullable = (a: number | null, b: number | null) => {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
};

const ensureNonNegativeInteger = (value: unknown, name: string) => {
  const intValue = ensureInteger(value, name);
  if (intValue < 0) {
    throw new Error(`${name} must be 0 or greater`);
  }
  return intValue;
};

const ensurePositiveInteger = (value: unknown, name: string) => {
  const intValue = ensureInteger(value, name);
  if (intValue <= 0) {
    throw new Error(`${name} must be greater than 0`);
  }
  return intValue;
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

const buildPlaceholders = (count: number) =>
  count > 0 ? Array.from({ length: count }, () => "?").join(", ") : "";

const getScheduleSummaryMap = (db: any, ids: string[]) => {
  const map = new Map<
    string,
    { count: number; total: number; start: number | null; end: number | null }
  >();
  if (ids.length === 0) {
    return map;
  }
  const placeholders = buildPlaceholders(ids.length);
  const rows = db.exec({
    sql: `SELECT item_id,
      COUNT(*) AS block_count,
      SUM(duration_minutes) AS total_minutes,
      MIN(start_at) AS start_at,
      MAX(start_at + duration_minutes * 60000) AS end_at
      FROM scheduled_blocks
      WHERE item_id IN (${placeholders})
      GROUP BY item_id;`,
    rowMode: "array",
    returnValue: "resultRows",
    bind: ids,
  }) as Array<[string, number, number | null, number | null, number | null]>;
  for (const row of rows) {
    map.set(row[0], {
      count: Number(row[1]),
      total: row[2] ? Number(row[2]) : 0,
      start: row[3] !== null ? Number(row[3]) : null,
      end: row[4] !== null ? Number(row[4]) : null,
    });
  }
  return map;
};

const getBlockedStatusMap = (db: any, ids: string[]) => {
  const map = new Map<
    string,
    { hasBlocker: boolean; hasUnmetDep: boolean; is_blocked: boolean }
  >();
  if (ids.length === 0) {
    return map;
  }
  const placeholders = buildPlaceholders(ids.length);
  const rows = db.exec({
    sql: `SELECT id,
      EXISTS(SELECT 1 FROM blockers b WHERE b.item_id = items.id AND b.cleared_at IS NULL) AS has_blocker,
      EXISTS(
        SELECT 1 FROM dependencies d
        LEFT JOIN items di ON di.id = d.depends_on_id
        WHERE d.item_id = items.id AND (di.id IS NULL OR di.status != 'done')
      ) AS has_unmet_dep
      FROM items WHERE id IN (${placeholders});`,
    rowMode: "array",
    returnValue: "resultRows",
    bind: ids,
  }) as Array<[string, number, number]>;
  for (const row of rows) {
    const hasBlocker = Boolean(row[1]);
    const hasUnmetDep = Boolean(row[2]);
    map.set(row[0], {
      hasBlocker,
      hasUnmetDep,
      is_blocked: hasBlocker || hasUnmetDep,
    });
  }
  return map;
};

const getAssigneesMap = (db: any, ids: string[]) => {
  const map = new Map<string, string[]>();
  if (ids.length === 0) {
    return map;
  }
  const placeholders = buildPlaceholders(ids.length);
  const rows = db.exec({
    sql: `SELECT item_id, assignee_id FROM item_assignees WHERE item_id IN (${placeholders});`,
    rowMode: "array",
    returnValue: "resultRows",
    bind: ids,
  }) as Array<[string, string]>;
  for (const row of rows) {
    const list = map.get(row[0]) ?? [];
    list.push(row[1]);
    map.set(row[0], list);
  }
  return map;
};

const getTagsMap = (db: any, ids: string[]) => {
  const map = new Map<string, string[]>();
  if (ids.length === 0) {
    return map;
  }
  const placeholders = buildPlaceholders(ids.length);
  const rows = db.exec({
    sql: `SELECT item_id, tag FROM item_tags WHERE item_id IN (${placeholders});`,
    rowMode: "array",
    returnValue: "resultRows",
    bind: ids,
  }) as Array<[string, string]>;
  for (const row of rows) {
    const list = map.get(row[0]) ?? [];
    list.push(row[1]);
    map.set(row[0], list);
  }
  return map;
};

const getDependenciesMap = (db: any, ids: string[]) => {
  const map = new Map<string, string[]>();
  if (ids.length === 0) {
    return map;
  }
  const placeholders = buildPlaceholders(ids.length);
  const rows = db.exec({
    sql: `SELECT item_id, depends_on_id FROM dependencies WHERE item_id IN (${placeholders});`,
    rowMode: "array",
    returnValue: "resultRows",
    bind: ids,
  }) as Array<[string, string]>;
  for (const row of rows) {
    const list = map.get(row[0]) ?? [];
    list.push(row[1]);
    map.set(row[0], list);
  }
  return map;
};

const getDependentsCountMap = (db: any, ids: string[]) => {
  const map = new Map<string, number>();
  if (ids.length === 0) {
    return map;
  }
  const placeholders = buildPlaceholders(ids.length);
  const rows = db.exec({
    sql: `SELECT depends_on_id, COUNT(*) FROM dependencies
      WHERE depends_on_id IN (${placeholders})
      GROUP BY depends_on_id;`,
    rowMode: "array",
    returnValue: "resultRows",
    bind: ids,
  }) as Array<[string, number]>;
  for (const row of rows) {
    map.set(row[0], Number(row[1]));
  }
  return map;
};

const getActiveBlockerCountMap = (db: any, ids: string[]) => {
  const map = new Map<string, number>();
  if (ids.length === 0) {
    return map;
  }
  const placeholders = buildPlaceholders(ids.length);
  const rows = db.exec({
    sql: `SELECT item_id, COUNT(*) FROM blockers
      WHERE item_id IN (${placeholders}) AND cleared_at IS NULL
      GROUP BY item_id;`,
    rowMode: "array",
    returnValue: "resultRows",
    bind: ids,
  }) as Array<[string, number]>;
  for (const row of rows) {
    map.set(row[0], Number(row[1]));
  }
  return map;
};

const getUnmetDependencyMap = (db: any, ids: string[]) => {
  const map = new Map<string, { count: number; ids: string[] }>();
  if (ids.length === 0) {
    return map;
  }
  const placeholders = buildPlaceholders(ids.length);
  const rows = db.exec({
    sql: `SELECT d.item_id, d.depends_on_id
      FROM dependencies d
      LEFT JOIN items di ON di.id = d.depends_on_id
      WHERE d.item_id IN (${placeholders})
        AND (di.id IS NULL OR di.status != 'done');`,
    rowMode: "array",
    returnValue: "resultRows",
    bind: ids,
  }) as Array<[string, string]>;
  for (const row of rows) {
    const entry = map.get(row[0]) ?? { count: 0, ids: [] };
    entry.count += 1;
    entry.ids.push(row[1]);
    map.set(row[0], entry);
  }
  return map;
};

const getActiveBlockerIdsMap = (db: any, ids: string[]) => {
  const map = new Map<string, string[]>();
  if (ids.length === 0) {
    return map;
  }
  const placeholders = buildPlaceholders(ids.length);
  const rows = db.exec({
    sql: `SELECT blocker_id, item_id FROM blockers
      WHERE item_id IN (${placeholders}) AND cleared_at IS NULL;`,
    rowMode: "array",
    returnValue: "resultRows",
    bind: ids,
  }) as Array<[string, string]>;
  for (const row of rows) {
    const list = map.get(row[1]) ?? [];
    list.push(row[0]);
    map.set(row[1], list);
  }
  return map;
};

const buildHierarchyMaps = (
  rows: Array<[string, string, string | null]>,
  rootId: string | null
) => {
  const parentMap = new Map<string, string | null>();
  const typeMap = new Map<string, string>();
  for (const row of rows) {
    parentMap.set(row[0], row[2]);
    typeMap.set(row[0], row[1]);
  }

  const depthMap = new Map<string, number>();
  const projectMap = new Map<string, string>();

  const resolveDepth = (id: string): number => {
    if (depthMap.has(id)) {
      return depthMap.get(id)!;
    }
    const parentId = parentMap.get(id) ?? null;
    if (rootId && id === rootId) {
      depthMap.set(id, 0);
      return 0;
    }
    if (!parentId || parentId === id) {
      depthMap.set(id, 0);
      return 0;
    }
    const depth = resolveDepth(parentId) + 1;
    depthMap.set(id, depth);
    return depth;
  };

  const resolveProjectId = (id: string): string => {
    if (projectMap.has(id)) {
      return projectMap.get(id)!;
    }
    if (typeMap.get(id) === "project") {
      projectMap.set(id, id);
      return id;
    }
    const parentId = parentMap.get(id) ?? null;
    if (!parentId || parentId === id) {
      projectMap.set(id, id);
      return id;
    }
    const projectId = resolveProjectId(parentId);
    projectMap.set(id, projectId);
    return projectId;
  };

  for (const row of rows) {
    resolveDepth(row[0]);
    resolveProjectId(row[0]);
  }

  return { depthMap, projectMap };
};

const computeSequenceRank = (data: {
  is_overdue: boolean;
  is_blocked: boolean;
  due_at: number;
  priority: number;
  dependents: number;
}) => {
  const overdueScore = data.is_overdue ? 0 : 1;
  const blockedScore = data.is_blocked ? 1 : 0;
  const dueKey = Math.floor(data.due_at / 60000);
  const priorityScore = 5 - data.priority;
  return (
    overdueScore * 1e15 +
    blockedScore * 1e14 +
    dueKey * 1e4 +
    priorityScore * 1e2 -
    data.dependents
  );
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
    sql: "SELECT id, type, title, parent_id, project_id, status, priority, due_at, scheduled_for, scheduled_duration_minutes, estimate_mode, estimate_minutes, health, health_mode, notes, created_at, updated_at, sort_order FROM items;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<
    [
      string,
      string,
      string,
      string | null,
      string | null,
      string,
      number,
      number,
      number | null,
      number | null,
      string,
      number,
      string,
      string,
      string | null,
      number,
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
    sql: "SELECT blocker_id, item_id, kind, text, created_at, cleared_at FROM blockers;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string, string, string, number, number | null]>;

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

  const runningTimerRows = db.exec({
    sql: "SELECT item_id, start_at, note FROM running_timers;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, number, string | null]>;

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
      project_id: row[4],
      status: row[5],
      priority: row[6],
      due_at: row[7],
      scheduled_for: row[8],
      scheduled_duration_minutes: row[9],
      estimate_mode: row[10],
      estimate_minutes: row[11],
      health: row[12],
      health_mode: row[13],
      notes: row[14],
      created_at: row[15],
      updated_at: row[16],
      sort_order: row[17],
    })),
    dependencies: dependencyRows.map((row) => ({
      item_id: row[0],
      depends_on_id: row[1],
    })),
    blockers: blockerRows.map((row) => ({
      blocker_id: row[0],
      item_id: row[1],
      kind: row[2],
      text: row[3],
      created_at: row[4],
      cleared_at: row[5],
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
    running_timers: runningTimerRows.map((row) => ({
      item_id: row[0],
      start_at: row[1],
      note: row[2],
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

const computeDueMetrics = (dueAt: number, now: number, status: string) => {
  const dayMs = 24 * 60 * 60 * 1000;
  const diffMs = dueAt - now;
  const isOverdue = diffMs < 0 && status !== "done" && status !== "canceled";
  return {
    is_overdue: isOverdue,
    days_until_due: isOverdue ? 0 : Math.max(0, Math.ceil(diffMs / dayMs)),
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
          const dueAt = ensureInteger(args.due_at, "due_at");
          const estimateMinutes = ensureNonNegativeInteger(
            args.estimate_minutes,
            "estimate_minutes"
          );
          const parentId =
            typeof args.parent_id === "string" ? args.parent_id : null;
          const id = crypto.randomUUID();
          const now = Date.now();
          let projectId: string;
          if (type === "project") {
            if (parentId) {
              result = { ok: false, error: "project parent_id must be null" };
              break;
            }
            projectId = id;
          } else {
            if (!parentId) {
              result = {
                ok: false,
                error: "parent_id required for non-project items",
              };
              break;
            }
            projectId = resolveProjectIdFromParent(dbHandle, parentId);
          }
          const sortOrderRows = dbHandle.exec({
            sql: "SELECT parent_id, MAX(sort_order) FROM items WHERE parent_id IS ?;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [parentId],
          }) as Array<[string | null, number | null]>;
          const maxSortOrder =
            sortOrderRows.length > 0 && sortOrderRows[0][1] !== null
              ? Number(sortOrderRows[0][1])
              : 0;
          const sortOrder = maxSortOrder + 1;
          const estimateMode =
            typeof args.estimate_mode === "string"
              ? args.estimate_mode
              : type === "task"
              ? "manual"
              : "rollup";
          const status =
            typeof args.status === "string" ? args.status : "backlog";
          const priority =
            typeof args.priority === "number" ? args.priority : 0;
          const health =
            typeof args.health === "string" ? args.health : "unknown";
          const healthMode =
            typeof args.health_mode === "string" ? args.health_mode : "auto";
          const notes = typeof args.notes === "string" ? args.notes : null;
          const scheduledFor =
            typeof args.scheduled_for === "number"
              ? ensureInteger(args.scheduled_for, "scheduled_for")
              : null;
          const scheduledDuration =
            typeof args.scheduled_duration_minutes === "number"
              ? ensurePositiveInteger(
                  args.scheduled_duration_minutes,
                  "scheduled_duration_minutes"
                )
              : null;

          dbHandle.exec(
            "INSERT INTO items (id, type, title, parent_id, project_id, status, priority, due_at, scheduled_for, scheduled_duration_minutes, estimate_mode, estimate_minutes, health, health_mode, notes, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
            {
              bind: [
                id,
                type,
                title,
                parentId,
                projectId,
                status,
                priority,
                dueAt,
                scheduledFor,
                scheduledDuration,
                estimateMode,
                estimateMinutes,
                health,
                healthMode,
                notes,
                now,
                now,
                sortOrder,
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
          if (Object.prototype.hasOwnProperty.call(fields, "project_id")) {
            delete fields.project_id;
          }
          const allowed = new Set([
            "title",
            "parent_id",
            "due_at",
            "scheduled_for",
            "scheduled_duration_minutes",
            "estimate_minutes",
            "estimate_mode",
            "priority",
            "health",
            "health_mode",
            "notes",
            "sort_order",
            "project_id",
          ]);
          const numericFields = new Set([
            "due_at",
            "scheduled_for",
            "scheduled_duration_minutes",
            "estimate_minutes",
            "priority",
            "sort_order",
          ]);
          const updates: string[] = [];
          const bind: unknown[] = [];
          const parentIdProvided = Object.prototype.hasOwnProperty.call(
            fields,
            "parent_id"
          );
          if (parentIdProvided) {
            const parentValue = fields.parent_id;
            const nextParentId =
              typeof parentValue === "string"
                ? parentValue
                : parentValue === null
                  ? null
                  : undefined;
            if (nextParentId === undefined) {
              result = { ok: false, error: "parent_id must be string or null" };
              break;
            }
            const row = dbHandle.exec({
              sql: "SELECT type, project_id FROM items WHERE id = ? LIMIT 1;",
              rowMode: "array",
              returnValue: "resultRows",
              bind: [id],
            }) as Array<[string, string | null]>;
            if (row.length === 0) {
              result = { ok: false, error: "item not found" };
              break;
            }
            const itemType = row[0][0];
            if (itemType === "project") {
              if (nextParentId !== null) {
                result = { ok: false, error: "project parent_id must be null" };
                break;
              }
            } else {
              if (!nextParentId && itemType !== "task") {
                result = { ok: false, error: "parent_id required" };
                break;
              }
              if (nextParentId) {
                fields.project_id = resolveProjectIdFromParent(
                  dbHandle,
                  nextParentId
                );
              }
            }
          }

          for (const [key, value] of Object.entries(fields)) {
            if (!allowed.has(key)) {
              continue;
            }
            if (numericFields.has(key)) {
              ensureNumber(value, key);
            }
            if (key === "scheduled_duration_minutes" && value !== null) {
              ensurePositiveInteger(value, key);
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
          if (parentIdProvided && typeof fields.project_id === "string") {
            dbHandle.exec({
              sql: `WITH RECURSIVE subtree AS (
                SELECT id FROM items WHERE id = ?
                UNION ALL
                SELECT i.id FROM items i JOIN subtree s ON i.parent_id = s.id
              )
              UPDATE items SET project_id = ? WHERE id IN (SELECT id FROM subtree);`,
              bind: [id, fields.project_id],
            });
          }

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
          const override = args.override === true;
          if (status === "in_progress") {
            const blockRows = dbHandle.exec({
              sql: `SELECT
                EXISTS(SELECT 1 FROM blockers b WHERE b.item_id = ? AND b.cleared_at IS NULL) AS has_blocker,
                EXISTS(
                  SELECT 1 FROM dependencies d
                  LEFT JOIN items di ON di.id = d.depends_on_id
                  WHERE d.item_id = ? AND (di.id IS NULL OR di.status != 'done')
                ) AS has_unmet;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: [id, id],
            }) as Array<[number, number]>;
            const hasBlocker = blockRows[0]?.[0] === 1;
            const hasUnmet = blockRows[0]?.[1] === 1;
            if ((hasBlocker || hasUnmet) && !override) {
              result = {
                ok: false,
                error: {
                  code: "BLOCKED",
                  message: "Item is blocked and cannot move to in_progress.",
                },
              };
              break;
            }
          }
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
          const startAt = ensureInteger(args.start_at, "start_at");
          const durationMinutes = ensurePositiveInteger(
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
          const durationMinutes = ensurePositiveInteger(
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
        case "delete_item": {
          const itemId = ensureString(args.item_id, "item_id");
          const idsRows = dbHandle.exec({
            sql: `WITH RECURSIVE subtree AS (
              SELECT id FROM items WHERE id = ?
              UNION ALL
              SELECT i.id FROM items i JOIN subtree s ON i.parent_id = s.id
            )
            SELECT id FROM subtree;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string]>;
          const deletedIds = idsRows.map((row) => row[0]);
          if (deletedIds.length === 0) {
            result = { ok: false, error: "item not found" };
            break;
          }
          const placeholders = buildPlaceholders(deletedIds.length);
          dbHandle.exec(`DELETE FROM dependencies WHERE item_id IN (${placeholders}) OR depends_on_id IN (${placeholders});`, {
            bind: [...deletedIds, ...deletedIds],
          });
          dbHandle.exec(`DELETE FROM blockers WHERE item_id IN (${placeholders});`, {
            bind: deletedIds,
          });
          dbHandle.exec(`DELETE FROM scheduled_blocks WHERE item_id IN (${placeholders});`, {
            bind: deletedIds,
          });
          dbHandle.exec(`DELETE FROM time_entries WHERE item_id IN (${placeholders});`, {
            bind: deletedIds,
          });
          dbHandle.exec(`DELETE FROM running_timers WHERE item_id IN (${placeholders});`, {
            bind: deletedIds,
          });
          dbHandle.exec(`DELETE FROM item_tags WHERE item_id IN (${placeholders});`, {
            bind: deletedIds,
          });
          dbHandle.exec(`DELETE FROM item_assignees WHERE item_id IN (${placeholders});`, {
            bind: deletedIds,
          });
          dbHandle.exec(`DELETE FROM items WHERE id IN (${placeholders});`, {
            bind: deletedIds,
          });
          result = {
            ok: true,
            result: { deleted_ids: deletedIds },
            invalidate: [
              "items",
              "dependencies",
              "blockers",
              "blocks",
              "time_entries",
              "running_timers",
            ],
          };
          break;
        }
        case "reorder_item": {
          const itemId = ensureString(args.item_id, "item_id");
          const direction = ensureString(args.direction, "direction");
          if (direction !== "up" && direction !== "down") {
            result = { ok: false, error: "direction must be up or down" };
            break;
          }
          const rows = dbHandle.exec({
            sql: "SELECT parent_id, sort_order FROM items WHERE id = ? LIMIT 1;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string | null, number]>;
          if (rows.length === 0) {
            result = { ok: false, error: "item not found" };
            break;
          }
          const parentId = rows[0][0] ?? null;
          const sortOrder = Number(rows[0][1]);
          const siblingRows = dbHandle.exec({
            sql:
              "SELECT id, sort_order FROM items WHERE parent_id IS ? ORDER BY sort_order ASC, due_at ASC, title ASC;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [parentId],
          }) as Array<[string, number]>;
          const index = siblingRows.findIndex((row) => row[0] === itemId);
          if (index === -1) {
            result = { ok: false, error: "item not found" };
            break;
          }
          const swapWith =
            direction === "up" ? siblingRows[index - 1] : siblingRows[index + 1];
          if (!swapWith) {
            result = { ok: true, result: { id: itemId, sort_order: sortOrder } };
            break;
          }
          const otherId = swapWith[0];
          const otherSort = Number(swapWith[1]);
          dbHandle.exec("UPDATE items SET sort_order = ? WHERE id = ?;", {
            bind: [otherSort, itemId],
          });
          dbHandle.exec("UPDATE items SET sort_order = ? WHERE id = ?;", {
            bind: [sortOrder, otherId],
          });
          result = {
            ok: true,
            result: { id: itemId, sort_order: otherSort },
            invalidate: ["items", `item:${itemId}`],
          };
          break;
        }
        case "move_item": {
          const itemId = ensureString(args.item_id, "item_id");
          const parentId =
            typeof args.parent_id === "string" ? args.parent_id : null;
          const beforeId =
            typeof args.before_id === "string" ? args.before_id : null;
          const afterId =
            typeof args.after_id === "string" ? args.after_id : null;
          if (!beforeId && !afterId) {
            result = { ok: false, error: "before_id or after_id required" };
            break;
          }
          if (beforeId && afterId) {
            result = { ok: false, error: "provide only before_id or after_id" };
            break;
          }
          const itemRows = dbHandle.exec({
            sql: "SELECT parent_id FROM items WHERE id = ? LIMIT 1;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string | null]>;
          if (itemRows.length === 0) {
            result = { ok: false, error: "item not found" };
            break;
          }
          const currentParent = itemRows[0][0] ?? null;
          if (currentParent !== parentId) {
            result = { ok: false, error: "parent_id must match current parent" };
            break;
          }
          const siblingRows = dbHandle.exec({
            sql:
              "SELECT id FROM items WHERE parent_id IS ? ORDER BY sort_order ASC, due_at ASC, title ASC;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [currentParent],
          }) as Array<[string]>;
          const siblings = siblingRows.map((row) => row[0]);
          const currentIndex = siblings.indexOf(itemId);
          if (currentIndex === -1) {
            result = { ok: false, error: "item not found" };
            break;
          }
          const targetId = beforeId ?? afterId!;
          const targetIndex = siblings.indexOf(targetId);
          if (targetIndex === -1) {
            result = { ok: false, error: "target not found" };
            break;
          }
          const nextOrder = siblings.filter((id) => id !== itemId);
          const insertIndex =
            beforeId !== null ? targetIndex : targetIndex + 1;
          nextOrder.splice(insertIndex, 0, itemId);
          const updates: Array<[number, string]> = [];
          nextOrder.forEach((id, index) => {
            updates.push([(index + 1) * 10, id]);
          });
          for (const [order, id] of updates) {
            dbHandle.exec("UPDATE items SET sort_order = ? WHERE id = ?;", {
              bind: [order, id],
            });
          }
          result = {
            ok: true,
            result: { id: itemId },
            invalidate: ["items", `item:${itemId}`],
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
        case "start_timer": {
          const itemId = ensureString(args.item_id, "item_id");
          const startAt =
            typeof args.start_at === "number"
              ? ensureInteger(args.start_at, "start_at")
              : Date.now();
          const note = typeof args.note === "string" ? args.note : null;
          const runningRows = dbHandle.exec({
            sql: "SELECT COUNT(*) FROM running_timers;",
            rowMode: "array",
            returnValue: "resultRows",
          }) as Array<[number]>;
          const runningCount = Number(runningRows[0]?.[0] ?? 0);
          if (runningCount > 0) {
            result = {
              ok: false,
              error: {
                code: "TIMER_ALREADY_RUNNING",
                message: "Another timer is already running.",
              },
            };
            break;
          }
          dbHandle.exec(
            "INSERT INTO running_timers (item_id, start_at, note) VALUES (?, ?, ?);",
            {
              bind: [itemId, startAt, note],
            }
          );
          result = {
            ok: true,
            result: { item_id: itemId, start_at: startAt },
            invalidate: ["running_timers", `item:${itemId}`],
          };
          break;
        }
        case "stop_timer": {
          const itemId = ensureString(args.item_id, "item_id");
          const endAt =
            typeof args.end_at === "number"
              ? ensureInteger(args.end_at, "end_at")
              : Date.now();
          const rows = dbHandle.exec({
            sql: "SELECT item_id, start_at, note FROM running_timers WHERE item_id = ? LIMIT 1;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string, number, string | null]>;
          if (rows.length === 0) {
            result = {
              ok: false,
              error: {
                code: "NO_RUNNING_TIMER",
                message: "No running timer found for this item.",
              },
            };
            break;
          }
          const startAt = rows[0][1];
          const durationMinutes = Math.max(
            0,
            Math.ceil((endAt - startAt) / 60000)
          );
          const entryId = crypto.randomUUID();
          dbHandle.exec(
            "INSERT INTO time_entries (entry_id, item_id, start_at, end_at, duration_minutes, note, source) VALUES (?, ?, ?, ?, ?, ?, ?);",
            {
              bind: [
                entryId,
                itemId,
                startAt,
                endAt,
                durationMinutes,
                rows[0][2],
                "timer",
              ],
            }
          );
          dbHandle.exec("DELETE FROM running_timers WHERE item_id = ?;", {
            bind: [itemId],
          });
          result = {
            ok: true,
            result: { entry_id: entryId, duration_minutes: durationMinutes },
            invalidate: ["time_entries", "running_timers", `item:${itemId}`],
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
              project_id: ensureOptionalString(
                item.project_id ?? null,
                `items[${index}].project_id`
              ),
              status: ensureString(item.status, `items[${index}].status`),
              priority: ensureNumber(item.priority, `items[${index}].priority`),
              due_at: ensureNumber(item.due_at, `items[${index}].due_at`),
              scheduled_for:
                item.scheduled_for === null || item.scheduled_for === undefined
                  ? null
                  : ensureInteger(
                      ensureNumber(
                        item.scheduled_for,
                        `items[${index}].scheduled_for`
                      ),
                      `items[${index}].scheduled_for`
                    ),
              scheduled_duration_minutes:
                item.scheduled_duration_minutes === null ||
                item.scheduled_duration_minutes === undefined
                  ? null
                  : ensurePositiveInteger(
                      ensureNumber(
                        item.scheduled_duration_minutes,
                        `items[${index}].scheduled_duration_minutes`
                      ),
                      `items[${index}].scheduled_duration_minutes`
                    ),
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
              sort_order:
                typeof item.sort_order === "number" ? item.sort_order : 0,
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
              const legacyReason =
                typeof blocker.reason === "string" ? blocker.reason : null;
              const textValue =
                typeof blocker.text === "string"
                  ? blocker.text
                  : legacyReason ?? "";
              const text = textValue.trim();
              if (!text) {
                throw new Error(`blockers[${index}].text must be a non-empty string`);
              }
              const kind =
                typeof blocker.kind === "string" && blocker.kind.trim()
                  ? blocker.kind.trim()
                  : "general";
              return {
                blocker_id: ensureString(
                  blocker.blocker_id,
                  `blockers[${index}].blocker_id`
                ),
                item_id: ensureString(
                  blocker.item_id,
                  `blockers[${index}].item_id`
                ),
                kind,
                text,
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

          const runningTimers = ensureArray(
            record.running_timers ?? [],
            "running_timers"
          ).map((value, index) => {
            if (!value || typeof value !== "object") {
              throw new Error(`running_timers[${index}] must be an object`);
            }
            const timer = value as Record<string, unknown>;
            return {
              item_id: ensureString(timer.item_id, `running_timers[${index}].item_id`),
              start_at: ensureNumber(
                timer.start_at,
                `running_timers[${index}].start_at`
              ),
              note: ensureOptionalString(
                timer.note ?? null,
                `running_timers[${index}].note`
              ),
            };
          });

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
          dbHandle.exec("DELETE FROM running_timers;");
          dbHandle.exec("DELETE FROM items;");
          dbHandle.exec("DELETE FROM settings;");

          for (const item of items) {
            dbHandle.exec(
              "INSERT INTO items (id, type, title, parent_id, project_id, status, priority, due_at, scheduled_for, scheduled_duration_minutes, estimate_mode, estimate_minutes, health, health_mode, notes, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
              {
                bind: [
                  item.id,
                  item.type,
                  item.title,
                  item.parent_id,
                  typeof (item as Record<string, unknown>).project_id === "string"
                    ? (item as Record<string, unknown>).project_id
                    : null,
                  item.status,
                  item.priority,
                  item.due_at,
                  item.scheduled_for,
                  item.scheduled_duration_minutes,
                  item.estimate_mode,
                  item.estimate_minutes,
                  item.health,
                  item.health_mode,
                  item.notes,
                  item.created_at,
                  item.updated_at,
                  typeof (item as Record<string, unknown>).sort_order === "number"
                    ? (item as Record<string, unknown>).sort_order
                    : 0,
                ],
              }
            );
          }

          backfillProjectIds(dbHandle);

          for (const dep of dependencies) {
            dbHandle.exec(
              "INSERT INTO dependencies (item_id, depends_on_id) VALUES (?, ?);",
              { bind: [dep.item_id, dep.depends_on_id] }
            );
          }

          for (const blocker of blockers) {
            dbHandle.exec(
              "INSERT INTO blockers (blocker_id, item_id, kind, text, created_at, cleared_at) VALUES (?, ?, ?, ?, ?, ?);",
              {
                bind: [
                  blocker.blocker_id,
                  blocker.item_id,
                  blocker.kind,
                  blocker.text,
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

          for (const timer of runningTimers) {
            dbHandle.exec(
              "INSERT INTO running_timers (item_id, start_at, note) VALUES (?, ?, ?);",
              {
                bind: [timer.item_id, timer.start_at, timer.note],
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
                running_timers: runningTimers.length,
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
              "running_timers",
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
          const kind =
            typeof args.kind === "string" && args.kind.trim()
              ? args.kind.trim()
              : "general";
          const text = typeof args.text === "string" ? args.text.trim() : "";
          if (!text) {
            throw new Error("text must be a non-empty string");
          }
          const blockerId = crypto.randomUUID();
          dbHandle.exec(
            "INSERT INTO blockers (blocker_id, item_id, kind, text, created_at, cleared_at) VALUES (?, ?, ?, ?, ?, ?);",
            {
              bind: [blockerId, itemId, kind, text, envelope.ts, null],
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
        case "set_item_tags": {
          const itemId = ensureString(args.item_id, "item_id");
          const tagsRaw = ensureArray(args.tags, "tags") as unknown[];
          const tags = Array.from(
            new Set(
              tagsRaw
                .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
                .filter((tag) => tag.length > 0)
            )
          );
          dbHandle.exec("DELETE FROM item_tags WHERE item_id = ?;", {
            bind: [itemId],
          });
          for (const tag of tags) {
            dbHandle.exec("INSERT INTO item_tags (item_id, tag) VALUES (?, ?);", {
              bind: [itemId, tag],
            });
          }
          result = {
            ok: true,
            result: { item_id: itemId, tags },
            invalidate: ["items", `item:${itemId}`],
          };
          break;
        }
        case "set_item_assignees": {
          const itemId = ensureString(args.item_id, "item_id");
          const assigneesRaw = ensureArray(
            args.assignee_ids,
            "assignee_ids"
          ) as unknown[];
          const assigneeIds = Array.from(
            new Set(
              assigneesRaw
                .map((value) => (typeof value === "string" ? value.trim() : ""))
                .filter((value) => value.length > 0)
            )
          );
          dbHandle.exec("DELETE FROM item_assignees WHERE item_id = ?;", {
            bind: [itemId],
          });
          for (const assigneeId of assigneeIds) {
            dbHandle.exec(
              "INSERT INTO item_assignees (item_id, assignee_id) VALUES (?, ?);",
              {
                bind: [itemId, assigneeId],
              }
            );
          }
          result = {
            ok: true,
            result: { item_id: itemId, assignee_ids: assigneeIds },
            invalidate: ["items", `item:${itemId}`],
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
            sql: "SELECT id, type, title, parent_id, status, priority, due_at, scheduled_for, scheduled_duration_minutes, estimate_mode, estimate_minutes, health, health_mode, notes FROM items WHERE id = ? LIMIT 1;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string, string, string, string | null, string, number, number, number | null, number | null, string, number, string, string, string | null]>;

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
            sql: "SELECT blocker_id, kind, text, created_at, cleared_at FROM blockers WHERE item_id = ? ORDER BY created_at DESC;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string, string, string, number, number | null]>;

          const hasActiveBlocker = blockersRows.some((row) => row[4] === null);
          const hasUnmetDep = depsRows.some(
            (row) => row[1] === null || row[1] !== "done"
          );

          const settings = getSettings(dbHandle);
          const capacityPerDay =
            typeof settings.get("capacity_minutes_per_day") === "number"
              ? (settings.get("capacity_minutes_per_day") as number)
              : null;
          const now = Date.now();
          const dueMetrics = computeDueMetrics(rows[0][6], now, rows[0][4]);
          const actualRows = dbHandle.exec({
            sql: "SELECT SUM(duration_minutes) FROM time_entries WHERE item_id = ?;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[number | null]>;
          const actualMinutes = actualRows[0]?.[0] ? Number(actualRows[0][0]) : 0;
          const timeEntryRows = dbHandle.exec({
            sql: "SELECT entry_id, start_at, end_at, duration_minutes, note, source FROM time_entries WHERE item_id = ? ORDER BY start_at DESC LIMIT 10;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string, number, number, number, string | null, string]>;
          const runningTimerRows = dbHandle.exec({
            sql: "SELECT item_id, start_at, note FROM running_timers WHERE item_id = ? LIMIT 1;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string, number, string | null]>;
          const runningTimer =
            runningTimerRows.length > 0
              ? {
                  item_id: runningTimerRows[0][0],
                  start_at: runningTimerRows[0][1],
                  note: runningTimerRows[0][2],
                }
              : null;
          const remainingMinutes = Math.max(0, rows[0][10] - actualMinutes);
          const scheduleRows = dbHandle.exec({
            sql: "SELECT COUNT(*), SUM(duration_minutes), MIN(start_at), MAX(start_at + duration_minutes * 60000) FROM scheduled_blocks WHERE item_id = ?;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[number, number | null, number | null, number | null]>;
          const scheduleRow = scheduleRows[0] ?? [0, null, null, null];
          const scheduledCount = Number(scheduleRow[0]);
          const scheduledMinutesTotal = scheduleRow[1] ? Number(scheduleRow[1]) : 0;
          const scheduleStartAt =
            scheduleRow[2] !== null ? Number(scheduleRow[2]) : null;
          const scheduleEndAt =
            scheduleRow[3] !== null ? Number(scheduleRow[3]) : null;
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
              scheduled_for: rows[0][7],
              scheduled_duration_minutes: rows[0][8],
              estimate_mode: rows[0][9],
              estimate_minutes: rows[0][10],
              health: rows[0][11],
              health_mode: rows[0][12],
              notes: rows[0][13],
              dependencies: depsRows.map((row) => row[0]),
              blockers: blockersRows.map((row) => ({
                blocker_id: row[0],
                kind: row[1],
                text: row[2],
                created_at: row[3],
                cleared_at: row[4],
              })),
              is_blocked: hasActiveBlocker || hasUnmetDep,
              days_until_due: dueMetrics.days_until_due,
              days_overdue: dueMetrics.days_overdue,
              is_overdue: dueMetrics.is_overdue,
              has_scheduled_blocks: scheduledCount > 0,
              scheduled_minutes_total: scheduledMinutesTotal,
              schedule_start_at: scheduleStartAt,
              schedule_end_at: scheduleEndAt,
              running_timer: runningTimer,
              time_entries: timeEntryRows.map((row) => ({
                entry_id: row[0],
                start_at: row[1],
                end_at: row[2],
                duration_minutes: row[3],
                note: row[4],
                source: row[5],
              })),
              rollup_actual_minutes: actualMinutes,
              rollup_remaining_minutes: remainingMinutes,
              health_auto: health,
            },
          };
          break;
        }
        case "get_running_timer": {
          const rows = dbHandle.exec({
            sql: "SELECT item_id, start_at, note FROM running_timers ORDER BY start_at ASC LIMIT 1;",
            rowMode: "array",
            returnValue: "resultRows",
          }) as Array<[string, number, string | null]>;
          result = {
            ok: true,
            result:
              rows.length > 0
                ? {
                    item_id: rows[0][0],
                    start_at: rows[0][1],
                    note: rows[0][2],
                  }
                : null,
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
            ORDER BY sort_order ASC, due_at ASC, title ASC;`,
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
          const dueMetricsMap = new Map(
            rows.map((row) => [row[0], computeDueMetrics(row[6], now, row[4])])
          );

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

          const scheduleMap = new Map<
            string,
            { start: number | null; end: number | null }
          >();
          if (ids.length > 0) {
            const placeholders = ids.map(() => "?").join(", ");
            const scheduleRows = dbHandle.exec({
              sql: `SELECT item_id,
                MIN(start_at) AS start_at,
                MAX(start_at + duration_minutes * 60000) AS end_at
                FROM scheduled_blocks
                WHERE item_id IN (${placeholders})
                GROUP BY item_id;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: ids,
            }) as Array<[string, number | null, number | null]>;
            for (const row of scheduleRows) {
              scheduleMap.set(row[0], {
                start: row[1] !== null ? Number(row[1]) : null,
                end: row[2] !== null ? Number(row[2]) : null,
              });
            }
          }

          const blockedMap = new Map<string, boolean>();
          if (ids.length > 0) {
            const placeholders = ids.map(() => "?").join(", ");
            const blockedRows = dbHandle.exec({
              sql: `SELECT id,
                (
                  EXISTS(SELECT 1 FROM blockers b WHERE b.item_id = items.id AND b.cleared_at IS NULL)
                  OR EXISTS(
                    SELECT 1 FROM dependencies d
                    LEFT JOIN items di ON di.id = d.depends_on_id
                    WHERE d.item_id = items.id AND (di.id IS NULL OR di.status != 'done')
                  )
                ) AS is_blocked
                FROM items WHERE id IN (${placeholders});`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: ids,
            }) as Array<[string, number]>;
            for (const row of blockedRows) {
              blockedMap.set(row[0], Boolean(row[1]));
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
                rollupStartAt: null as number | null,
                rollupEndAt: null as number | null,
                rollupBlockedCount: 0,
                rollupOverdueCount: 0,
              },
            ])
          );

          for (const node of nodeMap.values()) {
            if (node.parent_id && nodeMap.has(node.parent_id)) {
              nodeMap.get(node.parent_id)!.children.push(node.id);
            }
          }

          const computeTotals = (
            id: string
          ): {
            estimate: number;
            actual: number;
            rollupStartAt: number | null;
            rollupEndAt: number | null;
            rollupBlockedCount: number;
            rollupOverdueCount: number;
          } => {
            const node = nodeMap.get(id);
            if (!node) {
              return {
                estimate: 0,
                actual: 0,
                rollupStartAt: null,
                rollupEndAt: null,
                rollupBlockedCount: 0,
                rollupOverdueCount: 0,
              };
            }
            let estimate = node.estimate_minutes;
            let actual = timeMap.get(id) ?? 0;
            let rollupStartAt = scheduleMap.get(id)?.start ?? null;
            let rollupEndAt = scheduleMap.get(id)?.end ?? null;
            let rollupBlockedCount = blockedMap.get(id) ? 1 : 0;
            let rollupOverdueCount = dueMetricsMap.get(id)?.is_overdue ? 1 : 0;
            for (const childId of node.children) {
              const childTotals = computeTotals(childId);
              estimate += childTotals.estimate;
              actual += childTotals.actual;
              rollupStartAt = minNullable(rollupStartAt, childTotals.rollupStartAt);
              rollupEndAt = maxNullable(rollupEndAt, childTotals.rollupEndAt);
              rollupBlockedCount += childTotals.rollupBlockedCount;
              rollupOverdueCount += childTotals.rollupOverdueCount;
            }
            node.totalEstimate = estimate;
            node.totalActual = actual;
            node.rollupStartAt = rollupStartAt;
            node.rollupEndAt = rollupEndAt;
            node.rollupBlockedCount = rollupBlockedCount;
            node.rollupOverdueCount = rollupOverdueCount;
            return {
              estimate,
              actual,
              rollupStartAt,
              rollupEndAt,
              rollupBlockedCount,
              rollupOverdueCount,
            };
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
              const dueMetrics = dueMetricsMap.get(row[0])!;
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
                rollup_start_at: node?.rollupStartAt ?? null,
                rollup_end_at: node?.rollupEndAt ?? null,
                rollup_blocked_count: node?.rollupBlockedCount ?? 0,
                rollup_overdue_count: node?.rollupOverdueCount ?? 0,
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
                FROM items WHERE project_id = ? ORDER BY sort_order ASC, due_at ASC, title ASC;`
              : `SELECT id, type, title, parent_id, status, priority, due_at,
                (
                  EXISTS(SELECT 1 FROM blockers b WHERE b.item_id = items.id AND b.cleared_at IS NULL)
                  OR EXISTS(
                    SELECT 1 FROM dependencies d
                    LEFT JOIN items di ON di.id = d.depends_on_id
                    WHERE d.item_id = items.id AND (di.id IS NULL OR di.status != 'done')
                  )
                ) AS is_blocked
                FROM items ORDER BY sort_order ASC, due_at ASC, title ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<[string, string, string, string | null, string, number, number, number]>;

          const scheduleRows = dbHandle.exec({
            sql: `SELECT item_id,
              COUNT(*) AS block_count,
              SUM(duration_minutes) AS total_minutes,
              MIN(start_at) AS start_at,
              MAX(start_at + duration_minutes * 60000) AS end_at
              FROM scheduled_blocks
              GROUP BY item_id;`,
            rowMode: "array",
            returnValue: "resultRows",
          }) as Array<[string, number, number | null, number | null, number | null]>;
          const scheduleMap = new Map(
            scheduleRows.map((row) => [
              row[0],
              {
                count: Number(row[1]),
                total: row[2] ? Number(row[2]) : 0,
                start: row[3] !== null ? Number(row[3]) : null,
                end: row[4] !== null ? Number(row[4]) : null,
              },
            ])
          );
          const itemIds = rows.map((row) => row[0]);
          const blockersRows = itemIds.length
            ? (dbHandle.exec({
                sql: `SELECT blocker_id, item_id, kind, text, created_at, cleared_at
                  FROM blockers
                  WHERE item_id IN (${itemIds.map(() => "?").join(",")})
                  ORDER BY created_at DESC;`,
                rowMode: "array",
                returnValue: "resultRows",
                bind: itemIds,
              }) as Array<[string, string, string, string, number, number | null]>)
            : [];
          const blockersMap = new Map<
            string,
            Array<{
              blocker_id: string;
              kind: string;
              text: string;
              created_at: number;
              cleared_at: number | null;
            }>
          >();
          for (const row of blockersRows) {
            const entry = blockersMap.get(row[1]) ?? [];
            entry.push({
              blocker_id: row[0],
              kind: row[2],
              text: row[3],
              created_at: row[4],
              cleared_at: row[5],
            });
            blockersMap.set(row[1], entry);
          }

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
              blockers: blockersMap.get(row[0]) ?? [],
              has_scheduled_blocks: (scheduleMap.get(row[0])?.count ?? 0) > 0,
              scheduled_minutes_total: scheduleMap.get(row[0])?.total ?? 0,
              schedule_start_at: scheduleMap.get(row[0])?.start ?? null,
              schedule_end_at: scheduleMap.get(row[0])?.end ?? null,
            })),
          };
          break;
        }
        case "listItems": {
          const scope = resolveScope(args);
          const projectId = ensureProjectScope(scope);
          const filters = resolveFilters(args);
          const statusArg = filters.status ?? args.status;
          const healthArg = filters.health ?? args.health;
          const assigneeId =
            typeof filters.assignee === "string"
              ? filters.assignee
              : typeof args.assigneeId === "string"
                ? args.assigneeId
                : null;
          const tagFilter =
            typeof filters.tag === "string"
              ? filters.tag
              : typeof args.tagId === "string"
                ? args.tagId
                : typeof args.tag === "string"
                  ? args.tag
                  : null;
          const statusFilter = Array.isArray(statusArg)
            ? statusArg.filter((value) => typeof value === "string")
            : typeof statusArg === "string"
              ? [statusArg]
              : null;
          const healthFilter = Array.isArray(healthArg)
            ? healthArg.filter((value) => typeof value === "string")
            : typeof healthArg === "string"
              ? [healthArg]
              : null;
          const rows = dbHandle.exec({
            sql: projectId
              ? `SELECT id, type, title, parent_id, project_id, status, priority, due_at,
                  scheduled_for, scheduled_duration_minutes,
                  estimate_mode, estimate_minutes, health, health_mode, notes, updated_at, sort_order
                FROM items
                WHERE project_id = ?
                ORDER BY sort_order ASC, due_at ASC, title ASC;`
              : `SELECT id, type, title, parent_id, project_id, status, priority, due_at,
                  scheduled_for, scheduled_duration_minutes,
                  estimate_mode, estimate_minutes, health, health_mode, notes, updated_at, sort_order
                FROM items
                ORDER BY sort_order ASC, due_at ASC, title ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<
            [
              string,
              string,
              string,
              string | null,
              string | null,
              string,
              number,
              number,
              number | null,
              number | null,
              string,
              number,
              string,
              string,
              string | null,
              number,
              number
            ]
          >;
          const ids = rows.map((row) => row[0]);
          const rowMap = new Map(
            rows.map((row) => [row[0], { updated_at: row[15], sort_order: row[16] }])
          );
          const scheduleMap = getScheduleSummaryMap(dbHandle, ids);
          const blockedMap = getBlockedStatusMap(dbHandle, ids);
          const assigneesMap = getAssigneesMap(dbHandle, ids);
          const tagsMap = getTagsMap(dbHandle, ids);
          const dependenciesMap = getDependenciesMap(dbHandle, ids);
          const dependentsMap = getDependentsCountMap(dbHandle, ids);
          const activeBlockerCountMap = getActiveBlockerCountMap(dbHandle, ids);
          const unmetDepMap = getUnmetDependencyMap(dbHandle, ids);
          const { depthMap, projectMap } = buildHierarchyMaps(
            rows.map((row) => [row[0], row[1], row[3]]),
            projectId
          );
          const timeMap = new Map<string, number>();
          if (ids.length > 0) {
            const placeholders = buildPlaceholders(ids.length);
            const timeRows = dbHandle.exec({
              sql: `SELECT item_id, SUM(duration_minutes) FROM time_entries
                WHERE item_id IN (${placeholders})
                GROUP BY item_id;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: ids,
            }) as Array<[string, number]>;
            for (const row of timeRows) {
              timeMap.set(row[0], Number(row[1]));
            }
          }
          const settings = getSettings(dbHandle);
          const capacityPerDay =
            typeof settings.get("capacity_minutes_per_day") === "number"
              ? (settings.get("capacity_minutes_per_day") as number)
              : null;
          const now = Date.now();
          const includeCanceled =
            typeof args.includeCanceled === "boolean" ? args.includeCanceled : false;
          const includeDone =
            typeof args.includeDone === "boolean" ? args.includeDone : false;
          const searchText =
            typeof args.searchText === "string" ? args.searchText.trim() : "";
          const dueRange = filters.dueRange ?? {};
          const filtered = rows.filter((row) => {
            if (statusFilter && !statusFilter.includes(row[5])) {
              return false;
            }
            if (healthFilter && !healthFilter.includes(row[12])) {
              return false;
            }
            if (!includeCanceled && row[5] === "canceled") {
              return false;
            }
            if (!includeDone && row[5] === "done") {
              return false;
            }
            const assignees = assigneesMap.get(row[0]) ?? [];
            if (assigneeId === "unassigned" && assignees.length > 0) {
              return false;
            }
            if (
              assigneeId &&
              assigneeId !== "unassigned" &&
              !assignees.includes(assigneeId)
            ) {
              return false;
            }
            const tags = tagsMap.get(row[0]) ?? [];
            if (tagFilter && !tags.includes(tagFilter)) {
              return false;
            }
            if (searchText) {
              const haystack = `${row[2]} ${row[14] ?? ""}`.toLowerCase();
              if (!haystack.includes(searchText.toLowerCase())) {
                return false;
              }
            }
            if (
              typeof dueRange.start === "number" &&
              row[7] < dueRange.start
            ) {
              return false;
            }
            if (typeof dueRange.end === "number" && row[7] > dueRange.end) {
              return false;
            }
            return true;
          });
          const mapped = filtered.map((row) => {
            const schedule = scheduleMap.get(row[0]) ?? {
              count: 0,
              total: 0,
              start: null,
              end: null,
            };
            const blocked = blockedMap.get(row[0]) ?? {
              hasBlocker: false,
              hasUnmetDep: false,
              is_blocked: false,
            };
            const unmetDeps = unmetDepMap.get(row[0]) ?? { count: 0, ids: [] };
            const dueMetrics = computeDueMetrics(row[7], now, row[5]);
            const actualMinutes = timeMap.get(row[0]) ?? 0;
            const remainingMinutes = Math.max(0, row[11] - actualMinutes);
            const healthAuto = computeHealth(
              dueMetrics.is_overdue,
              remainingMinutes,
              dueMetrics.days_until_due,
              capacityPerDay
            );
            const dependents = dependentsMap.get(row[0]) ?? 0;
            const sequenceRank = computeSequenceRank({
              is_overdue: dueMetrics.is_overdue,
              is_blocked: blocked.is_blocked,
              due_at: row[7],
              priority: row[6],
              dependents,
            });
            return {
              id: row[0],
              type: row[1],
              title: row[2],
              parent_id: row[3],
              project_id: row[4] ?? projectMap.get(row[0]) ?? row[0],
              depth: depthMap.get(row[0]) ?? 0,
              status: row[5],
              priority: row[6],
              due_at: row[7],
              scheduled_for: row[8],
              scheduled_duration_minutes: row[9],
              estimate_mode: row[10],
              estimate_minutes: row[11],
              notes: row[14],
              sort_order: row[16],
              health: row[12],
              health_mode: row[13],
              schedule: {
                has_blocks: schedule.count > 0,
                scheduled_minutes_total: schedule.total,
                schedule_start_at: schedule.start,
                schedule_end_at: schedule.end,
              },
              blocked: {
                is_blocked: blocked.is_blocked,
                blocked_by_deps: blocked.hasUnmetDep,
                blocked_by_blockers: blocked.hasBlocker,
                active_blocker_count: activeBlockerCountMap.get(row[0]) ?? 0,
                unmet_dependency_count: unmetDeps.count,
                scheduled_but_blocked:
                  schedule.count > 0 && blocked.is_blocked ? true : false,
              },
              assignees: (assigneesMap.get(row[0]) ?? []).map((id) => ({
                id,
                name: null,
              })),
              tags: (tagsMap.get(row[0]) ?? []).map((tag) => ({
                id: tag,
                name: tag,
              })),
              depends_on: dependenciesMap.get(row[0]) ?? [],
              sequence_rank: sequenceRank,
            };
          });
          const orderBy =
            typeof args.orderBy === "string" ? args.orderBy : "sort_order";
          const orderDir =
            typeof args.orderDir === "string" ? args.orderDir : "asc";
          const sorted = mapped.sort((a, b) => {
            const dir = orderDir === "desc" ? -1 : 1;
            if (orderBy === "sort_order") {
              if (a.sort_order !== b.sort_order) {
                return (a.sort_order - b.sort_order) * dir;
              }
            }
            if (orderBy === "sequence_rank") {
              return (a.sequence_rank - b.sequence_rank) * dir;
            }
            if (orderBy === "priority") {
              if (a.priority !== b.priority) {
                return (a.priority - b.priority) * dir;
              }
            }
            if (orderBy === "title") {
              return a.title.localeCompare(b.title) * dir;
            }
            if (orderBy === "updated_at") {
              const aUpdated = rowMap.get(a.id)?.updated_at ?? 0;
              const bUpdated = rowMap.get(b.id)?.updated_at ?? 0;
              return (aUpdated - bUpdated) * dir;
            }
            if (a.due_at !== b.due_at) {
              return (a.due_at - b.due_at) * dir;
            }
            if (a.sort_order !== b.sort_order) {
              return (a.sort_order - b.sort_order) * dir;
            }
            return a.title.localeCompare(b.title) * dir;
          });
          const limit = typeof args.limit === "number" ? args.limit : null;
          const offset = typeof args.offset === "number" ? args.offset : 0;
          const sliced =
            limit !== null ? sorted.slice(offset, offset + limit) : sorted.slice(offset);
          result = {
            ok: true,
            result: {
              items: sliced,
            },
          };
          break;
        }
        case "listGantt": {
          const projectId =
            typeof args.projectId === "string" ? args.projectId : null;
          const rows = dbHandle.exec({
            sql: projectId
              ? `SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_minutes, health, health_mode, notes
                FROM items
                WHERE project_id = ?
                ORDER BY sort_order ASC, due_at ASC, title ASC;`
              : `SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_minutes, health, health_mode, notes
                FROM items
                ORDER BY sort_order ASC, due_at ASC, title ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<[string, string, string, string | null, string, number, number, number, string, string, string | null]>;
          const ids = rows.map((row) => row[0]);
          const estimateMap = new Map(rows.map((row) => [row[0], row[7]]));
          const scheduleMap = getScheduleSummaryMap(dbHandle, ids);
          const blockedMap = getBlockedStatusMap(dbHandle, ids);
          const unmetDepMap = getUnmetDependencyMap(dbHandle, ids);
          const activeBlockerCountMap = getActiveBlockerCountMap(dbHandle, ids);
          const { depthMap } = buildHierarchyMaps(
            rows.map((row) => [row[0], row[1], row[3]]),
            projectId
          );
          const now = Date.now();
          const dueMetricsMap = new Map(
            rows.map((row) => [row[0], computeDueMetrics(row[6], now, row[4])])
          );
          const timeMap = new Map<string, number>();
          if (ids.length > 0) {
            const placeholders = buildPlaceholders(ids.length);
            const timeRows = dbHandle.exec({
              sql: `SELECT item_id, SUM(duration_minutes) FROM time_entries
                WHERE item_id IN (${placeholders})
                GROUP BY item_id;`,
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
                parent_id: row[3],
                children: [] as string[],
                rollupStartAt: null as number | null,
                rollupEndAt: null as number | null,
                totalEstimate: 0,
                totalActual: 0,
                rollupBlockedCount: 0,
                rollupOverdueCount: 0,
              },
            ])
          );
          for (const node of nodeMap.values()) {
            if (node.parent_id && nodeMap.has(node.parent_id)) {
              nodeMap.get(node.parent_id)!.children.push(node.id);
            }
          }
          const computeSpan = (
            id: string
          ): {
            start: number | null;
            end: number | null;
            estimate: number;
            actual: number;
            blockedCount: number;
            overdueCount: number;
          } => {
            const node = nodeMap.get(id);
            if (!node) {
              return {
                start: null,
                end: null,
                estimate: 0,
                actual: 0,
                blockedCount: 0,
                overdueCount: 0,
              };
            }
            let start = scheduleMap.get(id)?.start ?? null;
            let end = scheduleMap.get(id)?.end ?? null;
            let estimate = estimateMap.get(id) ?? 0;
            let actual = timeMap.get(id) ?? 0;
            let blockedCount = blockedMap.get(id)?.is_blocked ? 1 : 0;
            let overdueCount = dueMetricsMap.get(id)?.is_overdue ? 1 : 0;
            for (const childId of node.children) {
              const childSpan = computeSpan(childId);
              start = minNullable(start, childSpan.start);
              end = maxNullable(end, childSpan.end);
              estimate += childSpan.estimate;
              actual += childSpan.actual;
              blockedCount += childSpan.blockedCount;
              overdueCount += childSpan.overdueCount;
            }
            node.rollupStartAt = start;
            node.rollupEndAt = end;
            node.totalEstimate = estimate;
            node.totalActual = actual;
            node.rollupBlockedCount = blockedCount;
            node.rollupOverdueCount = overdueCount;
            return { start, end, estimate, actual, blockedCount, overdueCount };
          };
          if (projectId) {
            computeSpan(projectId);
          } else {
            for (const row of rows) {
              if (!nodeMap.get(row[0])?.parent_id) {
                computeSpan(row[0]);
              }
            }
          }
          result = {
            ok: true,
            result: {
              rows: rows
                .map((row) => {
                  const schedule = scheduleMap.get(row[0]) ?? {
                    start: null,
                    end: null,
                    count: 0,
                    total: 0,
                  };
                  const node = nodeMap.get(row[0]);
                const blocked = blockedMap.get(row[0]) ?? {
                  hasBlocker: false,
                  hasUnmetDep: false,
                  is_blocked: false,
                };
                const unmetDeps = unmetDepMap.get(row[0]) ?? { count: 0, ids: [] };
                const rollupEstimate =
                  row[1] === "task"
                    ? row[7]
                    : Math.max(0, (node?.totalEstimate ?? row[7]) - row[7]);
                const rollupActual =
                  row[1] === "task" ? timeMap.get(row[0]) ?? 0 : node?.totalActual ?? 0;
                const rollupRemaining = Math.max(0, rollupEstimate - rollupActual);
                const rollupBlockedCount = node?.rollupBlockedCount ?? 0;
                const rollupOverdueCount = node?.rollupOverdueCount ?? 0;
                return {
                  id: row[0],
                  type: row[1],
                  title: row[2],
                  parent_id: row[3],
                  depth: depthMap.get(row[0]) ?? 0,
                  status: row[4],
                  blocked: {
                    is_blocked: blocked.is_blocked,
                    blocked_by_deps: blocked.hasUnmetDep,
                    blocked_by_blockers: blocked.hasBlocker,
                    active_blocker_count: activeBlockerCountMap.get(row[0]) ?? 0,
                    unmet_dependency_count: unmetDeps.count,
                  },
                  due_at: row[6],
                  bar_start_at:
                    row[1] === "task" ? schedule.start : node?.rollupStartAt ?? null,
                  bar_end_at:
                    row[1] === "task" ? schedule.end : node?.rollupEndAt ?? null,
                  rollup:
                    row[1] === "task"
                      ? undefined
                      : {
                          estimate_minutes: rollupEstimate,
                          actual_minutes: rollupActual,
                          remaining_minutes: rollupRemaining,
                          overdue_count: rollupOverdueCount,
                          blocked_count: rollupBlockedCount,
                          rollup_start_at: node?.rollupStartAt ?? null,
                          rollup_end_at: node?.rollupEndAt ?? null,
                        },
                  schedule:
                    row[1] === "task"
                      ? {
                          has_blocks: schedule.count > 0,
                          scheduled_minutes_total: schedule.total,
                          schedule_start_at: schedule.start,
                          schedule_end_at: schedule.end,
                        }
                      : undefined,
                };
              })
                .filter((row) => {
                  const includeDone =
                    typeof args.includeDone === "boolean" ? args.includeDone : false;
                  const includeCanceled =
                    typeof args.includeCanceled === "boolean"
                      ? args.includeCanceled
                      : false;
                  if (!includeDone && row.status === "done") {
                    return false;
                  }
                  if (!includeCanceled && row.status === "canceled") {
                    return false;
                  }
                  const startAt =
                    typeof args.startAt === "number" ? args.startAt : null;
                  const endAt = typeof args.endAt === "number" ? args.endAt : null;
                  if (startAt === null && endAt === null) {
                    return true;
                  }
                  const barStart = row.bar_start_at;
                  const barEnd = row.bar_end_at;
                  if (barStart === null || barEnd === null) {
                    return true;
                  }
                  if (startAt !== null && barEnd < startAt) {
                    return false;
                  }
                  if (endAt !== null && barStart > endAt) {
                    return false;
                  }
                  return true;
                }),
            },
          };
          break;
        }
        case "listExecution": {
          const scope = resolveScope(args);
          const projectId = ensureProjectScope(scope);
          const filters = resolveFilters(args);
          const assigneeId =
            typeof filters.assignee === "string"
              ? filters.assignee
              : typeof args.assigneeId === "string"
                ? args.assigneeId
                : null;
          const startAt = ensureNumber(args.startAt, "startAt");
          const endAt = ensureNumber(args.endAt, "endAt");
          const itemsRows = dbHandle.exec({
            sql: projectId
              ? `SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_minutes, health, health_mode, notes
                FROM items
                WHERE project_id = ?;`
              : `SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_minutes, health, health_mode, notes
                FROM items;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<[string, string, string, string | null, string, number, number, number, string, string, string | null]>;
          const itemIds = itemsRows.map((row) => row[0]);
          const scheduleMap = getScheduleSummaryMap(dbHandle, itemIds);
          const blockedStatusMap = getBlockedStatusMap(dbHandle, itemIds);
          const activeBlockerCountMap = getActiveBlockerCountMap(dbHandle, itemIds);
          const unmetDepMap = getUnmetDependencyMap(dbHandle, itemIds);
          const assigneesMap = getAssigneesMap(dbHandle, itemIds);
          const tagsMap = getTagsMap(dbHandle, itemIds);
          const dependentsMap = getDependentsCountMap(dbHandle, itemIds);
          const { depthMap, projectMap } = buildHierarchyMaps(
            itemsRows.map((row) => [row[0], row[1], row[3]]),
            projectId
          );
          const timeMap = new Map<string, number>();
          if (itemIds.length > 0) {
            const placeholders = buildPlaceholders(itemIds.length);
            const timeRows = dbHandle.exec({
              sql: `SELECT item_id, SUM(duration_minutes) FROM time_entries
                WHERE item_id IN (${placeholders})
                GROUP BY item_id;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: itemIds,
            }) as Array<[string, number]>;
            for (const row of timeRows) {
              timeMap.set(row[0], Number(row[1]));
            }
          }
          const settings = getSettings(dbHandle);
          const capacityPerDay =
            typeof settings.get("capacity_minutes_per_day") === "number"
              ? (settings.get("capacity_minutes_per_day") as number)
              : null;
          const now = Date.now();

          const listTraits = (row: typeof itemsRows[number]) => {
            const schedule = scheduleMap.get(row[0]) ?? {
              count: 0,
              total: 0,
              start: null,
              end: null,
            };
            const blocked = blockedStatusMap.get(row[0]) ?? {
              hasBlocker: false,
              hasUnmetDep: false,
              is_blocked: false,
            };
            const unmetDeps = unmetDepMap.get(row[0]) ?? { count: 0, ids: [] };
            const dueMetrics = computeDueMetrics(row[6], now, row[4]);
            const actualMinutes = timeMap.get(row[0]) ?? 0;
            const remainingMinutes = Math.max(0, row[7] - actualMinutes);
            const dependents = dependentsMap.get(row[0]) ?? 0;
            const sequenceRank = computeSequenceRank({
              is_overdue: dueMetrics.is_overdue,
              is_blocked: blocked.is_blocked,
              due_at: row[6],
              priority: row[5],
              dependents,
            });
            return {
              id: row[0],
              type: row[1],
              title: row[2],
              parent_id: row[3],
              project_id: projectMap.get(row[0]) ?? row[0],
              depth: depthMap.get(row[0]) ?? 0,
              status: row[4],
              priority: row[5],
              due_at: row[6],
              estimate_minutes: row[7],
              notes: row[10],
              health: row[8],
              health_mode: row[9],
              schedule: {
                has_blocks: schedule.count > 0,
                scheduled_minutes_total: schedule.total,
                schedule_start_at: schedule.start,
                schedule_end_at: schedule.end,
              },
              blocked: {
                is_blocked: blocked.is_blocked,
                blocked_by_deps: blocked.hasUnmetDep,
                blocked_by_blockers: blocked.hasBlocker,
                active_blocker_count: activeBlockerCountMap.get(row[0]) ?? 0,
                unmet_dependency_count: unmetDeps.count,
                scheduled_but_blocked:
                  schedule.count > 0 && blocked.is_blocked ? true : false,
              },
              assignees: (assigneesMap.get(row[0]) ?? []).map((id) => ({
                id,
                name: null,
              })),
              tags: (tagsMap.get(row[0]) ?? []).map((tag) => ({
                id: tag,
                name: tag,
              })),
              sequence_rank: sequenceRank,
            };
          };

          const filteredItems = itemsRows.filter((row) => {
            const assignees = assigneesMap.get(row[0]) ?? [];
            if (assigneeId === "unassigned" && assignees.length > 0) {
              return false;
            }
            if (
              assigneeId &&
              assigneeId !== "unassigned" &&
              !assignees.includes(assigneeId)
            ) {
              return false;
            }
            return true;
          });

          const placeholders = buildPlaceholders(itemIds.length);
          const blocksRows =
            itemIds.length > 0
              ? (dbHandle.exec({
                  sql: `SELECT block_id, item_id, start_at, duration_minutes, locked
                    FROM scheduled_blocks
                    WHERE item_id IN (${placeholders})
                      AND start_at < ? AND (start_at + duration_minutes * 60000) > ?
                    ORDER BY start_at ASC;`,
                  rowMode: "array",
                  returnValue: "resultRows",
                  bind: [...itemIds, endAt, startAt],
                }) as Array<[string, string, number, number, number]>)
              : [];
          const blocks = blocksRows
            .filter((row) => {
              if (!assigneeId) {
                return true;
              }
              const assignees = assigneesMap.get(row[1]) ?? [];
              if (assigneeId === "unassigned") {
                return assignees.length === 0;
              }
              return assignees.includes(assigneeId);
            })
            .map((row) => ({
              block_id: row[0],
              item_id: row[1],
              start_at: row[2],
              duration_minutes: row[3],
              locked: Boolean(row[4]),
            }));

          const queue = filteredItems
            .filter((row) => {
              if (row[4] !== "ready") {
                return false;
              }
              if (blockedStatusMap.get(row[0])?.is_blocked) {
                return false;
              }
              return (scheduleMap.get(row[0])?.count ?? 0) === 0;
            })
            .map((row) => listTraits(row))
            .sort((a, b) => a.sequence_rank - b.sequence_rank);

          result = {
            ok: true,
            result: {
              blocks,
              queue,
            },
          };
          break;
        }
        case "listBlocked": {
          const projectId =
            typeof args.projectId === "string" ? args.projectId : null;
          const assigneeId =
            typeof args.assigneeId === "string" ? args.assigneeId : null;
          const includeScheduled =
            typeof args.includeScheduledButBlocked === "boolean"
              ? args.includeScheduledButBlocked
              : true;
          const rows = dbHandle.exec({
            sql: projectId
              ? `WITH RECURSIVE tree AS (
                  SELECT * FROM items WHERE id = ?
                  UNION ALL
                  SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
                )
                SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_minutes, health, health_mode, notes
                FROM tree
                ORDER BY sort_order ASC, due_at ASC, title ASC;`
              : `SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_minutes, health, health_mode, notes
                FROM items
                ORDER BY sort_order ASC, due_at ASC, title ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<[string, string, string, string | null, string, number, number, number, string, string, string | null]>;
          const ids = rows.map((row) => row[0]);
          const blockedMap = getBlockedStatusMap(dbHandle, ids);
          const scheduleMap = getScheduleSummaryMap(dbHandle, ids);
          const assigneesMap = getAssigneesMap(dbHandle, ids);
          const tagsMap = getTagsMap(dbHandle, ids);
          const unmetDepMap = getUnmetDependencyMap(dbHandle, ids);
          const activeBlockerIdsMap = getActiveBlockerIdsMap(dbHandle, ids);
          const activeBlockerCountMap = getActiveBlockerCountMap(dbHandle, ids);
          const { depthMap, projectMap } = buildHierarchyMaps(
            rows.map((row) => [row[0], row[1], row[3]]),
            projectId
          );
          const blockedByDeps = [];
          const blockedByBlockers = [];
          const blockedByBoth = [];
          const scheduledButBlocked = [];
          for (const row of rows) {
            const blocked = blockedMap.get(row[0]);
            if (!blocked?.is_blocked) {
              continue;
            }
            const assignees = assigneesMap.get(row[0]) ?? [];
            if (assigneeId === "unassigned" && assignees.length > 0) {
              continue;
            }
            if (
              assigneeId &&
              assigneeId !== "unassigned" &&
              !assignees.includes(assigneeId)
            ) {
              continue;
            }
            const schedule = scheduleMap.get(row[0]) ?? {
              count: 0,
              total: 0,
              start: null,
              end: null,
            };
            const unmetDeps = unmetDepMap.get(row[0]) ?? { count: 0, ids: [] };
            const blockerIds = activeBlockerIdsMap.get(row[0]) ?? [];
            const entry = {
              id: row[0],
              type: row[1],
              title: row[2],
              parent_id: row[3],
              project_id: projectMap.get(row[0]) ?? row[0],
              depth: depthMap.get(row[0]) ?? 0,
              status: row[4],
              priority: row[5],
              due_at: row[6],
              estimate_minutes: row[7],
              notes: row[10],
              health: row[8],
              health_mode: row[9],
              schedule: {
                has_blocks: schedule.count > 0,
                scheduled_minutes_total: schedule.total,
                schedule_start_at: schedule.start,
                schedule_end_at: schedule.end,
              },
              blocked: {
                is_blocked: blocked.is_blocked,
                blocked_by_deps: blocked.hasUnmetDep,
                blocked_by_blockers: blocked.hasBlocker,
                active_blocker_count: activeBlockerCountMap.get(row[0]) ?? 0,
                unmet_dependency_count: unmetDeps.count,
                scheduled_but_blocked:
                  schedule.count > 0 && blocked.is_blocked ? true : false,
                blocked_dependency_ids: unmetDeps.ids,
                blocker_ids: blockerIds,
              },
              assignees: assignees.map((id) => ({ id, name: null })),
              tags: (tagsMap.get(row[0]) ?? []).map((tag) => ({
                id: tag,
                name: tag,
              })),
            };
            if (blocked.hasUnmetDep && blocked.hasBlocker) {
              blockedByBoth.push(entry);
            } else if (blocked.hasUnmetDep) {
              blockedByDeps.push(entry);
            } else if (blocked.hasBlocker) {
              blockedByBlockers.push(entry);
            }
            if (includeScheduled && schedule.count > 0) {
              scheduledButBlocked.push(entry);
            }
          }
          result = {
            ok: true,
            result: {
              blocked_by_deps: blockedByDeps,
              blocked_by_blockers: blockedByBlockers,
              blocked_by_both: blockedByBoth,
              scheduled_but_blocked: scheduledButBlocked,
            },
          };
          break;
        }
        case "listByUser": {
          const projectId =
            typeof args.projectId === "string" ? args.projectId : null;
          const assigneeFilter =
            typeof args.assigneeId === "string" ? args.assigneeId : null;
          const includeUnassigned =
            typeof args.includeUnassigned === "boolean"
              ? args.includeUnassigned
              : true;
          const includeCanceled =
            typeof args.includeCanceled === "boolean" ? args.includeCanceled : false;
          const includeDone =
            typeof args.includeDone === "boolean" ? args.includeDone : false;
          const rows = dbHandle.exec({
            sql: projectId
              ? `WITH RECURSIVE tree AS (
                  SELECT * FROM items WHERE id = ?
                  UNION ALL
                  SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
                )
                SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_minutes, health, health_mode, notes
                FROM tree;`
              : `SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_minutes, health, health_mode, notes
                FROM items;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<[string, string, string, string | null, string, number, number, number, string, string, string | null]>;
          const ids = rows.map((row) => row[0]);
          const scheduleMap = getScheduleSummaryMap(dbHandle, ids);
          const blockedMap = getBlockedStatusMap(dbHandle, ids);
          const activeBlockerCountMap = getActiveBlockerCountMap(dbHandle, ids);
          const unmetDepMap = getUnmetDependencyMap(dbHandle, ids);
          const assigneesMap = getAssigneesMap(dbHandle, ids);
          const tagsMap = getTagsMap(dbHandle, ids);
          const { depthMap, projectMap } = buildHierarchyMaps(
            rows.map((row) => [row[0], row[1], row[3]]),
            projectId
          );
          const groups = new Map<string, Array<Record<string, unknown>>>();
          const unassigned: Array<Record<string, unknown>> = [];
          for (const row of rows) {
            if (!includeCanceled && row[4] === "canceled") {
              continue;
            }
            if (!includeDone && row[4] === "done") {
              continue;
            }
            const schedule = scheduleMap.get(row[0]) ?? {
              count: 0,
              total: 0,
              start: null,
              end: null,
            };
            const blocked = blockedMap.get(row[0]) ?? {
              hasBlocker: false,
              hasUnmetDep: false,
              is_blocked: false,
            };
            const unmetDeps = unmetDepMap.get(row[0]) ?? { count: 0, ids: [] };
            const item = {
              id: row[0],
              type: row[1],
              title: row[2],
              parent_id: row[3],
              project_id: projectMap.get(row[0]) ?? row[0],
              depth: depthMap.get(row[0]) ?? 0,
              status: row[4],
              priority: row[5],
              due_at: row[6],
              estimate_minutes: row[7],
              notes: row[10],
              health: row[8],
              health_mode: row[9],
              schedule: {
                has_blocks: schedule.count > 0,
                scheduled_minutes_total: schedule.total,
                schedule_start_at: schedule.start,
                schedule_end_at: schedule.end,
              },
              blocked: {
                is_blocked: blocked.is_blocked,
                blocked_by_deps: blocked.hasUnmetDep,
                blocked_by_blockers: blocked.hasBlocker,
                active_blocker_count: activeBlockerCountMap.get(row[0]) ?? 0,
                unmet_dependency_count: unmetDeps.count,
                scheduled_but_blocked:
                  schedule.count > 0 && blocked.is_blocked ? true : false,
              },
              assignees: (assigneesMap.get(row[0]) ?? []).map((id) => ({
                id,
                name: null,
              })),
              tags: (tagsMap.get(row[0]) ?? []).map((tag) => ({
                id: tag,
                name: tag,
              })),
            };
            const assignees = assigneesMap.get(row[0]) ?? [];
            if (assignees.length === 0) {
              unassigned.push(item);
              continue;
            }
            for (const assignee of assignees) {
              const list = groups.get(assignee) ?? [];
              list.push(item);
              groups.set(assignee, list);
            }
          }
          const resultGroups = Array.from(groups.entries())
            .filter(([assigneeId]) => !assigneeFilter || assigneeId === assigneeFilter)
            .map(([assigneeId, items]) => ({
              assignee: { id: assigneeId, name: null },
              items,
            }));
          if (!assigneeFilter && includeUnassigned) {
            resultGroups.push({ assignee: null, items: unassigned });
          }
          result = {
            ok: true,
            result: { groups: resultGroups },
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
              const dueMetrics = computeDueMetrics(row[6], now, row[4]);
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
              const dueMetrics = computeDueMetrics(row[6], now, row[4]);
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
          const scope = resolveScope(args);
          const projectId = ensureProjectScope(scope);
          const startAt = ensureNumber(args.startAt, "startAt");
          const endAt = ensureNumber(args.endAt, "endAt");
          let rows: Array<[string, string, number, number, number, string]> = [];
          if (projectId) {
            rows = dbHandle.exec({
              sql: `SELECT b.block_id, b.item_id, b.start_at, b.duration_minutes, b.locked, b.source
              FROM scheduled_blocks b
              JOIN items i ON i.id = b.item_id
              WHERE i.project_id = ?
                AND b.start_at < ?
                AND (b.start_at + b.duration_minutes * 60000) > ?
              ORDER BY b.start_at ASC;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: [projectId, endAt, startAt],
            }) as Array<[string, string, number, number, number, string]>;
          } else {
            rows = dbHandle.exec({
              sql: "SELECT block_id, item_id, start_at, duration_minutes, locked, source FROM scheduled_blocks WHERE start_at < ? AND (start_at + duration_minutes * 60000) > ? ORDER BY start_at ASC;",
              rowMode: "array",
              returnValue: "resultRows",
              bind: [endAt, startAt],
            }) as Array<[string, string, number, number, number, string]>;
          }

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
