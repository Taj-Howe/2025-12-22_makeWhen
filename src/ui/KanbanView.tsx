import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { mutate, query } from "../data/api";
import type { Scope } from "../domain/scope";
import { AppButton, AppCheckbox, AppSelect, AppSwitch } from "./controls";

type CardItem = {
  id: string;
  title: string;
  status: string;
  priority: number;
  due_at: number | null;
  planned_start_at?: number | null;
  planned_end_at?: number | null;
  assignee_id?: string | null;
  assignee_name?: string | null;
  project_id?: string | null;
  project_title?: string | null;
  parent_id?: string | null;
  health?: string;
};

type KanbanLane = {
  lane_id: string;
  lane_title: string;
  columns: Record<string, CardItem[]>;
};

type KanbanViewProps = {
  scope: Scope;
  refreshToken: number;
  onRefresh: () => void;
  onOpenItem: (itemId: string) => void;
};

const STATUSES = [
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "done",
];

const formatDate = (value: number | null) => {
  if (!value) {
    return "";
  }
  return new Date(value).toLocaleDateString();
};

const KanbanView: FC<KanbanViewProps> = ({
  scope,
  refreshToken,
  onRefresh,
  onOpenItem,
}) => {
  const [lanes, setLanes] = useState<KanbanLane[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swimlaneMode, setSwimlaneMode] = useState<
    "none" | "assignee" | "project" | "health"
  >("none");
  const [showDone, setShowDone] = useState(false);
  const [showCanceled, setShowCanceled] = useState(false);

  const statusColumns = useMemo(() => {
    if (showCanceled) {
      return [...STATUSES, "canceled"];
    }
    return STATUSES;
  }, [showCanceled]);

  const loadBoard = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
      }
      setError(null);
    try {
      const data = await query<{ lanes: KanbanLane[] }>("kanban_view", {
        scope,
        includeCompleted: showDone,
        showCanceled,
        swimlaneMode,
      });
      setLanes(data.lanes);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  },
  [scope, showCanceled, showDone, swimlaneMode]
  );

  useEffect(() => {
    void loadBoard();
  }, [loadBoard, refreshToken]);

  const cardById = useMemo(() => {
    const map = new Map<string, CardItem>();
    for (const lane of lanes) {
      for (const column of Object.values(lane.columns)) {
        for (const card of column) {
          map.set(card.id, card);
        }
      }
    }
    return map;
  }, [lanes]);

  const cardLaneMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of lanes) {
      for (const column of Object.values(lane.columns)) {
        for (const card of column) {
          map.set(card.id, lane.lane_id);
        }
      }
    }
    return map;
  }, [lanes]);

  const moveCardStatus = useCallback(
    (itemId: string, laneId: string, nextStatus: string) => {
      const card = cardById.get(itemId);
      if (!card) {
        return;
      }
      setLanes((prev) =>
        prev.map((lane) => {
          const nextColumns: Record<string, CardItem[]> = {};
          for (const [key, list] of Object.entries(lane.columns)) {
            nextColumns[key] = list.filter((entry) => entry.id !== itemId);
          }
          if (lane.lane_id === laneId) {
            const nextList = nextColumns[nextStatus] ?? [];
            nextColumns[nextStatus] = [...nextList, { ...card, status: nextStatus }];
          }
          return { ...lane, columns: nextColumns };
        })
      );
    },
    [cardById]
  );

  const handleDrop = async (
    event: React.DragEvent,
    laneId: string,
    status: string
  ) => {
    event.preventDefault();
    const itemId = event.dataTransfer.getData("text/plain");
    if (!itemId) {
      return;
    }
    const card = cardById.get(itemId);
    if (!card || card.status === status) {
      return;
    }
    const currentLaneId = cardLaneMap.get(itemId);
    if (currentLaneId && currentLaneId !== laneId) {
      return;
    }
    moveCardStatus(itemId, laneId, status);
    try {
      await mutate("set_status", { id: itemId, status });
      void loadBoard(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleToggleDone = async (itemId: string, checked: boolean) => {
    const laneId = cardLaneMap.get(itemId);
    if (!laneId) {
      return;
    }
    const nextStatus = checked ? "done" : "ready";
    moveCardStatus(itemId, laneId, nextStatus);
    try {
      await mutate("set_status", { id: itemId, status: nextStatus });
      void loadBoard(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleCreate = async (lane: KanbanLane, status: string) => {
    setError(null);
    try {
      const createArgs: Record<string, unknown> = {
        type: "task",
        title: "New task",
        status,
        estimate_minutes: 0,
        estimate_mode: "manual",
        due_at: null,
        priority: 0,
      };

      if (swimlaneMode === "project" && lane.lane_id !== "no_project") {
        createArgs.parent_id = lane.lane_id;
      } else if (scope.kind === "project" && scope.projectId) {
        createArgs.parent_id = scope.projectId;
      }

      const created = (await mutate("create_item", createArgs)) as {
        id?: string;
      };
      const itemId = created?.id;
      if (!itemId) {
        throw new Error("Create failed");
      }

      if (scope.kind === "user") {
        await mutate("item.set_assignee", {
          item_id: itemId,
          user_id: scope.userId,
        });
      } else if (swimlaneMode === "assignee" && lane.lane_id !== "unassigned") {
        await mutate("item.set_assignee", {
          item_id: itemId,
          user_id: lane.lane_id,
        });
      }

      onOpenItem(itemId);
      void loadBoard(true);
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  return (
    <div className="kanban-root">
      <div className="kanban-toolbar">
        <div className="kanban-toolbar-left">
          <label>
            Swimlanes
            <AppSelect
              value={swimlaneMode}
              onChange={(value) =>
                setSwimlaneMode(
                  value as "none" | "assignee" | "project" | "health"
                )
              }
              options={[
                { value: "none", label: "None" },
                { value: "assignee", label: "By Assignee" },
                { value: "project", label: "By Project" },
                { value: "health", label: "By Health" },
              ]}
            />
          </label>
          <label className="kanban-toggle">
            <AppSwitch
              checked={showDone}
              onCheckedChange={(checked) => setShowDone(checked === true)}
            />
            Show Done
          </label>
          <label className="kanban-toggle">
            <AppSwitch
              checked={showCanceled}
              onCheckedChange={(checked) => setShowCanceled(checked === true)}
            />
            Show Canceled
          </label>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {loading ? <div className="loading">Loading…</div> : null}

      <div className="kanban-board">
        {lanes.map((lane) => (
          <section key={lane.lane_id} className="kanban-lane">
            <div className="kanban-lane-title">{lane.lane_title}</div>
            <div className="kanban-columns">
              {statusColumns.map((status) => (
                <div
                  key={status}
                  className="kanban-column"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => void handleDrop(event, lane.lane_id, status)}
                >
                  <div className="kanban-column-header">
                    <span>{status.replace("_", " ")}</span>
                    <AppButton
                      type="button"
                      size="1"
                      variant="ghost"
                      className="kanban-add"
                      onClick={() => void handleCreate(lane, status)}
                    >
                      + Task
                    </AppButton>
                  </div>
                  <div className="kanban-column-body">
                    {(lane.columns[status] ?? []).length === 0 ? (
                      <div className="kanban-empty">No items</div>
                    ) : (
                      (lane.columns[status] ?? []).map((card) => (
                        <div
                          key={card.id}
                          className="kanban-card"
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/plain", card.id);
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        onClick={() => onOpenItem(card.id)}
                      >
                        <div className="kanban-card-header">
                          <AppCheckbox
                            className="task-checkbox task-checkbox--compact"
                            checked={card.status === "done"}
                            onCheckedChange={(checked) =>
                              void handleToggleDone(card.id, checked === true)
                            }
                            onClick={(event) => event.stopPropagation()}
                          />
                          <div className="kanban-card-title">{card.title}</div>
                        </div>
                        <div className="kanban-card-meta">
                          {card.priority ? (
                            <span className="kanban-chip">
                              P{card.priority}
                            </span>
                          ) : null}
                          {card.due_at ? (
                            <span className="kanban-chip">
                              {formatDate(card.due_at)}
                            </span>
                          ) : null}
                          {card.assignee_name ? (
                            <span className="kanban-chip">
                              {card.assignee_name}
                            </span>
                          ) : null}
                          {card.health ? (
                            <span className="kanban-chip">{card.health}</span>
                          ) : null}
                        </div>
                      </div>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};

export default KanbanView;
