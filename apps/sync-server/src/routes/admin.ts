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
import { ApiError } from "../auth/errors.ts";
import { getRateLimitConfig } from "../security/rateLimit.ts";
import { getMetricsSnapshot } from "../observability/metrics.ts";
import { getRequestId } from "../observability/requestContext.ts";
import { getRequestIp } from "../security/requestMeta.ts";
import { logOperationalEvent } from "../security/logging.ts";

type WriteJson = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>
) => void;

export type AdminRouteDependencies = {
  authenticateRequest: (request: AuthenticatedRequest) => Promise<AuthContext>;
  requireTeamMember: (user_id: string, team_id: string) => Promise<TeamRole>;
  requireRoleAtLeast: (role: TeamRole, requiredRole: TeamRole) => TeamRole;
  getMetricsSnapshot: typeof getMetricsSnapshot;
};

const defaultDependencies: AdminRouteDependencies = {
  authenticateRequest: authenticateRequest(),
  requireTeamMember,
  requireRoleAtLeast,
  getMetricsSnapshot,
};

const parseTeamId = (requestUrl: URL) => {
  const allowedQueryKeys = new Set(["team_id"]);
  for (const key of requestUrl.searchParams.keys()) {
    if (!allowedQueryKeys.has(key)) {
      throw new ApiError(400, "BAD_REQUEST", `Unknown query parameter: ${key}.`);
    }
  }

  const teamId = requestUrl.searchParams.get("team_id")?.trim() ?? "";
  if (!teamId) {
    throw new ApiError(400, "BAD_REQUEST", "team_id is required.");
  }
  return teamId;
};

export const handleAdminRoute = async (
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  writeJson: WriteJson,
  depsOverride: Partial<AdminRouteDependencies> = {}
) => {
  const deps = {
    ...defaultDependencies,
    ...depsOverride,
  };

  const method = request.method ?? "GET";

  if (method === "GET" && requestUrl.pathname === "/admin/metrics") {
    const teamId = parseTeamId(requestUrl);
    const auth = await deps.authenticateRequest(request as AuthenticatedRequest);

    const role = await deps.requireTeamMember(auth.user_id, teamId);
    deps.requireRoleAtLeast(role, "owner");

    const metrics = deps.getMetricsSnapshot();

    logOperationalEvent({
      event: "admin_metrics_viewed",
      request_id: getRequestId(request),
      method,
      path: requestUrl.pathname,
      endpoint: "admin.metrics",
      ip: getRequestIp(request),
      session_id: auth.session_id,
      user_id: auth.user_id,
      team_id: teamId,
    });

    writeJson(response, 200, {
      team_id: teamId,
      request_id: getRequestId(request),
      rate_limit_config: getRateLimitConfig(),
      metrics,
    });
    return;
  }

  throw new ApiError(404, "BAD_REQUEST", "Unknown admin route.");
};
