import { useEffect, useRef } from "react";
import type { Scope } from "../domain/scope";

type SseEvent = {
  scopeType: "project" | "user";
  scopeId: string;
  reason: string;
  at: string;
};

export const useSse = (scope: Scope | null, onEvent: (event: SseEvent) => void) => {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!scope) {
      return;
    }
    if (scope.kind === "project" && !scope.projectId) {
      return;
    }
    const scopeType = scope.kind === "project" ? "project" : "user";
    const scopeId = scope.kind === "project" ? scope.projectId : scope.userId;
    const url = `/api/sse?scopeType=${encodeURIComponent(
      scopeType
    )}&scopeId=${encodeURIComponent(scopeId)}`;
    const source = new EventSource(url);

    const onMessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as SseEvent;
        handlerRef.current(payload);
      } catch {
        // ignore malformed messages
      }
    };

    source.addEventListener("message", onMessage);
    source.addEventListener("error", () => {
      // browser will auto-retry; no-op
    });

    return () => {
      source.close();
    };
  }, [scope]);
};
