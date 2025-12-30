import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FC,
  type ReactNode,
} from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { query, mutate } from "../rpc/clientSingleton";
import { UNGROUPED_PROJECT_ID } from "./constants";
import type {
  DependencyProjectionLite,
  ItemGanttModel,
  ListItem,
  ScheduledBlockLite,
} from "../domain/listTypes";
import { buildListViewModel } from "../domain/listViewModel";
import {
  formatDate,
  formatEstimateMinutes,
  parseEstimateMinutesInput,
  shortId,
  toDateTimeLocal,
  truncate,
} from "../domain/formatters";
import {
  createDependencyEdge,
  createItem,
  deleteItem,
  deleteDependencyEdge,
  duplicateTaskFromItem,
  setItemTags,
  setStatus,
  updateDependencyEdge,
  updateItemFields,
} from "./itemActions";
import { ItemAutocomplete } from "./ItemAutocomplete";

type ListViewItem = ListItem & {
  completed_on: number | null;
  actual_minutes: number | null;
  scheduled_blocks: ScheduledBlockLite[];
  dependencies_out: ItemGanttModel["dependencies_out"];
  dependencies_in: ItemGanttModel["dependencies_in"];
  blocked_by: DependencyProjectionLite[];
  blocking: DependencyProjectionLite[];
  slack_minutes: number | null;
};

type Column = {
  key: string;
  label: string;
  minWidth: number;
  render: (
    item: ListViewItem,
    indent: number,
    dragHandle: ReactNode | null,
    actions?: ReactNode
  ) => ReactNode;
};

type ListViewProps = {
  selectedProjectId: string | null;
  refreshToken: number;
  onRefresh: () => void;
};

const ListView: FC<ListViewProps> = ({
  selectedProjectId,
  refreshToken,
  onRefresh,
}) => {
  const [items, setItems] = useState<ListViewItem[]>([]);
  const [itemsProjectId, setItemsProjectId] = useState<string | null>(null);
  const itemsCacheRef = useRef<Map<string, ListViewItem[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{
    itemId: string;
    groupKey: string;
  } | null>(null);
  const [dragOver, setDragOver] = useState<{
    itemId: string;
    groupKey: string;
    position: "before" | "after" | "into";
  } | null>(null);
  const [inlineAdd, setInlineAdd] = useState<{
    groupKey: string;
    parentId: string;
  } | null>(null);
  const [inlineTitle, setInlineTitle] = useState("");
  const [editing, setEditing] = useState<{
    itemId: string;
    field: string;
  } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [milestoneDrop, setMilestoneDrop] = useState<{
    milestoneId: string;
    position: "top" | "bottom";
  } | null>(null);

  const getLastVisibleId = (groupItems: ListViewItem[]) => {
    if (groupItems.length === 0) {
      return undefined;
    }
    const lastItem = groupItems[groupItems.length - 1];
    const children = taskChildren.get(lastItem.id) ?? [];
    if (children.length > 0) {
      return children[children.length - 1].id;
    }
    return lastItem.id;
  };

  const loadItems = useCallback(async () => {
    if (!selectedProjectId) {
      return [];
    }
    const [listData, completeData] = await Promise.all([
      query<{ items: ListItem[] }>("listItems", {
        projectId: selectedProjectId,
        includeDone: true,
        includeCanceled: true,
        orderBy: "due_at",
        orderDir: "asc",
      }),
      query<ItemGanttModel[]>("list_view_complete", {
        scopeProjectId: selectedProjectId,
        includeUngrouped: false,
        includeCompleted: true,
      }),
    ]);
    const completeMap = new Map(
      completeData.map((item) => [item.id, item])
    );
    const merged = listData.items.map((item) => {
      const extra = completeMap.get(item.id);
      return {
        ...item,
        completed_on: extra?.completed_on ?? null,
        actual_minutes: extra?.actual_minutes ?? null,
        scheduled_blocks: extra?.scheduled_blocks ?? [],
        dependencies_out: extra?.dependencies_out ?? [],
        dependencies_in: extra?.dependencies_in ?? [],
        blocked_by: extra?.blocked_by ?? [],
        blocking: extra?.blocking ?? [],
        slack_minutes: extra?.slack_minutes ?? null,
      };
    });
    return merged;
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setItems([]);
      setItemsProjectId(null);
      setError(null);
      setLoading(false);
      return;
    }
    let isMounted = true;
    const cached = itemsCacheRef.current.get(selectedProjectId);
    if (cached) {
      setItems(cached);
      setItemsProjectId(selectedProjectId);
    } else {
      setItems([]);
      setItemsProjectId(selectedProjectId);
    }
    setLoading(!cached);
    setError(null);
    loadItems()
      .then((merged) => {
        if (!isMounted) {
          return;
        }
        setItems(merged);
        setItemsProjectId(selectedProjectId);
        itemsCacheRef.current.set(selectedProjectId, merged);
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
  }, [loadItems, refreshToken, selectedProjectId]);

  const effectiveProjectId = itemsProjectId ?? selectedProjectId;
  const viewModel = useMemo(
    () =>
      buildListViewModel({
        items,
        selectedProjectId: effectiveProjectId,
        ungroupedProjectId: UNGROUPED_PROJECT_ID,
      }),
    [effectiveProjectId, items]
  );

  useEffect(() => {
    if (!itemsProjectId) {
      return;
    }
    itemsCacheRef.current.set(itemsProjectId, items);
  }, [items, itemsProjectId]);

  const {
    parentTypeMap,
    itemById,
    tasks = [],
    milestones,
    taskChildren,
    tasksUnderMilestone,
    ungroupedTasks,
    ungroupedParentId,
    getAllTasksUnderMilestone,
  } = viewModel;

  const handleToggleTaskDone = useCallback(
    async (item: ListViewItem, checked: boolean) => {
      setError(null);
      try {
        const nextStatus = checked ? "done" : "ready";
        let milestoneStatus: string | null = null;
        let milestoneId: string | null = null;
        await setStatus(item.id, nextStatus);
        if (item.parent_id && parentTypeMap.get(item.parent_id) === "milestone") {
          milestoneId = item.parent_id;
          const allTasks = getAllTasksUnderMilestone(milestoneId);
          if (allTasks.length > 0) {
            const allDone = allTasks.every((task) =>
              task.id === item.id ? checked : task.status === "done"
            );
            const anyDone = allTasks.some((task) =>
              task.id === item.id ? checked : task.status === "done"
            );
            if (allDone) {
              await setStatus(milestoneId, "done");
              milestoneStatus = "done";
            } else if (anyDone) {
              await setStatus(milestoneId, "in_progress");
              milestoneStatus = "in_progress";
            } else {
              const milestone = itemById.get(milestoneId);
              if (milestone?.status === "done") {
                await setStatus(milestoneId, "ready");
                milestoneStatus = "ready";
              }
            }
          }
        }
        setItems((prev) =>
          prev.map((current) => {
            if (current.id === item.id) {
              return { ...current, status: nextStatus };
            }
            if (milestoneId && current.id === milestoneId && milestoneStatus) {
              return { ...current, status: milestoneStatus };
            }
            return current;
          })
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [getAllTasksUnderMilestone, itemById, parentTypeMap]
  );

  const formatSlackMinutes = (value: number | null) => {
    if (value === null || !Number.isFinite(value)) {
      return "";
    }
    const rounded = Math.round(value);
    const abs = Math.abs(rounded);
    const hours = Math.floor(abs / 60);
    const minutes = abs % 60;
    const parts = [];
    if (hours > 0) {
      parts.push(`${hours}h`);
    }
    parts.push(`${minutes}m`);
    return `${rounded >= 0 ? "+" : "-"}${parts.join(" ")}`;
  };

  const formatBlocksSummary = (blocks: ScheduledBlockLite[]) => {
    if (!blocks.length) {
      return "—";
    }
    const start = Math.min(...blocks.map((block) => block.start_at));
    const end = Math.max(...blocks.map((block) => block.end_at_derived));
    const preview = blocks
      .slice()
      .sort((a, b) => a.start_at - b.start_at)
      .slice(0, 3)
      .map(
        (block) =>
          `${formatDate(block.start_at)} (${formatEstimateMinutes(
            block.duration_minutes
          )})`
      )
      .join(", ");
    const more = blocks.length > 3 ? ", ..." : "";
    return `${blocks.length} | ${formatDate(start)} -> ${formatDate(
      end
    )}${preview ? ` | ${preview}${more}` : ""}`;
  };

  const formatDependencyList = (deps: DependencyProjectionLite[]) => {
    if (!deps.length) {
      return "—";
    }
    return deps
      .map((dep) => {
        const lag = dep.lag_minutes ? `+${dep.lag_minutes}m` : "";
        return `${dep.title} [${dep.type}${lag} ${dep.status}]`;
      })
      .join("; ");
  };

  const formatDependencySummary = (item: ListViewItem) => {
    const incoming = item.dependencies_in ?? [];
    const outgoing = item.dependencies_out ?? [];
    if (incoming.length === 0 && outgoing.length === 0) {
      return "—";
    }
    const blockedByMap = new Map(
      item.blocked_by.map((dep) => [dep.item_id, dep])
    );
    const blockingMap = new Map(
      item.blocking.map((dep) => [dep.item_id, dep])
    );
    const parts: string[] = [];
    for (const dep of incoming) {
      const predecessorId = dep.predecessor_id ?? "";
      const title = itemById.get(predecessorId)?.title ?? predecessorId;
      const lag =
        dep.lag_minutes && dep.lag_minutes > 0
          ? `+${dep.lag_minutes}m`
          : "0m";
      const status = blockedByMap.get(predecessorId)?.status ?? "unknown";
      parts.push(`in:${title} (${dep.type} ${lag}, ${status})`);
    }
    for (const dep of outgoing) {
      const successorId = dep.successor_id ?? "";
      const title = itemById.get(successorId)?.title ?? successorId;
      const lag =
        dep.lag_minutes && dep.lag_minutes > 0
          ? `+${dep.lag_minutes}m`
          : "0m";
      const status = blockingMap.get(successorId)?.status ?? "unknown";
      parts.push(`out:${title} (${dep.type} ${lag}, ${status})`);
    }
    return parts.join("; ");
  };

  const columns = useMemo<Column[]>(
    () => [
      {
        key: "title",
        label: "Title",
        minWidth: 220,
        render: (
          item: ListViewItem,
          indent: number,
          dragHandle: ReactNode,
          actions?: ReactNode
        ) => (
          <div className="cell-title" style={{ paddingLeft: `${indent}px` }}>
            <span className="cell-title-text">
              {item.type === "task" ? (
                <span className="task-checkbox-wrap">
                  <input
                    type="checkbox"
                    className="task-checkbox"
                    checked={item.status === "done"}
                    onChange={(event) =>
                      void handleToggleTaskDone(item, event.target.checked)
                    }
                    onClick={(event) => event.stopPropagation()}
                  />
                </span>
              ) : null}
              {dragHandle}
              <span className="cell-title-label">{item.title || "—"}</span>
            </span>
            {actions}
          </div>
        ),
      },
      {
        key: "assignees",
        label: "Assignees",
        minWidth: 160,
        render: (item: ListViewItem) =>
          item.assignees.length > 0
            ? item.assignees.map((assignee) => assignee.id).join(", ")
            : "unassigned",
      },
      {
        key: "status",
        label: "Status",
        minWidth: 120,
        render: (item: ListViewItem) => (
          <span className="status-badge">{item.status || "—"}</span>
        ),
      },
      {
        key: "priority",
        label: "Priority",
        minWidth: 90,
        render: (item: ListViewItem) =>
          Number.isFinite(item.priority) ? item.priority : 0,
      },
      {
        key: "due_at",
        label: "Due",
        minWidth: 160,
        render: (item: ListViewItem) => formatDate(item.due_at),
      },
      {
        key: "completed_on",
        label: "Completed On",
        minWidth: 170,
        render: (item: ListViewItem) =>
          item.completed_on ? formatDate(item.completed_on) : "",
      },
      {
        key: "slack_minutes",
        label: "Slack",
        minWidth: 140,
        render: (item: ListViewItem) => {
          const value = item.slack_minutes;
          const formatted = formatSlackMinutes(value);
          if (!formatted) {
            return "";
          }
          return (
            <span className={value !== null && value < 0 ? "slack-negative" : ""}>
              {formatted}
            </span>
          );
        },
      },
      {
        key: "start_time",
        label: "Start Time",
        minWidth: 170,
        render: (item: ListViewItem) => {
          if (item.scheduled_blocks.length === 0) {
            return "—";
          }
          const earliest = Math.min(
            ...item.scheduled_blocks.map((block) => block.start_at)
          );
          return Number.isFinite(earliest) ? formatDate(earliest) : "—";
        },
      },
      {
        key: "scheduled_blocks",
        label: "Scheduled Blocks",
        minWidth: 240,
        render: (item: ListViewItem) => formatBlocksSummary(item.scheduled_blocks),
      },
      {
        key: "estimate_mode",
        label: "Estimate Mode",
        minWidth: 140,
        render: (item: ListViewItem) =>
          item.estimate_mode ??
          (item.type === "task" ? "manual" : "rollup"),
      },
      {
        key: "estimate_minutes",
        label: "Est Dur",
        minWidth: 140,
        render: (item: ListViewItem) => {
          const mode =
            item.estimate_mode ?? (item.type === "task" ? "manual" : "rollup");
          const estimate =
            mode === "rollup"
              ? item.rollup_estimate_minutes ?? item.estimate_minutes
              : item.estimate_minutes;
          return formatEstimateMinutes(estimate ?? 0);
        },
      },
      {
        key: "actual_minutes",
        label: "Actual",
        minWidth: 120,
        render: (item: ListViewItem) =>
          item.actual_minutes === null
            ? "—"
            : formatEstimateMinutes(item.actual_minutes),
      },
      {
        key: "dependencies",
        label: "Dependencies",
        minWidth: 160,
        render: (item: ListViewItem) => formatDependencySummary(item),
      },
      {
        key: "blocked_by",
        label: "Blocked By",
        minWidth: 220,
        render: (item: ListViewItem) => formatDependencyList(item.blocked_by),
      },
      {
        key: "blocking",
        label: "Blocking",
        minWidth: 220,
        render: (item: ListViewItem) => formatDependencyList(item.blocking),
      },
      {
        key: "blockers",
        label: "Blockers",
        minWidth: 120,
        render: (item: ListViewItem) => {
          // TODO: listItems does not include blocker objects yet; show active count.
          const count = item.blocked?.active_blocker_count ?? 0;
          return count > 0 ? String(count) : "0";
        },
      },
      {
        key: "tags",
        label: "Tags",
        minWidth: 160,
        render: (item: ListViewItem) =>
          item.tags.length > 0
            ? item.tags.map((tag) => tag.name).join(", ")
            : "[]",
      },
      {
        key: "notes",
        label: "Notes",
        minWidth: 200,
        render: (item: ListViewItem) => truncate(item.notes, 60),
      },
      {
        key: "health",
        label: "Health",
        minWidth: 160,
        render: (item: ListViewItem) => item.health ?? "unknown",
      },
      {
        key: "id",
        label: "ID",
        minWidth: 120,
        render: (item: ListViewItem) => (
          <span className="cell-id">{shortId(item.id)}</span>
        ),
      },
      {
        key: "delete",
        label: "",
        minWidth: 80,
        render: (item: ListViewItem) => (
          <button
            type="button"
            className="button button-ghost"
            onClick={() => handleDelete(item)}
          >
            Delete
          </button>
        ),
      },
    ],
    [
      handleToggleTaskDone,
      formatBlocksSummary,
      formatDependencyList,
      formatDependencySummary,
      formatSlackMinutes,
    ]
  );

  const [collapsedMilestones, setCollapsedMilestones] = useState<Set<string>>(
    () => new Set()
  );
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(
    () => new Set()
  );
  const [collapsedUngrouped, setCollapsedUngrouped] = useState(false);

  useEffect(() => {
    setCollapsedMilestones((prev) => {
      const milestoneIds = new Set(milestones.map((milestone) => milestone.id));
      return new Set(Array.from(prev).filter((id) => milestoneIds.has(id)));
    });
  }, [milestones]);

  useEffect(() => {
    setCollapsedTasks((prev) => {
      const taskIds = new Set(tasks.map((task) => task.id));
      return new Set(Array.from(prev).filter((id) => taskIds.has(id)));
    });
  }, [tasks]);

  const handleDelete = async (item: ListItem) => {
    if (!confirm(`Delete ${item.title}? This removes all descendants.`)) {
      return;
    }
    setError(null);
    try {
      await deleteItem(item.id);
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleRename = async (item: ListItem) => {
    const nextTitle = prompt("Rename item", item.title);
    if (!nextTitle || !nextTitle.trim()) {
      return;
    }
    setError(null);
    try {
      await updateItemFields(item.id, { title: nextTitle.trim() });
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleAddTaskUnder = async (parentId: string) => {
    setError(null);
    try {
      await createItem({
        type: "task",
        title: "New task",
        parent_id: parentId,
        due_at: null,
        estimate_minutes: 0,
      });
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleDuplicateTask = async (item: ListItem) => {
    setError(null);
    try {
      await duplicateTaskFromItem(item);
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleInlineCommit = async () => {
    if (!inlineAdd) {
      return;
    }
    const title = inlineTitle.trim();
    if (!title) {
      setInlineAdd(null);
      setInlineTitle("");
      return;
    }
    setError(null);
    try {
      await createItem({
        type: "task",
        title,
        parent_id: inlineAdd.parentId,
        due_at: null,
        estimate_minutes: 0,
      });
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setInlineAdd(null);
      setInlineTitle("");
    }
  };

  const handleInlineCancel = () => {
    setInlineAdd(null);
    setInlineTitle("");
  };

  const startInlineAdd = (groupKey: string, parentId: string) => {
    setInlineAdd({ groupKey, parentId });
    setInlineTitle("");
  };

  const handleCreateDependencyEdge = useCallback(
    async (
      predecessorId: string,
      successorId: string,
      type: "FS" | "SS" | "FF" | "SF" = "FS",
      lagMinutes = 0
    ) => {
      if (predecessorId === successorId) {
        return;
      }
      setError(null);
      try {
        await createDependencyEdge({
          predecessor_id: predecessorId,
          successor_id: successorId,
          type,
          lag_minutes: lagMinutes,
        });
        onRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [onRefresh]
  );

  const handleUpdateDependencyEdge = useCallback(
    async (edgeId: string, updates: { type?: string; lag_minutes?: number }) => {
      setError(null);
      try {
        await updateDependencyEdge({ edge_id: edgeId, ...updates });
        onRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [onRefresh]
  );

  const handleDeleteDependencyEdge = useCallback(
    async (edgeId: string) => {
      setError(null);
      try {
        await deleteDependencyEdge({ edge_id: edgeId });
        onRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [onRefresh]
  );

  const startEdit = (itemId: string, field: string, value: string) => {
    setEditing({ itemId, field });
    setEditValue(value);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditValue("");
    setEditingBlockId(null);
  };

  const getPrimaryBlock = (item: ListViewItem) => {
    if (item.scheduled_blocks.length === 0) {
      return null;
    }
    return item.scheduled_blocks.reduce((earliest, block) =>
      block.start_at < earliest.start_at ? block : earliest
    );
  };

  const startStartTimeEdit = (item: ListViewItem) => {
    const primary = getPrimaryBlock(item);
    setEditing({ itemId: item.id, field: "start_time" });
    setEditingBlockId(primary?.block_id ?? null);
    setEditValue(toDateTimeLocal(primary?.start_at ?? null));
  };

  const commitStartTimeEdit = async () => {
    if (!editing || editing.field !== "start_time") {
      return;
    }
    const item = itemById.get(editing.itemId);
    if (!item) {
      cancelEdit();
      return;
    }
    const startAt = new Date(editValue).getTime();
    const estimateSource =
      item.estimate_mode === "rollup"
        ? item.rollup_estimate_minutes ?? item.estimate_minutes
        : item.estimate_minutes;
    const durationMinutes = Math.floor(Number(estimateSource));
    if (!editValue || !Number.isFinite(startAt)) {
      setError("Start time is required.");
      return;
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      setError("Est Dur must be greater than 0 to schedule.");
      return;
    }
    setError(null);
    try {
      if (editingBlockId) {
        await mutate("scheduled_block.update", {
          block_id: editingBlockId,
          start_at: startAt,
          duration_minutes: durationMinutes,
        });
      } else {
        await mutate("scheduled_block.create", {
          item_id: item.id,
          start_at: startAt,
          duration_minutes: durationMinutes,
          source: "manual",
        });
      }
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      cancelEdit();
    }
  };

  const commitEdit = async () => {
    if (!editing) {
      return;
    }
    const item = itemById.get(editing.itemId);
    if (!item) {
      cancelEdit();
      return;
    }
    const value = editValue.trim();
    if (editing.field === "estimate_minutes") {
      const parsed = parseEstimateMinutesInput(value);
      if (parsed === null) {
        setError("Estimate must be minutes (30 min) or hours (2 hours or 2:30).");
        return;
      }
    }
    setError(null);
    try {
      switch (editing.field) {
        case "title":
          if (value) {
            await updateItemFields(item.id, { title: value });
          }
          break;
        case "status":
          await setStatus(item.id, value);
          break;
        case "priority": {
          const priority = Number(value);
          if (Number.isFinite(priority)) {
            await updateItemFields(item.id, { priority });
          }
          break;
        }
        case "due_at": {
          if (!value) {
            await updateItemFields(item.id, { due_at: null });
            break;
          }
          const dueAt = new Date(value).getTime();
          if (Number.isFinite(dueAt)) {
            await updateItemFields(item.id, { due_at: dueAt });
          }
          break;
        }
        case "tags": {
          const tags = value
            ? value
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean)
            : [];
          await setItemTags(item.id, tags);
          break;
        }
        case "notes":
          await updateItemFields(item.id, { notes: value ? value : null });
          break;
        case "estimate_mode": {
          const mode = value === "rollup" ? "rollup" : "manual";
          await updateItemFields(
            item.id,
            mode === "rollup"
              ? { estimate_mode: mode, estimate_minutes: 0 }
              : { estimate_mode: mode }
          );
          break;
        }
        case "estimate_minutes": {
          const minutes = parseEstimateMinutesInput(value);
          if (minutes !== null && Number.isFinite(minutes) && minutes >= 0) {
            await updateItemFields(item.id, {
              estimate_minutes: Math.floor(minutes),
            });
          }
          break;
        }
        case "health":
          await updateItemFields(item.id, {
            health: value,
            health_mode: "manual",
          });
          break;
        default:
          break;
      }
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      cancelEdit();
    }
  };

  const renderEditableCell = (
    item: ListViewItem,
    field: string,
    display: ReactNode,
    editor: ReactNode,
    initialValue: string
  ) => {
    const isEditing = editing?.itemId === item.id && editing.field === field;
    if (isEditing) {
      return <div className="cell-editing">{editor}</div>;
    }
    return (
      <button
        type="button"
        className="cell-button"
        onClick={(event) => {
          event.stopPropagation();
          startEdit(item.id, field, initialValue);
        }}
      >
        {display}
      </button>
    );
  };

  // Edges are truth; Blocked By/Blocking are projections; Dependencies is the editor.
  const renderDependenciesEditor = (item: ListViewItem) => {
    const incoming = item.dependencies_in ?? [];
    const outgoing = item.dependencies_out ?? [];
    const incomingIds = incoming
      .map((dep) => dep.predecessor_id)
      .filter(Boolean) as string[];
    const outgoingIds = outgoing
      .map((dep) => dep.successor_id)
      .filter(Boolean) as string[];
    const blockedByMap = new Map(
      item.blocked_by.map((dep) => [dep.item_id, dep])
    );
    const blockingMap = new Map(
      item.blocking.map((dep) => [dep.item_id, dep])
    );

    return (
      <div className="cell-editing dependency-editor">
        <div className="dependency-hint">
          Lag (min) adds a delay between predecessor and successor.
        </div>
        <div className="dependency-section">
          <div className="dependency-section-title">Depends on</div>
          {incoming.length === 0 ? (
            <div className="dependency-empty">No dependencies</div>
          ) : (
            incoming.map((dep) => {
              const predecessorId = dep.predecessor_id ?? "";
              const edgeId = dep.edge_id;
              const title = itemById.get(predecessorId)?.title ?? predecessorId;
              const lagValue = dep.lag_minutes ?? 0;
              const status =
                blockedByMap.get(predecessorId)?.status ?? "unknown";
              return (
                <div key={edgeId} className="dependency-row">
                  <span className="dependency-title">{title}</span>
                <select
                  value={dep.type}
                  onChange={(event) =>
                    void handleUpdateDependencyEdge(edgeId, {
                      type: event.target.value,
                    })
                  }
                >
                  <option value="FS">FS</option>
                  <option value="SS">SS</option>
                  <option value="FF">FF</option>
                  <option value="SF">SF</option>
                </select>
                <span className="dependency-label">Lag (min)</span>
                <input
                  key={`${edgeId}-${lagValue}`}
                  type="number"
                  min={0}
                  placeholder="Lag (min)"
                  aria-label="Lag minutes"
                    defaultValue={lagValue}
                    onBlur={(event) => {
                      const next = Number(event.currentTarget.value);
                      if (!Number.isFinite(next) || next < 0) {
                        return;
                      }
                      if (next !== lagValue) {
                        void handleUpdateDependencyEdge(edgeId, {
                          lag_minutes: Math.floor(next),
                        });
                      }
                    }}
                  />
                  <span className="dependency-status">{status}</span>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => void handleDeleteDependencyEdge(edgeId)}
                  >
                    Remove
                  </button>
                </div>
              );
            })
          )}
          <ItemAutocomplete
            scopeId={selectedProjectId}
            excludeIds={[item.id, ...incomingIds]}
            placeholder="Add predecessor"
            onSelect={(dependency) =>
              void handleCreateDependencyEdge(dependency.id, item.id)
            }
            autoFocus
          />
        </div>
        <div className="dependency-section">
          <div className="dependency-section-title">Blocking</div>
          {outgoing.length === 0 ? (
            <div className="dependency-empty">No dependents</div>
          ) : (
            outgoing.map((dep) => {
              const successorId = dep.successor_id ?? "";
              const edgeId = dep.edge_id;
              const title = itemById.get(successorId)?.title ?? successorId;
              const lagValue = dep.lag_minutes ?? 0;
              const status = blockingMap.get(successorId)?.status ?? "unknown";
              return (
                <div key={edgeId} className="dependency-row">
                  <span className="dependency-title">{title}</span>
                <select
                  value={dep.type}
                  onChange={(event) =>
                    void handleUpdateDependencyEdge(edgeId, {
                      type: event.target.value,
                    })
                  }
                >
                  <option value="FS">FS</option>
                  <option value="SS">SS</option>
                  <option value="FF">FF</option>
                  <option value="SF">SF</option>
                </select>
                <span className="dependency-label">Lag (min)</span>
                <input
                  key={`${edgeId}-${lagValue}`}
                  type="number"
                  min={0}
                  placeholder="Lag (min)"
                  aria-label="Lag minutes"
                    defaultValue={lagValue}
                    onBlur={(event) => {
                      const next = Number(event.currentTarget.value);
                      if (!Number.isFinite(next) || next < 0) {
                        return;
                      }
                      if (next !== lagValue) {
                        void handleUpdateDependencyEdge(edgeId, {
                          lag_minutes: Math.floor(next),
                        });
                      }
                    }}
                  />
                  <span className="dependency-status">{status}</span>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => void handleDeleteDependencyEdge(edgeId)}
                  >
                    Remove
                  </button>
                </div>
              );
            })
          )}
          <ItemAutocomplete
            scopeId={selectedProjectId}
            excludeIds={[item.id, ...outgoingIds]}
            placeholder="Add successor"
            onSelect={(dependency) =>
              void handleCreateDependencyEdge(item.id, dependency.id)
            }
          />
        </div>
        <button
          type="button"
          className="button button-ghost"
          onClick={cancelEdit}
        >
          Done
        </button>
      </div>
    );
  };

  const renderCell = (
    item: ListViewItem,
    column: Column,
    indent: number,
    dragHandle: ReactNode | null,
    actions?: ReactNode
  ) => {
    if (column.key === "title") {
      const isEditing = editing?.itemId === item.id && editing.field === "title";
      if (isEditing) {
        return (
          <div className="cell-editing">
            <input
              value={editValue}
              onChange={(event) => setEditValue(event.target.value)}
              onBlur={() => void commitEdit()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitEdit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEdit();
                }
              }}
              autoFocus
            />
          </div>
        );
      }
      return (
        <div
          className="cell-title-editable"
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest("button")) {
              return;
            }
            startEdit(item.id, "title", item.title ?? "");
          }}
        >
          {column.render(item, indent, dragHandle, actions)}
        </div>
      );
    }
    if (column.key === "status") {
      return renderEditableCell(
        item,
        "status",
        column.render(item, 0, null),
        <select
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onBlur={() => void commitEdit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitEdit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          autoFocus
        >
          <option value="backlog">backlog</option>
          <option value="ready">ready</option>
          <option value="in_progress">in_progress</option>
          <option value="blocked">blocked</option>
          <option value="review">review</option>
          <option value="done">done</option>
          <option value="canceled">canceled</option>
        </select>,
        item.status ?? ""
      );
    }
    if (column.key === "priority") {
      return renderEditableCell(
        item,
        "priority",
        column.render(item, 0, null),
        <input
          type="number"
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onBlur={() => void commitEdit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitEdit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          autoFocus
        />,
        String(item.priority ?? 0)
      );
    }
    if (column.key === "estimate_mode") {
      const initial =
        item.estimate_mode ?? (item.type === "task" ? "manual" : "rollup");
      return renderEditableCell(
        item,
        "estimate_mode",
        column.render(item, 0, null),
        <select
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onBlur={() => void commitEdit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitEdit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          autoFocus
        >
          <option value="manual">manual</option>
          <option value="rollup">rollup</option>
        </select>,
        initial
      );
    }
    if (column.key === "estimate_minutes") {
      if (item.estimate_mode === "rollup") {
        return column.render(item, 0, null);
      }
      return renderEditableCell(
        item,
        "estimate_minutes",
        column.render(item, 0, null),
        <input
          type="text"
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onBlur={() => void commitEdit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitEdit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          autoFocus
        />,
        formatEstimateMinutes(item.estimate_minutes ?? 0)
      );
    }
    if (column.key === "due_at") {
      return renderEditableCell(
        item,
        "due_at",
        column.render(item, 0, null),
        <input
          type="datetime-local"
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onBlur={() => void commitEdit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitEdit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          autoFocus
        />,
        toDateTimeLocal(item.due_at ?? null)
      );
    }
    if (column.key === "start_time") {
      const isEditing =
        editing?.itemId === item.id && editing.field === "start_time";
      if (isEditing) {
        return (
          <div className="cell-editing dependency-editor">
            <div className="dependency-row">
              <input
                type="datetime-local"
                value={editValue}
                onChange={(event) => setEditValue(event.target.value)}
                onBlur={() => void commitStartTimeEdit()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitStartTimeEdit();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelEdit();
                  }
                }}
                autoFocus
              />
            </div>
          </div>
        );
      }
      return (
        <button
          type="button"
          className="cell-button"
          onClick={(event) => {
            event.stopPropagation();
            startStartTimeEdit(item);
          }}
        >
          {column.render(item, 0, null)}
        </button>
      );
    }
    if (column.key === "tags") {
      return renderEditableCell(
        item,
        "tags",
        column.render(item, 0, null),
        <input
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onBlur={() => void commitEdit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitEdit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          autoFocus
        />,
        (item.tags ?? []).map((tag) => tag.name).join(", ")
      );
    }
    if (column.key === "dependencies") {
      const isEditing =
        editing?.itemId === item.id && editing.field === "dependencies";
      if (isEditing) {
        return renderDependenciesEditor(item);
      }
      return (
        <button
          type="button"
          className="cell-button"
          onClick={(event) => {
            event.stopPropagation();
            startEdit(item.id, "dependencies", "");
          }}
        >
          {column.render(item, 0, null)}
        </button>
      );
    }
    if (column.key === "notes") {
      return renderEditableCell(
        item,
        "notes",
        column.render(item, 0, null),
        <input
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onBlur={() => void commitEdit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitEdit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          autoFocus
        />,
        item.notes ?? ""
      );
    }
    if (column.key === "health") {
      return renderEditableCell(
        item,
        "health",
        column.render(item, 0, null),
        <select
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onBlur={() => void commitEdit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitEdit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          autoFocus
        >
          <option value="on_track">on_track</option>
          <option value="at_risk">at_risk</option>
          <option value="behind">behind</option>
          <option value="ahead">ahead</option>
          <option value="unknown">unknown</option>
        </select>,
        item.health ?? "unknown"
      );
    }
    return column.render(item, 0, null);
  };

  const handleMove = async (
    itemId: string,
    parentId: string | null,
    beforeId?: string,
    afterId?: string
  ) => {
    setError(null);
    try {
      await mutate("move_item", {
        item_id: itemId,
        parent_id: parentId,
        before_id: beforeId,
        after_id: afterId,
      });
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const isDescendant = useCallback(
    (itemId: string, potentialParentId: string | null) => {
      if (!potentialParentId) {
        return false;
      }
      if (potentialParentId === itemId) {
        return true;
      }
      const stack = [...(taskChildren.get(itemId) ?? [])];
      while (stack.length > 0) {
        const next = stack.pop();
        if (!next) {
          continue;
        }
        if (next.id === potentialParentId) {
          return true;
        }
        const children = taskChildren.get(next.id) ?? [];
        for (const child of children) {
          stack.push(child);
        }
      }
      return false;
    },
    [taskChildren]
  );

  const canMoveTaskToParent = useCallback(
    (itemId: string, targetParentId: string | null) => {
      const item = itemById.get(itemId);
      if (!item || item.type !== "task") {
        return false;
      }
      if (item.parent_id === targetParentId) {
        return false;
      }
      if (isDescendant(itemId, targetParentId)) {
        return false;
      }
      return true;
    },
    [isDescendant, itemById]
  );

  const handleMoveToParent = async (
    itemId: string,
    targetParentId: string | null
  ) => {
    setError(null);
    try {
      await updateItemFields(itemId, { parent_id: targetParentId });
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleMoveToParentAtPosition = async (
    itemId: string,
    targetParentId: string,
    position: "top" | "bottom"
  ) => {
    const siblings = taskChildren.get(targetParentId) ?? [];
    const sortOrders = siblings.map((task) => task.sort_order);
    const minSort = sortOrders.length > 0 ? Math.min(...sortOrders) : 0;
    const maxSort = sortOrders.length > 0 ? Math.max(...sortOrders) : 0;
    const nextSort = position === "top" ? minSort - 1 : maxSort + 1;

    setError(null);
    try {
      await updateItemFields(itemId, {
        parent_id: targetParentId,
        sort_order: nextSort,
      });
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleMoveToParentAppend = async (
    itemId: string,
    targetParentId: string
  ) => {
    const siblings = taskChildren.get(targetParentId) ?? [];
    const sortOrders = siblings.map((task) => task.sort_order);
    const maxSort = sortOrders.length > 0 ? Math.max(...sortOrders) : 0;
    const nextSort = maxSort + 1;
    setError(null);
    try {
      await updateItemFields(itemId, {
        parent_id: targetParentId,
        sort_order: nextSort,
      });
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleMoveAcrossParents = async (
    itemId: string,
    targetParentId: string | null,
    sortOrder: number
  ) => {
    setError(null);
    try {
      await updateItemFields(itemId, {
        parent_id: targetParentId,
        sort_order: sortOrder,
      });
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };


  const handleDragStart = (itemId: string, groupKey: string) => (
    event: DragEvent
  ) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", itemId);
    setDragging({ itemId, groupKey });
  };

  const handleDragEnd = () => {
    setDragging(null);
    setDragOver(null);
    setMilestoneDrop(null);
  };

  const canDragOverRow = (itemId: string, groupKey: string) => {
    if (!dragging) {
      return false;
    }
    if (dragging.groupKey === groupKey) {
      return true;
    }
    const targetItem = itemById.get(itemId);
    if (!targetItem) {
      return false;
    }
    if (
      targetItem.type === "task" &&
      canMoveTaskToParent(dragging.itemId, targetItem.id)
    ) {
      return true;
    }
    const targetParentId = targetItem.parent_id ?? null;
    return canMoveTaskToParent(dragging.itemId, targetParentId);
  };

  const handleDragOverRow = (itemId: string, groupKey: string) => (
    event: DragEvent
  ) => {
    if (!canDragOverRow(itemId, groupKey)) {
      return;
    }
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const upperZone = rect.top + rect.height * 0.25;
    const lowerZone = rect.top + rect.height * 0.75;
    const targetItem = itemById.get(itemId);
    const canNestInto =
      dragging &&
      targetItem?.type === "task" &&
      dragging.groupKey !== groupKey &&
      canMoveTaskToParent(dragging.itemId, itemId);
    if (canNestInto && event.clientY > upperZone && event.clientY < lowerZone) {
      setDragOver({ itemId, groupKey, position: "into" });
      return;
    }
    const position = event.clientY < midpoint ? "before" : "after";
    setDragOver({ itemId, groupKey, position });
  };

  const handleDragOverGroup = (
    targetParentId: string | null,
    groupKey: string
  ) => (event: DragEvent) => {
    if (!dragging) {
      return;
    }
    if (!canMoveTaskToParent(dragging.itemId, targetParentId)) {
      return;
    }
    event.preventDefault();
    setDragOver({
      itemId: targetParentId ?? "ungrouped",
      groupKey,
      position: "into",
    });
  };

  const handleDropOnGroup = (targetParentId: string | null) => (
    event: DragEvent
  ) => {
    if (!dragging) {
      return;
    }
    if (!canMoveTaskToParent(dragging.itemId, targetParentId)) {
      return;
    }
    event.preventDefault();
    void handleMoveToParent(dragging.itemId, targetParentId);
    setDragOver(null);
  };

  const handleMilestoneDragOver = (milestoneId: string) => (event: DragEvent) => {
    if (!dragging) {
      return;
    }
    if (dragging.groupKey === "milestones") {
      handleDragOverRow(milestoneId, "milestones")(event);
      return;
    }
    const draggingItem = itemById.get(dragging.itemId);
    if (!draggingItem || draggingItem.type !== "task") {
      return;
    }
    if (!canMoveTaskToParent(dragging.itemId, milestoneId)) {
      return;
    }
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const position = event.clientY < midpoint ? "top" : "bottom";
    setMilestoneDrop({ milestoneId, position });
  };

  const handleMilestoneDrop = (milestoneId: string) => (event: DragEvent) => {
    if (!dragging) {
      return;
    }
    if (dragging.groupKey === "milestones") {
      handleDropBefore(milestoneId, "milestones")(event);
      setMilestoneDrop(null);
      return;
    }
    if (milestoneDrop?.milestoneId === milestoneId) {
      event.preventDefault();
      void handleMoveToParentAtPosition(
        dragging.itemId,
        milestoneId,
        milestoneDrop.position
      );
      setMilestoneDrop(null);
      return;
    }
    handleDropOnGroup(milestoneId)(event);
    setMilestoneDrop(null);
  };

  const handleDropBefore = (itemId: string, groupKey: string) => (
    event: DragEvent
  ) => {
    if (!dragging) {
      return;
    }
    if (!canDragOverRow(itemId, groupKey)) {
      return;
    }
    event.preventDefault();
    const targetItem = itemById.get(itemId);
    const parentId = targetItem?.parent_id ?? null;
    if (dragging.itemId === itemId) {
      return;
    }
    if (dragging.groupKey === groupKey) {
      void handleMove(dragging.itemId, parentId, itemId, undefined);
      setDragOver(null);
      return;
    }
    const targetSort = targetItem?.sort_order ?? 0;
    void handleMoveAcrossParents(dragging.itemId, parentId, targetSort - 1);
    setDragOver(null);
  };

  const handleDropAfter = (itemId: string, groupKey: string) => (
    event: DragEvent
  ) => {
    if (!dragging) {
      return;
    }
    if (!canDragOverRow(itemId, groupKey)) {
      return;
    }
    event.preventDefault();
    const targetItem = itemById.get(itemId);
    const parentId = targetItem?.parent_id ?? null;
    if (dragging.itemId === itemId) {
      return;
    }
    if (dragging.groupKey === groupKey) {
      void handleMove(dragging.itemId, parentId, undefined, itemId);
      setDragOver(null);
      return;
    }
    const targetSort = targetItem?.sort_order ?? 0;
    void handleMoveAcrossParents(dragging.itemId, parentId, targetSort + 1);
    setDragOver(null);
  };

  const handleDropOnRow = (itemId: string, groupKey: string) => (
    event: DragEvent
  ) => {
    if (dragOver?.position === "into") {
      event.preventDefault();
      if (dragging && canMoveTaskToParent(dragging.itemId, itemId)) {
        void handleMoveToParentAppend(dragging.itemId, itemId);
      }
      setDragOver(null);
      return;
    }
    if (dragOver?.position === "after") {
      handleDropAfter(itemId, groupKey)(event);
      return;
    }
    handleDropBefore(itemId, groupKey)(event);
  };

  const handleDragOverAppend = (
    groupKey: string,
    parentId: string | null,
    lastItemId?: string
  ) => (event: DragEvent) => {
    if (!dragging) {
      return;
    }
    const allowDrop =
      dragging.groupKey === groupKey ||
      (groupKey !== "milestones" &&
        canMoveTaskToParent(dragging.itemId, parentId));
    if (!allowDrop) {
      return;
    }
    event.preventDefault();
    if (lastItemId) {
      setDragOver({ itemId: lastItemId, groupKey, position: "after" });
      return;
    }
    setDragOver({
      itemId: parentId ?? "ungrouped",
      groupKey: `move-target:${parentId ?? "ungrouped"}`,
      position: "into",
    });
  };

  const handleDropAppend = (
    groupKey: string,
    parentId: string | null,
    lastItemId?: string
  ) => (event: DragEvent) => {
    if (lastItemId) {
      handleDropAfter(lastItemId, groupKey)(event);
      return;
    }
    handleDropOnGroup(parentId)(event);
  };


  const renderDragHandle = (itemId: string, groupKey: string) => (
    <span
      className="drag-handle"
      draggable
      onDragStart={handleDragStart(itemId, groupKey)}
      onDragEnd={handleDragEnd}
      title="Drag to reorder"
    >
      ⋮⋮
    </span>
  );

  const showLoading = loading && items.length === 0;

  if (!selectedProjectId) {
    return (
      <div className="list-view list-view-container">Select a project</div>
    );
  }

  return (
    <div className="list-view list-view-container">
      {showLoading ? <div className="list-empty">Loading…</div> : null}
      {error ? <div className="error">{error}</div> : null}
      <div className="list-scroll">
        <table className="list-table list-table-wide">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  style={{ minWidth: column.minWidth }}
                  className={column.key === "title" ? "title-header" : undefined}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!showLoading && milestones.length === 0 && ungroupedTasks.length === 0 ? (
              <tr>
                  <td colSpan={columns.length} className="list-empty">
                    No items yet
                  </td>
                </tr>
              ) : (
                <>
                <tr
                  className={
                    dragOver?.groupKey === "move-target:ungrouped"
                      ? "group-row drag-over"
                      : "group-row"
                  }
                  onDragOver={handleDragOverGroup(
                    ungroupedParentId,
                    "move-target:ungrouped"
                  )}
                  onDrop={handleDropOnGroup(ungroupedParentId)}
                >
                  <td colSpan={columns.length}>
                    <button
                      type="button"
                      className="group-toggle"
                      onClick={() => setCollapsedUngrouped((prev) => !prev)}
                    >
                      {collapsedUngrouped ? "▶" : "▼"} Ungrouped
                    </button>
                  </td>
                </tr>
                {collapsedUngrouped
                  ? null
                  : ungroupedTasks.map((item) => {
                      const children = taskChildren.get(item.id) ?? [];
                      const groupKey = "ungrouped";
                      const actions = undefined;
                      const isTaskCollapsed = collapsedTasks.has(item.id);
                      const taskDragHandle = (
                        <span className="cell-title-controls">
                          {renderDragHandle(item.id, groupKey)}
                          {children.length > 0 ? (
                            <button
                              type="button"
                              className="group-toggle"
                              onClick={(event) => {
                                event.stopPropagation();
                                setCollapsedTasks((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(item.id)) {
                                    next.delete(item.id);
                                  } else {
                                    next.add(item.id);
                                  }
                                  return next;
                                });
                              }}
                            >
                              {isTaskCollapsed ? "▶" : "▼"}
                            </button>
                          ) : null}
                        </span>
                      );
                      return (
                        <Fragment key={item.id}>
                            <ContextMenu.Root>
                              <ContextMenu.Trigger asChild>
                                <tr
                                  className={
                                    dragOver?.itemId === item.id &&
                                    dragOver.groupKey === groupKey
                                      ? dragOver.position === "into"
                                        ? "drag-over-into"
                                        : dragOver.position === "after"
                                          ? "drag-over-bottom"
                                          : "drag-over-top"
                                      : undefined
                                  }
                                  onDragOver={handleDragOverRow(item.id, groupKey)}
                                  onDrop={handleDropOnRow(item.id, groupKey)}
                                >
                                    {columns.map((column) => (
                                      <td key={`${item.id}-${column.key}`}>
                                        {renderCell(
                                          item,
                                          column,
                                          item.depth * 16,
                                          taskDragHandle,
                                          actions
                                        )}
                                      </td>
                                    ))}
                                </tr>
                              </ContextMenu.Trigger>
                              <ContextMenu.Portal>
                                <ContextMenu.Content className="context-menu-content">
                                  <ContextMenu.Item
                                    className="context-menu-item"
                                    onSelect={() => handleDelete(item)}
                                  >
                                    Delete task
                                  </ContextMenu.Item>
                                  <ContextMenu.Item
                                    className="context-menu-item"
                                    onSelect={() => handleDuplicateTask(item)}
                                  >
                                    Duplicate task
                                  </ContextMenu.Item>
                                  <ContextMenu.Item
                                    className="context-menu-item"
                                    disabled
                                  >
                                    Move to…
                                  </ContextMenu.Item>
                                </ContextMenu.Content>
                              </ContextMenu.Portal>
                            </ContextMenu.Root>
                          {isTaskCollapsed ? null : (
                            <>
                              {children.map((child) => {
                                const childGroupKey = `task:${item.id}`;
                                const childActions = undefined;
                                return (
                                  <ContextMenu.Root key={child.id}>
                                    <ContextMenu.Trigger asChild>
                                      <tr
                                        className={
                                          dragOver?.itemId === child.id &&
                                          dragOver.groupKey === childGroupKey
                                            ? dragOver.position === "into"
                                              ? "drag-over-into"
                                              : dragOver.position === "after"
                                                ? "drag-over-bottom"
                                                : "drag-over-top"
                                            : undefined
                                        }
                                        onDragOver={handleDragOverRow(
                                          child.id,
                                          childGroupKey
                                        )}
                                        onDrop={handleDropOnRow(
                                          child.id,
                                          childGroupKey
                                        )}
                                      >
                                        {columns.map((column) => (
                                          <td key={`${child.id}-${column.key}`}>
                                            {renderCell(
                                              child,
                                              column,
                                              child.depth * 16,
                                              renderDragHandle(child.id, childGroupKey),
                                              childActions
                                            )}
                                          </td>
                                        ))}
                                      </tr>
                                    </ContextMenu.Trigger>
                                    <ContextMenu.Portal>
                                      <ContextMenu.Content className="context-menu-content">
                                        <ContextMenu.Item
                                          className="context-menu-item"
                                          onSelect={() => handleDelete(child)}
                                        >
                                          Delete task
                                        </ContextMenu.Item>
                                        <ContextMenu.Item
                                          className="context-menu-item"
                                          onSelect={() =>
                                            handleDuplicateTask(child)
                                          }
                                        >
                                          Duplicate task
                                        </ContextMenu.Item>
                                        <ContextMenu.Item
                                          className="context-menu-item"
                                          disabled
                                        >
                                          Move to…
                                        </ContextMenu.Item>
                                      </ContextMenu.Content>
                                    </ContextMenu.Portal>
                                  </ContextMenu.Root>
                                );
                              })}
                              <tr className="add-row">
                                <td colSpan={columns.length}>
                                  {inlineAdd?.groupKey === `subtask:${item.id}` ? (
                                    <input
                                      className="add-row-input"
                                      value={inlineTitle}
                                      onChange={(event) =>
                                        setInlineTitle(event.target.value)
                                      }
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                          event.preventDefault();
                                          void handleInlineCommit();
                                        }
                                        if (event.key === "Escape") {
                                          event.preventDefault();
                                          handleInlineCancel();
                                        }
                                      }}
                                      placeholder="New subtask title"
                                      autoFocus
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      className="add-row-button"
                                      onClick={() =>
                                        startInlineAdd(
                                          `subtask:${item.id}`,
                                          item.id
                                        )
                                      }
                                    >
                                      Add subtask…
                                    </button>
                                  )}
                                </td>
                              </tr>
                            </>
                          )}
                        </Fragment>
                      );
                    })}
                <tr className="add-row">
                  <td colSpan={columns.length}>
                    <div
                      onDragOver={handleDragOverAppend(
                        "ungrouped",
                        ungroupedParentId,
                        getLastVisibleId(ungroupedTasks)
                      )}
                      onDrop={handleDropAppend(
                        "ungrouped",
                        ungroupedParentId,
                        getLastVisibleId(ungroupedTasks)
                      )}
                    >
                    {inlineAdd?.groupKey === "ungrouped" ? (
                      <input
                        className="add-row-input"
                        value={inlineTitle}
                        onChange={(event) => setInlineTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void handleInlineCommit();
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            handleInlineCancel();
                          }
                        }}
                        placeholder="New task title"
                        autoFocus
                      />
                    ) : (
                      <button
                        type="button"
                        className="add-row-button"
                        onClick={() => startInlineAdd("ungrouped", ungroupedParentId)}
                      >
                        Add task…
                      </button>
                    )}
                    </div>
                  </td>
                </tr>
                {milestones.map((milestone) => {
                  const isCollapsed = collapsedMilestones.has(milestone.id);
                  const milestoneTasks = tasksUnderMilestone.get(milestone.id) ?? [];
                  const groupKey = `milestone:${milestone.id}`;
                  const milestoneActions = undefined;
                  const milestoneDragHandle = (
                    <span className="cell-title-controls">
                      {renderDragHandle(milestone.id, "milestones")}
                      <button
                        type="button"
                        className="group-toggle"
                        onClick={() =>
                          setCollapsedMilestones((prev) => {
                            const next = new Set(prev);
                            if (next.has(milestone.id)) {
                              next.delete(milestone.id);
                            } else {
                              next.add(milestone.id);
                            }
                            return next;
                          })
                        }
                      >
                        {isCollapsed ? "▶" : "▼"}
                      </button>
                    </span>
                  );
                  return (
                    <Fragment key={milestone.id}>
                      <ContextMenu.Root>
                        <ContextMenu.Trigger asChild>
                          <tr
                            className={
                              dragOver &&
                              ((dragOver.groupKey === "milestones" &&
                                dragOver.itemId === milestone.id) ||
                                dragOver.groupKey === `move-target:${milestone.id}`)
                                ? "group-row drag-over"
                                : milestoneDrop?.milestoneId === milestone.id
                                  ? milestoneDrop.position === "top"
                                    ? "group-row milestone-drop-top"
                                    : "group-row milestone-drop-bottom"
                                  : "group-row"
                            }
                            onDragOver={handleMilestoneDragOver(milestone.id)}
                            onDrop={handleMilestoneDrop(milestone.id)}
                          >
                            {columns.map((column) => (
                              <td key={`${milestone.id}-${column.key}`}>
                                {renderCell(
                                  milestone,
                                  column,
                                  milestone.depth * 16,
                                  milestoneDragHandle,
                                  milestoneActions
                                )}
                              </td>
                            ))}
                          </tr>
                        </ContextMenu.Trigger>
                        <ContextMenu.Portal>
                          <ContextMenu.Content className="context-menu-content">
                            <ContextMenu.Item
                              className="context-menu-item"
                              onSelect={() => handleAddTaskUnder(milestone.id)}
                            >
                              Add task under milestone
                            </ContextMenu.Item>
                            <ContextMenu.Item
                              className="context-menu-item"
                              onSelect={() => handleRename(milestone)}
                            >
                              Rename milestone
                            </ContextMenu.Item>
                            <ContextMenu.Separator className="context-menu-separator" />
                            <ContextMenu.Item
                              className="context-menu-item"
                              onSelect={() => handleDelete(milestone)}
                            >
                              Delete milestone
                            </ContextMenu.Item>
                          </ContextMenu.Content>
                        </ContextMenu.Portal>
                      </ContextMenu.Root>
                      {isCollapsed
                        ? null
                        : milestoneTasks.map((item) => {
                            const children = taskChildren.get(item.id) ?? [];
                            const actions = undefined;
                            const isTaskCollapsed = collapsedTasks.has(item.id);
                            const taskDragHandle = (
                              <span className="cell-title-controls">
                                {renderDragHandle(item.id, groupKey)}
                                {children.length > 0 ? (
                                  <button
                                    type="button"
                                    className="group-toggle"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setCollapsedTasks((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(item.id)) {
                                          next.delete(item.id);
                                        } else {
                                          next.add(item.id);
                                        }
                                        return next;
                                      });
                                    }}
                                  >
                                    {isTaskCollapsed ? "▶" : "▼"}
                                  </button>
                                ) : null}
                              </span>
                            );
                            return (
                              <Fragment key={item.id}>
                                <ContextMenu.Root>
                                  <ContextMenu.Trigger asChild>
                                    <tr
                                      className={
                                        dragOver?.itemId === item.id &&
                                        dragOver.groupKey === groupKey
                                          ? dragOver.position === "into"
                                            ? "drag-over-into"
                                            : dragOver.position === "after"
                                              ? "drag-over-bottom"
                                              : "drag-over-top"
                                          : undefined
                                      }
                                      onDragOver={handleDragOverRow(item.id, groupKey)}
                                      onDrop={handleDropOnRow(item.id, groupKey)}
                                    >
                                      {columns.map((column) => (
                                        <td key={`${item.id}-${column.key}`}>
                                          {renderCell(
                                            item,
                                            column,
                                            item.depth * 16,
                                            taskDragHandle,
                                            actions
                                          )}
                                        </td>
                                      ))}
                                    </tr>
                                  </ContextMenu.Trigger>
                                  <ContextMenu.Portal>
                                    <ContextMenu.Content className="context-menu-content">
                                      <ContextMenu.Item
                                        className="context-menu-item"
                                        onSelect={() => handleDelete(item)}
                                      >
                                        Delete task
                                      </ContextMenu.Item>
                                      <ContextMenu.Item
                                        className="context-menu-item"
                                        onSelect={() => handleDuplicateTask(item)}
                                      >
                                        Duplicate task
                                      </ContextMenu.Item>
                                      <ContextMenu.Item
                                        className="context-menu-item"
                                        disabled
                                      >
                                        Move to…
                                      </ContextMenu.Item>
                                    </ContextMenu.Content>
                                  </ContextMenu.Portal>
                                </ContextMenu.Root>
                                {isTaskCollapsed ? null : (
                                  <>
                                    {children.map((child) => {
                                      const childGroupKey = `task:${item.id}`;
                                      const childActions = undefined;
                                      return (
                                        <ContextMenu.Root key={child.id}>
                                          <ContextMenu.Trigger asChild>
                                            <tr
                                              className={
                                                dragOver?.itemId === child.id &&
                                                dragOver.groupKey === childGroupKey
                                                  ? dragOver.position === "into"
                                                    ? "drag-over-into"
                                                    : dragOver.position === "after"
                                                      ? "drag-over-bottom"
                                                      : "drag-over-top"
                                                  : undefined
                                              }
                                              onDragOver={handleDragOverRow(
                                                child.id,
                                                childGroupKey
                                              )}
                                              onDrop={handleDropOnRow(
                                                child.id,
                                                childGroupKey
                                              )}
                                            >
                                              {columns.map((column) => (
                                                <td key={`${child.id}-${column.key}`}>
                                                  {renderCell(
                                                    child,
                                                    column,
                                                    child.depth * 16,
                                                    renderDragHandle(
                                                      child.id,
                                                      childGroupKey
                                                    ),
                                                    childActions
                                                  )}
                                                </td>
                                              ))}
                                            </tr>
                                          </ContextMenu.Trigger>
                                          <ContextMenu.Portal>
                                            <ContextMenu.Content className="context-menu-content">
                                              <ContextMenu.Item
                                                className="context-menu-item"
                                                onSelect={() => handleDelete(child)}
                                              >
                                                Delete task
                                              </ContextMenu.Item>
                                              <ContextMenu.Item
                                                className="context-menu-item"
                                                onSelect={() =>
                                                  handleDuplicateTask(child)
                                                }
                                              >
                                                Duplicate task
                                              </ContextMenu.Item>
                                              <ContextMenu.Item
                                                className="context-menu-item"
                                                disabled
                                              >
                                                Move to…
                                              </ContextMenu.Item>
                                            </ContextMenu.Content>
                                          </ContextMenu.Portal>
                                        </ContextMenu.Root>
                                      );
                                    })}
                                    <tr className="add-row">
                                      <td colSpan={columns.length}>
                                        {inlineAdd?.groupKey === `subtask:${item.id}` ? (
                                          <input
                                            className="add-row-input"
                                            value={inlineTitle}
                                            onChange={(event) =>
                                              setInlineTitle(event.target.value)
                                            }
                                            onKeyDown={(event) => {
                                              if (event.key === "Enter") {
                                                event.preventDefault();
                                                void handleInlineCommit();
                                              }
                                              if (event.key === "Escape") {
                                                event.preventDefault();
                                                handleInlineCancel();
                                              }
                                            }}
                                            placeholder="New subtask title"
                                            autoFocus
                                          />
                                        ) : (
                                          <button
                                            type="button"
                                            className="add-row-button"
                                            onClick={() =>
                                              startInlineAdd(
                                                `subtask:${item.id}`,
                                                item.id
                                              )
                                            }
                                          >
                                            Add subtask…
                                          </button>
                                        )}
                                      </td>
                                    </tr>
                                  </>
                                )}
                              </Fragment>
                            );
                          })}
                      <tr className="add-row">
                        <td colSpan={columns.length}>
                          <div
                            onDragOver={handleDragOverAppend(
                              groupKey,
                              milestone.id,
                              getLastVisibleId(milestoneTasks)
                            )}
                            onDrop={handleDropAppend(
                              groupKey,
                              milestone.id,
                              getLastVisibleId(milestoneTasks)
                            )}
                          >
                          {inlineAdd?.groupKey === groupKey ? (
                            <input
                              className="add-row-input"
                              value={inlineTitle}
                              onChange={(event) => setInlineTitle(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void handleInlineCommit();
                                }
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  handleInlineCancel();
                                }
                              }}
                              placeholder="New task title"
                              autoFocus
                            />
                          ) : (
                            <button
                              type="button"
                              className="add-row-button"
                              onClick={() => startInlineAdd(groupKey, milestone.id)}
                            >
                              Add task…
                            </button>
                          )}
                          </div>
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ListView;
