export type ThemeMode = "light" | "dark";

export type Theme = {
  version: 1;
  mode: ThemeMode;
  accent: string;
  neutral: string;
  radius: number;
};
