export type RpcRequest = {
  id: string;
  kind: "request";
  method: string;
  params?: unknown;
};

export type RpcResponse = {
  id: string;
  kind: "response";
  ok: boolean;
  result?: unknown;
  error?: string;
};
