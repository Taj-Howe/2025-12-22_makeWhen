import { serverMutate } from "./serverApi";

export const setStatus = (itemId: string, status: string) =>
  serverMutate("item.set_status", { itemId, status });

export const updateItemFields = (
  itemId: string,
  fields: Record<string, unknown>
) => {
  const patch: Record<string, unknown> = {};
  if ("title" in fields) patch.title = fields.title;
  if ("status" in fields) patch.status = fields.status;
  if ("priority" in fields) patch.priority = fields.priority;
  if ("assignee_id" in fields || "assignee_user_id" in fields) {
    const value =
      (fields.assignee_id as string | null | undefined) ??
      (fields.assignee_user_id as string | null | undefined);
    patch.assigneeUserId = value ?? null;
  }
  if ("due_at" in fields) patch.dueAt = fields.due_at;
  if ("estimate_minutes" in fields) patch.estimateMinutes = fields.estimate_minutes;
  if ("estimate_mode" in fields) patch.estimateMode = fields.estimate_mode;
  if ("notes" in fields) patch.notes = fields.notes;
  if ("parent_id" in fields) patch.parentId = fields.parent_id;
  return serverMutate("item.update", { itemId, patch });
};

export const createItem = (args: Record<string, unknown>) => {
  const type = args.type as string | undefined;
  if (type === "project") {
    return serverMutate("project.create", { title: args.title ?? "" });
  }
  return serverMutate("item.create", {
    projectId: args.project_id,
    parentId: args.parent_id ?? null,
    type,
    title: args.title ?? "",
    status: args.status,
    priority: args.priority,
    assigneeUserId: args.assignee_id ?? args.assignee_user_id ?? null,
    dueAt: args.due_at ?? null,
    estimateMinutes: args.estimate_minutes ?? 0,
    estimateMode: args.estimate_mode ?? "manual",
    notes: args.notes ?? null,
  });
};

export const duplicateTaskFromItem = (item: {
  title: string;
  parent_id: string | null;
  project_id: string;
  due_at: number | null;
  estimate_mode?: string | null;
  estimate_minutes?: number | null;
  status: string;
  priority?: number | null;
  notes?: string | null;
}) =>
  createItem({
    type: "task",
    title: `${item.title} (copy)`,
    parent_id: item.parent_id,
    project_id: item.project_id,
    due_at: item.due_at,
    estimate_mode: item.estimate_mode ?? "manual",
    estimate_minutes: item.estimate_minutes ?? 0,
    status: item.status,
    priority: item.priority ?? 0,
    notes: item.notes ?? null,
  });

export const archiveItem = (itemId: string) =>
  serverMutate("item.archive", { itemId });

export const archiveItems = (ids: string[]) =>
  serverMutate("items.archive_many", { ids });

export const restoreItem = (itemId: string) =>
  serverMutate("item.restore", { itemId });

export const restoreItems = (ids: string[]) =>
  serverMutate("items.restore_many", { ids });

export const deleteItem = (itemId: string) =>
  serverMutate("item.delete", { itemId });

export const deleteItems = (ids: string[]) =>
  serverMutate("items.delete_many", { ids });

export const createInviteLink = (projectId: string, role: "viewer" | "editor") =>
  serverMutate("project.invite_link_create", { projectId, role });

export const revokeInviteLink = (inviteId: string) =>
  serverMutate("project.invite_link_revoke", { inviteId });

export const createBlock = (args: {
  item_id: string;
  start_at: number;
  duration_minutes: number;
}) =>
  serverMutate("scheduled_block.create", {
    itemId: args.item_id,
    startAt: args.start_at,
    durationMinutes: args.duration_minutes,
  });

export const moveBlock = (blockId: string, startAt: number) =>
  serverMutate("scheduled_block.move", { blockId, startAt });

export const resizeBlock = (blockId: string, durationMinutes: number) =>
  serverMutate("scheduled_block.resize", { blockId, durationMinutes });

export const deleteBlock = (blockId: string) =>
  serverMutate("scheduled_block.delete", { blockId });

export const setItemAssignee = (itemId: string, userId: string | null) =>
  serverMutate("item.update", {
    itemId,
    patch: { assigneeUserId: userId },
  });

export const setItemTags = async (_itemId: string, _tags: string[]) => {
  return Promise.resolve();
};

export const createDependencyEdge = (args: {
  predecessor_id: string;
  successor_id: string;
  type?: string;
  lag_minutes?: number;
}) =>
  serverMutate("dependency.add", {
    itemId: args.successor_id,
    dependsOnId: args.predecessor_id,
    type: args.type ?? "FS",
    lagMinutes: args.lag_minutes ?? 0,
  });

export const updateDependencyEdge = (args: {
  edge_id: string;
  type?: string;
  lag_minutes?: number;
}) =>
  serverMutate("dependency.update", {
    edgeId: args.edge_id,
    type: args.type,
    lagMinutes: args.lag_minutes,
  });

export const deleteDependencyEdge = (args: { edge_id: string }) =>
  serverMutate("dependency.delete", { edgeId: args.edge_id });

export const addDependency = (itemId: string, dependsOnId: string) =>
  serverMutate("dependency.add", { itemId, dependsOnId, type: "FS", lagMinutes: 0 });

export const removeDependency = (itemId: string, dependsOnId: string) =>
  serverMutate("dependency.remove", { itemId, dependsOnId });

export const addBlocker = (itemId: string, kind: string, text: string) =>
  serverMutate("blocker.add", { itemId, kind, text });

export const resolveBlocker = (blockerId: string) =>
  serverMutate("blocker.resolve", { blockerId });
