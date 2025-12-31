import { mutate } from "../rpc/clientSingleton";
import type { ListItem } from "../domain/listTypes";

export const setStatus = (id: string, status: string) =>
  mutate("set_status", { id, status });

export const updateItemFields = (
  id: string,
  fields: Record<string, unknown>
) => mutate("update_item_fields", { id, fields });

export const deleteItem = (id: string) =>
  mutate("delete_item", { item_id: id });

export const createItem = (args: Record<string, unknown>) =>
  mutate("create_item", args);

export const createBlock = (args: {
  item_id: string;
  start_at: number;
  duration_minutes: number;
  source?: string;
}) => mutate("scheduled_block.create", args);

export const setItemTags = (itemId: string, tags: string[]) =>
  mutate("set_item_tags", { item_id: itemId, tags });

// Single-assignee invariant: item.set_assignee replaces any existing assignment.
export const setItemAssignee = (itemId: string, userId: string | null) =>
  mutate("item.set_assignee", { item_id: itemId, user_id: userId });

export const addDependency = (itemId: string, dependsOnId: string) =>
  mutate("add_dependency", { item_id: itemId, depends_on_id: dependsOnId });

export const removeDependency = (itemId: string, dependsOnId: string) =>
  mutate("remove_dependency", { item_id: itemId, depends_on_id: dependsOnId });

export const createDependencyEdge = (args: {
  predecessor_id: string;
  successor_id: string;
  type?: string;
  lag_minutes?: number;
}) => mutate("dependency.create", args);

export const updateDependencyEdge = (args: {
  edge_id: string;
  type?: string;
  lag_minutes?: number;
}) => mutate("dependency.update", args);

export const deleteDependencyEdge = (args: { edge_id: string }) =>
  mutate("dependency.delete", args);

export const duplicateTaskFromItem = (item: ListItem) =>
  mutate("create_item", {
    type: "task",
    title: `${item.title} (copy)`,
    parent_id: item.parent_id,
    due_at: item.due_at ?? null,
    estimate_mode: item.estimate_mode ?? "manual",
    estimate_minutes: item.estimate_minutes ?? 0,
    status: item.status,
    priority: item.priority ?? 0,
    notes: item.notes ?? null,
  });
