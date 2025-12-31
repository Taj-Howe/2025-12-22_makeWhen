import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import type { Scope } from "../domain/scope";
import { query } from "../rpc/clientSingleton";
import { formatDate } from "../domain/formatters";
import { getTodayRange, getWeekRange } from "./dateWindow";

type DashboardViewProps = {
  scope: Scope;
  refreshToken: number;
  onOpenItem: (itemId: string) => void;
};

type ExecutionWindowResult = {
  scheduled: Array<{
    block_id: string;
    item_id: string;
    title: string;
    start_at: number;
    duration_minutes: number;
    due_at?: number | null;
    status: string;
    project_title?: string | null;
  }>;
  unscheduled_ready: Array<{
    item_id: string;
    title: string;
    due_at?: number | null;
    status: string;
    priority: number;
    sequence_rank?: number;
    slack_minutes?: number | null;
    project_title?: string | null;
  }>;
};

type BlockedViewResult = {
  blocked_by_dependencies: Array<{
    item_id: string;
    title: string;
    blocked_reason: string;
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
  onOpenItem,
}) => {
  const [windowMode, setWindowMode] = useState<"today" | "week">("today");
  const [execution, setExecution] = useState<ExecutionWindowResult>({
    scheduled: [],
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
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [scope, windowRange]);

  useEffect(() => {
    void loadWidgets();
  }, [loadWidgets, refreshToken]);

  return (
    <div className="dashboard-view">
      <div className="dashboard-toolbar">
        <div className="dashboard-title">Dashboard</div>
        <div className="dashboard-toggle">
          <button
            type="button"
            className={
              windowMode === "today" ? "button button-active" : "button"
            }
            onClick={() => setWindowMode("today")}
          >
            Today
          </button>
          <button
            type="button"
            className={windowMode === "week" ? "button button-active" : "button"}
            onClick={() => setWindowMode("week")}
          >
            This Week
          </button>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {loading ? <div className="list-empty">Loading…</div> : null}
      <div className="dashboard-grid">
        <section className="dashboard-card">
          <h3>Execution</h3>
          <div className="dashboard-section">
            <div className="dashboard-section-title">Scheduled</div>
            {execution.scheduled.length === 0 ? (
              <div className="dashboard-empty">No scheduled blocks.</div>
            ) : (
              execution.scheduled.map((block) => (
                <button
                  key={block.block_id}
                  type="button"
                  className="dashboard-row"
                  onClick={() => onOpenItem(block.item_id)}
                >
                  <span className="dashboard-time">
                    {TIME_LABEL.format(new Date(block.start_at))}
                  </span>
                  <span className="dashboard-title-text">{block.title}</span>
                  <span className="dashboard-meta">
                    {block.project_title ?? "—"}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="dashboard-section">
            <div className="dashboard-section-title">Unscheduled (Ready)</div>
            {execution.unscheduled_ready.length === 0 ? (
              <div className="dashboard-empty">Nothing ready without blocks.</div>
            ) : (
              execution.unscheduled_ready.map((item) => (
                <button
                  key={item.item_id}
                  type="button"
                  className="dashboard-row"
                  onClick={() => onOpenItem(item.item_id)}
                >
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {item.project_title ?? "—"}
                  </span>
                  <span className="dashboard-meta">
                    {item.due_at ? formatDate(item.due_at) : "No due"}
                  </span>
                </button>
              ))
            )}
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
                <button
                  key={item.item_id}
                  type="button"
                  className="dashboard-row"
                  onClick={() => onOpenItem(item.item_id)}
                >
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {item.project_title ?? "—"}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="dashboard-section">
            <div className="dashboard-section-title">Blockers</div>
            {blocked.blocked_by_blockers.length === 0 ? (
              <div className="dashboard-empty">No active blockers.</div>
            ) : (
              blocked.blocked_by_blockers.map((item) => (
                <button
                  key={item.item_id}
                  type="button"
                  className="dashboard-row"
                  onClick={() => onOpenItem(item.item_id)}
                >
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {item.blocker_count} blocker
                    {item.blocker_count === 1 ? "" : "s"}
                  </span>
                </button>
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
                <button
                  key={item.item_id}
                  type="button"
                  className="dashboard-row dashboard-row-warning"
                  onClick={() => onOpenItem(item.item_id)}
                >
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {item.project_title ?? "—"}
                  </span>
                </button>
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
                <button
                  key={item.item_id}
                  type="button"
                  className="dashboard-row"
                  onClick={() => onOpenItem(item.item_id)}
                >
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {formatDays(item.days_until_due)}
                  </span>
                  <span className="dashboard-meta">
                    {formatDate(item.due_at)}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="dashboard-section">
            <div className="dashboard-section-title">Overdue</div>
            {dueOverdue.overdue.length === 0 ? (
              <div className="dashboard-empty">No overdue items.</div>
            ) : (
              dueOverdue.overdue.map((item) => (
                <button
                  key={item.item_id}
                  type="button"
                  className="dashboard-row dashboard-row-warning"
                  onClick={() => onOpenItem(item.item_id)}
                >
                  <span className="dashboard-title-text">{item.title}</span>
                  <span className="dashboard-meta">
                    {formatDays(item.days_overdue)}
                  </span>
                  <span className="dashboard-meta">
                    {formatDate(item.due_at)}
                  </span>
                </button>
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
