export type GanttItem = {
  id: string;
  item_type: "project" | "milestone" | "task";
  title: string;
  parent_id: string | null;
  status: string;
  due_at: number | null;
  planned_start_at: number | null;
  planned_end_at: number | null;
  rollup_start_at: number | null;
  rollup_end_at: number | null;
  assignee_id?: string | null;
  assignee_name?: string | null;
};

export type GanttBlock = {
  block_id: string;
  item_id: string;
  start_at: number;
  duration_minutes: number;
};

export type GanttEdge = {
  edge_id: string;
  predecessor_id: string;
  successor_id: string;
  type: "FS" | "SS" | "FF" | "SF";
  lag_minutes: number;
};

export type GanttRangeResult = {
  items: GanttItem[];
  blocks: GanttBlock[];
  edges: GanttEdge[];
};
