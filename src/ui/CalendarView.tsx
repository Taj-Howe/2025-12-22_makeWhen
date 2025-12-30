import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { mutate, query } from "../rpc/clientSingleton";
import { UNGROUPED_PROJECT_ID } from "./constants";
import type { ListItem } from "../domain/listTypes";

type CalendarViewProps = {
  selectedProjectId: string | null;
  projectItems: ListItem[];
  refreshToken: number;
  onRefresh: () => void;
  onOpenItem: (itemId: string) => void;
};

type CalendarBlock = {
  block_id: string;
  item_id: string;
  start_at: number;
  duration_minutes: number;
};

type CalendarItem = {
  id: string;
  title: string;
  status: string;
  due_at: number | null;
  parent_id: string | null;
  item_type: string;
  priority: number;
};

type CalendarRangeResult = {
  blocks: CalendarBlock[];
  items: CalendarItem[];
};

const HOURS_START = 6;
const HOURS_END = 20;
const HOUR_HEIGHT = 48;
const DAY_LABEL = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const DAY_NUMBER = new Intl.DateTimeFormat(undefined, { day: "numeric" });
const TIME_LABEL = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const startOfDay = (value: Date) => {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
};

const addDays = (value: Date, days: number) => {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
};

const startOfWeek = (value: Date) => {
  const next = startOfDay(value);
  const day = next.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  next.setDate(next.getDate() + diff);
  return next;
};

const CalendarView: FC<CalendarViewProps> = ({
  selectedProjectId,
  projectItems,
  refreshToken,
  onRefresh,
  onOpenItem,
}) => {
  const [blocks, setBlocks] = useState<CalendarBlock[]>([]);
  const [dueItems, setDueItems] = useState<CalendarItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"week" | "month">("week");
  const [focusDate, setFocusDate] = useState(() => new Date());
  const [selection, setSelection] = useState<{
    dayKey: string;
    dayStartMs: number;
    startMinutes: number;
    endMinutes: number;
  } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [dragBlock, setDragBlock] = useState<{
    blockId: string;
    mode: "move" | "resize";
    startAt: number;
    durationMinutes: number;
    dayKey: string;
    dayStartMs: number;
    offsetMinutes: number;
    startMinutes: number;
  } | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    blockId: string;
    start_at: number;
    duration_minutes: number;
  } | null>(null);
  const [dragCandidate, setDragCandidate] = useState<{
    block: CalendarBlock;
    dayStartMs: number;
    dayKey: string;
    startX: number;
    startY: number;
    offsetMinutes: number;
    startMinutes: number;
  } | null>(null);
  const selectionRef = useRef<{
    dayKey: string;
    dayStartMs: number;
    anchorMinutes: number;
    rectTop: number;
    rectHeight: number;
    startMinutes: number;
    endMinutes: number;
  } | null>(null);
  const dragPreviewRef = useRef<{
    blockId: string;
    start_at: number;
    duration_minutes: number;
  } | null>(null);
  const dragClickGuardRef = useRef(false);
  const contextMenuOpenRef = useRef(false);
  const suppressOpenUntilRef = useRef(0);
  const suppressNextBlockClickRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);

  const itemTitleMap = useMemo(
    () => new Map(projectItems.map((item) => [item.id, item.title])),
    [projectItems]
  );

  const projectItemIds = useMemo(
    () => new Set(projectItems.map((item) => item.id)),
    [projectItems]
  );

  const projectItemMap = useMemo(
    () => new Map(projectItems.map((item) => [item.id, item])),
    [projectItems]
  );

  const range = useMemo(() => {
    if (viewMode === "week") {
      const start = startOfWeek(focusDate);
      const end = addDays(start, 7);
      return { start, end, days: Array.from({ length: 7 }, (_, i) => addDays(start, i)) };
    }
    const monthStart = new Date(focusDate.getFullYear(), focusDate.getMonth(), 1);
    const gridStart = startOfWeek(monthStart);
    const gridEnd = addDays(gridStart, 42);
    return {
      start: gridStart,
      end: gridEnd,
      days: Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)),
    };
  }, [focusDate, viewMode]);

  useEffect(() => {
    if (!selectedProjectId) {
      setBlocks([]);
      setDueItems([]);
      setError(null);
      return;
    }
    let isMounted = true;
    setLoading(true);
    setError(null);
    const scopeProjectId =
      selectedProjectId === UNGROUPED_PROJECT_ID ? undefined : selectedProjectId;
    query<CalendarRangeResult>("calendar_range", {
      time_min: range.start.getTime(),
      time_max: range.end.getTime(),
      ...(scopeProjectId ? { scopeProjectId } : {}),
    })
      .then((result) => {
        if (!isMounted) {
          return;
        }
        const nextBlocks =
          scopeProjectId || selectedProjectId === UNGROUPED_PROJECT_ID
            ? result.blocks.filter((block) =>
                projectItemIds.has(block.item_id)
              )
            : result.blocks;
        const nextItems =
          scopeProjectId || selectedProjectId === UNGROUPED_PROJECT_ID
            ? result.items.filter((item) => projectItemIds.has(item.id))
            : result.items;
        setBlocks(nextBlocks);
        setDueItems(nextItems);
      })
      .catch((err) => {
        if (!isMounted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      })
      .finally(() => {
        if (isMounted) {
          setLoading(false);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [projectItemIds, range.end, range.start, refreshToken, selectedProjectId]);

  const handlePrev = () => {
    if (viewMode === "week") {
      setFocusDate((prev) => addDays(prev, -7));
      return;
    }
    setFocusDate(
      (prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1)
    );
  };

  const handleNext = () => {
    if (viewMode === "week") {
      setFocusDate((prev) => addDays(prev, 7));
      return;
    }
    setFocusDate(
      (prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1)
    );
  };

  const handleToday = () => setFocusDate(new Date());

  const displayBlocks = useMemo(() => {
    if (!dragPreview) {
      return blocks;
    }
    return blocks.map((block) =>
      block.block_id === dragPreview.blockId
        ? {
            ...block,
            start_at: dragPreview.start_at,
            duration_minutes: dragPreview.duration_minutes,
          }
        : block
    );
  }, [blocks, dragPreview]);

  if (!selectedProjectId) {
    return <div className="calendar-view">Select a project</div>;
  }

  const dayKey = (value: Date) => value.toISOString().slice(0, 10);

  const blocksByDay = new Map<string, CalendarBlock[]>();
  const dueByDay = new Map<string, CalendarItem[]>();

  for (const block of displayBlocks) {
    const key = dayKey(new Date(block.start_at));
    const list = blocksByDay.get(key) ?? [];
    list.push(block);
    blocksByDay.set(key, list);
  }

  for (const item of dueItems) {
    if (!item.due_at) {
      continue;
    }
    const key = dayKey(new Date(item.due_at));
    const list = dueByDay.get(key) ?? [];
    list.push(item);
    dueByDay.set(key, list);
  }

  const hourCount = HOURS_END - HOURS_START;
  const pxPerMinute = HOUR_HEIGHT / 60;
  const nowMs = Date.now();

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (viewMode === "week") {
      return;
    }
    selectionRef.current = null;
    setSelection(null);
    setIsSelecting(false);
    setDragBlock(null);
    setDragPreview(null);
  }, [viewMode]);

  const clampMinutes = (value: number) => {
    const min = HOURS_START * 60;
    const max = HOURS_END * 60;
    return Math.min(max, Math.max(min, value));
  };

  const snapMinutes = (value: number) => Math.round(value / 15) * 15;

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      onRefresh();
    }, 200);
  }, [onRefresh]);

  const handleDeleteBlock = useCallback(
    async (blockId: string) => {
      setError(null);
      try {
        await mutate("scheduled_block.delete", { block_id: blockId });
        scheduleRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [scheduleRefresh]
  );

  const handleDuplicateTask = useCallback(
    async (itemId: string) => {
      const item = projectItemMap.get(itemId);
      if (!item) {
        return;
      }
      setError(null);
      try {
        const estimateMode =
          item.estimate_mode ?? (item.type === "task" ? "manual" : "rollup");
        await mutate("create_item", {
          type: item.type,
          title: `${item.title} (copy)`,
          parent_id: item.parent_id,
          due_at: item.due_at ?? null,
          estimate_mode: estimateMode,
          estimate_minutes: item.estimate_minutes ?? 0,
          status: item.status,
          priority: item.priority ?? 0,
          notes: item.notes ?? null,
        });
        scheduleRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [projectItemMap, scheduleRefresh]
  );

  const updateDragPreview = (next: {
    blockId: string;
    start_at: number;
    duration_minutes: number;
  }) => {
    dragPreviewRef.current = next;
    setDragPreview(next);
  };

  const getDayContextFromPoint = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y) as HTMLElement | null;
    const dayBody = element?.closest?.(".calendar-day-body") as
      | HTMLElement
      | null;
    if (!dayBody) {
      return null;
    }
    const dayStart = Number(dayBody.dataset.dayStart);
    const dayKeyValue = dayBody.dataset.dayKey ?? null;
    if (!Number.isFinite(dayStart) || !dayKeyValue) {
      return null;
    }
    return {
      dayStartMs: dayStart,
      dayKey: dayKeyValue,
      rect: dayBody.getBoundingClientRect(),
    };
  };

  const createTaskWithBlock = useCallback(
    async (startAt: number, durationMinutes: number) => {
      if (!selectedProjectId) {
        return;
      }
      const parentId =
        selectedProjectId === UNGROUPED_PROJECT_ID ? null : selectedProjectId;
      setError(null);
      try {
        const created = await mutate<{ id: string }>("create_item", {
          type: "task",
          title: "New task",
          parent_id: parentId,
          due_at: null,
          estimate_mode: "manual",
          estimate_minutes: Math.max(15, Math.round(durationMinutes)),
          status: "ready",
          priority: 0,
        });
        const itemId = created?.id;
        if (!itemId) {
          throw new Error("Failed to create task");
        }
        await mutate("scheduled_block.create", {
          item_id: itemId,
          start_at: startAt,
          duration_minutes: Math.max(15, Math.round(durationMinutes)),
          source: "manual",
        });
        scheduleRefresh();
        onOpenItem(itemId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [onOpenItem, scheduleRefresh, selectedProjectId]
  );

  const beginBlockDrag = useCallback(
    (
      block: CalendarBlock,
      dayStartMs: number,
      dayKeyValue: string,
      mode: "move" | "resize",
      event: ReactMouseEvent
    ) => {
      if (event.button !== 0 || event.ctrlKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dragClickGuardRef.current = true;
      const dayBody = (event.currentTarget as HTMLElement).closest(
        ".calendar-day-body"
      ) as HTMLElement | null;
      const rect = dayBody?.getBoundingClientRect();
      const blockStartMinutes = (block.start_at - dayStartMs) / 60000;
      const pointerMinutes = rect
        ? HOURS_START * 60 + (event.clientY - rect.top) / pxPerMinute
        : blockStartMinutes;
      const offsetMinutes =
        mode === "move" ? pointerMinutes - blockStartMinutes : 0;
      setDragBlock({
        blockId: block.block_id,
        mode,
        startAt: block.start_at,
        durationMinutes: block.duration_minutes,
        dayKey: dayKeyValue,
        dayStartMs,
        offsetMinutes,
        startMinutes: blockStartMinutes,
      });
      updateDragPreview({
        blockId: block.block_id,
        start_at: block.start_at,
        duration_minutes: block.duration_minutes,
      });
      selectionRef.current = null;
      setSelection(null);
      setIsSelecting(false);
    },
    [pxPerMinute, updateDragPreview]
  );

  const handleBlockPress = useCallback(
    (block: CalendarBlock, dayStartMs: number, dayKeyValue: string) =>
      (event: ReactMouseEvent) => {
        if (event.button !== 0 || event.ctrlKey) {
          return;
        }
        if (dragBlock) {
          return;
        }
        event.preventDefault();
        const dayBody = (event.currentTarget as HTMLElement).closest(
          ".calendar-day-body"
        ) as HTMLElement | null;
        const rect = dayBody?.getBoundingClientRect();
        const blockStartMinutes = (block.start_at - dayStartMs) / 60000;
        const pointerMinutes = rect
          ? HOURS_START * 60 + (event.clientY - rect.top) / pxPerMinute
          : blockStartMinutes;
        const offsetMinutes = pointerMinutes - blockStartMinutes;
        dragClickGuardRef.current = false;
        setDragCandidate({
          block,
          dayStartMs,
          dayKey: dayKeyValue,
          startX: event.clientX,
          startY: event.clientY,
          offsetMinutes,
          startMinutes: blockStartMinutes,
        });
        updateDragPreview({
          blockId: block.block_id,
          start_at: block.start_at,
          duration_minutes: block.duration_minutes,
        });
      },
    [dragBlock, pxPerMinute, updateDragPreview]
  );

  const handleBlockClick = useCallback(
    (itemId: string) => (event: ReactMouseEvent) => {
      if (event.ctrlKey || event.metaKey) {
        return;
      }
      if (dragClickGuardRef.current || dragBlock) {
        return;
      }
      if (contextMenuOpenRef.current) {
        return;
      }
      if (Date.now() < suppressOpenUntilRef.current) {
        return;
      }
      if (suppressNextBlockClickRef.current) {
        suppressNextBlockClickRef.current = false;
        return;
      }
      setDragCandidate(null);
      dragPreviewRef.current = null;
      setDragPreview(null);
      onOpenItem(itemId);
    },
    [dragBlock, onOpenItem]
  );

  const handleBlockContextMenu = useCallback(() => {
    dragClickGuardRef.current = true;
    suppressOpenUntilRef.current = Date.now() + 200;
    suppressNextBlockClickRef.current = true;
    setDragCandidate(null);
    dragPreviewRef.current = null;
    setDragPreview(null);
  }, []);

  const handleContextMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      contextMenuOpenRef.current = true;
      dragClickGuardRef.current = true;
      suppressOpenUntilRef.current = Date.now() + 200;
      suppressNextBlockClickRef.current = true;
      setDragCandidate(null);
      dragPreviewRef.current = null;
      setDragPreview(null);
      return;
    }
    window.setTimeout(() => {
      contextMenuOpenRef.current = false;
    }, 0);
  }, []);

  const handleSelectStart = useCallback(
    (day: Date) => (event: ReactMouseEvent<HTMLDivElement>) => {
      if (viewMode !== "week") {
        return;
      }
      if (dragBlock) {
        return;
      }
      if (
        contextMenuOpenRef.current ||
        Date.now() < suppressOpenUntilRef.current ||
        suppressNextBlockClickRef.current
      ) {
        suppressNextBlockClickRef.current = false;
        return;
      }
      if (event.button !== 0) {
        return;
      }
    const target = event.target as HTMLElement;
    if (
      target.closest(".calendar-block") ||
      target.closest(".calendar-due-flag")
    ) {
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    const minutesFromStart = HOURS_START * 60 + offsetY / pxPerMinute;
    const snapped = snapMinutes(clampMinutes(minutesFromStart));
    const dayStart = startOfDay(day).getTime();
    selectionRef.current = {
      dayKey: dayKey(day),
      dayStartMs: dayStart,
      anchorMinutes: snapped,
      rectTop: rect.top,
      rectHeight: rect.height,
      startMinutes: snapped,
      endMinutes: snapped + 15,
    };
    setSelection({
      dayKey: dayKey(day),
      dayStartMs: dayStart,
      startMinutes: snapped,
      endMinutes: snapped + 15,
    });
    setIsSelecting(true);
    },
    [clampMinutes, dragBlock, pxPerMinute, snapMinutes, viewMode]
  );

  useEffect(() => {
    if (!isSelecting || !selectionRef.current) {
      return;
    }
    const handleMove = (event: MouseEvent) => {
      const current = selectionRef.current;
      if (!current) {
        return;
      }
      const offsetY = event.clientY - current.rectTop;
      const clampedY = Math.min(
        Math.max(0, offsetY),
        current.rectHeight
      );
      const minutesFromStart = HOURS_START * 60 + clampedY / pxPerMinute;
      const snapped = snapMinutes(clampMinutes(minutesFromStart));
      const start = Math.min(current.anchorMinutes, snapped);
      const end = Math.max(current.anchorMinutes, snapped);
      const safeEnd = Math.max(start + 15, end);
      current.startMinutes = start;
      current.endMinutes = safeEnd;
      setSelection({
        dayKey: current.dayKey,
        dayStartMs: current.dayStartMs,
        startMinutes: start,
        endMinutes: safeEnd,
      });
    };
    const handleUp = () => {
      const current = selectionRef.current;
      if (current) {
        const duration = Math.max(15, current.endMinutes - current.startMinutes);
        const startAt = current.dayStartMs + current.startMinutes * 60000;
        void createTaskWithBlock(startAt, duration);
      }
      selectionRef.current = null;
      setSelection(null);
      setIsSelecting(false);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [createTaskWithBlock, isSelecting, pxPerMinute]);

  useEffect(() => {
    if (!dragBlock) {
      return;
    }
    const handleMove = (event: MouseEvent) => {
      if (dragBlock.mode === "move") {
        const context =
          getDayContextFromPoint(event.clientX, event.clientY) ?? {
            dayStartMs: dragBlock.dayStartMs,
            dayKey: dragBlock.dayKey,
            rect: {
              top: 0,
              height: hourCount * HOUR_HEIGHT,
            } as DOMRect,
          };
        const rect = context.rect;
        const offsetY = event.clientY - rect.top;
        const clampedY = Math.min(
          Math.max(0, offsetY),
          rect.height
        );
        const minutesFromStart = HOURS_START * 60 + clampedY / pxPerMinute;
        let nextStartMinutes = snapMinutes(
          clampMinutes(minutesFromStart - dragBlock.offsetMinutes)
        );
        const maxStart = HOURS_END * 60 - dragBlock.durationMinutes;
        nextStartMinutes = Math.min(
          maxStart,
          Math.max(HOURS_START * 60, nextStartMinutes)
        );
        const startAt = context.dayStartMs + nextStartMinutes * 60000;
        updateDragPreview({
          blockId: dragBlock.blockId,
          start_at: startAt,
          duration_minutes: dragBlock.durationMinutes,
        });
        return;
      }
      const startMinutes = dragBlock.startMinutes;
      const context = getDayContextFromPoint(event.clientX, event.clientY);
      const rect = context?.rect;
      const offsetY = rect ? event.clientY - rect.top : 0;
      const clampedY = Math.min(
        Math.max(0, offsetY),
        (rect?.height ?? hourCount * HOUR_HEIGHT)
      );
      const minutesFromStart = HOURS_START * 60 + clampedY / pxPerMinute;
      let endMinutes = snapMinutes(clampMinutes(minutesFromStart));
      endMinutes = Math.max(startMinutes + 15, endMinutes);
      endMinutes = Math.min(HOURS_END * 60, endMinutes);
      const duration = Math.max(15, endMinutes - startMinutes);
      updateDragPreview({
        blockId: dragBlock.blockId,
        start_at: dragBlock.startAt,
        duration_minutes: duration,
      });
    };
    const handleUp = () => {
      const preview = dragPreviewRef.current;
      if (preview) {
        const changedStart = preview.start_at !== dragBlock.startAt;
        const changedDuration =
          preview.duration_minutes !== dragBlock.durationMinutes;
        if (changedStart || changedDuration) {
          setBlocks((prev) =>
            prev.map((block) =>
              block.block_id === preview.blockId
                ? {
                    ...block,
                    start_at: preview.start_at,
                    duration_minutes: preview.duration_minutes,
                  }
                : block
            )
          );
          void mutate("scheduled_block.update", {
            block_id: dragBlock.blockId,
            start_at: preview.start_at,
            duration_minutes: preview.duration_minutes,
          })
            .then(() => scheduleRefresh())
            .catch((err) => {
              const message =
                err instanceof Error ? err.message : "Unknown error";
              setError(message);
              scheduleRefresh();
            });
        }
      }
      window.setTimeout(() => {
        dragClickGuardRef.current = false;
      }, 0);
      dragPreviewRef.current = null;
      setDragPreview(null);
      setDragBlock(null);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [clampMinutes, dragBlock, hourCount, pxPerMinute, scheduleRefresh, snapMinutes]);

  useEffect(() => {
    if (!dragCandidate) {
      return;
    }
    const handleMove = (event: MouseEvent) => {
      const dx = event.clientX - dragCandidate.startX;
      const dy = event.clientY - dragCandidate.startY;
      if (Math.hypot(dx, dy) < 4) {
        return;
      }
      dragClickGuardRef.current = true;
      setDragCandidate(null);
      setDragBlock({
        blockId: dragCandidate.block.block_id,
        mode: "move",
        startAt: dragCandidate.block.start_at,
        durationMinutes: dragCandidate.block.duration_minutes,
        dayKey: dragCandidate.dayKey,
        dayStartMs: dragCandidate.dayStartMs,
        offsetMinutes: dragCandidate.offsetMinutes,
        startMinutes: dragCandidate.startMinutes,
      });
    };
    const handleUp = () => {
      if (!dragCandidate) {
        return;
      }
      if (contextMenuOpenRef.current) {
        return;
      }
      if (Date.now() < suppressOpenUntilRef.current) {
        return;
      }
      if (dragClickGuardRef.current) {
        return;
      }
      setDragCandidate(null);
      dragPreviewRef.current = null;
      setDragPreview(null);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [dragCandidate, onOpenItem]);

  const handleOpenKey = useCallback(
    (itemId: string) => (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpenItem(itemId);
      }
    },
    [onOpenItem]
  );

  return (
    <div className="calendar-view">
      {error ? <div className="error">{error}</div> : null}
      <div className="calendar-toolbar">
        <div className="calendar-nav">
          <button type="button" className="button" onClick={handlePrev}>
            Prev
          </button>
          <button type="button" className="button" onClick={handleToday}>
            Today
          </button>
          <button type="button" className="button" onClick={handleNext}>
            Next
          </button>
        </div>
        <div className="calendar-toggle">
          <button
            type="button"
            className={
              viewMode === "week"
                ? "calendar-toggle-button calendar-toggle-active"
                : "calendar-toggle-button"
            }
            onClick={() => setViewMode("week")}
          >
            Week
          </button>
          <button
            type="button"
            className={
              viewMode === "month"
                ? "calendar-toggle-button calendar-toggle-active"
                : "calendar-toggle-button"
            }
            onClick={() => setViewMode("month")}
          >
            Month
          </button>
        </div>
      </div>
      {loading && blocks.length === 0 && dueItems.length === 0 ? (
        <div className="list-empty">Loading…</div>
      ) : null}
      {viewMode === "week" ? (
        <div className="calendar-week">
          <div className="calendar-time-col" style={{ paddingTop: 28 }}>
            {Array.from({ length: hourCount + 1 }).map((_, idx) => {
              const hour = HOURS_START + idx;
              const labelDate = new Date();
              labelDate.setHours(hour, 0, 0, 0);
              return (
                <div
                  key={`hour-${hour}`}
                  className="calendar-time-slot"
                  style={{ height: HOUR_HEIGHT }}
                >
                  {TIME_LABEL.format(labelDate)}
                </div>
              );
            })}
          </div>
          <div className="calendar-week-days">
            {range.days.map((day) => {
              const key = dayKey(day);
              const dayBlocks = blocksByDay.get(key) ?? [];
              const dayDue = dueByDay.get(key) ?? [];
              const dayStart = startOfDay(day).getTime();
              const selectionForDay =
                selection && selection.dayKey === key ? selection : null;
              return (
                <div key={key} className="calendar-day-col">
                  <div className="calendar-day-header">{DAY_LABEL.format(day)}</div>
                  <div
                    className="calendar-day-body"
                    style={{ height: hourCount * HOUR_HEIGHT }}
                    onMouseDown={handleSelectStart(day)}
                    data-day-key={key}
                    data-day-start={dayStart}
                  >
                    {selectionForDay ? (
                      <div
                        className="calendar-selection"
                        style={{
                          top:
                            (selectionForDay.startMinutes - HOURS_START * 60) *
                            pxPerMinute,
                          height: Math.max(
                            18,
                            (selectionForDay.endMinutes -
                              selectionForDay.startMinutes) *
                              pxPerMinute
                          ),
                        }}
                      >
                        New task
                      </div>
                    ) : null}
                    {dayDue.map((item) => {
                      if (!item.due_at) {
                        return null;
                      }
                      const minutesFromDayStart =
                        (item.due_at - dayStart) / 60000;
                      const isOverdue =
                        item.due_at < nowMs &&
                        item.status !== "done" &&
                        item.status !== "canceled";
                      const outsideHours =
                        minutesFromDayStart < HOURS_START * 60 ||
                        minutesFromDayStart > HOURS_END * 60;
                      const top = outsideHours
                        ? 4
                        : (minutesFromDayStart - HOURS_START * 60) * pxPerMinute;
                      return (
                        <div
                          key={`due-${item.id}`}
                          className={
                            isOverdue
                              ? "calendar-due-flag is-overdue"
                              : "calendar-due-flag"
                          }
                          style={{ top }}
                          title={item.title}
                          role="button"
                          tabIndex={0}
                          onClick={() => onOpenItem(item.id)}
                          onKeyDown={handleOpenKey(item.id)}
                        >
                          {outsideHours ? "Due" : "Due:"} {item.title}
                        </div>
                      );
                    })}
                    {dayBlocks.map((block) => {
                      const blockStartMinutes =
                        (block.start_at - dayStart) / 60000;
                      const blockEndMinutes =
                        blockStartMinutes + block.duration_minutes;
                      const visibleStart = Math.max(
                        blockStartMinutes,
                        HOURS_START * 60
                      );
                      const visibleEnd = Math.min(
                        blockEndMinutes,
                        HOURS_END * 60
                      );
                      if (visibleEnd <= visibleStart) {
                        return null;
                      }
                      const top =
                        (visibleStart - HOURS_START * 60) * pxPerMinute;
                      const height = Math.max(
                        18,
                        (visibleEnd - visibleStart) * pxPerMinute
                      );
                      const labelTime = TIME_LABEL.format(
                        new Date(block.start_at)
                      );
                      const title =
                        itemTitleMap.get(block.item_id) ?? block.item_id;
                      return (
                        <ContextMenu.Root
                          key={block.block_id}
                          onOpenChange={handleContextMenuOpenChange}
                        >
                          <ContextMenu.Trigger asChild>
                            <div
                              className="calendar-block"
                              style={{ top, height }}
                              role="button"
                              tabIndex={0}
                              onMouseDown={handleBlockPress(block, dayStart, key)}
                              onContextMenu={handleBlockContextMenu}
                              onClick={handleBlockClick(block.item_id)}
                              onKeyDown={handleOpenKey(block.item_id)}
                            >
                              <div className="calendar-block-title">{title}</div>
                              <div className="calendar-block-meta">
                                {labelTime} · {block.duration_minutes}m
                              </div>
                              <div
                                className="calendar-block-resize"
                                onMouseDown={(event) =>
                                  beginBlockDrag(
                                    block,
                                    dayStart,
                                    key,
                                    "resize",
                                    event
                                  )
                                }
                              />
                            </div>
                          </ContextMenu.Trigger>
                          <ContextMenu.Portal>
                            <ContextMenu.Content className="context-menu-content">
                              <ContextMenu.Item
                                className="context-menu-item"
                                onSelect={() => onOpenItem(block.item_id)}
                              >
                                Edit task
                              </ContextMenu.Item>
                              <ContextMenu.Item
                                className="context-menu-item"
                                onSelect={() => handleDuplicateTask(block.item_id)}
                              >
                                Duplicate task
                              </ContextMenu.Item>
                              <ContextMenu.Item
                                className="context-menu-item"
                                onSelect={() => handleDeleteBlock(block.block_id)}
                              >
                                Delete block
                              </ContextMenu.Item>
                            </ContextMenu.Content>
                          </ContextMenu.Portal>
                        </ContextMenu.Root>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="calendar-month-grid">
          {range.days.map((day) => {
            const key = dayKey(day);
            const dayBlocks = blocksByDay.get(key) ?? [];
            const dayDue = dueByDay.get(key) ?? [];
            const isCurrentMonth = day.getMonth() === focusDate.getMonth();
            return (
              <div
                key={key}
                className={
                  isCurrentMonth
                    ? "calendar-month-cell"
                    : "calendar-month-cell is-outside"
                }
              >
                <div className="calendar-day-number">
                  {DAY_NUMBER.format(day)}
                </div>
                {dayDue.map((item) => (
                  <div
                    key={`due-${item.id}`}
                    className={
                      item.due_at && item.due_at < nowMs && item.status !== "done" && item.status !== "canceled"
                        ? "calendar-month-due is-overdue"
                        : "calendar-month-due"
                    }
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenItem(item.id)}
                    onKeyDown={handleOpenKey(item.id)}
                  >
                    Due: {item.title}
                  </div>
                ))}
                {dayBlocks.map((block) => {
                  const labelTime = TIME_LABEL.format(
                    new Date(block.start_at)
                  );
                  const title =
                    itemTitleMap.get(block.item_id) ?? block.item_id;
                  return (
                    <ContextMenu.Root
                      key={block.block_id}
                      onOpenChange={handleContextMenuOpenChange}
                    >
                      <ContextMenu.Trigger asChild>
                        <div
                          className="calendar-chip"
                          role="button"
                          tabIndex={0}
                          onClick={() => onOpenItem(block.item_id)}
                          onContextMenu={handleBlockContextMenu}
                          onKeyDown={handleOpenKey(block.item_id)}
                        >
                          {labelTime} {title}
                        </div>
                      </ContextMenu.Trigger>
                      <ContextMenu.Portal>
                        <ContextMenu.Content className="context-menu-content">
                          <ContextMenu.Item
                            className="context-menu-item"
                            onSelect={() => onOpenItem(block.item_id)}
                          >
                            Edit task
                          </ContextMenu.Item>
                          <ContextMenu.Item
                            className="context-menu-item"
                            onSelect={() => handleDuplicateTask(block.item_id)}
                          >
                            Duplicate task
                          </ContextMenu.Item>
                          <ContextMenu.Item
                            className="context-menu-item"
                            onSelect={() => handleDeleteBlock(block.block_id)}
                          >
                            Delete block
                          </ContextMenu.Item>
                        </ContextMenu.Content>
                      </ContextMenu.Portal>
                    </ContextMenu.Root>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CalendarView;
