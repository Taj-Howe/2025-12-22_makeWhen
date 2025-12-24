export const ACCENT_OPTIONS = ["blue", "violet", "amber"] as const;
export const NEUTRAL_OPTIONS = ["gray", "mauve", "slate"] as const;
export const RADIUS_OPTIONS = [0, 4, 8, 10, 12, 16] as const;

export const DEFAULT_THEME = {
  version: 1,
  mode: "dark",
  accent: "violet",
  neutral: "mauve",
  radius: 10,
} as const;

export const isValidAccent = (value: unknown): value is string =>
  typeof value === "string" &&
  (ACCENT_OPTIONS as readonly string[]).includes(value);

export const isValidNeutral = (value: unknown): value is string =>
  typeof value === "string" &&
  (NEUTRAL_OPTIONS as readonly string[]).includes(value);

export const isValidRadius = (value: unknown): value is number =>
  typeof value === "number" &&
  (RADIUS_OPTIONS as readonly number[]).includes(value);
