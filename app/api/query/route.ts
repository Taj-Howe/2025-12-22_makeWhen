import { NextResponse } from "next/server";
import { requireUser } from "../../../lib/auth/auth";
import { getCalendarView } from "../../../lib/views/calendarView";
import { getListView } from "../../../lib/views/listView";
import { db } from "../../../lib/db/kysely";

type ScopeInput =
  | { kind: "project"; projectId: string }
  | { kind: "user"; userId: string }
  | { kind: "all" };

const parseScope = (args: any): ScopeInput | null => {
  if (args?.scope?.kind === "project" && typeof args.scope.projectId === "string") {
    return { kind: "project", projectId: args.scope.projectId };
  }
  if (args?.scope?.kind === "user" && typeof args.scope.userId === "string") {
    return { kind: "user", userId: args.scope.userId };
  }
  if (args?.scopeType === "project" && typeof args.scopeId === "string") {
    return { kind: "project", projectId: args.scopeId };
  }
  if (args?.scopeType === "user" && typeof args.scopeId === "string") {
    return { kind: "user", userId: args.scopeId };
  }
  if (typeof args?.scopeProjectId === "string") {
    return { kind: "project", projectId: args.scopeProjectId };
  }
  if (typeof args?.scopeUserId === "string") {
    return { kind: "user", userId: args.scopeUserId };
  }
  if (typeof args?.assigneeId === "string") {
    return { kind: "user", userId: args.assigneeId };
  }
  if (typeof args?.projectId === "string") {
    return { kind: "project", projectId: args.projectId };
  }
  return null;
};

const parseWindow = (args: any) => {
  const start =
    typeof args?.windowStart === "number"
      ? args.windowStart
      : typeof args?.time_min === "number"
        ? args.time_min
        : typeof args?.start_at === "number"
          ? args.start_at
          : null;
  const end =
    typeof args?.windowEnd === "number"
      ? args.windowEnd
      : typeof args?.time_max === "number"
        ? args.time_max
        : typeof args?.end_at === "number"
          ? args.end_at
          : null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return { start: Number(start), end: Number(end) };
};

export const runtime = "nodejs";

export const POST = async (request: Request) => {
  let currentUserId: string | null = null;
  try {
    const user = await requireUser();
    currentUserId = user.userId;
  } catch (error) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const name = body?.name;
  const args = body?.args;

  if (!name || typeof name !== "string") {
    return NextResponse.json(
      { ok: false, error: "query name is required" },
      { status: 400 }
    );
  }

  try {
    if (name === "calendar_view" || name === "calendar_range" || name === "calendar_range_user") {
      if (name === "calendar_range_user" && typeof args?.user_id !== "string") {
        return NextResponse.json(
          { ok: false, error: "user_id is required" },
          { status: 400 }
        );
      }
      const scope =
        name === "calendar_range_user"
          ? { kind: "user", userId: args.user_id as string }
          : parseScope(args) ?? { kind: "all" };
      const window = parseWindow(args);
      if (!window) {
        return NextResponse.json(
          { ok: false, error: "windowStart/windowEnd are required" },
          { status: 400 }
        );
      }
      const result = await getCalendarView({
        scope,
        windowStart: window.start,
        windowEnd: window.end,
        includeArchived: Boolean(args?.includeArchived),
      });
      return NextResponse.json(result);
    }

    if (name === "list_view") {
      const scope = parseScope(args) ?? { kind: "all" };
      const result = await getListView({
        scope,
        includeArchived: Boolean(args?.includeArchived),
        includeCompleted:
          typeof args?.includeCompleted === "boolean" ? args.includeCompleted : true,
        archiveFilter: args?.archiveFilter,
      });
      return NextResponse.json(result);
    }

    if (name === "list_view_complete") {
      const scope = parseScope(args) ?? { kind: "all" };
      const result = await getListView({
        scope,
        includeArchived: Boolean(args?.includeArchived),
        includeCompleted:
          typeof args?.includeCompleted === "boolean" ? args.includeCompleted : true,
        archiveFilter: args?.archiveFilter,
      });
      return NextResponse.json(result);
    }

    if (name === "listItems") {
      const scope = parseScope(args) ?? { kind: "all" };
      const result = await getListView({
        scope,
        includeArchived: Boolean(args?.includeArchived),
        includeCompleted:
          typeof args?.includeCompleted === "boolean" ? args.includeCompleted : true,
        archiveFilter: args?.archiveFilter,
      });
      return NextResponse.json({ items: result });
    }

    if (name === "users_list") {
      const users = await db
        .selectFrom("users")
        .select(["id", "name", "image"])
        .orderBy("name", "asc")
        .execute();
      const payload = {
        users: users.map((row) => ({
          user_id: row.id,
          display_name: row.name ?? "Unknown",
          avatar_url: row.image ?? null,
        })),
        current_user_id: currentUserId,
      };
      return NextResponse.json(payload);
    }

    return NextResponse.json(
      { ok: false, error: "query not implemented", name, args },
      { status: 501 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "query failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
