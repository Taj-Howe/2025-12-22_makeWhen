import { parseCommand, type ParsedCommand, type ParseError } from "./parseCommand";

const ctx = {
  now: new Date("2025-01-10T12:00:00Z"),
  timezone: "UTC",
  defaultProjectId: "proj_default",
};

type ValidCase = {
  input: string;
  expected: ParsedCommand;
};

type InvalidCase = {
  input: string;
  error: ParseError;
};

const validCases: ValidCase[] = [
  {
    input: 'create project "Personal Dashboard" due:today pri:2',
    expected: {
      action: "create",
      type: "project",
      title: "Personal Dashboard",
      status: "backlog",
      priority: 2,
      due_at: "2025-01-10T00:00:00.000Z",
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
  },
  {
    input: 'create milestone "MVP v1" in:proj_123 due:2025-01-15 est:0',
    expected: {
      action: "create",
      type: "milestone",
      title: "MVP v1",
      project_id: "proj_123",
      status: "backlog",
      priority: 0,
      due_at: "2025-01-15T00:00:00.000Z",
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
  },
  {
    input: 'create task "Draft onboarding copy" in:proj_123 under:ms_456 due:tomorrow est:90',
    expected: {
      action: "create",
      type: "task",
      title: "Draft onboarding copy",
      project_id: "proj_123",
      parent_id: "ms_456",
      status: "backlog",
      priority: 0,
      due_at: "2025-01-11T00:00:00.000Z",
      estimate_mode: "manual",
      estimate_minutes: 90,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
  },
  {
    input: 'create subtask "Write empty state" under:task_9 est:45',
    expected: {
      action: "create",
      type: "subtask",
      title: "Write empty state",
      parent_id: "task_9",
      project_id: "proj_default",
      status: "backlog",
      priority: 0,
      estimate_mode: "manual",
      estimate_minutes: 45,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
  },
  {
    input: 'create task "Calendar polish" in:"Personal Dashboard" status:ready pri:3',
    expected: {
      action: "create",
      type: "task",
      title: "Calendar polish",
      project_id: "Personal Dashboard",
      status: "ready",
      priority: 3,
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
  },
  {
    input: 'create task "Schedule team sync" in:proj_123 sched:2025-12-24T09:00/60',
    expected: {
      action: "create",
      type: "task",
      title: "Schedule team sync",
      project_id: "proj_123",
      status: "backlog",
      priority: 0,
      scheduled_for: "2025-12-24T09:00:00.000Z",
      scheduled_duration_minutes: 60,
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
  },
  {
    input: 'create task "Fix CI flake" in:proj_123 sched:"tomorrow 9am/60" est:60',
    expected: {
      action: "create",
      type: "task",
      title: "Fix CI flake",
      project_id: "proj_123",
      status: "backlog",
      priority: 0,
      scheduled_for: "2025-01-11T09:00:00.000Z",
      scheduled_duration_minutes: 60,
      estimate_mode: "manual",
      estimate_minutes: 60,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
  },
  {
    input: 'create task "Wire analytics" in:proj_123 tags:ops,backend,urgent',
    expected: {
      action: "create",
      type: "task",
      title: "Wire analytics",
      project_id: "proj_123",
      status: "backlog",
      priority: 0,
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: ["ops", "backend", "urgent"],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
  },
  {
    input: 'create task "Refactor tree" in:proj_123 dep:task_a,task_b',
    expected: {
      action: "create",
      type: "task",
      title: "Refactor tree",
      project_id: "proj_123",
      status: "backlog",
      priority: 0,
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: [],
      depends_on: ["task_a", "task_b"],
      health: "unknown",
      health_mode: "auto",
    },
  },
  {
    input: 'create milestone "Security pass" in:proj_123 notes:"Must include perf audit"',
    expected: {
      action: "create",
      type: "milestone",
      title: "Security pass",
      project_id: "proj_123",
      status: "backlog",
      priority: 0,
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: [],
      depends_on: [],
      notes: "Must include perf audit",
      health: "unknown",
      health_mode: "auto",
    },
  },
];

const invalidCases: InvalidCase[] = [
  {
    input: "create task Unquoted Title",
    error: { code: "MISSING_TITLE", message: "title must be quoted" },
  },
  {
    input: 'create task "Missing key colon" due today',
    error: { code: "EXPECTED_KV", message: 'expected key:value pair, got "due"' },
  },
  {
    input: 'create task "Bad key" foo:bar',
    error: { code: "UNKNOWN_KEY", message: "unknown key: foo" },
  },
  {
    input: 'create task "Bad status" status:working',
    error: { code: "INVALID_STATUS", message: "invalid status: working" },
  },
  {
    input: 'create task "Bad priority" pri:9',
    error: { code: "INVALID_PRIORITY", message: "priority must be 0-5" },
  },
  {
    input: 'create task "Bad due" due:yesterdayish',
    error: { code: "INVALID_DUE", message: "invalid due value: yesterdayish" },
  },
  {
    input: 'create task "Bad sched" sched:tomorrow 9am/60',
    error: {
      code: "INVALID_SCHED",
      message: "sched value with spaces must be quoted",
    },
  },
  {
    input: 'create task "Bad sched" sched:2025-13-01T09:00/60',
    error: {
      code: "INVALID_SCHED",
      message: "invalid sched datetime: 2025-13-01T09:00",
    },
  },
  {
    input: 'create task "Bad dep list" dep:""',
    error: { code: "INVALID_DEP", message: "dep list must contain at least one id" },
  },
  {
    input: 'create task "Missing project context" est:5',
    error: {
      code: "MISSING_PROJECT",
      message: "missing project context for non-project item",
    },
  },
  {
    input: 'task "Missing action" due:today',
    error: { code: "INVALID_ACTION", message: "invalid action: task" },
  },
];

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every((key) =>
      deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      )
    );
  }
  return false;
};

export const runParseCommandTests = () => {
  const failures: string[] = [];

  for (const test of validCases) {
    const result = parseCommand(test.input, ctx);
    if (!result.ok) {
      failures.push(`Expected ok for "${test.input}", got error ${result.error.code}`);
      continue;
    }
    if (!deepEqual(result.value, test.expected)) {
      failures.push(`Mismatch for "${test.input}"`);
    }
  }

  for (const test of invalidCases) {
    const result = parseCommand(test.input, ctx);
    if (result.ok) {
      failures.push(`Expected error for "${test.input}", got ok`);
      continue;
    }
    if (
      result.error.code !== test.error.code ||
      result.error.message !== test.error.message
    ) {
      failures.push(
        `Error mismatch for "${test.input}": expected ${test.error.code} "${test.error.message}"`
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`parseCommand tests failed:\n${failures.join("\n")}`);
  }
};
