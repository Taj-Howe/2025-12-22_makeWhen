import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const REQUEST_ID_HEADER = "x-request-id";
const MAX_REQUEST_ID_LENGTH = 128;

export type RequestWithContext = IncomingMessage & {
  request_id?: string;
};

const normalizeRequestId = (value: string | null) => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REQUEST_ID_LENGTH) {
    return null;
  }
  return trimmed;
};

export const attachRequestContext = (
  request: IncomingMessage,
  response: ServerResponse
): string => {
  const inbound = request.headers[REQUEST_ID_HEADER];
  const requestIdRaw = Array.isArray(inbound) ? inbound[0] ?? null : inbound ?? null;
  const requestId = normalizeRequestId(requestIdRaw) ?? randomUUID();

  (request as RequestWithContext).request_id = requestId;
  response.setHeader("X-Request-Id", requestId);
  return requestId;
};

export const getRequestId = (request: IncomingMessage): string => {
  return (request as RequestWithContext).request_id ?? "unknown";
};
