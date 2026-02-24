export type RpcRequest = {
  id: string;
  kind: "request";
  method: string;
  params?: unknown;
};

export type RpcResponse = {
  id: string;
  kind: "response";
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type RpcErrorCode =
  | "NOT_SIGNED_IN"
  | "NOT_TEAM_MEMBER"
  | "INSUFFICIENT_ROLE"
  | "CROSS_TEAM_ACCESS";

export type RpcErrorPayload = {
  code: RpcErrorCode | string;
  message: string;
};

export type TeamRole = "owner" | "editor" | "viewer";

export type AuthSession = {
  session_id: string;
  user_id: string;
  team_id: string;
};

export type AuthSessionCurrentResult = {
  session: AuthSession | null;
  user:
    | {
        user_id: string;
        display_name: string;
        avatar_url: string | null;
      }
    | null;
  team:
    | {
        team_id: string;
        name: string;
      }
    | null;
  role: TeamRole | null;
};

export type AuthSessionOptionsResult = {
  users: Array<{
    user_id: string;
    display_name: string;
    avatar_url: string | null;
  }>;
  teams: Array<{
    team_id: string;
    name: string;
  }>;
  memberships: Array<{
    user_id: string;
    team_id: string;
    role: TeamRole;
  }>;
};

export type AuthSessionSetArgs = {
  user_id: string;
  team_id: string;
};

export type AuthSessionBootstrapArgs = {
  user_id: string;
  display_name: string;
  avatar_url?: string | null;
  team_id: string;
  team_name?: string;
  role?: TeamRole;
  memberships?: Array<{
    team_id: string;
    team_name?: string;
    role?: TeamRole;
  }>;
};

export type AuthLogoutResult = {
  logged_out: boolean;
  session_id: string | null;
};

export type OpOutboxStatus = "queued" | "sending" | "acked" | "failed";

export type OpEnvelope<TPayload = unknown> = {
  op_id: string;
  team_id: string;
  actor_user_id: string;
  created_at: number;
  op_name: string;
  payload: TPayload;
};

export type SyncOutboxStatusResult = {
  queued_count: number;
  failed_count: number;
  last_error?: string | null;
};

export type SyncStatusResult = SyncOutboxStatusResult & {
  team_id: string;
  last_applied_seq: number;
  sync_mode?: "mock" | "remote";
  sync_remote_base_url?: string | null;
};

export type SyncRunOnceArgs = {
  client_id?: string;
};

export type SyncRunOnceResult = {
  team_id: string;
  client_id: string;
  pushed_count: number;
  acked_count: number;
  rejected_count: number;
  pulled_count: number;
  applied_count: number;
  latest_seq: number;
  sync_mode?: "mock" | "remote";
};
