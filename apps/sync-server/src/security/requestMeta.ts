import type { IncomingMessage } from "node:http";

const firstHeaderValue = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return typeof value === "string" ? value : "";
};

export const getRequestIp = (request: IncomingMessage) => {
  const forwarded = firstHeaderValue(request.headers["x-forwarded-for"])
    .split(",")
    .map((part) => part.trim())
    .find(Boolean);
  if (forwarded) {
    return forwarded;
  }

  const realIp = firstHeaderValue(request.headers["x-real-ip"]).trim();
  if (realIp) {
    return realIp;
  }

  const socket = request.socket as { remoteAddress?: string } | undefined;
  return socket?.remoteAddress ?? "unknown";
};

export const getHeaderString = (
  request: IncomingMessage,
  headerName: string
): string | null => {
  const value = request.headers[headerName.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
};
