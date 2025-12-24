import type { Theme } from "./themeTypes";

export const applyTheme = (theme: Theme) => {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  root.dataset.mode = theme.mode;
  root.dataset.accent = theme.accent;
  root.dataset.neutral = theme.neutral;
  root.dataset.theme = theme.mode;
  root.classList.toggle("dark", theme.mode === "dark");
  root.classList.toggle("light", theme.mode === "light");
  root.style.setProperty("--radius", `${theme.radius}px`);
};
