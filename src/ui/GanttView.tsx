import { SegmentedControl } from "@radix-ui/themes";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
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

type ViewMode = "week" | "month" | "quarter";

type BarGesture = {
  itemId: string;
  isLeafTask: boolean;
  blockId: string | null;
  kind: "move" | "resize-start" | "resize-end";
  pointerStartX: number;
  initialStart: number;
  initialEnd: number;
};

type DragPreview = {
  itemId: string;
  start: number;
  end: number;
};

type ConnectionDrag = {
  sourceItemId: string;
  sourceX: number;
  sourceY: number;
  currentX: number;
  currentY: number;
};

type EdgeEditorState = {
  edgeId: string;
  type: GanttEdge["type"];
  lagMinutes: number;
  x: number;
  y: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_WIDTH = 120;
const MIN_DAY_WIDTH = 60;
const MAX_DAY_WIDTH = 260;
const ROW_HEIGHT = 28;
const MIN_BAR_WIDTH = 6;
const DRAG_CLICK_THRESHOLD_PX = 4;

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

const getSnapMinutesForView = (viewMode: ViewMode) => {
  if (viewMode === "week") {
    return 60;
  }
  if (viewMode === "quarter") {
    return 7 * 24 * 60;
  }
  return 24 * 60;
};

const roundToSnapMinutes = (minutes: number, snapMinutes: number) => {
  if (!Number.isFinite(minutes)) {
    return 0;
  }
  return Math.round(minutes / snapMinutes) * snapMinutes;
};

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
  const [viewMode, setViewMode] = useState<ViewMode>("month");
  const [focusDate, setFocusDate] = useState(() => new Date());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dayWidth, setDayWidth] = useState(DAY_WIDTH);
  const [isAltPressed, setIsAltPressed] = useState(false);
  const [edgeEditor, setEdgeEditor] = useState<EdgeEditorState | null>(null);
  const [connectionDrag, setConnectionDrag] = useState<ConnectionDrag | null>(null);
  const [barGesture, setBarGesture] = useState<BarGesture | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const headerScrollRef = useRef<HTMLDivElement | null>(null);
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const dragMovedRef = useRef(false);

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey) {
        setIsAltPressed(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!event.altKey) {
        setIsAltPressed(false);
      }
    };
    const handleBlur = () => {
      setIsAltPressed(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

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

  const blockByItemId = useMemo(() => {
    const map = new Map<string, GanttBlock>();
    for (const block of blocks) {
      const current = map.get(block.item_id);
      if (!current || block.start_at < current.start_at) {
        map.set(block.item_id, block);
      }
    }
    return map;
  }, [blocks]);

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
  }, [childMap, collapsed, itemMap, items, scope.kind, sortItems, sortedChildren]);

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
  const snapMinutes = useMemo(() => getSnapMinutesForView(viewMode), [viewMode]);

  const toX = useCallback(
    (timestamp: number) =>
      ((timestamp - timeWindow.start.getTime()) / DAY_MS) * dayWidth,
    [dayWidth, timeWindow.start]
  );

  const rowPositionMap = useMemo(() => {
    const map = new Map<
      string,
      { y: number; startX: number | null; endX: number | null }
    >();
    visibleRows.forEach((row, index) => {
      const hasChildren = (childMap.get(row.item.id) ?? []).length > 0;
      const range = getBarRange(row.item, hasChildren);
      const startX = range.start !== null ? toX(range.start) : null;
      const endX = range.end !== null ? toX(range.end) : null;
      map.set(row.item.id, {
        y: index * ROW_HEIGHT + ROW_HEIGHT / 2,
        startX,
        endX,
      });
    });
    return map;
  }, [childMap, toX, visibleRows]);

  const isRefreshing = loading && hasLoadedOnce;

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

  const handleDeleteItem = useCallback(
    async (itemId: string) => {
      setError(null);
      try {
        await mutate("delete_item", { item_id: itemId });
        onRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [onRefresh]
  );

  const clientToTimelinePoint = useCallback((clientX: number, clientY: number) => {
    const body = bodyScrollRef.current;
    if (!body) {
      return null;
    }
    const rect = body.getBoundingClientRect();
    return {
      x: clientX - rect.left + body.scrollLeft,
      y: clientY - rect.top + body.scrollTop,
    };
  }, []);

  const createDependencyAndOpenEditor = useCallback(
    async (
      predecessorId: string,
      successorId: string,
      position: { x: number; y: number }
    ) => {
      setError(null);
      try {
        const created = await mutate<{
          edge_id: string;
          predecessor_id: string;
          successor_id: string;
          type: GanttEdge["type"];
          lag_minutes: number;
        }>("dependency.create", {
          predecessor_id: predecessorId,
          successor_id: successorId,
          type: "FS",
          lag_minutes: 0,
        });
        const nextEdge: GanttEdge = {
          edge_id: created.edge_id,
          predecessor_id: created.predecessor_id,
          successor_id: created.successor_id,
          type: created.type,
          lag_minutes: created.lag_minutes,
        };
        setEdges((prev) => [...prev.filter((edge) => edge.edge_id !== nextEdge.edge_id), nextEdge]);
        setEdgeEditor({
          edgeId: nextEdge.edge_id,
          type: nextEdge.type,
          lagMinutes: nextEdge.lag_minutes,
          x: position.x,
          y: position.y,
        });
        onRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [onRefresh]
  );

  const handleSaveEdge = useCallback(async () => {
    if (!edgeEditor) {
      return;
    }
    setError(null);
    try {
      await mutate("dependency.update", {
        edge_id: edgeEditor.edgeId,
        type: edgeEditor.type,
        lag_minutes: Math.max(0, edgeEditor.lagMinutes),
      });
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  }, [edgeEditor, onRefresh]);

  const handleDeleteEdge = useCallback(async () => {
    if (!edgeEditor) {
      return;
    }
    setError(null);
    try {
      await mutate("dependency.delete", { edge_id: edgeEditor.edgeId });
      setEdgeEditor(null);
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  }, [edgeEditor, onRefresh]);

  const computeGesturePreview = useCallback(
    (gesture: BarGesture, pointerClientX: number) => {
      const deltaMinutesRaw =
        ((pointerClientX - gesture.pointerStartX) / dayWidth) * 24 * 60;
      const snappedDeltaMinutes = roundToSnapMinutes(deltaMinutesRaw, snapMinutes);
      const deltaMs = snappedDeltaMinutes * 60_000;
      const minimumDurationMs = snapMinutes * 60_000;
      if (gesture.kind === "move") {
        return {
          start: gesture.initialStart + deltaMs,
          end: gesture.initialEnd + deltaMs,
          deltaMinutes: snappedDeltaMinutes,
        };
      }
      if (gesture.kind === "resize-start") {
        return {
          start: Math.min(
            gesture.initialStart + deltaMs,
            gesture.initialEnd - minimumDurationMs
          ),
          end: gesture.initialEnd,
          deltaMinutes: snappedDeltaMinutes,
        };
      }
      return {
        start: gesture.initialStart,
        end: Math.max(
          gesture.initialEnd + deltaMs,
          gesture.initialStart + minimumDurationMs
        ),
        deltaMinutes: snappedDeltaMinutes,
      };
    },
    [dayWidth, snapMinutes]
  );

  const commitBarGesture = useCallback(
    async (gesture: BarGesture, pointerClientX: number, moved: boolean) => {
      const preview = computeGesturePreview(gesture, pointerClientX);
      const didStartChange = preview.start !== gesture.initialStart;
      const didEndChange = preview.end !== gesture.initialEnd;
      if (!moved && gesture.kind === "move") {
        onOpenItem(gesture.itemId);
        return;
      }
      if (!didStartChange && !didEndChange) {
        return;
      }
      setError(null);
      try {
        if (gesture.kind === "move") {
          if (gesture.isLeafTask) {
            if (!gesture.blockId) {
              return;
            }
            await mutate("scheduled_block.update", {
              block_id: gesture.blockId,
              start_at: preview.start,
            });
          } else {
            const deltaMinutes = Math.round(
              (preview.start - gesture.initialStart) / 60_000
            );
            if (deltaMinutes === 0) {
              return;
            }
            await mutate("gantt.shift_subtree", {
              item_id: gesture.itemId,
              delta_minutes: deltaMinutes,
            });
          }
        } else {
          if (!gesture.isLeafTask || !gesture.blockId) {
            return;
          }
          const durationMinutes = Math.max(
            1,
            Math.round((preview.end - preview.start) / 60_000)
          );
          await mutate("scheduled_block.update", {
            block_id: gesture.blockId,
            start_at: preview.start,
            duration_minutes: durationMinutes,
          });
        }
        onRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [computeGesturePreview, onOpenItem, onRefresh]
  );

  useEffect(() => {
    if (!barGesture && !connectionDrag) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (connectionDrag) {
        const point = clientToTimelinePoint(event.clientX, event.clientY);
        if (point) {
          setConnectionDrag((prev) =>
            prev
              ? {
                  ...prev,
                  currentX: point.x,
                  currentY: point.y,
                }
              : prev
          );
        }
      }

      if (barGesture) {
        if (
          Math.abs(event.clientX - barGesture.pointerStartX) >
          DRAG_CLICK_THRESHOLD_PX
        ) {
          dragMovedRef.current = true;
        }
        const preview = computeGesturePreview(barGesture, event.clientX);
        setDragPreview({
          itemId: barGesture.itemId,
          start: preview.start,
          end: preview.end,
        });
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      const activeConnection = connectionDrag;
      const activeGesture = barGesture;
      const didMove = dragMovedRef.current;

      setConnectionDrag(null);
      setBarGesture(null);
      setDragPreview(null);
      dragMovedRef.current = false;

      if (activeConnection) {
        const nodeAtPointer = document.elementFromPoint(
          event.clientX,
          event.clientY
        ) as HTMLElement | null;
        const targetElement = nodeAtPointer?.closest(
          "[data-gantt-connect-target='in'][data-item-id]"
        ) as HTMLElement | null;
        const targetBar = nodeAtPointer?.closest(
          "[data-gantt-bar-item-id]"
        ) as HTMLElement | null;
        const targetItemId =
          targetElement?.dataset.itemId ??
          targetBar?.dataset.ganttBarItemId ??
          null;
        if (targetItemId && targetItemId !== activeConnection.sourceItemId) {
          const point =
            clientToTimelinePoint(event.clientX, event.clientY) ?? {
              x: activeConnection.currentX,
              y: activeConnection.currentY,
            };
          void createDependencyAndOpenEditor(
            activeConnection.sourceItemId,
            targetItemId,
            point
          );
        }
      }

      if (activeGesture) {
        void commitBarGesture(activeGesture, event.clientX, didMove);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [
    barGesture,
    clientToTimelinePoint,
    commitBarGesture,
    computeGesturePreview,
    connectionDrag,
    createDependencyAndOpenEditor,
  ]);

  const handleConnectStart = useCallback(
    (event: ReactPointerEvent<HTMLElement>, itemId: string) => {
      if (!isAltPressed || event.button !== 0) {
        return;
      }
      const position = rowPositionMap.get(itemId);
      if (!position || position.endX === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const point = clientToTimelinePoint(event.clientX, event.clientY);
      setEdgeEditor(null);
      setConnectionDrag({
        sourceItemId: itemId,
        sourceX: position.endX,
        sourceY: position.y,
        currentX: point?.x ?? position.endX,
        currentY: point?.y ?? position.y,
      });
    },
    [clientToTimelinePoint, isAltPressed, rowPositionMap]
  );

  const startBarGesture = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      item: GanttItem,
      hasChildren: boolean,
      range: { start: number | null; end: number | null },
      kind: BarGesture["kind"]
    ) => {
      if (event.button !== 0 || isAltPressed) {
        return;
      }
      if (range.start === null || range.end === null) {
        return;
      }
      const isLeafTask = item.item_type === "task" && !hasChildren;
      if ((kind === "resize-start" || kind === "resize-end") && !isLeafTask) {
        return;
      }
      const block = blockByItemId.get(item.id) ?? null;
      if (isLeafTask && !block) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setEdgeEditor(null);
      dragMovedRef.current = false;
      setBarGesture({
        itemId: item.id,
        isLeafTask,
        blockId: block?.block_id ?? null,
        kind,
        pointerStartX: event.clientX,
        initialStart: range.start,
        initialEnd: range.end,
      });
      setDragPreview({
        itemId: item.id,
        start: range.start,
        end: range.end,
      });
    },
    [blockByItemId, isAltPressed]
  );

  const handleTimelineScroll = useCallback(() => {
    if (!headerScrollRef.current || !bodyScrollRef.current) {
      return;
    }
    headerScrollRef.current.scrollLeft = bodyScrollRef.current.scrollLeft;
  }, []);

  const handleTimelineWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
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

  const edgeGeometries = useMemo(() => {
    return edges
      .map((edge) => {
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
          edge.type === "SS" || edge.type === "SF" ? start.startX : start.endX;
        const toX = edge.type === "FF" || edge.type === "SF" ? end.endX : end.startX;
        if (!Number.isFinite(fromX) || !Number.isFinite(toX)) {
          return null;
        }
        const elbowX = fromX + (toX >= fromX ? 16 : -16);
        const path = `M ${fromX} ${start.y} L ${elbowX} ${start.y} L ${elbowX} ${end.y} L ${toX} ${end.y}`;
        const popoverX = (elbowX + toX) / 2;
        const popoverY = (start.y + end.y) / 2;
        return {
          edge,
          path,
          popoverX,
          popoverY,
        };
      })
      .filter((value): value is { edge: GanttEdge; path: string; popoverX: number; popoverY: number } => value !== null);
  }, [edges, rowPositionMap]);

  const connectionPath = useMemo(() => {
    if (!connectionDrag) {
      return null;
    }
    const elbowX =
      connectionDrag.sourceX +
      (connectionDrag.currentX >= connectionDrag.sourceX ? 16 : -16);
    return `M ${connectionDrag.sourceX} ${connectionDrag.sourceY} L ${elbowX} ${connectionDrag.sourceY} L ${elbowX} ${connectionDrag.currentY} L ${connectionDrag.currentX} ${connectionDrag.currentY}`;
  }, [connectionDrag]);

  const edgeEditorPosition = useMemo(() => {
    if (!edgeEditor) {
      return null;
    }
    const left = Math.max(8, Math.min(timelineWidth - 260, edgeEditor.x + 10));
    const top = Math.max(4, edgeEditor.y - 42);
    return { left, top };
  }, [edgeEditor, timelineWidth]);

  return (
    <div
      className={[
        "gantt-root",
        isAltPressed ? "is-alt-pressed" : "",
        barGesture || connectionDrag ? "is-gesture-active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="gantt-toolbar">
        <div className="gantt-toolbar-left">
          <SegmentedControl.Root
            value={viewMode}
            onValueChange={(value) => setViewMode(value as ViewMode)}
          >
            <SegmentedControl.Item value="week">Week</SegmentedControl.Item>
            <SegmentedControl.Item value="month">Month</SegmentedControl.Item>
            <SegmentedControl.Item value="quarter">Quarter</SegmentedControl.Item>
          </SegmentedControl.Root>
        </div>
        <div className="gantt-toolbar-right">
          <span className="gantt-toolbar-tip">
            Hold Alt/Option to show dependency handles
          </span>
        </div>
      </div>

      {edgeEditor ? (
        <div className="gantt-edge-editor-inline">
          <span>
            Editing dependency:{" "}
            {itemMap.get(edges.find((edge) => edge.edge_id === edgeEditor.edgeId)?.predecessor_id ?? "")
              ?.title ?? "Item"}
            {" -> "}
            {itemMap.get(edges.find((edge) => edge.edge_id === edgeEditor.edgeId)?.successor_id ?? "")
              ?.title ?? "Item"}
          </span>
        </div>
      ) : null}

      {error ? <div className="error">{error}</div> : null}
      {loading && !hasLoadedOnce ? <div className="loading">Loading…</div> : null}
      {isRefreshing ? <div className="view-refreshing">Refreshing…</div> : null}

      <div className="gantt-grid">
        <div className="gantt-header">
          <div className="gantt-label-header">Item</div>
          <div
            className="gantt-timeline-scroll gantt-timeline-scroll--header"
            ref={headerScrollRef}
          >
            <div className="gantt-timeline-header" style={{ width: timelineWidth }}>
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
            onPointerDown={() => {
              if (!barGesture && !connectionDrag) {
                setEdgeEditor(null);
              }
            }}
          >
            <div
              className="gantt-timeline"
              style={{ width: timelineWidth, height: totalHeight }}
            >
              <svg className="gantt-lines" width={timelineWidth} height={totalHeight}>
                {edgeGeometries.map(({ edge, path, popoverX, popoverY }) => (
                  <g key={edge.edge_id}>
                    <path
                      d={path}
                      className={
                        edgeEditor?.edgeId === edge.edge_id
                          ? "gantt-edge-line is-selected"
                          : "gantt-edge-line"
                      }
                    />
                    <path
                      d={path}
                      className="gantt-edge-hit"
                      onClick={(event) => {
                        event.stopPropagation();
                        setEdgeEditor({
                          edgeId: edge.edge_id,
                          type: edge.type,
                          lagMinutes: edge.lag_minutes,
                          x: popoverX,
                          y: popoverY,
                        });
                      }}
                    />
                  </g>
                ))}
                {connectionPath ? (
                  <path d={connectionPath} className="gantt-edge-preview" />
                ) : null}
              </svg>

              {edgeEditor && edgeEditorPosition ? (
                <div
                  className="gantt-edge-popover"
                  style={edgeEditorPosition}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <label>
                    Type
                    <AppSelect
                      value={edgeEditor.type}
                      onChange={(value) =>
                        setEdgeEditor((prev) =>
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
                      value={edgeEditor.lagMinutes}
                      onChange={(event) =>
                        setEdgeEditor((prev) =>
                          prev
                            ? {
                                ...prev,
                                lagMinutes: Math.max(
                                  0,
                                  Number(event.currentTarget.value || 0)
                                ),
                              }
                            : prev
                        )
                      }
                    />
                  </label>
                  <div className="gantt-edge-popover-actions">
                    <AppButton type="button" size="1" onClick={handleSaveEdge}>
                      Save
                    </AppButton>
                    <AppButton
                      type="button"
                      size="1"
                      variant="surface"
                      onClick={handleDeleteEdge}
                    >
                      Delete
                    </AppButton>
                    <AppButton
                      type="button"
                      size="1"
                      variant="ghost"
                      onClick={() => setEdgeEditor(null)}
                    >
                      Close
                    </AppButton>
                  </div>
                </div>
              ) : null}

              {visibleRows.map((row, index) => {
                const item = row.item;
                const hasChildren = (childMap.get(item.id) ?? []).length > 0;
                const baseRange = getBarRange(item, hasChildren);
                const range =
                  dragPreview && dragPreview.itemId === item.id
                    ? {
                        start: dragPreview.start,
                        end: dragPreview.end,
                      }
                    : baseRange;
                const start = range.start !== null ? toX(range.start) : null;
                const end = range.end !== null ? toX(range.end) : null;
                const width =
                  start !== null && end !== null
                    ? Math.max(MIN_BAR_WIDTH, end - start)
                    : 0;
                const dueX = item.due_at !== null ? toX(item.due_at) : null;
                const rowTop = index * ROW_HEIGHT;
                const isLeafTask = item.item_type === "task" && !hasChildren;
                const isDragging = barGesture?.itemId === item.id;
                return (
                  <div
                    key={item.id}
                    className="gantt-row"
                    style={{ top: rowTop, height: ROW_HEIGHT }}
                  >
                    {start !== null && end !== null ? (
                      <button
                        type="button"
                        className={isDragging ? "gantt-bar is-dragging" : "gantt-bar"}
                        style={{
                          left: start,
                          width,
                        }}
                        data-gantt-bar-item-id={item.id}
                        onPointerDown={(event) =>
                          startBarGesture(event, item, hasChildren, baseRange, "move")
                        }
                      >
                        <span className="gantt-bar-title">{item.title}</span>

                        {isLeafTask ? (
                          <>
                            <span
                              className="gantt-resize-handle gantt-resize-handle--start"
                              onPointerDown={(event) =>
                                startBarGesture(
                                  event,
                                  item,
                                  hasChildren,
                                  baseRange,
                                  "resize-start"
                                )
                              }
                            />
                            <span
                              className="gantt-resize-handle gantt-resize-handle--end"
                              onPointerDown={(event) =>
                                startBarGesture(
                                  event,
                                  item,
                                  hasChildren,
                                  baseRange,
                                  "resize-end"
                                )
                              }
                            />
                          </>
                        ) : null}

                        {isAltPressed ? (
                          <>
                            <span
                              className="gantt-connect-handle gantt-connect-handle--in"
                              data-gantt-connect-target="in"
                              data-item-id={item.id}
                              onPointerDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                            />
                            <span
                              className="gantt-connect-handle gantt-connect-handle--out"
                              data-item-id={item.id}
                              onPointerDown={(event) => handleConnectStart(event, item.id)}
                            />
                          </>
                        ) : null}
                      </button>
                    ) : (
                      <span className="gantt-unscheduled">—</span>
                    )}

                    {dueX !== null && dueX >= 0 && dueX <= timelineWidth ? (
                      <button
                        type="button"
                        className="gantt-due-marker"
                        style={{ left: dueX }}
                        onClick={(event) => {
                          if (
                            event.altKey &&
                            event.shiftKey &&
                            !event.ctrlKey &&
                            !event.metaKey
                          ) {
                            if (item.item_type !== "task") {
                              return;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            void handleDeleteItem(item.id);
                            return;
                          }
                          onOpenItem(item.id);
                        }}
                      >
                        <span className="gantt-due-dot" />
                        <span className="gantt-due-label">{item.title}</span>
                      </button>
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
