import type { ListItem } from "./listTypes";

type ListViewModel<T extends ListItem> = {
  parentTypeMap: Map<string, ListItem["type"]>;
  itemById: Map<string, T>;
  tasks: T[];
  milestones: T[];
  taskChildren: Map<string, T[]>;
  tasksUnderMilestone: Map<string, T[]>;
  ungroupedTasks: T[];
  ungroupedParentId: string | null;
  getAllTasksUnderMilestone: (milestoneId: string) => T[];
};

const sortByOrder = <T extends ListItem>(items: T[]) =>
  items.sort((a, b) => a.sort_order - b.sort_order);

export const buildListViewModel = <T extends ListItem>({
  items,
  selectedProjectId,
  ungroupedProjectId,
  mode = "project",
}: {
  items: T[];
  selectedProjectId: string | null;
  ungroupedProjectId: string;
  mode?: "project" | "user";
}): ListViewModel<T> => {
  const parentTypeMap = new Map<string, ListItem["type"]>();
  const itemById = new Map<string, T>();

  for (const item of items) {
    parentTypeMap.set(item.id, item.type);
    itemById.set(item.id, item);
  }

  const tasks = items.filter((item) => item.type === "task");
  const milestones =
    mode === "user"
      ? []
      : sortByOrder(
          items.filter(
            (item) =>
              item.type === "milestone" && item.parent_id === selectedProjectId
          )
        );

  const taskChildren = new Map<string, T[]>();
  for (const task of tasks) {
    if (!task.parent_id) {
      continue;
    }
    const list = taskChildren.get(task.parent_id) ?? [];
    list.push(task);
    taskChildren.set(task.parent_id, list);
  }
  for (const [key, list] of taskChildren.entries()) {
    taskChildren.set(key, sortByOrder(list));
  }

  const tasksUnderMilestone = new Map<string, T[]>();
  if (mode !== "user") {
    for (const task of tasks) {
      if (!task.parent_id) {
        continue;
      }
      const parentType = parentTypeMap.get(task.parent_id);
      if (parentType === "milestone") {
        const list = tasksUnderMilestone.get(task.parent_id) ?? [];
        list.push(task);
        tasksUnderMilestone.set(task.parent_id, list);
      }
    }
    for (const [key, list] of tasksUnderMilestone.entries()) {
      tasksUnderMilestone.set(key, sortByOrder(list));
    }
  }

  const ungroupedParentId =
    mode === "user"
      ? null
      : selectedProjectId === ungroupedProjectId
        ? null
        : selectedProjectId;
  const ungroupedTasks =
    mode === "user"
      ? tasks.filter((task) => {
          if (!task.parent_id) {
            return true;
          }
          const parent = itemById.get(task.parent_id);
          return !parent || parent.type !== "task";
        })
      : sortByOrder(
          tasks.filter((task) =>
            ungroupedParentId === null
              ? task.parent_id === null
              : task.parent_id === ungroupedParentId
          )
        );

  const collectTaskDescendants = (taskId: string, acc: T[]) => {
    const children = taskChildren.get(taskId) ?? [];
    for (const child of children) {
      acc.push(child);
      collectTaskDescendants(child.id, acc);
    }
  };

  const getAllTasksUnderMilestone =
    mode === "user"
      ? () => []
      : (milestoneId: string) => {
          const tasksForMilestone = tasksUnderMilestone.get(milestoneId) ?? [];
          const all: T[] = [];
          for (const task of tasksForMilestone) {
            all.push(task);
            collectTaskDescendants(task.id, all);
          }
          return all;
        };

  return {
    parentTypeMap,
    itemById,
    tasks,
    milestones,
    taskChildren,
    tasksUnderMilestone,
    ungroupedTasks,
    ungroupedParentId,
    getAllTasksUnderMilestone,
  };
};
