import type { ParsedCommand, ParseError } from "./parseCommand";
import type { Scope } from "../rpc/types";

export type ResolvedCommand = ParsedCommand & {
  project_id: string;
  parent_id?: string | null;
};

export type ResolveContext = {
  scope: Scope;
  items: Array<{ id: string; type: "project" | "milestone" | "task"; title: string }>;
  projects: Array<{ id: string; title: string }>;
};

type ResolveResult =
  | { ok: true; value: ResolvedCommand }
  | { ok: false; error: ParseError };

const createError = (code: string, message: string): ResolveResult => ({
  ok: false,
  error: { code, message },
});

// Case-insensitive exact match for title resolution.
const normalize = (value: string) => value.trim().toLowerCase();

const stripIdPrefix = (value: string) =>
  value.startsWith("id:") ? value.slice(3) : value;

export const resolveCommand = (
  parsed: ParsedCommand,
  ctx: ResolveContext
): ResolveResult => {
  if (ctx.scope.kind !== "project") {
    return createError(
      "SCOPE_NOT_SUPPORTED",
      `scope kind not implemented: ${ctx.scope.kind}`
    );
  }

  const items = ctx.items;
  const projectTitle =
    ctx.projects.find((project) => project.id === ctx.scope.id)?.title ?? "";

  let projectId = ctx.scope.id;
  if (parsed.project_id) {
    if (parsed.project_id.startsWith("id:")) {
      projectId = stripIdPrefix(parsed.project_id);
    } else if (
      projectTitle &&
      normalize(parsed.project_id) === normalize(projectTitle)
    ) {
      projectId = ctx.scope.id;
    } else {
      const matches = ctx.projects.filter(
        (project) => normalize(project.title) === normalize(parsed.project_id)
      );
      if (matches.length === 0) {
        return createError(
          "PROJECT_NOT_FOUND",
          `unknown project: ${parsed.project_id} (use id:...)`
        );
      }
      if (matches.length > 1) {
        return createError(
          "PROJECT_AMBIGUOUS",
          `ambiguous project: ${parsed.project_id}; use id:...`
        );
      }
      projectId = matches[0].id;
    }
  }

  let parentId: string | null | undefined = parsed.parent_id ?? null;
  if (parsed.parent_id) {
    if (parsed.parent_id.startsWith("id:")) {
      const idValue = stripIdPrefix(parsed.parent_id);
      const match = items.find((item) => item.id === idValue);
      if (!match) {
        return createError(
          "PARENT_NOT_FOUND",
          `parent not found: ${parsed.parent_id}`
        );
      }
      if (match.type === "project") {
        return createError(
          "PARENT_INVALID",
          "parent must be a milestone or task"
        );
      }
      parentId = idValue;
    } else {
      if (projectId !== ctx.scope.id) {
        return createError(
          "PARENT_SCOPE_MISMATCH",
          "under requires id: when targeting a different project"
        );
      }
      const matches = items.filter(
        (item) =>
          item.type !== "project" &&
          normalize(item.title) === normalize(parsed.parent_id ?? "")
      );
      if (matches.length === 0) {
        return createError(
          "PARENT_NOT_FOUND",
          `parent not found: ${parsed.parent_id}`
        );
      }
      if (matches.length > 1) {
        return createError(
          "PARENT_AMBIGUOUS",
          `ambiguous name: ${parsed.parent_id}; use id:...`
        );
      }
      parentId = matches[0].id;
    }
  }

  return {
    ok: true,
    value: {
      ...parsed,
      project_id: projectId,
      parent_id: parentId,
    },
  };
};
