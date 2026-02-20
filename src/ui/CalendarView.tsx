import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { SegmentedControl } from "@radix-ui/themes";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { mutate, query } from "../rpc/clientSingleton";
import { UNGROUPED_PROJECT_ID } from "./constants";
import type { ListItem } from "../domain/listTypes";
import type { Scope } from "../domain/scope";
import {
  DEFAULT_WORKDAY_END_HOUR,
  DEFAULT_WORKDAY_START_HOUR,
  normalizeWorkdayHours,
} from "../domain/workHours";
import { addDays, startOfDay, startOfWeek } from "./dateWindow";
import { AppButton, AppCheckbox } from "./controls";

type CalendarViewProps = {
  scope: Scope;
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
  assignee_id?: string | null;
  assignee_name?: string | null;
};

type CalendarRangeResult = {
  blocks: CalendarBlock[];
  items: CalendarItem[];
};

type SchedulableTask = {
  id: string;
  title: string;
  status: string;
  due_at: number | null;
  estimate_minutes: number;
  priority: number;
  is_blocked: boolean;
  has_blocks: boolean;
};

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
const DUE_TIME_LABEL = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const SHORT_DATE_LABEL = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const dayKey = (value: Date) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(value.getDate()).padStart(2, "0")}`;


const CalendarView: FC<CalendarViewProps> = ({
  scope,
  projectItems,
  refreshToken,
  onRefresh,
  onOpenItem,
}) => {
  const [blocks, setBlocks] = useState<CalendarBlock[]>([]);
  const [calendarItems, setCalendarItems] = useState<CalendarItem[]>([]);
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
  const [statusOverrides, setStatusOverrides] = useState<Record<string, string>>(
    {}
  );
  const [userScopeItems, setUserScopeItems] = useState<ListItem[]>([]);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropDayKey, setDropDayKey] = useState<string | null>(null);
  const [dueDrag, setDueDrag] = useState<{ itemId: string } | null>(null);
  const [dueDraft, setDueDraft] = useState<{
    itemId: string;
    due_at: number;
  } | null>(null);
  const dragTaskRef = useRef<SchedulableTask | null>(null);
  const dueDraftRef = useRef<{ itemId: string; due_at: number } | null>(null);
  const [workStartHour, setWorkStartHour] = useState(
    DEFAULT_WORKDAY_START_HOUR
  );
  const [workEndHour, setWorkEndHour] = useState(DEFAULT_WORKDAY_END_HOUR);

  const itemTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    if (scope.kind === "project") {
      for (const item of projectItems) {
        map.set(item.id, item.title);
      }
    }
    for (const item of calendarItems) {
      map.set(item.id, item.title);
    }
    return map;
  }, [calendarItems, projectItems, scope.kind]);

  const itemStatusMap = useMemo(() => {
    const map = new Map<string, string>();
    if (scope.kind === "project") {
      for (const item of projectItems) {
        map.set(item.id, item.status);
      }
    }
    for (const item of calendarItems) {
      map.set(item.id, item.status);
    }
    for (const [id, status] of Object.entries(statusOverrides)) {
      map.set(id, status);
    }
    return map;
  }, [calendarItems, projectItems, scope.kind, statusOverrides]);

  const projectItemIds = useMemo(() => {
    if (scope.kind !== "project") {
      return new Set<string>();
    }
    return new Set(projectItems.map((item) => item.id));
  }, [projectItems, scope.kind]);

  const projectItemMap = useMemo(
    () => new Map(projectItems.map((item) => [item.id, item])),
    [projectItems]
  );
  const calendarItemMap = useMemo(
    () => new Map(calendarItems.map((item) => [item.id, item])),
    [calendarItems]
  );
  const itemDueMap = useMemo(() => {
    const map = new Map<string, number | null>();
    if (scope.kind === "project") {
      for (const item of projectItems) {
        map.set(item.id, item.due_at ?? null);
      }
    }
    for (const item of calendarItems) {
      map.set(item.id, item.due_at ?? null);
    }
    return map;
  }, [calendarItems, projectItems, scope.kind]);
  const schedulableSourceItems =
    scope.kind === "project" ? projectItems : userScopeItems;
  const unscheduledTasks = useMemo<SchedulableTask[]>(() => {
    const tasks = schedulableSourceItems
      .filter((item) => item.type === "task")
      .filter((item) => item.status !== "done" && item.status !== "canceled")
      .filter((item) => !(item.schedule?.has_blocks ?? false))
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        due_at: item.due_at ?? null,
        estimate_minutes: Math.max(15, Math.round(item.estimate_minutes ?? 0)) || 30,
        priority: item.priority ?? 0,
        is_blocked: Boolean(item.blocked?.is_blocked),
        has_blocks: Boolean(item.schedule?.has_blocks),
      }));
    tasks.sort((a, b) => {
      if (a.is_blocked !== b.is_blocked) {
        return a.is_blocked ? 1 : -1;
      }
      const aDue = a.due_at ?? Number.MAX_SAFE_INTEGER;
      const bDue = b.due_at ?? Number.MAX_SAFE_INTEGER;
      if (aDue !== bDue) {
        return aDue - bDue;
      }
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.title.localeCompare(b.title);
    });
    return tasks;
  }, [schedulableSourceItems]);

  const scopeProjectId = scope.kind === "project" ? scope.projectId : null;
  const scopeUserId = scope.kind === "user" ? scope.userId : null;
  const updateDueDraft = useCallback(
    (next: { itemId: string; due_at: number } | null) => {
      dueDraftRef.current = next;
      setDueDraft(next);
    },
    []
  );

  useEffect(() => {
    if (scope.kind !== "user" || !scopeUserId) {
      setUserScopeItems([]);
      return;
    }
    let isMounted = true;
    query<{ items: ListItem[] }>("listItems", {
      assigneeId: scopeUserId,
      includeDone: false,
      includeCanceled: false,
      orderBy: "due_at",
      orderDir: "asc",
    })
      .then((result) => {
        if (!isMounted) {
          return;
        }
        setUserScopeItems(result.items);
      })
      .catch((err) => {
        if (!isMounted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      });
    return () => {
      isMounted = false;
    };
  }, [refreshToken, scope.kind, scopeUserId]);

  useEffect(() => {
    let isMounted = true;
    query<Record<string, unknown>>("getSettings", {})
      .then((settings) => {
        if (!isMounted) {
          return;
        }
        const normalized = normalizeWorkdayHours(
          settings["ui.workday_start_hour"],
          settings["ui.workday_end_hour"]
        );
        setWorkStartHour(normalized.startHour);
        setWorkEndHour(normalized.endHour);
      })
      .catch(() => {
        if (!isMounted) {
          return;
        }
        setWorkStartHour(DEFAULT_WORKDAY_START_HOUR);
        setWorkEndHour(DEFAULT_WORKDAY_END_HOUR);
      });
    return () => {
      isMounted = false;
    };
  }, [refreshToken]);

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
    if (scope.kind === "project" && !scopeProjectId) {
      setBlocks([]);
      setCalendarItems([]);
      setError(null);
      return;
    }
    if (scope.kind === "user" && !scopeUserId) {
      setBlocks([]);
      setCalendarItems([]);
      setError(null);
      return;
    }
    let isMounted = true;
    setLoading(true);
    setError(null);
    if (scope.kind === "project") {
      const scopedProjectId =
        scopeProjectId === UNGROUPED_PROJECT_ID ? undefined : scopeProjectId;
      query<CalendarRangeResult>("calendar_range", {
        time_min: range.start.getTime(),
        time_max: range.end.getTime(),
        ...(scopedProjectId ? { scopeProjectId: scopedProjectId } : {}),
      })
        .then((result) => {
          if (!isMounted) {
            return;
          }
          const shouldFilter =
            scopedProjectId || scopeProjectId === UNGROUPED_PROJECT_ID;
          const nextBlocks = shouldFilter
            ? result.blocks.filter((block) => projectItemIds.has(block.item_id))
            : result.blocks;
          const nextItems = shouldFilter
            ? result.items.filter((item) => projectItemIds.has(item.id))
            : result.items;
          setBlocks(nextBlocks);
          setCalendarItems(nextItems);
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
    }
    query<CalendarRangeResult>("calendar_range_user", {
      user_id: scopeUserId,
      time_min: range.start.getTime(),
      time_max: range.end.getTime(),
    })
      .then((result) => {
        if (!isMounted) {
          return;
        }
        setBlocks(result.blocks);
        setCalendarItems(result.items);
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
  }, [
    projectItemIds,
    range.end,
    range.start,
    refreshToken,
    scope.kind,
    scopeProjectId,
    scopeUserId,
  ]);

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

  if (scope.kind === "project" && !scopeProjectId) {
    return <div className="calendar-view">Select a project</div>;
  }
  if (scope.kind === "user" && !scopeUserId) {
    return <div className="calendar-view">Select a calendar</div>;
  }

  const blocksByDay = new Map<string, CalendarBlock[]>();
  const dueByDay = new Map<string, CalendarItem[]>();

  for (const block of displayBlocks) {
    const key = dayKey(new Date(block.start_at));
    const list = blocksByDay.get(key) ?? [];
    list.push(block);
    blocksByDay.set(key, list);
  }

  const timeMin = range.start.getTime();
  const timeMax = range.end.getTime();
  const dueItemsById = new Map<string, CalendarItem>();
  for (const item of calendarItems) {
    if (!item.due_at) {
      continue;
    }
    if (item.due_at < timeMin || item.due_at >= timeMax) {
      continue;
    }
    dueItemsById.set(item.id, item);
  }
  if (
    dueDraft &&
    dueDraft.due_at >= timeMin &&
    dueDraft.due_at < timeMax
  ) {
    const existing =
      calendarItemMap.get(dueDraft.itemId) ?? dueItemsById.get(dueDraft.itemId);
    const projectItem =
      scope.kind === "project" ? projectItemMap.get(dueDraft.itemId) : null;
    if (existing) {
      dueItemsById.set(dueDraft.itemId, {
        ...existing,
        due_at: dueDraft.due_at,
      });
    } else if (projectItem) {
      dueItemsById.set(dueDraft.itemId, {
        id: projectItem.id,
        title: projectItem.title,
        status: projectItem.status,
        due_at: dueDraft.due_at,
        parent_id: projectItem.parent_id,
        item_type: projectItem.type,
        priority: projectItem.priority,
        assignee_id: projectItem.assignee_id ?? null,
        assignee_name: projectItem.assignee_name ?? null,
      });
    }
  }
  for (const item of dueItemsById.values()) {
    if (!item.due_at) {
      continue;
    }
    const key = dayKey(new Date(item.due_at));
    const list = dueByDay.get(key) ?? [];
    list.push(item);
    dueByDay.set(key, list);
  }

  const hourCount = workEndHour - workStartHour;
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
    const min = workStartHour * 60;
    const max = workEndHour * 60;
    return Math.min(max, Math.max(min, value));
  };

  const snapMinutes = (value: number) => Math.round(value / 15) * 15;
  const snapDueMinutes = (value: number) => Math.round(value / 5) * 5;

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      onRefresh();
    }, 200);
  }, [onRefresh]);

  const handleToggleDone = useCallback(
    async (itemId: string, checked: boolean) => {
      const nextStatus = checked ? "done" : "ready";
      const prevStatus = itemStatusMap.get(itemId);
      setStatusOverrides((prev) => ({ ...prev, [itemId]: nextStatus }));
      try {
        await mutate("set_status", { id: itemId, status: nextStatus });
        scheduleRefresh();
      } catch (err) {
        setStatusOverrides((prev) => {
          const next = { ...prev };
          if (prevStatus) {
            next[itemId] = prevStatus;
          } else {
            delete next[itemId];
          }
          return next;
        });
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [itemStatusMap, scheduleRefresh]
  );

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
      const item =
        scope.kind === "project"
          ? projectItemMap.get(itemId)
          : calendarItems.find((entry) => entry.id === itemId);
      if (!item) {
        return;
      }
      setError(null);
      try {
        const itemType = "type" in item ? item.type : item.item_type;
        const estimateMode =
          "estimate_mode" in item
            ? item.estimate_mode ?? (itemType === "task" ? "manual" : "rollup")
            : itemType === "task"
              ? "manual"
              : "rollup";
        const created = await mutate<{ id: string }>("create_item", {
          type: itemType,
          title: `${item.title} (copy)`,
          parent_id: item.parent_id,
          due_at: item.due_at ?? null,
          estimate_mode: estimateMode,
          estimate_minutes:
            "estimate_minutes" in item ? item.estimate_minutes ?? 0 : 0,
          status: item.status,
          priority: item.priority ?? 0,
          notes: "notes" in item ? item.notes ?? null : null,
        });
        if (scope.kind === "user" && scopeUserId) {
          const itemIdValue = created?.id;
          if (itemIdValue) {
            await mutate("item.set_assignee", {
              item_id: itemIdValue,
              user_id: scopeUserId,
            });
          }
        }
        scheduleRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [calendarItems, projectItemMap, scheduleRefresh, scope.kind, scopeUserId]
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

  const handleTaskDragStart = useCallback(
    (task: SchedulableTask) => (event: ReactDragEvent<HTMLDivElement>) => {
      dragTaskRef.current = task;
      setDragTaskId(task.id);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
      }
    },
    []
  );

  const handleTaskDragEnd = useCallback(() => {
    dragTaskRef.current = null;
    setDragTaskId(null);
    setDropDayKey(null);
  }, []);

  const handleDayDragOver = useCallback(
    (day: Date) => (event: ReactDragEvent<HTMLDivElement>) => {
      if (!dragTaskRef.current || viewMode !== "week") {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      setDropDayKey(dayKey(day));
    },
    [viewMode]
  );

  const handleDayDragLeave = useCallback(
    (day: Date) => (event: ReactDragEvent<HTMLDivElement>) => {
      if (dropDayKey !== dayKey(day)) {
        return;
      }
      const next = event.relatedTarget as Node | null;
      if (next && (event.currentTarget as HTMLElement).contains(next)) {
        return;
      }
      setDropDayKey(null);
    },
    [dropDayKey]
  );

  const handleDayDrop = useCallback(
    (day: Date) => async (event: ReactDragEvent<HTMLDivElement>) => {
      const task = dragTaskRef.current;
      if (!task || viewMode !== "week") {
        return;
      }
      event.preventDefault();
      setDropDayKey(null);
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const offsetY = event.clientY - rect.top;
      const minutesFromStart = workStartHour * 60 + offsetY / pxPerMinute;
      const snapped = snapMinutes(clampMinutes(minutesFromStart));
      const dayStartMs = startOfDay(day).getTime();
      const startAt = dayStartMs + snapped * 60000;
      const durationMinutes =
        Number.isFinite(task.estimate_minutes) && task.estimate_minutes > 0
          ? Math.max(15, Math.round(task.estimate_minutes))
          : 30;
      setError(null);
      try {
        await mutate("scheduled_block.create", {
          item_id: task.id,
          start_at: startAt,
          duration_minutes: durationMinutes,
          source: "manual",
        });
        scheduleRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [clampMinutes, pxPerMinute, scheduleRefresh, snapMinutes, viewMode]
  );

  const beginDueDrag = useCallback(
    (block: CalendarBlock, event: ReactMouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || viewMode !== "week") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dragClickGuardRef.current = true;
      setDragCandidate(null);
      setDragBlock(null);
      const fallbackDue = block.start_at + block.duration_minutes * 60000;
      const currentDue = itemDueMap.get(block.item_id);
      setDueDrag({ itemId: block.item_id });
      updateDueDraft({
        itemId: block.item_id,
        due_at: currentDue ?? fallbackDue,
      });
      document.body.style.userSelect = "none";
    },
    [itemDueMap, updateDueDraft, viewMode]
  );

  const createTaskWithBlock = useCallback(
    async (startAt: number, durationMinutes: number) => {
      if (scope.kind === "project" && !scopeProjectId) {
        return;
      }
      const parentId =
        scope.kind === "project"
          ? scopeProjectId === UNGROUPED_PROJECT_ID
            ? null
            : scopeProjectId
          : null;
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
        if (scope.kind === "user" && scopeUserId) {
          await mutate("item.set_assignee", {
            item_id: itemId,
            user_id: scopeUserId,
          });
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
    [onOpenItem, scheduleRefresh, scope.kind, scopeProjectId, scopeUserId]
  );

  const beginBlockDrag = useCallback(
    (
      block: CalendarBlock,
      dayStartMs: number,
      dayKeyValue: string,
      mode: "move" | "resize",
      event: ReactMouseEvent
    ) => {
      if (event.button !== 0 || event.ctrlKey || dueDrag) {
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
        ? workStartHour * 60 + (event.clientY - rect.top) / pxPerMinute
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
    [dueDrag, pxPerMinute, updateDragPreview]
  );

  const handleBlockPress = useCallback(
    (block: CalendarBlock, dayStartMs: number, dayKeyValue: string) =>
      (event: ReactMouseEvent) => {
        if (event.button !== 0 || event.ctrlKey) {
          return;
        }
        if (dragBlock || dueDrag) {
          return;
        }
        event.preventDefault();
        const dayBody = (event.currentTarget as HTMLElement).closest(
          ".calendar-day-body"
        ) as HTMLElement | null;
        const rect = dayBody?.getBoundingClientRect();
        const blockStartMinutes = (block.start_at - dayStartMs) / 60000;
        const pointerMinutes = rect
          ? workStartHour * 60 + (event.clientY - rect.top) / pxPerMinute
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
    [dragBlock, dueDrag, pxPerMinute, updateDragPreview]
  );

  const handleBlockClick = useCallback(
    (itemId: string) => (event: ReactMouseEvent) => {
      if (event.ctrlKey || event.metaKey) {
        return;
      }
      if (dragClickGuardRef.current || dragBlock || dueDrag) {
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
    [dragBlock, dueDrag, onOpenItem]
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
      if (dragBlock || dueDrag) {
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
    const minutesFromStart = workStartHour * 60 + offsetY / pxPerMinute;
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
    [clampMinutes, dragBlock, dueDrag, pxPerMinute, snapMinutes, viewMode]
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
      const minutesFromStart = workStartHour * 60 + clampedY / pxPerMinute;
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
        const minutesFromStart = workStartHour * 60 + clampedY / pxPerMinute;
        let nextStartMinutes = snapMinutes(
          clampMinutes(minutesFromStart - dragBlock.offsetMinutes)
        );
        const maxStart = workEndHour * 60 - dragBlock.durationMinutes;
        nextStartMinutes = Math.min(
          maxStart,
          Math.max(workStartHour * 60, nextStartMinutes)
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
      const minutesFromStart = workStartHour * 60 + clampedY / pxPerMinute;
      let endMinutes = snapMinutes(clampMinutes(minutesFromStart));
      endMinutes = Math.max(startMinutes + 15, endMinutes);
      endMinutes = Math.min(workEndHour * 60, endMinutes);
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

  useEffect(() => {
    if (!dueDrag) {
      return;
    }
    const handleMove = (event: MouseEvent) => {
      const context = getDayContextFromPoint(event.clientX, event.clientY);
      if (!context) {
        return;
      }
      const offsetY = event.clientY - context.rect.top;
      const clampedY = Math.min(Math.max(0, offsetY), context.rect.height);
      const minutesFromStart = workStartHour * 60 + clampedY / pxPerMinute;
      const snapped = snapDueMinutes(clampMinutes(minutesFromStart));
      const dueAt = context.dayStartMs + snapped * 60000;
      updateDueDraft({
        itemId: dueDrag.itemId,
        due_at: dueAt,
      });
    };
    const handleUp = () => {
      const draft = dueDraftRef.current;
      document.body.style.userSelect = "";
      setDueDrag(null);
      if (!draft) {
        updateDueDraft(null);
        window.setTimeout(() => {
          dragClickGuardRef.current = false;
        }, 0);
        return;
      }
      setCalendarItems((prev) => {
        const idx = prev.findIndex((item) => item.id === draft.itemId);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = {
            ...next[idx],
            due_at: draft.due_at,
          };
          return next;
        }
        const projectItem =
          scope.kind === "project" ? projectItemMap.get(draft.itemId) : null;
        if (!projectItem) {
          return prev;
        }
        return prev.concat({
          id: projectItem.id,
          title: projectItem.title,
          status: projectItem.status,
          due_at: draft.due_at,
          parent_id: projectItem.parent_id,
          item_type: projectItem.type,
          priority: projectItem.priority,
          assignee_id: projectItem.assignee_id ?? null,
          assignee_name: projectItem.assignee_name ?? null,
        });
      });
      void mutate("update_item_fields", {
        id: draft.itemId,
        fields: {
          due_at: draft.due_at,
        },
      })
        .then(() => {
          scheduleRefresh();
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : "Unknown error";
          setError(message);
          scheduleRefresh();
        })
        .finally(() => {
          updateDueDraft(null);
          window.setTimeout(() => {
            dragClickGuardRef.current = false;
          }, 0);
        });
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [
    clampMinutes,
    dueDrag,
    projectItemMap,
    pxPerMinute,
    scheduleRefresh,
    scope.kind,
    snapDueMinutes,
    updateDueDraft,
  ]);

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
          <AppButton type="button" variant="surface" onClick={handlePrev}>
            Prev
          </AppButton>
          <AppButton type="button" variant="surface" onClick={handleToday}>
            Today
          </AppButton>
          <AppButton type="button" variant="surface" onClick={handleNext}>
            Next
          </AppButton>
        </div>
        <SegmentedControl.Root
          value={viewMode}
          onValueChange={(value) => setViewMode(value as "week" | "month")}
        >
          <SegmentedControl.Item value="week">Week</SegmentedControl.Item>
          <SegmentedControl.Item value="month">Month</SegmentedControl.Item>
        </SegmentedControl.Root>
      </div>
      {loading && blocks.length === 0 && calendarItems.length === 0 ? (
        <div className="list-empty">Loading…</div>
      ) : null}
      {viewMode === "week" ? (
        <div className="calendar-week-shell">
          <aside className="calendar-task-rail">
            <div className="calendar-task-rail-header">
              <div className="calendar-task-rail-title">Unscheduled tasks</div>
              <div className="calendar-task-rail-count">{unscheduledTasks.length}</div>
            </div>
            <div className="calendar-task-list">
              {unscheduledTasks.length === 0 ? (
                <div className="calendar-task-empty">
                  All active tasks in this scope are already scheduled.
                </div>
              ) : (
                unscheduledTasks.map((task) => {
                  const dueText = task.due_at
                    ? `${SHORT_DATE_LABEL.format(
                        new Date(task.due_at)
                      )} ${DUE_TIME_LABEL.format(new Date(task.due_at))}`
                    : "No due date";
                  const className = [
                    "calendar-task-card",
                    task.is_blocked ? "is-blocked" : "",
                    dragTaskId === task.id ? "is-dragging" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <div
                      key={task.id}
                      className={className}
                      draggable
                      role="button"
                      tabIndex={0}
                      title={task.title}
                      onDragStart={handleTaskDragStart(task)}
                      onDragEnd={handleTaskDragEnd}
                      onClick={() => onOpenItem(task.id)}
                      onKeyDown={handleOpenKey(task.id)}
                    >
                      <div className="calendar-task-card-title">{task.title}</div>
                      <div className="calendar-task-meta">
                        {task.estimate_minutes}m · {dueText}
                      </div>
                      {task.is_blocked ? (
                        <div className="calendar-task-badge">Blocked</div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </aside>
          <div className="calendar-week">
            <div className="calendar-time-col" style={{ paddingTop: 28 }}>
              {Array.from({ length: hourCount + 1 }).map((_, idx) => {
                const hour = workStartHour + idx;
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
                      className={
                        dropDayKey === key
                          ? "calendar-day-body is-drop-target"
                          : "calendar-day-body"
                      }
                      style={
                        {
                          height: hourCount * HOUR_HEIGHT,
                          "--calendar-hour-height": `${HOUR_HEIGHT}px`,
                        } as React.CSSProperties
                      }
                      onMouseDown={handleSelectStart(day)}
                      onDragOver={handleDayDragOver(day)}
                      onDragLeave={handleDayDragLeave(day)}
                      onDrop={handleDayDrop(day)}
                      data-day-key={key}
                      data-day-start={dayStart}
                    >
                      {selectionForDay ? (
                        <div
                          className="calendar-selection"
                          style={{
                            top:
                              (selectionForDay.startMinutes -
                                workStartHour * 60) *
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
                        const isDraft = dueDraft?.itemId === item.id;
                        const outsideHours =
                          minutesFromDayStart < workStartHour * 60 ||
                          minutesFromDayStart > workEndHour * 60;
                        const top = outsideHours
                          ? 4
                          : (minutesFromDayStart - workStartHour * 60) *
                              pxPerMinute;
                        const className = [
                          "calendar-due-flag",
                          isOverdue ? "is-overdue" : "",
                          isDraft ? "is-draft" : "",
                        ]
                          .filter(Boolean)
                          .join(" ");
                        return (
                          <div
                            key={`due-${item.id}`}
                            className={className}
                            style={{ top }}
                            title={item.title}
                            role="button"
                            tabIndex={0}
                            onClick={() => onOpenItem(item.id)}
                            onKeyDown={handleOpenKey(item.id)}
                          >
                            Due {DUE_TIME_LABEL.format(new Date(item.due_at))}:{" "}
                            {item.title}
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
                          workStartHour * 60
                        );
                        const visibleEnd = Math.min(
                          blockEndMinutes,
                          workEndHour * 60
                        );
                        if (visibleEnd <= visibleStart) {
                          return null;
                        }
                        const top =
                          (visibleStart - workStartHour * 60) * pxPerMinute;
                        const height = Math.max(
                          18,
                          (visibleEnd - visibleStart) * pxPerMinute
                        );
                        const labelTime = TIME_LABEL.format(
                          new Date(block.start_at)
                        );
                        const title =
                          itemTitleMap.get(block.item_id) ?? block.item_id;
                        const isDone =
                          itemStatusMap.get(block.item_id) === "done";
                        const dueAt =
                          dueDraft?.itemId === block.item_id
                            ? dueDraft.due_at
                            : itemDueMap.get(block.item_id) ?? null;
                        const dueText = dueAt
                          ? `${SHORT_DATE_LABEL.format(
                              new Date(dueAt)
                            )} ${DUE_TIME_LABEL.format(new Date(dueAt))}`
                          : "Set due";
                        const dueHandleClass = [
                          "calendar-block-due-handle",
                          dueDrag?.itemId === block.item_id ? "is-dragging" : "",
                        ]
                          .filter(Boolean)
                          .join(" ");
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
                                <div className="calendar-block-header">
                                  <AppCheckbox
                                    className="task-checkbox task-checkbox--compact"
                                    checked={isDone}
                                    onCheckedChange={(checked) =>
                                      void handleToggleDone(
                                        block.item_id,
                                        checked === true
                                      )
                                    }
                                    onClick={(event) => event.stopPropagation()}
                                  />
                                  <div className="calendar-block-title">
                                    {title}
                                  </div>
                                  <div
                                    className={dueHandleClass}
                                    role="button"
                                    tabIndex={-1}
                                    title={`Drag to set due date (${dueText})`}
                                    onClick={(event) => event.stopPropagation()}
                                    onMouseDown={(event) =>
                                      beginDueDrag(block, event)
                                    }
                                  >
                                    {dueAt ? `Due ${dueText}` : dueText}
                                  </div>
                                </div>
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
                  const isDone =
                    itemStatusMap.get(block.item_id) === "done";
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
                          <AppCheckbox
                            className="task-checkbox task-checkbox--compact"
                            checked={isDone}
                            onCheckedChange={(checked) =>
                              void handleToggleDone(
                                block.item_id,
                                checked === true
                              )
                            }
                            onClick={(event) => event.stopPropagation()}
                          />
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
