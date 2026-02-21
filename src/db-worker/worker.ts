import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { RpcRequest, RpcResponse } from "../rpc/types";
import initSql from "./migrations/0001_init.sql?raw";
import blockersKindTextSql from "./migrations/0002_blockers_kind_text.sql?raw";
import runningTimersSql from "./migrations/0003_running_timers.sql?raw";
import sortOrderSql from "./migrations/0004_sort_order.sql?raw";
import dueNullableSql from "./migrations/0005_due_at_nullable.sql?raw";
import titleSearchSql from "./migrations/0006_title_search.sql?raw";
import dependenciesTypeLagSql from "./migrations/0007_dependencies_type_lag.sql?raw";
import completedAtSql from "./migrations/0008_completed_at.sql?raw";
import archivedAtSql from "./migrations/0010_archived_at.sql?raw";
import {
  computeSlackMinutes,
  deriveEndAtFromDuration,
  evaluateDependencyStatus,
} from "./scheduleMath";
import { computeRollupTotals } from "./rollup";
import {
  isPersistentBackend,
  normalizeStorageBackendPreference,
} from "../domain/storageRuntime";

const ctx = self as unknown as {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<RpcRequest>) => void
  ) => void;
  postMessage: (message: RpcResponse) => void;
};

const DB_FILENAME = "makewhen.sqlite3";
const VFS_NAME = "opfs-sahpool";
const UNGROUPED_PROJECT_ID = "__ungrouped__";
const storageBackendPreference = normalizeStorageBackendPreference(
  import.meta.env.VITE_STORAGE_BACKEND
);

type DbStorageBackend = "sqlite-opfs" | "sqlite-memory";

type DbInfoPayload =
  | {
      ok: true;
      storageBackend: DbStorageBackend;
      persistent: boolean;
      preference: string;
      fallbackFrom: "sqlite-opfs" | null;
      fallbackReason: string | null;
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
let scheduledBlocksSchema: { hasDuration: boolean; hasEndAt: boolean } | null =
  null;

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
    sql: dueNullableSql,
  },
  {
    version: 6,
    sql: titleSearchSql,
  },
  {
    version: 7,
    sql: dependenciesTypeLagSql,
  },
  {
    version: 8,
    sql: completedAtSql,
  },
  {
    version: 9,
    sql: archivedAtSql,
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

const normalizeArchiveFilter = (value: unknown) => {
  if (value === "archived" || value === "all" || value === "active") {
    return value;
  }
  return "active";
};

const buildArchiveWhere = (archiveFilter: string, alias?: string) => {
  const column = alias ? `${alias}.archived_at` : "archived_at";
  if (archiveFilter === "archived") {
    return `${column} IS NOT NULL`;
  }
  if (archiveFilter === "all") {
    return "1=1";
  }
  return `${column} IS NULL`;
};

const resolveDurationMinutes = (
  startAt: number,
  durationArg: unknown,
  endAtArg: unknown
) => {
  if (durationArg !== undefined && durationArg !== null) {
    return ensurePositiveInteger(durationArg, "duration_minutes");
  }
  if (endAtArg !== undefined && endAtArg !== null) {
    const endAt = ensureInteger(endAtArg, "end_at");
    const minutes = Math.ceil((endAt - startAt) / 60000);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error("end_at must be after start_at");
    }
    return minutes;
  }
  throw new Error("duration_minutes is required");
};

const ensureDependencyType = (value: unknown, name: string) => {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const normalized = value.trim().toUpperCase();
  if (!["FS", "SS", "FF", "SF"].includes(normalized)) {
    throw new Error(`${name} must be FS, SS, FF, or SF`);
  }
  return normalized;
};

const normalizeDependencyType = (
  value: unknown
): "FS" | "SS" | "FF" | "SF" => {
  if (typeof value !== "string") {
    return "FS";
  }
  const normalized = value.trim().toUpperCase();
  if (
    normalized === "FS" ||
    normalized === "SS" ||
    normalized === "FF" ||
    normalized === "SF"
  ) {
    return normalized;
  }
  return "FS";
};

const parseEdgeId = (edgeId: string) => {
  const parts = edgeId.split("->");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("edge_id must be in successor->predecessor format");
  }
  return { successorId: parts[0], predecessorId: parts[1] };
};

type IntegrityIssue = {
  code: string;
  message: string;
  count?: number;
  sample?: unknown;
};

const detectDependencyCycles = (edges: Array<[string, string]>) => {
  const adjacency = new Map<string, string[]>();
  for (const [itemId, dependsOnId] of edges) {
    if (!adjacency.has(itemId)) {
      adjacency.set(itemId, []);
    }
    adjacency.get(itemId)?.push(dependsOnId);
  }
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycles: string[][] = [];

  const dfs = (node: string, path: string[]) => {
    if (cycles.length >= 5) {
      return;
    }
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      cycles.push(path.slice(cycleStart).concat(node));
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    inStack.add(node);
    const nextNodes = adjacency.get(node) ?? [];
    for (const next of nextNodes) {
      dfs(next, [...path, next]);
      if (cycles.length >= 5) {
        break;
      }
    }
    inStack.delete(node);
  };

  for (const node of adjacency.keys()) {
    if (cycles.length >= 5) {
      break;
    }
    if (!visited.has(node)) {
      dfs(node, [node]);
    }
  }
  return cycles;
};

const verifyIntegrity = (): { ok: boolean; issues: IntegrityIssue[] } => {
  if (!dbHandle) {
    return {
      ok: false,
      issues: [{ code: "db_missing", message: "DB not initialized" }],
    };
  }
  const issues: IntegrityIssue[] = [];

  const invalidBlocks = dbHandle.exec({
    sql: "SELECT block_id, item_id, duration_minutes FROM scheduled_blocks WHERE duration_minutes <= 0;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string, number]>;
  if (invalidBlocks.length > 0) {
    issues.push({
      code: "scheduled_blocks_invalid_duration",
      message: "Scheduled blocks must have duration_minutes > 0",
      count: invalidBlocks.length,
      sample: invalidBlocks.slice(0, 5),
    });
  }

  const blocksMissingItems = dbHandle.exec({
    sql: "SELECT block_id, item_id FROM scheduled_blocks WHERE item_id NOT IN (SELECT id FROM items);",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string]>;
  if (blocksMissingItems.length > 0) {
    issues.push({
      code: "scheduled_blocks_missing_items",
      message: "Scheduled blocks reference missing items",
      count: blocksMissingItems.length,
      sample: blocksMissingItems.slice(0, 5),
    });
  }

  const depsMissingItems = dbHandle.exec({
    sql: "SELECT item_id, depends_on_id FROM dependencies WHERE item_id NOT IN (SELECT id FROM items) OR depends_on_id NOT IN (SELECT id FROM items);",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string]>;
  if (depsMissingItems.length > 0) {
    issues.push({
      code: "dependencies_missing_items",
      message: "Dependencies reference missing items",
      count: depsMissingItems.length,
      sample: depsMissingItems.slice(0, 5),
    });
  }

  const dependencyEdges = dbHandle.exec({
    sql: "SELECT item_id, depends_on_id FROM dependencies;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string]>;
  const cycles = detectDependencyCycles(dependencyEdges);
  if (cycles.length > 0) {
    issues.push({
      code: "dependency_cycles",
      message: "Dependency cycles detected",
      count: cycles.length,
      sample: cycles,
    });
  }

  const blockersMissingItems = dbHandle.exec({
    sql: "SELECT blocker_id, item_id FROM blockers WHERE item_id NOT IN (SELECT id FROM items);",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string]>;
  if (blockersMissingItems.length > 0) {
    issues.push({
      code: "blockers_missing_items",
      message: "Blockers reference missing items",
      count: blockersMissingItems.length,
      sample: blockersMissingItems.slice(0, 5),
    });
  }

  const timeEntryIssues = dbHandle.exec({
    sql: "SELECT entry_id, item_id, start_at, end_at FROM time_entries WHERE item_id NOT IN (SELECT id FROM items) OR end_at < start_at;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string, number, number]>;
  if (timeEntryIssues.length > 0) {
    issues.push({
      code: "time_entries_invalid",
      message: "Time entries reference missing items or have end_at < start_at",
      count: timeEntryIssues.length,
      sample: timeEntryIssues.slice(0, 5),
    });
  }

  const timeEntriesByItem = dbHandle.exec({
    sql: "SELECT item_id, start_at, end_at FROM time_entries ORDER BY item_id, start_at;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, number, number]>;
  let overlapCount = 0;
  let overlapSample: Array<[string, number, number, number, number]> = [];
  let currentItem: string | null = null;
  let lastEnd = 0;
  for (const [itemId, startAt, endAt] of timeEntriesByItem) {
    if (itemId !== currentItem) {
      currentItem = itemId;
      lastEnd = endAt;
      continue;
    }
    if (startAt < lastEnd) {
      overlapCount += 1;
      if (overlapSample.length < 5) {
        overlapSample.push([itemId, startAt, endAt, lastEnd, startAt]);
      }
    }
    if (endAt > lastEnd) {
      lastEnd = endAt;
    }
  }
  if (overlapCount > 0) {
    issues.push({
      code: "time_entries_overlap",
      message: "Overlapping time entries detected for the same item",
      count: overlapCount,
      sample: overlapSample,
    });
  }

  const runningTimerCount = dbHandle.exec({
    sql: "SELECT COUNT(*) FROM running_timers;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[number]>;
  if ((runningTimerCount[0]?.[0] ?? 0) > 1) {
    issues.push({
      code: "multiple_running_timers",
      message: "More than one running timer exists",
      count: runningTimerCount[0][0],
    });
  }

  const completedMissing = dbHandle.exec({
    sql: "SELECT id, status, completed_at FROM items WHERE status = 'done' AND completed_at IS NULL;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string, number | null]>;
  if (completedMissing.length > 0) {
    issues.push({
      code: "completed_at_missing",
      message: "Done items must have completed_at set",
      count: completedMissing.length,
      sample: completedMissing.slice(0, 5),
    });
  }

  const completedExtra = dbHandle.exec({
    sql: "SELECT id, status, completed_at FROM items WHERE status != 'done' AND completed_at IS NOT NULL;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string, number | null]>;
  if (completedExtra.length > 0) {
    issues.push({
      code: "completed_at_orphaned",
      message: "Non-done items should not have completed_at set",
      count: completedExtra.length,
      sample: completedExtra.slice(0, 5),
    });
  }

  return { ok: issues.length === 0, issues };
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

const ensureTimeMs = (value: unknown, name: string) => {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${name} must be a valid ISO timestamp`);
    }
    return parsed;
  }
  return ensureNumber(value, name);
};

const DAY_MS = 24 * 60 * 60 * 1000;

const parseLocalDayStart = (value: unknown, name: string) => {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a YYYY-MM-DD string`);
  }
  const parts = value.split("-");
  if (parts.length !== 3) {
    throw new Error(`${name} must be a YYYY-MM-DD string`);
  }
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new Error(`${name} must be a valid date`);
  }
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(`${name} must be a valid date`);
  }
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const formatLocalDay = (value: Date) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

const escapeLike = (value: string) =>
  value.replace(/[\\%_]/g, (match) => `\\${match}`);

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
    sql: `SELECT id, status,
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
  }) as Array<[string, string, number, number]>;
  for (const row of rows) {
    const status = row[1];
    const hasBlocker = Boolean(row[2]);
    const hasUnmetDep = Boolean(row[3]);
    map.set(row[0], {
      hasBlocker,
      hasUnmetDep,
      is_blocked: status === "blocked" || hasBlocker || hasUnmetDep,
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
    sql: `SELECT item_id, assignee_id FROM item_assignees WHERE item_id IN (${placeholders}) ORDER BY assignee_id ASC;`,
    rowMode: "array",
    returnValue: "resultRows",
    bind: ids,
  }) as Array<[string, string]>;
  for (const row of rows) {
    const list = map.get(row[0]) ?? [];
    if (!list.includes(row[1])) {
      list.push(row[1]);
    }
    map.set(row[0], list);
  }
  for (const [key, list] of map.entries()) {
    if (list.length > 1) {
      map.set(key, [list[0]]);
    }
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

const resolveScopeArgs = (args: Record<string, unknown>) => {
  let scopeProjectId =
    typeof args.scopeProjectId === "string" ? args.scopeProjectId : null;
  let scopeUserId =
    typeof args.scopeUserId === "string" ? args.scopeUserId : null;
  const scope =
    typeof args.scope === "object" && args.scope !== null
      ? (args.scope as Record<string, unknown>)
      : null;
  if (scope && typeof scope.kind === "string") {
    if (scope.kind === "project") {
      scopeProjectId =
        typeof scope.projectId === "string" ? scope.projectId : null;
      scopeUserId = null;
    } else if (scope.kind === "user") {
      scopeUserId = typeof scope.userId === "string" ? scope.userId : null;
      scopeProjectId = null;
    }
  }
  return { scopeProjectId, scopeUserId };
};

const getScopeItemIds = (
  db: any,
  scopeProjectId: string | null,
  scopeUserId: string | null
) => {
  if (scopeUserId) {
    const rows = db.exec({
      sql: `SELECT i.id
        FROM items i
        JOIN item_assignees a ON a.item_id = i.id
        WHERE a.assignee_id = ?
          AND i.archived_at IS NULL;`,
      rowMode: "array",
      returnValue: "resultRows",
      bind: [scopeUserId],
    }) as Array<[string]>;
    return rows.map((row) => row[0]);
  }
  if (scopeProjectId === UNGROUPED_PROJECT_ID) {
    const rows = db.exec({
      sql: `WITH RECURSIVE tree AS (
        SELECT * FROM items WHERE parent_id IS NULL AND type = 'task'
        UNION ALL
        SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
      )
      SELECT id FROM tree WHERE archived_at IS NULL;`,
      rowMode: "array",
      returnValue: "resultRows",
    }) as Array<[string]>;
    return rows.map((row) => row[0]);
  }
  if (scopeProjectId) {
    const rows = db.exec({
      sql: `WITH RECURSIVE tree AS (
        SELECT * FROM items WHERE id = ?
        UNION ALL
        SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
      )
      SELECT id FROM tree WHERE archived_at IS NULL;`,
      rowMode: "array",
      returnValue: "resultRows",
      bind: [scopeProjectId],
    }) as Array<[string]>;
    return rows.map((row) => row[0]);
  }
  const rows = db.exec({
    sql: `SELECT id FROM items WHERE archived_at IS NULL;`,
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string]>;
  return rows.map((row) => row[0]);
};

const getSubtreeIds = (db: any, seedIds: string[]) => {
  if (seedIds.length === 0) {
    return [];
  }
  const placeholders = buildPlaceholders(seedIds.length);
  const rows = db.exec({
    sql: `WITH RECURSIVE subtree AS (
      SELECT id FROM items WHERE id IN (${placeholders})
      UNION ALL
      SELECT i.id FROM items i JOIN subtree s ON i.parent_id = s.id
    )
    SELECT id FROM subtree;`,
    rowMode: "array",
    returnValue: "resultRows",
    bind: seedIds,
  }) as Array<[string]>;
  return Array.from(new Set(rows.map((row) => row[0])));
};

const getHierarchyRows = (db: any) =>
  db.exec({
    sql: "SELECT id, type, parent_id, title FROM items;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string, string | null, string]>;

const computeSequenceRank = (data: {
  is_overdue: boolean;
  is_blocked: boolean;
  due_at: number | null;
  priority: number;
  dependents: number;
}) => {
  const overdueScore = data.is_overdue ? 0 : 1;
  const blockedScore = data.is_blocked ? 1 : 0;
  const dueKey = Number.isFinite(data.due_at)
    ? Math.floor((data.due_at as number) / 60000)
    : Number.MAX_SAFE_INTEGER;
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

const USERS_SETTING_KEY = "users_registry";
const CURRENT_USER_SETTING_KEY = "current_user_id";

type UserRecord = {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
};

const normalizeUserList = (value: unknown): UserRecord[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const map = new Map<string, UserRecord>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.user_id !== "string" || typeof record.display_name !== "string") {
      continue;
    }
    const avatar =
      typeof record.avatar_url === "string" ? record.avatar_url : null;
    if (!map.has(record.user_id)) {
      map.set(record.user_id, {
        user_id: record.user_id,
        display_name: record.display_name,
        avatar_url: avatar,
      });
    }
  }
  return Array.from(map.values());
};

const readUserRegistry = (db: any) => {
  const settings = getSettings(db);
  return normalizeUserList(settings.get(USERS_SETTING_KEY));
};

const writeUserRegistry = (db: any, users: UserRecord[]) => {
  const payload = JSON.stringify(users);
  db.exec(
    "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json;",
    {
      bind: [USERS_SETTING_KEY, payload],
    }
  );
};

const getUserMap = (db: any) => {
  const registry = readUserRegistry(db);
  return new Map(registry.map((user) => [user.user_id, user.display_name]));
};

const getUserDisplayName = (userId: string, nameMap: Map<string, string>) => {
  if (!userId) {
    return null;
  }
  return nameMap.get(userId) ?? `User ${userId.slice(0, 6)}`;
};

const exportData = (db: any) => {
  const itemsRows = db.exec({
    sql: "SELECT id, type, title, parent_id, status, priority, due_at, estimate_mode, estimate_minutes, health, health_mode, notes, created_at, updated_at, archived_at FROM items;",
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
      number | null,
      string,
      number,
      string,
      string,
      string | null,
      number,
      number,
      number | null
    ]
  >;

  const dependencyRows = db.exec({
    sql: "SELECT item_id, depends_on_id, type, lag_minutes FROM dependencies;",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[string, string, string, number]>;

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
      archived_at: row[14],
    })),
    dependencies: dependencyRows.map((row) => ({
      item_id: row[0],
      depends_on_id: row[1],
      type: row[2],
      lag_minutes: row[3],
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

const computeDueMetrics = (
  dueAt: number | null,
  now: number,
  status: string
) => {
  if (dueAt === null) {
    return {
      is_overdue: false,
      days_until_due: 0,
      days_overdue: 0,
    };
  }
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

const enforceSingleScheduledBlock = (
  db: any,
  itemId: string,
  keepBlockId?: string
) => {
  if (keepBlockId) {
    db.exec(
      "DELETE FROM scheduled_blocks WHERE item_id = ? AND block_id != ?;",
      { bind: [itemId, keepBlockId] }
    );
  } else {
    db.exec("DELETE FROM scheduled_blocks WHERE item_id = ?;", {
      bind: [itemId],
    });
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

  const tableInfo = db.exec({
    sql: "PRAGMA table_info(items);",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[number, string, string, number, unknown, number]>;
  const dueAtRow = tableInfo.find((row) => row[1] === "due_at");
  if (dueAtRow && Number(dueAtRow[3]) === 1) {
    db.exec(dueNullableSql);
    currentVersion = Math.max(currentVersion, 5);
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

  const archivedAtRow = tableInfo.find((row) => row[1] === "archived_at");
  if (!archivedAtRow) {
    db.exec(archivedAtSql);
    currentVersion = Math.max(currentVersion, 9);
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

  return currentVersion;
};

const loadScheduledBlocksSchema = (db: any) => {
  const rows = db.exec({
    sql: "PRAGMA table_info(scheduled_blocks);",
    rowMode: "array",
    returnValue: "resultRows",
  }) as Array<[number, string, string, number, unknown, number]>;
  const names = new Set(rows.map((row) => row[1]));
  scheduledBlocksSchema = {
    hasDuration: names.has("duration_minutes"),
    hasEndAt: names.has("end_at"),
  };
  return scheduledBlocksSchema;
};

const ensureScheduledBlocksDurationColumn = (db: any) => {
  const schema = loadScheduledBlocksSchema(db);
  if (!schema.hasDuration && schema.hasEndAt) {
    db.exec(
      "ALTER TABLE scheduled_blocks ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 0;"
    );
    db.exec(
      `UPDATE scheduled_blocks
        SET duration_minutes = CASE
          WHEN end_at IS NOT NULL AND end_at > start_at THEN CAST((end_at - start_at + 59999) / 60000 AS INTEGER)
          ELSE 0
        END;`
    );
    scheduledBlocksSchema = { hasDuration: true, hasEndAt: true };
    return scheduledBlocksSchema;
  }
  if (schema.hasDuration && schema.hasEndAt) {
    db.exec(
      `UPDATE scheduled_blocks
        SET duration_minutes = CASE
          WHEN end_at IS NOT NULL AND end_at > start_at THEN CAST((end_at - start_at + 59999) / 60000 AS INTEGER)
          ELSE duration_minutes
        END
        WHERE duration_minutes IS NULL OR duration_minutes <= 0;`
    );
  }
  return scheduledBlocksSchema;
};

type OpenedDb = {
  db: any;
  storageBackend: DbStorageBackend;
  vfs: string;
  filename: string;
  fallbackFrom: "sqlite-opfs" | null;
  fallbackReason: string | null;
};

const openDbInMemory = (sqlite3: any): OpenedDb => ({
  db: new sqlite3.oo1.DB(":memory:", "c"),
  storageBackend: "sqlite-memory",
  vfs: "memdb",
  filename: ":memory:",
  fallbackFrom: null,
  fallbackReason: null,
});

const openDbWithOpfs = async (sqlite3: any): Promise<OpenedDb> => {
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({
    name: VFS_NAME,
  });
  return {
    db: new poolUtil.OpfsSAHPoolDb(DB_FILENAME),
    storageBackend: "sqlite-opfs",
    vfs: VFS_NAME,
    filename: DB_FILENAME,
    fallbackFrom: null,
    fallbackReason: null,
  };
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
      let opened: OpenedDb;
      if (storageBackendPreference === "memory") {
        opened = openDbInMemory(sqlite3);
      } else {
        try {
          opened = await openDbWithOpfs(sqlite3);
        } catch (err) {
          if (storageBackendPreference === "opfs-strict") {
            throw err;
          }
          const fallbackReason =
            err instanceof Error ? err.message : String(err);
          opened = {
            ...openDbInMemory(sqlite3),
            fallbackFrom: "sqlite-opfs",
            fallbackReason,
          };
        }
      }
      dbHandle = opened.db;
      const schemaVersion = runMigrations(opened.db);
      ensureScheduledBlocksDurationColumn(opened.db);

      dbState.info = {
        ok: true,
        storageBackend: opened.storageBackend,
        persistent: isPersistentBackend(opened.storageBackend),
        preference: storageBackendPreference,
        fallbackFrom: opened.fallbackFrom,
        fallbackReason: opened.fallbackReason,
        vfs: opened.vfs,
        filename: opened.filename,
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
          const dueAt =
            args.due_at === null || args.due_at === undefined
              ? null
              : ensureInteger(args.due_at, "due_at");
          const estimateMinutes = ensureNonNegativeInteger(
            args.estimate_minutes,
            "estimate_minutes"
          );
          const parentId =
            typeof args.parent_id === "string" ? args.parent_id : null;
          const id = crypto.randomUUID();
          const now = Date.now();
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
          const completedAt = status === "done" ? now : null;
          const priority =
            typeof args.priority === "number" ? args.priority : 0;
          const health =
            typeof args.health === "string" ? args.health : "unknown";
          const healthMode =
            typeof args.health_mode === "string" ? args.health_mode : "auto";
          const notes = typeof args.notes === "string" ? args.notes : null;

          dbHandle.exec(
            "INSERT INTO items (id, type, title, parent_id, status, priority, due_at, estimate_mode, estimate_minutes, health, health_mode, notes, created_at, updated_at, sort_order, completed_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
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
                sortOrder,
                completedAt,
                null,
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
            "sort_order",
          ]);
          const numericFields = new Set([
            "due_at",
            "estimate_minutes",
            "priority",
            "sort_order",
          ]);
          const updates: string[] = [];
          const bind: unknown[] = [];

          for (const [key, value] of Object.entries(fields)) {
            if (!allowed.has(key)) {
              continue;
            }
            if (numericFields.has(key)) {
              if (key === "due_at" && value === null) {
                // allow nullable due dates
              } else {
                ensureNumber(value, key);
              }
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
          const override = args.override === true;
          const settings = getSettings(dbHandle);
          const autoArchive =
            settings.get("ui.auto_archive_on_complete") === true;
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
          const now = Date.now();
          let completedAt: number | null = null;
          let archivedAt: number | null = null;
          if (status === "done") {
            const completedRows = dbHandle.exec({
              sql: "SELECT completed_at, archived_at FROM items WHERE id = ?;",
              rowMode: "array",
              returnValue: "resultRows",
              bind: [id],
            }) as Array<[number | null, number | null]>;
            const existingCompleted = completedRows[0]?.[0] ?? null;
            const existingArchived = completedRows[0]?.[1] ?? null;
            completedAt = existingCompleted ?? now;
            if (autoArchive) {
              archivedAt = existingArchived ?? now;
            }
          }
          dbHandle.exec(
            "UPDATE items SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?;",
            {
              bind: [status, now, completedAt, id],
            }
          );
          if (status === "done" && autoArchive) {
            const archiveIds = getSubtreeIds(dbHandle, [id]);
            if (archiveIds.length > 0) {
              const placeholders = buildPlaceholders(archiveIds.length);
              dbHandle.exec(
                `UPDATE items SET archived_at = ?, updated_at = ? WHERE id IN (${placeholders});`,
                {
                  bind: [archivedAt ?? now, now, ...archiveIds],
                }
              );
            }
          }
          result = {
            ok: true,
            result: { id },
            invalidate: ["items", `item:${id}`],
          };
          break;
        }
        case "scheduled_block.create": {
          const itemId = ensureString(args.item_id, "item_id");
          const startAt = ensureInteger(args.start_at, "start_at");
          const durationMinutes = resolveDurationMinutes(
            startAt,
            args.duration_minutes,
            args.end_at
          );
          const blockId = crypto.randomUUID();
          const locked = typeof args.locked === "number" ? args.locked : 0;
          const source = typeof args.source === "string" ? args.source : "manual";
          enforceSingleScheduledBlock(dbHandle, itemId);
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
        case "scheduled_block.update": {
          const blockId = ensureString(args.block_id, "block_id");
          const currentRows = dbHandle.exec({
            sql: "SELECT item_id, start_at, duration_minutes FROM scheduled_blocks WHERE block_id = ?;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [blockId],
          }) as Array<[string, number, number]>;
          if (currentRows.length === 0) {
            result = { ok: false, error: "scheduled block not found" };
            break;
          }
          const current = currentRows[0];
          const nextStartAt =
            args.start_at === undefined || args.start_at === null
              ? current[1]
              : ensureInteger(args.start_at, "start_at");
          let nextDuration = current[2];
          if (args.duration_minutes !== undefined && args.duration_minutes !== null) {
            nextDuration = ensurePositiveInteger(
              args.duration_minutes,
              "duration_minutes"
            );
          } else if (args.end_at !== undefined && args.end_at !== null) {
            nextDuration = resolveDurationMinutes(
              nextStartAt,
              undefined,
              args.end_at
            );
          } else if (
            args.start_at !== undefined &&
            args.start_at !== null &&
            args.end_at !== undefined &&
            args.end_at !== null
          ) {
            nextDuration = resolveDurationMinutes(
              nextStartAt,
              undefined,
              args.end_at
            );
          }
          dbHandle.exec(
            "UPDATE scheduled_blocks SET start_at = ?, duration_minutes = ? WHERE block_id = ?;",
            { bind: [nextStartAt, nextDuration, blockId] }
          );
          enforceSingleScheduledBlock(dbHandle, current[0], blockId);
          result = {
            ok: true,
            result: { block_id: blockId, item_id: current[0] },
            invalidate: ["blocks", `item:${current[0]}`],
          };
          break;
        }
        case "scheduled_block.delete": {
          const blockId = ensureString(args.block_id, "block_id");
          const rows = dbHandle.exec({
            sql: "SELECT item_id FROM scheduled_blocks WHERE block_id = ?;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [blockId],
          }) as Array<[string]>;
          const itemId = rows[0]?.[0] ?? null;
          if (!itemId) {
            result = { ok: false, error: "scheduled block not found" };
            break;
          }
          dbHandle.exec("DELETE FROM scheduled_blocks WHERE block_id = ?;", {
            bind: [blockId],
          });
          result = {
            ok: true,
            result: { block_id: blockId },
            invalidate: ["blocks", `item:${itemId}`],
          };
          break;
        }
        case "create_block": {
          const itemId = ensureString(args.item_id, "item_id");
          const startAt = ensureInteger(args.start_at, "start_at");
          const durationMinutes = resolveDurationMinutes(
            startAt,
            args.duration_minutes,
            args.end_at
          );
          const blockId = crypto.randomUUID();
          const locked = typeof args.locked === "number" ? args.locked : 0;
          const source = typeof args.source === "string" ? args.source : "manual";
          enforceSingleScheduledBlock(dbHandle, itemId);
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
          const rows = dbHandle.exec({
            sql: "SELECT item_id FROM scheduled_blocks WHERE block_id = ?;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [blockId],
          }) as Array<[string]>;
          const itemId = rows[0]?.[0] ?? null;
          if (!itemId) {
            result = { ok: false, error: "scheduled block not found" };
            break;
          }
          dbHandle.exec(
            "UPDATE scheduled_blocks SET start_at = ? WHERE block_id = ?;",
            { bind: [startAt, blockId] }
          );
          enforceSingleScheduledBlock(dbHandle, itemId, blockId);
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
          const rows = dbHandle.exec({
            sql: "SELECT item_id FROM scheduled_blocks WHERE block_id = ?;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [blockId],
          }) as Array<[string]>;
          const itemId = rows[0]?.[0] ?? null;
          if (!itemId) {
            result = { ok: false, error: "scheduled block not found" };
            break;
          }
          dbHandle.exec(
            "UPDATE scheduled_blocks SET duration_minutes = ? WHERE block_id = ?;",
            { bind: [durationMinutes, blockId] }
          );
          enforceSingleScheduledBlock(dbHandle, itemId, blockId);
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
        case "item.archive": {
          const itemId = ensureString(args.item_id, "item_id");
          const now =
            typeof args.now_at === "number"
              ? ensureInteger(args.now_at, "now_at")
              : Date.now();
          const archivedIds = getSubtreeIds(dbHandle, [itemId]);
          if (archivedIds.length === 0) {
            result = { ok: false, error: "item not found" };
            break;
          }
          const placeholders = buildPlaceholders(archivedIds.length);
          dbHandle.exec(
            `UPDATE items SET archived_at = ?, updated_at = ? WHERE id IN (${placeholders});`,
            {
              bind: [now, now, ...archivedIds],
            }
          );
          result = {
            ok: true,
            result: { archived_ids: archivedIds },
            invalidate: ["items"],
          };
          break;
        }
        case "items.archive_many": {
          const idsInput = ensureArray(args.ids, "ids")
            .map((value, index) => ensureString(value, `ids[${index}]`))
            .filter((value) => value.trim().length > 0);
          const uniqueIds = Array.from(new Set(idsInput));
          if (uniqueIds.length === 0) {
            result = { ok: false, error: "ids must be a non-empty array" };
            break;
          }
          const now =
            typeof args.now_at === "number"
              ? ensureInteger(args.now_at, "now_at")
              : Date.now();
          const archivedIds = getSubtreeIds(dbHandle, uniqueIds);
          if (archivedIds.length === 0) {
            result = { ok: false, error: "items not found" };
            break;
          }
          const placeholders = buildPlaceholders(archivedIds.length);
          dbHandle.exec(
            `UPDATE items SET archived_at = ?, updated_at = ? WHERE id IN (${placeholders});`,
            {
              bind: [now, now, ...archivedIds],
            }
          );
          result = {
            ok: true,
            result: { archived_ids: archivedIds },
            invalidate: ["items"],
          };
          break;
        }
        case "item.restore": {
          const itemId = ensureString(args.item_id, "item_id");
          const now = Date.now();
          const restoredIds = getSubtreeIds(dbHandle, [itemId]);
          if (restoredIds.length === 0) {
            result = { ok: false, error: "item not found" };
            break;
          }
          const placeholders = buildPlaceholders(restoredIds.length);
          dbHandle.exec(
            `UPDATE items SET archived_at = NULL, updated_at = ? WHERE id IN (${placeholders});`,
            {
              bind: [now, ...restoredIds],
            }
          );
          result = {
            ok: true,
            result: { restored_ids: restoredIds },
            invalidate: ["items"],
          };
          break;
        }
        case "items.restore_many": {
          const idsInput = ensureArray(args.ids, "ids")
            .map((value, index) => ensureString(value, `ids[${index}]`))
            .filter((value) => value.trim().length > 0);
          const uniqueIds = Array.from(new Set(idsInput));
          if (uniqueIds.length === 0) {
            result = { ok: false, error: "ids must be a non-empty array" };
            break;
          }
          const restoredIds = getSubtreeIds(dbHandle, uniqueIds);
          if (restoredIds.length === 0) {
            result = { ok: false, error: "items not found" };
            break;
          }
          const now = Date.now();
          const placeholders = buildPlaceholders(restoredIds.length);
          dbHandle.exec(
            `UPDATE items SET archived_at = NULL, updated_at = ? WHERE id IN (${placeholders});`,
            {
              bind: [now, ...restoredIds],
            }
          );
          result = {
            ok: true,
            result: { restored_ids: restoredIds },
            invalidate: ["items"],
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
        case "items.delete_many": {
          const idsInput = ensureArray(args.ids, "ids")
            .map((value, index) => ensureString(value, `ids[${index}]`))
            .filter((value) => value.trim().length > 0);
          const uniqueIds = Array.from(new Set(idsInput));
          if (uniqueIds.length === 0) {
            result = { ok: false, error: "ids must be a non-empty array" };
            break;
          }
          const seedPlaceholders = buildPlaceholders(uniqueIds.length);
          const idsRows = dbHandle.exec({
            sql: `WITH RECURSIVE subtree AS (
              SELECT id FROM items WHERE id IN (${seedPlaceholders})
              UNION ALL
              SELECT i.id FROM items i JOIN subtree s ON i.parent_id = s.id
            )
            SELECT id FROM subtree;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: uniqueIds,
          }) as Array<[string]>;
          const deletedIds = Array.from(
            new Set(idsRows.map((row) => row[0]))
          );
          if (deletedIds.length === 0) {
            result = { ok: false, error: "items not found" };
            break;
          }
          const placeholders = buildPlaceholders(deletedIds.length);
          dbHandle.exec(
            `DELETE FROM dependencies WHERE item_id IN (${placeholders}) OR depends_on_id IN (${placeholders});`,
            {
              bind: [...deletedIds, ...deletedIds],
            }
          );
          dbHandle.exec(
            `DELETE FROM blockers WHERE item_id IN (${placeholders});`,
            {
              bind: deletedIds,
            }
          );
          dbHandle.exec(
            `DELETE FROM scheduled_blocks WHERE item_id IN (${placeholders});`,
            {
              bind: deletedIds,
            }
          );
          dbHandle.exec(
            `DELETE FROM time_entries WHERE item_id IN (${placeholders});`,
            {
              bind: deletedIds,
            }
          );
          dbHandle.exec(
            `DELETE FROM running_timers WHERE item_id IN (${placeholders});`,
            {
              bind: deletedIds,
            }
          );
          dbHandle.exec(
            `DELETE FROM item_tags WHERE item_id IN (${placeholders});`,
            {
              bind: deletedIds,
            }
          );
          dbHandle.exec(
            `DELETE FROM item_assignees WHERE item_id IN (${placeholders});`,
            {
              bind: deletedIds,
            }
          );
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
              "SELECT id, sort_order FROM items WHERE parent_id IS ? ORDER BY sort_order ASC, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, title ASC;",
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
              "SELECT id FROM items WHERE parent_id IS ? ORDER BY sort_order ASC, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, title ASC;",
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
              status: ensureString(item.status, `items[${index}].status`),
              priority: ensureNumber(item.priority, `items[${index}].priority`),
              due_at: ensureOptionalNumber(
                item.due_at ?? null,
                `items[${index}].due_at`
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
            };
          });

          const dependencies = ensureArray(record.dependencies, "dependencies").map(
            (value, index) => {
              if (!value || typeof value !== "object") {
                throw new Error(`dependencies[${index}] must be an object`);
              }
              const dep = value as Record<string, unknown>;
              const typeRaw =
                dep.type === undefined
                  ? "FS"
                  : ensureDependencyType(dep.type, `dependencies[${index}].type`);
              const lagMinutes =
                dep.lag_minutes === undefined
                  ? 0
                  : ensureNonNegativeInteger(
                      dep.lag_minutes,
                      `dependencies[${index}].lag_minutes`
                    );
              return {
                item_id: ensureString(dep.item_id, `dependencies[${index}].item_id`),
                depends_on_id: ensureString(
                  dep.depends_on_id,
                  `dependencies[${index}].depends_on_id`
                ),
                type: typeRaw,
                lag_minutes: lagMinutes,
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
              "INSERT INTO items (id, type, title, parent_id, status, priority, due_at, estimate_mode, estimate_minutes, health, health_mode, notes, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
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
                  (item as Record<string, unknown>).archived_at ?? null,
                ],
              }
            );
          }

          for (const dep of dependencies) {
            dbHandle.exec(
              "INSERT INTO dependencies (item_id, depends_on_id, type, lag_minutes) VALUES (?, ?, ?, ?);",
              {
                bind: [dep.item_id, dep.depends_on_id, dep.type, dep.lag_minutes],
              }
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
        case "dependency.create": {
          const predecessorId = ensureString(
            args.predecessor_id,
            "predecessor_id"
          );
          const successorId = ensureString(
            args.successor_id,
            "successor_id"
          );
          if (predecessorId === successorId) {
            result = { ok: false, error: "cannot depend on itself" };
            break;
          }
          if (hasDependencyCycle(dbHandle, successorId, predecessorId)) {
            result = { ok: false, error: "dependency cycle detected" };
            break;
          }
          const type =
            args.type === undefined
              ? "FS"
              : ensureDependencyType(args.type, "type");
          const lagMinutes =
            args.lag_minutes === undefined
              ? 0
              : ensureNonNegativeInteger(args.lag_minutes, "lag_minutes");
          const existing = dbHandle.exec({
            sql: "SELECT 1 FROM dependencies WHERE item_id = ? AND depends_on_id = ? LIMIT 1;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [successorId, predecessorId],
          }) as Array<[number]>;
          if (existing.length > 0) {
            result = { ok: false, error: "dependency already exists" };
            break;
          }
          dbHandle.exec(
            "INSERT INTO dependencies (item_id, depends_on_id, type, lag_minutes) VALUES (?, ?, ?, ?);",
            {
              bind: [successorId, predecessorId, type, lagMinutes],
            }
          );
          result = {
            ok: true,
            result: {
              edge_id: `${successorId}->${predecessorId}`,
              predecessor_id: predecessorId,
              successor_id: successorId,
              type,
              lag_minutes: lagMinutes,
            },
            invalidate: [
              "items",
              `item:${successorId}`,
              `item:${predecessorId}`,
              "dependencies",
            ],
          };
          break;
        }
        case "dependency.update": {
          const edgeId = ensureString(args.edge_id, "edge_id");
          const { successorId, predecessorId } = parseEdgeId(edgeId);
          const rows = dbHandle.exec({
            sql: "SELECT type, lag_minutes FROM dependencies WHERE item_id = ? AND depends_on_id = ?;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [successorId, predecessorId],
          }) as Array<[string, number]>;
          if (rows.length === 0) {
            result = { ok: false, error: "dependency not found" };
            break;
          }
          const nextType =
            args.type === undefined
              ? null
              : ensureDependencyType(args.type, "type");
          const nextLag =
            args.lag_minutes === undefined
              ? null
              : ensureNonNegativeInteger(args.lag_minutes, "lag_minutes");
          if (nextType === null && nextLag === null) {
            result = { ok: false, error: "no dependency updates provided" };
            break;
          }
          const currentType = rows[0][0];
          const currentLag = Number(rows[0][1]);
          const updatedType = nextType ?? currentType;
          const updatedLag = nextLag ?? currentLag;
          dbHandle.exec(
            "UPDATE dependencies SET type = ?, lag_minutes = ? WHERE item_id = ? AND depends_on_id = ?;",
            {
              bind: [updatedType, updatedLag, successorId, predecessorId],
            }
          );
          result = {
            ok: true,
            result: {
              edge_id: edgeId,
              predecessor_id: predecessorId,
              successor_id: successorId,
              type: updatedType,
              lag_minutes: updatedLag,
            },
            invalidate: [
              "items",
              `item:${successorId}`,
              `item:${predecessorId}`,
              "dependencies",
            ],
          };
          break;
        }
        case "dependency.delete": {
          const edgeId = ensureString(args.edge_id, "edge_id");
          const { successorId, predecessorId } = parseEdgeId(edgeId);
          const rows = dbHandle.exec({
            sql: "SELECT 1 FROM dependencies WHERE item_id = ? AND depends_on_id = ? LIMIT 1;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [successorId, predecessorId],
          }) as Array<[number]>;
          if (rows.length === 0) {
            result = { ok: false, error: "dependency not found" };
            break;
          }
          dbHandle.exec(
            "DELETE FROM dependencies WHERE item_id = ? AND depends_on_id = ?;",
            {
              bind: [successorId, predecessorId],
            }
          );
          result = {
            ok: true,
            result: {
              edge_id: edgeId,
              predecessor_id: predecessorId,
              successor_id: successorId,
            },
            invalidate: [
              "items",
              `item:${successorId}`,
              `item:${predecessorId}`,
              "dependencies",
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
        case "user.create": {
          const displayName = ensureString(args.display_name, "display_name").trim();
          if (!displayName) {
            result = { ok: false, error: "display_name must be a non-empty string" };
            break;
          }
          const avatarUrl =
            typeof args.avatar_url === "string" ? args.avatar_url : null;
          const users = readUserRegistry(dbHandle);
          const userId = crypto.randomUUID();
          users.push({
            user_id: userId,
            display_name: displayName,
            avatar_url: avatarUrl,
          });
          writeUserRegistry(dbHandle, users);
          const settings = getSettings(dbHandle);
          if (typeof settings.get(CURRENT_USER_SETTING_KEY) !== "string") {
            dbHandle.exec(
              "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json;",
              {
                bind: [
                  CURRENT_USER_SETTING_KEY,
                  JSON.stringify(userId),
                ],
              }
            );
          }
          result = {
            ok: true,
            result: { user_id: userId },
            invalidate: ["users"],
          };
          break;
        }
        case "user.update": {
          const userId = ensureString(args.user_id, "user_id");
          const displayName =
            typeof args.display_name === "string"
              ? args.display_name.trim()
              : null;
          const avatarUrl =
            typeof args.avatar_url === "string" ? args.avatar_url : null;
          const users = readUserRegistry(dbHandle);
          const index = users.findIndex((user) => user.user_id === userId);
          if (index === -1) {
            result = { ok: false, error: "user_id not found" };
            break;
          }
          const next = { ...users[index] };
          if (displayName !== null) {
            if (!displayName) {
              result = { ok: false, error: "display_name must be non-empty" };
              break;
            }
            next.display_name = displayName;
          }
          if (avatarUrl !== null) {
            next.avatar_url = avatarUrl;
          }
          users[index] = next;
          writeUserRegistry(dbHandle, users);
          result = {
            ok: true,
            result: { user_id: userId },
            invalidate: ["users"],
          };
          break;
        }
        case "item.set_assignee": {
          const itemId = ensureString(args.item_id, "item_id");
          const userId =
            args.user_id === null || args.user_id === undefined
              ? null
              : ensureString(args.user_id, "user_id");
          dbHandle.exec("DELETE FROM item_assignees WHERE item_id = ?;", {
            bind: [itemId],
          });
          if (userId) {
            dbHandle.exec(
              "INSERT INTO item_assignees (item_id, assignee_id) VALUES (?, ?);",
              {
                bind: [itemId, userId],
              }
            );
          }
          result = {
            ok: true,
            result: { item_id: itemId, assignee_id: userId },
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
          const singleAssigneeId = assigneeIds[0] ?? null;
          dbHandle.exec("DELETE FROM item_assignees WHERE item_id = ?;", {
            bind: [itemId],
          });
          if (singleAssigneeId) {
            dbHandle.exec(
              "INSERT INTO item_assignees (item_id, assignee_id) VALUES (?, ?);",
              {
                bind: [itemId, singleAssigneeId],
              }
            );
          }
          result = {
            ok: true,
            result: {
              item_id: itemId,
              assignee_ids: singleAssigneeId ? [singleAssigneeId] : [],
            },
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
            sql: "SELECT id, type, title, parent_id, status, priority, due_at, estimate_mode, estimate_minutes, health, health_mode, notes FROM items WHERE id = ? LIMIT 1;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<
            [
              string,
              string,
              string,
              string | null,
              string,
              number,
              number | null,
              string,
              number,
              string,
              string,
              string | null
            ]
          >;

          if (rows.length === 0) {
            result = { ok: true, result: null };
            break;
          }

          const depsRows = dbHandle.exec({
            sql: `SELECT d.depends_on_id, i.status, d.type, d.lag_minutes, i.title
              FROM dependencies d
              LEFT JOIN items i ON i.id = d.depends_on_id
              WHERE d.item_id = ?;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<
            [string, string | null, string | null, number | null, string | null]
          >;

          const blockersRows = dbHandle.exec({
            sql: "SELECT blocker_id, kind, text, created_at, cleared_at FROM blockers WHERE item_id = ? ORDER BY created_at DESC;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string, string, string, number, number | null]>;

          const assigneeRows = dbHandle.exec({
            sql: "SELECT assignee_id FROM item_assignees WHERE item_id = ? ORDER BY assignee_id ASC LIMIT 1;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string]>;
          const assigneeId = assigneeRows[0]?.[0] ?? null;
          const assigneeName = assigneeId
            ? getUserDisplayName(assigneeId, getUserMap(dbHandle))
            : null;

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
          const treeRows = dbHandle.exec({
            sql: `WITH RECURSIVE tree AS (
              SELECT id, parent_id, estimate_mode, estimate_minutes, status, due_at FROM items WHERE id = ?
              UNION ALL
              SELECT i.id, i.parent_id, i.estimate_mode, i.estimate_minutes, i.status, i.due_at
              FROM items i JOIN tree t ON i.parent_id = t.id
            )
            SELECT id, parent_id, estimate_mode, estimate_minutes, status, due_at FROM tree;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string, string | null, string, number, string, number | null]>;
          const treeIds = treeRows.map((row) => row[0]);
          const treeScheduleMap = getScheduleSummaryMap(dbHandle, treeIds);
          const treeBlockedMap = getBlockedStatusMap(dbHandle, treeIds);
          const treeTimeMap = new Map<string, number>();
          if (treeIds.length > 0) {
            const placeholders = buildPlaceholders(treeIds.length);
            const treeTimeRows = dbHandle.exec({
              sql: `SELECT item_id, SUM(duration_minutes) FROM time_entries
                WHERE item_id IN (${placeholders})
                GROUP BY item_id;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: treeIds,
            }) as Array<[string, number]>;
            for (const row of treeTimeRows) {
              treeTimeMap.set(row[0], Number(row[1]));
            }
          }
          const treeDueMetricsMap = new Map(
            treeRows.map((row) => [
              row[0],
              computeDueMetrics(row[5], now, row[4]),
            ])
          );
          const rollupMap = computeRollupTotals(
            treeRows.map((row) => ({
              id: row[0],
              parent_id: row[1],
              estimate_mode: row[2],
              estimate_minutes: row[3],
            })),
            treeScheduleMap,
            treeBlockedMap,
            treeDueMetricsMap,
            treeTimeMap
          );
          const rollupTotals = rollupMap.get(itemId);
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
          const rollupEstimate = rollupTotals?.totalEstimate ?? rows[0][8];
          const rollupActual = rollupTotals?.totalActual ?? actualMinutes;
          const rollupRemaining = Math.max(0, rollupEstimate - rollupActual);
          const remainingMinutes =
            rows[0][1] === "task" && rows[0][7] !== "rollup"
              ? Math.max(0, rows[0][8] - actualMinutes)
              : rollupRemaining;
          const scheduleRows = dbHandle.exec({
            sql: "SELECT COUNT(*), SUM(duration_minutes), MIN(start_at), MAX(start_at + duration_minutes * 60000) FROM scheduled_blocks WHERE item_id = ?;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[number, number | null, number | null, number | null]>;
          const primaryBlockRows = dbHandle.exec({
            sql: "SELECT block_id, start_at, duration_minutes FROM scheduled_blocks WHERE item_id = ? ORDER BY start_at ASC LIMIT 1;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [itemId],
          }) as Array<[string, number, number]>;
          const primaryBlock = primaryBlockRows[0] ?? null;
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
              estimate_mode: rows[0][7],
              estimate_minutes: rows[0][8],
              health: rows[0][9],
              health_mode: rows[0][10],
              notes: rows[0][11],
              assignee_id: assigneeId,
              assignee_name: assigneeName,
              dependencies: depsRows.map((row) => row[0]),
              dependency_edges: depsRows.map((row) => {
                const predecessorId = row[0];
                const type = normalizeDependencyType(row[2] ?? "FS");
                const lagMinutes = Number.isFinite(row[3]) ? Number(row[3]) : 0;
                return {
                  edge_id: `${itemId}->${predecessorId}`,
                  predecessor_id: predecessorId,
                  type,
                  lag_minutes: lagMinutes,
                  predecessor_title: row[4] ?? predecessorId,
                };
              }),
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
              primary_block_id: primaryBlock ? primaryBlock[0] : null,
              running_timer: runningTimer,
              time_entries: timeEntryRows.map((row) => ({
                entry_id: row[0],
                start_at: row[1],
                end_at: row[2],
                duration_minutes: row[3],
                note: row[4],
                source: row[5],
              })),
              rollup_actual_minutes: rollupActual,
              rollup_estimate_minutes: rollupEstimate,
              rollup_remaining_minutes: rollupRemaining,
              rollup_start_at: rollupTotals?.rollupStartAt ?? null,
              rollup_end_at: rollupTotals?.rollupEndAt ?? null,
              rollup_blocked_count: rollupTotals?.rollupBlockedCount ?? 0,
              rollup_overdue_count: rollupTotals?.rollupOverdueCount ?? 0,
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
            ORDER BY sort_order ASC, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, title ASC;`,
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

          const blockedMap = getBlockedStatusMap(dbHandle, ids);
          const rollupMap = computeRollupTotals(
            rows.map((row) => ({
              id: row[0],
              parent_id: row[3],
              estimate_minutes: row[8],
              estimate_mode: row[7],
            })),
            scheduleMap,
            blockedMap,
            dueMetricsMap,
            timeMap
          );

          result = {
            ok: true,
            result: rows.map((row) => {
              const rollupTotals = rollupMap.get(row[0]);
              const rollupEstimate = rollupTotals?.totalEstimate ?? row[8];
              const rollupActual =
                rollupTotals?.totalActual ?? (timeMap.get(row[0]) ?? 0);
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
                rollup_start_at: rollupTotals?.rollupStartAt ?? null,
                rollup_end_at: rollupTotals?.rollupEndAt ?? null,
                rollup_blocked_count: rollupTotals?.rollupBlockedCount ?? 0,
                rollup_overdue_count: rollupTotals?.rollupOverdueCount ?? 0,
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
                FROM items WHERE parent_id = ? ORDER BY sort_order ASC, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, title ASC;`
              : `SELECT id, type, title, parent_id, status, priority, due_at,
                (
                  EXISTS(SELECT 1 FROM blockers b WHERE b.item_id = items.id AND b.cleared_at IS NULL)
                  OR EXISTS(
                    SELECT 1 FROM dependencies d
                    LEFT JOIN items di ON di.id = d.depends_on_id
                    WHERE d.item_id = items.id AND (di.id IS NULL OR di.status != 'done')
                  )
                ) AS is_blocked
                FROM items ORDER BY sort_order ASC, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, title ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<
            [
              string,
              string,
              string,
              string | null,
              string,
              number,
              number | null,
              number
            ]
          >;

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
          const projectIdArg =
            typeof args.projectId === "string" ? args.projectId : null;
          const isUngrouped = projectIdArg === UNGROUPED_PROJECT_ID;
          const projectId = isUngrouped ? null : projectIdArg;
          const statusArg = args.status;
          const healthArg = args.health;
          const archiveFilter = normalizeArchiveFilter(args.archiveFilter);
          const archiveWhere = buildArchiveWhere(archiveFilter);
          const assigneeId =
            typeof args.assigneeId === "string" ? args.assigneeId : null;
          const tagFilter =
            typeof args.tagId === "string"
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
            sql: isUngrouped
              ? `WITH RECURSIVE tree AS (
                  SELECT * FROM items WHERE parent_id IS NULL AND type = 'task'
                  UNION ALL
                  SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
                )
                SELECT * FROM (
                  SELECT id, type, title, parent_id, status, priority, due_at,
                    estimate_mode, estimate_minutes, health, health_mode, notes, updated_at, sort_order, archived_at
                  FROM tree
                  WHERE ${archiveWhere}
                )
                ORDER BY sort_order ASC,
                  CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
                  due_at ASC,
                  title ASC;`
              : projectId
                ? `WITH RECURSIVE tree AS (
                    SELECT * FROM items WHERE id = ?
                    UNION ALL
                    SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
                  )
                  SELECT * FROM (
                    SELECT id, type, title, parent_id, status, priority, due_at,
                      estimate_mode, estimate_minutes, health, health_mode, notes, updated_at, sort_order, archived_at
                    FROM tree
                    WHERE ${archiveWhere}
                  )
                  ORDER BY sort_order ASC,
                    CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
                    due_at ASC,
                    title ASC;`
                : `SELECT id, type, title, parent_id, status, priority, due_at,
                    estimate_mode, estimate_minutes, health, health_mode, notes, updated_at, sort_order, archived_at
                  FROM items
                  WHERE ${archiveWhere}
                  ORDER BY sort_order ASC,
                    CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
                    due_at ASC,
                    title ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<
            [
              string,
              string,
              string,
              string | null,
              string,
              number,
              number | null,
              string,
              number,
              string,
              string,
              string | null,
              number,
              number,
              number | null
            ]
          >;
          const ids = rows.map((row) => row[0]);
          const rowMap = new Map(
            rows.map((row) => [row[0], { updated_at: row[12], sort_order: row[13] }])
          );
          const scheduleMap = getScheduleSummaryMap(dbHandle, ids);
          const blockedMap = getBlockedStatusMap(dbHandle, ids);
          const assigneesMap = getAssigneesMap(dbHandle, ids);
          const tagsMap = getTagsMap(dbHandle, ids);
          const userNameMap = getUserMap(dbHandle);
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
          const dueMetricsMap = new Map(
            rows.map((row) => [row[0], computeDueMetrics(row[6], now, row[4])])
          );
          const rollupMap = computeRollupTotals(
            rows.map((row) => ({
              id: row[0],
              parent_id: row[3],
              estimate_mode: row[7],
              estimate_minutes: row[8],
            })),
            scheduleMap,
            blockedMap,
            dueMetricsMap,
            timeMap
          );
          const includeCanceled =
            typeof args.includeCanceled === "boolean" ? args.includeCanceled : false;
          const includeDone =
            typeof args.includeDone === "boolean" ? args.includeDone : false;
          const searchText =
            typeof args.searchText === "string" ? args.searchText.trim() : "";
          const filtered = rows.filter((row) => {
            if (statusFilter && !statusFilter.includes(row[4])) {
              return false;
            }
            if (healthFilter && !healthFilter.includes(row[9])) {
              return false;
            }
            if (!includeCanceled && row[4] === "canceled") {
              return false;
            }
            if (!includeDone && row[4] === "done") {
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
              const haystack = `${row[2]} ${row[11] ?? ""}`.toLowerCase();
              if (!haystack.includes(searchText.toLowerCase())) {
                return false;
              }
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
            const dueMetrics = dueMetricsMap.get(row[0])!;
            const rollupTotals = rollupMap.get(row[0]);
            const actualMinutes = timeMap.get(row[0]) ?? 0;
            const assigneeIds = assigneesMap.get(row[0]) ?? [];
            const assigneeId = assigneeIds[0] ?? null;
            const assigneeName = assigneeId
              ? getUserDisplayName(assigneeId, userNameMap)
              : null;
            const rollupEstimate = rollupTotals?.totalEstimate ?? row[8];
            const rollupActual =
              rollupTotals?.totalActual ?? actualMinutes;
            const rollupRemaining = Math.max(0, rollupEstimate - rollupActual);
            const remainingMinutes = rollupRemaining;
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
              due_at: row[6],
              priority: row[5],
              dependents,
            });
            return {
              id: row[0],
              type: row[1],
              title: row[2],
              parent_id: row[3],
              project_id: isUngrouped
                ? UNGROUPED_PROJECT_ID
                : projectMap.get(row[0]) ?? row[0],
              depth: depthMap.get(row[0]) ?? 0,
              status: row[4],
              priority: row[5],
              due_at: row[6],
              archived_at: row[14],
              estimate_mode: row[7],
              estimate_minutes: row[8],
              rollup_estimate_minutes: rollupEstimate,
              rollup_actual_minutes: rollupActual,
              rollup_remaining_minutes: rollupRemaining,
              rollup_start_at: rollupTotals?.rollupStartAt ?? null,
              rollup_end_at: rollupTotals?.rollupEndAt ?? null,
              rollup_blocked_count: rollupTotals?.rollupBlockedCount ?? 0,
              rollup_overdue_count: rollupTotals?.rollupOverdueCount ?? 0,
              notes: row[11],
              sort_order: row[13],
              health: row[9],
              health_mode: row[10],
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
              assignees: assigneeIds.map((id) => ({
                id,
                name: null,
              })),
              assignee_id: assigneeId,
              assignee_name: assigneeName,
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
            if (orderBy === "title") {
              return a.title.localeCompare(b.title) * dir;
            }
            if (orderBy === "updated_at") {
              const aUpdated = rowMap.get(a.id)?.updated_at ?? 0;
              const bUpdated = rowMap.get(b.id)?.updated_at ?? 0;
              return (aUpdated - bUpdated) * dir;
            }
            if (a.due_at !== b.due_at) {
              const aDue = a.due_at ?? Number.MAX_SAFE_INTEGER;
              const bDue = b.due_at ?? Number.MAX_SAFE_INTEGER;
              return (aDue - bDue) * dir;
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
        case "list_view_complete":
        case "list_view_scope": {
          const { scopeProjectId, scopeUserId } = resolveScopeArgs(
            args as Record<string, unknown>
          );
          const scopeParentId =
            typeof args.scopeParentId === "string" ? args.scopeParentId : null;
          const includeUngrouped =
            typeof args.includeUngrouped === "boolean"
              ? args.includeUngrouped
              : false;
          const includeCompleted =
            typeof args.includeCompleted === "boolean"
              ? args.includeCompleted
              : true;
          const archiveFilter = normalizeArchiveFilter(args.archiveFilter);
          const archiveWhere = buildArchiveWhere(archiveFilter);
          const archiveWhereAlias = buildArchiveWhere(archiveFilter, "i");

          const fetchTree = (rootId: string) =>
            dbHandle.exec({
              sql: `WITH RECURSIVE tree AS (
                SELECT * FROM items WHERE id = ?
                UNION ALL
                SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
              )
              SELECT id, type, title, parent_id, status, priority, due_at,
                estimate_mode, estimate_minutes, notes, created_at, updated_at, sort_order, completed_at
              FROM tree
              WHERE ${archiveWhere}
              ORDER BY sort_order ASC,
                CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
                due_at ASC,
                title ASC;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: [rootId],
            }) as Array<
              [
                string,
                string,
                string,
                string | null,
                string,
                number,
                number | null,
                string,
                number,
                string | null,
                number,
                number,
                number,
                number | null
              ]
            >;

          const fetchUngrouped = () =>
            dbHandle.exec({
              sql: `WITH RECURSIVE tree AS (
                SELECT * FROM items WHERE parent_id IS NULL AND type = 'task'
                UNION ALL
                SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
              )
              SELECT id, type, title, parent_id, status, priority, due_at,
                estimate_mode, estimate_minutes, notes, created_at, updated_at, sort_order, completed_at
              FROM tree
              WHERE ${archiveWhere}
              ORDER BY sort_order ASC,
                CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
                due_at ASC,
                title ASC;`,
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
                number | null,
                string,
                number,
                string | null,
                number,
                number,
                number,
                number | null
              ]
            >;

          const fetchAll = () =>
            dbHandle.exec({
              sql: `SELECT id, type, title, parent_id, status, priority, due_at,
                estimate_mode, estimate_minutes, notes, created_at, updated_at, sort_order, completed_at
              FROM items
              WHERE ${archiveWhere}
              ORDER BY sort_order ASC,
                CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
                due_at ASC,
                title ASC;`,
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
                number | null,
                string,
                number,
                string | null,
                number,
                number,
                number,
                number | null
              ]
            >;

          const fetchTreeForUser = (rootId: string, userId: string) =>
            dbHandle.exec({
              sql: `WITH RECURSIVE tree AS (
                SELECT * FROM items WHERE id = ?
                UNION ALL
                SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
              )
              SELECT i.id, i.type, i.title, i.parent_id, i.status, i.priority, i.due_at,
                i.estimate_mode, i.estimate_minutes, i.notes, i.created_at, i.updated_at, i.sort_order, i.completed_at
              FROM tree i
              JOIN item_assignees a ON a.item_id = i.id
              WHERE a.assignee_id = ?
                AND ${archiveWhereAlias}
              ORDER BY i.sort_order ASC,
                CASE WHEN i.due_at IS NULL THEN 1 ELSE 0 END,
                i.due_at ASC,
                i.title ASC;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: [rootId, userId],
            }) as Array<
              [
                string,
                string,
                string,
                string | null,
                string,
                number,
                number | null,
                string,
                number,
                string | null,
                number,
                number,
                number,
                number | null
              ]
            >;

          const fetchUngroupedForUser = (userId: string) =>
            dbHandle.exec({
              sql: `WITH RECURSIVE tree AS (
                SELECT * FROM items WHERE parent_id IS NULL AND type = 'task'
                UNION ALL
                SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
              )
              SELECT i.id, i.type, i.title, i.parent_id, i.status, i.priority, i.due_at,
                i.estimate_mode, i.estimate_minutes, i.notes, i.created_at, i.updated_at, i.sort_order, i.completed_at
              FROM tree i
              JOIN item_assignees a ON a.item_id = i.id
              WHERE a.assignee_id = ?
                AND ${archiveWhereAlias}
              ORDER BY i.sort_order ASC,
                CASE WHEN i.due_at IS NULL THEN 1 ELSE 0 END,
                i.due_at ASC,
                i.title ASC;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: [userId],
            }) as Array<
              [
                string,
                string,
                string,
                string | null,
                string,
                number,
                number | null,
                string,
                number,
                string | null,
                number,
                number,
                number,
                number | null
              ]
            >;

          const fetchAllForUser = (userId: string) =>
            dbHandle.exec({
              sql: `SELECT i.id, i.type, i.title, i.parent_id, i.status, i.priority, i.due_at,
                i.estimate_mode, i.estimate_minutes, i.notes, i.created_at, i.updated_at, i.sort_order, i.completed_at
              FROM items i
              JOIN item_assignees a ON a.item_id = i.id
              WHERE a.assignee_id = ?
                AND ${archiveWhereAlias}
              ORDER BY i.sort_order ASC,
                CASE WHEN i.due_at IS NULL THEN 1 ELSE 0 END,
                i.due_at ASC,
                i.title ASC;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: [userId],
            }) as Array<
              [
                string,
                string,
                string,
                string | null,
                string,
                number,
                number | null,
                string,
                number,
                string | null,
                number,
                number,
                number,
                number | null
              ]
            >;

          let rows: Array<
            [
              string,
              string,
              string,
              string | null,
              string,
              number,
              number | null,
              string,
              number,
              string | null,
              number,
              number,
              number,
              number | null
            ]
          > = [];

          if (scopeUserId) {
            if (scopeProjectId === UNGROUPED_PROJECT_ID) {
              rows = fetchUngroupedForUser(scopeUserId);
            } else if (scopeParentId) {
              rows = fetchTreeForUser(scopeParentId, scopeUserId);
            } else if (scopeProjectId) {
              rows = fetchTreeForUser(scopeProjectId, scopeUserId);
            } else {
              rows = fetchAllForUser(scopeUserId);
            }
          } else if (scopeProjectId === UNGROUPED_PROJECT_ID) {
            rows = fetchUngrouped();
          } else if (scopeParentId) {
            rows = fetchTree(scopeParentId);
          } else if (scopeProjectId) {
            rows = fetchTree(scopeProjectId);
          } else if (includeUngrouped) {
            rows = fetchUngrouped();
          } else {
            rows = fetchAll();
          }

          if (
            includeUngrouped &&
            scopeProjectId &&
            scopeProjectId !== UNGROUPED_PROJECT_ID
          ) {
            const extraRows = scopeUserId
              ? fetchUngroupedForUser(scopeUserId)
              : fetchUngrouped();
            const rowMap = new Map(rows.map((row) => [row[0], row]));
            for (const row of extraRows) {
              if (!rowMap.has(row[0])) {
                rows.push(row);
              }
            }
          }

          if (!includeCompleted) {
            rows = rows.filter((row) => row[4] !== "done" && row[4] !== "canceled");
          }

          const baseIds = rows.map((row) => row[0]);
          const uniqueBaseIds = Array.from(new Set(baseIds));

          if (uniqueBaseIds.length === 0) {
            result = { ok: true, result: [] };
            break;
          }

          const assigneesMap = getAssigneesMap(dbHandle, uniqueBaseIds);
          const userNameMap = getUserMap(dbHandle);

          const scheduleRows = dbHandle.exec({
            sql: `SELECT block_id, item_id, start_at, duration_minutes
              FROM scheduled_blocks
              WHERE item_id IN (${buildPlaceholders(uniqueBaseIds.length)});`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: uniqueBaseIds,
          }) as Array<[string, string, number, number]>;

          const blocksMap = new Map<
            string,
            Array<{
              block_id: string;
              item_id: string;
              start_at: number;
              duration_minutes: number;
              end_at_derived: number;
            }>
          >();
          const scheduleSummaryMap = new Map<
            string,
            { start: number | null; end: number | null }
          >();
          for (const row of scheduleRows) {
            const endAt =
              deriveEndAtFromDuration(row[2], row[3]) ?? row[2];
            const list = blocksMap.get(row[1]) ?? [];
            list.push({
              block_id: row[0],
              item_id: row[1],
              start_at: row[2],
              duration_minutes: row[3],
              end_at_derived: endAt,
            });
            blocksMap.set(row[1], list);
            const summary = scheduleSummaryMap.get(row[1]) ?? {
              start: null,
              end: null,
            };
            summary.start = minNullable(summary.start, row[2]);
            summary.end = maxNullable(summary.end, endAt);
            scheduleSummaryMap.set(row[1], summary);
          }

          if (scopeUserId && envelope.name === "list_view_scope") {
            rows = rows
              .slice()
              .sort((a, b) => {
                const aSummary = scheduleSummaryMap.get(a[0]);
                const bSummary = scheduleSummaryMap.get(b[0]);
                const aStart =
                  aSummary?.start ?? Number.POSITIVE_INFINITY;
                const bStart =
                  bSummary?.start ?? Number.POSITIVE_INFINITY;
                if (aStart !== bStart) {
                  return aStart - bStart;
                }
                const aDue = a[6] ?? Number.POSITIVE_INFINITY;
                const bDue = b[6] ?? Number.POSITIVE_INFINITY;
                if (aDue !== bDue) {
                  return aDue - bDue;
                }
                return a[2].localeCompare(b[2]);
              });
          }

          const timeRows = dbHandle.exec({
            sql: `SELECT item_id, SUM(duration_minutes) FROM time_entries
              WHERE item_id IN (${buildPlaceholders(uniqueBaseIds.length)})
              GROUP BY item_id;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: uniqueBaseIds,
          }) as Array<[string, number]>;
          const timeMap = new Map<string, number>();
          for (const row of timeRows) {
            timeMap.set(row[0], Number(row[1]));
          }

          const blockedRawMap = getBlockedStatusMap(dbHandle, uniqueBaseIds);
          const blockedMap = new Map(
            Array.from(blockedRawMap.entries()).map(([id, summary]) => [
              id,
              { is_blocked: summary.is_blocked },
            ])
          );
          const now = Date.now();
          const dueMetricsMap = new Map(
            rows.map((row) => [row[0], computeDueMetrics(row[6], now, row[4])])
          );
          const rollupMap = computeRollupTotals(
            rows.map((row) => ({
              id: row[0],
              parent_id: row[3],
              estimate_mode: row[7],
              estimate_minutes: row[8],
            })),
            scheduleSummaryMap,
            blockedMap,
            dueMetricsMap,
            timeMap
          );

          const depRows = dbHandle.exec({
            sql: `SELECT item_id, depends_on_id, type, lag_minutes FROM dependencies
              WHERE item_id IN (${buildPlaceholders(uniqueBaseIds.length)})
                OR depends_on_id IN (${buildPlaceholders(uniqueBaseIds.length)});`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: [...uniqueBaseIds, ...uniqueBaseIds],
          }) as Array<[string, string, string, number]>;

          const allEdgeIds = new Set<string>();
          for (const row of depRows) {
            allEdgeIds.add(row[0]);
            allEdgeIds.add(row[1]);
          }
          const edgeIds = Array.from(allEdgeIds);

          const metaMap = new Map<
            string,
            {
              id: string;
              title: string;
              type: string;
              status: string;
              parent_id: string | null;
              due_at: number | null;
              updated_at: number;
            }
          >();
          for (const row of rows) {
            metaMap.set(row[0], {
              id: row[0],
              title: row[2],
              type: row[1],
              status: row[4],
              parent_id: row[3],
              due_at: row[6],
              updated_at: row[11],
            });
          }

          const missingIds = edgeIds.filter((id) => !metaMap.has(id));
          if (missingIds.length > 0) {
            const metaRows = dbHandle.exec({
              sql: `SELECT id, title, type, status, parent_id, due_at, updated_at
                FROM items WHERE id IN (${buildPlaceholders(missingIds.length)});`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: missingIds,
            }) as Array<
              [string, string, string, string, string | null, number | null, number]
            >;
            for (const row of metaRows) {
              metaMap.set(row[0], {
                id: row[0],
                title: row[1],
                type: row[2],
                status: row[3],
                parent_id: row[4],
                due_at: row[5],
                updated_at: row[6],
              });
            }
          }

          if (edgeIds.length > 0) {
            const edgeScheduleRows = dbHandle.exec({
              sql: `SELECT item_id, MIN(start_at), MAX(start_at + duration_minutes * 60000)
                FROM scheduled_blocks
                WHERE item_id IN (${buildPlaceholders(edgeIds.length)})
                GROUP BY item_id;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: edgeIds,
            }) as Array<[string, number | null, number | null]>;
            for (const row of edgeScheduleRows) {
              scheduleSummaryMap.set(row[0], {
                start: row[1] !== null ? Number(row[1]) : null,
                end: row[2] !== null ? Number(row[2]) : null,
              });
            }
          }

          const depsInMap = new Map<
            string,
            Array<{
              edge_id: string;
              predecessor_id: string;
              type: "FS" | "SS" | "FF" | "SF";
              lag_minutes: number;
            }>
          >();
          const depsOutMap = new Map<
            string,
            Array<{
              edge_id: string;
              successor_id: string;
              type: "FS" | "SS" | "FF" | "SF";
              lag_minutes: number;
            }>
          >();
          const baseSet = new Set(uniqueBaseIds);
          for (const row of depRows) {
            const edgeId = `${row[0]}->${row[1]}`;
            const type = normalizeDependencyType(row[2]);
            const lag = Number.isFinite(row[3]) ? Number(row[3]) : 0;
            if (baseSet.has(row[0])) {
              const list = depsInMap.get(row[0]) ?? [];
              list.push({
                edge_id: edgeId,
                predecessor_id: row[1],
                type,
                lag_minutes: lag,
              });
              depsInMap.set(row[0], list);
            }
            if (baseSet.has(row[1])) {
              const list = depsOutMap.get(row[1]) ?? [];
              list.push({
                edge_id: edgeId,
                successor_id: row[0],
                type,
                lag_minutes: lag,
              });
              depsOutMap.set(row[1], list);
            }
          }

          const items = rows.map((row) => {
            const id = row[0];
            const blocks = blocksMap.get(id) ?? [];
            const scheduleSummary = scheduleSummaryMap.get(id) ?? {
              start: null,
              end: null,
            };
            const slackMinutes = computeSlackMinutes(
              row[6],
              scheduleSummary.end
            );
            const rollupTotals = rollupMap.get(id);
            const depsIn = depsInMap.get(id) ?? [];
            const depsOut = depsOutMap.get(id) ?? [];
            const assigneeIds = assigneesMap.get(id) ?? [];
            const assigneeId = assigneeIds[0] ?? null;
            const assigneeName = assigneeId
              ? getUserDisplayName(assigneeId, userNameMap)
              : null;
            const blockedBy = depsIn.map((dep) => {
              const meta = metaMap.get(dep.predecessor_id);
              const predecessorSummary = scheduleSummaryMap.get(
                dep.predecessor_id
              );
              const successorSummary = scheduleSummary;
              return {
                item_id: dep.predecessor_id,
                title: meta?.title ?? dep.predecessor_id,
                type: dep.type,
                lag_minutes: dep.lag_minutes,
                status: evaluateDependencyStatus({
                  predecessorStart: predecessorSummary?.start ?? null,
                  predecessorEnd: predecessorSummary?.end ?? null,
                  successorStart: successorSummary.start,
                  successorEnd: successorSummary.end,
                  type: dep.type,
                  lagMinutes: dep.lag_minutes,
                }),
              };
            });
            const blocking = depsOut.map((dep) => {
              const meta = metaMap.get(dep.successor_id);
              const successorSummary = scheduleSummaryMap.get(dep.successor_id);
              const predecessorSummary = scheduleSummary;
              return {
                item_id: dep.successor_id,
                title: meta?.title ?? dep.successor_id,
                type: dep.type,
                lag_minutes: dep.lag_minutes,
                status: evaluateDependencyStatus({
                  predecessorStart: predecessorSummary.start,
                  predecessorEnd: predecessorSummary.end,
                  successorStart: successorSummary?.start ?? null,
                  successorEnd: successorSummary?.end ?? null,
                  type: dep.type,
                  lagMinutes: dep.lag_minutes,
                }),
              };
            });
            return {
              id,
              title: row[2],
              item_type: row[1],
              parent_id: row[3],
              status: row[4],
              completed_on: row[13] ?? null,
              due_at: row[6],
              rollup_estimate_minutes: rollupTotals?.totalEstimate ?? row[8],
              rollup_actual_minutes: rollupTotals?.totalActual ?? (timeMap.get(id) ?? 0),
              rollup_remaining_minutes:
                rollupTotals
                  ? Math.max(0, rollupTotals.totalEstimate - rollupTotals.totalActual)
                  : Math.max(0, (row[8] ?? 0) - (timeMap.get(id) ?? 0)),
              rollup_start_at: rollupTotals?.rollupStartAt ?? null,
              rollup_end_at: rollupTotals?.rollupEndAt ?? null,
              rollup_blocked_count: rollupTotals?.rollupBlockedCount ?? 0,
              rollup_overdue_count: rollupTotals?.rollupOverdueCount ?? 0,
              estimate_mode: row[7],
              estimate_minutes: row[8],
              actual_minutes: timeMap.get(id) ?? null,
              scheduled_blocks: blocks,
              dependencies_out: depsOut,
              dependencies_in: depsIn,
              blocked_by: blockedBy,
              blocking,
              slack_minutes: slackMinutes,
              assignee_id: assigneeId,
              assignee_name: assigneeName,
            };
          });

          result = { ok: true, result: items };
          break;
        }
        case "execution_window": {
          const timeMin = ensureTimeMs(args.time_min, "time_min");
          const timeMax = ensureTimeMs(args.time_max, "time_max");
          if (timeMax <= timeMin) {
            throw new Error("time_max must be greater than time_min");
          }

          const { scopeProjectId, scopeUserId } = resolveScopeArgs(
            args as Record<string, unknown>
          );
          const itemIds = getScopeItemIds(
            dbHandle,
            scopeProjectId,
            scopeUserId
          );
          if (itemIds.length === 0) {
            result = {
              ok: true,
              result: {
                scheduled: [],
                actionable_now: [],
                unscheduled_ready: [],
                meta: {
                  scheduled_total: 0,
                  actionable_total: 0,
                  unscheduled_total: 0,
                  truncated: {
                    scheduled: false,
                    actionable_now: false,
                    unscheduled_ready: false,
                  },
                },
              },
            };
            break;
          }

          const placeholders = buildPlaceholders(itemIds.length);
          const itemRows = dbHandle.exec({
            sql: `SELECT id, title, status, priority, due_at, parent_id, type, updated_at
              FROM items
              WHERE id IN (${placeholders});`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: itemIds,
          }) as Array<
            [
              string,
              string,
              string,
              number,
              number | null,
              string | null,
              string,
              number
            ]
          >;
          const itemMap = new Map(itemRows.map((row) => [row[0], row]));
          const scheduleMap = getScheduleSummaryMap(dbHandle, itemIds);
          const blockedMap = getBlockedStatusMap(dbHandle, itemIds);
          const dependentsMap = getDependentsCountMap(dbHandle, itemIds);
          const assigneesMap = getAssigneesMap(dbHandle, itemIds);
          const userNameMap = getUserMap(dbHandle);
          const hierarchyRows = getHierarchyRows(dbHandle);
          const { projectMap } = buildHierarchyMaps(
            hierarchyRows.map((row) => [row[0], row[1], row[2]]),
            null
          );
          const projectTitleMap = new Map(
            hierarchyRows
              .filter((row) => row[1] === "project")
              .map((row) => [row[0], row[3]])
          );

          const limitArgs =
            typeof args.limits === "object" && args.limits !== null
              ? (args.limits as Record<string, unknown>)
              : {};
          const parseLimit = (value: unknown, fallback: number) => {
            if (typeof value !== "number") {
              return fallback;
            }
            const intValue = Math.floor(value);
            if (!Number.isFinite(intValue) || intValue <= 0) {
              return fallback;
            }
            return Math.min(intValue, 50);
          };
          const scheduledMax = parseLimit(limitArgs.scheduled_max, 12);
          const actionableMax = parseLimit(limitArgs.actionable_max, 8);
          const unscheduledMax = parseLimit(
            limitArgs.unscheduled_max,
            Math.max(actionableMax * 2, 16)
          );
          const nextUpHoursRaw = parseLimit(limitArgs.next_up_hours, 12);
          const nextUpHours = Math.min(Math.max(nextUpHoursRaw, 1), 168);

          const nowAt =
            args.now_at !== undefined ? ensureTimeMs(args.now_at, "now_at") : Date.now();
          const nextUpEnd = nowAt + nextUpHours * 60 * 60 * 1000;

          const blockRows = dbHandle.exec({
            sql: `SELECT block_id, item_id, start_at, duration_minutes
              FROM scheduled_blocks
              WHERE item_id IN (${placeholders})
                AND start_at < ?
                AND (start_at + duration_minutes * 60000) > ?
              ORDER BY start_at ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: [...itemIds, timeMax, timeMin],
          }) as Array<[string, string, number, number]>;

          const blocksInWindow = new Set<string>();
          const blockInfoByItem = new Map<
            string,
            { hasActive: boolean; hasUpcoming: boolean }
          >();

          const scheduledCandidates = blockRows.map((row) => {
            const endAt =
              deriveEndAtFromDuration(row[2], row[3]) ?? row[2];
            const active = row[2] <= nowAt && endAt > nowAt;
            const upcoming = row[2] >= nowAt && row[2] < nextUpEnd;
            const info = blockInfoByItem.get(row[1]) ?? {
              hasActive: false,
              hasUpcoming: false,
            };
            if (active) {
              info.hasActive = true;
            }
            if (upcoming) {
              info.hasUpcoming = true;
            }
            blockInfoByItem.set(row[1], info);
            blocksInWindow.add(row[1]);
            const item = itemMap.get(row[1]);
            const assigneeId = (assigneesMap.get(row[1]) ?? [])[0] ?? null;
            const projectId = projectMap.get(row[1]) ?? row[1];
            const bucket = active ? 0 : upcoming ? 1 : 2;
            return {
              block_id: row[0],
              item_id: row[1],
              title: item?.[1] ?? row[1],
              start_at: row[2],
              duration_minutes: row[3],
              end_at: endAt,
              due_at: item?.[4] ?? null,
              status: item?.[2] ?? "unknown",
              priority: item?.[3] ?? 0,
              project_id: projectId,
              project_title: projectTitleMap.get(projectId) ?? null,
              assignee_id: assigneeId,
              assignee_name: assigneeId
                ? getUserDisplayName(assigneeId, userNameMap)
                : null,
              _bucket: bucket,
            };
          });

          scheduledCandidates.sort((a, b) => {
            if (a._bucket !== b._bucket) {
              return a._bucket - b._bucket;
            }
            if (a.start_at !== b.start_at) {
              return a.start_at - b.start_at;
            }
            return a.title.localeCompare(b.title);
          });

          const scheduled = scheduledCandidates.slice(0, scheduledMax).map(
            ({ _bucket, ...entry }) => entry
          );

          const dueMetricsMap = new Map(
            itemRows.map((row) => [row[0], computeDueMetrics(row[4], nowAt, row[2])])
          );
          const readyStatuses = new Set(["ready", "in_progress", "review"]);
          const actionableCandidates = itemRows
            .filter((row) => {
              if (row[2] === "done" || row[2] === "canceled") {
                return false;
              }
              if (!readyStatuses.has(row[2])) {
                return false;
              }
              const blocked = blockedMap.get(row[0]);
              if (blocked?.is_blocked) {
                return false;
              }
              const info = blockInfoByItem.get(row[0]);
              if (info?.hasActive || info?.hasUpcoming) {
                return false;
              }
              return true;
            })
            .map((row) => {
              const schedule = scheduleMap.get(row[0]);
              const slackMinutes = computeSlackMinutes(
                row[4],
                schedule?.end ?? null
              );
              const projectId = projectMap.get(row[0]) ?? row[0];
              const assigneeId = (assigneesMap.get(row[0]) ?? [])[0] ?? null;
              return {
                item_id: row[0],
                title: row[1],
                due_at: row[4],
                status: row[2],
                priority: row[3],
                slack_minutes: slackMinutes,
                planned_start_at: schedule?.start ?? null,
                planned_end_at: schedule?.end ?? null,
                project_id: projectId,
                project_title: projectTitleMap.get(projectId) ?? null,
                assignee_id: assigneeId,
                assignee_name: assigneeId
                  ? getUserDisplayName(assigneeId, userNameMap)
                  : null,
                _slackSort:
                  slackMinutes === null ? Number.POSITIVE_INFINITY : slackMinutes,
                _dueSort: row[4] ?? Number.POSITIVE_INFINITY,
                _prioritySort: -row[3],
                _plannedStartSort:
                  schedule?.start ?? Number.POSITIVE_INFINITY,
              };
            });

          const compareActionable = (
            a: typeof actionableCandidates[number],
            b: typeof actionableCandidates[number]
          ) => {
            if (a._slackSort !== b._slackSort) {
              return a._slackSort - b._slackSort;
            }
            if (a._dueSort !== b._dueSort) {
              return a._dueSort - b._dueSort;
            }
            if (a._prioritySort !== b._prioritySort) {
              return a._prioritySort - b._prioritySort;
            }
            if (a._plannedStartSort !== b._plannedStartSort) {
              return a._plannedStartSort - b._plannedStartSort;
            }
            return a.title.localeCompare(b.title);
          };

          actionableCandidates.sort(compareActionable);
          const actionableNow = actionableCandidates
            .slice(0, actionableMax)
            .map(({ _slackSort, _dueSort, _prioritySort, _plannedStartSort, ...entry }) => entry);

          const actionableNowIds = new Set(
            actionableNow.map((entry) => entry.item_id)
          );
          const unscheduledCandidates = actionableCandidates.filter(
            (entry) =>
              !blocksInWindow.has(entry.item_id) &&
              !actionableNowIds.has(entry.item_id)
          );

          const unscheduledReady = unscheduledCandidates
            .map((entry) => {
              const dueMetrics = dueMetricsMap.get(entry.item_id);
              const dependents = dependentsMap.get(entry.item_id) ?? 0;
              const sequenceRank = computeSequenceRank({
                is_overdue: dueMetrics?.is_overdue ?? false,
                is_blocked: false,
                due_at: entry.due_at ?? null,
                priority: entry.priority,
                dependents,
              });
              return {
                ...entry,
                sequence_rank: sequenceRank,
              };
            })
            .sort((a, b) => {
              if (a.sequence_rank !== b.sequence_rank) {
                return a.sequence_rank - b.sequence_rank;
              }
              return compareActionable(a, b);
            })
            .slice(0, unscheduledMax)
            .map(({ _slackSort, _dueSort, _prioritySort, _plannedStartSort, ...entry }) => entry);

          result = {
            ok: true,
            result: {
              scheduled,
              actionable_now: actionableNow,
              unscheduled_ready: unscheduledReady,
              meta: {
                scheduled_total: scheduledCandidates.length,
                actionable_total: actionableCandidates.length,
                unscheduled_total: unscheduledCandidates.length,
                truncated: {
                  scheduled: scheduledCandidates.length > scheduledMax,
                  actionable_now: actionableCandidates.length > actionableMax,
                  unscheduled_ready: unscheduledCandidates.length > unscheduledMax,
                },
              },
            },
          };
          break;
        }
        case "blocked_view": {
          const { scopeProjectId, scopeUserId } = resolveScopeArgs(
            args as Record<string, unknown>
          );
          const timeMin =
            args.time_min !== undefined ? ensureTimeMs(args.time_min, "time_min") : null;
          const timeMax =
            args.time_max !== undefined ? ensureTimeMs(args.time_max, "time_max") : null;
          if (timeMin !== null && timeMax !== null && timeMax <= timeMin) {
            throw new Error("time_max must be greater than time_min");
          }

          const itemIds = getScopeItemIds(
            dbHandle,
            scopeProjectId,
            scopeUserId
          );
          if (itemIds.length === 0) {
            result = {
              ok: true,
              result: {
                blocked_by_dependencies: [],
                blocked_by_blockers: [],
                scheduled_but_blocked: [],
              },
            };
            break;
          }

          const placeholders = buildPlaceholders(itemIds.length);
          const itemRows = dbHandle.exec({
            sql: `SELECT id, title, status, priority, due_at, parent_id, type, updated_at
              FROM items
              WHERE id IN (${placeholders});`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: itemIds,
          }) as Array<
            [
              string,
              string,
              string,
              number,
              number | null,
              string | null,
              string,
              number
            ]
          >;
          const itemMap = new Map(itemRows.map((row) => [row[0], row]));
          const scheduleMap = getScheduleSummaryMap(dbHandle, itemIds);
          const blockedMap = getBlockedStatusMap(dbHandle, itemIds);
          const unmetDepMap = getUnmetDependencyMap(dbHandle, itemIds);
          const activeBlockerCountMap = getActiveBlockerCountMap(
            dbHandle,
            itemIds
          );
          const assigneesMap = getAssigneesMap(dbHandle, itemIds);
          const userNameMap = getUserMap(dbHandle);
          const hierarchyRows = getHierarchyRows(dbHandle);
          const { projectMap } = buildHierarchyMaps(
            hierarchyRows.map((row) => [row[0], row[1], row[2]]),
            null
          );
          const projectTitleMap = new Map(
            hierarchyRows
              .filter((row) => row[1] === "project")
              .map((row) => [row[0], row[3]])
          );

          const blockRows =
            timeMin !== null && timeMax !== null
              ? (dbHandle.exec({
                  sql: `SELECT block_id, item_id, start_at, duration_minutes
                    FROM scheduled_blocks
                    WHERE item_id IN (${placeholders})
                      AND start_at < ?
                      AND (start_at + duration_minutes * 60000) > ?
                    ORDER BY start_at ASC;`,
                  rowMode: "array",
                  returnValue: "resultRows",
                  bind: [...itemIds, timeMax, timeMin],
                }) as Array<[string, string, number, number]>)
              : [];
          const blockMap = new Map<
            string,
            { block_id: string; start_at: number; duration_minutes: number }
          >();
          for (const row of blockRows) {
            if (!blockMap.has(row[1])) {
              blockMap.set(row[1], {
                block_id: row[0],
                start_at: row[2],
                duration_minutes: row[3],
              });
            }
          }

          const blockedByDeps = [];
          const blockedByBlockers = [];
          const scheduledButBlocked = [];

          for (const row of itemRows) {
            const blocked = blockedMap.get(row[0]);
            if (!blocked?.is_blocked) {
              continue;
            }
            const schedule = scheduleMap.get(row[0]) ?? {
              start: null,
              end: null,
            };
            const slackMinutes = computeSlackMinutes(row[4], schedule.end ?? null);
            const projectId = projectMap.get(row[0]) ?? row[0];
            const assigneeId = (assigneesMap.get(row[0]) ?? [])[0] ?? null;
            const assigneeName = assigneeId
              ? getUserDisplayName(assigneeId, userNameMap)
              : null;
            const baseEntry = {
              item_id: row[0],
              title: row[1],
              status: row[2],
              due_at: row[4],
              planned_start_at: schedule.start ?? null,
              planned_end_at: schedule.end ?? null,
              slack_minutes: slackMinutes,
              project_title: projectTitleMap.get(projectId) ?? null,
              assignee_name: assigneeName,
            };
            if (blocked.hasUnmetDep) {
              blockedByDeps.push({
                ...baseEntry,
                blocked_reason: "dependencies",
              });
            }
            if (blocked.hasBlocker) {
              blockedByBlockers.push({
                ...baseEntry,
                blocker_count: activeBlockerCountMap.get(row[0]) ?? 0,
              });
            }
            if (!blocked.hasUnmetDep && !blocked.hasBlocker && row[2] === "blocked") {
              blockedByDeps.push({
                ...baseEntry,
                blocked_reason: "status",
              });
            }
            const hasBlockInWindow = blockMap.has(row[0]);
            const hasAnyBlock = schedule.end !== null;
            if ((timeMin !== null && timeMax !== null && hasBlockInWindow) ||
                (timeMin === null && timeMax === null && hasAnyBlock)) {
              const block = blockMap.get(row[0]);
              const reason = blocked.hasUnmetDep && blocked.hasBlocker
                ? "both"
                : blocked.hasUnmetDep
                  ? "dependencies"
                  : blocked.hasBlocker
                    ? "blockers"
                    : "status";
            scheduledButBlocked.push({
              item_id: row[0],
              title: row[1],
              status: row[2],
              block_id: block?.block_id ?? null,
              start_at: block?.start_at ?? null,
              duration_minutes: block?.duration_minutes ?? null,
              blocked_reason: reason,
              due_at: row[4],
                project_title: projectTitleMap.get(projectId) ?? null,
              });
            }
          }

          result = {
            ok: true,
            result: {
              blocked_by_dependencies: blockedByDeps,
              blocked_by_blockers: blockedByBlockers,
              scheduled_but_blocked: scheduledButBlocked,
            },
          };
          break;
        }
        case "due_overdue": {
          const nowAt = ensureTimeMs(args.now_at, "now_at");
          const dueSoonDays = ensureNonNegativeInteger(
            args.due_soon_days,
            "due_soon_days"
          );
          const dayMs = 24 * 60 * 60 * 1000;
          const dueSoonEnd = nowAt + dueSoonDays * dayMs;

          const { scopeProjectId, scopeUserId } = resolveScopeArgs(
            args as Record<string, unknown>
          );
          const itemIds = getScopeItemIds(
            dbHandle,
            scopeProjectId,
            scopeUserId
          );
          if (itemIds.length === 0) {
            result = {
              ok: true,
              result: { due_soon: [], overdue: [], projects: [] },
            };
            break;
          }

          const placeholders = buildPlaceholders(itemIds.length);
          const itemRows = dbHandle.exec({
            sql: `SELECT id, title, status, due_at, parent_id, type, priority
              FROM items
              WHERE id IN (${placeholders});`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: itemIds,
          }) as Array<
            [
              string,
              string,
              string,
              number | null,
              string | null,
              string,
              number
            ]
          >;

          const scheduleMap = getScheduleSummaryMap(dbHandle, itemIds);
          const assigneesMap = getAssigneesMap(dbHandle, itemIds);
          const userNameMap = getUserMap(dbHandle);
          const hierarchyRows = getHierarchyRows(dbHandle);
          const { projectMap } = buildHierarchyMaps(
            hierarchyRows.map((row) => [row[0], row[1], row[2]]),
            null
          );
          const projectTitleMap = new Map(
            hierarchyRows
              .filter((row) => row[1] === "project")
              .map((row) => [row[0], row[3]])
          );

          const dueSoon = [];
          const overdue = [];
          const projects = [];

          for (const row of itemRows) {
            if (row[2] === "done" || row[2] === "canceled") {
              continue;
            }
            const dueAt = row[3];
            const schedule = scheduleMap.get(row[0]) ?? {
              start: null,
              end: null,
            };
            const slackMinutes = computeSlackMinutes(dueAt, schedule.end ?? null);
            const projectId = projectMap.get(row[0]) ?? row[0];
            const assigneeId = (assigneesMap.get(row[0]) ?? [])[0] ?? null;
            const assigneeName = assigneeId
              ? getUserDisplayName(assigneeId, userNameMap)
              : null;

            if (row[5] === "project") {
              if (dueAt !== null) {
                const metrics = computeDueMetrics(dueAt, nowAt, row[2]);
                projects.push({
                  project_id: row[0],
                  title: row[1],
                  due_at: dueAt,
                  days_until_due_or_overdue: metrics.is_overdue
                    ? -metrics.days_overdue
                    : metrics.days_until_due,
                });
              }
              continue;
            }

            if (dueAt === null) {
              continue;
            }

            const metrics = computeDueMetrics(dueAt, nowAt, row[2]);
            const entry = {
              item_id: row[0],
              title: row[1],
              status: row[2],
              due_at: dueAt,
              planned_end_at: schedule.end ?? null,
              slack_minutes: slackMinutes,
              project_title: projectTitleMap.get(projectId) ?? null,
              assignee_name: assigneeName,
            };
            if (dueAt >= nowAt && dueAt <= dueSoonEnd) {
              dueSoon.push({
                ...entry,
                days_until_due: metrics.days_until_due,
              });
            } else if (dueAt < nowAt) {
              overdue.push({
                ...entry,
                days_overdue: metrics.days_overdue,
              });
            }
          }

          dueSoon.sort((a, b) => a.due_at - b.due_at);
          overdue.sort((a, b) => a.due_at - b.due_at);
          projects.sort((a, b) => {
            const aDue = a.due_at ?? Number.POSITIVE_INFINITY;
            const bDue = b.due_at ?? Number.POSITIVE_INFINITY;
            return aDue - bDue;
          });

          result = {
            ok: true,
            result: {
              due_soon: dueSoon,
              overdue,
              projects,
            },
          };
          break;
        }
        case "contributions_range": {
          const { scopeProjectId, scopeUserId } = resolveScopeArgs(
            args as Record<string, unknown>
          );
          const dayStart = parseLocalDayStart(
            args.day_start_local,
            "day_start_local"
          );
          const dayCountRaw = ensurePositiveInteger(args.day_count, "day_count");
          const dayCount = Math.min(dayCountRaw, 730);
          const endMs = dayStart + dayCount * DAY_MS;
          const includeSubtasks = args.includeSubtasks !== false;
          const includeMilestones = args.includeMilestones === true;
          const includeProjects = args.includeProjects === true;

          const itemIds = getScopeItemIds(
            dbHandle,
            scopeProjectId,
            scopeUserId
          );

          const dayCounts = new Array<number>(dayCount).fill(0);
          if (itemIds.length > 0) {
            const placeholders = buildPlaceholders(itemIds.length);
            const rows = dbHandle.exec({
              sql: `SELECT id, type, parent_id, completed_at
                FROM items
                WHERE id IN (${placeholders})
                  AND completed_at IS NOT NULL
                  AND completed_at >= ?
                  AND completed_at < ?;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: [...itemIds, dayStart, endMs],
            }) as Array<[string, string, string | null, number]>;

            const hierarchyRows = getHierarchyRows(dbHandle);
            const parentTypeMap = new Map(
              hierarchyRows.map((row) => [row[0], row[1]])
            );

            for (const row of rows) {
              const type = row[1];
              const parentId = row[2];
              if (type === "project" && !includeProjects) {
                continue;
              }
              if (type === "milestone" && !includeMilestones) {
                continue;
              }
              if (type === "task" && !includeSubtasks) {
                const parentType = parentId ? parentTypeMap.get(parentId) : null;
                if (parentType === "task") {
                  continue;
                }
              }
              const completedAt = row[3];
              const dayIndex = Math.floor((completedAt - dayStart) / DAY_MS);
              if (dayIndex < 0 || dayIndex >= dayCount) {
                continue;
              }
              dayCounts[dayIndex] += 1;
            }
          }

          let maxCount = 0;
          const days = [];
          for (let i = 0; i < dayCount; i += 1) {
            const date = new Date(dayStart + i * DAY_MS);
            const count = dayCounts[i] ?? 0;
            if (count > maxCount) {
              maxCount = count;
            }
            days.push({ day: formatLocalDay(date), completed_count: count });
          }

          result = {
            ok: true,
            result: {
              days,
              meta: { max_count: maxCount },
            },
          };
          break;
        }
        case "kanban_view": {
          const { scopeProjectId, scopeUserId } = resolveScopeArgs(
            args as Record<string, unknown>
          );
          const includeCompleted =
            typeof args.includeCompleted === "boolean"
              ? args.includeCompleted
              : false;
          const showCanceled =
            typeof args.showCanceled === "boolean" ? args.showCanceled : false;
          const swimlaneMode =
            typeof args.swimlaneMode === "string" ? args.swimlaneMode : "none";

          let hierarchyRows: Array<[string, string, string | null, string]> = [];
          let taskRows: Array<
            [
              string,
              string,
              string,
              string | null,
              string,
              number,
              number | null,
              string,
              number
            ]
          > = [];

          if (scopeProjectId) {
            hierarchyRows = dbHandle.exec({
              sql: `WITH RECURSIVE tree AS (
                SELECT id, type, title, parent_id FROM items WHERE id = ?
                UNION ALL
                SELECT i.id, i.type, i.title, i.parent_id
                FROM items i JOIN tree t ON i.parent_id = t.id
              )
              SELECT id, type, parent_id, title FROM tree;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: [scopeProjectId],
            }) as Array<[string, string, string | null, string]>;

            if (scopeUserId) {
              taskRows = dbHandle.exec({
                sql: `WITH RECURSIVE tree AS (
                  SELECT * FROM items WHERE id = ?
                  UNION ALL
                  SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
                )
                SELECT i.id, i.type, i.title, i.parent_id, i.status, i.priority,
                  i.due_at, i.health, i.updated_at
                FROM tree i
                JOIN item_assignees a ON a.item_id = i.id
                WHERE i.type = 'task' AND a.assignee_id = ?
                ORDER BY i.updated_at DESC;`,
                rowMode: "array",
                returnValue: "resultRows",
                bind: [scopeProjectId, scopeUserId],
              }) as Array<
                [
                  string,
                  string,
                  string,
                  string | null,
                  string,
                  number,
                  number | null,
                  string,
                  number
                ]
              >;
            } else {
              taskRows = dbHandle.exec({
                sql: `WITH RECURSIVE tree AS (
                  SELECT * FROM items WHERE id = ?
                  UNION ALL
                  SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
                )
                SELECT id, type, title, parent_id, status, priority,
                  due_at, health, updated_at
                FROM tree
                WHERE type = 'task'
                ORDER BY updated_at DESC;`,
                rowMode: "array",
                returnValue: "resultRows",
                bind: [scopeProjectId],
              }) as Array<
                [
                  string,
                  string,
                  string,
                  string | null,
                  string,
                  number,
                  number | null,
                  string,
                  number
                ]
              >;
            }
          } else {
            hierarchyRows = dbHandle.exec({
              sql: "SELECT id, type, parent_id, title FROM items;",
              rowMode: "array",
              returnValue: "resultRows",
            }) as Array<[string, string, string | null, string]>;

            if (scopeUserId) {
              taskRows = dbHandle.exec({
                sql: `SELECT i.id, i.type, i.title, i.parent_id, i.status,
                  i.priority, i.due_at, i.health, i.updated_at
                FROM items i
                JOIN item_assignees a ON a.item_id = i.id
                WHERE i.type = 'task' AND a.assignee_id = ?
                ORDER BY i.updated_at DESC;`,
                rowMode: "array",
                returnValue: "resultRows",
                bind: [scopeUserId],
              }) as Array<
                [
                  string,
                  string,
                  string,
                  string | null,
                  string,
                  number,
                  number | null,
                  string,
                  number
                ]
              >;
            } else {
              taskRows = dbHandle.exec({
                sql: `SELECT id, type, title, parent_id, status,
                  priority, due_at, health, updated_at
                FROM items
                WHERE type = 'task'
                ORDER BY updated_at DESC;`,
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
                  number | null,
                  string,
                  number
                ]
              >;
            }
          }

          const hierarchyMapRows = hierarchyRows.map((row) => [
            row[0],
            row[1],
            row[2],
          ]) as Array<[string, string, string | null]>;
          const { projectMap } = buildHierarchyMaps(
            hierarchyMapRows,
            scopeProjectId
          );
          const projectTitleMap = new Map<string, string>();
          for (const row of hierarchyRows) {
            if (row[1] === "project") {
              projectTitleMap.set(row[0], row[3]);
            }
          }

          const filteredTasks = taskRows.filter((row) => {
            const status = row[4] || "backlog";
            if (!includeCompleted && status === "done") {
              return false;
            }
            if (!showCanceled && status === "canceled") {
              return false;
            }
            return true;
          });
          const taskIds = filteredTasks.map((row) => row[0]);
          const scheduleMap = getScheduleSummaryMap(dbHandle, taskIds);
          const assigneesMap = getAssigneesMap(dbHandle, taskIds);
          const userNameMap = getUserMap(dbHandle);

          type CardItem = {
            id: string;
            title: string;
            status: string;
            priority: number;
            due_at: number | null;
            planned_start_at: number | null;
            planned_end_at: number | null;
            assignee_id: string | null;
            assignee_name: string | null;
            project_id: string | null;
            project_title: string | null;
            parent_id: string | null;
            health: string;
          };

          const cards = filteredTasks.map((row) => {
            const status = row[4] || "backlog";
            const schedule = scheduleMap.get(row[0]) ?? {
              start: null,
              end: null,
            };
            const assigneeId = (assigneesMap.get(row[0]) ?? [])[0] ?? null;
            const projectId = projectMap.get(row[0]) ?? null;
            return {
              id: row[0],
              title: row[2],
              status,
              priority: Number(row[5]) || 0,
              due_at: row[6],
              planned_start_at: schedule.start,
              planned_end_at: schedule.end,
              assignee_id: assigneeId,
              assignee_name: assigneeId
                ? getUserDisplayName(assigneeId, userNameMap)
                : null,
              project_id: projectId,
              project_title: projectId
                ? projectTitleMap.get(projectId) ?? "Project"
                : null,
              parent_id: row[3],
              health: row[7] ?? "unknown",
            } as CardItem;
          });

          const statuses = [
            "backlog",
            "ready",
            "in_progress",
            "blocked",
            "review",
            "done",
          ];
          if (showCanceled) {
            statuses.push("canceled");
          }

          const createLane = (laneId: string, laneTitle: string) => {
            const columns: Record<string, CardItem[]> = {};
            for (const status of statuses) {
              columns[status] = [];
            }
            return {
              lane_id: laneId,
              lane_title: laneTitle,
              columns,
            };
          };

          const lanesMap = new Map<string, ReturnType<typeof createLane>>();
          const laneOrder: string[] = [];

          const getLaneKey = (card: CardItem) => {
            if (swimlaneMode === "assignee") {
              return card.assignee_id ?? "unassigned";
            }
            if (swimlaneMode === "project") {
              return card.project_id ?? "no_project";
            }
            if (swimlaneMode === "health") {
              return card.health ?? "unknown";
            }
            return "all";
          };

          const getLaneTitle = (card: CardItem, laneKey: string) => {
            if (swimlaneMode === "assignee") {
              if (laneKey === "unassigned") {
                return "Unassigned";
              }
              return card.assignee_name ?? laneKey;
            }
            if (swimlaneMode === "project") {
              return card.project_title ?? "No project";
            }
            if (swimlaneMode === "health") {
              return laneKey
                .split("_")
                .map((part) => part[0]?.toUpperCase() + part.slice(1))
                .join(" ");
            }
            return "All";
          };

          for (const card of cards) {
            const laneKey = getLaneKey(card);
            if (!lanesMap.has(laneKey)) {
              const laneTitle = getLaneTitle(card, laneKey);
              lanesMap.set(laneKey, createLane(laneKey, laneTitle));
              laneOrder.push(laneKey);
            }
            const lane = lanesMap.get(laneKey)!;
            const column = lane.columns[card.status] ?? lane.columns.backlog;
            column.push(card);
          }

          const sortColumn = (list: CardItem[]) =>
            list.sort((a, b) => {
              if (a.priority !== b.priority) {
                return b.priority - a.priority;
              }
              const aDue = a.due_at ?? Number.MAX_SAFE_INTEGER;
              const bDue = b.due_at ?? Number.MAX_SAFE_INTEGER;
              if (aDue !== bDue) {
                return aDue - bDue;
              }
              const aPlan = a.planned_start_at ?? Number.MAX_SAFE_INTEGER;
              const bPlan = b.planned_start_at ?? Number.MAX_SAFE_INTEGER;
              if (aPlan !== bPlan) {
                return aPlan - bPlan;
              }
              return a.title.localeCompare(b.title);
            });

          for (const lane of lanesMap.values()) {
            for (const status of statuses) {
              sortColumn(lane.columns[status]);
            }
          }

          let lanes = laneOrder.map((id) => lanesMap.get(id)!);
          if (swimlaneMode === "assignee") {
            const unassigned = lanes.find((lane) => lane.lane_id === "unassigned");
            const rest = lanes
              .filter((lane) => lane.lane_id !== "unassigned")
              .sort((a, b) => a.lane_title.localeCompare(b.lane_title));
            lanes = unassigned ? [unassigned, ...rest] : rest;
          } else if (swimlaneMode === "project") {
            lanes = lanes.sort((a, b) => a.lane_title.localeCompare(b.lane_title));
          } else if (swimlaneMode === "health") {
            const order = ["behind", "at_risk", "on_track", "ahead", "unknown"];
            lanes = lanes.sort(
              (a, b) =>
                order.indexOf(a.lane_id) - order.indexOf(b.lane_id)
            );
          }

          if (lanes.length === 0) {
            lanes = [createLane("all", "All")];
          }

          result = {
            ok: true,
            result: {
              lanes,
            },
          };
          break;
        }
        case "searchItems": {
          const rawQuery = typeof args.q === "string" ? args.q : "";
          const normalized = rawQuery.trim().toLowerCase();
          if (!normalized) {
            result = { ok: true, result: { items: [] } };
            break;
          }
          const requestedLimit =
            typeof args.limit === "number" ? Math.floor(args.limit) : 12;
          const limit = Math.min(Math.max(requestedLimit, 1), 50);
          const fetchLimit = Math.min(limit * 4, 200);
          const scopeId = typeof args.scopeId === "string" ? args.scopeId : null;
          const escaped = escapeLike(normalized);
          const likePattern = `%${escaped}%`;
          const prefixPattern = `${escaped}%`;
          const prefixRows = dbHandle.exec({
            sql: `SELECT id, title, type, parent_id, status, due_at, completed_at, updated_at
              FROM items
              WHERE type != 'project'
                AND title LIKE ? ESCAPE '\\' COLLATE NOCASE
              ORDER BY LENGTH(title) ASC, updated_at DESC
              LIMIT ?;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: [prefixPattern, fetchLimit],
          }) as Array<
            [
              string,
              string,
              string,
              string | null,
              string,
              number | null,
              number | null,
              number
            ]
          >;

          let rows = prefixRows;
          if (rows.length < fetchLimit) {
            const remaining = fetchLimit - rows.length;
            const excludeIds = rows.map((row) => row[0]);
            const excludeClause =
              excludeIds.length > 0
                ? `AND id NOT IN (${buildPlaceholders(excludeIds.length)})`
                : "";
            const substringRows = dbHandle.exec({
              sql: `SELECT id, title, type, parent_id, status, due_at, completed_at, updated_at
                FROM items
                WHERE type != 'project'
                  AND title LIKE ? ESCAPE '\\' COLLATE NOCASE
                  ${excludeClause}
                ORDER BY LENGTH(title) ASC, updated_at DESC
                LIMIT ?;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind:
                excludeIds.length > 0
                  ? [likePattern, ...excludeIds, remaining]
                  : [likePattern, remaining],
            }) as Array<
              [
                string,
                string,
                string,
                string | null,
                string,
                number | null,
                number | null,
                number
              ]
            >;
            rows = rows.concat(substringRows);
          }

          if (rows.length === 0) {
            result = { ok: true, result: { items: [] } };
            break;
          }

          const hierarchyRows = dbHandle.exec({
            sql: "SELECT id, type, parent_id FROM items;",
            rowMode: "array",
            returnValue: "resultRows",
          }) as Array<[string, string, string | null]>;
          const { projectMap } = buildHierarchyMaps(hierarchyRows, null);
          let scopeProjectId: string | null = null;
          let scopeUngrouped = false;
          if (scopeId) {
            if (scopeId === UNGROUPED_PROJECT_ID) {
              scopeUngrouped = true;
            } else if (projectMap.has(scopeId)) {
              scopeProjectId = projectMap.get(scopeId) ?? null;
            }
          }

          const mapped = rows.map((row) => {
            const projectId = projectMap.get(row[0]) ?? row[0];
            const sameProject = scopeUngrouped
              ? row[3] === null
              : scopeProjectId
                ? projectId === scopeProjectId
                : false;
            const titleLower = row[1].toLowerCase();
            const matchRank = titleLower.startsWith(normalized) ? 0 : 1;
            return {
              id: row[0],
              title: row[1],
              item_type: row[2],
              parent_id: row[3],
              due_at: row[5],
              completed_at: row[4] === "done" ? row[6] : null,
              _matchRank: matchRank,
              _sameProject: sameProject,
              _titleLength: row[1].length,
              _updatedAt: row[7],
            };
          });

          mapped.sort((a, b) => {
            if (a._matchRank !== b._matchRank) {
              return a._matchRank - b._matchRank;
            }
            if ((scopeProjectId || scopeUngrouped) && a._sameProject !== b._sameProject) {
              return a._sameProject ? -1 : 1;
            }
            if (a._titleLength !== b._titleLength) {
              return a._titleLength - b._titleLength;
            }
            if (a._updatedAt !== b._updatedAt) {
              return b._updatedAt - a._updatedAt;
            }
            return a.title.localeCompare(b.title);
          });

          result = {
            ok: true,
            result: {
              items: mapped.slice(0, limit).map((item) => ({
                id: item.id,
                title: item.title,
                item_type: item.item_type,
                parent_id: item.parent_id,
                due_at: item.due_at,
                completed_at: item.completed_at,
              })),
            },
          };
          break;
        }
        case "listGantt": {
          const projectId =
            typeof args.projectId === "string" ? args.projectId : null;
          const rows = dbHandle.exec({
            sql: projectId
              ? `WITH RECURSIVE tree AS (
                  SELECT * FROM items WHERE id = ?
                  UNION ALL
                  SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
                )
                SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_mode, estimate_minutes, health, health_mode, notes
                FROM tree
                ORDER BY sort_order ASC, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, title ASC;`
              : `SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_mode, estimate_minutes, health, health_mode, notes
                FROM items
                ORDER BY sort_order ASC, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, title ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<
            [
              string,
              string,
              string,
              string | null,
              string,
              number,
              number | null,
              string,
              number,
              string,
              string,
              string | null
            ]
          >;
          const ids = rows.map((row) => row[0]);
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
          const rollupMap = computeRollupTotals(
            rows.map((row) => ({
              id: row[0],
              parent_id: row[3],
              estimate_minutes: row[8],
              estimate_mode: row[7],
            })),
            scheduleMap,
            blockedMap,
            dueMetricsMap,
            timeMap
          );
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
                  const rollupTotals = rollupMap.get(row[0]);
                  const blocked = blockedMap.get(row[0]) ?? {
                    hasBlocker: false,
                    hasUnmetDep: false,
                    is_blocked: false,
                  };
                  const unmetDeps = unmetDepMap.get(row[0]) ?? { count: 0, ids: [] };
                const rollupEstimate = rollupTotals?.totalEstimate ?? row[8];
                const rollupActual =
                  rollupTotals?.totalActual ?? (timeMap.get(row[0]) ?? 0);
                const rollupRemaining = Math.max(0, rollupEstimate - rollupActual);
                const rollupBlockedCount = rollupTotals?.rollupBlockedCount ?? 0;
                const rollupOverdueCount = rollupTotals?.rollupOverdueCount ?? 0;
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
                    row[1] === "task" ? schedule.start : rollupTotals?.rollupStartAt ?? null,
                  bar_end_at:
                    row[1] === "task" ? schedule.end : rollupTotals?.rollupEndAt ?? null,
                  rollup:
                    row[1] === "task"
                      ? undefined
                      : {
                          estimate_minutes: rollupEstimate,
                          actual_minutes: rollupActual,
                          remaining_minutes: rollupRemaining,
                          overdue_count: rollupOverdueCount,
                          blocked_count: rollupBlockedCount,
                          rollup_start_at: rollupTotals?.rollupStartAt ?? null,
                          rollup_end_at: rollupTotals?.rollupEndAt ?? null,
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
          const projectId =
            typeof args.projectId === "string" ? args.projectId : null;
          const assigneeId =
            typeof args.assigneeId === "string" ? args.assigneeId : null;
          const startAt = ensureNumber(args.startAt, "startAt");
          const endAt = ensureNumber(args.endAt, "endAt");
          const itemsRows = dbHandle.exec({
            sql: projectId
              ? `WITH RECURSIVE tree AS (
                  SELECT * FROM items WHERE id = ?
                  UNION ALL
                  SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
                )
                SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_mode, estimate_minutes, health, health_mode, notes
                FROM tree;`
              : `SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_mode, estimate_minutes, health, health_mode, notes
                FROM items;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<
            [
              string,
              string,
              string,
              string | null,
              string,
              number,
              number | null,
              string,
              number,
              string,
              string,
              string | null
            ]
          >;
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
          const dueMetricsMap = new Map(
            itemsRows.map((row) => [row[0], computeDueMetrics(row[6], now, row[4])])
          );
          const rollupMap = computeRollupTotals(
            itemsRows.map((row) => ({
              id: row[0],
              parent_id: row[3],
              estimate_minutes: row[8],
              estimate_mode: row[7],
            })),
            scheduleMap,
            blockedStatusMap,
            dueMetricsMap,
            timeMap
          );

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
            const dueMetrics = dueMetricsMap.get(row[0])!;
            const rollupTotals = rollupMap.get(row[0]);
            const actualMinutes = timeMap.get(row[0]) ?? 0;
            const rollupEstimate = rollupTotals?.totalEstimate ?? row[8];
            const rollupActual =
              rollupTotals?.totalActual ?? actualMinutes;
            const rollupRemaining = Math.max(0, rollupEstimate - rollupActual);
            const remainingMinutes =
              row[7] === "rollup"
                ? rollupRemaining
                : Math.max(0, row[8] - actualMinutes);
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
              estimate_minutes: row[8],
              estimate_mode: row[7],
              rollup_estimate_minutes: rollupEstimate,
              rollup_actual_minutes: rollupActual,
              rollup_remaining_minutes: rollupRemaining,
              rollup_start_at: rollupTotals?.rollupStartAt ?? null,
              rollup_end_at: rollupTotals?.rollupEndAt ?? null,
              rollup_blocked_count: rollupTotals?.rollupBlockedCount ?? 0,
              rollup_overdue_count: rollupTotals?.rollupOverdueCount ?? 0,
              notes: row[11],
              health: row[9],
              health_mode: row[10],
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
                  estimate_mode, estimate_minutes, health, health_mode, notes
                FROM tree
                ORDER BY sort_order ASC, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, title ASC;`
              : `SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_mode, estimate_minutes, health, health_mode, notes
                FROM items
                ORDER BY sort_order ASC, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, title ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<
            [
              string,
              string,
              string,
              string | null,
              string,
              number,
              number | null,
              string,
              number,
              string,
              string,
              string | null
            ]
          >;
          const ids = rows.map((row) => row[0]);
          const blockedMap = getBlockedStatusMap(dbHandle, ids);
          const scheduleMap = getScheduleSummaryMap(dbHandle, ids);
          const assigneesMap = getAssigneesMap(dbHandle, ids);
          const tagsMap = getTagsMap(dbHandle, ids);
          const unmetDepMap = getUnmetDependencyMap(dbHandle, ids);
          const activeBlockerIdsMap = getActiveBlockerIdsMap(dbHandle, ids);
          const activeBlockerCountMap = getActiveBlockerCountMap(dbHandle, ids);
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
          const now = Date.now();
          const dueMetricsMap = new Map(
            rows.map((row) => [row[0], computeDueMetrics(row[6], now, row[4])])
          );
          const rollupMap = computeRollupTotals(
            rows.map((row) => ({
              id: row[0],
              parent_id: row[3],
              estimate_minutes: row[8],
              estimate_mode: row[7],
            })),
            scheduleMap,
            blockedMap,
            dueMetricsMap,
            timeMap
          );
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
            const rollupTotals = rollupMap.get(row[0]);
            const rollupEstimate = rollupTotals?.totalEstimate ?? row[8];
            const rollupActual =
              rollupTotals?.totalActual ?? (timeMap.get(row[0]) ?? 0);
            const rollupRemaining = Math.max(0, rollupEstimate - rollupActual);
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
              estimate_minutes: row[8],
              rollup_estimate_minutes: rollupEstimate,
              rollup_actual_minutes: rollupActual,
              rollup_remaining_minutes: rollupRemaining,
              rollup_start_at: rollupTotals?.rollupStartAt ?? null,
              rollup_end_at: rollupTotals?.rollupEndAt ?? null,
              rollup_blocked_count: rollupTotals?.rollupBlockedCount ?? 0,
              rollup_overdue_count: rollupTotals?.rollupOverdueCount ?? 0,
              notes: row[11],
              health: row[9],
              health_mode: row[10],
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
                  estimate_mode, estimate_minutes, health, health_mode, notes
                FROM tree;`
              : `SELECT id, type, title, parent_id, status, priority, due_at,
                  estimate_mode, estimate_minutes, health, health_mode, notes
                FROM items;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: projectId ? [projectId] : undefined,
          }) as Array<
            [
              string,
              string,
              string,
              string | null,
              string,
              number,
              number | null,
              string,
              number,
              string,
              string,
              string | null
            ]
          >;
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
          const now = Date.now();
          const dueMetricsMap = new Map(
            rows.map((row) => [row[0], computeDueMetrics(row[6], now, row[4])])
          );
          const rollupMap = computeRollupTotals(
            rows.map((row) => ({
              id: row[0],
              parent_id: row[3],
              estimate_minutes: row[8],
              estimate_mode: row[7],
            })),
            scheduleMap,
            blockedMap,
            dueMetricsMap,
            timeMap
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
            const rollupTotals = rollupMap.get(row[0]);
            const rollupEstimate = rollupTotals?.totalEstimate ?? row[8];
            const rollupActual =
              rollupTotals?.totalActual ?? (timeMap.get(row[0]) ?? 0);
            const rollupRemaining = Math.max(0, rollupEstimate - rollupActual);
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
              estimate_minutes: row[8],
              rollup_estimate_minutes: rollupEstimate,
              rollup_actual_minutes: rollupActual,
              rollup_remaining_minutes: rollupRemaining,
              rollup_start_at: rollupTotals?.rollupStartAt ?? null,
              rollup_end_at: rollupTotals?.rollupEndAt ?? null,
              rollup_blocked_count: rollupTotals?.rollupBlockedCount ?? 0,
              rollup_overdue_count: rollupTotals?.rollupOverdueCount ?? 0,
              notes: row[11],
              health: row[9],
              health_mode: row[10],
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
          type AssigneeGroup = {
            assignee: { id: string; name: null } | null;
            items: typeof unassigned;
          };
          const resultGroups: AssigneeGroup[] = Array.from(groups.entries())
            .filter(([assigneeId]) => !assigneeFilter || assigneeId === assigneeFilter)
            .map(([assigneeId, items]) => ({
              assignee: { id: assigneeId, name: null },
              items,
            }));
          if (!assigneeFilter && includeUnassigned) {
            resultGroups.push({
              assignee: null,
              items: unassigned,
            });
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
            sql: "SELECT id, type, title, parent_id, status, priority, due_at FROM items WHERE due_at IS NOT NULL AND due_at < ? AND status NOT IN ('done', 'canceled') ORDER BY due_at ASC;",
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
            sql: "SELECT id, type, title, parent_id, status, priority, due_at FROM items WHERE due_at IS NOT NULL AND due_at >= ? AND due_at <= ? ORDER BY due_at ASC;",
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
          const startAt = ensureNumber(args.startAt, "startAt");
          const endAt = ensureNumber(args.endAt, "endAt");
          const rows = dbHandle.exec({
            sql: "SELECT block_id, item_id, start_at, duration_minutes, locked, source FROM scheduled_blocks WHERE start_at < ? AND (start_at + duration_minutes * 60000) > ? ORDER BY start_at ASC;",
            rowMode: "array",
            returnValue: "resultRows",
            bind: [endAt, startAt],
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
        case "calendar_range": {
          const timeMin = ensureTimeMs(args.time_min, "time_min");
          const timeMax = ensureTimeMs(args.time_max, "time_max");
          if (timeMax <= timeMin) {
            throw new Error("time_max must be greater than time_min");
          }
          const scopeProjectId =
            typeof args.scopeProjectId === "string" ? args.scopeProjectId : null;

          let scopedIds: string[] | null = null;
          if (scopeProjectId) {
            const treeRows = dbHandle.exec({
              sql: `WITH RECURSIVE tree AS (
                SELECT id FROM items WHERE id = ?
                UNION ALL
                SELECT i.id FROM items i JOIN tree t ON i.parent_id = t.id
              )
              SELECT id FROM tree;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: [scopeProjectId],
            }) as Array<[string]>;
            scopedIds = treeRows.map((row) => row[0]);
          }

          if (scopedIds && scopedIds.length === 0) {
            result = { ok: true, result: { blocks: [], items: [] } };
            break;
          }

          const blockSql = scopedIds
            ? `SELECT b.block_id, b.item_id, b.start_at, b.duration_minutes
                FROM scheduled_blocks b
                JOIN items i ON i.id = b.item_id
                WHERE i.archived_at IS NULL
                  AND b.start_at < ?
                  AND (b.start_at + b.duration_minutes * 60000) > ?
                  AND b.item_id IN (${buildPlaceholders(scopedIds.length)})
                ORDER BY b.start_at ASC;`
            : `SELECT b.block_id, b.item_id, b.start_at, b.duration_minutes
                FROM scheduled_blocks b
                JOIN items i ON i.id = b.item_id
                WHERE i.archived_at IS NULL
                  AND b.start_at < ?
                  AND (b.start_at + b.duration_minutes * 60000) > ?
                ORDER BY b.start_at ASC;`;

          const blockRows = dbHandle.exec({
            sql: blockSql,
            rowMode: "array",
            returnValue: "resultRows",
            bind: scopedIds ? [timeMax, timeMin, ...scopedIds] : [timeMax, timeMin],
          }) as Array<[string, string, number, number]>;

          const itemSql = scopedIds
            ? `SELECT id, title, status, due_at, parent_id, type, priority
                FROM items
                WHERE archived_at IS NULL
                  AND due_at IS NOT NULL
                  AND due_at >= ?
                  AND due_at < ?
                  AND id IN (${buildPlaceholders(scopedIds.length)})
                ORDER BY due_at ASC;`
            : `SELECT id, title, status, due_at, parent_id, type, priority
                FROM items
                WHERE archived_at IS NULL
                  AND due_at IS NOT NULL
                  AND due_at >= ?
                  AND due_at < ?
                ORDER BY due_at ASC;`;

          const itemRows = dbHandle.exec({
            sql: itemSql,
            rowMode: "array",
            returnValue: "resultRows",
            bind: scopedIds ? [timeMin, timeMax, ...scopedIds] : [timeMin, timeMax],
          }) as Array<
            [string, string, string, number, string | null, string, number]
          >;
          const itemIds = itemRows.map((row) => row[0]);
          const assigneesMap = getAssigneesMap(dbHandle, itemIds);
          const userNameMap = getUserMap(dbHandle);

          result = {
            ok: true,
            result: {
              blocks: blockRows.map((row) => ({
                block_id: row[0],
                item_id: row[1],
                start_at: row[2],
                duration_minutes: row[3],
              })),
              items: itemRows.map((row) => ({
                assignee_id: (assigneesMap.get(row[0]) ?? [])[0] ?? null,
                assignee_name: getUserDisplayName(
                  (assigneesMap.get(row[0]) ?? [])[0] ?? "",
                  userNameMap
                ),
                id: row[0],
                title: row[1],
                status: row[2],
                due_at: row[3],
                parent_id: row[4],
                item_type: row[5],
                priority: row[6],
              })),
            },
          };
          break;
        }
        case "gantt_range": {
          const timeMin = ensureTimeMs(args.time_min, "time_min");
          const timeMax = ensureTimeMs(args.time_max, "time_max");
          if (timeMax <= timeMin) {
            throw new Error("time_max must be greater than time_min");
          }
          const { scopeProjectId, scopeUserId } = resolveScopeArgs(
            args as Record<string, unknown>
          );
          const includeCompleted =
            typeof args.includeCompleted === "boolean"
              ? args.includeCompleted
              : false;

          const statusFilter = includeCompleted
            ? ""
            : "AND i.status NOT IN ('done','canceled')";

          let rows: Array<
            [
              string,
              string,
              string,
              string | null,
              string,
              number | null,
              string | null,
              number,
              number,
              number
            ]
          > = [];

          if (scopeProjectId) {
            if (scopeUserId) {
              rows = dbHandle.exec({
                sql: `WITH RECURSIVE tree AS (
                  SELECT * FROM items WHERE id = ?
                  UNION ALL
                  SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
                )
                SELECT i.id, i.type, i.title, i.parent_id, i.status, i.due_at,
                  i.estimate_mode, i.estimate_minutes, i.sort_order, i.updated_at
                FROM tree i
                JOIN item_assignees a ON a.item_id = i.id
                WHERE a.assignee_id = ?
                  ${statusFilter}
                ORDER BY i.sort_order ASC,
                  CASE WHEN i.due_at IS NULL THEN 1 ELSE 0 END,
                  i.due_at ASC,
                  i.title ASC;`,
                rowMode: "array",
                returnValue: "resultRows",
                bind: [scopeProjectId, scopeUserId],
              }) as Array<
                [
                  string,
                  string,
                  string,
                  string | null,
                  string,
                  number | null,
                  string | null,
                  number,
                  number,
                  number
                ]
              >;
            } else {
              rows = dbHandle.exec({
                sql: `WITH RECURSIVE tree AS (
                  SELECT * FROM items WHERE id = ?
                  UNION ALL
                  SELECT i.* FROM items i JOIN tree t ON i.parent_id = t.id
                )
                SELECT id, type, title, parent_id, status, due_at,
                  estimate_mode, estimate_minutes, sort_order, updated_at
                FROM tree i
                WHERE 1=1 ${statusFilter}
                ORDER BY i.sort_order ASC,
                  CASE WHEN i.due_at IS NULL THEN 1 ELSE 0 END,
                  i.due_at ASC,
                  i.title ASC;`,
                rowMode: "array",
                returnValue: "resultRows",
                bind: [scopeProjectId],
              }) as Array<
                [
                  string,
                  string,
                  string,
                  string | null,
                  string,
                  number | null,
                  string | null,
                  number,
                  number,
                  number
                ]
              >;
            }
          } else if (scopeUserId) {
            rows = dbHandle.exec({
              sql: `SELECT i.id, i.type, i.title, i.parent_id, i.status, i.due_at,
                  i.estimate_mode, i.estimate_minutes, i.sort_order, i.updated_at
                FROM items i
                JOIN item_assignees a ON a.item_id = i.id
                WHERE a.assignee_id = ?
                  ${statusFilter}
                ORDER BY i.sort_order ASC,
                  CASE WHEN i.due_at IS NULL THEN 1 ELSE 0 END,
                  i.due_at ASC,
                  i.title ASC;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: [scopeUserId],
            }) as Array<
              [
                string,
                string,
                string,
                string | null,
                string,
                number | null,
                string | null,
                number,
                number,
                number
              ]
            >;
          } else {
            rows = dbHandle.exec({
              sql: `SELECT id, type, title, parent_id, status, due_at,
                  estimate_mode, estimate_minutes, sort_order, updated_at
                FROM items i
                WHERE 1=1 ${statusFilter}
                ORDER BY i.sort_order ASC,
                  CASE WHEN i.due_at IS NULL THEN 1 ELSE 0 END,
                  i.due_at ASC,
                  i.title ASC;`,
              rowMode: "array",
              returnValue: "resultRows",
            }) as Array<
              [
                string,
                string,
                string,
                string | null,
                string,
                number | null,
                string | null,
                number,
                number,
                number
              ]
            >;
          }

          const ids = rows.map((row) => row[0]);
          if (ids.length === 0) {
            result = { ok: true, result: { items: [], blocks: [], edges: [] } };
            break;
          }

          const scheduleMap = getScheduleSummaryMap(dbHandle, ids);
          const blockedRawMap = getBlockedStatusMap(dbHandle, ids);
          const blockedMap = new Map(
            Array.from(blockedRawMap.entries()).map(([id, summary]) => [
              id,
              { is_blocked: summary.is_blocked },
            ])
          );
          const now = Date.now();
          const dueMetricsMap = new Map(
            rows.map((row) => [row[0], computeDueMetrics(row[5], now, row[4])])
          );
          const rollupMap = computeRollupTotals(
            rows.map((row) => ({
              id: row[0],
              parent_id: row[3],
              estimate_mode: row[6],
              estimate_minutes: row[7],
            })),
            scheduleMap,
            blockedMap,
            dueMetricsMap,
            new Map()
          );

          const placeholders = buildPlaceholders(ids.length);
          const blockRows = dbHandle.exec({
            sql: `SELECT block_id, item_id, start_at, duration_minutes
              FROM scheduled_blocks
              WHERE start_at < ?
                AND (start_at + duration_minutes * 60000) > ?
                AND item_id IN (${placeholders})
              ORDER BY start_at ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: [timeMax, timeMin, ...ids],
          }) as Array<[string, string, number, number]>;

          const edgeRows = dbHandle.exec({
            sql: `SELECT item_id, depends_on_id, type, lag_minutes
              FROM dependencies
              WHERE item_id IN (${placeholders})
                AND depends_on_id IN (${placeholders});`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: [...ids, ...ids],
          }) as Array<[string, string, string, number]>;

          const assigneesMap = getAssigneesMap(dbHandle, ids);
          const userNameMap = getUserMap(dbHandle);

          result = {
            ok: true,
            result: {
              items: rows.map((row) => {
                const schedule = scheduleMap.get(row[0]) ?? {
                  start: null,
                  end: null,
                };
                const rollupTotals = rollupMap.get(row[0]);
                const assigneeId = (assigneesMap.get(row[0]) ?? [])[0] ?? null;
                return {
                  id: row[0],
                  item_type: row[1],
                  title: row[2],
                  parent_id: row[3],
                  status: row[4],
                  due_at: row[5],
                  planned_start_at: schedule.start,
                  planned_end_at: schedule.end,
                  rollup_start_at: rollupTotals?.rollupStartAt ?? null,
                  rollup_end_at: rollupTotals?.rollupEndAt ?? null,
                  assignee_id: assigneeId,
                  assignee_name: getUserDisplayName(assigneeId ?? "", userNameMap),
                };
              }),
              blocks: blockRows.map((row) => ({
                block_id: row[0],
                item_id: row[1],
                start_at: row[2],
                duration_minutes: row[3],
              })),
              edges: edgeRows.map((row) => ({
                edge_id: `${row[0]}->${row[1]}`,
                predecessor_id: row[1],
                successor_id: row[0],
                type: row[2] ?? "FS",
                lag_minutes: row[3] ?? 0,
              })),
            },
          };
          break;
        }
        case "calendar_range_user": {
          const userId = ensureString(args.user_id, "user_id");
          const timeMin = ensureTimeMs(args.time_min, "time_min");
          const timeMax = ensureTimeMs(args.time_max, "time_max");
          if (timeMax <= timeMin) {
            throw new Error("time_max must be greater than time_min");
          }

          const blockRows = dbHandle.exec({
            sql: `SELECT b.block_id, b.item_id, b.start_at, b.duration_minutes
              FROM scheduled_blocks b
              JOIN item_assignees a ON a.item_id = b.item_id
              WHERE a.assignee_id = ?
                AND b.start_at < ?
                AND (b.start_at + b.duration_minutes * 60000) > ?
              ORDER BY b.start_at ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: [userId, timeMax, timeMin],
          }) as Array<[string, string, number, number]>;

          const dueRows = dbHandle.exec({
            sql: `SELECT i.id, i.title, i.status, i.due_at, i.parent_id, i.type, i.priority
              FROM items i
              JOIN item_assignees a ON a.item_id = i.id
              WHERE a.assignee_id = ?
                AND i.due_at IS NOT NULL
                AND i.due_at >= ?
                AND i.due_at < ?
              ORDER BY i.due_at ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: [userId, timeMin, timeMax],
          }) as Array<
            [string, string, string, number, string | null, string, number]
          >;

          const itemIds = new Set<string>();
          for (const row of blockRows) {
            itemIds.add(row[1]);
          }
          for (const row of dueRows) {
            itemIds.add(row[0]);
          }

          let itemRows: Array<
            [string, string, string, number | null, string | null, string, number]
          > = [];
          if (itemIds.size > 0) {
            const ids = Array.from(itemIds);
            const placeholders = buildPlaceholders(ids.length);
            itemRows = dbHandle.exec({
              sql: `SELECT id, title, status, due_at, parent_id, type, priority
                FROM items
                WHERE id IN (${placeholders})
                ORDER BY title ASC;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: ids,
            }) as Array<
              [string, string, string, number | null, string | null, string, number]
            >;
          }
          const userNameMap = getUserMap(dbHandle);
          const assigneeName = getUserDisplayName(userId, userNameMap);

          result = {
            ok: true,
            result: {
              blocks: blockRows.map((row) => ({
                block_id: row[0],
                item_id: row[1],
                start_at: row[2],
                duration_minutes: row[3],
              })),
              items: itemRows.map((row) => ({
                id: row[0],
                title: row[1],
                status: row[2],
                due_at: row[3],
                parent_id: row[4],
                item_type: row[5],
                priority: row[6],
                assignee_id: userId,
                assignee_name: assigneeName,
              })),
            },
          };
          break;
        }
        case "calendar_range_users": {
          const userIds = Array.from(
            new Set(
              ensureArray(args.user_ids, "user_ids").map((value, index) =>
                ensureString(value, `user_ids[${index}]`)
              )
            )
          );
          const timeMin = ensureTimeMs(args.time_min, "time_min");
          const timeMax = ensureTimeMs(args.time_max, "time_max");
          if (timeMax <= timeMin) {
            throw new Error("time_max must be greater than time_min");
          }
          if (userIds.length === 0) {
            result = { ok: true, result: { blocks: [], items: [] } };
            break;
          }

          const placeholders = buildPlaceholders(userIds.length);
          const blockRows = dbHandle.exec({
            sql: `SELECT DISTINCT
                b.block_id, b.item_id, b.start_at, b.duration_minutes, a.assignee_id
              FROM scheduled_blocks b
              JOIN item_assignees a ON a.item_id = b.item_id
              WHERE a.assignee_id IN (${placeholders})
                AND b.start_at < ?
                AND (b.start_at + b.duration_minutes * 60000) > ?
              ORDER BY b.start_at ASC;`,
            rowMode: "array",
            returnValue: "resultRows",
            bind: [...userIds, timeMax, timeMin],
          }) as Array<[string, string, number, number, string]>;

          const itemIds = Array.from(new Set(blockRows.map((row) => row[1])));
          let itemRows: Array<
            [string, string, string, number | null, string | null, string, number]
          > = [];
          if (itemIds.length > 0) {
            const itemPlaceholders = buildPlaceholders(itemIds.length);
            itemRows = dbHandle.exec({
              sql: `SELECT id, title, status, due_at, parent_id, type, priority
                FROM items
                WHERE id IN (${itemPlaceholders})
                ORDER BY title ASC;`,
              rowMode: "array",
              returnValue: "resultRows",
              bind: itemIds,
            }) as Array<
              [string, string, string, number | null, string | null, string, number]
            >;
          }

          const userNameMap = getUserMap(dbHandle);
          result = {
            ok: true,
            result: {
              blocks: blockRows.map((row) => ({
                block_id: row[0],
                item_id: row[1],
                start_at: row[2],
                duration_minutes: row[3],
                assignee_id: row[4],
                assignee_name: getUserDisplayName(row[4], userNameMap),
              })),
              items: itemRows.map((row) => ({
                id: row[0],
                title: row[1],
                status: row[2],
                due_at: row[3],
                parent_id: row[4],
                item_type: row[5],
                priority: row[6],
              })),
            },
          };
          break;
        }
        case "users_list": {
          const settings = getSettings(dbHandle);
          const registry = normalizeUserList(settings.get(USERS_SETTING_KEY));
          const userMap = new Map(registry.map((user) => [user.user_id, user]));
          const rows = dbHandle.exec({
            sql: "SELECT DISTINCT assignee_id FROM item_assignees ORDER BY assignee_id ASC;",
            rowMode: "array",
            returnValue: "resultRows",
          }) as Array<[string]>;
          for (const row of rows) {
            const id = row[0];
            if (!userMap.has(id)) {
              const shortId = id.length > 6 ? id.slice(0, 6) : id;
              userMap.set(id, {
                user_id: id,
                display_name: `User ${shortId}`,
                avatar_url: null,
              });
            }
          }
          const users = Array.from(userMap.values());
          const currentUserId =
            typeof settings.get(CURRENT_USER_SETTING_KEY) === "string"
              ? (settings.get(CURRENT_USER_SETTING_KEY) as string)
              : null;
          result = {
            ok: true,
            result: { users, current_user_id: currentUserId },
          };
          break;
        }
        case "debug.verify_integrity": {
          result = { ok: true, result: verifyIntegrity() };
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
