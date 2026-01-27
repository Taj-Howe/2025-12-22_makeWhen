import { sql, type Kysely } from "kysely";
import type { Database } from "../db/schema";

type OpEnvelope = {
  opName: string;
  args?: Record<string, unknown>;
  actor?: { type: string; id?: string };
};

type ApplyOpsInput = {
  userId: string;
  ops: OpEnvelope[];
};

type ApplyOpsResult = {
  results: { opName: string; ok: boolean; result?: unknown }[];
  affectedProjectIds: Set<string>;
  affectedUserIds: Set<string>;
};

const nowSql = sql`now()`;

const asString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const ensureProjectRole = async (
  trx: Kysely<Database>,
  projectId: string,
  userId: string
) => {
  const membership = await trx
    .selectFrom("project_members")
    .select(["role"])
    .where("project_id", "=", projectId)
    .where("user_id", "=", userId)
    .executeTakeFirst();

  if (!membership) {
    throw new Error("forbidden");
  }

  return membership.role;
};

const ensureEditor = (role: string) => {
  if (role !== "owner" && role !== "editor") {
    throw new Error("forbidden");
  }
};

const ensureAssignee = async (
  trx: Kysely<Database>,
  projectId: string,
  assigneeUserId: string | null
) => {
  if (!assigneeUserId) return;
  const member = await trx
    .selectFrom("project_members")
    .select(["user_id"])
    .where("project_id", "=", projectId)
    .where("user_id", "=", assigneeUserId)
    .executeTakeFirst();
  if (!member) {
    throw new Error("assignee must be a project member");
  }
};

const fetchItem = async (trx: Kysely<Database>, itemId: string) => {
  const item = await trx
    .selectFrom("items")
    .select([
      "id",
      "project_id",
      "parent_id",
      "archived_at",
      "status",
      "assignee_user_id",
    ])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item) {
    throw new Error("item not found");
  }
  return item;
};

const fetchProjectIdForBlock = async (
  trx: Kysely<Database>,
  blockId: string
) => {
  const row = await trx
    .selectFrom("scheduled_blocks")
    .innerJoin("items", "items.id", "scheduled_blocks.item_id")
    .select([
      "scheduled_blocks.id",
      "items.id as item_id",
      "items.project_id",
      "items.archived_at",
      "items.assignee_user_id",
    ])
    .where("scheduled_blocks.id", "=", blockId)
    .executeTakeFirst();
  if (!row) {
    throw new Error("scheduled block not found");
  }
  if (row.archived_at) {
    throw new Error("cannot modify archived item blocks");
  }
  return row;
};

const getDescendantIds = async (trx: Kysely<Database>, rootIds: string[]) => {
  if (rootIds.length === 0) return [];
  const rows = await trx
    .withRecursive("descendants", (db) =>
      db
        .selectFrom("items")
        .select(["id"])
        .where("id", "in", rootIds)
        .unionAll((qb) =>
          qb
            .selectFrom("items")
            .innerJoin("descendants", "items.parent_id", "descendants.id")
            .select(["items.id"])
        )
    )
    .selectFrom("descendants")
    .select(["id"])
    .execute();
  return rows.map((row) => row.id);
};

const dependencyCreatesCycle = async (
  trx: Kysely<Database>,
  itemId: string,
  dependsOnId: string
) => {
  if (itemId === dependsOnId) return true;
  const rows = await trx
    .withRecursive("dep_path", (db) =>
      db
        .selectFrom("dependencies")
        .select(["depends_on_id as id"])
        .where("item_id", "=", dependsOnId)
        .unionAll((qb) =>
          qb
            .selectFrom("dependencies")
            .innerJoin("dep_path", "dependencies.item_id", "dep_path.id")
            .select(["dependencies.depends_on_id as id"])
        )
    )
    .selectFrom("dep_path")
    .select(["id"])
    .where("id", "=", itemId)
    .executeTakeFirst();

  return !!rows;
};

const deleteItems = async (trx: Kysely<Database>, ids: string[]) => {
  if (ids.length === 0) return;
  await trx
    .deleteFrom("dependencies")
    .where((eb) =>
      eb.or([
        eb("item_id", "in", ids),
        eb("depends_on_id", "in", ids),
      ])
    )
    .execute();
  await trx.deleteFrom("blockers").where("item_id", "in", ids).execute();
  await trx
    .deleteFrom("scheduled_blocks")
    .where("item_id", "in", ids)
    .execute();
  await trx.deleteFrom("time_entries").where("item_id", "in", ids).execute();
  await trx.deleteFrom("items").where("id", "in", ids).execute();
};

const logOp = async (
  trx: Kysely<Database>,
  userId: string,
  projectId: string | null,
  opName: string,
  args: unknown
) => {
  await trx
    .insertInto("op_log")
    .values({
      user_id: userId,
      project_id: projectId,
      op_name: opName,
      op_json: { opName, args },
    })
    .execute();
};

export const applyOps = async (
  db: Kysely<Database>,
  input: ApplyOpsInput
): Promise<ApplyOpsResult> => {
  const affectedProjectIds = new Set<string>();
  const affectedUserIds = new Set<string>();

  const results = await db.transaction().execute(async (trx) => {
    const output: { opName: string; ok: boolean; result?: unknown }[] = [];

    for (const op of input.ops) {
      const opName = op.opName;
      const args = (op.args ?? {}) as Record<string, unknown>;
      const userId = input.userId;

      switch (opName) {
        case "project.create": {
          const title = asString(args.title);
          assert(title, "project title is required");
          const project = await trx
            .insertInto("projects")
            .values({
              title,
              owner_user_id: userId,
              created_at: nowSql,
              updated_at: nowSql,
            })
            .returning(["id", "title"])
            .executeTakeFirstOrThrow();
          await trx
            .insertInto("project_members")
            .values({
              project_id: project.id,
              user_id: userId,
              role: "owner",
            })
            .execute();
          await logOp(trx, userId, project.id, opName, args);
          affectedProjectIds.add(project.id);
          output.push({ opName, ok: true, result: project });
          break;
        }
        case "project.update": {
          const projectId = asString(args.projectId);
          const title = asString(args.title);
          assert(projectId, "projectId is required");
          assert(title, "project title is required");
          const role = await ensureProjectRole(trx, projectId, userId);
          ensureEditor(role);
          const project = await trx
            .updateTable("projects")
            .set({ title, updated_at: nowSql })
            .where("id", "=", projectId)
            .returning(["id", "title"])
            .executeTakeFirstOrThrow();
          await logOp(trx, userId, projectId, opName, args);
          affectedProjectIds.add(projectId);
          output.push({ opName, ok: true, result: project });
          break;
        }
        case "project.member_add":
        case "project.member_update":
        case "project.member_remove": {
          const projectId = asString(args.projectId);
          const memberId = asString(args.userId);
          assert(projectId, "projectId is required");
          assert(memberId, "userId is required");
          const role = await ensureProjectRole(trx, projectId, userId);
          if (role !== "owner") {
            throw new Error("forbidden");
          }
          if (opName === "project.member_add") {
            const memberRole = asString(args.role) ?? "viewer";
            await trx
              .insertInto("project_members")
              .values({
                project_id: projectId,
                user_id: memberId,
                role: memberRole,
              })
              .onConflict((oc) =>
                oc.columns(["project_id", "user_id"]).doUpdateSet({
                  role: memberRole,
                })
              )
              .execute();
          } else if (opName === "project.member_update") {
            const memberRole = asString(args.role);
            assert(memberRole, "role is required");
            await trx
              .updateTable("project_members")
              .set({ role: memberRole })
              .where("project_id", "=", projectId)
              .where("user_id", "=", memberId)
              .execute();
          } else {
            await trx
              .deleteFrom("project_members")
              .where("project_id", "=", projectId)
              .where("user_id", "=", memberId)
              .execute();
          }
          await logOp(trx, userId, projectId, opName, args);
          affectedProjectIds.add(projectId);
          output.push({ opName, ok: true, result: { projectId, userId: memberId } });
          break;
        }
        case "item.create": {
          const projectId = asString(args.projectId);
          const title = asString(args.title);
          const type = asString(args.type);
          assert(projectId, "projectId is required");
          assert(title, "title is required");
          assert(type, "type is required");
          if (!["milestone", "task", "subtask"].includes(type)) {
            throw new Error("invalid item type");
          }
          const role = await ensureProjectRole(trx, projectId, userId);
          ensureEditor(role);
          const parentId = asString(args.parentId);
          if (parentId) {
            const parent = await trx
              .selectFrom("items")
              .select(["id", "project_id"])
              .where("id", "=", parentId)
              .executeTakeFirst();
            if (!parent || parent.project_id !== projectId) {
              throw new Error("parent item not found");
            }
          }
          const status = asString(args.status) ?? "backlog";
          const priority = asNumber(args.priority) ?? 0;
          const dueAt = asString(args.dueAt) ?? asString(args.due_at);
          const estimateMode = asString(args.estimateMode) ?? "manual";
          const estimateMinutes = asNumber(args.estimateMinutes) ?? 0;
          const assigneeUserId =
            asString(args.assigneeUserId) ?? asString(args.assignee_user_id);
          assert(
            ["manual", "rollup"].includes(estimateMode),
            "estimateMode must be manual or rollup"
          );
          assert(
            estimateMinutes >= 0,
            "estimateMinutes must be zero or positive"
          );
          await ensureAssignee(trx, projectId, assigneeUserId);

          const item = await trx
            .insertInto("items")
            .values({
              project_id: projectId,
              parent_id: parentId,
              type,
              title,
              status,
              priority,
              due_at: dueAt,
              completed_at: null,
              archived_at: null,
              assignee_user_id: assigneeUserId,
              estimate_mode: estimateMode,
              estimate_minutes: estimateMinutes,
              sequence_rank: 0,
              health: asString(args.health),
              notes: asString(args.notes),
              created_at: nowSql,
              updated_at: nowSql,
            })
            .returning(["id", "project_id", "title"])
            .executeTakeFirstOrThrow();
          await logOp(trx, userId, projectId, opName, args);
          affectedProjectIds.add(projectId);
          if (assigneeUserId) {
            affectedUserIds.add(assigneeUserId);
          }
          output.push({ opName, ok: true, result: item });
          break;
        }
        case "item.update": {
          const itemId = asString(args.itemId);
          const patch = (args.patch ?? {}) as Record<string, unknown>;
          assert(itemId, "itemId is required");
          const item = await fetchItem(trx, itemId);
          const role = await ensureProjectRole(trx, item.project_id, userId);
          ensureEditor(role);

          const update: Record<string, unknown> = {};
          if (patch.title !== undefined) {
            const title = asString(patch.title);
            assert(title, "title is required");
            update.title = title;
          }
          if (patch.priority !== undefined) {
            const priority = asNumber(patch.priority);
            assert(priority !== null, "priority must be a number");
            update.priority = priority;
          }
          if (patch.due_at !== undefined) update.due_at = asString(patch.due_at);
          if (patch.dueAt !== undefined) update.due_at = asString(patch.dueAt);
          if (patch.estimate_mode !== undefined) {
            const mode = asString(patch.estimate_mode);
            assert(mode, "estimate_mode is required");
            assert(
              ["manual", "rollup"].includes(mode),
              "estimate_mode must be manual or rollup"
            );
            update.estimate_mode = mode;
          }
          if (patch.estimateMode !== undefined) {
            const mode = asString(patch.estimateMode);
            assert(mode, "estimateMode is required");
            assert(
              ["manual", "rollup"].includes(mode),
              "estimateMode must be manual or rollup"
            );
            update.estimate_mode = mode;
          }
          if (patch.estimate_minutes !== undefined) {
            const minutes = asNumber(patch.estimate_minutes);
            assert(minutes !== null, "estimate_minutes must be a number");
            assert(minutes >= 0, "estimate_minutes must be >= 0");
            update.estimate_minutes = minutes;
          }
          if (patch.estimateMinutes !== undefined) {
            const minutes = asNumber(patch.estimateMinutes);
            assert(minutes !== null, "estimateMinutes must be a number");
            assert(minutes >= 0, "estimateMinutes must be >= 0");
            update.estimate_minutes = minutes;
          }
          if (patch.notes !== undefined) update.notes = asString(patch.notes);
          if (patch.health !== undefined) update.health = asString(patch.health);
          if (patch.parent_id !== undefined) update.parent_id = asString(patch.parent_id);
          if (patch.parentId !== undefined) update.parent_id = asString(patch.parentId);
          if (patch.assignee_user_id !== undefined || patch.assigneeUserId !== undefined) {
            const assignee =
              asString(patch.assignee_user_id) ?? asString(patch.assigneeUserId);
            await ensureAssignee(trx, item.project_id, assignee);
            update.assignee_user_id = assignee;
            if (assignee) affectedUserIds.add(assignee);
            if (item.assignee_user_id) affectedUserIds.add(item.assignee_user_id);
          }

          update.updated_at = nowSql;
          await trx
            .updateTable("items")
            .set(update)
            .where("id", "=", itemId)
            .execute();
          await logOp(trx, userId, item.project_id, opName, args);
          affectedProjectIds.add(item.project_id);
          if (item.assignee_user_id) affectedUserIds.add(item.assignee_user_id);
          output.push({ opName, ok: true, result: { id: itemId } });
          break;
        }
        case "item.set_status": {
          const itemId = asString(args.itemId);
          const status = asString(args.status);
          assert(itemId, "itemId is required");
          assert(status, "status is required");
          const item = await fetchItem(trx, itemId);
          const role = await ensureProjectRole(trx, item.project_id, userId);
          ensureEditor(role);
          const updates: Record<string, unknown> = { status, updated_at: nowSql };
          if (item.status !== "done" && status === "done") {
            updates.completed_at = nowSql;
          }
          if (item.status === "done" && status !== "done") {
            updates.completed_at = null;
          }
          await trx
            .updateTable("items")
            .set(updates)
            .where("id", "=", itemId)
            .execute();
          await logOp(trx, userId, item.project_id, opName, args);
          affectedProjectIds.add(item.project_id);
          if (item.assignee_user_id) affectedUserIds.add(item.assignee_user_id);
          output.push({ opName, ok: true, result: { id: itemId, status } });
          break;
        }
        case "item.archive":
        case "item.restore": {
          const itemId = asString(args.itemId);
          assert(itemId, "itemId is required");
          const item = await fetchItem(trx, itemId);
          const role = await ensureProjectRole(trx, item.project_id, userId);
          ensureEditor(role);
          const archivedAt = opName === "item.archive" ? nowSql : null;
          await trx
            .updateTable("items")
            .set({ archived_at: archivedAt, updated_at: nowSql })
            .where("id", "=", itemId)
            .execute();
          await logOp(trx, userId, item.project_id, opName, args);
          affectedProjectIds.add(item.project_id);
          if (item.assignee_user_id) affectedUserIds.add(item.assignee_user_id);
          output.push({ opName, ok: true, result: { id: itemId } });
          break;
        }
        case "item.delete":
        case "item.bulk_delete": {
          const ids =
            opName === "item.delete"
              ? [asString(args.itemId)].filter(Boolean) as string[]
              : ((args.ids as string[]) ?? []).filter(Boolean);
          assert(ids.length > 0, "item ids are required");
          const items = await trx
            .selectFrom("items")
            .select(["id", "project_id"])
            .where("id", "in", ids)
            .execute();
          assert(items.length > 0, "items not found");
          for (const item of items) {
            const role = await ensureProjectRole(trx, item.project_id, userId);
            ensureEditor(role);
            affectedProjectIds.add(item.project_id);
          }
          const descendantIds = await getDescendantIds(trx, items.map((i) => i.id));
          for (const item of items) {
            const row = await fetchItem(trx, item.id);
            if (row.assignee_user_id) affectedUserIds.add(row.assignee_user_id);
          }
          await deleteItems(trx, descendantIds);
          for (const item of items) {
            await logOp(trx, userId, item.project_id, opName, { ids: descendantIds });
          }
          output.push({ opName, ok: true, result: { deletedIds: descendantIds } });
          break;
        }
        case "scheduled_block.create": {
          const itemId = asString(args.itemId);
          const startAt = asString(args.startAt);
          const durationMinutes = asNumber(args.durationMinutes);
          assert(itemId, "itemId is required");
          assert(startAt, "startAt is required");
          assert(durationMinutes !== null, "durationMinutes is required");
          assert(durationMinutes > 0, "durationMinutes must be > 0");
          assert(
            Number.isInteger(durationMinutes),
            "durationMinutes must be an integer"
          );
          const item = await fetchItem(trx, itemId);
          const role = await ensureProjectRole(trx, item.project_id, userId);
          ensureEditor(role);
          if (item.archived_at) {
            throw new Error("cannot schedule archived item");
          }
          const block = await trx
            .insertInto("scheduled_blocks")
            .values({
              item_id: itemId,
              start_at: startAt,
              duration_minutes: durationMinutes,
              created_at: nowSql,
              updated_at: nowSql,
            })
            .returning(["id", "item_id", "start_at", "duration_minutes"])
            .executeTakeFirstOrThrow();
          await logOp(trx, userId, item.project_id, opName, args);
          affectedProjectIds.add(item.project_id);
          if (item.assignee_user_id) {
            affectedUserIds.add(item.assignee_user_id);
          }
          output.push({ opName, ok: true, result: block });
          break;
        }
        case "scheduled_block.move":
        case "scheduled_block.resize":
        case "scheduled_block.delete": {
          const blockId = asString(args.blockId);
          assert(blockId, "blockId is required");
          const block = await fetchProjectIdForBlock(trx, blockId);
          const role = await ensureProjectRole(trx, block.project_id, userId);
          ensureEditor(role);
          if (opName === "scheduled_block.delete") {
            await trx
              .deleteFrom("scheduled_blocks")
              .where("id", "=", blockId)
              .execute();
          } else if (opName === "scheduled_block.move") {
            const startAt = asString(args.startAt);
            assert(startAt, "startAt is required");
            await trx
              .updateTable("scheduled_blocks")
              .set({ start_at: startAt, updated_at: nowSql })
              .where("id", "=", blockId)
              .execute();
          } else {
            const durationMinutes = asNumber(args.durationMinutes);
            assert(durationMinutes !== null, "durationMinutes is required");
            assert(durationMinutes > 0, "durationMinutes must be > 0");
            assert(
              Number.isInteger(durationMinutes),
              "durationMinutes must be an integer"
            );
            await trx
              .updateTable("scheduled_blocks")
              .set({ duration_minutes: durationMinutes, updated_at: nowSql })
              .where("id", "=", blockId)
              .execute();
          }
          await logOp(trx, userId, block.project_id, opName, args);
          affectedProjectIds.add(block.project_id);
          if (block.assignee_user_id) {
            affectedUserIds.add(block.assignee_user_id);
          }
          output.push({ opName, ok: true, result: { id: blockId } });
          break;
        }
        case "dependency.add": {
          const itemId = asString(args.itemId);
          const dependsOnId = asString(args.dependsOnId);
          const type = asString(args.type) ?? "FS";
          const lagMinutes = asNumber(args.lagMinutes) ?? 0;
          assert(itemId, "itemId is required");
          assert(dependsOnId, "dependsOnId is required");
          if (itemId === dependsOnId) {
            throw new Error("cannot depend on itself");
          }
          const hasCycle = await dependencyCreatesCycle(
            trx,
            itemId,
            dependsOnId
          );
          assert(!hasCycle, "dependency cycle detected");
          if (!["FS", "SS", "FF", "SF"].includes(type)) {
            throw new Error("invalid dependency type");
          }
          const item = await fetchItem(trx, itemId);
          const dependsOn = await fetchItem(trx, dependsOnId);
          if (item.project_id !== dependsOn.project_id) {
            throw new Error("dependencies must be within the same project");
          }
          const role = await ensureProjectRole(trx, item.project_id, userId);
          ensureEditor(role);
          if (item.archived_at || dependsOn.archived_at) {
            throw new Error("cannot depend on archived item");
          }
          const dependency = await trx
            .insertInto("dependencies")
            .values({
              item_id: itemId,
              depends_on_id: dependsOnId,
              type,
              lag_minutes: lagMinutes,
              created_at: nowSql,
            })
            .onConflict((oc) =>
              oc.columns(["item_id", "depends_on_id"]).doUpdateSet({
                type,
                lag_minutes: lagMinutes,
              })
            )
            .returning(["id", "item_id", "depends_on_id", "type", "lag_minutes"])
            .executeTakeFirstOrThrow();
          await logOp(trx, userId, item.project_id, opName, args);
          affectedProjectIds.add(item.project_id);
          if (item.assignee_user_id) affectedUserIds.add(item.assignee_user_id);
          output.push({ opName, ok: true, result: dependency });
          break;
        }
        case "dependency.update": {
          const dependencyId = asString(args.dependencyId);
          const type = asString(args.type);
          const lagMinutes = asNumber(args.lagMinutes);
          assert(dependencyId, "dependencyId is required");
          const dependency = await trx
            .selectFrom("dependencies")
            .select(["id", "item_id"])
            .where("id", "=", dependencyId)
            .executeTakeFirst();
          if (!dependency) {
            throw new Error("dependency not found");
          }
          const item = await fetchItem(trx, dependency.item_id);
          const role = await ensureProjectRole(trx, item.project_id, userId);
          ensureEditor(role);
          if (type && !["FS", "SS", "FF", "SF"].includes(type)) {
            throw new Error("invalid dependency type");
          }
          await trx
            .updateTable("dependencies")
            .set({
              type: type ?? sql`type`,
              lag_minutes: lagMinutes ?? sql`lag_minutes`,
            })
            .where("id", "=", dependencyId)
            .execute();
          await logOp(trx, userId, item.project_id, opName, args);
          affectedProjectIds.add(item.project_id);
          if (item.assignee_user_id) affectedUserIds.add(item.assignee_user_id);
          output.push({ opName, ok: true, result: { id: dependencyId } });
          break;
        }
        case "dependency.remove": {
          const itemId = asString(args.itemId);
          const dependsOnId = asString(args.dependsOnId);
          const dependencyId = asString(args.dependencyId);
          assert(itemId || dependencyId, "dependency identifiers are required");
          let targetItemId = itemId;
          if (!targetItemId && dependencyId) {
            const dep = await trx
              .selectFrom("dependencies")
              .select(["item_id"])
              .where("id", "=", dependencyId)
              .executeTakeFirst();
            if (!dep) {
              throw new Error("dependency not found");
            }
            targetItemId = dep.item_id;
          }
          const item = await fetchItem(trx, targetItemId!);
          const role = await ensureProjectRole(trx, item.project_id, userId);
          ensureEditor(role);
          if (dependencyId) {
            await trx.deleteFrom("dependencies").where("id", "=", dependencyId).execute();
          } else {
            await trx
              .deleteFrom("dependencies")
              .where("item_id", "=", itemId!)
              .where("depends_on_id", "=", dependsOnId!)
              .execute();
          }
          await logOp(trx, userId, item.project_id, opName, args);
          affectedProjectIds.add(item.project_id);
          if (item.assignee_user_id) affectedUserIds.add(item.assignee_user_id);
          output.push({ opName, ok: true, result: { itemId: targetItemId } });
          break;
        }
        case "blocker.add": {
          const itemId = asString(args.itemId);
          assert(itemId, "itemId is required");
          const item = await fetchItem(trx, itemId);
          const role = await ensureProjectRole(trx, item.project_id, userId);
          ensureEditor(role);
          if (item.archived_at) {
            throw new Error("cannot add blocker to archived item");
          }
          const blocker = await trx
            .insertInto("blockers")
            .values({
              item_id: itemId,
              kind: asString(args.kind) ?? "general",
              reason: asString(args.reason),
              created_at: nowSql,
              cleared_at: null,
            })
            .returning(["id", "item_id", "kind", "reason"])
            .executeTakeFirstOrThrow();
          await logOp(trx, userId, item.project_id, opName, args);
          affectedProjectIds.add(item.project_id);
          if (item.assignee_user_id) affectedUserIds.add(item.assignee_user_id);
          output.push({ opName, ok: true, result: blocker });
          break;
        }
        case "blocker.clear": {
          const blockerId = asString(args.blockerId);
          assert(blockerId, "blockerId is required");
          const blocker = await trx
            .selectFrom("blockers")
            .select(["id", "item_id"])
            .where("id", "=", blockerId)
            .executeTakeFirst();
          if (!blocker) {
            throw new Error("blocker not found");
          }
          const item = await fetchItem(trx, blocker.item_id);
          const role = await ensureProjectRole(trx, item.project_id, userId);
          ensureEditor(role);
          await trx
            .updateTable("blockers")
            .set({ cleared_at: nowSql })
            .where("id", "=", blockerId)
            .execute();
          await logOp(trx, userId, item.project_id, opName, args);
          affectedProjectIds.add(item.project_id);
          if (item.assignee_user_id) affectedUserIds.add(item.assignee_user_id);
          output.push({ opName, ok: true, result: { id: blockerId } });
          break;
        }
        case "time_entry.start": {
          const itemId = asString(args.itemId);
          assert(itemId, "itemId is required");
          const item = await fetchItem(trx, itemId);
          const role = await ensureProjectRole(trx, item.project_id, userId);
          ensureEditor(role);
          if (item.archived_at) {
            throw new Error("cannot track time on archived item");
          }
          const entry = await trx
            .insertInto("time_entries")
            .values({
              item_id: itemId,
              start_at: nowSql,
              end_at: null,
              duration_minutes: null,
              created_at: nowSql,
            })
            .returning(["id", "item_id", "start_at"])
            .executeTakeFirstOrThrow();
          await logOp(trx, userId, item.project_id, opName, args);
          affectedProjectIds.add(item.project_id);
          if (item.assignee_user_id) affectedUserIds.add(item.assignee_user_id);
          output.push({ opName, ok: true, result: entry });
          break;
        }
        case "time_entry.stop": {
          const timeEntryId = asString(args.timeEntryId);
          assert(timeEntryId, "timeEntryId is required");
          const entry = await trx
            .selectFrom("time_entries")
            .select(["id", "item_id", "start_at", "end_at"])
            .where("id", "=", timeEntryId)
            .executeTakeFirst();
          if (!entry) {
            throw new Error("time entry not found");
          }
          if (entry.end_at) {
            throw new Error("time entry already stopped");
          }
          const item = await fetchItem(trx, entry.item_id);
          const role = await ensureProjectRole(trx, item.project_id, userId);
          ensureEditor(role);
          await trx
            .updateTable("time_entries")
            .set({
              end_at: nowSql,
              duration_minutes: sql`EXTRACT(EPOCH FROM (${nowSql} - ${sql.ref(
                "start_at"
              )})) / 60`,
            })
            .where("id", "=", timeEntryId)
            .execute();
          await logOp(trx, userId, item.project_id, opName, args);
          affectedProjectIds.add(item.project_id);
          if (item.assignee_user_id) affectedUserIds.add(item.assignee_user_id);
          output.push({ opName, ok: true, result: { id: timeEntryId } });
          break;
        }
        default:
          throw new Error(`unknown op: ${opName}`);
      }
    }

    return output;
  });

  return { results, affectedProjectIds, affectedUserIds };
};
