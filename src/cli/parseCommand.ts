import { parseEstimateMinutesInput } from "../domain/formatters";

export type ParsedCommand = {
  verb:
    | "create"
    | "edit"
    | "delete"
    | "schedule"
    | "archive"
    | "restore"
    | "open";
  type: "project" | "milestone" | "task" | "subtask";
  title?: string;
  target?: string;
  id?: string;
  openProject?: string;
  openView?: "list" | "calendar" | "kanban" | "gantt" | "dashboard";
  parentId?: string;
  inProject?: string;
  dueAt?: number;
  scheduledFor?: number;
  scheduledDurationMinutes?: number;
  priority?: number;
  status?: string;
  tags?: string[];
  dependsOn?: string[];
  depType?: "FS" | "SS" | "FF" | "SF";
  depLagMinutes?: number;
  assignees?: string[];
  notes?: string;
  estimateMode?: "manual" | "rollup";
  estimateMinutes?: number;
  health?: "on_track" | "at_risk" | "behind" | "ahead" | "unknown";
  healthMode?: "auto" | "manual";
  blockerTexts?: string[];
  blockerKind?: string;
};

type ParseError = {
  message: string;
};

type ParseResult =
  | { ok: true; value: ParsedCommand }
  | { ok: false; error: ParseError };

const VERBS = new Set([
  "create",
  "edit",
  "delete",
  "schedule",
  "archive",
  "restore",
  "open",
]);
const TYPES = new Set(["project", "milestone", "task", "subtask"]);
const VIEW_NAMES = new Set(["list", "calendar", "kanban", "gantt", "dashboard"]);
const KEYS = new Set([
  "title",
  "parent",
  "under",
  "in",
  "id",
  "due",
  "due_at",
  "start",
  "start_at",
  "scheduled_for",
  "duration",
  "duration_minutes",
  "dur",
  "priority",
  "pri",
  "tags",
  "dep",
  "depends_on",
  "dep_type",
  "dep_lag",
  "lag",
  "status",
  "assignee",
  "assignees",
  "notes",
  "estimate_mode",
  "estimate_minutes",
  "health",
  "health_mode",
  "blocker",
  "blockers",
  "blocker_kind",
]);

export const parseCommand = (input: string): ParseResult => {
  const tokensResult = tokenize(input);
  if (!tokensResult.ok) {
    return tokensResult;
  }
  const tokens = tokensResult.value;
  if (tokens.length === 0) {
    return { ok: false, error: { message: "Command is empty" } };
  }
  let index = 0;
  let verb = "create";
  let rawToken = tokens[index].toLowerCase();
  if (VERBS.has(rawToken)) {
    verb = rawToken;
    index += 1;
    rawToken = tokens[index]?.toLowerCase();
  }
  if (verb === "open") {
    const remaining = tokens.slice(index);
    if (remaining.length === 0) {
      return {
        ok: false,
        error: { message: "open requires a project name or view" },
      };
    }
    const hasKeyValue = remaining.some((token) => parseKeyValue(token));
    if (hasKeyValue) {
      return {
        ok: false,
        error: { message: "open does not accept key:value tokens" },
      };
    }
    let openProject: string | undefined;
    let openView: ParsedCommand["openView"];
    const first = remaining[0].toLowerCase();
    const second = remaining[1]?.toLowerCase();
    if (VIEW_NAMES.has(first)) {
      openView = first as ParsedCommand["openView"];
    } else {
      openProject = remaining[0];
    }
    if (second) {
      if (!VIEW_NAMES.has(second)) {
        return {
          ok: false,
          error: {
            message:
              "open accepts a project name and optional view (list/calendar/kanban/gantt/dashboard)",
          },
        };
      }
      openView = second as ParsedCommand["openView"];
    }
    return {
      ok: true,
      value: {
        verb: "open",
        type: "task",
        openProject,
        openView,
      },
    };
  }
  if (!rawToken || !TYPES.has(rawToken)) {
    return {
      ok: false,
      error: { message: "Missing or invalid item type" },
    };
  }
  const type = rawToken as ParsedCommand["type"];
  index += 1;

  let titleFromKey: string | null = null;
  const titleParts: string[] = [];
  let sawKey = false;
  let parentId: string | undefined;
  let inProject: string | undefined;
  let id: string | undefined;
  let dueAt: number | undefined;
  let scheduledFor: number | undefined;
  let scheduledDurationMinutes: number | undefined;
  let priority: number | undefined;
  let status: string | undefined;
  let tags: string[] | undefined;
  let dependsOn: string[] | undefined;
  let depType: ParsedCommand["depType"];
  let depLagMinutes: number | undefined;
  let assignees: string[] | undefined;
  let notes: string | undefined;
  let estimateMode: "manual" | "rollup" | undefined;
  let estimateMinutes: number | undefined;
  let health: ParsedCommand["health"];
  let healthMode: ParsedCommand["healthMode"];
  let blockerTexts: string[] = [];
  let blockerKind: string | undefined;
  let target: string | undefined;

  if (verb !== "create") {
    const targetToken = tokens[index];
    const targetKey = targetToken ? parseKeyValue(targetToken) : null;
    if (targetKey && targetKey.key === "id") {
      id = targetKey.value;
      sawKey = true;
      index += 1;
    } else if (targetToken && !targetKey) {
      target = targetToken;
      index += 1;
    } else {
      return {
        ok: false,
        error: {
          message: "Edit/delete/schedule/archive/restore requires an id or quoted title",
        },
      };
    }
  }

  for (let i = index; i < tokens.length; i += 1) {
    const token = tokens[i];
    const tokenLower = token.toLowerCase();
    const nextToken = tokens[i + 1];
    const kv =
      tokenLower === "in" && nextToken && !parseKeyValue(nextToken)
        ? { key: "in", value: nextToken, consumedNext: true }
        : parseKeyValue(token, nextToken);
    if (kv) {
      const { key, value, consumedNext } = kv;
      if (!KEYS.has(key)) {
        return {
          ok: false,
          error: { message: `Unknown key: ${key}` },
        };
      }
      sawKey = true;
      if (consumedNext) {
        i += 1;
      }
      if (value === "") {
        return {
          ok: false,
          error: { message: `Missing value for ${key}:` },
        };
      }
      switch (key) {
        case "title": {
          if (titleFromKey || titleParts.length > 0) {
            return {
              ok: false,
              error: { message: "Title provided more than once" },
            };
          }
          titleFromKey = value;
          break;
        }
        case "parent":
        case "under": {
          if (parentId) {
            return {
              ok: false,
              error: { message: "Parent specified more than once" },
            };
          }
          parentId = value;
          break;
        }
        case "in": {
          if (inProject) {
            return {
              ok: false,
              error: { message: "in specified more than once" },
            };
          }
          inProject = value;
          break;
        }
        case "id": {
          if (id) {
            return {
              ok: false,
              error: { message: "id provided more than once" },
            };
          }
          id = value;
          break;
        }
        case "due":
        case "due_at": {
          const parsed = parseDate(value);
          if (parsed === null) {
            return { ok: false, error: { message: "Invalid due date" } };
          }
          dueAt = parsed;
          break;
        }
        case "start":
        case "start_at":
        case "scheduled_for": {
          const parsed = parseDate(value);
          if (parsed === null) {
            return {
              ok: false,
              error: { message: "Invalid start date" },
            };
          }
          scheduledFor = parsed;
          break;
        }
        case "duration":
        case "duration_minutes":
        case "dur": {
          const parsed = parseEstimateMinutesInput(value);
          if (parsed === null) {
            return {
              ok: false,
              error: { message: "duration must be minutes or hours" },
            };
          }
          scheduledDurationMinutes = parsed;
          break;
        }
        case "priority":
        case "pri": {
          const number = parseInt(value, 10);
          if (!Number.isFinite(number) || number < 0 || number > 5) {
            return { ok: false, error: { message: "pri must be 0-5" } };
          }
          priority = number;
          break;
        }
        case "status": {
          status = value;
          break;
        }
        case "tags": {
          tags = splitList(value);
          break;
        }
        case "depends_on":
        case "dep": {
          dependsOn = splitList(value);
          break;
        }
        case "dep_type": {
          const typeValue = value.toUpperCase();
          if (!["FS", "SS", "FF", "SF"].includes(typeValue)) {
            return {
              ok: false,
              error: { message: "dep_type must be FS, SS, FF, or SF" },
            };
          }
          depType = typeValue as ParsedCommand["depType"];
          break;
        }
        case "dep_lag":
        case "lag": {
          const parsed = parseEstimateMinutesInput(value);
          if (parsed === null || parsed < 0) {
            return { ok: false, error: { message: "lag must be >= 0 minutes" } };
          }
          depLagMinutes = parsed;
          break;
        }
        case "assignee":
        case "assignees": {
          assignees = splitList(value);
          break;
        }
        case "notes": {
          notes = value;
          break;
        }
        case "estimate_mode": {
          estimateMode = value === "rollup" ? "rollup" : "manual";
          break;
        }
        case "estimate_minutes": {
          const minutes = parseEstimateMinutesInput(value);
          if (minutes === null) {
            return {
              ok: false,
              error: { message: "estimate_minutes must be minutes or hours" },
            };
          }
          estimateMinutes = minutes;
          break;
        }
        case "health": {
          const normalized = value.toLowerCase();
          if (
            !["on_track", "at_risk", "behind", "ahead", "unknown"].includes(
              normalized
            )
          ) {
            return {
              ok: false,
              error: {
                message:
                  "health must be on_track, at_risk, behind, ahead, or unknown",
              },
            };
          }
          health = normalized as ParsedCommand["health"];
          break;
        }
        case "health_mode": {
          const normalized = value.toLowerCase();
          if (!["auto", "manual"].includes(normalized)) {
            return {
              ok: false,
              error: { message: "health_mode must be auto or manual" },
            };
          }
          healthMode = normalized as ParsedCommand["healthMode"];
          break;
        }
        case "blocker": {
          blockerTexts.push(value);
          break;
        }
        case "blockers": {
          blockerTexts = blockerTexts.concat(splitList(value));
          break;
        }
        case "blocker_kind": {
          if (blockerKind) {
            return {
              ok: false,
              error: { message: "blocker_kind provided more than once" },
            };
          }
          blockerKind = value;
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (sawKey) {
      return {
        ok: false,
        error: { message: `Unexpected token: ${token}` },
      };
    }
    titleParts.push(token);
  }

  const title = titleFromKey ?? titleParts.join(" ").trim();
  if (verb === "create") {
    if (!title) {
      return { ok: false, error: { message: "Title is required" } };
    }
    if (type === "subtask" && !parentId) {
      return {
        ok: false,
        error: { message: "subtask requires parent:<id> or under:<id>" },
      };
    }
  } else if (!id && !target) {
    return {
      ok: false,
      error: {
        message: "Edit/delete/schedule/archive/restore requires an id or quoted title",
      },
    };
  }

  return {
    ok: true,
    value: {
      verb: verb as ParsedCommand["verb"],
      type,
      title: title || undefined,
      target,
      id,
      parentId,
      inProject,
      dueAt,
      scheduledFor,
      scheduledDurationMinutes,
      priority,
      status,
      tags,
      dependsOn,
      depType,
      depLagMinutes,
      assignees,
      notes,
      estimateMode,
      estimateMinutes,
      health,
      healthMode,
      blockerTexts: blockerTexts.length > 0 ? blockerTexts : undefined,
      blockerKind,
    },
  };
};

const tokenize = (
  input: string
): { ok: true; value: string[] } | { ok: false; error: ParseError } => {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && inQuotes) {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (inQuotes) {
    return { ok: false, error: { message: "Unclosed quote" } };
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return { ok: true, value: tokens };
};

const parseKeyValue = (
  token: string,
  nextToken?: string
): { key: string; value: string; consumedNext: boolean } | null => {
  const colonIndex = token.indexOf(":");
  if (colonIndex === -1) {
    return null;
  }
  const key = token.slice(0, colonIndex).toLowerCase();
  const value = token.slice(colonIndex + 1);
  if (value !== "") {
    return { key, value, consumedNext: false };
  }
  if (nextToken !== undefined) {
    return { key, value: nextToken, consumedNext: true };
  }
  return { key, value: "", consumedNext: false };
};

const parseDate = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const noYearMatch = trimmed.match(
    /^(\d{1,2})[/-](\d{1,2})(?:[ T](.*))?$/
  );
  if (noYearMatch) {
    const [, month, day, timePart] = noYearMatch;
    const year = new Date().getFullYear();
    const datePart = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    const withTime = timePart ? `${datePart} ${timePart}` : datePart;
    const parsed = Date.parse(withTime);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
};

const splitList = (value: string): string[] => {
  const trimmed =
    value.startsWith("[") && value.endsWith("]")
      ? value.slice(1, -1)
      : value;
  const items = trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(items));
};
