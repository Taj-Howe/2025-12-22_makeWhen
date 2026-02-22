export const FONT_SOURCE_KEYS = [
  "ibmMono",
  "systemSans",
  "systemSerif",
  "custom1",
  "custom2",
] as const;

export type FontSourceKey = (typeof FONT_SOURCE_KEYS)[number];
export type CustomFontKey = "custom1" | "custom2";

export type CustomFontConfig = {
  label: string;
  family: string;
  url: string;
};

export type CustomFontMap = Record<CustomFontKey, CustomFontConfig>;

export type TypographySettings = {
  bodyFont: FontSourceKey;
  headingFont: FontSourceKey;
  bodySizePx: number;
  labelSizePx: number;
  titleSizePx: number;
  bodyWeight: number;
  headingWeight: number;
  customFonts: CustomFontMap;
};

export const DEFAULT_CUSTOM_FONTS: CustomFontMap = {
  custom1: {
    label: "Custom Font 1",
    family: "",
    url: "",
  },
  custom2: {
    label: "Custom Font 2",
    family: "",
    url: "",
  },
};

export const DEFAULT_TYPOGRAPHY_SETTINGS: TypographySettings = {
  bodyFont: "ibmMono",
  headingFont: "ibmMono",
  bodySizePx: 17,
  labelSizePx: 12,
  titleSizePx: 34,
  bodyWeight: 400,
  headingWeight: 600,
  customFonts: DEFAULT_CUSTOM_FONTS,
};

const PRESET_FONT_FAMILIES: Record<Exclude<FontSourceKey, CustomFontKey>, string> = {
  ibmMono:
    '"IBM Plex Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  systemSans:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  systemSerif:
    '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", Times, serif',
};

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const normalizeSource = (value: unknown, fallback: FontSourceKey): FontSourceKey => {
  if (typeof value !== "string") {
    return fallback;
  }
  return FONT_SOURCE_KEYS.includes(value as FontSourceKey)
    ? (value as FontSourceKey)
    : fallback;
};

const normalizeLabel = (value: unknown, fallback: string) => {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 40) : fallback;
};

const normalizeTextValue = (value: unknown) => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
};

const normalizeSizePx = (value: unknown, fallback: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return clampNumber(Math.round(value), 10, 72);
};

const normalizeWeight = (value: unknown, fallback: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return clampNumber(Math.round(value), 300, 900);
};

const normalizeCustomFonts = (value: unknown): CustomFontMap => {
  const fallback = DEFAULT_CUSTOM_FONTS;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const next: CustomFontMap = {
    custom1: { ...fallback.custom1 },
    custom2: { ...fallback.custom2 },
  };
  for (const key of ["custom1", "custom2"] as const) {
    const raw = record[key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    next[key] = {
      label: normalizeLabel(entry.label, fallback[key].label),
      family: normalizeTextValue(entry.family),
      url: normalizeTextValue(entry.url),
    };
  }
  return next;
};

export const normalizeTypographySettings = (value: unknown): TypographySettings => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_TYPOGRAPHY_SETTINGS;
  }
  const record = value as Record<string, unknown>;
  return {
    bodyFont: normalizeSource(record.bodyFont, DEFAULT_TYPOGRAPHY_SETTINGS.bodyFont),
    headingFont: normalizeSource(
      record.headingFont,
      DEFAULT_TYPOGRAPHY_SETTINGS.headingFont
    ),
    bodySizePx: normalizeSizePx(
      record.bodySizePx,
      DEFAULT_TYPOGRAPHY_SETTINGS.bodySizePx
    ),
    labelSizePx: normalizeSizePx(
      record.labelSizePx,
      DEFAULT_TYPOGRAPHY_SETTINGS.labelSizePx
    ),
    titleSizePx: normalizeSizePx(
      record.titleSizePx,
      DEFAULT_TYPOGRAPHY_SETTINGS.titleSizePx
    ),
    bodyWeight: normalizeWeight(
      record.bodyWeight,
      DEFAULT_TYPOGRAPHY_SETTINGS.bodyWeight
    ),
    headingWeight: normalizeWeight(
      record.headingWeight,
      DEFAULT_TYPOGRAPHY_SETTINGS.headingWeight
    ),
    customFonts: normalizeCustomFonts(record.customFonts),
  };
};

export const resolveFontFamily = (
  source: FontSourceKey,
  customFonts: CustomFontMap
) => {
  if (source === "custom1" || source === "custom2") {
    const candidate = customFonts[source].family.trim();
    if (candidate.length > 0) {
      return candidate;
    }
    return PRESET_FONT_FAMILIES.ibmMono;
  }
  return PRESET_FONT_FAMILIES[source];
};

const applyCustomFontLinks = (customFonts: CustomFontMap) => {
  if (typeof document === "undefined") {
    return;
  }
  const head = document.head;
  const existing = new Map<string, HTMLLinkElement>();
  head
    .querySelectorAll<HTMLLinkElement>('link[data-ui-custom-font="true"]')
    .forEach((link) => {
      const key = link.dataset.customFontKey;
      if (key) {
        existing.set(key, link);
      }
    });

  for (const key of ["custom1", "custom2"] as const) {
    const href = customFonts[key].url.trim();
    const current = existing.get(key);
    if (!href) {
      current?.remove();
      continue;
    }
    if (current) {
      if (current.href !== href) {
        current.href = href;
      }
      continue;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.uiCustomFont = "true";
    link.dataset.customFontKey = key;
    head.appendChild(link);
  }
};

export const applyTypographySettings = (
  target: HTMLElement,
  settings: TypographySettings
) => {
  const bodyFamily = resolveFontFamily(settings.bodyFont, settings.customFonts);
  const headingFamily = resolveFontFamily(settings.headingFont, settings.customFonts);
  target.style.setProperty("--font-family-body", bodyFamily);
  target.style.setProperty("--font-family-heading", headingFamily);
  target.style.setProperty("--default-font-family", bodyFamily);
  target.style.setProperty("--font-size-body", `${settings.bodySizePx}px`);
  target.style.setProperty("--font-size-label", `${settings.labelSizePx}px`);
  target.style.setProperty("--font-size-title", `${settings.titleSizePx}px`);
  target.style.setProperty("--font-size-base", `${settings.bodySizePx}px`);
  target.style.setProperty("--font-weight-body", String(settings.bodyWeight));
  target.style.setProperty("--font-weight-heading", String(settings.headingWeight));
  applyCustomFontLinks(settings.customFonts);
};
