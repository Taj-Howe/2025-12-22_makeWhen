import { randomUUID } from "node:crypto";

export type PubSubEvent = {
  id: string;
  ts: string;
  topic: string;
  type: string;
  projectId?: string;
  userId?: string;
  payload?: unknown;
};

type Handler = (event: PubSubEvent) => void;

const listeners = new Map<string, Set<Handler>>();

export const publish = (event: Omit<PubSubEvent, "id" | "ts">) => {
  const fullEvent: PubSubEvent = {
    ...event,
    id: randomUUID(),
    ts: new Date().toISOString(),
  };
  const handlers = listeners.get(fullEvent.topic);
  if (!handlers) return;
  for (const handler of handlers) {
    handler(fullEvent);
  }
};

export const subscribe = (topic: string, handler: Handler) => {
  const handlers = listeners.get(topic) ?? new Set<Handler>();
  handlers.add(handler);
  listeners.set(topic, handlers);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) {
      listeners.delete(topic);
    }
  };
};
