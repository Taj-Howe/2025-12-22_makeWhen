import type { IncomingMessage } from "node:http";
import { queryRows, sqlLiteral } from "../db/client.ts";
import { ApiError } from "./errors.ts";
import {
  parseCookies,
  SESSION_COOKIE_NAME,
  type AuthMethod,
} from "./sessionSecurity.ts";

export type AuthContext = {
  user_id: string;
  session_id: string;
  auth_method?: AuthMethod;
};

export type AuthenticatedRequest = IncomingMessage & {
  auth?: AuthContext;
};

export type SessionResolver = (token: string) => Promise<AuthContext | null>;

export type SessionToken = {
  token: string;
  auth_method: AuthMethod;
};

export const extractSessionToken = (
  request: IncomingMessage
): SessionToken | null => {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return {
        token: match[1].trim(),
        auth_method: "bearer",
      };
    }
  }
  const cookies = parseCookies(request);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (typeof cookieToken === "string" && cookieToken.trim().length > 0) {
    return {
      token: cookieToken.trim(),
      auth_method: "cookie",
    };
  }

  return null;
};

export const resolveSessionFromDatabase: SessionResolver = async (token) => {
  const rows = await queryRows(
    `SELECT session_id, user_id
     FROM sessions
     WHERE session_id = ${sqlLiteral(token)}
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1;`,
    ["session_id", "user_id"] as const
  );
  const row = rows[0];
  if (!row?.session_id || !row.user_id) {
    return null;
  }
  return {
    session_id: row.session_id,
    user_id: row.user_id,
  };
};

export const authenticateRequest =
  (resolveSession: SessionResolver = resolveSessionFromDatabase) =>
  async (request: AuthenticatedRequest): Promise<AuthContext> => {
    const sessionToken = extractSessionToken(request);
    if (!sessionToken) {
      throw new ApiError(401, "UNAUTHENTICATED", "Missing session token.");
    }

    const session = await resolveSession(sessionToken.token);
    if (!session) {
      throw new ApiError(401, "UNAUTHENTICATED", "Invalid or expired session token.");
    }

    const withAuthMethod: AuthContext = {
      ...session,
      auth_method: sessionToken.auth_method,
    };

    request.auth = withAuthMethod;
    return withAuthMethod;
  };
