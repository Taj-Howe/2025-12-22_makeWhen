import { SegmentedControl } from "@radix-ui/themes";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FC,
  type KeyboardEvent,
} from "react";
import type { Scope } from "../domain/scope";
import { query } from "../rpc/clientSingleton";
import { formatDate } from "../domain/formatters";
import { getTodayRange, getWeekRange } from "./dateWindow";
import ContributionsHeatmap from "./ContributionsHeatmap";
import { setStatus } from "./itemActions";
import { AppCheckbox } from "./controls";

type DashboardViewProps = {
  scope: Scope;
  refreshToken: number;
  onSelectItem: (itemId: string, projectId: string | null) => void;
};

type ExecutionWindowResult = {
  scheduled: Array<{
    block_id: string;
    item_id: string;
    title: string;
    start_at: number;
    duration_minutes: number;
    end_at?: number;
    due_at?: number | null;
    status: string;
    priority?: number;
    slack_minutes?: number | null;
    project_id?: string | null;
    project_title?: string | null;
    assignee_name?: string | null;
  }>;
  actionable_now: Array<{
    item_id: string;
    title: string;
    due_at?: number | null;
    status: string;
    priority: number;
    slack_minutes?: number | null;
    planned_start_at?: number | null;
    planned_end_at?: number | null;
    project_id?: string | null;
    project_title?: string | null;
    assignee_name?: string | null;
  }>;
  unscheduled_ready: Array<{
    item_id: string;
    title: string;
    due_at?: number | null;
    status: string;
    priority: number;
    sequence_rank?: number;
    slack_minutes?: number | null;
    planned_start_at?: number | null;
    planned_end_at?: number | null;
    project_id?: string | null;
    project_title?: string | null;
    assignee_name?: string | null;
  }>;
  meta?: {
    scheduled_total: number;
    actionable_total: number;
    unscheduled_total: number;
    truncated: {
      scheduled: boolean;
      actionable_now: boolean;
      unscheduled_ready: boolean;
    };
  };
};

type BlockedViewResult = {
  blocked_by_dependencies: Array<{
    item_id: string;
    title: string;
    blocked_reason: string;
    status: string;
    due_at?: number | null;
    planned_start_at?: number | null;
    planned_end_at?: number | null;
    slack_minutes?: number | null;
    project_title?: string | null;
    assignee_name?: string | null;
  }>;
  blocked_by_blockers: Array<{
    item_id: string;
    title: string;
    blocker_count: number;
    status: string;
    due_at?: number | null;
    planned_start_at?: number | null;
    planned_end_at?: number | null;
    slack_minutes?: number | null;
    project_title?: string | null;
    assignee_name?: string | null;
  }>;
  scheduled_but_blocked: Array<{
    item_id: string;
    title: string;
    status: string;
    block_id?: string | null;
    start_at?: number | null;
    duration_minutes?: number | null;
    blocked_reason: string;
    due_at?: number | null;
    project_title?: string | null;
  }>;
};

type DueOverdueResult = {
  due_soon: Array<{
    item_id: string;
    title: string;
    status: string;
    due_at: number;
    days_until_due: number;
    planned_end_at?: number | null;
    slack_minutes?: number | null;
    project_title?: string | null;
    assignee_name?: string | null;
  }>;
  overdue: Array<{
    item_id: string;
    title: string;
    status: string;
    due_at: number;
    days_overdue: number;
    planned_end_at?: number | null;
    slack_minutes?: number | null;
    project_title?: string | null;
    assignee_name?: string | null;
  }>;
  projects: Array<{
    project_id: string;
    title: string;
    due_at?: number | null;
    days_until_due_or_overdue?: number | null;
  }>;
};

const TIME_LABEL = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const formatDays = (value: number) =>
  `${value < 0 ? "-" : ""}${Math.abs(value)}d`;

const DashboardView: FC<DashboardViewProps> = ({
  scope,
  refreshToken,
  onSelectItem,
}) => {
  const [windowMode, setWindowMode] = useState<"today" | "week">("today");
  const [execution, setExecution] = useState<ExecutionWindowResult>({
    scheduled: [],
    actionable_now: [],
    unscheduled_ready: [],
  });
  const [blocked, setBlocked] = useState<BlockedViewResult>({
    blocked_by_dependencies: [],
    blocked_by_blockers: [],
    scheduled_but_blocked: [],
  });
  const [dueOverdue, setDueOverdue] = useState<DueOverdueResult>({
    due_soon: [],
    overdue: [],
    projects: [],
  });
  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const windowRange = useMemo(() => {
    const now = new Date();
    return windowMode === "today" ? getTodayRange(now) : getWeekRange(now);
  }, [windowMode]);

  const loadWidgets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [executionData, blockedData, dueData] = await Promise.all([
        query<ExecutionWindowResult>("execution_window", {
          scope,
          time_min: windowRange.start.getTime(),
          time_max: windowRange.end.getTime(),
        }),
        query<BlockedViewResult>("blocked_view", {
          scope,
          time_min: windowRange.start.getTime(),
          time_max: windowRange.end.getTime(),
        }),
        query<DueOverdueResult>("due_overdue", {
          scope,
          now_at: Date.now(),
          due_soon_days: 7,
        }),
      ]);
      setExecution(executionData);
      setBlocked(blockedData);
      setDueOverdue(dueData);
      setHasLoadedOnce(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [scope, windowRange]);

  const handleToggleDone = useCallback(
    async (itemId: string, checked: boolean) => {
      setError(null);
      try {
        await setStatus(itemId, checked ? "done" : "ready");
        await loadWidgets();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [loadWidgets]
  );

  useEffect(() => {
    void loadWidgets();
  }, [loadWidgets, refreshToken]);

  const handleRowKeyDown = (action: () => void) => (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };

  return (
    <div className="dashboard-view">
      <ContributionsHeatmap scope={scope} refreshToken={refreshToken} />
      <div className="dashboard-toolbar">
        <div className="dashboard-title">Dashboard</div>
        <SegmentedControl.Root
          value={windowMode}
          onValueChange={(value) => setWindowMode(value as "today" | "week")}
        >
          <SegmentedControl.Item value="today">Today</SegmentedControl.Item>
          <SegmentedControl.Item value="week">This Week</SegmentedControl.Item>
        </SegmentedControl.Root>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {loading && !hasLoadedOnce ? <div className="list-empty">Loading…</div> : null}
      <div className="dashboard-grid">
        <section className="dashboard-card">
          <h3>Execution</h3>
          <div className="dashboard-section">
            <div className="dashboard-section-title">Now / Next</div>
            {execution.scheduled.length === 0 ? (
              <div className="dashboard-empty">No scheduled blocks.</div>
            ) : (
              execution.scheduled.map((block) => (
                <div
                  key={block.block_id}
                  className="dashboard-row"
                  onClick={() =>
                    onSelectItem(block.item_id, block.project_id ?? null)
                  }
                  onKeyDown={handleRowKeyDown(() =>
                    onSelectItem(block.item_id, block.project_id ?? null)
                  )}
                  role="button"
                  tabIndex={0}
                >
                  <span className="dashboard-leading">
                    <AppCheckbox
                      className="task-checkbox task-checkbox--compact"
                      checked={block.status === "done"}
                      onCheckedChange={(checked) =>
                        void handleToggleDone(block.item_id, checked === true)
                      }
                      onClick={(event) => event.stopPropagation()}
                    />
                    <span className="dashboard-time">
                      {TIME_LABEL.format(new Date(block.start_at))}
                    </span>
                  </span>
                  <span className="dashboard-title-text">{block.title}</span>
                  <span className="dashboard-meta">
                    {block.project_title ?? "—"}
                  </span>
                </div>
              ))
            )}
            {execution.meta?.truncated.scheduled ? (
              <div className="dashboard-meta">
                Showing {execution.scheduled.length} of{" "}
                {execution.meta.scheduled_total}
              </div>
            ) : null}
          </div>
          <div className="dashboard-section">
            <div className="dashboard-section-title">Available now</div>
            {execution.actionable_now.length === 0 ? (
              <div className="dashboard-empty">No actionable items.</div>
            ) : (
              execution.actionable_now.map((item) => (
                <div
                  key={item.item_id}
                  className="dashboard-row"
                  onClick={() =>
                    onSelectItem(item.item_id, item.project_id ?? null)
                  }
                  onKeyDown={handleRowKeyDown(() =>
                    onSelectItem(item.item_id, item.project_id ?? null)
                  )}
                  role="button"
                  tabIndex={0}
                >
                  <span className="dashboard-leading">
                    <AppCheckbox
                      className="task-checkbox task-checkbox--compact"
                      checked={item.status === "done"}
                      onCheckedChange={(checked) =>
                        void handleToggleDone(item.item_id, checked === true)
                      }
                      onClick={(event) => event.stopPropagation()}
                    />
                  </span>
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {item.project_title ?? "—"}
                  </span>
                  <span className="dashboard-meta">
                    {item.due_at ? formatDate(item.due_at) : "No due"}
                  </span>
                </div>
              ))
            )}
            {execution.meta?.truncated.actionable_now ? (
              <div className="dashboard-meta">
                Showing {execution.actionable_now.length} of{" "}
                {execution.meta.actionable_total}
              </div>
            ) : null}
          </div>
          <div className="dashboard-section">
            <div className="dashboard-section-title">Back pocket</div>
            {execution.unscheduled_ready.length === 0 ? (
              <div className="dashboard-empty">Nothing ready without blocks.</div>
            ) : (
              execution.unscheduled_ready.map((item) => (
                <div
                  key={item.item_id}
                  className="dashboard-row"
                  onClick={() =>
                    onSelectItem(item.item_id, item.project_id ?? null)
                  }
                  onKeyDown={handleRowKeyDown(() =>
                    onSelectItem(item.item_id, item.project_id ?? null)
                  )}
                  role="button"
                  tabIndex={0}
                >
                  <span className="dashboard-leading">
                    <AppCheckbox
                      className="task-checkbox task-checkbox--compact"
                      checked={item.status === "done"}
                      onCheckedChange={(checked) =>
                        void handleToggleDone(item.item_id, checked === true)
                      }
                      onClick={(event) => event.stopPropagation()}
                    />
                  </span>
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {item.project_title ?? "—"}
                  </span>
                  <span className="dashboard-meta">
                    {item.due_at ? formatDate(item.due_at) : "No due"}
                  </span>
                </div>
              ))
            )}
            {execution.meta?.truncated.unscheduled_ready ? (
              <div className="dashboard-meta">
                Showing {execution.unscheduled_ready.length} of{" "}
                {execution.meta.unscheduled_total}
              </div>
            ) : null}
          </div>
        </section>

        <section className="dashboard-card">
          <h3>Blocked</h3>
          <div className="dashboard-section">
            <div className="dashboard-section-title">Dependencies</div>
            {blocked.blocked_by_dependencies.length === 0 ? (
              <div className="dashboard-empty">No dependency blocks.</div>
            ) : (
              blocked.blocked_by_dependencies.map((item) => (
                <div
                  key={item.item_id}
                  className="dashboard-row"
                  onClick={() => onSelectItem(item.item_id, null)}
                  onKeyDown={handleRowKeyDown(() =>
                    onSelectItem(item.item_id, null)
                  )}
                  role="button"
                  tabIndex={0}
                >
                  <span className="dashboard-leading">
                    <AppCheckbox
                      className="task-checkbox task-checkbox--compact"
                      checked={item.status === "done"}
                      onCheckedChange={(checked) =>
                        void handleToggleDone(item.item_id, checked === true)
                      }
                      onClick={(event) => event.stopPropagation()}
                    />
                  </span>
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {item.project_title ?? "—"}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="dashboard-section">
            <div className="dashboard-section-title">Blockers</div>
            {blocked.blocked_by_blockers.length === 0 ? (
              <div className="dashboard-empty">No active blockers.</div>
            ) : (
              blocked.blocked_by_blockers.map((item) => (
                <div
                  key={item.item_id}
                  className="dashboard-row"
                  onClick={() => onSelectItem(item.item_id, null)}
                  onKeyDown={handleRowKeyDown(() =>
                    onSelectItem(item.item_id, null)
                  )}
                  role="button"
                  tabIndex={0}
                >
                  <span className="dashboard-leading">
                    <AppCheckbox
                      className="task-checkbox task-checkbox--compact"
                      checked={item.status === "done"}
                      onCheckedChange={(checked) =>
                        void handleToggleDone(item.item_id, checked === true)
                      }
                      onClick={(event) => event.stopPropagation()}
                    />
                  </span>
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {item.blocker_count} blocker
                    {item.blocker_count === 1 ? "" : "s"}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="dashboard-section">
            <div className="dashboard-section-title">
              Scheduled but blocked
            </div>
            {blocked.scheduled_but_blocked.length === 0 ? (
              <div className="dashboard-empty">No scheduled blocks blocked.</div>
            ) : (
              blocked.scheduled_but_blocked.map((item) => (
                <div
                  key={item.item_id}
                  className="dashboard-row dashboard-row-warning"
                  onClick={() => onSelectItem(item.item_id, null)}
                  onKeyDown={handleRowKeyDown(() =>
                    onSelectItem(item.item_id, null)
                  )}
                  role="button"
                  tabIndex={0}
                >
                  <span className="dashboard-leading">
                    <AppCheckbox
                      className="task-checkbox task-checkbox--compact"
                      checked={item.status === "done"}
                      onCheckedChange={(checked) =>
                        void handleToggleDone(item.item_id, checked === true)
                      }
                      onClick={(event) => event.stopPropagation()}
                    />
                  </span>
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {item.project_title ?? "—"}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="dashboard-card">
          <h3>Due / Overdue</h3>
          <div className="dashboard-section">
            <div className="dashboard-section-title">Due soon</div>
            {dueOverdue.due_soon.length === 0 ? (
              <div className="dashboard-empty">No upcoming deadlines.</div>
            ) : (
              dueOverdue.due_soon.map((item) => (
                <div
                  key={item.item_id}
                  className="dashboard-row"
                  onClick={() => onSelectItem(item.item_id, null)}
                  onKeyDown={handleRowKeyDown(() =>
                    onSelectItem(item.item_id, null)
                  )}
                  role="button"
                  tabIndex={0}
                >
                  <span className="dashboard-leading">
                    <AppCheckbox
                      className="task-checkbox task-checkbox--compact"
                      checked={item.status === "done"}
                      onCheckedChange={(checked) =>
                        void handleToggleDone(item.item_id, checked === true)
                      }
                      onClick={(event) => event.stopPropagation()}
                    />
                  </span>
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {formatDays(item.days_until_due)}
                  </span>
                  <span className="dashboard-meta">
                    {formatDate(item.due_at)}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="dashboard-section">
            <div className="dashboard-section-title">Overdue</div>
            {dueOverdue.overdue.length === 0 ? (
              <div className="dashboard-empty">No overdue items.</div>
            ) : (
              dueOverdue.overdue.map((item) => (
                <div
                  key={item.item_id}
                  className="dashboard-row dashboard-row-warning"
                  onClick={() => onSelectItem(item.item_id, null)}
                  onKeyDown={handleRowKeyDown(() =>
                    onSelectItem(item.item_id, null)
                  )}
                  role="button"
                  tabIndex={0}
                >
                  <span className="dashboard-leading">
                    <AppCheckbox
                      className="task-checkbox task-checkbox--compact"
                      checked={item.status === "done"}
                      onCheckedChange={(checked) =>
                        void handleToggleDone(item.item_id, checked === true)
                      }
                      onClick={(event) => event.stopPropagation()}
                    />
                  </span>
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {formatDays(item.days_overdue)}
                  </span>
                  <span className="dashboard-meta">
                    {formatDate(item.due_at)}
                  </span>
                </div>
              ))
            )}
          </div>
          {dueOverdue.projects.length > 0 ? (
            <div className="dashboard-section">
              <div className="dashboard-section-title">Project deadlines</div>
              {dueOverdue.projects.map((project) => (
                <div key={project.project_id} className="dashboard-row">
                  <span className="dashboard-title-text">{project.title}</span>
                  <span className="dashboard-meta">
                    {project.days_until_due_or_overdue !== null &&
                    project.days_until_due_or_overdue !== undefined
                      ? formatDays(project.days_until_due_or_overdue)
                      : "—"}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};

export default DashboardView;
