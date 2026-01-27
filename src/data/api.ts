type SubscribeHandler = (event: unknown) => void;
type Unsubscribe = () => void;
type SubscribeOptions = { scopeType: "project" | "user"; scopeId: string };

type Adapter = {
  query: <T>(name: string, args?: unknown) => Promise<T>;
  mutate: <T>(
    opName: string,
    args?: unknown,
    actor?: { type: string; id?: string }
  ) => Promise<T>;
  subscribe: (handler: SubscribeHandler, options?: SubscribeOptions) => Unsubscribe;
};

const serverAdapter: Adapter = {
  query: async (name, args) => {
    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const message = payload?.error || `Query failed (${res.status})`;
      throw new Error(message);
    }
    return payload;
  },
  mutate: async (opName, args, actor) => {
    const res = await fetch("/api/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ops: [{ opName, args, actor }] }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const message = payload?.error || `Mutation failed (${res.status})`;
      throw new Error(message);
    }
    return payload;
  },
  subscribe: (handler, options) => {
    if (!options) {
      return () => {};
    }
    const params = new URLSearchParams({
      scopeType: options.scopeType,
      scopeId: options.scopeId,
    });
    const source = new EventSource(`/api/sse?${params.toString()}`);
    source.addEventListener("invalidation", (event) => {
      handler((event as MessageEvent).data);
    });
    return () => {
      source.close();
    };
  },
};

export const query: Adapter["query"] = (name, args) =>
  serverAdapter.query(name, args);
export const mutate: Adapter["mutate"] = (opName, args, actor) =>
  serverAdapter.mutate(opName, args, actor);
export const subscribe: Adapter["subscribe"] = (handler, options) =>
  serverAdapter.subscribe(handler, options);
