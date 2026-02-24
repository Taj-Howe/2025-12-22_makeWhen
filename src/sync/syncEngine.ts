import type { OpEnvelope } from "../rpc/types";
import type { PullRequest, PullResponse, PushRequest, PushResponse } from "./syncTypes";

export type SyncEngineAdapter = {
  listPendingOps: (teamId: string) => Promise<OpEnvelope[]> | OpEnvelope[];
  push: (request: PushRequest) => Promise<PushResponse> | PushResponse;
  applyPushResult: (
    teamId: string,
    response: PushResponse
  ) => Promise<void> | void;
  getLastAppliedSeq: (teamId: string) => Promise<number> | number;
  pull: (request: PullRequest) => Promise<PullResponse> | PullResponse;
  applyIncoming: (
    serverSeq: number,
    op: OpEnvelope
  ) => Promise<boolean | void> | boolean | void;
};

export type SyncRunOnceArgs = {
  teamId: string;
  clientId: string;
  adapter: SyncEngineAdapter;
};

export type SyncRunOnceResult = {
  team_id: string;
  client_id: string;
  pushed_count: number;
  acked_count: number;
  rejected_count: number;
  pulled_count: number;
  applied_count: number;
  latest_seq: number;
};

export const runSyncOnce = async ({
  teamId,
  clientId,
  adapter,
}: SyncRunOnceArgs): Promise<SyncRunOnceResult> => {
  const pendingOps = await adapter.listPendingOps(teamId);
  const pushResponse =
    pendingOps.length > 0
      ? await adapter.push({
          team_id: teamId,
          client_id: clientId,
          ops: pendingOps,
        })
      : { acked: [], rejected: [] };

  await adapter.applyPushResult(teamId, pushResponse);

  const sinceSeq = await adapter.getLastAppliedSeq(teamId);
  const pullResponse = await adapter.pull({
    team_id: teamId,
    since_seq: sinceSeq,
  });

  const orderedIncoming = [...pullResponse.ops].sort(
    (a, b) => a.server_seq - b.server_seq
  );

  let appliedCount = 0;
  for (const incoming of orderedIncoming) {
    const applied = await adapter.applyIncoming(incoming.server_seq, incoming.op);
    if (applied !== false) {
      appliedCount += 1;
    }
  }

  const latestSeq =
    orderedIncoming.length > 0
      ? orderedIncoming[orderedIncoming.length - 1].server_seq
      : pullResponse.latest_seq;

  return {
    team_id: teamId,
    client_id: clientId,
    pushed_count: pendingOps.length,
    acked_count: pushResponse.acked.length,
    rejected_count: pushResponse.rejected.length,
    pulled_count: orderedIncoming.length,
    applied_count: appliedCount,
    latest_seq: latestSeq,
  };
};
