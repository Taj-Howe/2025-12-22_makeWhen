export type SecurityEventType =
  | "auth_failure"
  | "authz_denied"
  | "rate_limited"
  | "op_rejected"
  | "csrf_failed";

export type OperationalEventType =
  | "sync_push_succeeded"
  | "sync_pull_succeeded"
  | "admin_metrics_viewed";

export type SecurityEventPayload = {
  event: SecurityEventType;
  request_id?: string;
  method?: string;
  path?: string;
  endpoint?: string;
  ip?: string;
  session_id?: string | null;
  user_id?: string | null;
  team_id?: string | null;
  op_id?: string;
  op_name?: string;
  reason_code?: string;
  reason?: string;
  detail?: string;
};

export const logSecurityEvent = (payload: SecurityEventPayload) => {
  const record = {
    ts: new Date().toISOString(),
    kind: "security_event",
    ...payload,
  };
  console.warn(JSON.stringify(record));
};

export type OperationalEventPayload = {
  event: OperationalEventType;
  request_id?: string;
  method?: string;
  path?: string;
  endpoint?: string;
  ip?: string;
  session_id?: string | null;
  user_id?: string | null;
  team_id?: string | null;
  detail?: string;
};

export const logOperationalEvent = (payload: OperationalEventPayload) => {
  const record = {
    ts: new Date().toISOString(),
    kind: "ops_event",
    ...payload,
  };
  console.info(JSON.stringify(record));
};
