export type SyncEndpoint = "push" | "pull";

export type CounterSnapshot = {
  push_success_total: number;
  push_failure_total: number;
  pull_success_total: number;
  pull_failure_total: number;
  auth_failure_total: number;
};

type LagTeamStat = {
  last: number;
  max: number;
  sum: number;
  count: number;
};

const startedAtMs = Date.now();

const counters = {
  push_success_total: 0,
  push_failure_total: 0,
  pull_success_total: 0,
  pull_failure_total: 0,
  auth_failure_total: 0,
};

const rejectedOpsByReason = new Map<string, number>();
const lagByTeam = new Map<string, LagTeamStat>();

const incrementMap = (map: Map<string, number>, key: string) => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

export const recordSyncEndpointResult = (
  endpoint: SyncEndpoint,
  outcome: "success" | "failure"
) => {
  if (endpoint === "push" && outcome === "success") {
    counters.push_success_total += 1;
    return;
  }
  if (endpoint === "push" && outcome === "failure") {
    counters.push_failure_total += 1;
    return;
  }
  if (endpoint === "pull" && outcome === "success") {
    counters.pull_success_total += 1;
    return;
  }
  counters.pull_failure_total += 1;
};

export const recordAuthFailure = () => {
  counters.auth_failure_total += 1;
};

export const recordRejectedOpReason = (reasonCode: string) => {
  incrementMap(rejectedOpsByReason, reasonCode);
};

export const recordQueueLagProxy = (
  teamId: string,
  latestSeq: number,
  lastAppliedSeq: number
) => {
  const lag = Math.max(0, latestSeq - lastAppliedSeq);
  const existing = lagByTeam.get(teamId);
  if (!existing) {
    lagByTeam.set(teamId, {
      last: lag,
      max: lag,
      sum: lag,
      count: 1,
    });
    return;
  }

  existing.last = lag;
  existing.max = Math.max(existing.max, lag);
  existing.sum += lag;
  existing.count += 1;
  lagByTeam.set(teamId, existing);
};

const perMinute = (count: number, elapsedMs: number) => {
  if (elapsedMs <= 0) {
    return count;
  }
  return Number(((count * 60_000) / elapsedMs).toFixed(3));
};

const rejectedOpsSnapshot = () => {
  return Array.from(rejectedOpsByReason.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([reason_code, count]) => ({ reason_code, count }));
};

const lagProxySnapshot = () => {
  return Array.from(lagByTeam.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([team_id, stat]) => ({
      team_id,
      last: stat.last,
      max: stat.max,
      avg: Number((stat.sum / stat.count).toFixed(3)),
      samples: stat.count,
    }));
};

export const getMetricsSnapshot = () => {
  const nowMs = Date.now();
  const elapsedMs = Math.max(1, nowMs - startedAtMs);

  return {
    generated_at: new Date(nowMs).toISOString(),
    uptime_seconds: Math.floor(elapsedMs / 1000),
    counters: {
      ...counters,
    },
    rates_per_minute: {
      push_success: perMinute(counters.push_success_total, elapsedMs),
      push_failure: perMinute(counters.push_failure_total, elapsedMs),
      pull_success: perMinute(counters.pull_success_total, elapsedMs),
      pull_failure: perMinute(counters.pull_failure_total, elapsedMs),
      auth_failure: perMinute(counters.auth_failure_total, elapsedMs),
    },
    rejected_ops_by_reason: rejectedOpsSnapshot(),
    queue_lag_proxy: lagProxySnapshot(),
  };
};

export const resetMetricsForTests = () => {
  counters.push_success_total = 0;
  counters.push_failure_total = 0;
  counters.pull_success_total = 0;
  counters.pull_failure_total = 0;
  counters.auth_failure_total = 0;
  rejectedOpsByReason.clear();
  lagByTeam.clear();
};
