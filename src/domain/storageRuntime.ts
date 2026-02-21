export const STORAGE_BACKEND_ENV_KEY = "VITE_STORAGE_BACKEND";

export type StorageBackendPreference = "opfs" | "opfs-strict" | "memory";

export const DEFAULT_STORAGE_BACKEND_PREFERENCE: StorageBackendPreference =
  "opfs";

export const normalizeStorageBackendPreference = (
  value: unknown
): StorageBackendPreference => {
  if (typeof value !== "string") {
    return DEFAULT_STORAGE_BACKEND_PREFERENCE;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "opfs" ||
    normalized === "opfs-strict" ||
    normalized === "memory"
  ) {
    return normalized;
  }
  return DEFAULT_STORAGE_BACKEND_PREFERENCE;
};

export const isPersistentBackend = (
  backend: "sqlite-opfs" | "sqlite-memory"
) => backend === "sqlite-opfs";
