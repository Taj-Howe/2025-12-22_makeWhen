import { applyOps, type OpsRequest } from "../../../lib/domain/ops";
import { requireUser } from "../../../lib/auth/session";
import { publish } from "../../../lib/sse/pubsub";
import { checkRateLimit } from "../../../lib/limit";

export const runtime = "nodejs";

export const POST = async (request: Request) => {
  try {
    const actor = await requireUser();
    const rate = checkRateLimit(`ops:${actor.userId}`, {
      windowMs: 60_000,
      max: 60,
    });
    if (!rate.allowed) {
      return Response.json(
        { ok: false, error: "Rate limit exceeded" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) } }
      );
    }
    const payload = (await request.json()) as OpsRequest;
    if (!payload?.ops || !Array.isArray(payload.ops)) {
      return Response.json(
        { ok: false, error: "Invalid ops payload" },
        { status: 400 }
      );
    }
    const response = await applyOps(actor.userId, payload.ops);
    for (const event of response.events) {
      publish(event);
    }
    return Response.json({ ok: true, ...response });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "UNAUTHORIZED" ? 401 : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
};
