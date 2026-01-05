type SseEvent = {
  scopeType: "project" | "user";
  scopeId: string;
  reason: string;
  at: string;
};

type Subscriber = {
  scopeType: "project" | "user";
  scopeId: string;
  send: (event: SseEvent) => void;
};

// In-memory pubsub for single-instance deployments.
// For multi-instance, replace with Redis or a shared broker.
const subscribers = new Set<Subscriber>();

export const subscribe = (subscriber: Subscriber) => {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
};

export const publish = (event: SseEvent) => {
  for (const subscriber of subscribers) {
    if (
      subscriber.scopeType === event.scopeType &&
      subscriber.scopeId === event.scopeId
    ) {
      subscriber.send(event);
    }
  }
};
