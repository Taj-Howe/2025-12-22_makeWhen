import { db } from "../db/kysely";
import {
  computeSlackMinutes,
  deriveEndAtFromDuration,
  evaluateDependencyStatus,
  type DependencyType,
} from "../domain/scheduleMath";
import { computeRollupTotals } from "../domain/rollup";

const toMs = (value: string | null) => (value ? new Date(value).getTime() : null);

export type ListViewScope =
  | { kind: "project"; projectId: string }
  | { kind: "user"; userId: string }
  | { kind: "all" };

export type ListViewArgs = {
  scope: ListViewScope;
  includeArchived?: boolean;
  includeCompleted?: boolean;
  archiveFilter?: "all" | "active" | "archived";
};

export type ScheduledBlockLite = {
  block_id: string;
  item_id: string;
  start_at: number;
  duration_minutes: number;
  end_at_derived: number;
};

export type DependencyEdgeLite = {
  edge_id: string;
  predecessor_id?: string;
  successor_id?: string;
  type: DependencyType;
  lag_minutes: number;
};

export type DependencyProjectionLite = {
  item_id: string;
  title: string;
  type: DependencyType;
  lag_minutes: number;
  status: "satisfied" | "violated" | "unknown";
};

export type ListViewItem = {
  id: string;
  type: "project" | "milestone" | "task" | "subtask";
  item_type?: "project" | "milestone" | "task" | "subtask";
  title: string;
  parent_id: string | null;
  depth: number;
  project_id: string;
  sort_order: number;
  due_at: number | null;
  archived_at?: number | null;
  estimate_mode?: string;
  status: string;
  priority: number;
  estimate_minutes: number;
  rollup_estimate_minutes?: number;
  rollup_actual_minutes?: number;
  rollup_remaining_minutes?: number;
  rollup_start_at?: number | null;
  rollup_end_at?: number | null;
  rollup_blocked_count?: number;
  rollup_overdue_count?: number;
  schedule: {
    has_blocks: boolean;
    scheduled_minutes_total: number;
    schedule_start_at: number | null;
    schedule_end_at: number | null;
  };
  depends_on: string[];
  notes: string | null;
  blocked: {
    is_blocked: boolean;
    blocked_by_deps: boolean;
    blocked_by_blockers: boolean;
    active_blocker_count: number;
    unmet_dependency_count: number;
  };
  assignees: { id: string; name: string | null }[];
  assignee_id?: string | null;
  assignee_name?: string | null;
  tags: { id: string; name: string }[];
  health: string;
  health_mode?: string;
  completed_on: number | null;
  actual_minutes: number | null;
  scheduled_blocks: ScheduledBlockLite[];
  dependencies_out: DependencyEdgeLite[];
  dependencies_in: DependencyEdgeLite[];
  blocked_by: DependencyProjectionLite[];
  blocking: DependencyProjectionLite[];
  slack_minutes: number | null;
};

const resolveArchiveFilter = (
  includeArchived?: boolean,
  archiveFilter?: "all" | "active" | "archived"
) => {
  if (archiveFilter) return archiveFilter;
  return includeArchived ? "all" : "active";
};

const computeDepthMap = (items: Array<{ id: string; parent_id: string | null }>) => {
  const map = new Map<string, { parent_id: string | null }>();
  for (const item of items) {
    map.set(item.id, { parent_id: item.parent_id });
  }
  const depthMap = new Map<string, number>();
  const compute = (id: string): number => {
    if (depthMap.has(id)) {
      return depthMap.get(id)!;
    }
    const entry = map.get(id);
    if (!entry?.parent_id || !map.has(entry.parent_id)) {
      depthMap.set(id, 0);
      return 0;
    }
    const depth = compute(entry.parent_id) + 1;
    depthMap.set(id, depth);
    return depth;
  };
  for (const id of map.keys()) {
    compute(id);
  }
  return depthMap;
};

const computeDueMetrics = (dueAt: number | null, now: number, status: string) => {
  if (dueAt === null) {
    return { is_overdue: false };
  }
  const diffMs = dueAt - now;
  const isOverdue = diffMs < 0 && status !== "done" && status !== "canceled";
  return { is_overdue: isOverdue };
};

export const getListView = async ({
  scope,
  includeArchived,
  includeCompleted = true,
  archiveFilter,
}: ListViewArgs): Promise<ListViewItem[]> => {
  const archiveMode = resolveArchiveFilter(includeArchived, archiveFilter);
  const now = Date.now();

  let query = db
    .selectFrom("items")
    .select([
      "items.id",
      "items.type",
      "items.title",
      "items.parent_id",
      "items.status",
      "items.priority",
      "items.due_at",
      "items.estimate_mode",
      "items.estimate_minutes",
      "items.notes",
      "items.updated_at",
      "items.sequence_rank",
      "items.completed_at",
      "items.archived_at",
      "items.project_id",
      "items.assignee_user_id",
      "items.health",
    ]);

  if (scope.kind === "project") {
    query = query.where("items.project_id", "=", scope.projectId);
  } else if (scope.kind === "user") {
    query = query.where("items.assignee_user_id", "=", scope.userId);
  }

  if (archiveMode === "active") {
    query = query.where("items.archived_at", "is", null);
  } else if (archiveMode === "archived") {
    query = query.where("items.archived_at", "is not", null);
  }

  if (!includeCompleted) {
    query = query.where("items.status", "not in", ["done", "canceled"]);
  }

  const rows = await query
    .orderBy("items.sequence_rank", "asc")
    .orderBy("items.due_at", "asc")
    .orderBy("items.title", "asc")
    .execute();

  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((row) => row.id);
  const depthMap = computeDepthMap(
    rows.map((row) => ({ id: row.id, parent_id: row.parent_id }))
  );
  const itemMap = new Map(rows.map((row) => [row.id, row]));

  const blockRows = await db
    .selectFrom("scheduled_blocks")
    .select(["id", "item_id", "start_at", "duration_minutes"])
    .where("item_id", "in", ids)
    .execute();

  const blocksMap = new Map<string, ScheduledBlockLite[]>();
  const scheduleSummaryMap = new Map<
    string,
    { count: number; total: number; start: number | null; end: number | null }
  >();

  for (const row of blockRows) {
    const startAt = new Date(row.start_at).getTime();
    const endAt = deriveEndAtFromDuration(startAt, row.duration_minutes) ?? startAt;
    const block: ScheduledBlockLite = {
      block_id: row.id,
      item_id: row.item_id,
      start_at: startAt,
      duration_minutes: row.duration_minutes,
      end_at_derived: endAt,
    };
    const list = blocksMap.get(row.item_id) ?? [];
    list.push(block);
    blocksMap.set(row.item_id, list);

    const summary = scheduleSummaryMap.get(row.item_id) ?? {
      count: 0,
      total: 0,
      start: null,
      end: null,
    };
    summary.count += 1;
    summary.total += row.duration_minutes;
    summary.start = summary.start === null ? startAt : Math.min(summary.start, startAt);
    summary.end = summary.end === null ? endAt : Math.max(summary.end, endAt);
    scheduleSummaryMap.set(row.item_id, summary);
  }

  const dependencyRows = await db
    .selectFrom("dependencies")
    .select([
      "id",
      "item_id",
      "depends_on_id",
      "type",
      "lag_minutes",
    ])
    .where((eb) =>
      eb.or([
        eb("item_id", "in", ids),
        eb("depends_on_id", "in", ids),
      ])
    )
    .execute();

  const dependsOnMap = new Map<string, string[]>();
  const depsInMap = new Map<string, DependencyEdgeLite[]>();
  const depsOutMap = new Map<string, DependencyEdgeLite[]>();

  for (const row of dependencyRows) {
    const edgeId = `${row.item_id}->${row.depends_on_id}`;
    const type = (row.type ?? "FS").toUpperCase() as DependencyType;
    const lag = Number.isFinite(row.lag_minutes) ? row.lag_minutes : 0;

    const inList = depsInMap.get(row.item_id) ?? [];
    inList.push({
      edge_id: edgeId,
      predecessor_id: row.depends_on_id,
      type,
      lag_minutes: lag,
    });
    depsInMap.set(row.item_id, inList);

    const outList = depsOutMap.get(row.depends_on_id) ?? [];
    outList.push({
      edge_id: edgeId,
      successor_id: row.item_id,
      type,
      lag_minutes: lag,
    });
    depsOutMap.set(row.depends_on_id, outList);

    const dependsList = dependsOnMap.get(row.item_id) ?? [];
    dependsList.push(row.depends_on_id);
    dependsOnMap.set(row.item_id, dependsList);
  }

  const blockerRows = await db
    .selectFrom("blockers")
    .select(["item_id"])
    .where("item_id", "in", ids)
    .where("cleared_at", "is", null)
    .execute();

  const blockerCountMap = new Map<string, number>();
  for (const row of blockerRows) {
    blockerCountMap.set(row.item_id, (blockerCountMap.get(row.item_id) ?? 0) + 1);
  }

  const timeRows = await db
    .selectFrom("time_entries")
    .select(["item_id", db.fn.sum<number>("duration_minutes").as("total")])
    .where("item_id", "in", ids)
    .groupBy("item_id")
    .execute();

  const timeMap = new Map<string, number>();
  for (const row of timeRows) {
    const total = row.total ?? 0;
    timeMap.set(row.item_id, Number(total));
  }

  const assigneeIds = Array.from(
    new Set(rows.map((row) => row.assignee_user_id).filter(Boolean))
  ) as string[];
  const assigneeRows = assigneeIds.length
    ? await db
        .selectFrom("users")
        .select(["id", "name"])
        .where("id", "in", assigneeIds)
        .execute()
    : [];
  const assigneeMap = new Map(assigneeRows.map((row) => [row.id, row.name]));

  const unmetDepCountMap = new Map<string, number>();
  for (const row of dependencyRows) {
    const predecessor = itemMap.get(row.depends_on_id);
    if (!predecessor || predecessor.status !== "done") {
      unmetDepCountMap.set(
        row.item_id,
        (unmetDepCountMap.get(row.item_id) ?? 0) + 1
      );
    }
  }

  const blockedMap = new Map<string, { is_blocked: boolean }>();
  const dueMetricsMap = new Map<string, { is_overdue: boolean }>();
  for (const row of rows) {
    const blockerCount = blockerCountMap.get(row.id) ?? 0;
    const unmetDeps = unmetDepCountMap.get(row.id) ?? 0;
    const blocked =
      row.status === "blocked" || blockerCount > 0 || unmetDeps > 0;
    blockedMap.set(row.id, { is_blocked: blocked });
    dueMetricsMap.set(
      row.id,
      computeDueMetrics(toMs(row.due_at), now, row.status)
    );
  }

  const rollupMap = computeRollupTotals(
    rows.map((row) => ({
      id: row.id,
      parent_id: row.parent_id,
      estimate_mode: row.estimate_mode,
      estimate_minutes: row.estimate_minutes,
    })),
    new Map(
      Array.from(scheduleSummaryMap.entries()).map(([id, summary]) => [
        id,
        { start: summary.start, end: summary.end },
      ])
    ),
    blockedMap,
    dueMetricsMap,
    timeMap
  );

  const result: ListViewItem[] = rows.map((row) => {
    const scheduleSummary = scheduleSummaryMap.get(row.id) ?? {
      count: 0,
      total: 0,
      start: null,
      end: null,
    };
    const depsIn = depsInMap.get(row.id) ?? [];
    const depsOut = depsOutMap.get(row.id) ?? [];
    const scheduleStart = scheduleSummary.start;
    const scheduleEnd = scheduleSummary.end;
    const slackMinutes = computeSlackMinutes(toMs(row.due_at), scheduleEnd);
    const rollupTotals = rollupMap.get(row.id);
    const blockerCount = blockerCountMap.get(row.id) ?? 0;
    const unmetDeps = unmetDepCountMap.get(row.id) ?? 0;
    const blockedBy = depsIn.map((dep) => {
      const meta = itemMap.get(dep.predecessor_id ?? "");
      const predecessorSchedule = scheduleSummaryMap.get(dep.predecessor_id ?? "") ?? {
        start: null,
        end: null,
      };
      return {
        item_id: dep.predecessor_id ?? "",
        title: meta?.title ?? dep.predecessor_id ?? "",
        type: dep.type,
        lag_minutes: dep.lag_minutes,
        status: evaluateDependencyStatus({
          predecessorStart: predecessorSchedule.start,
          predecessorEnd: predecessorSchedule.end,
          successorStart: scheduleStart,
          successorEnd: scheduleEnd,
          type: dep.type,
          lagMinutes: dep.lag_minutes,
        }),
      };
    });
    const blocking = depsOut.map((dep) => {
      const meta = itemMap.get(dep.successor_id ?? "");
      const successorSchedule = scheduleSummaryMap.get(dep.successor_id ?? "") ?? {
        start: null,
        end: null,
      };
      return {
        item_id: dep.successor_id ?? "",
        title: meta?.title ?? dep.successor_id ?? "",
        type: dep.type,
        lag_minutes: dep.lag_minutes,
        status: evaluateDependencyStatus({
          predecessorStart: scheduleStart,
          predecessorEnd: scheduleEnd,
          successorStart: successorSchedule.start,
          successorEnd: successorSchedule.end,
          type: dep.type,
          lagMinutes: dep.lag_minutes,
        }),
      };
    });

    const assigneeId = row.assignee_user_id;
    const assigneeName = assigneeId ? assigneeMap.get(assigneeId) ?? null : null;

    return {
      id: row.id,
      type: row.type as ListViewItem["type"],
      item_type: row.type as ListViewItem["type"],
      title: row.title,
      parent_id: row.parent_id,
      depth: depthMap.get(row.id) ?? 0,
      project_id: row.project_id,
      sort_order: row.sequence_rank ?? 0,
      due_at: toMs(row.due_at),
      archived_at: toMs(row.archived_at),
      estimate_mode: row.estimate_mode,
      status: row.status,
      priority: row.priority,
      estimate_minutes: row.estimate_minutes,
      rollup_estimate_minutes: rollupTotals?.totalEstimate ?? row.estimate_minutes,
      rollup_actual_minutes: rollupTotals?.totalActual ?? (timeMap.get(row.id) ?? 0),
      rollup_remaining_minutes: rollupTotals
        ? Math.max(0, rollupTotals.totalEstimate - rollupTotals.totalActual)
        : Math.max(0, row.estimate_minutes - (timeMap.get(row.id) ?? 0)),
      rollup_start_at: rollupTotals?.rollupStartAt ?? null,
      rollup_end_at: rollupTotals?.rollupEndAt ?? null,
      rollup_blocked_count: rollupTotals?.rollupBlockedCount ?? 0,
      rollup_overdue_count: rollupTotals?.rollupOverdueCount ?? 0,
      schedule: {
        has_blocks: scheduleSummary.count > 0,
        scheduled_minutes_total: scheduleSummary.total,
        schedule_start_at: scheduleSummary.start,
        schedule_end_at: scheduleSummary.end,
      },
      depends_on: dependsOnMap.get(row.id) ?? [],
      notes: row.notes,
      blocked: {
        is_blocked: row.status === "blocked" || blockerCount > 0 || unmetDeps > 0,
        blocked_by_deps: unmetDeps > 0,
        blocked_by_blockers: blockerCount > 0,
        active_blocker_count: blockerCount,
        unmet_dependency_count: unmetDeps,
      },
      assignees: assigneeId
        ? [{ id: assigneeId, name: assigneeName }]
        : [],
      assignee_id: assigneeId,
      assignee_name: assigneeName,
      tags: [],
      health: row.health ?? "unknown",
      completed_on: toMs(row.completed_at),
      actual_minutes: timeMap.get(row.id) ?? null,
      scheduled_blocks: blocksMap.get(row.id) ?? [],
      dependencies_out: depsOut,
      dependencies_in: depsIn,
      blocked_by: blockedBy,
      blocking,
      slack_minutes: slackMinutes,
    };
  });

  return result;
};
