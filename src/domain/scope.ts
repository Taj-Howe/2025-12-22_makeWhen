export type Scope =
  | { kind: "project"; projectId: string | null }
  | { kind: "user"; userId: string };

export const scopeKey = (scope: Scope) =>
  scope.kind === "project"
    ? `project:${scope.projectId ?? "none"}`
    : `user:${scope.userId}`;
