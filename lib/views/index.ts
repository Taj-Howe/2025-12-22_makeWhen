import { sql } from "kysely";
import { getDb } from "../db/connection";

export type QueryRequest = {
  name: string;
  args?: Record<string, unknown>;
};

export type QueryActor = {
  userId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
};

type ScopeInput = {
  scopeType: "project" | "user";
  scopeId: string;
};

type DependencyStatus = "satisfied" | "violated" | "unknown";

const parseDate = (value: unknown) => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
};

const buildDependencyGraph = (edges: Array<{ item_id: string; depends_on_id: string }>) => {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    const list = graph.get(edge.item_id) ?? [];
    list.push(edge.depends_on_id);
    graph.set(edge.item_id, list);
  }
  return graph;
};

const findDependencyCycles = (graph: Map<string, string[]>) => {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const cycles: string[][] = [];

  const dfs = (node: string, path: string[]) => {
    if (stack.has(node)) {
      const idx = path.indexOf(node);
      cycles.push(path.slice(idx));
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    stack.add(node);
    const next = graph.get(node) ?? [];
    for (const neighbor of next) {
      dfs(neighbor, [...path, neighbor]);
    }
    stack.delete(node);
  };

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, [node]);
    }
  }

  return cycles;
};

const requireScope = (args: Record<string, unknown> | undefined) => {
  const scopeType =
    args?.scopeType === "user" || args?.scopeType === "project"
      ? args.scopeType
      : null;
  const scopeId = typeof args?.scopeId === "string" ? args.scopeId : null;
  if (!scopeType || !scopeId) {
    throw new Error("scopeType and scopeId are required");
  }
  return { scopeType, scopeId } satisfies ScopeInput;
};

const requireProjectAccess = async (projectId: string, userId: string) => {
  const db = getDb();
  const member = await db
    .selectFrom("project_members")
    .select(["role"])
    .where("project_id", "=", projectId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!member) {
    throw new Error("FORBIDDEN");
  }
  return member.role;
};

const ensureScopeAccess = async (scope: ScopeInput, actor: QueryActor) => {
  if (scope.scopeType === "user" && scope.scopeId !== actor.userId) {
    throw new Error("FORBIDDEN");
  }
  if (scope.scopeType === "project") {
    await requireProjectAccess(scope.scopeId, actor.userId);
  }
};

const projectsListQuery = async (actor: QueryActor) => {
  const db = getDb();
  const projects = await db
    .selectFrom("project_members")
    .innerJoin("projects", "projects.id", "project_members.project_id")
    .select(["projects.id as id", "projects.title as title"])
    .where("project_members.user_id", "=", actor.userId)
    .orderBy("projects.updated_at", "desc")
    .execute();
  return { projects };
};

const usersListQuery = async (actor: QueryActor) => {
  const db = getDb();
  const users = await db
    .selectFrom("users")
    .select(["id", "name", "avatar_url"])
    .orderBy("created_at", "asc")
    .execute();
  return {
    users: users.map((user) => ({
      user_id: user.id,
      display_name: user.name ?? "Unknown",
      avatar_url: user.avatar_url ?? null,
    })),
    current_user_id: actor.userId,
  };
};

const collaboratorsListQuery = async (actor: QueryActor) => {
  const db = getDb();
  const collaborators = await db
    .selectFrom("collaborator_contacts")
    .innerJoin("users", "users.id", "collaborator_contacts.collaborator_user_id")
    .select([
      "users.id as user_id",
      "users.name as display_name",
      "users.avatar_url as avatar_url",
    ])
    .where("collaborator_contacts.owner_user_id", "=", actor.userId)
    .where("collaborator_contacts.status", "=", "active")
    .orderBy("collaborator_contacts.last_interaction_at", "desc")
    .execute();

  const map = new Map<string, { user_id: string; display_name: string; avatar_url: string | null }>();
  map.set(actor.userId, {
    user_id: actor.userId,
    display_name: actor.name ?? actor.email ?? "Me",
    avatar_url: actor.avatarUrl ?? null,
  });
  for (const user of collaborators) {
    map.set(user.user_id, {
      user_id: user.user_id,
      display_name: user.display_name ?? "Unknown",
      avatar_url: user.avatar_url ?? null,
    });
  }
  return { collaborators: Array.from(map.values()) };
};

const assigneesListQuery = async (
  args: Record<string, unknown> | undefined,
  actor: QueryActor
) => {
  const db = getDb();
  const projectId = typeof args?.projectId === "string" ? args.projectId : null;
  const map = new Map<string, { user_id: string; display_name: string; avatar_url: string | null }>();

  map.set(actor.userId, {
    user_id: actor.userId,
    display_name: actor.name ?? actor.email ?? "Me",
    avatar_url: actor.avatarUrl ?? null,
  });

  if (projectId) {
    await requireProjectAccess(projectId, actor.userId);
    const members = await db
      .selectFrom("project_members")
      .innerJoin("users", "users.id", "project_members.user_id")
      .select([
        "users.id as user_id",
        "users.name as display_name",
        "users.avatar_url as avatar_url",
      ])
      .where("project_members.project_id", "=", projectId)
      .execute();
    for (const member of members) {
      map.set(member.user_id, {
        user_id: member.user_id,
        display_name: member.display_name ?? "Unknown",
        avatar_url: member.avatar_url ?? null,
      });
    }
  }

  const collaborators = await db
    .selectFrom("collaborator_contacts")
    .innerJoin("users", "users.id", "collaborator_contacts.collaborator_user_id")
    .select([
      "users.id as user_id",
      "users.name as display_name",
      "users.avatar_url as avatar_url",
    ])
    .where("collaborator_contacts.owner_user_id", "=", actor.userId)
    .where("collaborator_contacts.status", "=", "active")
    .execute();
  for (const user of collaborators) {
    map.set(user.user_id, {
      user_id: user.user_id,
      display_name: user.display_name ?? "Unknown",
      avatar_url: user.avatar_url ?? null,
    });
  }

  return { users: Array.from(map.values()) };
};

const projectInviteLinksQuery = async (
  args: Record<string, unknown> | undefined,
  actor: QueryActor
) => {
  const projectId = typeof args?.projectId === "string" ? args.projectId : "";
  if (!projectId) {
    throw new Error("projectId is required");
  }
  await requireProjectAccess(projectId, actor.userId);
  const db = getDb();
  const invites = await db
    .selectFrom("project_invite_links")
    .select([
      "id",
      "role",
      "token",
      "revoked_at",
      "created_at",
      "created_by_user_id",
    ])
    .where("project_id", "=", projectId)
    .orderBy("created_at", "desc")
    .execute();
  const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    ""
  );
  return {
    invites: invites.map((invite) => ({
      id: invite.id,
      role: invite.role,
      revoked_at: invite.revoked_at,
      created_at: invite.created_at,
      created_by_user_id: invite.created_by_user_id,
      url: `${baseUrl}/join?token=${invite.token}`,
    })),
  };
};

const searchItemsQuery = async (
  args: Record<string, unknown> | undefined,
  actor: QueryActor
) => {
  const text = typeof args?.text === "string" ? args.text.trim() : "";
  const limit =
    typeof args?.limit === "number" && args.limit > 0 ? args.limit : 20;
  if (!text) {
    return { items: [] };
  }
  const scopeProjectId =
    typeof args?.scopeProjectId === "string" ? args.scopeProjectId : null;
  const db = getDb();
  let query = db
    .selectFrom("items")
    .select(["id", "title", "type", "project_id"])
    .where(sql`lower(title)`, "like", `%${text.toLowerCase()}%`);
  if (scopeProjectId) {
    await requireProjectAccess(scopeProjectId, actor.userId);
    query = query.where("project_id", "=", scopeProjectId);
  }
  const items = await query
    .orderBy(sql`length(title)`, "asc")
    .orderBy("title", "asc")
    .limit(Math.min(limit, 50))
    .execute();
  return {
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      project_id: item.project_id,
    })),
  };
};

const itemDetailsQuery = async (
  args: Record<string, unknown> | undefined,
  actor: QueryActor
) => {
  const itemId = typeof args?.itemId === "string" ? args.itemId : "";
  if (!itemId) {
    throw new Error("itemId is required");
  }
  const db = getDb();
  const item = await db
    .selectFrom("items")
    .selectAll()
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) {
    return null;
  }
  await requireProjectAccess(item.project_id, actor.userId);

  const deps = await db
    .selectFrom("dependencies")
    .select(["depends_on_id"])
    .where("item_id", "=", itemId)
    .execute();

  const blocks = await db
    .selectFrom("scheduled_blocks")
    .select(["id", "start_at", "duration_minutes"])
    .where("item_id", "=", itemId)
    .execute();

  let scheduleStartAt: string | null = null;
  let scheduledMinutesTotal = 0;
  let primaryBlockId: string | null = null;
  for (const block of blocks) {
    const startDate = parseDate(block.start_at);
    if (!startDate) {
      continue;
    }
    scheduledMinutesTotal += block.duration_minutes;
    const start = startDate.getTime();
    if (scheduleStartAt === null || start < new Date(scheduleStartAt).getTime()) {
      scheduleStartAt = startDate.toISOString();
      primaryBlockId = block.id;
    }
  }

  const blockers = await db
    .selectFrom("blockers")
    .select(["id", "kind", "text", "created_at", "resolved_at"])
    .where("item_id", "=", itemId)
    .execute();

  const assignee =
    item.assignee_user_id === null
      ? null
      : await db
          .selectFrom("users")
          .select(["id", "name"])
          .where("id", "=", item.assignee_user_id)
          .executeTakeFirst();

  return {
    id: item.id,
    project_id: item.project_id,
    type: item.type,
    title: item.title,
    parent_id: item.parent_id,
    status: item.status,
    priority: item.priority,
    due_at: item.due_at,
    estimate_mode: item.estimate_mode,
    estimate_minutes: item.estimate_minutes,
    health: item.health ?? "unknown",
    health_mode: "auto",
    notes: item.notes,
    dependencies: deps.map((dep) => dep.depends_on_id),
    scheduled_minutes_total: scheduledMinutesTotal,
    schedule_start_at: scheduleStartAt,
    primary_block_id: primaryBlockId,
    assignee_id: item.assignee_user_id,
    assignee_name: assignee?.name ?? null,
    blockers: blockers.map((blocker) => ({
      blocker_id: blocker.id,
      kind: blocker.kind,
      text: blocker.text,
      created_at: blocker.created_at,
      cleared_at: blocker.resolved_at,
    })),
  };
};

const toMinutes = (ms: number) => Math.round(ms / 60000);

const computeDependencyStatus = (
  edge: {
    type: string;
    lag_minutes: number;
    item_id: string;
    depends_on_id: string;
  },
  ranges: Map<string, { start: number | null; end: number | null }>
): { status: DependencyStatus; reason: string } => {
  const pred = ranges.get(edge.depends_on_id);
  const succ = ranges.get(edge.item_id);
  if (!pred || !succ) {
    return { status: "unknown", reason: "Missing schedule data" };
  }
  const lagMs = edge.lag_minutes * 60000;
  const predStart = pred.start;
  const predEnd = pred.end;
  const succStart = succ.start;
  const succEnd = succ.end;
  const lagLabel = `${edge.type} +${edge.lag_minutes}m`;
  switch (edge.type) {
    case "SS":
      if (predStart === null || succStart === null) {
        return { status: "unknown", reason: "Missing schedule data" };
      }
      return {
        status: succStart >= predStart + lagMs ? "satisfied" : "violated",
        reason: lagLabel,
      };
    case "FF":
      if (predEnd === null || succEnd === null) {
        return { status: "unknown", reason: "Missing schedule data" };
      }
      return {
        status: succEnd >= predEnd + lagMs ? "satisfied" : "violated",
        reason: lagLabel,
      };
    case "SF":
      if (predStart === null || succEnd === null) {
        return { status: "unknown", reason: "Missing schedule data" };
      }
      return {
        status: succEnd >= predStart + lagMs ? "satisfied" : "violated",
        reason: lagLabel,
      };
    case "FS":
    default:
      if (predEnd === null || succStart === null) {
        return { status: "unknown", reason: "Missing schedule data" };
      }
      return {
        status: succStart >= predEnd + lagMs ? "satisfied" : "violated",
        reason: lagLabel,
      };
  }
};

const summarizeBlocks = (
  blocks: Array<{
    id: string;
    item_id: string;
    start_at: string;
    duration_minutes: number;
  }>
) => {
  const map = new Map<
    string,
    { start: number | null; end: number | null; blocks: Array<any> }
  >();
  for (const block of blocks) {
    const startDate = parseDate(block.start_at);
    if (!startDate) {
      continue;
    }
    const start = startDate.getTime();
    const end = start + block.duration_minutes * 60000;
    const entry = map.get(block.item_id) ?? {
      start: null,
      end: null,
      blocks: [],
    };
    entry.start = entry.start === null ? start : Math.min(entry.start, start);
    entry.end = entry.end === null ? end : Math.max(entry.end, end);
    entry.blocks.push({
      id: block.id,
      start_at: block.start_at,
      duration_minutes: block.duration_minutes,
      end_at: new Date(end).toISOString(),
    });
    map.set(block.item_id, entry);
  }
  return map;
};

const computeRollups = (
  items: Array<{ id: string; parent_id: string | null }>,
  rollupSource: Map<
    string,
    { start: number | null; end: number | null; estimate: number; actual: number }
  >
) => {
  const childrenMap = new Map<string | null, string[]>();
  for (const item of items) {
    const list = childrenMap.get(item.parent_id) ?? [];
    list.push(item.id);
    childrenMap.set(item.parent_id, list);
  }
  const memo = new Map<
    string,
    { start: number | null; end: number | null; estimate: number; actual: number }
  >();

  const walk = (id: string) => {
    if (memo.has(id)) {
      return memo.get(id)!;
    }
    const self = rollupSource.get(id) ?? {
      start: null,
      end: null,
      estimate: 0,
      actual: 0,
    };
    let agg = { ...self };
    const children = childrenMap.get(id) ?? [];
    for (const childId of children) {
      const child = walk(childId);
      if (child.start !== null) {
        agg.start = agg.start === null ? child.start : Math.min(agg.start, child.start);
      }
      if (child.end !== null) {
        agg.end = agg.end === null ? child.end : Math.max(agg.end, child.end);
      }
      agg.estimate += child.estimate;
      agg.actual += child.actual;
    }
    memo.set(id, agg);
    return agg;
  };

  for (const item of items) {
    walk(item.id);
  }
  return memo;
};

const listViewQuery = async (args: Record<string, unknown> | undefined, actor: QueryActor) => {
  const scope = requireScope(args);
  await ensureScopeAccess(scope, actor);

  const includeArchived = Boolean(args?.includeArchived);
  const includeCompleted = Boolean(args?.includeCompleted);
  const db = getDb();

  let itemsQuery = db.selectFrom("items").selectAll();
  if (scope.scopeType === "project") {
    itemsQuery = itemsQuery.where("project_id", "=", scope.scopeId);
  } else {
    itemsQuery = itemsQuery.where("assignee_user_id", "=", scope.scopeId);
  }
  if (!includeArchived) {
    itemsQuery = itemsQuery.where("archived_at", "is", null);
  }
  if (!includeCompleted) {
    itemsQuery = itemsQuery.where("status", "not in", ["done", "canceled"]);
  }

  const items = await itemsQuery.execute();
  const itemIds = items.map((item) => item.id);
  if (itemIds.length === 0) {
    return [];
  }

  const blocks = await db
    .selectFrom("scheduled_blocks")
    .select(["id", "item_id", "start_at", "duration_minutes"])
    .where("item_id", "in", itemIds)
    .execute();
  const blockMap = summarizeBlocks(blocks);

  const dependencies = await db
    .selectFrom("dependencies")
    .select(["id", "item_id", "depends_on_id", "type", "lag_minutes"])
    .where("item_id", "in", itemIds)
    .execute();

  const blockers = await db
    .selectFrom("blockers")
    .select(["item_id", "resolved_at"])
    .where("item_id", "in", itemIds)
    .execute();
  const blockersCount = new Map<string, number>();
  const unresolvedBlockers = new Map<string, number>();
  for (const blocker of blockers) {
    blockersCount.set(
      blocker.item_id,
      (blockersCount.get(blocker.item_id) ?? 0) + 1
    );
    if (!blocker.resolved_at) {
      unresolvedBlockers.set(
        blocker.item_id,
        (unresolvedBlockers.get(blocker.item_id) ?? 0) + 1
      );
    }
  }

  const actuals = await db
    .selectFrom("time_entries")
    .select(["item_id"])
    .select(sql`COALESCE(SUM(duration_minutes), 0)`.as("actual_minutes"))
    .where("item_id", "in", itemIds)
    .groupBy("item_id")
    .execute();
  const actualMap = new Map<string, number>();
  for (const row of actuals) {
    actualMap.set(row.item_id, Number(row.actual_minutes ?? 0));
  }

  const ranges = new Map<string, { start: number | null; end: number | null }>();
  for (const item of items) {
    const summary = blockMap.get(item.id);
    ranges.set(item.id, {
      start: summary?.start ?? null,
      end: summary?.end ?? null,
    });
  }

  const blockedByMap = new Map<string, Array<any>>();
  const blockingMap = new Map<string, Array<any>>();
  const edgesByItem = new Map<string, Array<any>>();
  for (const dep of dependencies) {
    const statusInfo = computeDependencyStatus(dep, ranges);
    const predecessor = items.find((row) => row.id === dep.depends_on_id);
    const successor = items.find((row) => row.id === dep.item_id);
    const edge = {
      edge_id: dep.id,
      item_id: dep.item_id,
      depends_on_id: dep.depends_on_id,
      type: dep.type,
      lag_minutes: dep.lag_minutes,
      status: statusInfo.status,
      reason: statusInfo.reason,
      title: predecessor?.title ?? "",
    };
    const list = edgesByItem.get(dep.item_id) ?? [];
    list.push(edge);
    edgesByItem.set(dep.item_id, list);

    const blockedBy = blockedByMap.get(dep.item_id) ?? [];
    blockedBy.push(edge);
    blockedByMap.set(dep.item_id, blockedBy);

    const blocking = blockingMap.get(dep.depends_on_id) ?? [];
    blocking.push({
      ...edge,
      item_id: dep.depends_on_id,
      depends_on_id: dep.item_id,
      title: successor?.title ?? "",
    });
    blockingMap.set(dep.depends_on_id, blocking);
  }

  const rollupSource = new Map<
    string,
    { start: number | null; end: number | null; estimate: number; actual: number }
  >();
  for (const item of items) {
    const summary = ranges.get(item.id);
    rollupSource.set(item.id, {
      start: summary?.start ?? null,
      end: summary?.end ?? null,
      estimate: item.estimate_minutes ?? 0,
      actual: actualMap.get(item.id) ?? 0,
    });
  }
  const rollups = computeRollups(items, rollupSource);

  return items.map((item) => {
    const summary = blockMap.get(item.id);
    const rollup = rollups.get(item.id);
    const slackMinutes =
      item.due_at && summary?.end
        ? toMinutes(new Date(item.due_at).getTime() - summary.end)
        : null;
    return {
      ...item,
      schedule_start_at: summary?.start ? new Date(summary.start).toISOString() : null,
      schedule_end_at: summary?.end ? new Date(summary.end).toISOString() : null,
      blocks: summary?.blocks ?? [],
      depends_on_edges: edgesByItem.get(item.id) ?? [],
      blocked_by: blockedByMap.get(item.id) ?? [],
      blocking: blockingMap.get(item.id) ?? [],
      blockers_count: blockersCount.get(item.id) ?? 0,
      unresolved_blockers: unresolvedBlockers.get(item.id) ?? 0,
      actual_minutes: actualMap.get(item.id) ?? 0,
      slack_minutes: slackMinutes,
      rollup_start_at: rollup?.start ? new Date(rollup.start).toISOString() : null,
      rollup_end_at: rollup?.end ? new Date(rollup.end).toISOString() : null,
      rollup_estimate_minutes: rollup?.estimate ?? 0,
      rollup_actual_minutes: rollup?.actual ?? 0,
    };
  });
};

const calendarViewQuery = async (
  args: Record<string, unknown> | undefined,
  actor: QueryActor
) => {
  const scope = requireScope(args);
  await ensureScopeAccess(scope, actor);
  const windowStart = parseDate(args?.windowStart);
  const windowEnd = parseDate(args?.windowEnd);
  if (!windowStart || !windowEnd) {
    throw new Error("windowStart and windowEnd are required");
  }
  const includeArchived = Boolean(args?.includeArchived);
  const db = getDb();

  let itemBase = db.selectFrom("items").select([
    "id",
    "title",
    "status",
    "project_id",
    "assignee_user_id",
    "due_at",
  ]);
  if (scope.scopeType === "project") {
    itemBase = itemBase.where("project_id", "=", scope.scopeId);
  } else {
    itemBase = itemBase.where("assignee_user_id", "=", scope.scopeId);
  }
  if (!includeArchived) {
    itemBase = itemBase.where("archived_at", "is", null);
  }

  const items = await itemBase.execute();
  const itemIds = items.map((item) => item.id);

  const blocks =
    itemIds.length === 0
      ? []
      : await db
          .selectFrom("scheduled_blocks")
          .innerJoin("items", "items.id", "scheduled_blocks.item_id")
          .select([
            "scheduled_blocks.id as block_id",
            "scheduled_blocks.item_id",
            "scheduled_blocks.start_at",
            "scheduled_blocks.duration_minutes",
            "items.title",
            "items.status",
            "items.project_id",
            "items.assignee_user_id",
          ])
          .where("scheduled_blocks.item_id", "in", itemIds)
          .where(
            sql`scheduled_blocks.start_at + (scheduled_blocks.duration_minutes || ' minutes')::interval`,
            ">",
            windowStart
          )
          .where("scheduled_blocks.start_at", "<", windowEnd)
          .execute();

  const blocksWithEnd = blocks.map((block) => {
    const start = parseDate(block.start_at);
    const endAt = start
      ? new Date(start.getTime() + block.duration_minutes * 60000).toISOString()
      : null;
    return { ...block, end_at: endAt };
  });

  const dueItems = items.filter((item) => {
    const due = parseDate(item.due_at);
    if (!due) return false;
    return due >= windowStart && due <= windowEnd;
  });

  return { blocks: blocksWithEnd, items: dueItems };
};

const executionWindowQuery = async (
  args: Record<string, unknown> | undefined,
  actor: QueryActor
) => {
  const scope = requireScope(args);
  await ensureScopeAccess(scope, actor);
  const windowStart = parseDate(args?.windowStart);
  const windowEnd = parseDate(args?.windowEnd);
  if (!windowStart || !windowEnd) {
    throw new Error("windowStart and windowEnd are required");
  }
  const limit = typeof args?.limit === "number" ? args.limit : 12;
  const db = getDb();

  let itemsQuery = db.selectFrom("items").selectAll();
  if (scope.scopeType === "project") {
    itemsQuery = itemsQuery.where("project_id", "=", scope.scopeId);
  } else {
    itemsQuery = itemsQuery.where("assignee_user_id", "=", scope.scopeId);
  }
  itemsQuery = itemsQuery.where("archived_at", "is", null);
  const items = await itemsQuery.execute();
  const itemIds = items.map((item) => item.id);

  const blocks =
    itemIds.length === 0
      ? []
      : await db
          .selectFrom("scheduled_blocks")
          .select(["id", "item_id", "start_at", "duration_minutes"])
          .where("item_id", "in", itemIds)
          .where(
            sql`scheduled_blocks.start_at + (scheduled_blocks.duration_minutes || ' minutes')::interval`,
            ">",
            windowStart
          )
          .where("scheduled_blocks.start_at", "<", windowEnd)
          .execute();

  const blockMap = summarizeBlocks(blocks);
  const ranges = new Map<string, { start: number | null; end: number | null }>();
  for (const item of items) {
    const summary = blockMap.get(item.id);
    ranges.set(item.id, {
      start: summary?.start ?? null,
      end: summary?.end ?? null,
    });
  }

  const dependencies = await db
    .selectFrom("dependencies")
    .select(["item_id", "depends_on_id", "type", "lag_minutes"])
    .where("item_id", "in", itemIds)
    .execute();

  const blockers = await db
    .selectFrom("blockers")
    .select(["item_id", "resolved_at"])
    .where("item_id", "in", itemIds)
    .execute();
  const unresolvedBlockers = new Set<string>();
  for (const blocker of blockers) {
    if (!blocker.resolved_at) {
      unresolvedBlockers.add(blocker.item_id);
    }
  }

  const blockedByDeps = new Set<string>();
  for (const dep of dependencies) {
    const statusInfo = computeDependencyStatus(dep, ranges);
    if (statusInfo.status === "violated") {
      blockedByDeps.add(dep.item_id);
    }
  }

  const blocksWithMeta = blocks.map((block) => {
    const item = items.find((row) => row.id === block.item_id);
    const start = parseDate(block.start_at)?.toISOString() ?? block.start_at;
    const end = parseDate(block.start_at);
    const endAt = end
      ? new Date(end.getTime() + block.duration_minutes * 60000).toISOString()
      : null;
    return {
      block_id: block.id,
      item_id: block.item_id,
      start_at: start,
      duration_minutes: block.duration_minutes,
      end_at: endAt,
      title: item?.title ?? "",
      status: item?.status ?? "",
      project_id: item?.project_id ?? null,
      assignee_user_id: item?.assignee_user_id ?? null,
      due_at: item?.due_at ?? null,
    };
  });

  const blockItemIds = new Set(blocks.map((block) => block.item_id));
  const readyItems = items.filter((item) => {
    if (["done", "canceled"].includes(item.status)) {
      return false;
    }
    if (!["ready", "in_progress", "review"].includes(item.status)) {
      return false;
    }
    if (unresolvedBlockers.has(item.id)) {
      return false;
    }
    if (blockedByDeps.has(item.id)) {
      return false;
    }
    return true;
  });

  const readyUnscheduled = readyItems
    .filter((item) => !blockItemIds.has(item.id))
    .sort((a, b) => {
      const aDue = parseDate(a.due_at)?.getTime() ?? Number.POSITIVE_INFINITY;
      const bDue = parseDate(b.due_at)?.getTime() ?? Number.POSITIVE_INFINITY;
      if (aDue !== bDue) return aDue - bDue;
      const aSlack = a.due_at && ranges.get(a.id)?.end
        ? toMinutes(aDue - (ranges.get(a.id)?.end ?? 0))
        : Number.POSITIVE_INFINITY;
      const bSlack = b.due_at && ranges.get(b.id)?.end
        ? toMinutes(bDue - (ranges.get(b.id)?.end ?? 0))
        : Number.POSITIVE_INFINITY;
      if (aSlack !== bSlack) return aSlack - bSlack;
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (a.sequence_rank !== b.sequence_rank) return a.sequence_rank - b.sequence_rank;
      return a.title.localeCompare(b.title);
    })
    .slice(0, Math.max(1, limit));

  return {
    scheduled: blocksWithMeta.sort((a, b) => {
      const aStart = parseDate(a.start_at)?.getTime() ?? 0;
      const bStart = parseDate(b.start_at)?.getTime() ?? 0;
      if (aStart !== bStart) return aStart - bStart;
      return a.title.localeCompare(b.title);
    }),
    ready_unscheduled: readyUnscheduled,
  };
};

const integrityReportQuery = async (
  args: Record<string, unknown> | undefined,
  actor: QueryActor
) => {
  const scope = requireScope(args);
  await ensureScopeAccess(scope, actor);
  const db = getDb();

  let itemsQuery = db.selectFrom("items").select([
    "id",
    "project_id",
    "assignee_user_id",
    "archived_at",
  ]);
  if (scope.scopeType === "project") {
    itemsQuery = itemsQuery.where("project_id", "=", scope.scopeId);
  } else {
    itemsQuery = itemsQuery.where("assignee_user_id", "=", scope.scopeId);
  }
  const items = await itemsQuery.execute();
  const itemIds = items.map((item) => item.id);

  const invalidBlockDurations = await db
    .selectFrom("scheduled_blocks")
    .select(["id", "item_id", "duration_minutes"])
    .where("duration_minutes", "<=", 0)
    .execute();

  const orphanBlocks = await db
    .selectFrom("scheduled_blocks")
    .leftJoin("items", "items.id", "scheduled_blocks.item_id")
    .select(["scheduled_blocks.id", "scheduled_blocks.item_id"])
    .where("items.id", "is", null)
    .execute();

  const orphanDependencies = await db
    .selectFrom("dependencies")
    .leftJoin("items as item", "item.id", "dependencies.item_id")
    .leftJoin("items as dep", "dep.id", "dependencies.depends_on_id")
    .select(["dependencies.id", "dependencies.item_id", "dependencies.depends_on_id"])
    .where((eb) =>
      eb.or([eb("item.id", "is", null), eb("dep.id", "is", null)])
    )
    .execute();

  let scopedDependencies: Array<{ item_id: string; depends_on_id: string }> = [];
  if (itemIds.length > 0) {
    scopedDependencies = await db
      .selectFrom("dependencies")
      .select(["item_id", "depends_on_id"])
      .where("item_id", "in", itemIds)
      .execute();
  }
  const cycles = findDependencyCycles(buildDependencyGraph(scopedDependencies));

  const assigneesNotMembers =
    scope.scopeType === "project"
      ? await db
          .selectFrom("items")
          .leftJoin(
            "project_members",
            (join) =>
              join
                .onRef("project_members.project_id", "=", "items.project_id")
                .onRef("project_members.user_id", "=", "items.assignee_user_id")
          )
          .select(["items.id", "items.assignee_user_id"])
          .where("items.project_id", "=", scope.scopeId)
          .where("items.assignee_user_id", "is not", null)
          .where("project_members.user_id", "is", null)
          .execute()
      : [];

  const archivedCount = items.filter((item) => item.archived_at !== null).length;

  return {
    scope,
    counts: {
      items: items.length,
      archived_items: archivedCount,
      invalid_block_durations: invalidBlockDurations.length,
      orphan_blocks: orphanBlocks.length,
      orphan_dependencies: orphanDependencies.length,
      dependency_cycles: cycles.length,
      assignees_not_members: assigneesNotMembers.length,
    },
    invalid_block_durations: invalidBlockDurations,
    orphan_blocks: orphanBlocks,
    orphan_dependencies: orphanDependencies,
    dependency_cycles: cycles,
    assignees_not_members: assigneesNotMembers,
  };
};

const blockedViewQuery = async (
  args: Record<string, unknown> | undefined,
  actor: QueryActor
) => {
  const scope = requireScope(args);
  await ensureScopeAccess(scope, actor);
  const db = getDb();

  let itemsQuery = db.selectFrom("items").selectAll();
  if (scope.scopeType === "project") {
    itemsQuery = itemsQuery.where("project_id", "=", scope.scopeId);
  } else {
    itemsQuery = itemsQuery.where("assignee_user_id", "=", scope.scopeId);
  }
  itemsQuery = itemsQuery.where("archived_at", "is", null);
  const items = await itemsQuery.execute();
  const itemIds = items.map((item) => item.id);

  const blocks =
    itemIds.length === 0
      ? []
      : await db
          .selectFrom("scheduled_blocks")
          .select(["id", "item_id", "start_at", "duration_minutes"])
          .where("item_id", "in", itemIds)
          .execute();

  const blockMap = summarizeBlocks(blocks);
  const ranges = new Map<string, { start: number | null; end: number | null }>();
  for (const item of items) {
    const summary = blockMap.get(item.id);
    ranges.set(item.id, {
      start: summary?.start ?? null,
      end: summary?.end ?? null,
    });
  }

  const dependencies = await db
    .selectFrom("dependencies")
    .select(["item_id", "depends_on_id", "type", "lag_minutes"])
    .where("item_id", "in", itemIds)
    .execute();

  const blockers = await db
    .selectFrom("blockers")
    .select(["item_id", "resolved_at"])
    .where("item_id", "in", itemIds)
    .execute();

  const blockedByDependencies: Array<any> = [];
  const blockedByBlockers: Array<any> = [];
  const scheduledButBlocked: Array<any> = [];

  const now = new Date();
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const unresolvedBlockers = new Set<string>();
  for (const blocker of blockers) {
    if (!blocker.resolved_at) {
      unresolvedBlockers.add(blocker.item_id);
    }
  }

  for (const dep of dependencies) {
    const statusInfo = computeDependencyStatus(dep, ranges);
    if (statusInfo.status === "violated") {
      const item = items.find((row) => row.id === dep.item_id);
      if (item) {
        blockedByDependencies.push({
          item_id: item.id,
          title: item.title,
          reason: statusInfo.reason,
          status: statusInfo.status,
        });
      }
    }
  }

  for (const item of items) {
    if (unresolvedBlockers.has(item.id)) {
      blockedByBlockers.push({
        item_id: item.id,
        title: item.title,
        reason: "Unresolved blockers",
      });
    }
  }

  const blockedByDepsSet = new Set(blockedByDependencies.map((row) => row.item_id));

  for (const block of blocks) {
    const start = parseDate(block.start_at);
    if (!start || start < now || start > nextWeek) {
      continue;
    }
    if (unresolvedBlockers.has(block.item_id) || blockedByDepsSet.has(block.item_id)) {
      const item = items.find((row) => row.id === block.item_id);
      if (item) {
        scheduledButBlocked.push({
          item_id: item.id,
          title: item.title,
          block_id: block.id,
          start_at: block.start_at,
          duration_minutes: block.duration_minutes,
          reason: unresolvedBlockers.has(block.item_id)
            ? "Unresolved blockers"
            : "Dependency not satisfied",
        });
      }
    }
  }

  return {
    blocked_by_dependencies: blockedByDependencies,
    blocked_by_blockers: blockedByBlockers,
    scheduled_but_blocked: scheduledButBlocked,
  };
};

const dueOverdueQuery = async (
  args: Record<string, unknown> | undefined,
  actor: QueryActor
) => {
  const scope = requireScope(args);
  await ensureScopeAccess(scope, actor);
  const now = parseDate(args?.now) ?? new Date();
  const days = typeof args?.days === "number" ? args.days : 7;
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const db = getDb();

  let itemsQuery = db.selectFrom("items").selectAll();
  if (scope.scopeType === "project") {
    itemsQuery = itemsQuery.where("project_id", "=", scope.scopeId);
  } else {
    itemsQuery = itemsQuery.where("assignee_user_id", "=", scope.scopeId);
  }
  itemsQuery = itemsQuery.where("archived_at", "is", null);
  itemsQuery = itemsQuery.where("status", "not in", ["done", "canceled"]);

  const items = await itemsQuery.execute();
  const overdue: Array<any> = [];
  const dueSoon: Array<any> = [];

  for (const item of items) {
    const due = parseDate(item.due_at);
    if (!due) continue;
    const diffDays = Math.ceil((due.getTime() - now.getTime()) / DAY_MS);
    if (due < now) {
      overdue.push({
        item_id: item.id,
        title: item.title,
        due_at: item.due_at,
        days_until_due: diffDays,
      });
    } else if (due <= cutoff) {
      dueSoon.push({
        item_id: item.id,
        title: item.title,
        due_at: item.due_at,
        days_until_due: diffDays,
      });
    }
  }

  return { overdue, due_soon: dueSoon };
};

export const handleQuery = async (request: QueryRequest, actor: QueryActor) => {
  switch (request.name) {
    case "projects_list":
      return projectsListQuery(actor);
    case "users_list":
      return usersListQuery(actor);
    case "collaborators_list":
      return collaboratorsListQuery(actor);
    case "assignees_list":
      return assigneesListQuery(request.args, actor);
    case "project_invite_links":
      return projectInviteLinksQuery(request.args, actor);
    case "searchItems":
      return searchItemsQuery(request.args, actor);
    case "item_details":
      return itemDetailsQuery(request.args, actor);
    case "list_view":
      return listViewQuery(request.args, actor);
    case "calendar_view":
      return calendarViewQuery(request.args, actor);
    case "execution_window":
      return executionWindowQuery(request.args, actor);
    case "integrity_report":
      return integrityReportQuery(request.args, actor);
    case "blocked_view":
      return blockedViewQuery(request.args, actor);
    case "due_overdue":
      return dueOverdueQuery(request.args, actor);
    default:
      throw new Error(`Unknown query: ${request.name}`);
  }
};
