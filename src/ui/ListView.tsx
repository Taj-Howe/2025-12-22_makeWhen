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
import { query, mutate } from "../rpc/clientSingleton";
import type { QueryFilters, Scope } from "../rpc/types";

const formatDate = (value: number) => new Date(value).toLocaleString();

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
  due_at: number;
  scheduled_for: number | null;
  scheduled_duration_minutes: number | null;
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
  scope: Scope;
  filters: QueryFilters;
  sortMode: "sequence_rank" | "manual" | "due_at" | "priority";
  refreshToken: number;
  onRefresh: () => void;
};

const ListView: FC<ListViewProps> = ({
  scope,
  filters,
  sortMode,
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
            : "—",
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
        render: (item: ListItem) =>
          item.due_at ? formatDate(item.due_at) : "—",
      },
      {
        key: "scheduled_for",
        label: "Scheduled For",
        minWidth: 170,
        render: (item: ListItem) =>
          item.scheduled_for ? formatDate(item.scheduled_for) : "—",
      },
      {
        key: "scheduled_duration_minutes",
        label: "Sched Duration (min)",
        minWidth: 180,
        render: (item: ListItem) =>
          Number.isFinite(item.scheduled_duration_minutes)
            ? item.scheduled_duration_minutes
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
            ? item.depends_on.join(", ")
            : "—",
      },
      {
        key: "tags",
        label: "Tags",
        minWidth: 160,
        render: (item: ListItem) =>
          item.tags.length > 0
            ? item.tags.map((tag) => tag.name).join(", ")
            : "—",
      },
      {
        key: "notes",
        label: "Notes",
        minWidth: 200,
        render: (item: ListItem) => truncate(item.notes, 60),
      },
      {
        key: "health",
        label: "Health",
        minWidth: 130,
        render: (item: ListItem) => item.health ?? "unknown",
      },
      {
        key: "health_mode",
        label: "Health Mode",
        minWidth: 130,
        render: (item: ListItem) => item.health_mode ?? "auto",
      },
    ],
    []
  );

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    const orderBy = sortMode === "manual" ? "sort_order" : sortMode;
    const orderDir = sortMode === "priority" ? "desc" : "asc";
    const data = await query<{ items: ListItem[] }>("listItems", {
      scope,
      filters,
      includeDone: true,
      includeCanceled: true,
      orderBy,
      orderDir,
    });
    setItems(data.items);
    setLoading(false);
  }, [filters, scope, sortMode]);

  useEffect(() => {
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
  }, [loadItems, refreshToken]);

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
          (item) => item.type === "milestone" && item.parent_id === scope.id
        )
        .sort((a, b) => a.sort_order - b.sort_order),
    [items, scope.id]
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
      if (task.parent_id && task.parent_id !== scope.id) {
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
  }, [parentTypeMap, scope.id, tasks]);

  const ungroupedTasks = useMemo(() => {
    return tasks
      .filter((task) => task.parent_id === null || task.parent_id === scope.id)
      .sort((a, b) => a.sort_order - b.sort_order);
  }, [scope.id, tasks]);

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
      const siblings = items.filter(
        (item) =>
          item.type === "task" &&
          item.id !== itemId &&
          item.parent_id === targetParentId
      );
      const maxSortOrder = siblings.reduce(
        (max, item) => Math.max(max, item.sort_order),
        0
      );
      await mutate("update_item_fields", {
        id: itemId,
        fields: { parent_id: targetParentId, sort_order: maxSortOrder + 1 },
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
    handleDragOverGroup(milestoneId, `move-target:${milestoneId}`)(event);
  };

  const handleMilestoneDrop = (milestoneId: string) => (event: DragEvent) => {
    if (!dragging) {
      return;
    }
    if (dragging.groupKey === "milestones") {
      handleDropBefore(milestoneId, "milestones")(event);
      return;
    }
    handleDropOnGroup(milestoneId)(event);
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

  const canReorder = sortMode === "manual";

  const renderDragHandle = (itemId: string, groupKey: string) =>
    canReorder ? (
      <span
        className="drag-handle"
        draggable
        onDragStart={handleDragStart(itemId, groupKey)}
        onDragEnd={handleDragEnd}
        title="Drag to reorder"
      >
        ⋮⋮
      </span>
    ) : null;

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

  const renderMoveButtons = (itemId: string, index: number, total: number) =>
    canReorder ? (
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
    ) : null;

  return (
    <div className="list-view">
      {loading ? <div className="list-empty">Loading…</div> : null}
      {error ? <div className="error">{error}</div> : null}
      <div className="list-scroll">
        <table className="list-table">
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
                      <tr
                        className={
                          dragOver &&
                          ((dragOver.groupKey === "milestones" &&
                            dragOver.itemId === milestone.id) ||
                            dragOver.groupKey === `move-target:${milestone.id}`)
                            ? "group-row drag-over"
                            : "group-row"
                        }
                        onDragOver={handleMilestoneDragOver(milestone.id)}
                        onDrop={handleMilestoneDrop(milestone.id)}
                      >
                        {columns.map((column) => (
                          <td key={`${milestone.id}-${column.key}`}>
                            {column.key === "title"
                              ? column.render(
                                  milestone,
                                  milestone.depth * 16,
                                  milestoneDragHandle,
                                  milestoneActions
                                )
                              : column.render(milestone, 0, null)}
                          </td>
                        ))}
                      </tr>
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
                                      {column.key === "title"
                                        ? column.render(
                                            item,
                                            item.depth * 16,
                                            renderDragHandle(item.id, groupKey),
                                            actions
                                          )
                                        : column.render(item, 0, null)}
                                    </td>
                                  ))}
                                </tr>
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
                                    <tr
                                      key={child.id}
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
                                      onDrop={handleDropBefore(child.id, childGroupKey)}
                                    >
                                      {columns.map((column) => (
                                        <td key={`${child.id}-${column.key}`}>
                                          {column.key === "title"
                                            ? column.render(
                                                child,
                                                child.depth * 16,
                                                renderDragHandle(
                                                  child.id,
                                                  childGroupKey
                                                ),
                                                childActions
                                              )
                                            : column.render(child, 0, null)}
                                        </td>
                                      ))}
                                    </tr>
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
                    null,
                    "move-target:ungrouped"
                  )}
                  onDrop={handleDropOnGroup(null)}
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
                                {column.key === "title"
                                  ? column.render(
                                      item,
                                      item.depth * 16,
                                      renderDragHandle(item.id, groupKey),
                                      actions
                                    )
                                  : column.render(item, 0, null)}
                              </td>
                            ))}
                          </tr>
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
                              <tr
                                key={child.id}
                                className={
                                  dragOver?.itemId === child.id &&
                                  dragOver.groupKey === childGroupKey
                                    ? "drag-over"
                                    : undefined
                                }
                                onDragOver={handleDragOverRow(child.id, childGroupKey)}
                                onDrop={handleDropBefore(child.id, childGroupKey)}
                              >
                                {columns.map((column) => (
                                  <td key={`${child.id}-${column.key}`}>
                                    {column.key === "title"
                                      ? column.render(
                                          child,
                                          child.depth * 16,
                                          renderDragHandle(
                                            child.id,
                                            childGroupKey
                                          ),
                                          childActions
                                        )
                                      : column.render(child, 0, null)}
                                  </td>
                                ))}
                              </tr>
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
