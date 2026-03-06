import { isHexColor } from "./userColors";

export const SEMANTIC_COLOR_KEYS = [
  "primary",
  "secondary",
  "tertiary",
  "milestone",
  "task",
  "hierarchyLevel0",
  "hierarchyLevel1",
  "hierarchyLevel2",
  "hierarchyLevel3",
  "hierarchyLevel4",
  "scheduled",
  "deadline",
] as const;

export type SemanticColorKey = (typeof SEMANTIC_COLOR_KEYS)[number];

export type SemanticColorMap = Record<SemanticColorKey, string>;

export const DEFAULT_SEMANTIC_COLORS: SemanticColorMap = {
  primary: "#5b5bd6",
  secondary: "#29a383",
  tertiary: "#00a2c7",
  milestone: "#6e6ade",
  task: "#27b08b",
  hierarchyLevel0: "#6e6ade",
  hierarchyLevel1: "#27b08b",
  hierarchyLevel2: "#0090ff",
  hierarchyLevel3: "#f59e0b",
  hierarchyLevel4: "#e5484d",
  scheduled: "#0090ff",
  deadline: "#e5484d",
};

const CSS_VAR_BY_KEY: Record<SemanticColorKey, string> = {
  primary: "--color-primary",
  secondary: "--color-secondary",
  tertiary: "--color-tertiary",
  milestone: "--color-milestone",
  task: "--color-task",
  hierarchyLevel0: "--color-hierarchy-level-0",
  hierarchyLevel1: "--color-hierarchy-level-1",
  hierarchyLevel2: "--color-hierarchy-level-2",
  hierarchyLevel3: "--color-hierarchy-level-3",
  hierarchyLevel4: "--color-hierarchy-level-4",
  scheduled: "--color-scheduled",
  deadline: "--color-deadline",
};

export const normalizeSemanticColorMap = (value: unknown): SemanticColorMap => {
  const next: SemanticColorMap = { ...DEFAULT_SEMANTIC_COLORS };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return next;
  }
  const record = value as Record<string, unknown>;
  for (const key of SEMANTIC_COLOR_KEYS) {
    const raw = record[key];
    if (typeof raw !== "string") {
      continue;
    }
    const color = raw.trim().toLowerCase();
    if (!isHexColor(color)) {
      continue;
    }
    next[key] = color;
  }
  return next;
};

export const toSemanticColorCssVars = (colors: SemanticColorMap) => {
  const vars: Record<string, string> = {};
  for (const key of SEMANTIC_COLOR_KEYS) {
    vars[CSS_VAR_BY_KEY[key]] = colors[key];
  }
  return vars;
};

export const applySemanticColorVars = (
  target: HTMLElement,
  colors: SemanticColorMap
) => {
  const vars = toSemanticColorCssVars(colors);
  for (const [name, value] of Object.entries(vars)) {
    target.style.setProperty(name, value);
  }
};
