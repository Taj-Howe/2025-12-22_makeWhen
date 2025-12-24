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

export type Scope =
  | { kind: "project"; id: string }
  | { kind: "user"; id: string }
  | { kind: "team"; id: string }
  | { kind: "org"; id: string };

export type QueryFilters = {
  status?: string[];
  assignee?: string;
  tag?: string;
  health?: string[];
  dueRange?: { start?: number; end?: number };
};

export type ItemQuery = {
  scope: Scope;
  filters?: QueryFilters;
  includeDone?: boolean;
  includeCanceled?: boolean;
  searchText?: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: string;
};

export type BlockQuery = {
  scope: Scope;
  filters?: QueryFilters;
  startAt: number;
  endAt: number;
};

export type ExecutionQuery = {
  scope: Scope;
  filters?: QueryFilters;
  startAt: number;
  endAt: number;
};
