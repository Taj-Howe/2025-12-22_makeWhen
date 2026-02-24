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
  parseCookies,
} from "../auth/sessionSecurity.ts";
import { executeSql, queryRows, sqlLiteral } from "../db/client.ts";
import { loadConfig } from "../config.ts";

type WriteJson = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>
) => void;

export type AuthRouteDependencies = {
  resolveSessionFromDatabase: typeof resolveSessionFromDatabase;
};

type CookieOptions = {
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  maxAge?: number;
};

type OAuthIdentity = {
  user_id: string;
  display_name: string;
  email: string | null;
};

const OAUTH_STATE_COOKIE = "mw_oauth_state";
const OAUTH_RETURN_COOKIE = "mw_oauth_return";

// Ensure .env values are loaded before reading OAUTH_* env vars.
loadConfig();

const defaultDependencies: AuthRouteDependencies = {
  resolveSessionFromDatabase,
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

const normalizePath = (candidate: string | null) => {
  if (!candidate) {
    return "/";
  }
  if (!candidate.startsWith("/") || candidate.startsWith("//")) {
    return "/";
  }
  return candidate;
};

const parseReturnTo = (request: IncomingMessage, raw: string | null) => {
  if (!raw || raw.trim().length === 0) {
    return "/";
  }
  const value = raw.trim();
  if (value.startsWith("/")) {
    return normalizePath(value);
  }

  try {
    const parsed = new URL(value);
    const corsOrigin = loadConfig().corsOrigin;
    const allowedOrigin =
      corsOrigin !== "*" && corsOrigin.trim().length > 0
        ? new URL(corsOrigin).origin
        : null;

    const requestHost = request.headers.host?.trim() ?? "";
    const sameHost = requestHost
      ? parsed.host.toLowerCase() === requestHost.toLowerCase()
      : false;

    if (allowedOrigin && parsed.origin === allowedOrigin) {
      return parsed.toString();
    }
    if (sameHost) {
      return parsed.toString();
    }
  } catch {
    // fall through
  }

  return "/";
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

const redirect = (response: ServerResponse, location: string) => {
  response.statusCode = 302;
  response.setHeader("Location", location);
  response.end();
};

const readOAuthConfig = () => {
  return {
    authorizeUrl: process.env.OAUTH_AUTHORIZE_URL?.trim() ?? "",
    tokenUrl: process.env.OAUTH_TOKEN_URL?.trim() ?? "",
    userInfoUrl: process.env.OAUTH_USERINFO_URL?.trim() ?? "",
    clientId: process.env.OAUTH_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.OAUTH_CLIENT_SECRET?.trim() ?? "",
    redirectUri:
      process.env.OAUTH_REDIRECT_URI?.trim() ??
      "http://127.0.0.1:8787/auth/oauth/callback",
    scope:
      process.env.OAUTH_SCOPE?.trim() || "openid profile email",
  };
};

const isOAuthProviderConfigured = () => {
  const config = readOAuthConfig();
  return (
    config.authorizeUrl.length > 0 &&
    config.tokenUrl.length > 0 &&
    config.clientId.length > 0 &&
    config.redirectUri.length > 0
  );
};

const resolveDevIdentity = (): OAuthIdentity => {
  const userId = process.env.OAUTH_DEV_USER_ID?.trim() || "oauth_dev_user";
  const displayName = process.env.OAUTH_DEV_USER_NAME?.trim() || "OAuth Dev User";
  const email = process.env.OAUTH_DEV_USER_EMAIL?.trim() || "oauth-dev@example.com";
  return {
    user_id: userId,
    display_name: displayName,
    email,
  };
};

const resolveIdentityFromProvider = async (code: string): Promise<OAuthIdentity> => {
  const config = readOAuthConfig();
  const tokenResponse = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    throw new ApiError(
      401,
      "UNAUTHENTICATED",
      `OAuth token exchange failed (${tokenResponse.status}).`
    );
  }

  const tokenPayload = (await tokenResponse.json()) as Record<string, unknown>;
  const accessToken =
    typeof tokenPayload.access_token === "string"
      ? tokenPayload.access_token
      : "";
  if (!accessToken) {
    throw new ApiError(401, "UNAUTHENTICATED", "OAuth token response missing access_token.");
  }

  if (!config.userInfoUrl) {
    throw new ApiError(
      500,
      "BAD_REQUEST",
      "OAUTH_USERINFO_URL is required for provider-based OAuth mode."
    );
  }

  const userInfoResponse = await fetch(config.userInfoUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!userInfoResponse.ok) {
    throw new ApiError(
      401,
      "UNAUTHENTICATED",
      `OAuth userinfo request failed (${userInfoResponse.status}).`
    );
  }

  const userInfo = (await userInfoResponse.json()) as Record<string, unknown>;
  const userId =
    typeof userInfo.sub === "string"
      ? userInfo.sub
      : typeof userInfo.id === "string"
        ? userInfo.id
        : typeof userInfo.email === "string"
          ? userInfo.email
          : "";
  if (!userId) {
    throw new ApiError(
      401,
      "UNAUTHENTICATED",
      "OAuth userinfo response missing stable user identifier."
    );
  }

  const displayName =
    typeof userInfo.name === "string" && userInfo.name.trim().length > 0
      ? userInfo.name.trim()
      : typeof userInfo.preferred_username === "string" &&
          userInfo.preferred_username.trim().length > 0
        ? userInfo.preferred_username.trim()
        : typeof userInfo.email === "string" && userInfo.email.trim().length > 0
          ? userInfo.email.trim()
          : userId;

  const email =
    typeof userInfo.email === "string" && userInfo.email.trim().length > 0
      ? userInfo.email.trim()
      : null;

  return {
    user_id: userId,
    display_name: displayName,
    email,
  };
};

const resolveOAuthIdentity = async (code: string): Promise<OAuthIdentity> => {
  if (code === "dev" || !isOAuthProviderConfigured()) {
    return resolveDevIdentity();
  }
  return resolveIdentityFromProvider(code);
};

const resolveTeamDefaults = () => {
  return {
    team_id: process.env.OAUTH_DEFAULT_TEAM_ID?.trim() || "team_default",
    team_name: process.env.OAUTH_DEFAULT_TEAM_NAME?.trim() || "Default Team",
    role: (process.env.OAUTH_DEFAULT_ROLE?.trim().toLowerCase() || "editor") as
      | "owner"
      | "editor"
      | "viewer",
  };
};

const createSessionForIdentity = async (identity: OAuthIdentity) => {
  const { team_id, team_name, role } = resolveTeamDefaults();
  const sessionId = randomUUID();
  const expiresAtSeconds = Math.floor(
    (Date.now() + AUTH_SESSION_TTL_HOURS * 60 * 60 * 1000) / 1000
  );

  await executeSql(`
    INSERT INTO users (user_id, display_name, email)
    VALUES (${sqlLiteral(identity.user_id)}, ${sqlLiteral(identity.display_name)}, ${
      identity.email ? sqlLiteral(identity.email) : "NULL"
    })
    ON CONFLICT (user_id)
    DO UPDATE SET
      display_name = EXCLUDED.display_name,
      email = COALESCE(EXCLUDED.email, users.email),
      updated_at = NOW();

    INSERT INTO teams (team_id, name)
    VALUES (${sqlLiteral(team_id)}, ${sqlLiteral(team_name)})
    ON CONFLICT (team_id)
    DO UPDATE SET
      name = EXCLUDED.name,
      updated_at = NOW();

    INSERT INTO team_members (team_id, user_id, role)
    VALUES (${sqlLiteral(team_id)}, ${sqlLiteral(identity.user_id)}, ${sqlLiteral(role)})
    ON CONFLICT (team_id, user_id)
    DO UPDATE SET role = EXCLUDED.role;

    INSERT INTO sessions (session_id, user_id, expires_at)
    VALUES (${sqlLiteral(sessionId)}, ${sqlLiteral(identity.user_id)}, to_timestamp(${expiresAtSeconds}))
    ON CONFLICT (session_id)
    DO NOTHING;
  `);

  return {
    session_id: sessionId,
    user_id: identity.user_id,
    team_id,
  };
};

const buildAuthoriseRedirect = (state: string) => {
  const config = readOAuthConfig();
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  return url.toString();
};

const handleOAuthStart = async (
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
) => {
  const returnTo = parseReturnTo(request, requestUrl.searchParams.get("return_to"));
  const state = randomUUID();
  const secure = shouldUseSecureCookie(request);

  appendSetCookie(
    response,
    serializeCookie(OAUTH_STATE_COOKIE, state, {
      path: "/",
      secure,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 600,
    })
  );
  appendSetCookie(
    response,
    serializeCookie(OAUTH_RETURN_COOKIE, encodeURIComponent(returnTo), {
      path: "/",
      secure,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 600,
    })
  );

  if (isOAuthProviderConfigured()) {
    redirect(response, buildAuthoriseRedirect(state));
    return;
  }

  redirect(response, `/auth/oauth/callback?code=dev&state=${encodeURIComponent(state)}`);
};

const handleOAuthCallback = async (
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
) => {
  const code = requestUrl.searchParams.get("code")?.trim() ?? "";
  const state = requestUrl.searchParams.get("state")?.trim() ?? "";
  if (!code) {
    throw new ApiError(400, "BAD_REQUEST", "OAuth callback missing code.");
  }

  const cookies = parseCookies(request);
  const expectedState = cookies[OAUTH_STATE_COOKIE]?.trim() ?? "";
  if (!expectedState || !state || expectedState !== state) {
    throw new ApiError(401, "UNAUTHENTICATED", "OAuth state validation failed.");
  }

  const returnToRaw = cookies[OAUTH_RETURN_COOKIE]
    ? decodeURIComponent(cookies[OAUTH_RETURN_COOKIE])
    : "/";
  const returnTo = parseReturnTo(request, returnToRaw);

  const identity = await resolveOAuthIdentity(code);
  const session = await createSessionForIdentity(identity);

  const secure = shouldUseSecureCookie(request);
  const csrfToken = randomUUID();

  appendSetCookie(
    response,
    serializeCookie(SESSION_COOKIE_NAME, session.session_id, {
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

  clearCookie(response, request, OAUTH_STATE_COOKIE, { httpOnly: true });
  clearCookie(response, request, OAUTH_RETURN_COOKIE, { httpOnly: true });

  redirect(response, returnTo);
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
      const role =
        row.role === "owner" || row.role === "editor" || row.role === "viewer"
          ? row.role
          : "viewer";
      return {
        team_id: teamId,
        team_name: (row.team_name ?? teamId).trim() || teamId,
        role,
      };
    })
    .filter(
      (
        row
      ): row is { team_id: string; team_name: string; role: "owner" | "editor" | "viewer" } =>
        row !== null
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

const handleLogout = async (
  request: IncomingMessage,
  response: ServerResponse,
  writeJson: WriteJson
) => {
  const token = extractSessionToken(request);
  if (token?.token) {
    await executeSql(`
      UPDATE sessions
      SET revoked_at = NOW()
      WHERE session_id = ${sqlLiteral(token.token)};
    `);
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

  if (method === "GET" && requestUrl.pathname === "/auth/oauth/start") {
    await handleOAuthStart(request, response, requestUrl);
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/auth/oauth/callback") {
    await handleOAuthCallback(request, response, requestUrl);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/auth/logout") {
    await handleLogout(request, response, writeJson);
    return;
  }

  throw new ApiError(404, "BAD_REQUEST", "Unknown auth route.");
};
