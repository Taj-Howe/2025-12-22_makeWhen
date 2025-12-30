export type ListItem = {
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
  rollup_estimate_minutes?: number;
  rollup_actual_minutes?: number;
  rollup_remaining_minutes?: number;
  rollup_start_at?: number | null;
  rollup_end_at?: number | null;
  rollup_blocked_count?: number;
  rollup_overdue_count?: number;
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

export type DependencyType = "FS" | "SS" | "FF" | "SF";

export type ScheduledBlockLite = {
  block_id: string;
  item_id: string;
  start_at: number;
  duration_minutes: number;
  end_at_derived: number;
  kind?: string;
};

export type DependencyEdgeLite = {
  edge_id: string;
  type: DependencyType;
  lag_minutes: number;
  successor_id?: string;
  predecessor_id?: string;
};

export type DependencyProjectionLite = {
  item_id: string;
  title: string;
  type: DependencyType;
  lag_minutes: number;
  status: "satisfied" | "violated" | "unknown";
};

export type ItemGanttModel = {
  id: string;
  title: string;
  item_type: "project" | "milestone" | "task";
  parent_id: string | null;
  status: string;
  completed_on: number | null;
  due_at: number | null;
  rollup_estimate_minutes?: number;
  rollup_actual_minutes?: number;
  rollup_remaining_minutes?: number;
  rollup_start_at?: number | null;
  rollup_end_at?: number | null;
  rollup_blocked_count?: number;
  rollup_overdue_count?: number;
  estimate_mode?: string;
  estimate_minutes: number;
  actual_minutes: number | null;
  scheduled_blocks: ScheduledBlockLite[];
  dependencies_out: DependencyEdgeLite[];
  dependencies_in: DependencyEdgeLite[];
  blocked_by: DependencyProjectionLite[];
  blocking: DependencyProjectionLite[];
  slack_minutes: number | null;
};
