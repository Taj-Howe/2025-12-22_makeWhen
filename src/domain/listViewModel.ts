import type { ListItem } from "./listTypes";

type ListViewModel = {
  parentTypeMap: Map<string, ListItem["type"]>;
  itemById: Map<string, ListItem>;
  tasks: ListItem[];
  milestones: ListItem[];
  taskChildren: Map<string, ListItem[]>;
  tasksUnderMilestone: Map<string, ListItem[]>;
  ungroupedTasks: ListItem[];
  ungroupedParentId: string | null;
  getAllTasksUnderMilestone: (milestoneId: string) => ListItem[];
};

const sortByOrder = (items: ListItem[]) =>
  items.sort((a, b) => a.sort_order - b.sort_order);

export const buildListViewModel = ({
  items,
  selectedProjectId,
  ungroupedProjectId,
  mode = "project",
}: {
  items: ListItem[];
  selectedProjectId: string | null;
  ungroupedProjectId: string;
  mode?: "project" | "user";
}): ListViewModel => {
  const parentTypeMap = new Map<string, ListItem["type"]>();
  const itemById = new Map<string, ListItem>();

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

  const taskChildren = new Map<string, ListItem[]>();
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

  const tasksUnderMilestone = new Map<string, ListItem[]>();
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

  const collectTaskDescendants = (taskId: string, acc: ListItem[]) => {
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
          const all: ListItem[] = [];
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
