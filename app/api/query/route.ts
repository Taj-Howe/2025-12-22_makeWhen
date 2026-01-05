import { requireUser } from "../../../lib/auth/session";
import { handleQuery, type QueryRequest } from "../../../lib/views";
import { checkRateLimit } from "../../../lib/limit";

export const runtime = "nodejs";

export const POST = async (request: Request) => {
  try {
    const actor = await requireUser();
    const rate = checkRateLimit(`query:${actor.userId}`, {
      windowMs: 60_000,
      max: 120,
    });
    if (!rate.allowed) {
      return Response.json(
        { ok: false, error: "Rate limit exceeded" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) } }
      );
    }
    const payload = (await request.json()) as QueryRequest;
    if (!payload?.name) {
      return Response.json(
        { ok: false, error: "Invalid query payload" },
        { status: 400 }
      );
    }
    const result = await handleQuery(payload, actor);
    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "UNAUTHORIZED" ? 401 : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
};
