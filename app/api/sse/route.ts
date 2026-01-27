import { NextResponse } from "next/server";
import { requireUser } from "../../../lib/auth/auth";
import { db } from "../../../lib/db/kysely";
import { subscribe } from "../../../lib/server/pubsub";

export const runtime = "nodejs";

const getScope = (request: Request) => {
  const url = new URL(request.url);
  const scopeType = url.searchParams.get("scopeType");
  const scopeId = url.searchParams.get("scopeId");
  if (!scopeType || !scopeId) {
    return null;
  }
  if (scopeType !== "project" && scopeType !== "user") {
    return null;
  }
  return { scopeType, scopeId };
};

export const GET = async (request: Request) => {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const scope = getScope(request);
  if (!scope) {
    return NextResponse.json(
      { ok: false, error: "scopeType and scopeId are required" },
      { status: 400 }
    );
  }

  if (scope.scopeType === "user") {
    if (scope.scopeId !== user.userId) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }
  }

  if (scope.scopeType === "project") {
    const member = await db
      .selectFrom("project_members")
      .select("project_id")
      .where("project_id", "=", scope.scopeId)
      .where("user_id", "=", user.userId)
      .executeTakeFirst();
    if (!member) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }
  }

  const topic =
    scope.scopeType === "project"
      ? `project:${scope.scopeId}`
      : `user:${scope.scopeId}`;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(
          encoder.encode(`event: invalidation\ndata: ${JSON.stringify(payload)}\n\n`)
        );
      };

      const unsubscribe = subscribe(topic, send);
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, 15000);

      send({ topic, type: "connected" });

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      });
    },
    cancel() {
      // no-op; handled in abort listener
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
};
