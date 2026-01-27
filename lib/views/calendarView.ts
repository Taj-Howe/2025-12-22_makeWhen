import { db } from "../db/kysely";

const toMs = (value: string | null) => (value ? new Date(value).getTime() : null);

export type CalendarViewScope =
  | { kind: "project"; projectId: string }
  | { kind: "user"; userId: string }
  | { kind: "all" };

export type CalendarViewArgs = {
  scope: CalendarViewScope;
  windowStart: number;
  windowEnd: number;
  includeArchived?: boolean;
};

export type CalendarBlock = {
  block_id: string;
  item_id: string;
  start_at: number;
  duration_minutes: number;
};

export type CalendarItem = {
  id: string;
  title: string;
  status: string;
  due_at: number | null;
  parent_id: string | null;
  item_type: string;
  priority: number;
  assignee_id?: string | null;
  assignee_name?: string | null;
};

export type CalendarViewResult = {
  blocks: CalendarBlock[];
  items: CalendarItem[];
};

export const getCalendarView = async ({
  scope,
  windowStart,
  windowEnd,
  includeArchived = false,
}: CalendarViewArgs): Promise<CalendarViewResult> => {
  if (windowEnd <= windowStart) {
    throw new Error("windowEnd must be greater than windowStart");
  }

  const timeMin = new Date(windowStart).toISOString();
  const timeMax = new Date(windowEnd).toISOString();

  const baseItems = db
    .selectFrom("items")
    .select([
      "items.id",
      "items.title",
      "items.status",
      "items.due_at",
      "items.parent_id",
      "items.type",
      "items.priority",
      "items.assignee_user_id",
    ])
    .where((eb) =>
      includeArchived
        ? eb.val(true).eq(true)
        : eb("items.archived_at", "is", null)
    );

  const scopedItems =
    scope.kind === "project"
      ? baseItems.where("items.project_id", "=", scope.projectId)
      : scope.kind === "user"
        ? baseItems.where("items.assignee_user_id", "=", scope.userId)
        : baseItems;

  const dueRows = await scopedItems
    .where("items.due_at", "is not", null)
    .where("items.due_at", ">=", timeMin)
    .where("items.due_at", "<", timeMax)
    .orderBy("items.due_at", "asc")
    .execute();

  const assigneeIds = Array.from(
    new Set(dueRows.map((row) => row.assignee_user_id).filter(Boolean))
  ) as string[];
  const userRows = assigneeIds.length
    ? await db
        .selectFrom("users")
        .select(["id", "name"])
        .where("id", "in", assigneeIds)
        .execute()
    : [];
  const userMap = new Map(userRows.map((row) => [row.id, row.name]));

  const items: CalendarItem[] = dueRows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    due_at: toMs(row.due_at),
    parent_id: row.parent_id,
    item_type: row.type,
    priority: row.priority,
    assignee_id: row.assignee_user_id,
    assignee_name: row.assignee_user_id
      ? userMap.get(row.assignee_user_id) ?? null
      : null,
  }));

  const blocksQuery = db
    .selectFrom("scheduled_blocks as b")
    .innerJoin("items as i", "i.id", "b.item_id")
    .select([
      "b.id as block_id",
      "b.item_id",
      "b.start_at",
      "b.duration_minutes",
    ])
    .where((eb) =>
      includeArchived
        ? eb.val(true).eq(true)
        : eb("i.archived_at", "is", null)
    )
    .where("b.start_at", "<", timeMax);

  const scopedBlocks =
    scope.kind === "project"
      ? blocksQuery.where("i.project_id", "=", scope.projectId)
      : scope.kind === "user"
        ? blocksQuery.where("i.assignee_user_id", "=", scope.userId)
        : blocksQuery;

  const blockRows = await scopedBlocks.orderBy("b.start_at", "asc").execute();

  const blocks: CalendarBlock[] = blockRows
    .map((row) => {
      const startAt = new Date(row.start_at).getTime();
      return {
        block_id: row.block_id,
        item_id: row.item_id,
        start_at: startAt,
        duration_minutes: row.duration_minutes,
        end_at: startAt + row.duration_minutes * 60000,
      };
    })
    .filter((block) => block.end_at > windowStart)
    .map(({ end_at: _end, ...rest }) => rest);

  return { blocks, items };
};
