export type AuthMode = "local" | "oauth";

const readAuthMode = (): AuthMode => {
  const env = (import.meta.env ?? {}) as Record<string, unknown>;
  const raw =
    typeof env.AUTH_MODE === "string"
      ? env.AUTH_MODE
      : typeof env.VITE_AUTH_MODE === "string"
        ? env.VITE_AUTH_MODE
        : "local";
  return raw.trim().toLowerCase() === "oauth" ? "oauth" : "local";
};

export const AUTH_MODE: AuthMode = readAuthMode();

const readString = (value: unknown): string => {
  return typeof value === "string" ? value.trim() : "";
};

const readAuthRemoteBaseUrl = (): string => {
  const env = (import.meta.env ?? {}) as Record<string, unknown>;
  return (
    readString(env.AUTH_REMOTE_BASE_URL) ||
    readString(env.VITE_AUTH_REMOTE_BASE_URL) ||
    readString(env.SYNC_REMOTE_BASE_URL) ||
    readString(env.VITE_SYNC_REMOTE_BASE_URL)
  );
};

const readOAuthCallbackPath = (): string => {
  const env = (import.meta.env ?? {}) as Record<string, unknown>;
  const raw =
    readString(env.AUTH_OAUTH_CALLBACK_PATH) ||
    readString(env.VITE_AUTH_OAUTH_CALLBACK_PATH) ||
    "/auth/callback";
  if (!raw.startsWith("/")) {
    return `/${raw}`;
  }
  return raw;
};

export const AUTH_REMOTE_BASE_URL = readAuthRemoteBaseUrl();
export const AUTH_OAUTH_CALLBACK_PATH = readOAuthCallbackPath();
