import { randomUUID } from "crypto";
import { sql } from "kysely";
import type { Database } from "../db/kysely";
import { getDb } from "../db/connection";

export type Op = {
  op_name: string;
  op_id?: string;
  actor?: string;
  ts?: number;
  args: Record<string, unknown>;
};

export type OpsRequest = {
  ops: Op[];
};

export type OpResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

export type OpsResponse = {
  results: OpResult[];
  events: Array<Record<string, unknown>>;
};

type MemberRole = "owner" | "editor" | "viewer";

const parseDate = (value: unknown): Date | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

const getRole = async (
  db: ReturnType<typeof getDb>,
  projectId: string,
  userId: string
) => {
  const member = await db
    .selectFrom("project_members")
    .select(["role"])
    .where("project_id", "=", projectId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return (member?.role ?? null) as MemberRole | null;
};

const requireRole = (role: MemberRole | null, allowed: MemberRole[]) => {
  if (!role || !allowed.includes(role)) {
    throw new Error("FORBIDDEN");
  }
};

const ensureAssigneeInProject = async (
  db: ReturnType<typeof getDb>,
  projectId: string,
  assigneeUserId: string
) => {
  const member = await db
    .selectFrom("project_members")
    .select(["user_id"])
    .where("project_id", "=", projectId)
    .where("user_id", "=", assigneeUserId)
    .executeTakeFirst();
  if (!member) {
    throw new Error("assignee must be a project member");
  }
};

const fetchProjectDependencies = async (
  db: ReturnType<typeof getDb>,
  projectId: string
) =>
  db
    .selectFrom("dependencies")
    .innerJoin("items", "items.id", "dependencies.item_id")
    .select(["dependencies.item_id", "dependencies.depends_on_id"])
    .where("items.project_id", "=", projectId)
    .execute();

const hasPath = (
  graph: Map<string, string[]>,
  startId: string,
  targetId: string
) => {
  if (startId === targetId) {
    return true;
  }
  const stack = [startId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current === targetId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const next = graph.get(current) ?? [];
    for (const neighbor of next) {
      if (!visited.has(neighbor)) {
        stack.push(neighbor);
      }
    }
  }
  return false;
};

const ensureNoDependencyCycle = async (
  db: ReturnType<typeof getDb>,
  projectId: string,
  itemId: string,
  dependsOnId: string
) => {
  if (itemId === dependsOnId) {
    throw new Error("dependency cannot point to itself");
  }
  const edges = await fetchProjectDependencies(db, projectId);
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    const list = graph.get(edge.item_id) ?? [];
    list.push(edge.depends_on_id);
    graph.set(edge.item_id, list);
  }
  const list = graph.get(itemId) ?? [];
  list.push(dependsOnId);
  graph.set(itemId, list);
  if (hasPath(graph, dependsOnId, itemId)) {
    throw new Error("dependency cycle detected");
  }
};

const insertOpLog = async (
  db: ReturnType<typeof getDb>,
  params: {
    actorUserId: string;
    scopeType: "project" | "user";
    scopeId: string;
    op: Op;
  }
) => {
  await db
    .insertInto("op_log")
    .values({
      actor_user_id: params.actorUserId,
      scope_type: params.scopeType,
      scope_id: params.scopeId,
      op: JSON.stringify(params.op),
    })
    .execute();
};

const withProjectRole = async <T>(
  db: ReturnType<typeof getDb>,
  projectId: string,
  userId: string,
  allowed: MemberRole[],
  fn: (trx: ReturnType<typeof getDb>) => Promise<T>
) => {
  const role = await getRole(db, projectId, userId);
  requireRole(role, allowed);
  return fn(db);
};

const handleProjectCreate = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const title =
    typeof op.args.title === "string" ? op.args.title.trim() : "";
  if (!title) {
    throw new Error("title is required");
  }
  const project = await db
    .insertInto("projects")
    .values({
      owner_user_id: actorUserId,
      title,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("project_members")
    .values({
      project_id: project.id,
      user_id: actorUserId,
      role: "owner",
    })
    .execute();
  await insertOpLog(db, {
    actorUserId,
    scopeType: "project",
    scopeId: project.id,
    op,
  });
  return project;
};

const handleProjectUpdate = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const projectId =
    typeof op.args.projectId === "string" ? op.args.projectId : "";
  if (!projectId) {
    throw new Error("projectId is required");
  }
  return withProjectRole(db, projectId, actorUserId, ["owner"], async (trx) => {
    const title =
      typeof op.args.title === "string" ? op.args.title.trim() : "";
    if (!title) {
      throw new Error("title is required");
    }
    const updated = await trx
      .updateTable("projects")
      .set({ title, updated_at: sql`now()` })
      .where("id", "=", projectId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: projectId,
      op,
    });
    return updated;
  });
};

const handleProjectInviteLinkCreate = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const projectId =
    typeof op.args.projectId === "string" ? op.args.projectId : "";
  if (!projectId) {
    throw new Error("projectId is required");
  }
  const role =
    op.args.role === "viewer" || op.args.role === "editor"
      ? op.args.role
      : null;
  if (!role) {
    throw new Error("role must be viewer or editor");
  }
  return withProjectRole(db, projectId, actorUserId, ["owner"], async (trx) => {
    const token = randomUUID();
    const invite = await trx
      .insertInto("project_invite_links")
      .values({
        project_id: projectId,
        created_by_user_id: actorUserId,
        role,
        token,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: projectId,
      op,
    });
    const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(
      /\/$/,
      ""
    );
    return {
      ...invite,
      url: `${baseUrl}/join?token=${invite.token}`,
    };
  });
};

const handleProjectInviteLinkRevoke = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const inviteId =
    typeof op.args.inviteId === "string" ? op.args.inviteId : "";
  if (!inviteId) {
    throw new Error("inviteId is required");
  }
  const invite = await db
    .selectFrom("project_invite_links")
    .select(["id", "project_id"])
    .where("id", "=", inviteId)
    .executeTakeFirst();
  if (!invite) {
    throw new Error("invite link not found");
  }
  return withProjectRole(db, invite.project_id, actorUserId, ["owner"], async (trx) => {
    const updated = await trx
      .updateTable("project_invite_links")
      .set({ revoked_at: sql`now()` })
      .where("id", "=", inviteId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: invite.project_id,
      op,
    });
    return updated;
  });
};

const upsertCollaborator = async (
  db: ReturnType<typeof getDb>,
  ownerUserId: string,
  collaboratorUserId: string
) => {
  await db
    .insertInto("collaborator_contacts")
    .values({
      owner_user_id: ownerUserId,
      collaborator_user_id: collaboratorUserId,
      status: "active",
      last_interaction_at: sql`now()`,
    })
    .onConflict((oc) =>
      oc
        .columns(["owner_user_id", "collaborator_user_id"])
        .doUpdateSet({
          status: "active",
          last_interaction_at: sql`now()`,
        })
    )
    .execute();
};

const handleProjectInviteLinkAccept = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const token = typeof op.args.token === "string" ? op.args.token : "";
  if (!token) {
    throw new Error("token is required");
  }
  const invite = await db
    .selectFrom("project_invite_links")
    .select(["id", "project_id", "created_by_user_id", "role", "revoked_at"])
    .where("token", "=", token)
    .executeTakeFirst();
  if (!invite || invite.revoked_at) {
    throw new Error("invite link is invalid");
  }
  const project = await db
    .selectFrom("projects")
    .select(["id", "owner_user_id"])
    .where("id", "=", invite.project_id)
    .executeTakeFirst();
  if (!project) {
    throw new Error("project not found");
  }
  const result = await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("project_members")
      .values({
        project_id: invite.project_id,
        user_id: actorUserId,
        role: invite.role,
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "user_id"]).doNothing()
      )
      .execute();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: invite.project_id,
      op,
    });
    return invite;
  });
  await upsertCollaborator(db, project.owner_user_id, actorUserId);
  await upsertCollaborator(db, actorUserId, project.owner_user_id);
  if (invite.created_by_user_id && invite.created_by_user_id !== project.owner_user_id) {
    await upsertCollaborator(db, invite.created_by_user_id, actorUserId);
    await upsertCollaborator(db, actorUserId, invite.created_by_user_id);
  }
  return {
    invite_id: result.id,
    project_id: result.project_id,
    assignee_user_id: actorUserId,
  };
};

const handleItemCreate = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const projectId =
    typeof op.args.projectId === "string" ? op.args.projectId : "";
  if (!projectId) {
    throw new Error("projectId is required");
  }
  return withProjectRole(db, projectId, actorUserId, ["owner", "editor"], async (trx) => {
    const type =
      typeof op.args.type === "string" ? op.args.type : "";
    if (!["milestone", "task", "subtask"].includes(type)) {
      throw new Error("invalid type");
    }
    const title =
      typeof op.args.title === "string" ? op.args.title.trim() : "";
    if (!title) {
      throw new Error("title is required");
    }
    const parentId =
      typeof op.args.parentId === "string" ? op.args.parentId : null;
    const status =
      typeof op.args.status === "string" ? op.args.status : "backlog";
    const priority =
      typeof op.args.priority === "number" ? op.args.priority : 0;
    const assigneeUserId =
      typeof op.args.assigneeUserId === "string" ? op.args.assigneeUserId : null;
    const dueAt = parseDate(op.args.dueAt);
    const estimateMinutes =
      typeof op.args.estimateMinutes === "number"
        ? op.args.estimateMinutes
        : 0;
    const estimateMode =
      typeof op.args.estimateMode === "string" ? op.args.estimateMode : "manual";
    const notes =
      typeof op.args.notes === "string" ? op.args.notes : null;

    if (assigneeUserId) {
      await ensureAssigneeInProject(trx, projectId, assigneeUserId);
    }

    const inserted = await trx
      .insertInto("items")
      .values({
        project_id: projectId,
        parent_id: parentId,
        type: type as Database["items"]["type"],
        title,
        status,
        priority,
        assignee_user_id: assigneeUserId,
        due_at: dueAt,
        completed_at: status === "done" ? sql`now()` : null,
        estimate_minutes: estimateMinutes,
        estimate_mode: estimateMode as Database["items"]["estimate_mode"],
        notes,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: projectId,
      op,
    });
    return inserted;
  });
};

const handleItemUpdate = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const itemId = typeof op.args.itemId === "string" ? op.args.itemId : "";
  if (!itemId) {
    throw new Error("itemId is required");
  }
  const patch =
    typeof op.args.patch === "object" && op.args.patch
      ? (op.args.patch as Record<string, unknown>)
      : null;
  if (!patch) {
    throw new Error("patch is required");
  }
    const item = await db
      .selectFrom("items")
      .select(["project_id", "assignee_user_id"])
      .where("id", "=", itemId)
      .executeTakeFirst();
  if (!item) {
    throw new Error("item not found");
  }
  return withProjectRole(db, item.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    const update: Partial<Database["items"]> = {};
    if (typeof patch.title === "string") {
      update.title = patch.title;
    }
    if (typeof patch.status === "string") {
      update.status = patch.status;
      if (patch.status === "done") {
        update.completed_at = sql`COALESCE(completed_at, now())` as unknown as string;
      } else {
        update.completed_at = null;
      }
    }
    if (typeof patch.priority === "number") {
      update.priority = patch.priority;
    }
    if (typeof patch.assigneeUserId === "string" || patch.assigneeUserId === null) {
      if (typeof patch.assigneeUserId === "string") {
        await ensureAssigneeInProject(trx, item.project_id, patch.assigneeUserId);
      }
      update.assignee_user_id =
        typeof patch.assigneeUserId === "string" ? patch.assigneeUserId : null;
    }
    if (patch.dueAt !== undefined) {
      update.due_at = parseDate(patch.dueAt);
    }
    if (typeof patch.estimateMinutes === "number") {
      update.estimate_minutes = patch.estimateMinutes;
    }
    if (typeof patch.estimateMode === "string") {
      update.estimate_mode = patch.estimateMode as Database["items"]["estimate_mode"];
    }
    if (typeof patch.notes === "string" || patch.notes === null) {
      update.notes = typeof patch.notes === "string" ? patch.notes : null;
    }
    if (typeof patch.parentId === "string" || patch.parentId === null) {
      update.parent_id = typeof patch.parentId === "string" ? patch.parentId : null;
    }

    const updated = await trx
      .updateTable("items")
      .set({ ...update, updated_at: sql`now()` })
      .where("id", "=", itemId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: item.project_id,
      op,
    });
    return updated;
  });
};

const handleItemSetStatus = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const itemId = typeof op.args.itemId === "string" ? op.args.itemId : "";
  const status = typeof op.args.status === "string" ? op.args.status : "";
  if (!itemId || !status) {
    throw new Error("itemId and status are required");
  }
  const item = await db
    .selectFrom("items")
    .select(["project_id"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) {
    throw new Error("item not found");
  }
  return withProjectRole(db, item.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    const updates: Partial<Database["items"]> = { status };
    if (status === "done") {
      updates.completed_at = sql`COALESCE(completed_at, now())` as unknown as string;
    } else {
      updates.completed_at = null;
    }
    const updated = await trx
      .updateTable("items")
      .set({ ...updates, updated_at: sql`now()` })
      .where("id", "=", itemId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: item.project_id,
      op,
    });
    return updated;
  });
};

const handleItemArchive = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const itemId = typeof op.args.itemId === "string" ? op.args.itemId : "";
  if (!itemId) {
    throw new Error("itemId is required");
  }
  const item = await db
    .selectFrom("items")
    .select(["project_id"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) {
    throw new Error("item not found");
  }
  return withProjectRole(db, item.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    const updated = await trx
      .updateTable("items")
      .set({ archived_at: sql`now()`, updated_at: sql`now()` })
      .where("id", "=", itemId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: item.project_id,
      op,
    });
    return updated;
  });
};

const handleItemRestore = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const itemId = typeof op.args.itemId === "string" ? op.args.itemId : "";
  if (!itemId) {
    throw new Error("itemId is required");
  }
  const item = await db
    .selectFrom("items")
    .select(["project_id"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) {
    throw new Error("item not found");
  }
  return withProjectRole(db, item.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    const updated = await trx
      .updateTable("items")
      .set({ archived_at: null, updated_at: sql`now()` })
      .where("id", "=", itemId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: item.project_id,
      op,
    });
    return updated;
  });
};

const parseIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((id) => typeof id === "string" && id.trim().length > 0);
};

const requireProjectRoles = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  projectIds: string[],
  allowed: MemberRole[]
) => {
  for (const projectId of projectIds) {
    const role = await getRole(db, projectId, actorUserId);
    requireRole(role, allowed);
  }
};

const handleItemDelete = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const itemId = typeof op.args.itemId === "string" ? op.args.itemId : "";
  if (!itemId) {
    throw new Error("itemId is required");
  }
  const item = await db
    .selectFrom("items")
    .select(["project_id"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) {
    throw new Error("item not found");
  }
  return withProjectRole(db, item.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    await trx.deleteFrom("items").where("id", "=", itemId).execute();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: item.project_id,
      op,
    });
    return { id: itemId };
  });
};

const handleItemsArchiveMany = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const ids = parseIds(op.args.ids);
  if (ids.length === 0) {
    throw new Error("ids is required");
  }
  const items = await db
    .selectFrom("items")
    .select(["id", "project_id"])
    .where("id", "in", ids)
    .execute();
  const projectIds = Array.from(new Set(items.map((item) => item.project_id)));
  await requireProjectRoles(db, actorUserId, projectIds, ["owner", "editor"]);
  await db
    .updateTable("items")
    .set({ archived_at: sql`now()`, updated_at: sql`now()` })
    .where("id", "in", ids)
    .execute();
  for (const projectId of projectIds) {
    await insertOpLog(db, {
      actorUserId,
      scopeType: "project",
      scopeId: projectId,
      op,
    });
  }
  return { ids };
};

const handleItemsRestoreMany = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const ids = parseIds(op.args.ids);
  if (ids.length === 0) {
    throw new Error("ids is required");
  }
  const items = await db
    .selectFrom("items")
    .select(["id", "project_id"])
    .where("id", "in", ids)
    .execute();
  const projectIds = Array.from(new Set(items.map((item) => item.project_id)));
  await requireProjectRoles(db, actorUserId, projectIds, ["owner", "editor"]);
  await db
    .updateTable("items")
    .set({ archived_at: null, updated_at: sql`now()` })
    .where("id", "in", ids)
    .execute();
  for (const projectId of projectIds) {
    await insertOpLog(db, {
      actorUserId,
      scopeType: "project",
      scopeId: projectId,
      op,
    });
  }
  return { ids };
};

const handleItemsDeleteMany = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const ids = parseIds(op.args.ids);
  if (ids.length === 0) {
    throw new Error("ids is required");
  }
  const items = await db
    .selectFrom("items")
    .select(["id", "project_id"])
    .where("id", "in", ids)
    .execute();
  const projectIds = Array.from(new Set(items.map((item) => item.project_id)));
  await requireProjectRoles(db, actorUserId, projectIds, ["owner", "editor"]);
  await db.deleteFrom("items").where("id", "in", ids).execute();
  for (const projectId of projectIds) {
    await insertOpLog(db, {
      actorUserId,
      scopeType: "project",
      scopeId: projectId,
      op,
    });
  }
  return { ids };
};

const handleScheduledBlockCreate = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const itemId = typeof op.args.itemId === "string" ? op.args.itemId : "";
  const startAt = parseDate(op.args.startAt);
  const durationMinutes =
    typeof op.args.durationMinutes === "number" ? op.args.durationMinutes : null;
  if (!itemId || !startAt) {
    throw new Error("itemId and startAt are required");
  }
  if (!durationMinutes || durationMinutes <= 0) {
    throw new Error("duration_minutes must be greater than 0");
  }
  const item = await db
    .selectFrom("items")
    .select(["project_id"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) {
    throw new Error("item not found");
  }
  return withProjectRole(db, item.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    const inserted = await trx
      .insertInto("scheduled_blocks")
      .values({
        item_id: itemId,
        start_at: startAt,
        duration_minutes: durationMinutes,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: item.project_id,
      op,
    });
    return {
      ...inserted,
      project_id: item.project_id,
      assignee_user_id: item.assignee_user_id,
    };
  });
};

const handleScheduledBlockMove = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const blockId = typeof op.args.blockId === "string" ? op.args.blockId : "";
  const startAt = parseDate(op.args.startAt);
  if (!blockId || !startAt) {
    throw new Error("invalid scheduled_block.move args");
  }
  const block = await db
    .selectFrom("scheduled_blocks")
    .innerJoin("items", "items.id", "scheduled_blocks.item_id")
    .select(["items.project_id", "items.assignee_user_id"])
    .where("scheduled_blocks.id", "=", blockId)
    .executeTakeFirst();
  if (!block) {
    throw new Error("block not found");
  }
  return withProjectRole(db, block.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    const updated = await trx
      .updateTable("scheduled_blocks")
      .set({ start_at: startAt, updated_at: sql`now()` })
      .where("id", "=", blockId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: block.project_id,
      op,
    });
    return {
      ...updated,
      project_id: block.project_id,
      assignee_user_id: block.assignee_user_id,
    };
  });
};

const handleScheduledBlockResize = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const blockId = typeof op.args.blockId === "string" ? op.args.blockId : "";
  const durationMinutes =
    typeof op.args.durationMinutes === "number" ? op.args.durationMinutes : null;
  if (!blockId) {
    throw new Error("blockId is required");
  }
  if (!durationMinutes || durationMinutes <= 0) {
    throw new Error("duration_minutes must be greater than 0");
  }
  const block = await db
    .selectFrom("scheduled_blocks")
    .innerJoin("items", "items.id", "scheduled_blocks.item_id")
    .select(["items.project_id", "items.assignee_user_id"])
    .where("scheduled_blocks.id", "=", blockId)
    .executeTakeFirst();
  if (!block) {
    throw new Error("block not found");
  }
  return withProjectRole(db, block.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    const updated = await trx
      .updateTable("scheduled_blocks")
      .set({ duration_minutes: durationMinutes, updated_at: sql`now()` })
      .where("id", "=", blockId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: block.project_id,
      op,
    });
    return {
      ...updated,
      project_id: block.project_id,
      assignee_user_id: block.assignee_user_id,
    };
  });
};

const handleScheduledBlockDelete = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const blockId = typeof op.args.blockId === "string" ? op.args.blockId : "";
  if (!blockId) {
    throw new Error("blockId is required");
  }
  const block = await db
    .selectFrom("scheduled_blocks")
    .innerJoin("items", "items.id", "scheduled_blocks.item_id")
    .select(["items.project_id", "items.assignee_user_id"])
    .where("scheduled_blocks.id", "=", blockId)
    .executeTakeFirst();
  if (!block) {
    throw new Error("block not found");
  }
  return withProjectRole(db, block.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    await trx.deleteFrom("scheduled_blocks").where("id", "=", blockId).execute();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: block.project_id,
      op,
    });
    return {
      deleted: true,
      project_id: block.project_id,
      assignee_user_id: block.assignee_user_id,
    };
  });
};

const handleDependencyAdd = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const itemId = typeof op.args.itemId === "string" ? op.args.itemId : "";
  const dependsOnId =
    typeof op.args.dependsOnId === "string" ? op.args.dependsOnId : "";
  if (!itemId || !dependsOnId) {
    throw new Error("itemId and dependsOnId are required");
  }
  const type =
    typeof op.args.type === "string" ? op.args.type : "FS";
  const lagMinutes =
    typeof op.args.lagMinutes === "number" ? op.args.lagMinutes : 0;
  const item = await db
    .selectFrom("items")
    .select(["project_id", "assignee_user_id"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) {
    throw new Error("item not found");
  }
  const dependencyItem = await db
    .selectFrom("items")
    .select(["project_id"])
    .where("id", "=", dependsOnId)
    .executeTakeFirst();
  if (!dependencyItem) {
    throw new Error("dependsOn item not found");
  }
  if (dependencyItem.project_id !== item.project_id) {
    throw new Error("dependency must be within the same project");
  }
  return withProjectRole(db, item.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    await ensureNoDependencyCycle(trx, item.project_id, itemId, dependsOnId);
    await trx
      .insertInto("dependencies")
      .values({
        item_id: itemId,
        depends_on_id: dependsOnId,
        type: type as Database["dependencies"]["type"],
        lag_minutes: lagMinutes,
      })
      .execute();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: item.project_id,
      op,
    });
    return {
      created: true,
      project_id: item.project_id,
      assignee_user_id: item.assignee_user_id,
    };
  });
};

const handleDependencyRemove = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const itemId = typeof op.args.itemId === "string" ? op.args.itemId : "";
  const dependsOnId =
    typeof op.args.dependsOnId === "string" ? op.args.dependsOnId : "";
  if (!itemId || !dependsOnId) {
    throw new Error("itemId and dependsOnId are required");
  }
  const item = await db
    .selectFrom("items")
    .select(["project_id", "assignee_user_id"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) {
    throw new Error("item not found");
  }
  return withProjectRole(db, item.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    await trx
      .deleteFrom("dependencies")
      .where("item_id", "=", itemId)
      .where("depends_on_id", "=", dependsOnId)
      .execute();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: item.project_id,
      op,
    });
    return {
      deleted: true,
      project_id: item.project_id,
      assignee_user_id: item.assignee_user_id,
    };
  });
};

const handleDependencyUpdate = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const edgeId = typeof op.args.edgeId === "string" ? op.args.edgeId : "";
  const type = typeof op.args.type === "string" ? op.args.type : null;
  const lagMinutes =
    typeof op.args.lagMinutes === "number" ? op.args.lagMinutes : null;
  if (!edgeId) {
    throw new Error("edgeId is required");
  }
  if (!type && lagMinutes === null) {
    throw new Error("type or lagMinutes required");
  }
  const edge = await db
    .selectFrom("dependencies")
    .innerJoin("items", "items.id", "dependencies.item_id")
    .select(["dependencies.id", "items.project_id"])
    .where("dependencies.id", "=", edgeId)
    .executeTakeFirst();
  if (!edge) {
    throw new Error("dependency not found");
  }
  return withProjectRole(db, edge.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    const update: Record<string, unknown> = {};
    if (type) {
      update.type = type;
    }
    if (lagMinutes !== null) {
      update.lag_minutes = lagMinutes;
    }
    const updated = await trx
      .updateTable("dependencies")
      .set(update)
      .where("id", "=", edgeId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: edge.project_id,
      op,
    });
    return updated;
  });
};

const handleDependencyDelete = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const edgeId = typeof op.args.edgeId === "string" ? op.args.edgeId : "";
  if (!edgeId) {
    throw new Error("edgeId is required");
  }
  const edge = await db
    .selectFrom("dependencies")
    .innerJoin("items", "items.id", "dependencies.item_id")
    .select(["dependencies.id", "items.project_id"])
    .where("dependencies.id", "=", edgeId)
    .executeTakeFirst();
  if (!edge) {
    throw new Error("dependency not found");
  }
  return withProjectRole(db, edge.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    await trx.deleteFrom("dependencies").where("id", "=", edgeId).execute();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: edge.project_id,
      op,
    });
    return { id: edgeId };
  });
};

const handleBlockerAdd = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const itemId = typeof op.args.itemId === "string" ? op.args.itemId : "";
  const text = typeof op.args.text === "string" ? op.args.text.trim() : "";
  const kind = typeof op.args.kind === "string" ? op.args.kind : "general";
  if (!itemId || !text) {
    throw new Error("itemId and text are required");
  }
  const item = await db
    .selectFrom("items")
    .select(["project_id", "assignee_user_id"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) {
    throw new Error("item not found");
  }
  return withProjectRole(db, item.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    const inserted = await trx
      .insertInto("blockers")
      .values({
        item_id: itemId,
        kind,
        text,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: item.project_id,
      op,
    });
    return {
      ...inserted,
      project_id: item.project_id,
      assignee_user_id: item.assignee_user_id,
    };
  });
};

const handleBlockerResolve = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const blockerId =
    typeof op.args.blockerId === "string" ? op.args.blockerId : "";
  if (!blockerId) {
    throw new Error("blockerId is required");
  }
  const blocker = await db
    .selectFrom("blockers")
    .innerJoin("items", "items.id", "blockers.item_id")
    .select(["items.project_id", "items.assignee_user_id"])
    .where("blockers.id", "=", blockerId)
    .executeTakeFirst();
  if (!blocker) {
    throw new Error("blocker not found");
  }
  return withProjectRole(db, blocker.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    const updated = await trx
      .updateTable("blockers")
      .set({ resolved_at: sql`now()` })
      .where("id", "=", blockerId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: blocker.project_id,
      op,
    });
    return {
      ...updated,
      project_id: blocker.project_id,
      assignee_user_id: blocker.assignee_user_id,
    };
  });
};

const handleTimeEntryStart = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const itemId = typeof op.args.itemId === "string" ? op.args.itemId : "";
  if (!itemId) {
    throw new Error("itemId is required");
  }
  const item = await db
    .selectFrom("items")
    .select(["project_id", "assignee_user_id"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) {
    throw new Error("item not found");
  }
  return withProjectRole(db, item.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    const inserted = await trx
      .insertInto("time_entries")
      .values({
        item_id: itemId,
        user_id: actorUserId,
        start_at: sql`now()`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: item.project_id,
      op,
    });
    return {
      ...inserted,
      project_id: item.project_id,
      assignee_user_id: item.assignee_user_id,
    };
  });
};

const handleTimeEntryStop = async (
  db: ReturnType<typeof getDb>,
  actorUserId: string,
  op: Op
) => {
  const timeEntryId =
    typeof op.args.timeEntryId === "string" ? op.args.timeEntryId : "";
  if (!timeEntryId) {
    throw new Error("timeEntryId is required");
  }
  const entry = await db
    .selectFrom("time_entries")
    .innerJoin("items", "items.id", "time_entries.item_id")
    .select(["items.project_id", "items.assignee_user_id", "time_entries.start_at"])
    .where("time_entries.id", "=", timeEntryId)
    .executeTakeFirst();
  if (!entry) {
    throw new Error("time entry not found");
  }
  return withProjectRole(db, entry.project_id, actorUserId, ["owner", "editor"], async (trx) => {
    const updated = await trx
      .updateTable("time_entries")
      .set({
        end_at: sql`now()`,
        duration_minutes: sql`EXTRACT(EPOCH FROM (now() - ${entry.start_at})) / 60`,
      })
      .where("id", "=", timeEntryId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertOpLog(trx, {
      actorUserId,
      scopeType: "project",
      scopeId: entry.project_id,
      op,
    });
    return {
      ...updated,
      project_id: entry.project_id,
      assignee_user_id: entry.assignee_user_id,
    };
  });
};

export const applyOps = async (actorUserId: string, ops: Op[]) => {
  const db = getDb();
  const results: OpResult[] = [];
  const events: Array<{ scopeType: "project" | "user"; scopeId: string; reason: string; at: string }> = [];

  const addEvent = (scopeType: "project" | "user", scopeId: string) => {
    events.push({
      scopeType,
      scopeId,
      reason: "ops_applied",
      at: new Date().toISOString(),
    });
  };

  for (const op of ops) {
    try {
      let data: unknown;
      switch (op.op_name) {
        case "project.create":
          data = await handleProjectCreate(db, actorUserId, op);
          break;
        case "project.update":
          data = await handleProjectUpdate(db, actorUserId, op);
          break;
        case "project.invite_link_create":
          data = await handleProjectInviteLinkCreate(db, actorUserId, op);
          break;
        case "project.invite_link_revoke":
          data = await handleProjectInviteLinkRevoke(db, actorUserId, op);
          break;
        case "project.invite_link_accept":
          data = await handleProjectInviteLinkAccept(db, actorUserId, op);
          break;
        case "item.create":
          data = await handleItemCreate(db, actorUserId, op);
          break;
        case "item.update":
          data = await handleItemUpdate(db, actorUserId, op);
          break;
        case "item.set_status":
          data = await handleItemSetStatus(db, actorUserId, op);
          break;
        case "item.archive":
          data = await handleItemArchive(db, actorUserId, op);
          break;
        case "item.restore":
          data = await handleItemRestore(db, actorUserId, op);
          break;
        case "item.delete":
          data = await handleItemDelete(db, actorUserId, op);
          break;
        case "items.archive_many":
          data = await handleItemsArchiveMany(db, actorUserId, op);
          break;
        case "items.restore_many":
          data = await handleItemsRestoreMany(db, actorUserId, op);
          break;
        case "items.delete_many":
          data = await handleItemsDeleteMany(db, actorUserId, op);
          break;
        case "scheduled_block.create":
          data = await handleScheduledBlockCreate(db, actorUserId, op);
          break;
        case "scheduled_block.move":
          data = await handleScheduledBlockMove(db, actorUserId, op);
          break;
        case "scheduled_block.resize":
          data = await handleScheduledBlockResize(db, actorUserId, op);
          break;
        case "scheduled_block.delete":
          data = await handleScheduledBlockDelete(db, actorUserId, op);
          break;
        case "dependency.add":
          data = await handleDependencyAdd(db, actorUserId, op);
          break;
        case "dependency.remove":
          data = await handleDependencyRemove(db, actorUserId, op);
          break;
        case "dependency.update":
          data = await handleDependencyUpdate(db, actorUserId, op);
          break;
        case "dependency.delete":
          data = await handleDependencyDelete(db, actorUserId, op);
          break;
        case "blocker.add":
          data = await handleBlockerAdd(db, actorUserId, op);
          break;
        case "blocker.resolve":
          data = await handleBlockerResolve(db, actorUserId, op);
          break;
        case "time_entry.start":
          data = await handleTimeEntryStart(db, actorUserId, op);
          break;
        case "time_entry.stop":
          data = await handleTimeEntryStop(db, actorUserId, op);
          break;
        default:
          throw new Error(`unknown op: ${op.op_name}`);
      }
      results.push({ ok: true, data });
      const record = data as Record<string, unknown> | null;
      const projectId =
        typeof record?.project_id === "string"
          ? (record.project_id as string)
          : typeof (op.args as Record<string, unknown>)?.projectId === "string"
            ? ((op.args as Record<string, unknown>).projectId as string)
            : op.op_name.startsWith("project.") && typeof record?.id === "string"
              ? (record.id as string)
              : null;
      const assigneeId =
        typeof record?.assignee_user_id === "string"
          ? (record.assignee_user_id as string)
          : typeof (op.args as Record<string, unknown>)?.assigneeUserId === "string"
            ? (op.args as Record<string, unknown>).assigneeUserId as string
            : null;
      if (projectId) {
        addEvent("project", projectId);
      }
      if (assigneeId) {
        addEvent("user", assigneeId);
      }
    } catch (error) {
      results.push({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return { results, events };
};
