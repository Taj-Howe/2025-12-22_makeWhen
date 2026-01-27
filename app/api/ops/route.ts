import { NextResponse } from "next/server";
import { requireUser } from "../../../lib/auth/auth";
import { db } from "../../../lib/db/kysely";
import { applyOps } from "../../../lib/domain/ops";
import { publish } from "../../../lib/server/pubsub";

export const runtime = "nodejs";

export const POST = async (request: Request) => {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const ops = body?.ops;

  if (!Array.isArray(ops)) {
    return NextResponse.json(
      { ok: false, error: "ops must be an array" },
      { status: 400 }
    );
  }

  try {
    const result = await applyOps(db, { userId: user.userId, ops });

    const events = [];
    for (const projectId of result.affectedProjectIds) {
      const event = {
        topic: `project:${projectId}`,
        type: "ops_applied",
        projectId,
        payload: { count: result.results.length },
      };
      publish(event);
      events.push(event);
    }
    for (const userId of result.affectedUserIds) {
      const event = {
        topic: `user:${userId}`,
        type: "ops_applied",
        userId,
        payload: { count: result.results.length },
      };
      publish(event);
      events.push(event);
    }

    return NextResponse.json({ ok: true, results: result.results, events });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "ops execution failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
};
