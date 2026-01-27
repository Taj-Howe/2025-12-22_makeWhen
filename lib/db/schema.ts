export type UserRole = "owner" | "editor" | "viewer";
export type ItemType = "milestone" | "task" | "subtask";

export interface UsersTable {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  created_at: string;
}

export interface ProjectsTable {
  id: string;
  title: string;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectMembersTable {
  project_id: string;
  user_id: string;
  role: UserRole;
}

export interface ItemsTable {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: ItemType;
  title: string;
  status: string;
  priority: number;
  due_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
  assignee_user_id: string | null;
  estimate_mode: string;
  estimate_minutes: number;
  sequence_rank: number;
  health: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledBlocksTable {
  id: string;
  item_id: string;
  start_at: string;
  duration_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface DependenciesTable {
  id: string;
  item_id: string;
  depends_on_id: string;
  type: string;
  lag_minutes: number;
  created_at: string;
}

export interface BlockersTable {
  id: string;
  item_id: string;
  kind: string;
  reason: string | null;
  created_at: string;
  cleared_at: string | null;
}

export interface TimeEntriesTable {
  id: string;
  item_id: string;
  start_at: string;
  end_at: string | null;
  duration_minutes: number | null;
  created_at: string;
}

export interface OpLogTable {
  id: string;
  user_id: string;
  project_id: string | null;
  op_name: string;
  op_json: unknown;
  created_at: string;
}

export interface Database {
  users: UsersTable;
  projects: ProjectsTable;
  project_members: ProjectMembersTable;
  items: ItemsTable;
  scheduled_blocks: ScheduledBlocksTable;
  dependencies: DependenciesTable;
  blockers: BlockersTable;
  time_entries: TimeEntriesTable;
  op_log: OpLogTable;
}
