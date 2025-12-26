import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type FC,
  type ReactNode,
} from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { query, mutate } from "../rpc/clientSingleton";
import { UNGROUPED_PROJECT_ID } from "./constants";

const formatDate = (value: number | null) =>
  value ? new Date(value).toLocaleString() : "—";

const shortId = (value: string | null) => {
  if (!value) {
    return "—";
  }
  return value.slice(0, 8);
};

const truncate = (value: string | null, max = 40) => {
  if (!value) {
    return "—";
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
};

type ListItem = {
  id: string;
  type: "project" | "milestone" | "task";
  title: string;
  parent_id: string | null;
  depth: number;
  project_id: string;
  sort_order: number;
  due_at: number | null;
  estimate_mode?: string;
  status: string;
  priority: number;
  estimate_minutes: number;
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
  tags: { id: string; name: string }[];
  health: string;
  health_mode?: string;
};

type Column = {
  key: string;
  label: string;
  minWidth: number;
  render: (
    item: ListItem,
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
  const [items, setItems] = useState<ListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{
    itemId: string;
    groupKey: string;
  } | null>(null);
  const [dragOver, setDragOver] = useState<{
    itemId: string;
    groupKey: string;
    position: "before" | "end" | "into";
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
  const [milestoneDrop, setMilestoneDrop] = useState<{
    milestoneId: string;
    position: "top" | "bottom";
  } | null>(null);

  const columns = useMemo<Column[]>(
    () => [
      {
        key: "id",
        label: "ID",
        minWidth: 120,
        render: (item: ListItem) => (
          <span className="cell-id">
            {shortId(item.id)}
            <button
              type="button"
              className="button button-ghost"
              onClick={() => navigator.clipboard?.writeText(item.id)}
              title="Copy ID"
            >
              Copy
            </button>
          </span>
        ),
      },
      {
        key: "type",
        label: "Type",
        minWidth: 110,
        render: (item: ListItem) => item.type ?? "—",
      },
      {
        key: "title",
        label: "Title",
        minWidth: 220,
        render: (
          item: ListItem,
          indent: number,
          dragHandle: ReactNode,
          actions?: ReactNode
        ) => (
          <div className="cell-title" style={{ paddingLeft: `${indent}px` }}>
            <span className="cell-title-text">
              {dragHandle}
              {item.title || "—"}
            </span>
            {actions}
          </div>
        ),
      },
      {
        key: "parent_id",
        label: "Parent ID",
        minWidth: 120,
        render: (item: ListItem) => shortId(item.parent_id),
      },
      {
        key: "assignees",
        label: "Assignees",
        minWidth: 160,
        render: (item: ListItem) =>
          item.assignees.length > 0
            ? item.assignees.map((assignee) => assignee.id).join(", ")
            : "unassigned",
      },
      {
        key: "status",
        label: "Status",
        minWidth: 120,
        render: (item: ListItem) => (
          <span className="status-badge">{item.status || "—"}</span>
        ),
      },
      {
        key: "priority",
        label: "Priority",
        minWidth: 90,
        render: (item: ListItem) =>
          Number.isFinite(item.priority) ? item.priority : 0,
      },
      {
        key: "due_at",
        label: "Due At",
        minWidth: 160,
        render: (item: ListItem) => formatDate(item.due_at),
      },
      {
        key: "scheduled_for",
        label: "Scheduled For",
        minWidth: 170,
        render: (item: ListItem) =>
          item.schedule?.schedule_start_at
            ? formatDate(item.schedule.schedule_start_at)
            : "—",
      },
      {
        key: "estimate_mode",
        label: "Estimate Mode",
        minWidth: 140,
        render: (item: ListItem) =>
          item.estimate_mode ??
          (item.type === "task" ? "manual" : "rollup"),
      },
      {
        key: "estimate_minutes",
        label: "Estimate (min)",
        minWidth: 140,
        render: (item: ListItem) =>
          Number.isFinite(item.estimate_minutes) ? item.estimate_minutes : 0,
      },
      {
        key: "depends_on",
        label: "Depends On",
        minWidth: 160,
        render: (item: ListItem) =>
          item.depends_on.length > 0
            ? item.depends_on.map((id) => shortId(id)).join(", ")
            : "[]",
      },
      {
        key: "blockers",
        label: "Blockers",
        minWidth: 120,
        render: (item: ListItem) => {
          // TODO: listItems does not include blocker objects yet; show active count.
          const count = item.blocked?.active_blocker_count ?? 0;
          return count > 0 ? String(count) : "0";
        },
      },
      {
        key: "tags",
        label: "Tags",
        minWidth: 160,
        render: (item: ListItem) =>
          item.tags.length > 0
            ? item.tags.map((tag) => tag.name).join(", ")
            : "[]",
      },
      {
        key: "notes",
        label: "Notes",
        minWidth: 200,
        render: (item: ListItem) => truncate(item.notes, 60),
      },
      {
        key: "health",
        label: "Health (mode)",
        minWidth: 160,
        render: (item: ListItem) =>
          `${item.health ?? "unknown"} (${item.health_mode ?? "auto"})`,
      },
    ],
    []
  );

  const loadItems = useCallback(async () => {
    if (!selectedProjectId) {
      setItems([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const data = await query<{ items: ListItem[] }>("listItems", {
      projectId: selectedProjectId,
      includeDone: true,
      includeCanceled: true,
      orderBy: "due_at",
      orderDir: "asc",
    });
    setItems(data.items);
    setLoading(false);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setItems([]);
      setError(null);
      return;
    }
    let isMounted = true;
    setLoading(true);
    setError(null);
    loadItems()
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

  const parentTypeMap = useMemo(() => {
    const map = new Map<string, ListItem["type"]>();
    for (const item of items) {
      map.set(item.id, item.type);
    }
    return map;
  }, [items]);

  const itemById = useMemo(() => {
    const map = new Map<string, ListItem>();
    for (const item of items) {
      map.set(item.id, item);
    }
    return map;
  }, [items]);

  const tasks = useMemo(
    () => items.filter((item) => item.type === "task"),
    [items]
  );

  const milestones = useMemo(
    () =>
      items
        .filter(
          (item) =>
            item.type === "milestone" && item.parent_id === selectedProjectId
        )
        .sort((a, b) => a.sort_order - b.sort_order),
    [items, selectedProjectId]
  );

  const taskChildren = useMemo(() => {
    const map = new Map<string, ListItem[]>();
    for (const task of tasks) {
      if (!task.parent_id) {
        continue;
      }
      const list = map.get(task.parent_id) ?? [];
      list.push(task);
      map.set(task.parent_id, list);
    }
    for (const [key, list] of map.entries()) {
      map.set(key, list.sort((a, b) => a.sort_order - b.sort_order));
    }
    return map;
  }, [tasks]);

  const tasksUnderMilestone = useMemo(() => {
    const map = new Map<string, ListItem[]>();
    for (const task of tasks) {
      if (task.parent_id && task.parent_id !== selectedProjectId) {
        const parentType = parentTypeMap.get(task.parent_id);
        if (parentType === "milestone") {
          const list = map.get(task.parent_id) ?? [];
          list.push(task);
          map.set(task.parent_id, list);
        }
      }
    }
    for (const [key, list] of map.entries()) {
      map.set(key, list.sort((a, b) => a.sort_order - b.sort_order));
    }
    return map;
  }, [parentTypeMap, selectedProjectId, tasks]);

  const ungroupedTasks = useMemo(() => {
    if (selectedProjectId === UNGROUPED_PROJECT_ID) {
      return tasks
        .filter((task) => task.parent_id === null)
        .sort((a, b) => a.sort_order - b.sort_order);
    }
    return tasks
      .filter((task) => task.parent_id === selectedProjectId)
      .sort((a, b) => a.sort_order - b.sort_order);
  }, [selectedProjectId, tasks]);

  const ungroupedParentId =
    selectedProjectId === UNGROUPED_PROJECT_ID ? null : selectedProjectId;

  const [collapsedMilestones, setCollapsedMilestones] = useState<Set<string>>(
    () => new Set()
  );
  const [collapsedUngrouped, setCollapsedUngrouped] = useState(false);

  useEffect(() => {
    setCollapsedMilestones((prev) => {
      const milestoneIds = new Set(milestones.map((milestone) => milestone.id));
      return new Set(Array.from(prev).filter((id) => milestoneIds.has(id)));
    });
  }, [milestones]);

  const handleDelete = async (item: ListItem) => {
    if (!confirm(`Delete ${item.title}? This removes all descendants.`)) {
      return;
    }
    setError(null);
    try {
      await mutate("delete_item", { item_id: item.id });
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
      await mutate("update_item_fields", {
        id: item.id,
        fields: { title: nextTitle.trim() },
      });
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleAddTaskUnder = async (parentId: string) => {
    setError(null);
    try {
      await mutate("create_item", {
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
      await mutate("create_item", {
        type: "task",
        title: `${item.title} (copy)`,
        parent_id: item.parent_id,
        due_at: item.due_at ?? null,
        estimate_mode: item.estimate_mode ?? "manual",
        estimate_minutes: item.estimate_minutes ?? 0,
        status: item.status,
        priority: item.priority ?? 0,
        notes: item.notes ?? null,
      });
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
      await mutate("create_item", {
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

  const toDateTimeLocal = (value: number | null) => {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(value - offset).toISOString().slice(0, 16);
  };

  const startEdit = (itemId: string, field: string, value: string) => {
    setEditing({ itemId, field });
    setEditValue(value);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditValue("");
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
    setError(null);
    try {
      switch (editing.field) {
        case "title":
          if (value) {
            await mutate("update_item_fields", {
              id: item.id,
              fields: { title: value },
            });
          }
          break;
        case "status":
          await mutate("set_status", { id: item.id, status: value });
          break;
        case "priority": {
          const priority = Number(value);
          if (Number.isFinite(priority)) {
            await mutate("update_item_fields", {
              id: item.id,
              fields: { priority },
            });
          }
          break;
        }
        case "due_at": {
          if (!value) {
            await mutate("update_item_fields", {
              id: item.id,
              fields: { due_at: null },
            });
            break;
          }
          const dueAt = new Date(value).getTime();
          if (Number.isFinite(dueAt)) {
            await mutate("update_item_fields", {
              id: item.id,
              fields: { due_at: dueAt },
            });
          }
          break;
        }
        case "scheduled_for": {
          if (!value) {
            break;
          }
          const startAt = new Date(value).getTime();
          if (Number.isFinite(startAt)) {
            await mutate("create_block", {
              item_id: item.id,
              start_at: startAt,
              duration_minutes: 60,
              source: "manual",
            });
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
          await mutate("set_item_tags", { item_id: item.id, tags });
          break;
        }
        case "depends_on": {
          const desired = new Set(
            value
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean)
          );
          const existing = new Set(item.depends_on ?? []);
          for (const depId of desired) {
            if (!existing.has(depId)) {
              await mutate("add_dependency", {
                item_id: item.id,
                depends_on_id: depId,
              });
            }
          }
          for (const depId of existing) {
            if (!desired.has(depId)) {
              await mutate("remove_dependency", {
                item_id: item.id,
                depends_on_id: depId,
              });
            }
          }
          break;
        }
        case "notes":
          await mutate("update_item_fields", {
            id: item.id,
            fields: { notes: value ? value : null },
          });
          break;
        case "health":
          await mutate("update_item_fields", {
            id: item.id,
            fields: { health: value, health_mode: "manual" },
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
    item: ListItem,
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

  const renderCell = (
    item: ListItem,
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
    if (column.key === "scheduled_for") {
      return renderEditableCell(
        item,
        "scheduled_for",
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
        toDateTimeLocal(item.schedule?.schedule_start_at ?? null)
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
    if (column.key === "depends_on") {
      return renderEditableCell(
        item,
        "depends_on",
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
        (item.depends_on ?? []).join(", ")
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

  const canMoveTaskToParent = useCallback(
    (itemId: string, targetParentId: string | null) => {
      const item = itemById.get(itemId);
      if (!item || item.type !== "task") {
        return false;
      }
      const parentType = item.parent_id
        ? parentTypeMap.get(item.parent_id)
        : null;
      if (parentType === "task") {
        return false;
      }
      if (item.parent_id === targetParentId) {
        return false;
      }
      return true;
    },
    [itemById, parentTypeMap]
  );

  const handleMoveToParent = async (
    itemId: string,
    targetParentId: string | null
  ) => {
    setError(null);
    try {
      await mutate("update_item_fields", {
        id: itemId,
        fields: { parent_id: targetParentId },
      });
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
    const siblings = tasksUnderMilestone.get(targetParentId) ?? [];
    const sortOrders = siblings.map((task) => task.sort_order);
    const minSort = sortOrders.length > 0 ? Math.min(...sortOrders) : 0;
    const maxSort = sortOrders.length > 0 ? Math.max(...sortOrders) : 0;
    const nextSort =
      position === "top" ? minSort - 1 : maxSort + 1;

    setError(null);
    try {
      await mutate("update_item_fields", {
        id: itemId,
        fields: { parent_id: targetParentId, sort_order: nextSort },
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

  const handleDragOverRow = (itemId: string, groupKey: string) => (
    event: DragEvent
  ) => {
    if (!dragging || dragging.groupKey !== groupKey) {
      return;
    }
    event.preventDefault();
    setDragOver({ itemId, groupKey, position: "before" });
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
    if (!dragging || dragging.groupKey !== groupKey) {
      return;
    }
    event.preventDefault();
    const parentId = itemById.get(itemId)?.parent_id ?? null;
    if (dragging.itemId === itemId) {
      return;
    }
    void handleMove(dragging.itemId, parentId, itemId, undefined);
    setDragOver(null);
  };

  const handleDropEnd = (groupKey: string, lastId: string) => (
    event: DragEvent
  ) => {
    if (!dragging || dragging.groupKey !== groupKey) {
      return;
    }
    event.preventDefault();
    const parentId = itemById.get(lastId)?.parent_id ?? null;
    void handleMove(dragging.itemId, parentId, undefined, lastId);
    setDragOver(null);
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

  const handleReorder = async (itemId: string, direction: "up" | "down") => {
    setError(null);
    try {
      await mutate("reorder_item", { item_id: itemId, direction });
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const renderMoveButtons = (
    itemId: string,
    index: number,
    total: number
  ) => (
    <div className="row-actions">
      <button
        type="button"
        className="button button-ghost"
        onClick={() => handleReorder(itemId, "up")}
        disabled={index === 0}
      >
        ↑
      </button>
      <button
        type="button"
        className="button button-ghost"
        onClick={() => handleReorder(itemId, "down")}
        disabled={index === total - 1}
      >
        ↓
      </button>
    </div>
  );

  if (!selectedProjectId) {
    return (
      <div className="list-view list-view-container">Select a project</div>
    );
  }

  return (
    <div className="list-view list-view-container">
      {loading ? <div className="list-empty">Loading…</div> : null}
      {error ? <div className="error">{error}</div> : null}
      <div className="list-scroll">
        <table className="list-table list-table-wide">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} style={{ minWidth: column.minWidth }}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!loading && milestones.length === 0 && ungroupedTasks.length === 0 ? (
              <tr>
                  <td colSpan={columns.length} className="list-empty">
                    No items yet
                  </td>
                </tr>
              ) : (
                <>
                {milestones.map((milestone, milestoneIndex) => {
                  const isCollapsed = collapsedMilestones.has(milestone.id);
                  const milestoneTasks = tasksUnderMilestone.get(milestone.id) ?? [];
                  const groupKey = `milestone:${milestone.id}`;
                  const milestoneActions = (
                    <span className="cell-actions">
                      {renderMoveButtons(
                        milestone.id,
                        milestoneIndex,
                        milestones.length
                      )}
                      <button
                        type="button"
                        className="button button-ghost"
                        onClick={() => handleDelete(milestone)}
                      >
                        Delete
                      </button>
                    </span>
                  );
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
                        : milestoneTasks.map((item, itemIndex) => {
                            const children = taskChildren.get(item.id) ?? [];
                            const actions = (
                              <span className="cell-actions">
                                {renderMoveButtons(
                                  item.id,
                                  itemIndex,
                                  milestoneTasks.length
                                )}
                                <button
                                  type="button"
                                  className="button button-ghost"
                                  onClick={() => handleDelete(item)}
                                >
                                  Delete
                                </button>
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
                                          ? "drag-over"
                                          : undefined
                                      }
                                      onDragOver={handleDragOverRow(item.id, groupKey)}
                                      onDrop={handleDropBefore(item.id, groupKey)}
                                    >
                                      {columns.map((column) => (
                                        <td key={`${item.id}-${column.key}`}>
                                          {renderCell(
                                            item,
                                            column,
                                            item.depth * 16,
                                            renderDragHandle(item.id, groupKey),
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
                                {children.map((child, childIndex) => {
                                  const childGroupKey = `task:${item.id}`;
                                  const childActions = (
                                    <span className="cell-actions">
                                      {renderMoveButtons(
                                        child.id,
                                        childIndex,
                                        children.length
                                      )}
                                      <button
                                        type="button"
                                        className="button button-ghost"
                                        onClick={() => handleDelete(child)}
                                      >
                                        Delete
                                      </button>
                                    </span>
                                  );
                                  return (
                                    <ContextMenu.Root key={child.id}>
                                      <ContextMenu.Trigger asChild>
                                        <tr
                                          className={
                                            dragOver?.itemId === child.id &&
                                            dragOver.groupKey === childGroupKey
                                              ? "drag-over"
                                              : undefined
                                          }
                                          onDragOver={handleDragOverRow(
                                            child.id,
                                            childGroupKey
                                          )}
                                          onDrop={handleDropBefore(
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
                                {children.length > 0 ? (
                                  <tr className="drop-row">
                                    <td colSpan={columns.length}>
                                      <div
                                        className={
                                          dragOver?.position === "end" &&
                                          dragOver.groupKey === `task:${item.id}`
                                            ? "drop-target is-active"
                                            : "drop-target"
                                        }
                                        onDragOver={(event) => {
                                          if (
                                            dragging &&
                                            dragging.groupKey === `task:${item.id}`
                                          ) {
                                            event.preventDefault();
                                            setDragOver({
                                              itemId: item.id,
                                              groupKey: `task:${item.id}`,
                                              position: "end",
                                            });
                                          }
                                        }}
                                        onDrop={handleDropEnd(
                                          `task:${item.id}`,
                                          children[children.length - 1].id
                                        )}
                                      >
                                        Drop to end
                                      </div>
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
                            );
                          })}
                      {milestoneTasks.length > 0 ? (
                        <tr className="drop-row">
                          <td colSpan={columns.length}>
                            <div
                              className={
                                dragOver?.position === "end" &&
                                dragOver.groupKey === groupKey
                                  ? "drop-target is-active"
                                  : "drop-target"
                              }
                              onDragOver={(event) => {
                                if (dragging && dragging.groupKey === groupKey) {
                                  event.preventDefault();
                                  setDragOver({
                                    itemId: milestone.id,
                                    groupKey,
                                    position: "end",
                                  });
                                }
                              }}
                              onDrop={handleDropEnd(
                                groupKey,
                                milestoneTasks[milestoneTasks.length - 1].id
                              )}
                            >
                              Drop to end
                            </div>
                          </td>
                        </tr>
                      ) : null}
                      <tr className="add-row">
                        <td colSpan={columns.length}>
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
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
                {milestones.length > 0 ? (
                  <tr className="drop-row">
                    <td colSpan={columns.length}>
                      <div
                        className={
                          dragOver?.position === "end" &&
                          dragOver.groupKey === "milestones"
                            ? "drop-target is-active"
                            : "drop-target"
                        }
                        onDragOver={(event) => {
                          if (dragging && dragging.groupKey === "milestones") {
                            event.preventDefault();
                            setDragOver({
                              itemId: "milestones",
                              groupKey: "milestones",
                              position: "end",
                            });
                          }
                        }}
                        onDrop={handleDropEnd(
                          "milestones",
                          milestones[milestones.length - 1].id
                        )}
                      >
                        Drop to end
                      </div>
                    </td>
                  </tr>
                ) : null}
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
                  : ungroupedTasks.map((item, itemIndex) => {
                      const children = taskChildren.get(item.id) ?? [];
                      const groupKey = "ungrouped";
                      const actions = (
                        <span className="cell-actions">
                          {renderMoveButtons(
                            item.id,
                            itemIndex,
                            ungroupedTasks.length
                          )}
                          <button
                            type="button"
                            className="button button-ghost"
                            onClick={() => handleDelete(item)}
                          >
                            Delete
                          </button>
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
                                      ? "drag-over"
                                      : undefined
                                  }
                                  onDragOver={handleDragOverRow(item.id, groupKey)}
                                  onDrop={handleDropBefore(item.id, groupKey)}
                                >
                                    {columns.map((column) => (
                                      <td key={`${item.id}-${column.key}`}>
                                        {renderCell(
                                          item,
                                          column,
                                          item.depth * 16,
                                          renderDragHandle(item.id, groupKey),
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
                          {children.map((child, childIndex) => {
                            const childGroupKey = `task:${item.id}`;
                            const childActions = (
                              <span className="cell-actions">
                                {renderMoveButtons(
                                  child.id,
                                  childIndex,
                                  children.length
                                )}
                                <button
                                  type="button"
                                  className="button button-ghost"
                                  onClick={() => handleDelete(child)}
                                >
                                  Delete
                                </button>
                              </span>
                            );
                            return (
                              <ContextMenu.Root key={child.id}>
                                <ContextMenu.Trigger asChild>
                                  <tr
                                    className={
                                      dragOver?.itemId === child.id &&
                                      dragOver.groupKey === childGroupKey
                                        ? "drag-over"
                                        : undefined
                                    }
                                    onDragOver={handleDragOverRow(
                                      child.id,
                                      childGroupKey
                                    )}
                                    onDrop={handleDropBefore(
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
                                      onSelect={() => handleDuplicateTask(child)}
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
                          {children.length > 0 ? (
                            <tr className="drop-row">
                              <td colSpan={columns.length}>
                                <div
                                  className={
                                    dragOver?.position === "end" &&
                                    dragOver.groupKey === `task:${item.id}`
                                      ? "drop-target is-active"
                                      : "drop-target"
                                  }
                                  onDragOver={(event) => {
                                    if (
                                      dragging &&
                                      dragging.groupKey === `task:${item.id}`
                                    ) {
                                      event.preventDefault();
                                      setDragOver({
                                        itemId: item.id,
                                        groupKey: `task:${item.id}`,
                                        position: "end",
                                      });
                                    }
                                  }}
                                  onDrop={handleDropEnd(
                                    `task:${item.id}`,
                                    children[children.length - 1].id
                                  )}
                                >
                                  Drop to end
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                <tr className="add-row">
                  <td colSpan={columns.length}>
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
                  </td>
                </tr>
                {collapsedUngrouped || ungroupedTasks.length === 0 ? null : (
                  <tr className="drop-row">
                    <td colSpan={columns.length}>
                      <div
                        className={
                          dragOver?.position === "end" &&
                          dragOver.groupKey === "ungrouped"
                            ? "drop-target is-active"
                            : "drop-target"
                        }
                        onDragOver={(event) => {
                          if (dragging && dragging.groupKey === "ungrouped") {
                            event.preventDefault();
                            setDragOver({
                              itemId: "ungrouped",
                              groupKey: "ungrouped",
                              position: "end",
                            });
                          }
                        }}
                        onDrop={handleDropEnd(
                          "ungrouped",
                          ungroupedTasks[ungroupedTasks.length - 1].id
                        )}
                      >
                        Drop to end
                      </div>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ListView;
