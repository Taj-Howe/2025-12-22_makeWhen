import type { IncomingMessage } from "node:http";
import { ApiError } from "./errors.ts";
import { getHeaderString } from "../security/requestMeta.ts";

export const SESSION_COOKIE_NAME = "mw_session";
export const CSRF_COOKIE_NAME = "mw_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

export const SESSION_COOKIE_POLICY = {
  secure: true,
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
};

export type AuthMethod = "bearer" | "cookie";

export const parseCookies = (request: IncomingMessage) => {
  const header = request.headers.cookie;
  const result: Record<string, string> = {};
  if (typeof header !== "string" || header.trim().length === 0) {
    return result;
  }

  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (!rawKey) {
      continue;
    }
    const value = rest.join("=").trim();
    if (!value) {
      continue;
    }
    result[rawKey] = decodeURIComponent(value);
  }

  return result;
};

export const requireCsrfForCookieAuth = (
  request: IncomingMessage,
  authMethod: AuthMethod | undefined
) => {
  if (authMethod !== "cookie") {
    return;
  }

  const cookies = parseCookies(request);
  const csrfCookie = cookies[CSRF_COOKIE_NAME]?.trim() ?? "";
  const csrfHeader = (getHeaderString(request, CSRF_HEADER_NAME) ?? "").trim();

  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    throw new ApiError(
      403,
      "CSRF_INVALID",
      "Cookie-authenticated write requires matching CSRF cookie and header."
    );
  }
};
