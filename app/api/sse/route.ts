import { getDb } from "../../../lib/db/connection";
import { requireUser } from "../../../lib/auth/session";
import { subscribe } from "../../../lib/sse/pubsub";

export const runtime = "nodejs";

const encoder = new TextEncoder();

const formatEvent = (event: unknown) =>
  `event: message\ndata: ${JSON.stringify(event)}\n\n`;

export const GET = async (request: Request) => {
  const actor = await requireUser();
  const { searchParams } = new URL(request.url);
  const scopeType = searchParams.get("scopeType");
  const scopeId = searchParams.get("scopeId");
  if (
    (scopeType !== "project" && scopeType !== "user") ||
    typeof scopeId !== "string"
  ) {
    return Response.json(
      { ok: false, error: "scopeType and scopeId are required" },
      { status: 400 }
    );
  }

  if (scopeType === "user" && scopeId !== actor.userId) {
    return Response.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
  }

  if (scopeType === "project") {
    const db = getDb();
    const member = await db
      .selectFrom("project_members")
      .select("project_id")
      .where("project_id", "=", scopeId)
      .where("user_id", "=", actor.userId)
      .executeTakeFirst();
    if (!member) {
      return Response.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
    }
  }

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(formatEvent({ reason: "ready", at: new Date().toISOString() }))
      );
      const unsubscribe = subscribe({
        scopeType,
        scopeId,
        send(event) {
          controller.enqueue(encoder.encode(formatEvent(event)));
        },
      });
      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
      }, 25000);
      cleanup = () => {
        clearInterval(keepAlive);
        unsubscribe();
        controller.close();
      };
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
};
