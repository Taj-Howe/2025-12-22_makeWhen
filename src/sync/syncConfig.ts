export type SyncMode = "mock" | "remote";

export type SyncRuntimeConfig = {
  mode: SyncMode;
  remoteBaseUrl: string;
};

const readString = (value: unknown): string => {
  return typeof value === "string" ? value.trim() : "";
};

const readMode = (raw: string): SyncMode => {
  return raw.toLowerCase() === "remote" ? "remote" : "mock";
};

export const getSyncRuntimeConfig = (): SyncRuntimeConfig => {
  const env = (import.meta.env ?? {}) as Record<string, unknown>;
  const rawMode =
    readString(env.SYNC_MODE) || readString(env.VITE_SYNC_MODE) || "mock";
  const remoteBaseUrl =
    readString(env.SYNC_REMOTE_BASE_URL) ||
    readString(env.VITE_SYNC_REMOTE_BASE_URL);

  return {
    mode: readMode(rawMode),
    remoteBaseUrl,
  };
};

export const SYNC_RUNTIME_CONFIG: SyncRuntimeConfig = getSyncRuntimeConfig();
export const SYNC_MODE: SyncMode = SYNC_RUNTIME_CONFIG.mode;
export const SYNC_REMOTE_BASE_URL: string = SYNC_RUNTIME_CONFIG.remoteBaseUrl;
