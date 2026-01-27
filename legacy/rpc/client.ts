import type { RpcRequest, RpcResponse } from "./types";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export const createRpcClient = (worker: Worker) => {
  let nextId = 0;
  const pending = new Map<string, Pending>();

  worker.addEventListener("message", (event: MessageEvent<RpcResponse>) => {
    const message = event.data;

    if (!message || message.kind !== "response") {
      return;
    }

    const handler = pending.get(message.id);
    if (!handler) {
      return;
    }

    pending.delete(message.id);

    if (message.ok) {
      handler.resolve(message.result);
      return;
    }

    handler.reject(new Error(message.error || "Unknown error"));
  });

  return {
    request<T>(method: string, params?: unknown): Promise<T> {
      const id = String(++nextId);
      const message: RpcRequest = {
        id,
        kind: "request",
        method,
        params,
      };

      worker.postMessage(message);

      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
  };
};
