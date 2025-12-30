export type RollupTotals = {
  totalEstimate: number;
  totalActual: number;
  rollupStartAt: number | null;
  rollupEndAt: number | null;
  rollupBlockedCount: number;
  rollupOverdueCount: number;
};

export type RollupRow = {
  id: string;
  parent_id: string | null;
  estimate_minutes: number;
  estimate_mode?: string | null;
};

type ScheduleSummary = {
  start: number | null;
  end: number | null;
};

type BlockedSummary = {
  is_blocked: boolean;
};

type DueMetrics = {
  is_overdue: boolean;
};

const minNullable = (a: number | null, b: number | null) => {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return Math.min(a, b);
};

const maxNullable = (a: number | null, b: number | null) => {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return Math.max(a, b);
};

export const computeRollupTotals = (
  rows: RollupRow[],
  scheduleMap: Map<string, ScheduleSummary>,
  blockedMap: Map<string, BlockedSummary>,
  dueMetricsMap: Map<string, DueMetrics>,
  timeMap: Map<string, number>
) => {
  const rowMap = new Map(rows.map((row) => [row.id, row]));
  const nodeMap = new Map(
    rows.map((row) => [
      row.id,
      {
        parent_id: row.parent_id,
        children: [] as string[],
      },
    ])
  );

  for (const row of rows) {
    if (row.parent_id && nodeMap.has(row.parent_id)) {
      nodeMap.get(row.parent_id)!.children.push(row.id);
    }
  }

  const totalsMap = new Map<string, RollupTotals>();
  const visiting = new Set<string>();

  const compute = (id: string): RollupTotals => {
    if (totalsMap.has(id)) {
      return totalsMap.get(id)!;
    }
    if (visiting.has(id)) {
      return {
        totalEstimate: 0,
        totalActual: 0,
        rollupStartAt: null,
        rollupEndAt: null,
        rollupBlockedCount: 0,
        rollupOverdueCount: 0,
      };
    }
    visiting.add(id);
    const row = rowMap.get(id);
    const node = nodeMap.get(id);
    let estimate = row?.estimate_minutes ?? 0;
    let actual = timeMap.get(id) ?? 0;
    let rollupStartAt = scheduleMap.get(id)?.start ?? null;
    let rollupEndAt = scheduleMap.get(id)?.end ?? null;
    let rollupBlockedCount = blockedMap.get(id)?.is_blocked ? 1 : 0;
    let rollupOverdueCount = dueMetricsMap.get(id)?.is_overdue ? 1 : 0;

    for (const childId of node?.children ?? []) {
      const childTotals = compute(childId);
      if (row?.estimate_mode === "rollup") {
        estimate += childTotals.totalEstimate;
      }
      actual += childTotals.totalActual;
      rollupStartAt = minNullable(rollupStartAt, childTotals.rollupStartAt);
      rollupEndAt = maxNullable(rollupEndAt, childTotals.rollupEndAt);
      rollupBlockedCount += childTotals.rollupBlockedCount;
      rollupOverdueCount += childTotals.rollupOverdueCount;
    }

    const totals: RollupTotals = {
      totalEstimate: estimate,
      totalActual: actual,
      rollupStartAt,
      rollupEndAt,
      rollupBlockedCount,
      rollupOverdueCount,
    };
    totalsMap.set(id, totals);
    visiting.delete(id);
    return totals;
  };

  for (const row of rows) {
    const parentId = row.parent_id;
    if (!parentId || !nodeMap.has(parentId)) {
      compute(row.id);
    }
  }

  for (const row of rows) {
    if (!totalsMap.has(row.id)) {
      compute(row.id);
    }
  }

  return totalsMap;
};
