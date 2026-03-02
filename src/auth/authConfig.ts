export type AuthMode = "local" | "clerk";

const readAuthMode = (): AuthMode => {
  const env = (import.meta.env ?? {}) as Record<string, unknown>;
  const raw =
    typeof env.AUTH_MODE === "string"
      ? env.AUTH_MODE
      : typeof env.VITE_AUTH_MODE === "string"
        ? env.VITE_AUTH_MODE
        : "local";
  return raw.trim().toLowerCase() === "clerk" ? "clerk" : "local";
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

export const AUTH_REMOTE_BASE_URL = readAuthRemoteBaseUrl();
const readClerkPublishableKey = (): string => {
  const env = (import.meta.env ?? {}) as Record<string, unknown>;
  return readString(env.VITE_CLERK_PUBLISHABLE_KEY);
};

export const CLERK_PUBLISHABLE_KEY = readClerkPublishableKey();
