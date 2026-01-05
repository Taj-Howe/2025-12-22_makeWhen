type QueryPayload = {
  name: string;
  args?: unknown;
};

type QueryResponse<T> = {
  ok: boolean;
  result?: T;
  error?: string;
};

type OpPayload = {
  op_name: string;
  op_id?: string;
  actor?: string;
  ts?: number;
  args: Record<string, unknown>;
};

type OpsPayload = {
  ops: OpPayload[];
};

type OpsResponse<T = unknown> = {
  ok: boolean;
  results?: Array<{ ok: boolean; data?: T; error?: string }>;
  error?: string;
};

const handleJson = async <T,>(response: Response): Promise<T> => {
  const json = (await response.json()) as T;
  return json;
};

export const serverQuery = async <T,>(
  name: string,
  args?: unknown
): Promise<T> => {
  const response = await fetch("/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, args } satisfies QueryPayload),
  });
  const payload = await handleJson<QueryResponse<T>>(response);
  if (!payload.ok) {
    throw new Error(payload.error || "Query failed");
  }
  return payload.result as T;
};

export const serverOps = async <T,>(ops: OpPayload[]): Promise<OpsResponse<T>> => {
  const response = await fetch("/api/ops", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops } satisfies OpsPayload),
  });
  return handleJson<OpsResponse<T>>(response);
};

export const serverMutate = async <T,>(
  op_name: string,
  args: Record<string, unknown>
): Promise<T> => {
  const payload = await serverOps<T>([{ op_name, args }]);
  if (!payload.ok) {
    throw new Error(payload.error || "Operation failed");
  }
  const result = payload.results?.[0];
  if (!result?.ok) {
    throw new Error(result?.error || "Operation failed");
  }
  return result.data as T;
};
