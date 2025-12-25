export type ParseContext = {
  now: Date;
  timezone: string;
  defaultProjectId?: string;
};

export type ParseError = {
  code: string;
  message: string;
};

export type ParsedCommand = {
  action: "create" | "edit" | "archive";
  type: "project" | "milestone" | "task" | "subtask";
  title: string;
  id?: string;
  parent_id?: string;
  project_id?: string;
  assignees?: string[];
  status: "backlog" | "ready" | "in_progress" | "blocked" | "review" | "done" | "canceled";
  priority: number;
  due_at?: string;
  scheduled_for?: string;
  scheduled_duration_minutes?: number;
  estimate_mode: "manual";
  estimate_minutes: number;
  tags: string[];
  depends_on: string[];
  notes?: string;
  health: "on_track" | "at_risk" | "behind" | "ahead" | "unknown";
  health_mode: "auto" | "manual";
};

const allowedKeys = new Set([
  "id",
  "in",
  "under",
  "assignee",
  "status",
  "pri",
  "due",
  "sched",
  "est",
  "tags",
  "dep",
  "notes",
  "health",
]);

const statusValues = new Set([
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "done",
  "canceled",
]);

const healthValues = new Set([
  "on_track",
  "at_risk",
  "behind",
  "ahead",
  "unknown",
]);

const weekdayMap: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

type Token = {
  raw: string;
};

const createError = (code: string, message: string): { ok: false; error: ParseError } => ({
  ok: false,
  error: { code, message },
});

const isWhitespace = (char: string) => /\s/.test(char);

const tokenize = (input: string): { ok: true; tokens: Token[] } | { ok: false; error: ParseError } => {
  const tokens: Token[] = [];
  let current = "";
  let inQuote = false;
  let escape = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (inQuote && char === "\\") {
      current += char;
      escape = true;
      continue;
    }
    if (char === '"') {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (!inQuote && isWhitespace(char)) {
      if (current) {
        tokens.push({ raw: current });
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escape || inQuote) {
    return createError("UNCLOSED_QUOTE", "unterminated quoted string");
  }
  if (current) {
    tokens.push({ raw: current });
  }
  return { ok: true, tokens };
};

const unescapeQuoted = (value: string): { ok: true; value: string } | { ok: false; error: ParseError } => {
  let out = "";
  let escape = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (escape) {
      if (char === "\\" || char === '"' || char === "'") {
        out += char;
      } else if (char === "n") {
        out += "\n";
      } else if (char === "t") {
        out += "\t";
      } else {
        return createError("INVALID_ESCAPE", `invalid escape sequence: \\${char}`);
      }
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      return createError("INVALID_QUOTE", "unexpected quote inside value");
    }
    out += char;
  }
  if (escape) {
    return createError("INVALID_ESCAPE", "unterminated escape sequence");
  }
  return { ok: true, value: out };
};

const parseQuotedToken = (raw: string): { ok: true; value: string } | { ok: false; error: ParseError } => {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
    return createError("INVALID_QUOTED", "value must be quoted");
  }
  const inner = raw.slice(1, -1);
  return unescapeQuoted(inner);
};

const parseValue = (raw: string): { ok: true; value: string } | { ok: false; error: ParseError } => {
  if (!raw) {
    return createError("MISSING_VALUE", "missing value");
  }
  if (raw[0] === '"') {
    return parseQuotedToken(raw);
  }
  if (raw.includes('"')) {
    return createError("INVALID_QUOTED", "value must be quoted");
  }
  return { ok: true, value: raw };
};

const parseInteger = (raw: string, name: string): number | null => {
  if (!/^-?\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
};

const createDate = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  ctx: ParseContext
) => {
  if (ctx.timezone === "UTC") {
    return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  }
  return new Date(year, month - 1, day, hour, minute, 0, 0);
};

const matchesParts = (
  date: Date,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  ctx: ParseContext
) => {
  if (ctx.timezone === "UTC") {
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() + 1 === month &&
      date.getUTCDate() === day &&
      date.getUTCHours() === hour &&
      date.getUTCMinutes() === minute
    );
  }
  return (
    date.getFullYear() === year &&
    date.getMonth() + 1 === month &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
  );
};

const startOfDay = (date: Date, ctx: ParseContext) => {
  if (ctx.timezone === "UTC") {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
};

const parseDateShorthand = (
  raw: string,
  ctx: ParseContext
): { ok: true; value: Date } | { ok: false; error: ParseError } => {
  const lower = raw.toLowerCase();
  const now = ctx.now;
  if (lower === "today") {
    return { ok: true, value: startOfDay(now, ctx) };
  }
  if (lower === "tomorrow") {
    const base = startOfDay(now, ctx);
    const next = new Date(base.getTime() + 24 * 60 * 60 * 1000);
    return { ok: true, value: next };
  }
  if (weekdayMap[lower] !== undefined) {
    const target = weekdayMap[lower];
    const current = ctx.timezone === "UTC" ? now.getUTCDay() : now.getDay();
    const delta = (target - current + 7) % 7;
    const base = startOfDay(now, ctx);
    const next = new Date(base.getTime() + delta * 24 * 60 * 60 * 1000);
    return { ok: true, value: next };
  }
  return createError("INVALID_DATE", `invalid due value: ${raw}`);
};

const parseIsoDate = (
  raw: string,
  ctx: ParseContext
): { ok: true; value: Date } | { ok: false; error: ParseError } => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split("-").map(Number);
    const date = createDate(year, month, day, 0, 0, ctx);
    if (!matchesParts(date, year, month, day, 0, 0, ctx)) {
      return createError("INVALID_DATE", `invalid due value: ${raw}`);
    }
    return { ok: true, value: date };
  }
  if (ctx.timezone === "UTC" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
    const [datePart, timePart] = raw.split("T");
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute] = timePart.split(":").map(Number);
    const date = createDate(year, month, day, hour, minute, ctx);
    if (!matchesParts(date, year, month, day, hour, minute, ctx)) {
      return createError("INVALID_DATE", `invalid due value: ${raw}`);
    }
    return { ok: true, value: date };
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return createError("INVALID_DATE", `invalid due value: ${raw}`);
  }
  return { ok: true, value: date };
};

const parseDue = (raw: string, ctx: ParseContext) => {
  if (raw.includes(" ")) {
    return createError("INVALID_DATE", `invalid due value: ${raw}`);
  }
  const lower = raw.toLowerCase();
  if (lower === "today" || lower === "tomorrow" || weekdayMap[lower] !== undefined) {
    return parseDateShorthand(lower, ctx);
  }
  return parseIsoDate(raw, ctx);
};

const parseTime = (raw: string): { ok: true; hour: number; minute: number } | { ok: false; error: ParseError } => {
  const lower = raw.toLowerCase();
  const ampm = lower.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = ampm[2] ? Number(ampm[2]) : 0;
    const meridiem = ampm[3];
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
      return createError("INVALID_TIME", `invalid time: ${raw}`);
    }
    if (meridiem === "am") {
      if (hour === 12) {
        hour = 0;
      }
    } else if (hour !== 12) {
      hour += 12;
    }
    return { ok: true, hour, minute };
  }
  const twentyFour = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return createError("INVALID_TIME", `invalid time: ${raw}`);
    }
    return { ok: true, hour, minute };
  }
  return createError("INVALID_TIME", `invalid time: ${raw}`);
};

const parseSched = (
  raw: string,
  ctx: ParseContext
): { ok: true; at: Date; duration: number } | { ok: false; error: ParseError } => {
  const slashIndex = raw.lastIndexOf("/");
  if (slashIndex === -1) {
    return createError("INVALID_SCHED", `invalid sched value: ${raw}`);
  }
  const datePart = raw.slice(0, slashIndex).trim();
  const durationPart = raw.slice(slashIndex + 1).trim();
  const duration = parseInteger(durationPart, "duration");
  if (duration === null || duration <= 0) {
    return createError("INVALID_SCHED", `invalid sched duration: ${durationPart}`);
  }

  if (datePart.includes("T")) {
    const parsed = parseIsoDate(datePart, ctx);
    if (!parsed.ok) {
      return createError("INVALID_SCHED", `invalid sched datetime: ${datePart}`);
    }
    return { ok: true, at: parsed.value, duration };
  }

  const parts = datePart.split(" ").filter(Boolean);
  if (parts.length === 1) {
    const parsed = parseDateShorthand(parts[0], ctx);
    if (!parsed.ok) {
      return createError("INVALID_SCHED", `invalid sched datetime: ${datePart}`);
    }
    return { ok: true, at: parsed.value, duration };
  }
  if (parts.length === 2) {
    const dateToken = parts[0];
    const timeToken = parts[1];
    const dateParsed =
      dateToken.toLowerCase() === "today" ||
      dateToken.toLowerCase() === "tomorrow" ||
      weekdayMap[dateToken.toLowerCase()] !== undefined
        ? parseDateShorthand(dateToken, ctx)
        : parseIsoDate(dateToken, ctx);
    if (!dateParsed.ok) {
      return createError("INVALID_SCHED", `invalid sched datetime: ${datePart}`);
    }
    const timeParsed = parseTime(timeToken);
    if (!timeParsed.ok) {
      return createError("INVALID_SCHED", `invalid sched datetime: ${datePart}`);
    }
    const base = dateParsed.value;
    const day =
      ctx.timezone === "UTC"
        ? base.getUTCDate()
        : base.getDate();
    const month =
      ctx.timezone === "UTC"
        ? base.getUTCMonth() + 1
        : base.getMonth() + 1;
    const year =
      ctx.timezone === "UTC"
        ? base.getUTCFullYear()
        : base.getFullYear();
    const at = createDate(year, month, day, timeParsed.hour, timeParsed.minute, ctx);
    return { ok: true, at, duration };
  }

  return createError("INVALID_SCHED", `invalid sched datetime: ${datePart}`);
};

export const parseCommand = (
  input: string,
  ctx: ParseContext
): { ok: true; value: ParsedCommand } | { ok: false; error: ParseError } => {
  const trimmed = input.trim();
  if (!trimmed) {
    return createError("EMPTY_INPUT", "input is empty");
  }
  const tokenResult = tokenize(trimmed);
  if (!tokenResult.ok) {
    return tokenResult;
  }
  const tokens = tokenResult.tokens.map((token) => token.raw);
  if (tokens.length < 3) {
    return createError("MISSING_TITLE", "title must be quoted");
  }

  const actionToken = tokens[0];
  if (!["create", "edit", "archive"].includes(actionToken)) {
    return createError("INVALID_ACTION", `invalid action: ${actionToken}`);
  }

  const typeToken = tokens[1];
  if (!["project", "milestone", "task", "subtask"].includes(typeToken)) {
    return createError("INVALID_TYPE", `invalid item type: ${typeToken}`);
  }

  const titleToken = tokens[2];
  const titleParsed = parseQuotedToken(titleToken);
  if (!titleParsed.ok) {
    return createError("MISSING_TITLE", "title must be quoted");
  }

  const values: Record<string, string> = {};
  let previousKey: string | null = null;
  for (let i = 3; i < tokens.length; i += 1) {
    const token = tokens[i];
    const colonIndex = token.indexOf(":");
    if (colonIndex === -1) {
      if (previousKey === "sched") {
        return createError(
          "INVALID_SCHED",
          "sched value with spaces must be quoted"
        );
      }
      return createError("EXPECTED_KV", `expected key:value pair, got "${token}"`);
    }
    const key = token.slice(0, colonIndex);
    const rawValue = token.slice(colonIndex + 1);
    if (!allowedKeys.has(key)) {
      return createError("UNKNOWN_KEY", `unknown key: ${key}`);
    }
    if (values[key] !== undefined) {
      return createError("DUPLICATE_KEY", `duplicate key: ${key}`);
    }
    const valueParsed = parseValue(rawValue);
    if (!valueParsed.ok) {
      return createError(valueParsed.error.code, valueParsed.error.message);
    }
    if (!valueParsed.value) {
      return createError("MISSING_VALUE", `missing value for key: ${key}`);
    }
    values[key] = valueParsed.value;
    previousKey = key;
  }

  const status = values.status ?? "backlog";
  if (!statusValues.has(status)) {
    return createError("INVALID_STATUS", `invalid status: ${status}`);
  }

  const priorityRaw = values.pri ?? "0";
  const priority = parseInteger(priorityRaw, "pri");
  if (priority === null || priority < 0 || priority > 5) {
    return createError("INVALID_PRIORITY", "priority must be 0-5");
  }

  let dueAt: string | undefined;
  if (values.due) {
    const dueParsed = parseDue(values.due, ctx);
    if (!dueParsed.ok) {
      return createError("INVALID_DUE", dueParsed.error.message);
    }
    dueAt = dueParsed.value.toISOString();
  }

  let scheduledFor: string | undefined;
  let scheduledDuration: number | undefined;
  if (values.sched) {
    const schedParsed = parseSched(values.sched, ctx);
    if (!schedParsed.ok) {
      return createError("INVALID_SCHED", schedParsed.error.message);
    }
    scheduledFor = schedParsed.at.toISOString();
    scheduledDuration = schedParsed.duration;
  }

  const estimateRaw = values.est ?? "0";
  const estimate = parseInteger(estimateRaw, "est");
  if (estimate === null || estimate < 0) {
    return createError("INVALID_ESTIMATE", `invalid estimate: ${estimateRaw}`);
  }

  const tags = values.tags
    ? Array.from(
        new Set(
          values.tags
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        )
      )
    : [];

  const dependsOn = values.dep
    ? Array.from(
        new Set(
          values.dep
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        )
      )
    : [];
  if (values.dep && dependsOn.length === 0) {
    return createError("INVALID_DEP", "dep list must contain at least one id");
  }

  const health = values.health ?? "unknown";
  if (!healthValues.has(health)) {
    return createError("INVALID_HEALTH", `invalid health: ${health}`);
  }
  const healthMode = values.health ? "manual" : "auto";

  const projectId = values.in ?? ctx.defaultProjectId;
  const parentId = values.under;

  if (typeToken !== "project" && !projectId && !parentId) {
    return createError(
      "MISSING_PROJECT",
      "missing project context for non-project item"
    );
  }

  const assignees = values.assignee ? [values.assignee] : undefined;

  const result: ParsedCommand = {
    action: actionToken as ParsedCommand["action"],
    type: typeToken as ParsedCommand["type"],
    title: titleParsed.value,
    status: status as ParsedCommand["status"],
    priority,
    estimate_mode: "manual",
    estimate_minutes: estimate,
    tags,
    depends_on: dependsOn,
    health: health as ParsedCommand["health"],
    health_mode: healthMode as ParsedCommand["health_mode"],
  };

  if (values.id) {
    result.id = values.id;
  }
  if (projectId) {
    result.project_id = projectId;
  }
  if (parentId) {
    result.parent_id = parentId;
  }
  if (assignees) {
    result.assignees = assignees;
  }
  if (values.notes) {
    result.notes = values.notes;
  }
  if (dueAt) {
    result.due_at = dueAt;
  }
  if (scheduledFor) {
    result.scheduled_for = scheduledFor;
  }
  if (scheduledDuration !== undefined) {
    result.scheduled_duration_minutes = scheduledDuration;
  }

  return { ok: true, value: result };
};
