import { SegmentedControl } from "@radix-ui/themes";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";
import { query, mutate } from "../rpc/clientSingleton";
import type {
  GanttBlock,
  GanttEdge,
  GanttItem,
  GanttRangeResult,
} from "../domain/ganttTypes";
import type { Scope } from "../domain/scope";
import { AppButton, AppInput, AppSelect } from "./controls";

type GanttViewProps = {
  scope: Scope;
  refreshToken: number;
  onRefresh: () => void;
  onOpenItem: (itemId: string) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_WIDTH = 120;
const MIN_DAY_WIDTH = 60;
const MAX_DAY_WIDTH = 260;
const ROW_HEIGHT = 28;

const DAY_LABEL = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const startOfDay = (value: Date) => {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
};

const startOfWeek = (value: Date) => {
  const next = startOfDay(value);
  const day = next.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  next.setDate(next.getDate() + diff);
  return next;
};

const startOfMonth = (value: Date) => {
  const next = startOfDay(value);
  next.setDate(1);
  return next;
};

const startOfQuarter = (value: Date) => {
  const next = startOfDay(value);
  const month = next.getMonth();
  const quarterStart = month - (month % 3);
  next.setMonth(quarterStart, 1);
  return next;
};

const addDays = (value: Date, days: number) => {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
};

const addMonths = (value: Date, months: number) => {
  const next = new Date(value);
  next.setMonth(next.getMonth() + months, 1);
  return next;
};

const getPrimaryTime = (item: GanttItem, hasChildren: boolean) => {
  if (hasChildren) {
    return item.rollup_start_at ?? null;
  }
  return item.planned_start_at ?? null;
};

const getBarRange = (item: GanttItem, hasChildren: boolean) => {
  if (hasChildren) {
    return {
      start: item.rollup_start_at,
      end: item.rollup_end_at,
    };
  }
  return {
    start: item.planned_start_at,
    end: item.planned_end_at,
  };
};

const formatDayLabel = (value: Date) => DAY_LABEL.format(value);

const GanttView: FC<GanttViewProps> = ({
  scope,
  refreshToken,
  onRefresh,
  onOpenItem,
}) => {
  const [items, setItems] = useState<GanttItem[]>([]);
  const [blocks, setBlocks] = useState<GanttBlock[]>([]);
  const [edges, setEdges] = useState<GanttEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"week" | "month" | "quarter">(
    "month"
  );
  const [focusDate, setFocusDate] = useState(() => new Date());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dependencyMode, setDependencyMode] = useState(false);
  const [pendingEdge, setPendingEdge] = useState<string | null>(null);
  const [dayWidth, setDayWidth] = useState(DAY_WIDTH);
  const headerScrollRef = useRef<HTMLDivElement | null>(null);
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const [edgeDraft, setEdgeDraft] = useState<{
    predecessorId: string;
    successorId: string;
    type: "FS" | "SS" | "FF" | "SF";
    lagMinutes: number;
  } | null>(null);

  const timeWindow = useMemo(() => {
    if (viewMode === "week") {
      const start = startOfWeek(focusDate);
      const end = addDays(start, 7);
      return { start, end };
    }
    if (viewMode === "quarter") {
      const start = startOfQuarter(focusDate);
      const end = addMonths(start, 3);
      return { start, end };
    }
    const start = startOfMonth(focusDate);
    const end = addMonths(start, 1);
    return { start, end };
  }, [focusDate, viewMode]);

  const loadRange = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await query<GanttRangeResult>("gantt_range", {
        time_min: timeWindow.start.toISOString(),
        time_max: timeWindow.end.toISOString(),
        scope,
        includeCompleted: false,
      });
      setItems(data.items);
      setBlocks(data.blocks);
      setEdges(data.edges);
      setHasLoadedOnce(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [scope, timeWindow]);

  useEffect(() => {
    void loadRange();
  }, [loadRange, refreshToken]);

  const childMap = useMemo(() => {
    const map = new Map<string | null, GanttItem[]>();
    for (const item of items) {
      const list = map.get(item.parent_id ?? null) ?? [];
      list.push(item);
      map.set(item.parent_id ?? null, list);
    }
    return map;
  }, [items]);

  const itemMap = useMemo(() => new Map(items.map((item) => [item.id, item])), [
    items,
  ]);

  const sortItems = useCallback(
    (list: GanttItem[]) =>
      list.slice().sort((a, b) => {
        const aHasChildren = (childMap.get(a.id) ?? []).length > 0;
        const bHasChildren = (childMap.get(b.id) ?? []).length > 0;
        const aStart = getPrimaryTime(a, aHasChildren) ?? Number.POSITIVE_INFINITY;
        const bStart = getPrimaryTime(b, bHasChildren) ?? Number.POSITIVE_INFINITY;
        if (aStart !== bStart) {
          return aStart - bStart;
        }
        const aDue = a.due_at ?? Number.POSITIVE_INFINITY;
        const bDue = b.due_at ?? Number.POSITIVE_INFINITY;
        if (aDue !== bDue) {
          return aDue - bDue;
        }
        return a.title.localeCompare(b.title);
      }),
    [childMap]
  );

  const sortedChildren = useCallback(
    (parentId: string | null) => sortItems(childMap.get(parentId) ?? []),
    [childMap, sortItems]
  );

  const visibleRows = useMemo(() => {
    const rows: Array<{ item: GanttItem; depth: number }> = [];
    const walk = (parentId: string | null, depth: number) => {
      const children = sortedChildren(parentId);
      for (const child of children) {
        rows.push({ item: child, depth });
        const hasChildren = (childMap.get(child.id) ?? []).length > 0;
        if (hasChildren && !collapsed.has(child.id)) {
          walk(child.id, depth + 1);
        }
      }
    };
    if (scope.kind === "user") {
      const roots = items.filter(
        (item) => !item.parent_id || !itemMap.has(item.parent_id)
      );
      for (const root of sortItems(roots)) {
        rows.push({ item: root, depth: 0 });
        const hasChildren = (childMap.get(root.id) ?? []).length > 0;
        if (hasChildren && !collapsed.has(root.id)) {
          walk(root.id, 1);
        }
      }
      if (roots.length === 0) {
        walk(null, 0);
      }
    } else {
      walk(null, 0);
    }
    return rows;
  }, [childMap, collapsed, itemMap, items, scope.kind, sortedChildren]);

  const timelineDays = useMemo(() => {
    const days: Date[] = [];
    const start = timeWindow.start;
    const end = timeWindow.end;
    for (
      let cursor = new Date(start);
      cursor < end;
      cursor = addDays(cursor, 1)
    ) {
      days.push(new Date(cursor));
    }
    return days;
  }, [timeWindow]);

  const timelineWidth = timelineDays.length * dayWidth;
  const totalHeight = visibleRows.length * ROW_HEIGHT;

  const toX = (timestamp: number) =>
    ((timestamp - timeWindow.start.getTime()) / DAY_MS) * dayWidth;

  const rowPositionMap = useMemo(() => {
    const map = new Map<
      string,
      { y: number; startX: number | null; endX: number | null }
    >();
    visibleRows.forEach((row, index) => {
      const hasChildren = (childMap.get(row.item.id) ?? []).length > 0;
      const range = getBarRange(row.item, hasChildren);
      const startX =
        range.start !== null ? toX(range.start) : null;
      const endX =
        range.end !== null ? toX(range.end) : null;
      map.set(row.item.id, {
        y: index * ROW_HEIGHT + ROW_HEIGHT / 2,
        startX,
        endX,
      });
    });
    return map;
  }, [childMap, visibleRows, timeWindow.start]);

  const handleToggleCollapse = (itemId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const handleBarClick = (itemId: string) => {
    if (dependencyMode) {
      if (!pendingEdge) {
        setPendingEdge(itemId);
        return;
      }
      if (pendingEdge === itemId) {
        setPendingEdge(null);
        return;
      }
      setEdgeDraft({
        predecessorId: pendingEdge,
        successorId: itemId,
        type: "FS",
        lagMinutes: 0,
      });
      setPendingEdge(null);
      return;
    }
    onOpenItem(itemId);
  };

  const handleCreateEdge = async () => {
    if (!edgeDraft) {
      return;
    }
    try {
      await mutate("dependency.create", {
        predecessor_id: edgeDraft.predecessorId,
        successor_id: edgeDraft.successorId,
        type: edgeDraft.type,
        lag_minutes: edgeDraft.lagMinutes,
      });
      setEdgeDraft(null);
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleTimelineScroll = useCallback(() => {
    if (!headerScrollRef.current || !bodyScrollRef.current) {
      return;
    }
    headerScrollRef.current.scrollLeft = bodyScrollRef.current.scrollLeft;
  }, []);

  const handleTimelineWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      const delta = Math.sign(event.deltaY) * 10;
      setDayWidth((prev) => {
        const next = Math.min(MAX_DAY_WIDTH, Math.max(MIN_DAY_WIDTH, prev - delta));
        return next;
      });
    },
    []
  );

  useEffect(() => {
    if (!headerScrollRef.current || !bodyScrollRef.current) {
      return;
    }
    const header = headerScrollRef.current;
    const body = bodyScrollRef.current;
    const prevWidth = body.dataset.timelineWidth
      ? Number(body.dataset.timelineWidth)
      : timelineWidth;
    if (!Number.isFinite(prevWidth) || prevWidth <= 0) {
      body.dataset.timelineWidth = String(timelineWidth);
      return;
    }
    const ratio = body.scrollLeft / prevWidth;
    const nextScrollLeft = ratio * timelineWidth;
    body.scrollLeft = nextScrollLeft;
    header.scrollLeft = nextScrollLeft;
    body.dataset.timelineWidth = String(timelineWidth);
  }, [timelineWidth]);

  return (
    <div className="gantt-root">
      <div className="gantt-toolbar">
        <div className="gantt-toolbar-left">
          <SegmentedControl.Root
            value={viewMode}
            onValueChange={(value) =>
              setViewMode(value as typeof viewMode)
            }
          >
            <SegmentedControl.Item value="week">Week</SegmentedControl.Item>
            <SegmentedControl.Item value="month">Month</SegmentedControl.Item>
            <SegmentedControl.Item value="quarter">Quarter</SegmentedControl.Item>
          </SegmentedControl.Root>
        </div>
        <div className="gantt-toolbar-right">
          <AppButton
            type="button"
            variant={dependencyMode ? "solid" : "surface"}
            onClick={() => {
              setDependencyMode((prev) => !prev);
              setPendingEdge(null);
              setEdgeDraft(null);
            }}
          >
            Dependency Mode
          </AppButton>
        </div>
      </div>

      {edgeDraft ? (
        <div className="gantt-edge-editor">
          <div>
            Add dependency:{" "}
            {itemMap.get(edgeDraft.predecessorId)?.title ?? edgeDraft.predecessorId}
            {" → "}
            {itemMap.get(edgeDraft.successorId)?.title ?? edgeDraft.successorId}
          </div>
          <div className="gantt-edge-controls">
            <label>
              Type
              <AppSelect
                value={edgeDraft.type}
                onChange={(value) =>
                  setEdgeDraft((prev) =>
                    prev
                      ? {
                          ...prev,
                          type: value as GanttEdge["type"],
                        }
                      : prev
                  )
                }
                options={[
                  { value: "FS", label: "FS" },
                  { value: "SS", label: "SS" },
                  { value: "FF", label: "FF" },
                  { value: "SF", label: "SF" },
                ]}
              />
            </label>
            <label>
              Lag (min)
              <AppInput
                type="number"
                min={0}
                value={edgeDraft.lagMinutes}
                onChange={(event) =>
                  setEdgeDraft((prev) =>
                    prev
                      ? {
                          ...prev,
                          lagMinutes: Math.max(
                            0,
                            Number(event.target.value || 0)
                          ),
                        }
                      : prev
                  )
                }
              />
            </label>
            <AppButton type="button" variant="surface" onClick={handleCreateEdge}>
              Add
            </AppButton>
            <AppButton
              type="button"
              variant="ghost"
              onClick={() => setEdgeDraft(null)}
            >
              Cancel
            </AppButton>
          </div>
        </div>
      ) : null}

      {error ? <div className="error">{error}</div> : null}
      {loading && !hasLoadedOnce ? <div className="loading">Loading…</div> : null}

      <div className="gantt-grid">
        <div className="gantt-header">
          <div className="gantt-label-header">Item</div>
          <div
            className="gantt-timeline-scroll gantt-timeline-scroll--header"
            ref={headerScrollRef}
          >
            <div
              className="gantt-timeline-header"
              style={{ width: timelineWidth }}
            >
              {timelineDays.map((day) => (
                <div
                  key={day.toISOString()}
                  className="gantt-day"
                  style={{ width: dayWidth }}
                >
                  {formatDayLabel(day)}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="gantt-body">
          <div className="gantt-labels">
            {visibleRows.map((row) => {
              const item = row.item;
              const childrenCount = (childMap.get(item.id) ?? []).length;
              const isCollapsed = collapsed.has(item.id);
              return (
                <div
                  key={item.id}
                  className="gantt-row-label"
                  style={{ paddingLeft: row.depth * 16 }}
                >
                  {childrenCount > 0 ? (
                    <AppButton
                      type="button"
                      size="1"
                      variant="ghost"
                      className="gantt-disclosure"
                      onClick={() => handleToggleCollapse(item.id)}
                    >
                      {isCollapsed ? "▶" : "▼"}
                    </AppButton>
                  ) : (
                    <span className="gantt-disclosure-spacer" />
                  )}
                  <span className="gantt-label-title">{item.title}</span>
                </div>
              );
            })}
          </div>
          <div
            className="gantt-timeline-scroll"
            ref={bodyScrollRef}
            onScroll={handleTimelineScroll}
            onWheel={handleTimelineWheel}
          >
            <div
              className="gantt-timeline"
              style={{ width: timelineWidth, height: totalHeight }}
            >
              <svg className="gantt-lines" width={timelineWidth} height={totalHeight}>
                {edges.map((edge) => {
                  const start = rowPositionMap.get(edge.predecessor_id);
                  const end = rowPositionMap.get(edge.successor_id);
                  if (!start || !end) {
                    return null;
                  }
                  if (start.startX === null || start.endX === null) {
                    return null;
                  }
                  if (end.startX === null || end.endX === null) {
                    return null;
                  }
                  const fromX =
                    edge.type === "SS" || edge.type === "SF"
                      ? start.startX
                      : start.endX;
                  const toX =
                    edge.type === "FF" || edge.type === "SF"
                      ? end.endX
                      : end.startX;
                  if (!Number.isFinite(fromX) || !Number.isFinite(toX)) {
                    return null;
                  }
                  const midX = fromX + 12;
                  const path = `M ${fromX} ${start.y} L ${midX} ${start.y} L ${midX} ${end.y} L ${toX} ${end.y}`;
                  return (
                    <path
                      key={edge.edge_id}
                      d={path}
                      className="gantt-edge-line"
                    />
                  );
                })}
              </svg>
              {visibleRows.map((row, index) => {
                const item = row.item;
                const hasChildren = (childMap.get(item.id) ?? []).length > 0;
                const range = getBarRange(item, hasChildren);
                const start =
                  range.start !== null ? toX(range.start) : null;
                const end =
                  range.end !== null ? toX(range.end) : null;
                const width =
                  start !== null && end !== null
                    ? Math.max(2, end - start)
                    : 0;
                const dueX =
                  item.due_at !== null ? toX(item.due_at) : null;
                const rowTop = index * ROW_HEIGHT;
                return (
                  <div
                    key={item.id}
                    className="gantt-row"
                    style={{ top: rowTop, height: ROW_HEIGHT }}
                  >
                    {start !== null && end !== null ? (
                      <AppButton
                        type="button"
                        variant="ghost"
                        className={
                          dependencyMode && pendingEdge === item.id
                            ? "gantt-bar is-pending"
                            : "gantt-bar"
                        }
                        style={{
                          left: start,
                          width,
                        }}
                        onClick={() => handleBarClick(item.id)}
                      >
                        <span className="gantt-bar-title">{item.title}</span>
                      </AppButton>
                    ) : (
                      <span className="gantt-unscheduled">—</span>
                    )}
                    {dueX !== null &&
                    dueX >= 0 &&
                    dueX <= timelineWidth ? (
                      <AppButton
                        type="button"
                        variant="ghost"
                        className="gantt-due-marker"
                        style={{ left: dueX }}
                        onClick={() => onOpenItem(item.id)}
                      >
                        <span className="gantt-due-dot" />
                      </AppButton>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GanttView;
