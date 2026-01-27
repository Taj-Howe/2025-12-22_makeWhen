export type ThemeName = "light" | "dark" | "amber";

const STORAGE_KEY = "makewhen.theme";
const DEFAULT_THEME: ThemeName = "light";
const listeners = new Set<(theme: ThemeName) => void>();

export const loadTheme = (): ThemeName => {
  if (typeof window === "undefined") {
    return DEFAULT_THEME;
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "amber") {
    return stored;
  }
  return DEFAULT_THEME;
};

export const applyTheme = (theme: ThemeName) => {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.dataset.theme = theme;
};

export const saveTheme = (theme: ThemeName) => {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, theme);
};

export const setTheme = (theme: ThemeName) => {
  applyTheme(theme);
  saveTheme(theme);
  listeners.forEach((listener) => listener(theme));
};

export const initTheme = () => {
  const theme = loadTheme();
  applyTheme(theme);
  return theme;
};

export const subscribeTheme = (listener: (theme: ThemeName) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
