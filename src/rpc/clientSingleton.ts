import { createRpcClient } from "./client";
import type { RpcErrorPayload } from "./types";

const worker = new Worker(new URL("../db-worker/worker.ts", import.meta.url), {
  type: "module",
});

const rpc = createRpcClient(worker);

export const request = rpc.request.bind(rpc);

const toClientError = (
  error: string | RpcErrorPayload | undefined,
  fallbackMessage: string
) => {
  if (typeof error === "string") {
    return new Error(error);
  }
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    const next = new Error(error.message);
    (next as Error & { code?: string }).code = error.code;
    return next;
  }
  return new Error(fallbackMessage);
};

export const query = async <T,>(name: string, args?: unknown): Promise<T> => {
  const result = await request("query", { name, args });
  if (!result || typeof result !== "object" || !("ok" in result)) {
    return result as T;
  }
  const payload = result as {
    ok: boolean;
    result?: T;
    error?: string | RpcErrorPayload;
  };
  if (!payload.ok) {
    if (name.startsWith("sync.")) {
      console.warn("[sync] query failed", {
        name,
        error: payload.error,
      });
    }
    throw toClientError(payload.error, "Query failed");
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
    error?: string | RpcErrorPayload;
  };
  if (!payload.ok) {
    if (op_name.startsWith("sync.")) {
      console.warn("[sync] mutation failed", {
        op_name,
        error: payload.error,
      });
    }
    throw toClientError(payload.error, "Mutation failed");
  }
  return payload.result as T;
};
