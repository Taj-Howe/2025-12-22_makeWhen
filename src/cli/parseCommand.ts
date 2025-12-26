export type ParsedCommand = {
  type: "project" | "milestone" | "task";
  title: string;
  parentId?: string;
  dueAt?: number;
  scheduledFor?: number;
  priority?: number;
  tags?: string[];
  dependsOn?: string[];
};

type ParseError = {
  message: string;
};

type ParseResult =
  | { ok: true; value: ParsedCommand }
  | { ok: false; error: ParseError };

const COMMANDS = new Set(["project", "milestone", "task", "subtask"]);
const KEYS = new Set([
  "title",
  "parent",
  "under",
  "due",
  "scheduled_for",
  "pri",
  "tags",
  "dep",
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
  const rawCommand = tokens[0].toLowerCase();
  if (!COMMANDS.has(rawCommand)) {
    return {
      ok: false,
      error: { message: `Unknown command: ${tokens[0]}` },
    };
  }

  const type = rawCommand === "subtask" ? "task" : rawCommand;
  let titleFromKey: string | null = null;
  const titleParts: string[] = [];
  let sawKey = false;
  let parentId: string | undefined;
  let dueAt: number | undefined;
  let scheduledFor: number | undefined;
  let priority: number | undefined;
  let tags: string[] | undefined;
  let dependsOn: string[] | undefined;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    const kv = parseKeyValue(token, tokens[i + 1]);
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
        case "due": {
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
        case "pri": {
          const number = parseInt(value, 10);
          if (!Number.isFinite(number) || number < 0 || number > 5) {
            return { ok: false, error: { message: "pri must be 0-5" } };
          }
          priority = number;
          break;
        }
        case "tags": {
          tags = splitList(value);
          break;
        }
        case "dep": {
          dependsOn = splitList(value);
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
  if (!title) {
    return { ok: false, error: { message: "Title is required" } };
  }
  if (rawCommand === "subtask" && !parentId) {
    return {
      ok: false,
      error: { message: "subtask requires parent:<id> or under:<id>" },
    };
  }

  return {
    ok: true,
    value: {
      type,
      title,
      parentId,
      dueAt,
      scheduledFor,
      priority,
      tags,
      dependsOn,
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
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(items));
};
