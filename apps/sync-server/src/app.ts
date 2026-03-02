import type { IncomingMessage, ServerResponse } from "node:http";
import { isApiError } from "./auth/errors.ts";
import { pingDatabase } from "./db/client.ts";
import {
  handleSyncRoute,
  type SyncRouteDependencies,
} from "./routes/sync.ts";
import {
  handleAdminRoute,
  type AdminRouteDependencies,
} from "./routes/admin.ts";
import {
  handleAuthRoute,
  type AuthRouteDependencies,
} from "./routes/auth.ts";
import {
  handleTeamRoute,
  type TeamRouteDependencies,
} from "./routes/team.ts";
import { applyIpRateLimit } from "./security/rateLimit.ts";
import { logSecurityEvent } from "./security/logging.ts";
import { getRequestIp } from "./security/requestMeta.ts";
import {
  recordAuthFailure,
  recordSyncEndpointResult,
  type SyncEndpoint,
} from "./observability/metrics.ts";
import {
  attachRequestContext,
  getRequestId,
} from "./observability/requestContext.ts";

export type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void>;

const writeJson = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  corsOrigin: string
) => {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Access-Control-Allow-Origin", corsOrigin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.end(JSON.stringify(body));
};

export const buildHandler = (
  corsOrigin: string,
  syncDeps: Partial<SyncRouteDependencies> = {},
  adminDeps: Partial<AdminRouteDependencies> = {},
  authDeps: Partial<AuthRouteDependencies> = {},
  teamDeps: Partial<TeamRouteDependencies> = {}
): RequestHandler => {
  return async (request, response) => {
    const method = request.method ?? "GET";
    const url = request.url ?? "/";
    const parsedUrl = new URL(url, "http://localhost");
    const ip = getRequestIp(request);
    const requestId = attachRequestContext(request, response);

    const resolveSyncEndpoint = (): SyncEndpoint | null => {
      if (method === "GET" && parsedUrl.pathname === "/sync/pull") {
        return "pull";
      }
      if (method === "POST" && parsedUrl.pathname === "/sync/push") {
        return "push";
      }
      return null;
    };

    const writeApiError = (error: unknown) => {
      if (!isApiError(error)) {
        throw error;
      }

      const endpoint = resolveSyncEndpoint();
      if (endpoint) {
        recordSyncEndpointResult(endpoint, "failure");
      }
      if (error.code === "UNAUTHENTICATED") {
        recordAuthFailure();
      }

      if (
        error.code === "UNAUTHENTICATED" ||
        error.code === "NOT_TEAM_MEMBER" ||
        error.code === "INSUFFICIENT_ROLE" ||
        error.code === "RATE_LIMITED" ||
        error.code === "CSRF_INVALID"
      ) {
        const maybeAuth = (request as {
          auth?: { session_id?: string; user_id?: string };
        }).auth;

        logSecurityEvent({
          event:
            error.code === "UNAUTHENTICATED"
              ? "auth_failure"
              : error.code === "RATE_LIMITED"
                ? "rate_limited"
                : error.code === "CSRF_INVALID"
                  ? "csrf_failed"
                  : "authz_denied",
          request_id: requestId,
          method,
          path: parsedUrl.pathname,
          endpoint: endpoint
            ? `sync.${endpoint}`
            : parsedUrl.pathname.startsWith("/admin/")
              ? "admin.metrics"
              : parsedUrl.pathname,
          ip,
          session_id: maybeAuth?.session_id ?? null,
          user_id: maybeAuth?.user_id ?? null,
          reason_code: error.code,
          reason: error.message,
        });
      }

      writeJson(
        response,
        error.statusCode,
        {
          ok: false,
          error: error.code,
          message: error.message,
          request_id: requestId,
        },
        corsOrigin
      );
    };

    if (method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("Access-Control-Allow-Origin", corsOrigin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,X-CSRF-Token,X-Request-Id"
      );
      response.end();
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/health/live") {
      writeJson(
        response,
        200,
        {
          ok: true,
          status: "live",
          service: "sync-server",
          now: Date.now(),
          request_id: requestId,
        },
        corsOrigin
      );
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/health/ready") {
      const ping = await pingDatabase();
      if (!ping.ok) {
        writeJson(
          response,
          503,
          {
            ok: false,
            status: "not_ready",
            service: "sync-server",
            error: ping.error,
            request_id: requestId,
          },
          corsOrigin
        );
        return;
      }
      writeJson(
        response,
        200,
        {
          ok: true,
          status: "ready",
          service: "sync-server",
          now: Date.now(),
          request_id: requestId,
        },
        corsOrigin
      );
      return;
    }

    if (parsedUrl.pathname.startsWith("/sync/")) {
      try {
        applyIpRateLimit(ip, `sync:${method}`);
        await handleSyncRoute(
          request,
          response,
          parsedUrl,
          (res, status, body) => {
            writeJson(res, status, body, corsOrigin);
          },
          syncDeps
        );
      } catch (error) {
        writeApiError(error);
      }
      return;
    }

    if (parsedUrl.pathname.startsWith("/admin/")) {
      try {
        applyIpRateLimit(ip, `admin:${method}`);
        await handleAdminRoute(
          request,
          response,
          parsedUrl,
          (res, status, body) => {
            writeJson(res, status, body, corsOrigin);
          },
          adminDeps
        );
      } catch (error) {
        writeApiError(error);
      }
      return;
    }

    if (parsedUrl.pathname.startsWith("/auth/")) {
      try {
        applyIpRateLimit(ip, `auth:${method}`);
        await handleAuthRoute(
          request,
          response,
          parsedUrl,
          (res, status, body) => {
            writeJson(res, status, body, corsOrigin);
          },
          authDeps
        );
      } catch (error) {
        writeApiError(error);
      }
      return;
    }

    if (
      parsedUrl.pathname.startsWith("/teams/") ||
      parsedUrl.pathname.startsWith("/invites/")
    ) {
      try {
        applyIpRateLimit(ip, `teams:${method}`);
        await handleTeamRoute(
          request,
          response,
          parsedUrl,
          (res, status, body) => {
            writeJson(res, status, body, corsOrigin);
          },
          teamDeps
        );
      } catch (error) {
        writeApiError(error);
      }
      return;
    }

    writeJson(
      response,
      404,
      {
        ok: false,
        error: "not_found",
        request_id: getRequestId(request),
      },
      corsOrigin
    );
  };
};
