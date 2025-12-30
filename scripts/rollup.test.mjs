import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/db-worker/rollup.ts", import.meta.url),
  "utf8"
);
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

const moduleShim = { exports: {} };
runInNewContext(output, { module: moduleShim, exports: moduleShim.exports });

const { computeRollupTotals } = moduleShim.exports;

const makeMap = (entries) => new Map(entries);

test("rollup includes subtasks when parent task is rollup mode", () => {
  const rows = [
    { id: "task-1", parent_id: null, estimate_mode: "rollup", estimate_minutes: 0 },
    { id: "sub-1", parent_id: "task-1", estimate_mode: "manual", estimate_minutes: 30 },
    { id: "sub-2", parent_id: "task-1", estimate_mode: "manual", estimate_minutes: 20 },
  ];
  const scheduleMap = makeMap([
    ["task-1", { start: null, end: null }],
    ["sub-1", { start: 100, end: 160 }],
    ["sub-2", { start: 200, end: 260 }],
  ]);
  const blockedMap = makeMap([
    ["task-1", { is_blocked: false }],
    ["sub-1", { is_blocked: true }],
    ["sub-2", { is_blocked: false }],
  ]);
  const dueMetricsMap = makeMap([
    ["task-1", { is_overdue: false }],
    ["sub-1", { is_overdue: true }],
    ["sub-2", { is_overdue: false }],
  ]);
  const timeMap = makeMap([
    ["task-1", 0],
    ["sub-1", 15],
    ["sub-2", 10],
  ]);

  const totals = computeRollupTotals(
    rows,
    scheduleMap,
    blockedMap,
    dueMetricsMap,
    timeMap
  );
  const taskTotals = totals.get("task-1");
  assert.equal(taskTotals.totalEstimate, 50);
  assert.equal(taskTotals.totalActual, 25);
  assert.equal(taskTotals.rollupStartAt, 100);
  assert.equal(taskTotals.rollupEndAt, 260);
  assert.equal(taskTotals.rollupBlockedCount, 1);
  assert.equal(taskTotals.rollupOverdueCount, 1);
});

test("manual estimate overrides child estimates for parent task", () => {
  const rows = [
    { id: "task-2", parent_id: null, estimate_mode: "manual", estimate_minutes: 40 },
    { id: "sub-3", parent_id: "task-2", estimate_mode: "manual", estimate_minutes: 30 },
  ];
  const scheduleMap = makeMap([
    ["task-2", { start: null, end: null }],
    ["sub-3", { start: 10, end: 40 }],
  ]);
  const blockedMap = makeMap([
    ["task-2", { is_blocked: false }],
    ["sub-3", { is_blocked: false }],
  ]);
  const dueMetricsMap = makeMap([
    ["task-2", { is_overdue: false }],
    ["sub-3", { is_overdue: false }],
  ]);
  const timeMap = makeMap([
    ["task-2", 0],
    ["sub-3", 5],
  ]);

  const totals = computeRollupTotals(
    rows,
    scheduleMap,
    blockedMap,
    dueMetricsMap,
    timeMap
  );
  const taskTotals = totals.get("task-2");
  assert.equal(taskTotals.totalEstimate, 40);
  assert.equal(taskTotals.totalActual, 5);
  assert.equal(taskTotals.rollupStartAt, 10);
  assert.equal(taskTotals.rollupEndAt, 40);
});

test("moving a subtask updates parent rollups based on parent_id", () => {
  const baseRows = [
    { id: "task-a", parent_id: null, estimate_mode: "rollup", estimate_minutes: 0 },
    { id: "task-b", parent_id: null, estimate_mode: "rollup", estimate_minutes: 0 },
    { id: "sub-x", parent_id: "task-a", estimate_mode: "manual", estimate_minutes: 25 },
  ];
  const scheduleMap = makeMap([
    ["task-a", { start: null, end: null }],
    ["task-b", { start: null, end: null }],
    ["sub-x", { start: 100, end: 160 }],
  ]);
  const blockedMap = makeMap([
    ["task-a", { is_blocked: false }],
    ["task-b", { is_blocked: false }],
    ["sub-x", { is_blocked: false }],
  ]);
  const dueMetricsMap = makeMap([
    ["task-a", { is_overdue: false }],
    ["task-b", { is_overdue: false }],
    ["sub-x", { is_overdue: false }],
  ]);
  const timeMap = makeMap([
    ["task-a", 0],
    ["task-b", 0],
    ["sub-x", 10],
  ]);

  const totalsBefore = computeRollupTotals(
    baseRows,
    scheduleMap,
    blockedMap,
    dueMetricsMap,
    timeMap
  );
  assert.equal(totalsBefore.get("task-a").totalEstimate, 25);
  assert.equal(totalsBefore.get("task-b").totalEstimate, 0);

  const movedRows = baseRows.map((row) =>
    row.id === "sub-x" ? { ...row, parent_id: "task-b" } : row
  );
  const totalsAfter = computeRollupTotals(
    movedRows,
    scheduleMap,
    blockedMap,
    dueMetricsMap,
    timeMap
  );
  assert.equal(totalsAfter.get("task-a").totalEstimate, 0);
  assert.equal(totalsAfter.get("task-b").totalEstimate, 25);
  assert.equal(totalsAfter.get("task-b").totalActual, 10);
});

test("rollups include subtasks through task to milestone", () => {
  const rows = [
    { id: "proj-1", parent_id: null, estimate_mode: "rollup", estimate_minutes: 0 },
    { id: "ms-1", parent_id: "proj-1", estimate_mode: "rollup", estimate_minutes: 0 },
    { id: "task-3", parent_id: "ms-1", estimate_mode: "rollup", estimate_minutes: 0 },
    { id: "sub-4", parent_id: "task-3", estimate_mode: "manual", estimate_minutes: 45 },
  ];
  const scheduleMap = makeMap([
    ["proj-1", { start: null, end: null }],
    ["ms-1", { start: null, end: null }],
    ["task-3", { start: null, end: null }],
    ["sub-4", { start: 50, end: 110 }],
  ]);
  const blockedMap = makeMap([
    ["proj-1", { is_blocked: false }],
    ["ms-1", { is_blocked: false }],
    ["task-3", { is_blocked: false }],
    ["sub-4", { is_blocked: false }],
  ]);
  const dueMetricsMap = makeMap([
    ["proj-1", { is_overdue: false }],
    ["ms-1", { is_overdue: false }],
    ["task-3", { is_overdue: false }],
    ["sub-4", { is_overdue: false }],
  ]);
  const timeMap = makeMap([
    ["proj-1", 0],
    ["ms-1", 0],
    ["task-3", 0],
    ["sub-4", 12],
  ]);

  const totals = computeRollupTotals(
    rows,
    scheduleMap,
    blockedMap,
    dueMetricsMap,
    timeMap
  );
  assert.equal(totals.get("task-3").totalEstimate, 45);
  assert.equal(totals.get("ms-1").totalEstimate, 45);
  assert.equal(totals.get("task-3").totalActual, 12);
  assert.equal(totals.get("ms-1").totalActual, 12);
  assert.equal(totals.get("task-3").rollupStartAt, 50);
  assert.equal(totals.get("ms-1").rollupEndAt, 110);
});
