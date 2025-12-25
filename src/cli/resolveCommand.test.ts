import { resolveCommand } from "./resolveCommand";
import type { ParsedCommand, ParseError } from "./parseCommand";
import type { Scope } from "../rpc/types";

const scope: Scope = { kind: "project", id: "proj_1" };

const items = [
  { id: "proj_1", type: "project" as const, title: "Project Alpha" },
  { id: "ms_1", type: "milestone" as const, title: "Milestone A" },
  { id: "ms_2", type: "milestone" as const, title: "Milestone A" },
  { id: "task_1", type: "task" as const, title: "Task One" },
];

const projects = [
  { id: "proj_1", title: "Project Alpha" },
  { id: "proj_2", title: "Project Beta" },
  { id: "proj_3", title: "Project Beta" },
];

type InvalidCase = {
  parsed: ParsedCommand;
  error: ParseError;
};

const invalidCases: InvalidCase[] = [
  {
    parsed: {
      action: "create",
      type: "task",
      title: "Test",
      parent_id: "Milestone A",
      status: "backlog",
      priority: 0,
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
    error: {
      code: "PARENT_AMBIGUOUS",
      message: "ambiguous name: Milestone A; use id:...",
    },
  },
  {
    parsed: {
      action: "create",
      type: "task",
      title: "Test",
      project_id: "Project Beta",
      status: "backlog",
      priority: 0,
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
    error: {
      code: "PROJECT_AMBIGUOUS",
      message: "ambiguous project: Project Beta; use id:...",
    },
  },
  {
    parsed: {
      action: "create",
      type: "task",
      title: "Test",
      parent_id: "Missing Parent",
      status: "backlog",
      priority: 0,
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
    error: {
      code: "PARENT_NOT_FOUND",
      message: "parent not found: Missing Parent",
    },
  },
  {
    parsed: {
      action: "create",
      type: "task",
      title: "Test",
      parent_id: "id:proj_1",
      status: "backlog",
      priority: 0,
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
    error: {
      code: "PARENT_INVALID",
      message: "parent must be a milestone or task",
    },
  },
  {
    parsed: {
      action: "create",
      type: "task",
      title: "Test",
      project_id: "Other Project",
      status: "backlog",
      priority: 0,
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
    error: {
      code: "PROJECT_NOT_FOUND",
      message: "unknown project: Other Project (use id:...)",
    },
  },
  {
    parsed: {
      type: "task",
      title: "Test",
      project_id: "Project Beta",
      parent_id: "Milestone A",
      status: "backlog",
      priority: 0,
      estimate_mode: "manual",
      estimate_minutes: 0,
      tags: [],
      depends_on: [],
      health: "unknown",
      health_mode: "auto",
    },
    error: {
      code: "PARENT_SCOPE_MISMATCH",
      message: "under requires id: when targeting a different project",
    },
  },
];

export const runResolveCommandTests = () => {
  const failures: string[] = [];

  for (const test of invalidCases) {
    const result = resolveCommand(test.parsed, { scope, items, projects });
    if (result.ok) {
      failures.push(`Expected error for "${test.parsed.title}", got ok`);
      continue;
    }
    if (
      result.error.code !== test.error.code ||
      result.error.message !== test.error.message
    ) {
      failures.push(
        `Error mismatch for "${test.parsed.title}": expected ${test.error.code}`
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`resolveCommand tests failed:\n${failures.join("\n")}`);
  }
};
