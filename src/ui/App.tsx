import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { createRpcClient } from "../rpc/client";
import "./app.css";

const worker = new Worker(new URL("../db-worker/worker.ts", import.meta.url), {
  type: "module",
});

const rpc = createRpcClient(worker);

type PingResult = {
  now: number;
  version: string;
};

type DbInfoResult =
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

type AuditRow = {
  log_id: string;
  op_id: string;
  op_name: string;
  actor: string;
  ts: number;
  args_json: string;
  result_json: string;
};

type QueryEnvelope = {
  name: string;
  args?: unknown;
};

type QueryResult<T> = {
  ok: boolean;
  result?: T;
  error?: string;
};

type KanbanItem = {
  id: string;
  type: string;
  title: string;
  parent_id: string | null;
  status: string;
  priority: number;
  due_at: number;
  is_blocked: boolean;
};

type CalendarBlock = {
  block_id: string;
  item_id: string;
  start_at: number;
  duration_minutes: number;
  locked: number;
  source: string;
};

type Blocker = {
  blocker_id: string;
  reason: string | null;
  created_at: number;
  cleared_at: number | null;
};

type ItemDetails = {
  id: string;
  type: string;
  title: string;
  parent_id: string | null;
  status: string;
  priority: number;
  due_at: number;
  estimate_mode: string;
  estimate_minutes: number;
  health: string;
  health_mode: string;
  notes: string | null;
  dependencies: string[];
  blockers: Blocker[];
  is_blocked: boolean;
  days_until_due: number;
  days_overdue: number;
  is_overdue: boolean;
  rollup_actual_minutes: number;
  rollup_remaining_minutes: number;
  health_auto: string;
};

type ProjectNode = {
  id: string;
  type: string;
  title: string;
  parent_id: string | null;
  status: string;
  priority: number;
  due_at: number;
  estimate_mode: string;
  estimate_minutes: number;
  health: string;
  health_mode: string;
  notes: string | null;
  rollup_estimate_minutes: number;
  rollup_actual_minutes: number;
  rollup_remaining_minutes: number;
  days_until_due: number;
  days_overdue: number;
  is_overdue: boolean;
  health_auto: string;
};

type DragState =
  | {
      mode: "move";
      blockId: string;
      durationMinutes: number;
      offsetMinutes: number;
    }
  | {
      mode: "resize";
      blockId: string;
      startAt: number;
      startDuration: number;
      startY: number;
    }
  | null;

const formatTime = (now: number) => new Date(now).toLocaleString();

const START_HOUR = 6;
const END_HOUR = 20;
const HOUR_HEIGHT = 60;
const MINUTES_PER_DAY = (END_HOUR - START_HOUR) * 60;
const MINUTES_PER_HOUR = 60;
const MINUTES_SNAP = 15;

type ThemeTokens = {
  bg: string;
  fg: string;
  accent: string;
  border: string;
  surface: string;
  surfaceAlt: string;
  danger: string;
  dangerBg: string;
};

const DEFAULT_THEME_TOKENS: ThemeTokens = {
  bg: "#f7f4ef",
  fg: "#1b1b1b",
  accent: "#ffda79",
  border: "#1b1b1b",
  surface: "#fff7e6",
  surfaceAlt: "#ffe7a3",
  danger: "#b30000",
  dangerBg: "#ffd6d6",
};

const coerceThemeTokens = (value: unknown): ThemeTokens => {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_THEME_TOKENS };
  }
  const record = value as Record<string, unknown>;
  return {
    bg: typeof record.bg === "string" ? record.bg : DEFAULT_THEME_TOKENS.bg,
    fg: typeof record.fg === "string" ? record.fg : DEFAULT_THEME_TOKENS.fg,
    accent:
      typeof record.accent === "string" ? record.accent : DEFAULT_THEME_TOKENS.accent,
    border:
      typeof record.border === "string" ? record.border : DEFAULT_THEME_TOKENS.border,
    surface:
      typeof record.surface === "string" ? record.surface : DEFAULT_THEME_TOKENS.surface,
    surfaceAlt:
      typeof record.surfaceAlt === "string"
        ? record.surfaceAlt
        : DEFAULT_THEME_TOKENS.surfaceAlt,
    danger:
      typeof record.danger === "string" ? record.danger : DEFAULT_THEME_TOKENS.danger,
    dangerBg:
      typeof record.dangerBg === "string"
        ? record.dangerBg
        : DEFAULT_THEME_TOKENS.dangerBg,
  };
};

const scopeUserCss = (css: string) => {
  const trimmed = css.trim();
  if (!trimmed) {
    return "";
  }
  const keyframes: string[] = [];
  const withoutKeyframes = trimmed.replace(
    /@(-webkit-)?keyframes[^{]*\{[\s\S]*?\}\s*/g,
    (match) => {
      const token = `__KEYFRAMES_BLOCK_${keyframes.length}__`;
      keyframes.push(match);
      return token;
    }
  );
  const scoped = withoutKeyframes.replace(
    /(^|\n)\s*([^@\n][^{]*?)\s*\{/g,
    (match, start, selector) => {
      const scopedSelectors = selector
        .split(",")
        .map((part) => `.app-root ${part.trim()}`)
        .join(", ");
      return `${start}${scopedSelectors} {`;
    }
  );
  return keyframes.reduce(
    (acc, block, index) => acc.replace(`__KEYFRAMES_BLOCK_${index}__`, block),
    scoped
  );
};

const startOfWeek = (date: Date) => {
  const copy = new Date(date);
  const dayIndex = (copy.getDay() + 6) % 7;
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() - dayIndex);
  return copy;
};

const addDays = (date: Date, days: number) => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
};

const roundToSnap = (value: number) => {
  const snapped = Math.round(value / MINUTES_SNAP) * MINUTES_SNAP;
  return Math.max(MINUTES_SNAP, snapped);
};

const App = () => {
  const [lastPing, setLastPing] = useState<PingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dbInfo, setDbInfo] = useState<DbInfoResult | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [kanbanItems, setKanbanItems] = useState<KanbanItem[]>([]);
  const [kanbanError, setKanbanError] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<CalendarBlock[]>([]);
  const [blocksError, setBlocksError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [itemDetails, setItemDetails] = useState<ItemDetails | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [blockerKind, setBlockerKind] = useState("manual");
  const [blockerText, setBlockerText] = useState("");
  const [dependencyId, setDependencyId] = useState("");
  const [dragState, setDragState] = useState<DragState>(null);
  const [dragPreview, setDragPreview] = useState<Record<string, number>>({});
  const [projectTree, setProjectTree] = useState<ProjectNode[]>([]);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [capacityInput, setCapacityInput] = useState("");
  const [themeTokens, setThemeTokens] = useState<ThemeTokens>({
    ...DEFAULT_THEME_TOKENS,
  });
  const [userCss, setUserCss] = useState("");

  const gridRef = useRef<HTMLDivElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const weekStart = useMemo(() => startOfWeek(new Date()), []);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    [weekStart]
  );
  const scopedUserCss = useMemo(() => scopeUserCss(userCss), [userCss]);
  const themeStyle = useMemo(
    () =>
      ({
        "--color-bg": themeTokens.bg,
        "--color-fg": themeTokens.fg,
        "--color-accent": themeTokens.accent,
        "--color-border": themeTokens.border,
        "--color-surface": themeTokens.surface,
        "--color-surface-alt": themeTokens.surfaceAlt,
        "--color-danger": themeTokens.danger,
        "--color-danger-bg": themeTokens.dangerBg,
      }) satisfies CSSProperties,
    [themeTokens]
  );

  const ping = useCallback(async () => {
    setError(null);
    try {
      const result = await rpc.request<PingResult>("ping");
      setLastPing(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  }, []);

  const loadDbInfo = useCallback(async () => {
    setDbError(null);
    try {
      const result = await rpc.request<DbInfoResult>("dbInfo");
      setDbInfo(result);
      if (!result.ok) {
        setDbError(result.error);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setDbError(message);
    }
  }, []);

  const loadTables = useCallback(async () => {
    setTablesError(null);
    try {
      const result = await rpc.request<string[]>("listTables");
      setTables(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setTablesError(message);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    setAuditError(null);
    try {
      const result = await rpc.request<AuditRow[]>("listAudit");
      setAuditRows(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setAuditError(message);
    }
  }, []);

  const runQuery = useCallback(
    async <T,>(name: string, args?: Record<string, unknown>) => {
      const envelope: QueryEnvelope = { name, args };
      const result = await rpc.request<QueryResult<T>>("query", envelope);
      if (!result.ok) {
        throw new Error(result.error ?? "Query failed");
      }
      return result.result as T;
    },
    [] 
  );

  const loadSettings = useCallback(async () => {
    setSettingsError(null);
    try {
      const result = await runQuery<Record<string, unknown>>("getSettings");
      setSettings(result ?? {});
      if (typeof result?.capacity_minutes_per_day === "number") {
        setCapacityInput(String(result.capacity_minutes_per_day));
      }
      setThemeTokens(coerceThemeTokens(result?.theme_tokens));
      setUserCss(typeof result?.user_css === "string" ? result.user_css : "");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setSettingsError(message);
    }
  }, [runQuery]);

  const loadKanban = useCallback(async () => {
    setKanbanError(null);
    try {
      const result = await runQuery<KanbanItem[]>("listKanban", {
        projectId,
      });
      setKanbanItems(result ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setKanbanError(message);
    }
  }, [projectId, runQuery]);

  const loadBlocks = useCallback(async () => {
    setBlocksError(null);
    try {
      const startAt = weekStart.getTime();
      const endAt = addDays(weekStart, 7).getTime();
      const result = await runQuery<CalendarBlock[]>("listCalendarBlocks", {
        startAt,
        endAt,
      });
      setBlocks(result ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setBlocksError(message);
    }
  }, [runQuery, weekStart]);

  const loadItemDetails = useCallback(async () => {
    if (!selectedItemId) {
      setItemDetails(null);
      return;
    }
    setDetailError(null);
    try {
      const result = await runQuery<ItemDetails | null>("getItemDetails", {
        itemId: selectedItemId,
      });
      setItemDetails(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setDetailError(message);
    }
  }, [runQuery, selectedItemId]);

  const loadProjectTree = useCallback(async () => {
    if (!selectedItemId) {
      setProjectTree([]);
      return;
    }
    if (itemDetails?.type !== "project" && itemDetails?.type !== "milestone") {
      setProjectTree([]);
      return;
    }
    setProjectError(null);
    try {
      const result = await runQuery<ProjectNode[]>("getProjectTree", {
        projectId: selectedItemId,
      });
      setProjectTree(result ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setProjectError(message);
    }
  }, [itemDetails?.type, runQuery, selectedItemId]);

  const runMutation = useCallback(
    async (op_name: string, args: Record<string, unknown>) => {
      setMutationError(null);
      const envelope: MutateEnvelope = {
        op_id: crypto.randomUUID(),
        op_name,
        actor_type: "user",
        actor_id: "local",
        ts: Date.now(),
        args,
      };
      try {
        const result = await rpc.request<MutateResult>("mutate", envelope);
        if (!result.ok) {
          setMutationError(result.error ?? "Unknown error");
          return null;
        }
        await loadAudit();
        await loadKanban();
        await loadBlocks();
        await loadItemDetails();
        await loadProjectTree();
        await loadSettings();
        return result.result ?? null;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setMutationError(message);
        return null;
      }
    },
    [loadAudit, loadBlocks, loadItemDetails, loadKanban, loadProjectTree, loadSettings]
  );

  const createSampleProject = useCallback(async () => {
    const result = await runMutation("create_item", {
      type: "project",
      title: "Sample Project",
      due_at: Date.now() + 7 * 24 * 60 * 60 * 1000,
      estimate_minutes: 240,
    });
    if (result && typeof result === "object" && "id" in result) {
      const id = String((result as { id: string }).id);
      setProjectId(id);
      setSelectedItemId(id);
    }
  }, [runMutation]);

  const createSampleTask = useCallback(async () => {
    if (!projectId) {
      setMutationError("Create a project first.");
      return;
    }
    const result = await runMutation("create_item", {
      type: "task",
      title: "Sample Task",
      parent_id: projectId,
      due_at: Date.now() + 2 * 24 * 60 * 60 * 1000,
      estimate_minutes: 90,
    });
    if (result && typeof result === "object" && "id" in result) {
      const id = String((result as { id: string }).id);
      setTaskId(id);
      setSelectedItemId(id);
    }
  }, [projectId, runMutation]);

  const createSampleBlock = useCallback(async () => {
    if (!taskId) {
      setMutationError("Create a task first.");
      return;
    }
    await runMutation("create_block", {
      item_id: taskId,
      start_at: Date.now() + 60 * 60 * 1000,
      duration_minutes: 60,
    });
  }, [taskId, runMutation]);

  useEffect(() => {
    void ping();
    void loadDbInfo();
    void loadTables();
    void loadAudit();
    void loadKanban();
    void loadBlocks();
    void loadItemDetails();
    void loadProjectTree();
    void loadSettings();
  }, [
    ping,
    loadDbInfo,
    loadTables,
    loadAudit,
    loadKanban,
    loadBlocks,
    loadItemDetails,
    loadProjectTree,
    loadSettings,
  ]);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!gridRef.current) {
        return;
      }

      const rect = gridRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const dayWidth = rect.width / 7;
      const dayIndex = Math.min(6, Math.max(0, Math.floor(x / dayWidth)));
      const dayStart = addDays(weekStart, dayIndex).getTime();
      const minuteHeight = HOUR_HEIGHT / MINUTES_PER_HOUR;
      const minutesFromTop = Math.max(0, y / minuteHeight);

      if (dragState.mode === "move") {
        const minutesInGrid = Math.min(MINUTES_PER_DAY, minutesFromTop);
        const snapped = roundToSnap(minutesInGrid - dragState.offsetMinutes);
        const newStart = dayStart + (START_HOUR * MINUTES_PER_HOUR + snapped) * 60000;
        setDragPreview((prev) => ({ ...prev, [dragState.blockId]: newStart }));
        return;
      }

      if (dragState.mode === "resize") {
        const deltaMinutes = (event.clientY - dragState.startY) / minuteHeight;
        const newDuration = roundToSnap(dragState.startDuration + deltaMinutes);
        setDragPreview((prev) => ({ ...prev, [dragState.blockId]: newDuration }));
      }
    };

    const handlePointerUp = async () => {
      if (!dragState) {
        return;
      }
      const previewValue = dragPreview[dragState.blockId];
      if (dragState.mode === "move" && typeof previewValue === "number") {
        await runMutation("move_block", {
          block_id: dragState.blockId,
          start_at: previewValue,
        });
      }
      if (dragState.mode === "resize" && typeof previewValue === "number") {
        await runMutation("resize_block", {
          block_id: dragState.blockId,
          duration_minutes: previewValue,
        });
      }
      setDragState(null);
      setDragPreview({});
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState, dragPreview, runMutation, weekStart]);

  const kanbanColumns = [
    "backlog",
    "ready",
    "in_progress",
    "blocked",
    "review",
    "done",
    "canceled",
  ];

  const itemTitleById = new Map(kanbanItems.map((item) => [item.id, item.title]));

  const handleAddBlocker = async () => {
    if (!selectedItemId) {
      setMutationError("Select an item first.");
      return;
    }
    await runMutation("add_blocker", {
      item_id: selectedItemId,
      kind: blockerKind,
      text: blockerText,
    });
    setBlockerText("");
  };

  const handleClearBlocker = async (blockerId: string) => {
    await runMutation("clear_blocker", { blocker_id: blockerId });
  };

  const handleAddDependency = async () => {
    if (!selectedItemId || !dependencyId) {
      setMutationError("Select an item and dependency.");
      return;
    }
    await runMutation("add_dependency", {
      item_id: selectedItemId,
      depends_on_id: dependencyId,
    });
    setDependencyId("");
  };

  const handleSaveCapacity = async () => {
    const parsed = capacityInput.trim() === "" ? null : Number(capacityInput);
    if (capacityInput.trim() !== "" && (!Number.isFinite(parsed) || parsed < 0)) {
      setMutationError("Capacity must be a non-negative number.");
      return;
    }
    await runMutation("set_setting", {
      key: "capacity_minutes_per_day",
      value: parsed,
    });
  };

  const handleThemeTokenChange = (key: keyof ThemeTokens, value: string) => {
    setThemeTokens((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveTheme = async () => {
    await runMutation("set_setting", {
      key: "theme_tokens",
      value: themeTokens,
    });
    await runMutation("set_setting", {
      key: "user_css",
      value: userCss,
    });
  };

  const handleResetTheme = async () => {
    setThemeTokens({ ...DEFAULT_THEME_TOKENS });
    setUserCss("");
    await runMutation("set_setting", {
      key: "theme_tokens",
      value: DEFAULT_THEME_TOKENS,
    });
    await runMutation("set_setting", {
      key: "user_css",
      value: "",
    });
  };

  const handleExportData = async () => {
    const result = await runMutation("export_data", {});
    if (!result || typeof result !== "object") {
      setMutationError("Export failed.");
      return;
    }
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `makewhen-backup-${timestamp}.json`;
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleImportData = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await runMutation("import_data", { payload });
      if (importInputRef.current) {
        importInputRef.current.value = "";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid JSON file.";
      setMutationError(message);
    }
  };

  const weekLabel = `${weekStart.toLocaleDateString()} - ${addDays(
    weekStart,
    6
  ).toLocaleDateString()}`;

  const duePins = kanbanItems.filter((item) => {
    if (!item.due_at) {
      return false;
    }
    const dayStart = weekStart.getTime();
    const dayEnd = addDays(weekStart, 7).getTime();
    return item.due_at >= dayStart && item.due_at < dayEnd;
  });

  const dashboardRoot =
    projectTree.find((node) => node.id === selectedItemId) ?? null;

  return (
    <div className="app-root" style={themeStyle}>
      {scopedUserCss ? <style>{scopedUserCss}</style> : null}
      <div className="app">
        <h1 className="title">makewhen</h1>
        <div className="status">
          {lastPing ? (
            <p className="meta">
              Worker OK - {formatTime(lastPing.now)} (version {lastPing.version})
            </p>
          ) : (
            <p className="meta">Worker pending...</p>
          )}
          {error ? <p className="error">Worker error: {error}</p> : null}
        </div>
        <div className="status">
          {dbInfo && dbInfo.ok ? (
            <p className="meta">
              DB OK - {dbInfo.filename} via {dbInfo.vfs} (schema v
              {dbInfo.schemaVersion})
            </p>
          ) : dbInfo && !dbInfo.ok ? (
            <p className="meta">DB error</p>
          ) : (
            <p className="meta">DB pending...</p>
          )}
          {dbError ? <p className="error">DB error: {dbError}</p> : null}
        </div>
        <div className="status">
          {tables.length > 0 ? (
            <p className="meta">Tables: {tables.join(", ")}</p>
          ) : (
            <p className="meta">Tables pending...</p>
          )}
          {tablesError ? (
            <p className="error">Tables error: {tablesError}</p>
          ) : null}
        </div>
        <div className="status">
          <p className="meta">Sample ops</p>
          <div>
            <button className="button" type="button" onClick={createSampleProject}>
              Create sample project
            </button>
          </div>
          <div>
            <button className="button" type="button" onClick={createSampleTask}>
              Create sample task under project
            </button>
          </div>
          <div>
            <button className="button" type="button" onClick={createSampleBlock}>
              Create sample block
            </button>
          </div>
          {mutationError ? (
            <p className="error">Mutation error: {mutationError}</p>
          ) : null}
        </div>
        <div className="status">
          <p className="meta">Audit log (latest 20)</p>
          {auditRows.length > 0 ? (
            <pre className="audit">
              {auditRows
                .map(
                  (row) =>
                    `${new Date(row.ts).toLocaleString()} ${row.op_name} ${row.result_json}`
                )
                .join("\n")}
            </pre>
          ) : (
            <p className="meta">Audit pending...</p>
          )}
          {auditError ? <p className="error">Audit error: {auditError}</p> : null}
        </div>
        <div className="status">
          <p className="meta">Kanban</p>
          <div className="kanban">
            {kanbanColumns.map((column) => {
              const items = kanbanItems.filter((item) => item.status === column);
              return (
                <div className="kanban-column" key={column}>
                  <div className="kanban-title">{column}</div>
                  {items.length > 0 ? (
                    items.map((item) => (
                      <div
                        className={`kanban-card${item.is_blocked ? " blocked" : ""}`}
                        key={item.id}
                        onClick={() => setSelectedItemId(item.id)}
                      >
                        <div>{item.title}</div>
                        <div className="kanban-meta">
                          {item.type} - due{" "}
                          {new Date(item.due_at).toLocaleDateString()}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="kanban-empty">-</div>
                  )}
                </div>
              );
            })}
          </div>
          {kanbanError ? <p className="error">Kanban error: {kanbanError}</p> : null}
        </div>
        <div className="status">
          <p className="meta">Calendar week ({weekLabel})</p>
          <div
            className="calendar"
            style={{ "--hour-height": `${HOUR_HEIGHT}px` } as Record<string, string>}
          >
            <div className="calendar-header">
              {weekDays.map((day) => (
                <div key={day.toISOString()} className="calendar-header-cell">
                  {day.toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                </div>
              ))}
            </div>
            <div className="calendar-grid" ref={gridRef}>
              {weekDays.map((day) => {
                const dayStart = day.getTime();
                const dayEnd = addDays(day, 1).getTime();
                const dayBlocks = blocks.filter(
                  (block) => block.start_at >= dayStart && block.start_at < dayEnd
                );
                const dayPins = duePins.filter(
                  (item) => item.due_at >= dayStart && item.due_at < dayEnd
                );

                return (
                  <div key={day.toISOString()} className="calendar-day">
                    {dayBlocks.map((block) => {
                      const startMinutes =
                        (block.start_at - dayStart) / 60000 -
                        START_HOUR * MINUTES_PER_HOUR;
                      const top =
                        Math.max(0, startMinutes) * (HOUR_HEIGHT / MINUTES_PER_HOUR);
                      const duration =
                        dragState &&
                        dragState.blockId === block.block_id &&
                        dragState.mode === "resize"
                          ? dragPreview[block.block_id] ?? block.duration_minutes
                          : block.duration_minutes;
                      const previewStart =
                        dragState &&
                        dragState.blockId === block.block_id &&
                        dragState.mode === "move"
                          ? dragPreview[block.block_id] ?? block.start_at
                          : block.start_at;
                      const previewMinutes =
                        (previewStart - dayStart) / 60000 -
                        START_HOUR * MINUTES_PER_HOUR;
                      const previewTop =
                        dragState &&
                        dragState.blockId === block.block_id &&
                        dragState.mode === "move"
                          ? Math.max(0, previewMinutes) *
                            (HOUR_HEIGHT / MINUTES_PER_HOUR)
                          : top;
                      const height =
                        Math.max(MINUTES_SNAP, duration) *
                        (HOUR_HEIGHT / MINUTES_PER_HOUR);

                      return (
                        <div
                          key={block.block_id}
                          className="calendar-block"
                          style={{ top: previewTop, height }}
                          onPointerDown={(event) => {
                            if (!gridRef.current) {
                              return;
                            }
                            const rect = gridRef.current.getBoundingClientRect();
                            const dayRectTop = rect.top;
                            const offsetY = event.clientY - dayRectTop - previewTop;
                            const offsetMinutes =
                              offsetY / (HOUR_HEIGHT / MINUTES_PER_HOUR);
                            setDragState({
                              mode: "move",
                              blockId: block.block_id,
                              durationMinutes: block.duration_minutes,
                              offsetMinutes,
                            });
                          }}
                        >
                          <div className="calendar-block-title">
                            {itemTitleById.get(block.item_id) ?? block.item_id}
                          </div>
                          <div className="calendar-block-time">
                            {new Date(block.start_at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                          <div
                            className="calendar-block-handle"
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              setDragState({
                                mode: "resize",
                                blockId: block.block_id,
                                startAt: block.start_at,
                                startDuration: block.duration_minutes,
                                startY: event.clientY,
                              });
                              setDragPreview((prev) => ({
                                ...prev,
                                [block.block_id]: block.duration_minutes,
                              }));
                            }}
                          />
                        </div>
                      );
                    })}
                    {dayPins.map((item) => {
                      const dueMinutes =
                        (item.due_at - dayStart) / 60000 -
                        START_HOUR * MINUTES_PER_HOUR;
                      const top =
                        Math.max(0, dueMinutes) *
                        (HOUR_HEIGHT / MINUTES_PER_HOUR);
                      return (
                        <div
                          key={item.id}
                          className="due-pin"
                          style={{ top }}
                          title={`${item.title} due`}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
          {blocksError ? <p className="error">Blocks error: {blocksError}</p> : null}
        </div>
        <div className="status">
          <p className="meta">Project dashboard</p>
          {dashboardRoot ? (
            <div className="detail">
              <div>
                <strong>{dashboardRoot.title}</strong>
              </div>
              <div className="kanban-meta">
                {dashboardRoot.is_overdue
                  ? `${dashboardRoot.days_overdue} days overdue`
                  : `${dashboardRoot.days_until_due} days until due`}
              </div>
              <div className="detail-list">
                Rollup estimate: {dashboardRoot.rollup_estimate_minutes}m
              </div>
              <div className="detail-list">
                Rollup actual: {dashboardRoot.rollup_actual_minutes}m
              </div>
              <div className="detail-list">
                Rollup remaining: {dashboardRoot.rollup_remaining_minutes}m
              </div>
              <div className="detail-list">Health: {dashboardRoot.health_auto}</div>
            </div>
          ) : (
            <p className="meta">Select a project or milestone to view rollups.</p>
          )}
          {projectError ? <p className="error">Project error: {projectError}</p> : null}
        </div>
        <div className="status">
          <p className="meta">Settings</p>
          <label className="detail-list" htmlFor="capacity-input">
            Capacity minutes per day
          </label>
          <input
            id="capacity-input"
            className="input"
            value={capacityInput}
            onChange={(event) => setCapacityInput(event.target.value)}
            placeholder="e.g. 360"
          />
          <button className="button" type="button" onClick={handleSaveCapacity}>
            Save capacity
          </button>
          {settingsError ? <p className="error">Settings error: {settingsError}</p> : null}
        </div>
        <div className="status">
          <p className="meta">Theme</p>
          <div className="detail-row">
            {(
              [
                ["bg", "Background"],
                ["fg", "Foreground"],
                ["accent", "Accent"],
                ["border", "Border"],
                ["surface", "Surface"],
                ["surfaceAlt", "Surface alt"],
                ["danger", "Danger"],
                ["dangerBg", "Danger bg"],
              ] as Array<[keyof ThemeTokens, string]>
            ).map(([key, label]) => (
              <label key={key} className="detail-list">
                {label}
                <input
                  className="input"
                  value={themeTokens[key]}
                  onChange={(event) => handleThemeTokenChange(key, event.target.value)}
                  placeholder={DEFAULT_THEME_TOKENS[key]}
                />
              </label>
            ))}
          </div>
          <label className="detail-list" htmlFor="user-css-input">
            Advanced CSS (scoped to .app-root)
          </label>
          <textarea
            id="user-css-input"
            className="input"
            rows={6}
            value={userCss}
            onChange={(event) => setUserCss(event.target.value)}
            placeholder=".kanban { font-size: 14px; }"
          />
          <div className="detail-row">
            <button className="button" type="button" onClick={handleSaveTheme}>
              Save theme
            </button>
            <button className="button" type="button" onClick={handleResetTheme}>
              Reset theme
            </button>
          </div>
        </div>
        <div className="status">
          <p className="meta">Backup</p>
          <div className="detail-row">
            <button className="button" type="button" onClick={handleExportData}>
              Export JSON
            </button>
            <input
              ref={importInputRef}
              className="input"
              type="file"
              accept="application/json"
              onChange={handleImportData}
            />
          </div>
        </div>
        <div className="status">
          <p className="meta">Item detail</p>
          <select
            className="select"
            value={selectedItemId ?? ""}
            onChange={(event) => setSelectedItemId(event.target.value || null)}
          >
            <option value="">Select item</option>
            {kanbanItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          {itemDetails ? (
            <div className="detail">
              <div>
                <strong>{itemDetails.title}</strong>
              </div>
              <div className="kanban-meta">
                {itemDetails.type} - status {itemDetails.status} - due{" "}
                {new Date(itemDetails.due_at).toLocaleDateString()}
              </div>
              {itemDetails.is_blocked && itemDetails.status !== "blocked" ? (
                <p className="error">Warning: item is blocked but status is not blocked.</p>
              ) : null}
              <div className="detail-section">
                <div className="detail-title">Dependencies</div>
                <div className="detail-list">
                  {itemDetails.dependencies.length > 0
                    ? itemDetails.dependencies
                        .map((id) => itemTitleById.get(id) ?? id)
                        .join(", ")
                    : "None"}
                </div>
                <div className="detail-row">
                  <select
                    className="select"
                    value={dependencyId}
                    onChange={(event) => setDependencyId(event.target.value)}
                  >
                    <option value="">Select dependency</option>
                    {kanbanItems
                      .filter((item) => item.id !== itemDetails.id)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                  </select>
                  <button className="button" type="button" onClick={handleAddDependency}>
                    Add dependency
                  </button>
                </div>
              </div>
              <div className="detail-section">
                <div className="detail-title">Blockers</div>
                {itemDetails.blockers.length > 0 ? (
                  <ul className="detail-blockers">
                    {itemDetails.blockers.map((blocker) => (
                      <li key={blocker.blocker_id}>
                        <span>
                          {blocker.reason ?? "blocker"}{" "}
                          {blocker.cleared_at ? "(cleared)" : "(active)"}
                        </span>
                        {!blocker.cleared_at ? (
                          <button
                            className="button"
                            type="button"
                            onClick={() => handleClearBlocker(blocker.blocker_id)}
                          >
                            Clear
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="detail-list">No blockers</div>
                )}
                <div className="detail-row">
                  <input
                    className="input"
                    value={blockerKind}
                    onChange={(event) => setBlockerKind(event.target.value)}
                    placeholder="kind"
                  />
                  <input
                    className="input"
                    value={blockerText}
                    onChange={(event) => setBlockerText(event.target.value)}
                    placeholder="details"
                  />
                  <button className="button" type="button" onClick={handleAddBlocker}>
                    Add blocker
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <p className="meta">Select an item to view details.</p>
          )}
          {detailError ? <p className="error">Detail error: {detailError}</p> : null}
        </div>
        <button className="button" type="button" onClick={ping}>
          Ping
        </button>
      </div>
    </div>
  );
};

export default App;
