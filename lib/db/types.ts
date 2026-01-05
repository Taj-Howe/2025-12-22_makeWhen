export type DB = {
  items: {
    id: string;
    type: "project" | "milestone" | "task";
    title: string;
    parent_id: string | null;
    status: string;
    priority: number | null;
    due_at: number | null;
    estimate_mode: string | null;
    estimate_minutes: number | null;
    notes: string | null;
    completed_at: string | null;
    archived_at: string | null;
  };
};
