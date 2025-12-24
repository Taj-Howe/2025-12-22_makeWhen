import type { Theme } from "./themeTypes";
import {
  ACCENT_OPTIONS,
  DEFAULT_THEME,
  NEUTRAL_OPTIONS,
  RADIUS_OPTIONS,
} from "./themeRegistry";

const STORAGE_KEY = "makewhen.theme.v1";

const normalizeTheme = (value: unknown): Theme => {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_THEME };
  }
  const record = value as Record<string, unknown>;
  const version = record.version === 1 ? 1 : DEFAULT_THEME.version;
  const mode = record.mode === "light" ? "light" : "dark";
  const accent =
    typeof record.accent === "string" &&
    (ACCENT_OPTIONS as readonly string[]).includes(record.accent)
      ? record.accent
      : DEFAULT_THEME.accent;
  const neutral =
    typeof record.neutral === "string" &&
    (NEUTRAL_OPTIONS as readonly string[]).includes(record.neutral)
      ? record.neutral
      : DEFAULT_THEME.neutral;
  const radius =
    typeof record.radius === "number" &&
    (RADIUS_OPTIONS as readonly number[]).includes(record.radius)
      ? record.radius
      : DEFAULT_THEME.radius;
  return { version, mode, accent, neutral, radius };
};

export const loadTheme = (): Theme => {
  if (typeof window === "undefined") {
    return { ...DEFAULT_THEME };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_THEME };
    }
    return normalizeTheme(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_THEME };
  }
};

export const saveTheme = (theme: Theme) => {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // ignore storage errors
  }
};
