import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

export type Database = {
  users: {
    id: string;
    email: string | null;
    name: string | null;
    avatar_url: string | null;
    created_at: string;
  };
  auth_identities: {
    id: string;
    user_id: string;
    provider: string;
    provider_subject: string;
    created_at: string;
  };
  projects: {
    id: string;
    owner_user_id: string;
    title: string;
    created_at: string;
    updated_at: string;
  };
  project_members: {
    project_id: string;
    user_id: string;
    role: "owner" | "editor" | "viewer";
    created_at: string;
  };
  collaborator_contacts: {
    owner_user_id: string;
    collaborator_user_id: string;
    status: "active" | "hidden";
    last_interaction_at: string | null;
  };
  project_invite_links: {
    id: string;
    project_id: string;
    created_by_user_id: string;
    role: "viewer" | "editor";
    token: string;
    revoked_at: string | null;
    created_at: string;
  };
  items: {
    id: string;
    project_id: string;
    parent_id: string | null;
    type: "milestone" | "task" | "subtask";
    title: string;
    status: string;
    priority: number;
    due_at: string | null;
    completed_at: string | null;
    archived_at: string | null;
    assignee_user_id: string | null;
    estimate_mode: "manual" | "rollup";
    estimate_minutes: number;
    notes: string | null;
    health: string | null;
    sequence_rank: number;
    created_at: string;
    updated_at: string;
  };
  scheduled_blocks: {
    id: string;
    item_id: string;
    start_at: string;
    duration_minutes: number;
    created_at: string;
    updated_at: string;
  };
  dependencies: {
    id: string;
    item_id: string;
    depends_on_id: string;
    type: "FS" | "SS" | "FF" | "SF";
    lag_minutes: number;
    created_at: string;
  };
  blockers: {
    id: string;
    item_id: string;
    kind: string;
    text: string;
    created_at: string;
    resolved_at: string | null;
  };
  time_entries: {
    id: string;
    item_id: string;
    user_id: string;
    start_at: string;
    end_at: string | null;
    duration_minutes: number | null;
    created_at: string;
  };
  op_log: {
    id: string;
    actor_user_id: string | null;
    scope_type: "project" | "user";
    scope_id: string;
    op: unknown;
    created_at: string;
  };
};

let db: Kysely<Database> | null = null;

export const getDb = () => {
  if (db) {
    return db;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: databaseUrl }),
    }),
  });
  return db;
};
