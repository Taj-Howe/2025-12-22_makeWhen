import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "../auth/errors.ts";
import {
  extractSessionToken,
  resolveSessionFromDatabase,
} from "../auth/middleware.ts";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  requireCsrfForCookieAuth,
} from "../auth/sessionSecurity.ts";
import { queryRows, sqlLiteral } from "../db/client.ts";
import { verifyClerkRequest, type ClerkIdentity } from "../auth/clerk.ts";
import { loadConfig } from "../config.ts";

type WriteJson = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>
) => void;

export type AuthRouteDependencies = {
  resolveSessionFromDatabase: typeof resolveSessionFromDatabase;
  verifyClerkRequest: (request: IncomingMessage) => Promise<ClerkIdentity>;
};

type CookieOptions = {
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  maxAge?: number;
};

const defaultDependencies: AuthRouteDependencies = {
  resolveSessionFromDatabase,
  verifyClerkRequest,
};

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const AUTH_SESSION_TTL_HOURS = parseNumber(
  process.env.AUTH_SESSION_TTL_HOURS,
  24 * 30
);

const cookieSecureOverride = (() => {
  const raw = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return null;
})();

const parseRole = (value: string | undefined) => {
  const normalized = (value ?? "editor").trim().toLowerCase();
  if (normalized === "owner" || normalized === "editor" || normalized === "viewer") {
    return normalized;
  }
  return "editor";
};

const getDefaultTeam = () => {
  const config = loadConfig();
  return {
    team_id: process.env.AUTH_DEFAULT_TEAM_ID?.trim() || "team_default",
    team_name: config.authDefaultTeamName,
    role: config.authDefaultTeamRole,
  };
};

const shouldUseSecureCookie = (request: IncomingMessage) => {
  if (cookieSecureOverride !== null) {
    return cookieSecureOverride;
  }

  const protoHeader = request.headers["x-forwarded-proto"];
  const protoValue = Array.isArray(protoHeader)
    ? protoHeader[0] ?? ""
    : typeof protoHeader === "string"
      ? protoHeader
      : "";
  if (protoValue.toLowerCase().includes("https")) {
    return true;
  }

  const host = (request.headers.host ?? "").toLowerCase();
  if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
    return false;
  }

  return true;
};

const serializeCookie = (name: string, value: string, options: CookieOptions = {}) => {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  return parts.join("; ");
};

const appendSetCookie = (response: ServerResponse, cookieValue: string) => {
  const existing = response.getHeader("Set-Cookie");
  if (!existing) {
    response.setHeader("Set-Cookie", [cookieValue]);
    return;
  }
  if (Array.isArray(existing)) {
    response.setHeader("Set-Cookie", [...existing, cookieValue]);
    return;
  }
  response.setHeader("Set-Cookie", [String(existing), cookieValue]);
};

const clearCookie = (
  response: ServerResponse,
  request: IncomingMessage,
  name: string,
  options: Pick<CookieOptions, "httpOnly"> = {}
) => {
  appendSetCookie(
    response,
    serializeCookie(name, "", {
      path: "/",
      maxAge: 0,
      secure: shouldUseSecureCookie(request),
      httpOnly: options.httpOnly,
      sameSite: "Lax",
    })
  );
};

const ensureUserAndDefaultMembership = async (identity: ClerkIdentity) => {
  const { team_id, team_name, role } = getDefaultTeam();

  await queryRows(
    `INSERT INTO users (user_id, display_name, email)
      VALUES (${sqlLiteral(identity.user_id)}, ${sqlLiteral(identity.display_name)}, ${
        identity.email ? sqlLiteral(identity.email) : "NULL"
      })
      ON CONFLICT (user_id)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        email = COALESCE(EXCLUDED.email, users.email),
        updated_at = NOW();`,
    [] as const
  );

  await queryRows(
    `INSERT INTO teams (team_id, name)
      VALUES (${sqlLiteral(team_id)}, ${sqlLiteral(team_name)})
      ON CONFLICT (team_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        updated_at = NOW();`,
    [] as const
  );

  await queryRows(
    `INSERT INTO team_members (team_id, user_id, role)
      VALUES (${sqlLiteral(team_id)}, ${sqlLiteral(identity.user_id)}, ${sqlLiteral(role)})
      ON CONFLICT (team_id, user_id)
      DO NOTHING;`,
    [] as const
  );

  return { team_id };
};

const createSessionForUser = async (userId: string) => {
  const sessionId = randomUUID();
  const expiresAtSeconds = Math.floor(
    (Date.now() + AUTH_SESSION_TTL_HOURS * 60 * 60 * 1000) / 1000
  );

  await queryRows(
    `INSERT INTO sessions (session_id, user_id, expires_at)
      VALUES (${sqlLiteral(sessionId)}, ${sqlLiteral(userId)}, to_timestamp(${expiresAtSeconds}));`,
    [] as const
  );

  return sessionId;
};

const writeSessionCookies = (
  request: IncomingMessage,
  response: ServerResponse,
  sessionId: string
) => {
  const secure = shouldUseSecureCookie(request);
  const csrfToken = randomUUID();

  appendSetCookie(
    response,
    serializeCookie(SESSION_COOKIE_NAME, sessionId, {
      path: "/",
      secure,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: AUTH_SESSION_TTL_HOURS * 60 * 60,
    })
  );

  appendSetCookie(
    response,
    serializeCookie(CSRF_COOKIE_NAME, csrfToken, {
      path: "/",
      secure,
      httpOnly: false,
      sameSite: "Lax",
      maxAge: AUTH_SESSION_TTL_HOURS * 60 * 60,
    })
  );
};

const handleSessionCurrent = async (
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  writeJson: WriteJson,
  deps: AuthRouteDependencies
) => {
  const token = extractSessionToken(request);
  if (!token?.token) {
    writeJson(response, 200, { authenticated: false });
    return;
  }

  const session = await deps.resolveSessionFromDatabase(token.token);
  if (!session) {
    writeJson(response, 200, { authenticated: false });
    return;
  }

  const userRows = await queryRows(
    `SELECT user_id, display_name
      FROM users
      WHERE user_id = ${sqlLiteral(session.user_id)}
      LIMIT 1;`,
    ["user_id", "display_name"] as const
  );

  const membershipRows = await queryRows(
    `SELECT tm.team_id, tm.role, t.name AS team_name
      FROM team_members tm
      JOIN teams t ON t.team_id = tm.team_id
      WHERE tm.user_id = ${sqlLiteral(session.user_id)}
      ORDER BY
        CASE tm.role
          WHEN 'owner' THEN 1
          WHEN 'editor' THEN 2
          ELSE 3
        END,
        lower(t.name) ASC;`,
    ["team_id", "role", "team_name"] as const
  );

  if (membershipRows.length === 0 || userRows.length === 0) {
    writeJson(response, 200, { authenticated: false });
    return;
  }

  const memberships = membershipRows
    .map((row) => {
      const teamId = row.team_id?.trim() ?? "";
      if (!teamId) {
        return null;
      }
      const role = parseRole(row.role ?? undefined);
      return {
        team_id: teamId,
        team_name: (row.team_name ?? teamId).trim() || teamId,
        role,
      };
    })
    .filter(
      (
        row
      ): row is {
        team_id: string;
        team_name: string;
        role: "owner" | "editor" | "viewer";
      } => row !== null
    );

  if (memberships.length === 0) {
    writeJson(response, 200, { authenticated: false });
    return;
  }

  const requestedTeamId = requestUrl.searchParams.get("team_id")?.trim() ?? "";
  const selectedMembership =
    memberships.find((row) => row.team_id === requestedTeamId) ?? memberships[0];

  const userId = userRows[0].user_id?.trim() || session.user_id;
  const displayName = userRows[0].display_name?.trim() || userId;

  writeJson(response, 200, {
    authenticated: true,
    session: {
      session_id: session.session_id,
      user_id: session.user_id,
      team_id: selectedMembership.team_id,
    },
    user: {
      user_id: userId,
      display_name: displayName,
      avatar_url: null,
    },
    team: {
      team_id: selectedMembership.team_id,
      name: selectedMembership.team_name,
    },
    role: selectedMembership.role,
    memberships,
  });
};

const handleClerkExchange = async (
  request: IncomingMessage,
  response: ServerResponse,
  writeJson: WriteJson,
  deps: AuthRouteDependencies
) => {
  if (loadConfig().authMode !== "clerk") {
    throw new ApiError(404, "BAD_REQUEST", "Clerk exchange is disabled for AUTH_MODE=local.");
  }
  const identity = await deps.verifyClerkRequest(request);
  const { team_id } = await ensureUserAndDefaultMembership(identity);
  const sessionId = await createSessionForUser(identity.user_id);
  writeSessionCookies(request, response, sessionId);

  writeJson(response, 200, {
    exchanged: true,
    session: {
      session_id: sessionId,
      user_id: identity.user_id,
      team_id,
    },
  });
};

const handleLogout = async (
  request: IncomingMessage,
  response: ServerResponse,
  writeJson: WriteJson
) => {
  const token = extractSessionToken(request);
  requireCsrfForCookieAuth(request, token?.auth_method);
  if (token?.token) {
    await queryRows(
      `UPDATE sessions
        SET revoked_at = NOW()
        WHERE session_id = ${sqlLiteral(token.token)};`,
      [] as const
    );
  }

  clearCookie(response, request, SESSION_COOKIE_NAME, { httpOnly: true });
  clearCookie(response, request, CSRF_COOKIE_NAME);

  writeJson(response, 200, {
    logged_out: true,
  });
};

export const handleAuthRoute = async (
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  writeJson: WriteJson,
  depsOverride: Partial<AuthRouteDependencies> = {}
) => {
  const deps = {
    ...defaultDependencies,
    ...depsOverride,
  };

  const method = request.method ?? "GET";

  if (method === "GET" && requestUrl.pathname === "/auth/session") {
    await handleSessionCurrent(request, response, requestUrl, writeJson, deps);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/auth/clerk/exchange") {
    await handleClerkExchange(request, response, writeJson, deps);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/auth/logout") {
    await handleLogout(request, response, writeJson);
    return;
  }

  throw new ApiError(404, "BAD_REQUEST", "Unknown auth route.");
};
