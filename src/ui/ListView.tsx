import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type FC,
} from "react";
import { query, mutate } from "../rpc/clientSingleton";

const formatDate = (value: number) => new Date(value).toLocaleString();

const formatDuration = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (hours > 0 && remaining > 0) {
    return `${hours}h ${remaining}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${remaining}m`;
};

const formatBlocked = (blocked: ListItem["blocked"]) => {
  if (!blocked.is_blocked) {
    return "No";
  }
  const reasons = [];
  if (blocked.blocked_by_deps) {
    reasons.push("deps");
  }
  if (blocked.blocked_by_blockers) {
    reasons.push("blockers");
  }
  return `Yes (${reasons.join(" + ")})`;
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
  status: string;
  priority: number;
  estimate_minutes: number;
  notes: string | null;
  blocked: {
    is_blocked: boolean;
    blocked_by_deps: boolean;
    blocked_by_blockers: boolean;
  };
  assignees: { id: string; name: string | null }[];
  tags: { id: string; name: string }[];
  health: string;
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
    position: "before" | "end";
  } | null>(null);

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

  const ungroupedTasks = useMemo(
    () =>
      tasks
        .filter((task) => task.parent_id === selectedProjectId)
        .sort((a, b) => a.sort_order - b.sort_order),
    [selectedProjectId, tasks]
  );

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
    return <div className="list-view">Select a project</div>;
  }

  return (
    <div className="list-view">
      {loading ? <div className="list-empty">Loading…</div> : null}
      {error ? <div className="error">{error}</div> : null}
      <div className="list-scroll">
        <table className="list-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Status</th>
              <th>Due</th>
              <th>Priority</th>
              <th>Estimate</th>
              <th>Blocked</th>
              <th>Assignees</th>
              <th>Tags</th>
              <th>Health</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {!loading && milestones.length === 0 && ungroupedTasks.length === 0 ? (
              <tr>
                <td colSpan={12} className="list-empty">
                  No items yet
                </td>
              </tr>
            ) : (
              <>
                {milestones.map((milestone, milestoneIndex) => {
                  const isCollapsed = collapsedMilestones.has(milestone.id);
                  const milestoneTasks = tasksUnderMilestone.get(milestone.id) ?? [];
                  const groupKey = `milestone:${milestone.id}`;
                  return (
                    <Fragment key={milestone.id}>
                      <tr
                        className={
                          dragOver?.itemId === milestone.id &&
                          dragOver.groupKey === "milestones"
                            ? "group-row drag-over"
                            : "group-row"
                        }
                        onDragOver={handleDragOverRow(milestone.id, "milestones")}
                        onDrop={handleDropBefore(milestone.id, "milestones")}
                      >
                        <td colSpan={12}>
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
                            {isCollapsed ? "▶" : "▼"} {milestone.title}
                          </button>
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
                        </td>
                      </tr>
                      {isCollapsed
                        ? null
                        : milestoneTasks.map((item, itemIndex) => {
                            const parentType = item.parent_id
                              ? parentTypeMap.get(item.parent_id)
                              : null;
                            const typeLabel =
                              parentType === "task" ? "Subtask" : "Task";
                            const assignees = item.assignees.length
                              ? item.assignees
                                  .map((assignee) => assignee.id)
                                  .join(", ")
                              : "—";
                            const tags = item.tags.length
                              ? item.tags.map((tag) => tag.name).join(", ")
                              : "—";
                            const children = taskChildren.get(item.id) ?? [];
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
                                  <td>
                                    <span
                                      style={{ paddingLeft: `${item.depth * 16}px` }}
                                    >
                                      {renderDragHandle(item.id, groupKey)}
                                      {item.title}
                                    </span>
                                  </td>
                                  <td>{typeLabel}</td>
                                  <td>{item.status}</td>
                                  <td>{formatDate(item.due_at)}</td>
                                  <td>{item.priority}</td>
                                  <td>{formatDuration(item.estimate_minutes)}</td>
                                  <td>{formatBlocked(item.blocked)}</td>
                                  <td>{assignees}</td>
                                  <td>{tags}</td>
                                  <td>{item.health}</td>
                                  <td>{truncate(item.notes)}</td>
                                  <td>
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
                                  </td>
                                </tr>
                                {children.map((child, childIndex) => {
                                  const childGroupKey = `task:${item.id}`;
                                  const childAssignees = child.assignees.length
                                    ? child.assignees
                                        .map((assignee) => assignee.id)
                                        .join(", ")
                                    : "—";
                                  const childTags = child.tags.length
                                    ? child.tags.map((tag) => tag.name).join(", ")
                                    : "—";
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
                                      <td>
                                        <span
                                          style={{
                                            paddingLeft: `${child.depth * 16}px`,
                                          }}
                                        >
                                          {renderDragHandle(child.id, childGroupKey)}
                                          {child.title}
                                        </span>
                                      </td>
                                      <td>Subtask</td>
                                      <td>{child.status}</td>
                                      <td>{formatDate(child.due_at)}</td>
                                      <td>{child.priority}</td>
                                      <td>{formatDuration(child.estimate_minutes)}</td>
                                      <td>{formatBlocked(child.blocked)}</td>
                                      <td>{childAssignees}</td>
                                      <td>{childTags}</td>
                                      <td>{child.health}</td>
                                      <td>{truncate(child.notes)}</td>
                                      <td>
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
                                      </td>
                                    </tr>
                                  );
                                })}
                                {children.length > 0 ? (
                                  <tr className="drop-row">
                                    <td colSpan={12}>
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
                          <td colSpan={12}>
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
                    <td colSpan={12}>
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
                <tr className="group-row">
                  <td colSpan={12}>
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
                      const parentType = item.parent_id
                        ? parentTypeMap.get(item.parent_id)
                        : null;
                      const typeLabel =
                        parentType === "task" ? "Subtask" : "Task";
                      const assignees = item.assignees.length
                        ? item.assignees.map((assignee) => assignee.id).join(", ")
                        : "—";
                      const tags = item.tags.length
                        ? item.tags.map((tag) => tag.name).join(", ")
                        : "—";
                      const children = taskChildren.get(item.id) ?? [];
                      const groupKey = "ungrouped";
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
                            <td>
                              <span style={{ paddingLeft: `${item.depth * 16}px` }}>
                                {renderDragHandle(item.id, groupKey)}
                                {item.title}
                              </span>
                            </td>
                            <td>{typeLabel}</td>
                            <td>{item.status}</td>
                            <td>{formatDate(item.due_at)}</td>
                            <td>{item.priority}</td>
                            <td>{formatDuration(item.estimate_minutes)}</td>
                            <td>{formatBlocked(item.blocked)}</td>
                            <td>{assignees}</td>
                            <td>{tags}</td>
                            <td>{item.health}</td>
                            <td>{truncate(item.notes)}</td>
                            <td>
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
                            </td>
                          </tr>
                          {children.map((child, childIndex) => {
                            const childGroupKey = `task:${item.id}`;
                            const childAssignees = child.assignees.length
                              ? child.assignees
                                  .map((assignee) => assignee.id)
                                  .join(", ")
                              : "—";
                            const childTags = child.tags.length
                              ? child.tags.map((tag) => tag.name).join(", ")
                              : "—";
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
                                <td>
                                  <span
                                    style={{ paddingLeft: `${child.depth * 16}px` }}
                                  >
                                    {renderDragHandle(child.id, childGroupKey)}
                                    {child.title}
                                  </span>
                                </td>
                                <td>Subtask</td>
                                <td>{child.status}</td>
                                <td>{formatDate(child.due_at)}</td>
                                <td>{child.priority}</td>
                                <td>{formatDuration(child.estimate_minutes)}</td>
                                <td>{formatBlocked(child.blocked)}</td>
                                <td>{childAssignees}</td>
                                <td>{childTags}</td>
                                <td>{child.health}</td>
                                <td>{truncate(child.notes)}</td>
                                <td>
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
                                </td>
                              </tr>
                            );
                          })}
                          {children.length > 0 ? (
                            <tr className="drop-row">
                              <td colSpan={12}>
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
                    })
                }
                {collapsedUngrouped || ungroupedTasks.length === 0 ? null : (
                  <tr className="drop-row">
                    <td colSpan={12}>
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
