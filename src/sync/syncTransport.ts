import type { OpEnvelope } from "../rpc/types";
import type { PullRequest, PullResponse, PushRequest, PushResponse } from "./syncTypes";
import type { SyncMode } from "./syncConfig";

type SyncErrorReporter = (message: string) => void;

type SyncTransportFactoryArgs = {
  mode: SyncMode;
  remoteBaseUrl: string;
  sessionToken?: string | null;
  mockPush: (request: PushRequest) => PushResponse;
  mockPull: (request: PullRequest) => PullResponse;
  onError?: SyncErrorReporter;
};

export type SyncTransport = {
  mode: SyncMode;
  push: (request: PushRequest) => Promise<PushResponse>;
  pull: (request: PullRequest) => Promise<PullResponse>;
};

const ensureUrl = (baseUrl: string) => {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error("SYNC_REMOTE_BASE_URL is required when SYNC_MODE=remote.");
  }
  return trimmed.replace(/\/$/, "");
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
};

const normalizeRejectedReason = (reason: unknown): string => {
  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason;
  }
  if (isRecord(reason)) {
    const code = typeof reason.code === "string" ? reason.code : "rejected";
    const message =
      typeof reason.message === "string" && reason.message.trim().length > 0
        ? reason.message
        : "unknown reason";
    return `${code}: ${message}`;
  }
  return "rejected: unknown reason";
};

const normalizePushResponse = (payload: unknown): PushResponse => {
  if (!isRecord(payload)) {
    return { acked: [], rejected: [] };
  }

  const ackedRaw = Array.isArray(payload.acked) ? payload.acked : [];
  const rejectedRaw = Array.isArray(payload.rejected) ? payload.rejected : [];

  const acked = ackedRaw
    .map((entry) => {
      if (!isRecord(entry) || typeof entry.op_id !== "string") {
        return null;
      }
      const seq = Number(entry.server_seq);
      if (!Number.isFinite(seq)) {
        return null;
      }
      return {
        op_id: entry.op_id,
        server_seq: seq,
      };
    })
    .filter((entry): entry is { op_id: string; server_seq: number } => entry !== null);

  const rejected = rejectedRaw
    .map((entry) => {
      if (!isRecord(entry) || typeof entry.op_id !== "string") {
        return null;
      }
      return {
        op_id: entry.op_id,
        reason: normalizeRejectedReason(entry.reason),
      };
    })
    .filter((entry): entry is { op_id: string; reason: string } => entry !== null);

  return { acked, rejected };
};

const normalizePullResponse = (payload: unknown, sinceSeq: number): PullResponse => {
  if (!isRecord(payload)) {
    return { ops: [], latest_seq: sinceSeq };
  }

  const rawOps = Array.isArray(payload.ops) ? payload.ops : [];
  const ops: Array<{ server_seq: number; op: OpEnvelope }> = [];

  for (const entry of rawOps) {
    if (!isRecord(entry)) {
      continue;
    }
    const serverSeq = Number(entry.server_seq);
    const opValue = entry.op;
    if (!Number.isFinite(serverSeq) || !isRecord(opValue)) {
      continue;
    }
    if (
      typeof opValue.op_id !== "string" ||
      typeof opValue.team_id !== "string" ||
      typeof opValue.actor_user_id !== "string" ||
      typeof opValue.op_name !== "string"
    ) {
      continue;
    }
    const createdAt = Number(opValue.created_at);
    if (!Number.isFinite(createdAt)) {
      continue;
    }
    const payloadObject = isRecord(opValue.payload)
      ? opValue.payload
      : ({} as Record<string, unknown>);
    ops.push({
      server_seq: serverSeq,
      op: {
        op_id: opValue.op_id,
        team_id: opValue.team_id,
        actor_user_id: opValue.actor_user_id,
        created_at: createdAt,
        op_name: opValue.op_name,
        payload: payloadObject,
      },
    });
  }

  ops.sort((a, b) => a.server_seq - b.server_seq);

  const latestSeqValue = Number(payload.latest_seq);
  const latestSeq = Number.isFinite(latestSeqValue)
    ? latestSeqValue
    : ops.length > 0
      ? ops[ops.length - 1].server_seq
      : sinceSeq;

  return {
    ops,
    latest_seq: latestSeq,
  };
};

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as unknown;
    if (isRecord(payload)) {
      if (typeof payload.message === "string" && payload.message.trim().length > 0) {
        return payload.message;
      }
      if (typeof payload.error === "string" && payload.error.trim().length > 0) {
        return payload.error;
      }
    }
  } catch {
    // ignore
  }
  return `${response.status} ${response.statusText}`.trim();
};

const buildHeaders = (sessionToken?: string | null) => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (typeof sessionToken === "string" && sessionToken.trim().length > 0) {
    headers.Authorization = `Bearer ${sessionToken.trim()}`;
  }
  return headers;
};

const createRemoteTransport = ({
  remoteBaseUrl,
  sessionToken,
  onError,
}: Pick<SyncTransportFactoryArgs, "remoteBaseUrl" | "sessionToken" | "onError">): SyncTransport => {
  const baseUrl = ensureUrl(remoteBaseUrl);

  const requestJson = async (url: string, init: RequestInit) => {
    const response = await fetch(url, {
      ...init,
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) {
      const message = await readErrorMessage(response);
      throw new Error(`Sync request failed: ${message}`);
    }
    return (await response.json()) as unknown;
  };

  return {
    mode: "remote",
    push: async (request) => {
      try {
        const payload = await requestJson(`${baseUrl}/sync/push`, {
          method: "POST",
          headers: buildHeaders(sessionToken),
          body: JSON.stringify(request),
        });
        return normalizePushResponse(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError?.(`[sync][remote][push] ${message}`);
        throw error;
      }
    },
    pull: async (request) => {
      const search = new URLSearchParams({
        team_id: request.team_id,
        since_seq: String(request.since_seq),
      });
      try {
        const payload = await requestJson(
          `${baseUrl}/sync/pull?${search.toString()}`,
          {
            method: "GET",
            headers: buildHeaders(sessionToken),
          }
        );
        return normalizePullResponse(payload, request.since_seq);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError?.(`[sync][remote][pull] ${message}`);
        throw error;
      }
    },
  };
};

export const createSyncTransport = (
  args: SyncTransportFactoryArgs
): SyncTransport => {
  if (args.mode === "remote") {
    return createRemoteTransport(args);
  }

  return {
    mode: "mock",
    push: async (request) => args.mockPush(request),
    pull: async (request) => args.mockPull(request),
  };
};
