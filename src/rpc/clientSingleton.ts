import { createRpcClient } from "./client";

const worker = new Worker(new URL("../db-worker/worker.ts", import.meta.url), {
  type: "module",
});

const rpc = createRpcClient(worker);

export const request = rpc.request.bind(rpc);

export const query = async <T,>(name: string, args?: unknown): Promise<T> => {
  const result = await request("query", { name, args });
  if (!result || typeof result !== "object" || !("ok" in result)) {
    return result as T;
  }
  const payload = result as { ok: boolean; result?: T; error?: string };
  if (!payload.ok) {
    throw new Error(payload.error || "Query failed");
  }
  return payload.result as T;
};

export const mutate = async <T,>(
  op_name: string,
  args?: unknown,
  actor: { type: string; id?: string } = { type: "user", id: "local" }
): Promise<T> => {
  const envelope = {
    op_id: crypto.randomUUID(),
    op_name,
    actor_type: actor.type,
    actor_id: actor.id,
    ts: Date.now(),
    args,
  };
  const result = await request("mutate", envelope);
  if (!result || typeof result !== "object" || !("ok" in result)) {
    return result as T;
  }
  const payload = result as {
    ok: boolean;
    result?: T;
    error?: string | { code: string; message: string };
  };
  if (!payload.ok) {
    if (typeof payload.error === "string") {
      throw new Error(payload.error);
    }
    throw new Error(payload.error?.message ?? "Mutation failed");
  }
  return payload.result as T;
};
