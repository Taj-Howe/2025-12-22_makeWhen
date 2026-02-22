import { isHexColor } from "./userColors";

export const THEME_TOKEN_KEYS = [
  "bg",
  "panel",
  "panel2",
  "text",
  "muted",
  "border",
  "borderHover",
  "accent",
  "accentText",
  "accentBorder",
  "danger",
  "warning",
  "success",
  "glassBg",
  "glassBorder",
  "glassHighlight",
  "overlayScrim",
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];

export type ThemeTokenMap = Record<ThemeTokenKey, string>;
export type ThemeTokenOverrides = Partial<ThemeTokenMap>;

export const DEFAULT_THEME_TOKENS: ThemeTokenMap = {
  bg: "#f8f8fa",
  panel: "#f2f2f5",
  panel2: "#ebebef",
  text: "#1f1f23",
  muted: "#6f6f7b",
  border: "#c9c9d1",
  borderHover: "#afafb9",
  accent: "#7b7b88",
  accentText: "#5f5f6d",
  accentBorder: "#9a9aa5",
  danger: "#b85656",
  warning: "#f59e0b",
  success: "#34d399",
  glassBg: "#f3f3f6",
  glassBorder: "#c8c8d0",
  glassHighlight: "#b5b5bf",
  overlayScrim: "#efeff3",
};

const CSS_VAR_BY_KEY: Record<ThemeTokenKey, string> = {
  bg: "--color-bg",
  panel: "--color-panel",
  panel2: "--color-panel-2",
  text: "--color-text",
  muted: "--color-muted",
  border: "--color-border",
  borderHover: "--color-border-hover",
  accent: "--color-accent",
  accentText: "--color-accent-text",
  accentBorder: "--color-accent-border",
  danger: "--color-danger",
  warning: "--color-warning",
  success: "--color-success",
  glassBg: "--color-glass-bg",
  glassBorder: "--color-glass-border",
  glassHighlight: "--color-glass-highlight",
  overlayScrim: "--color-overlay-scrim",
};

const EXTRA_THEME_VARS = ["--color-text-muted", "--color-muted-text"] as const;

export const normalizeThemeTokenOverrides = (
  value: unknown
): ThemeTokenOverrides => {
  const next: ThemeTokenOverrides = {};
  let validKeyCount = 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return next;
  }
  const record = value as Record<string, unknown>;
  for (const key of THEME_TOKEN_KEYS) {
    const raw = record[key];
    if (typeof raw !== "string") {
      continue;
    }
    const color = raw.trim().toLowerCase();
    if (!isHexColor(color)) {
      continue;
    }
    next[key] = color;
    validKeyCount += 1;
  }

  // Backward-compat: older builds saved a full light default token map,
  // which should not override dark mode surfaces.
  if (validKeyCount === THEME_TOKEN_KEYS.length) {
    let matchesLegacyDefault = true;
    for (const key of THEME_TOKEN_KEYS) {
      if (next[key] !== DEFAULT_THEME_TOKENS[key]) {
        matchesLegacyDefault = false;
        break;
      }
    }
    if (matchesLegacyDefault) {
      return {};
    }
  }
  return next;
};

export const toThemeTokenCssVars = (tokens: ThemeTokenOverrides) => {
  const vars: Record<string, string> = {};
  for (const key of THEME_TOKEN_KEYS) {
    const value = tokens[key];
    if (!value) {
      continue;
    }
    vars[CSS_VAR_BY_KEY[key]] = value;
  }
  if (tokens.muted) {
    vars["--color-text-muted"] = tokens.muted;
    vars["--color-muted-text"] = tokens.muted;
  }
  return vars;
};

export const clearThemeTokenVars = (target: HTMLElement) => {
  for (const key of THEME_TOKEN_KEYS) {
    target.style.removeProperty(CSS_VAR_BY_KEY[key]);
  }
  for (const key of EXTRA_THEME_VARS) {
    target.style.removeProperty(key);
  }
};

export const applyThemeTokenVars = (
  target: HTMLElement,
  tokens: ThemeTokenOverrides
) => {
  const vars = toThemeTokenCssVars(tokens);
  for (const [name, value] of Object.entries(vars)) {
    target.style.setProperty(name, value);
  }
};

const clampByte = (value: number) =>
  Math.min(255, Math.max(0, Math.round(value)));

const byteToHex = (value: number) => clampByte(value).toString(16).padStart(2, "0");

const rgbToHex = (red: number, green: number, blue: number) =>
  `#${byteToHex(red)}${byteToHex(green)}${byteToHex(blue)}`;

const normalizeShortHex = (value: string) => {
  const short = value.slice(1);
  return `#${short[0]}${short[0]}${short[1]}${short[1]}${short[2]}${short[2]}`;
};

const cssColorToHex = (value: string): string | null => {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return normalized;
  }
  if (/^#[0-9a-f]{3}$/i.test(normalized)) {
    return normalizeShortHex(normalized);
  }

  const rgbMatch = normalized.match(
    /^rgba?\(\s*(\d{1,3})\s*(?:,|\s)\s*(\d{1,3})\s*(?:,|\s)\s*(\d{1,3})/
  );
  if (rgbMatch) {
    return rgbToHex(
      Number.parseInt(rgbMatch[1], 10),
      Number.parseInt(rgbMatch[2], 10),
      Number.parseInt(rgbMatch[3], 10)
    );
  }

  const srgbMatch = normalized.match(
    /^color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*[0-9.]+)?\)$/
  );
  if (srgbMatch) {
    return rgbToHex(
      Number.parseFloat(srgbMatch[1]) * 255,
      Number.parseFloat(srgbMatch[2]) * 255,
      Number.parseFloat(srgbMatch[3]) * 255
    );
  }

  return null;
};

export const readThemeTokensFromComputed = (target: HTMLElement): ThemeTokenMap => {
  const computed = getComputedStyle(target);
  const next: ThemeTokenMap = { ...DEFAULT_THEME_TOKENS };
  for (const key of THEME_TOKEN_KEYS) {
    const raw = computed.getPropertyValue(CSS_VAR_BY_KEY[key]).trim();
    const parsed = cssColorToHex(raw);
    if (parsed) {
      next[key] = parsed;
    }
  }
  return next;
};
