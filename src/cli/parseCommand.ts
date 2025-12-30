export type ParsedCommand = {
  verb: "create" | "edit" | "delete";
  type: "project" | "milestone" | "task" | "subtask";
  title?: string;
  target?: string;
  id?: string;
  parentId?: string;
  inProject?: string;
  dueAt?: number;
  scheduledFor?: number;
  priority?: number;
  status?: string;
  tags?: string[];
  dependsOn?: string[];
  assignees?: string[];
  notes?: string;
  estimateMode?: "manual" | "rollup";
  estimateMinutes?: number;
};

type ParseError = {
  message: string;
};

type ParseResult =
  | { ok: true; value: ParsedCommand }
  | { ok: false; error: ParseError };

const VERBS = new Set(["create", "edit", "delete"]);
const TYPES = new Set(["project", "milestone", "task", "subtask"]);
const KEYS = new Set([
  "title",
  "parent",
  "under",
  "in",
  "id",
  "due",
  "due_at",
  "scheduled_for",
  "priority",
  "pri",
  "tags",
  "dep",
  "depends_on",
  "status",
  "assignees",
  "notes",
  "estimate_mode",
  "estimate_minutes",
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
  let priority: number | undefined;
  let status: string | undefined;
  let tags: string[] | undefined;
  let dependsOn: string[] | undefined;
  let assignees: string[] | undefined;
  let notes: string | undefined;
  let estimateMode: "manual" | "rollup" | undefined;
  let estimateMinutes: number | undefined;
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
        error: { message: "Edit/delete requires an id or quoted title" },
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
        case "scheduled_for": {
          const parsed = parseDate(value);
          if (parsed === null) {
            return {
              ok: false,
              error: { message: "Invalid scheduled_for date" },
            };
          }
          scheduledFor = parsed;
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
          const minutes = Number(value);
          if (!Number.isFinite(minutes)) {
            return { ok: false, error: { message: "estimate_minutes must be a number" } };
          }
          estimateMinutes = minutes;
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
      error: { message: "Edit/delete requires an id or quoted title" },
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
      priority,
      status,
      tags,
      dependsOn,
      assignees,
      notes,
      estimateMode,
      estimateMinutes,
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
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
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
