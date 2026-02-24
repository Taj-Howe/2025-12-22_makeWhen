import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authenticateRequest,
  type AuthenticatedRequest,
  type AuthContext,
} from "../auth/middleware.ts";
import {
  requireRoleAtLeast,
  requireTeamMember,
  type TeamRole,
} from "../auth/authz.ts";
import { queryRows, sqlLiteral } from "../db/client.ts";
import { ApiError } from "../auth/errors.ts";
import { logOperationalEvent, logSecurityEvent } from "../security/logging.ts";
import {
  applyTeamRateLimit,
  applyUserRateLimit,
} from "../security/rateLimit.ts";
import { getRequestIp } from "../security/requestMeta.ts";
import { requireCsrfForCookieAuth } from "../auth/sessionSecurity.ts";
import {
  validateRegisteredOpPayload,
  type JsonObject,
} from "../sync/opValidation.ts";
import { loadConfig } from "../config.ts";
import {
  recordQueueLagProxy,
  recordRejectedOpReason,
  recordSyncEndpointResult,
} from "../observability/metrics.ts";
import { getRequestId } from "../observability/requestContext.ts";

type WriteJson = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>
) => void;

export type SyncRouteDependencies = {
  authenticateRequest: (request: AuthenticatedRequest) => Promise<AuthContext>;
  requireTeamMember: (user_id: string, team_id: string) => Promise<TeamRole>;
  requireRoleAtLeast: (role: TeamRole, requiredRole: TeamRole) => TeamRole;
  getLatestSeq: (team_id: string) => Promise<number>;
  listOpsSince: (
    team_id: string,
    since_seq: number,
    limit: number
  ) => Promise<Array<{ server_seq: number; op: OpEnvelope }>>;
  appendOrGetServerSeq: (
    team_id: string,
    client_id: string,
    actor_user_id: string,
    op: OpEnvelope
  ) => Promise<number>;
};

type OpEnvelope = {
  op_id: string;
  team_id: string;
  actor_user_id: string;
  created_at: number;
  op_name: string;
  payload: JsonObject;
};

type PushRequestBody = {
  team_id: string;
  client_id: string;
  ops: unknown[];
};

type PullQuery = {
  team_id: string;
  since_seq: number;
  limit: number;
};

type OpRejectReasonCode =
  | "validation_failed"
  | "cross_team_access"
  | "unknown_op";

type RejectedOp = {
  op_id: string;
  reason: {
    code: OpRejectReasonCode;
    message: string;
  };
};

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

// Ensure .env values are loaded before reading SYNC_* env vars.
loadConfig();

const MAX_PUSH_BODY_BYTES = parseNumber(process.env.SYNC_MAX_BODY_BYTES, 256 * 1024);
const MAX_PUSH_BATCH = parseNumber(process.env.SYNC_MAX_BATCH_OPS, 500);
const MAX_ID_LENGTH = parseNumber(process.env.SYNC_MAX_ID_LENGTH, 128);
const MAX_OP_NAME_LENGTH = parseNumber(process.env.SYNC_MAX_OP_NAME_LENGTH, 96);

const isRecord = (value: unknown): value is JsonObject => {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
};

const ensureOnlyKeys = (
  objectValue: JsonObject,
  allowedKeys: readonly string[],
  context: string
) => {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(objectValue).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      `${context} has unknown fields: ${unknown.join(", ")}.`
    );
  }
};

const parseBoundedString = (
  value: unknown,
  fieldName: string,
  maxLength: number = MAX_ID_LENGTH
): string => {
  if (typeof value !== "string") {
    throw new ApiError(400, "BAD_REQUEST", `${fieldName} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApiError(400, "BAD_REQUEST", `${fieldName} must not be empty.`);
  }
  if (trimmed.length > maxLength) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      `${fieldName} must be at most ${maxLength} chars.`
    );
  }
  return trimmed;
};

const parseNonNegativeInt = (
  raw: string | null,
  fieldName: string,
  defaultValue: number
) => {
  if (raw === null || raw.trim().length === 0) {
    return defaultValue;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new ApiError(400, "BAD_REQUEST", `${fieldName} must be a non-negative integer.`);
  }
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError(400, "BAD_REQUEST", `${fieldName} must be a safe integer.`);
  }
  return parsed;
};

const parsePullQuery = (requestUrl: URL): PullQuery => {
  const allowedQueryKeys = new Set(["team_id", "since_seq", "limit"]);
  for (const key of requestUrl.searchParams.keys()) {
    if (!allowedQueryKeys.has(key)) {
      throw new ApiError(400, "BAD_REQUEST", `Unknown query parameter: ${key}.`);
    }
  }

  const team_id = parseBoundedString(requestUrl.searchParams.get("team_id"), "team_id");
  const since_seq = parseNonNegativeInt(
    requestUrl.searchParams.get("since_seq"),
    "since_seq",
    0
  );
  const rawLimit = parseNonNegativeInt(requestUrl.searchParams.get("limit"), "limit", 500);
  if (rawLimit <= 0) {
    throw new ApiError(400, "BAD_REQUEST", "limit must be greater than zero.");
  }

  return {
    team_id,
    since_seq,
    limit: Math.min(rawLimit, 5000),
  };
};

const parsePushRequestBody = (value: unknown): PushRequestBody => {
  if (!isRecord(value)) {
    throw new ApiError(400, "BAD_REQUEST", "Request body must be a JSON object.");
  }

  ensureOnlyKeys(value, ["team_id", "client_id", "ops"], "push body");

  const team_id = parseBoundedString(value.team_id, "team_id");
  const client_id = parseBoundedString(value.client_id, "client_id");

  if (!Array.isArray(value.ops)) {
    throw new ApiError(400, "BAD_REQUEST", "ops must be an array.");
  }
  if (value.ops.length === 0) {
    throw new ApiError(400, "BAD_REQUEST", "ops must not be empty.");
  }
  if (value.ops.length > MAX_PUSH_BATCH) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      `ops exceeds max batch length ${MAX_PUSH_BATCH}.`
    );
  }

  return {
    team_id,
    client_id,
    ops: value.ops,
  };
};

const readJsonBody = async (
  request: IncomingMessage,
  maxBytes: number
): Promise<unknown> => {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += bytes.byteLength;
    if (total > maxBytes) {
      throw new ApiError(
        413,
        "PAYLOAD_TOO_LARGE",
        `Request body exceeds ${maxBytes} bytes.`
      );
    }
    chunks.push(bytes);
  }

  const bodyText = Buffer.concat(chunks).toString("utf8").trim();
  if (!bodyText) {
    throw new ApiError(400, "BAD_REQUEST", "Request body is required.");
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Request body must be valid JSON.");
  }
};

const parseOpEnvelope = (raw: unknown): { ok: true; op: OpEnvelope } | RejectedOp => {
  if (!isRecord(raw)) {
    return {
      op_id: "unknown",
      reason: {
        code: "validation_failed",
        message: "Op envelope must be an object.",
      },
    };
  }

  const allowedFields = [
    "op_id",
    "team_id",
    "actor_user_id",
    "created_at",
    "op_name",
    "payload",
  ] as const;

  const unknownFields = Object.keys(raw).filter((key) => !allowedFields.includes(key as never));
  if (unknownFields.length > 0) {
    return {
      op_id:
        typeof raw.op_id === "string" && raw.op_id.trim().length > 0
          ? raw.op_id.trim()
          : "unknown",
      reason: {
        code: "validation_failed",
        message: `Op envelope has unknown fields: ${unknownFields.join(", ")}.`,
      },
    };
  }

  const op_id =
    typeof raw.op_id === "string" && raw.op_id.trim().length > 0
      ? raw.op_id.trim()
      : "unknown";

  const team_id =
    typeof raw.team_id === "string" ? raw.team_id.trim() : "";
  const actor_user_id =
    typeof raw.actor_user_id === "string" ? raw.actor_user_id.trim() : "";
  const created_at = Number(raw.created_at);
  const op_name = typeof raw.op_name === "string" ? raw.op_name.trim() : "";
  const payload = raw.payload;

  if (
    !team_id ||
    team_id.length > MAX_ID_LENGTH ||
    !actor_user_id ||
    actor_user_id.length > MAX_ID_LENGTH ||
    !Number.isFinite(created_at) ||
    !Number.isSafeInteger(created_at) ||
    !op_name ||
    op_name.length > MAX_OP_NAME_LENGTH ||
    !isRecord(payload)
  ) {
    return {
      op_id,
      reason: {
        code: "validation_failed",
        message:
          "Op envelope requires bounded op_id/team_id/actor_user_id/op_name, integer created_at, and payload object.",
      },
    };
  }

  if (op_id.length > MAX_ID_LENGTH) {
    return {
      op_id,
      reason: {
        code: "validation_failed",
        message: `op_id must be at most ${MAX_ID_LENGTH} chars.`,
      },
    };
  }

  return {
    ok: true,
    op: {
      op_id,
      team_id,
      actor_user_id,
      created_at,
      op_name,
      payload,
    },
  };
};

const defaultDependencies: SyncRouteDependencies = {
  authenticateRequest: authenticateRequest(),
  requireTeamMember,
  requireRoleAtLeast,
  getLatestSeq: async (team_id: string) => {
    const rows = await queryRows(
      `SELECT latest_seq
       FROM team_seq
       WHERE team_id = ${sqlLiteral(team_id)}
       LIMIT 1;`,
      ["latest_seq"] as const
    );
    const value = Number(rows[0]?.latest_seq ?? "0");
    return Number.isFinite(value) ? value : 0;
  },
  listOpsSince: async (team_id: string, since_seq: number, limit: number) => {
    const rows = await queryRows(
      `SELECT
         server_seq,
         op_id,
         team_id,
         actor_user_id,
         created_at,
         op_name,
         payload_json::text AS payload_json
       FROM team_oplog
       WHERE team_id = ${sqlLiteral(team_id)}
         AND server_seq > ${since_seq}
       ORDER BY server_seq ASC
       LIMIT ${limit};`,
      [
        "server_seq",
        "op_id",
        "team_id",
        "actor_user_id",
        "created_at",
        "op_name",
        "payload_json",
      ] as const
    );

    return rows
      .map((row) => {
        const server_seq = Number(row.server_seq ?? NaN);
        const created_at = Number(row.created_at ?? NaN);
        if (
          !Number.isFinite(server_seq) ||
          !Number.isFinite(created_at) ||
          !row.op_id ||
          !row.team_id ||
          !row.actor_user_id ||
          !row.op_name
        ) {
          return null;
        }
        let payload: JsonObject = {};
        try {
          const parsed = JSON.parse(row.payload_json ?? "{}") as unknown;
          if (isRecord(parsed)) {
            payload = parsed;
          }
        } catch {
          payload = {};
        }
        return {
          server_seq,
          op: {
            op_id: row.op_id,
            team_id: row.team_id,
            actor_user_id: row.actor_user_id,
            created_at,
            op_name: row.op_name,
            payload,
          },
        };
      })
      .filter((entry): entry is { server_seq: number; op: OpEnvelope } => entry !== null);
  },
  appendOrGetServerSeq: async (
    team_id: string,
    client_id: string,
    actor_user_id: string,
    op: OpEnvelope
  ) => {
    const existingRows = await queryRows(
      `SELECT server_seq
       FROM team_oplog
       WHERE team_id = ${sqlLiteral(team_id)}
         AND op_id = ${sqlLiteral(op.op_id)}
       LIMIT 1;`,
      ["server_seq"] as const
    );
    const existing = Number(existingRows[0]?.server_seq ?? NaN);
    if (Number.isFinite(existing)) {
      return existing;
    }

    const seqRows = await queryRows(
      `BEGIN;
       SELECT pg_advisory_xact_lock(hashtext(${sqlLiteral(team_id)}));
       WITH existing AS (
         SELECT server_seq
         FROM team_oplog
         WHERE team_id = ${sqlLiteral(team_id)}
           AND op_id = ${sqlLiteral(op.op_id)}
         LIMIT 1
       ),
       next_seq AS (
         INSERT INTO team_seq (team_id, latest_seq, updated_at)
         SELECT ${sqlLiteral(team_id)}, 1, NOW()
         WHERE NOT EXISTS (SELECT 1 FROM existing)
         ON CONFLICT (team_id)
         DO UPDATE SET latest_seq = team_seq.latest_seq + 1, updated_at = NOW()
         RETURNING latest_seq
       ),
       inserted AS (
         INSERT INTO team_oplog (
           team_id,
           server_seq,
           op_id,
           actor_user_id,
           client_id,
           created_at,
           op_name,
           payload_json,
           received_at
         )
         SELECT
           ${sqlLiteral(team_id)},
           (SELECT latest_seq FROM next_seq),
           ${sqlLiteral(op.op_id)},
           ${sqlLiteral(actor_user_id)},
           ${sqlLiteral(client_id)},
           ${Number(op.created_at)},
           ${sqlLiteral(op.op_name)},
           ${sqlLiteral(JSON.stringify(op.payload))}::jsonb,
           NOW()
         WHERE NOT EXISTS (SELECT 1 FROM existing)
         RETURNING server_seq
       )
       SELECT server_seq FROM existing
       UNION ALL
       SELECT server_seq FROM inserted;
       COMMIT;`,
      ["server_seq"] as const
    );
    const seq = Number(seqRows[0]?.server_seq ?? NaN);
    if (!Number.isFinite(seq)) {
      throw new Error(`Unable to resolve server_seq for op ${op.op_id}`);
    }
    return seq;
  },
};

const logRejectedOp = (
  request: IncomingMessage,
  auth: AuthContext,
  teamId: string,
  opId: string,
  opName: string,
  reason: RejectedOp["reason"]
) => {
  logSecurityEvent({
    event: "op_rejected",
    request_id: getRequestId(request),
    method: request.method ?? "GET",
    path: request.url ?? "/",
    endpoint: "sync.push",
    ip: getRequestIp(request),
    session_id: auth.session_id,
    user_id: auth.user_id,
    team_id: teamId,
    op_id: opId,
    op_name: opName,
    reason_code: reason.code,
    reason: reason.message,
  });
};

export const handleSyncRoute = async (
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  writeJson: WriteJson,
  depsOverride: Partial<SyncRouteDependencies> = {}
) => {
  const deps = {
    ...defaultDependencies,
    ...depsOverride,
  };

  const method = request.method ?? "GET";
  const auth = await deps.authenticateRequest(request as AuthenticatedRequest);

  if (method === "GET" && requestUrl.pathname === "/sync/pull") {
    const { team_id, since_seq, limit } = parsePullQuery(requestUrl);

    applyUserRateLimit(auth.user_id, "sync.pull");
    applyTeamRateLimit(team_id, "sync.pull");

    const role = await deps.requireTeamMember(auth.user_id, team_id);
    deps.requireRoleAtLeast(role, "viewer");

    const latest_seq = await deps.getLatestSeq(team_id);
    const ops = (await deps.listOpsSince(team_id, since_seq, limit))
      .filter((entry) => entry.server_seq > since_seq)
      .sort((a, b) => a.server_seq - b.server_seq);

    recordQueueLagProxy(team_id, latest_seq, since_seq);
    recordSyncEndpointResult("pull", "success");
    logOperationalEvent({
      event: "sync_pull_succeeded",
      request_id: getRequestId(request),
      method,
      path: requestUrl.pathname,
      endpoint: "sync.pull",
      ip: getRequestIp(request),
      session_id: auth.session_id,
      user_id: auth.user_id,
      team_id,
      detail: `ops_returned=${ops.length};latest_seq=${latest_seq};since_seq=${since_seq}`,
    });

    writeJson(response, 200, {
      ops,
      latest_seq,
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/sync/push") {
    const rawBody = await readJsonBody(request, MAX_PUSH_BODY_BYTES);
    const body = parsePushRequestBody(rawBody);

    requireCsrfForCookieAuth(request, auth.auth_method);

    applyUserRateLimit(auth.user_id, "sync.push");
    applyTeamRateLimit(body.team_id, "sync.push");

    const role = await deps.requireTeamMember(auth.user_id, body.team_id);
    deps.requireRoleAtLeast(role, "editor");

    const acked: Array<{ op_id: string; server_seq: number }> = [];
    const rejected: RejectedOp[] = [];

    for (const rawOp of body.ops) {
      const parsed = parseOpEnvelope(rawOp);
      if (!("ok" in parsed && parsed.ok)) {
        rejected.push(parsed);
        recordRejectedOpReason(parsed.reason.code);
        logRejectedOp(request, auth, body.team_id, parsed.op_id, "unknown", parsed.reason);
        continue;
      }

      if (parsed.op.team_id !== body.team_id) {
        const reason = {
          code: "cross_team_access" as const,
          message: "Op team_id must match request team_id.",
        };
        rejected.push({
          op_id: parsed.op.op_id,
          reason,
        });
        recordRejectedOpReason(reason.code);
        logRejectedOp(
          request,
          auth,
          body.team_id,
          parsed.op.op_id,
          parsed.op.op_name,
          reason
        );
        continue;
      }

      const payloadValidation = validateRegisteredOpPayload(
        parsed.op.op_name,
        parsed.op.payload
      );
      if (!payloadValidation.ok) {
        rejected.push({
          op_id: parsed.op.op_id,
          reason: {
            code: payloadValidation.code,
            message: payloadValidation.message,
          },
        });
        recordRejectedOpReason(payloadValidation.code);
        logRejectedOp(
          request,
          auth,
          body.team_id,
          parsed.op.op_id,
          parsed.op.op_name,
          {
            code: payloadValidation.code,
            message: payloadValidation.message,
          }
        );
        continue;
      }

      const server_seq = await deps.appendOrGetServerSeq(
        body.team_id,
        body.client_id,
        auth.user_id,
        parsed.op
      );

      acked.push({
        op_id: parsed.op.op_id,
        server_seq,
      });
    }

    recordSyncEndpointResult("push", "success");
    logOperationalEvent({
      event: "sync_push_succeeded",
      request_id: getRequestId(request),
      method,
      path: requestUrl.pathname,
      endpoint: "sync.push",
      ip: getRequestIp(request),
      session_id: auth.session_id,
      user_id: auth.user_id,
      team_id: body.team_id,
      detail: `acked=${acked.length};rejected=${rejected.length}`,
    });

    writeJson(response, 200, {
      acked,
      rejected,
    });
    return;
  }

  throw new ApiError(404, "BAD_REQUEST", "Unknown sync route.");
};
