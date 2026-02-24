import type { OpEnvelope } from "../rpc/types";

export type PushRequest = {
  team_id: string;
  client_id: string;
  ops: OpEnvelope[];
};

export type PushResponse = {
  acked: Array<{ op_id: string; server_seq: number }>;
  rejected: Array<{ op_id: string; reason: string }>;
};

export type PullRequest = {
  team_id: string;
  since_seq: number;
};

export type PullResponse = {
  ops: Array<{ server_seq: number; op: OpEnvelope }>;
  latest_seq: number;
};
