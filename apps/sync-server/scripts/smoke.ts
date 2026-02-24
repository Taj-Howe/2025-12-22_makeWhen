import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrations.ts";
import { ensurePsqlAvailable, queryRows } from "../src/db/client.ts";
import { buildHandler } from "../src/app.ts";
import { ApiError } from "../src/auth/errors.ts";
import type { SyncRouteDependencies } from "../src/routes/sync.ts";
import type { AdminRouteDependencies } from "../src/routes/admin.ts";
import { resetMetricsForTests } from "../src/observability/metrics.ts";

type Check = {
  name: string;
  ok: boolean;
  details?: string;
};

const checks: Check[] = [];

const addCheck = (name: string, ok: boolean, details?: string) => {
  checks.push({ name, ok, details });
  if (!ok) {
    throw new Error(details ? `${name}: ${details}` : name);
  }
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(currentDir, "../migrations");

const run = async () => {
  resetMetricsForTests();

  const files = await fs.readdir(migrationsDir);
  const migrationFiles = files.filter((name) => /^\d+_.+\.sql$/i.test(name));
  addCheck("migration files exist", migrationFiles.length > 0);

  const config = loadConfig();
  addCheck("auth mode valid", ["local", "oauth"].includes(config.authMode));

  const invoke = async (
    method: string,
    url: string,
    options: {
      headers?: Record<string, string>;
      syncDeps?: Partial<SyncRouteDependencies>;
      adminDeps?: Partial<AdminRouteDependencies>;
      body?: unknown;
      rawBody?: string;
    } = {}
  ) => {
    const handler = buildHandler(config.corsOrigin, options.syncDeps, options.adminDeps);
    const headers = new Map<string, string>();
    const responseState: {
      statusCode: number;
      body: string;
    } = { statusCode: 200, body: "" };

    const bodyText =
      typeof options.rawBody === "string"
        ? options.rawBody
        : options.body === undefined
          ? ""
          : JSON.stringify(options.body);

    const request = {
      method,
      url,
      headers: options.headers ?? {},
      [Symbol.asyncIterator]: async function* () {
        if (!bodyText) {
          return;
        }
        yield Buffer.from(bodyText);
      },
    } as unknown as Parameters<typeof handler>[0];
    const response = {
      statusCode: 200,
      setHeader: (key: string, value: string | string[]) => {
        if (Array.isArray(value)) {
          headers.set(key.toLowerCase(), value[value.length - 1] ?? "");
          return;
        }
        headers.set(key.toLowerCase(), value);
      },
      getHeader: (key: string) => headers.get(key.toLowerCase()),
      end: (body?: string) => {
        responseState.statusCode = response.statusCode;
        responseState.body = body ?? "";
      },
    } as unknown as Parameters<typeof handler>[1];

    await handler(request, response);
    const json =
      responseState.body.trim().length > 0
        ? (JSON.parse(responseState.body) as Record<string, unknown>)
        : {};
    return {
      statusCode: responseState.statusCode,
      json,
      headers,
    };
  };

  const live = await invoke("GET", "/health/live");
  addCheck(
    "health live responds 200",
    live.statusCode === 200,
    `Expected 200, got ${live.statusCode}`
  );
  addCheck("health live payload ok=true", live.json.ok === true);
  addCheck(
    "health/live returns request id header",
    typeof live.headers.get("x-request-id") === "string" &&
      (live.headers.get("x-request-id") ?? "").length > 0
  );

  const authSessionSignedOut = await invoke("GET", "/auth/session");
  addCheck(
    "auth session signed-out returns 200",
    authSessionSignedOut.statusCode === 200,
    `Expected 200, got ${authSessionSignedOut.statusCode}`
  );
  addCheck(
    "auth session signed-out payload authenticated=false",
    authSessionSignedOut.json.authenticated === false
  );

  const authStart = await invoke("GET", "/auth/oauth/start?return_to=/auth/callback");
  addCheck(
    "auth oauth start returns redirect",
    authStart.statusCode === 302,
    `Expected 302, got ${authStart.statusCode}`
  );
  addCheck(
    "auth oauth start includes location header",
    typeof authStart.headers.get("location") === "string" &&
      (authStart.headers.get("location") ?? "").length > 0
  );

  const unauthenticated = await invoke("GET", "/sync/pull?team_id=team_default");
  addCheck(
    "sync pull unauthenticated returns 401",
    unauthenticated.statusCode === 401,
    `Expected 401, got ${unauthenticated.statusCode}`
  );

  const nonMember = await invoke("GET", "/sync/pull?team_id=team_default", {
    syncDeps: {
      authenticateRequest: async (request) => {
        const session = { user_id: "user_non_member", session_id: "session_non_member" };
        request.auth = session;
        return session;
      },
      requireTeamMember: async () => {
        throw new ApiError(403, "NOT_TEAM_MEMBER", "User is not a member of the requested team.");
      },
    },
  });
  addCheck(
    "sync pull non-member returns 403",
    nonMember.statusCode === 403,
    `Expected 403, got ${nonMember.statusCode}`
  );

  const adminUnauthenticated = await invoke(
    "GET",
    "/admin/metrics?team_id=team_default"
  );
  addCheck(
    "admin metrics unauthenticated returns 401",
    adminUnauthenticated.statusCode === 401,
    `Expected 401, got ${adminUnauthenticated.statusCode}`
  );

  const adminMetrics = await invoke("GET", "/admin/metrics?team_id=team_default", {
    adminDeps: {
      authenticateRequest: async (request) => {
        const session = { user_id: "user_owner", session_id: "session_owner" };
        request.auth = session;
        return session;
      },
      requireTeamMember: async () => "owner",
      getMetricsSnapshot: () => ({
        generated_at: "test",
        uptime_seconds: 1,
        counters: {
          push_success_total: 0,
          push_failure_total: 0,
          pull_success_total: 0,
          pull_failure_total: 0,
          auth_failure_total: 0,
        },
        rates_per_minute: {
          push_success: 0,
          push_failure: 0,
          pull_success: 0,
          pull_failure: 0,
          auth_failure: 0,
        },
        rejected_ops_by_reason: [],
        queue_lag_proxy: [],
      }),
    },
  });
  addCheck(
    "admin metrics owner returns 200",
    adminMetrics.statusCode === 200,
    `Expected 200, got ${adminMetrics.statusCode}`
  );
  addCheck(
    "admin metrics payload includes request id",
    typeof adminMetrics.json.request_id === "string" &&
      (adminMetrics.json.request_id as string).length > 0
  );

  const pullEmpty = await invoke("GET", "/sync/pull?team_id=team_default", {
    syncDeps: {
      authenticateRequest: async (request) => {
        const session = { user_id: "user_viewer", session_id: "session_viewer" };
        request.auth = session;
        return session;
      },
      requireTeamMember: async () => "viewer",
      getLatestSeq: async () => 0,
      listOpsSince: async () => [],
    },
  });
  addCheck(
    "sync pull empty returns 200",
    pullEmpty.statusCode === 200,
    `Expected 200, got ${pullEmpty.statusCode}`
  );
  addCheck(
    "sync pull empty has latest_seq 0",
    pullEmpty.json.latest_seq === 0
  );
  addCheck(
    "sync pull empty has no ops",
    Array.isArray(pullEmpty.json.ops) && pullEmpty.json.ops.length === 0
  );

  const pullArgs: { since: number; limit: number }[] = [];
  const pullAfterCursor = await invoke(
    "GET",
    "/sync/pull?team_id=team_default&since_seq=2&limit=999999",
    {
      syncDeps: {
        authenticateRequest: async (request) => {
          const session = { user_id: "user_viewer", session_id: "session_viewer" };
          request.auth = session;
          return session;
        },
        requireTeamMember: async () => "viewer",
        getLatestSeq: async () => 9,
        listOpsSince: async (_teamId, since, limit) => {
          pullArgs.push({ since, limit });
          return [
            {
              server_seq: 4,
              op: {
                op_id: "op_4",
                team_id: "team_default",
                actor_user_id: "user_viewer",
                created_at: 4,
                op_name: "set_status",
                payload: { item_id: "item_4", status: "todo" },
              },
            },
            {
              server_seq: 2,
              op: {
                op_id: "op_2",
                team_id: "team_default",
                actor_user_id: "user_viewer",
                created_at: 2,
                op_name: "set_status",
                payload: { item_id: "item_2", status: "todo" },
              },
            },
            {
              server_seq: 3,
              op: {
                op_id: "op_3",
                team_id: "team_default",
                actor_user_id: "user_viewer",
                created_at: 3,
                op_name: "set_status",
                payload: { item_id: "item_3", status: "todo" },
              },
            },
          ];
        },
      },
    }
  );
  addCheck(
    "sync pull after cursor returns 200",
    pullAfterCursor.statusCode === 200,
    `Expected 200, got ${pullAfterCursor.statusCode}`
  );
  addCheck(
    "sync pull forwards since_seq to data layer",
    pullArgs[0]?.since === 2
  );
  addCheck(
    "sync pull caps limit to 5000",
    pullArgs[0]?.limit === 5000
  );
  const pullAfterOps = pullAfterCursor.json.ops as Array<Record<string, unknown>>;
  addCheck(
    "sync pull after cursor keeps strict ascending order",
    Array.isArray(pullAfterOps) &&
      pullAfterOps.length === 2 &&
      pullAfterOps[0]?.server_seq === 3 &&
      pullAfterOps[1]?.server_seq === 4
  );
  addCheck(
    "sync pull after cursor includes latest_seq",
    pullAfterCursor.json.latest_seq === 9
  );

  const malformedSinceSeq = await invoke(
    "GET",
    "/sync/pull?team_id=team_default&since_seq=abc",
    {
      syncDeps: {
        authenticateRequest: async (request) => {
          const session = { user_id: "user_viewer", session_id: "session_viewer" };
          request.auth = session;
          return session;
        },
      },
    }
  );
  addCheck(
    "sync pull malformed since_seq returns 400",
    malformedSinceSeq.statusCode === 400,
    `Expected 400, got ${malformedSinceSeq.statusCode}`
  );

  const missingTeamId = await invoke("GET", "/sync/pull?since_seq=0", {
    syncDeps: {
      authenticateRequest: async (request) => {
        const session = { user_id: "user_viewer", session_id: "session_viewer" };
        request.auth = session;
        return session;
      },
    },
  });
  addCheck(
    "sync pull missing team_id returns 400",
    missingTeamId.statusCode === 400,
    `Expected 400, got ${missingTeamId.statusCode}`
  );

  const viewerWrite = await invoke("POST", "/sync/push?team_id=team_default", {
    body: {
      team_id: "team_default",
      client_id: "device_viewer",
      ops: [
        {
          op_id: "op_viewer_1",
          team_id: "team_default",
          actor_user_id: "user_viewer",
          created_at: Date.now(),
          op_name: "create_item",
          payload: {
            id: "item_viewer_1",
            project_id: "project_1",
            type: "task",
          },
        },
      ],
    },
    syncDeps: {
      authenticateRequest: async (request) => {
        const session = { user_id: "user_viewer", session_id: "session_viewer" };
        request.auth = session;
        return session;
      },
      requireTeamMember: async () => "viewer",
    },
  });
  addCheck(
    "sync push viewer returns 403",
    viewerWrite.statusCode === 403,
    `Expected 403, got ${viewerWrite.statusCode}`
  );

  const malformedPush = await invoke("POST", "/sync/push", {
    body: {
      team_id: "team_default",
      client_id: "device_editor",
      ops: "invalid",
    },
    syncDeps: {
      authenticateRequest: async (request) => {
        const session = { user_id: "user_editor", session_id: "session_editor" };
        request.auth = session;
        return session;
      },
      requireTeamMember: async () => "editor",
    },
  });
  addCheck(
    "sync push malformed payload returns 400",
    malformedPush.statusCode === 400,
    `Expected 400, got ${malformedPush.statusCode}`
  );

  const crossTeamAttempt = await invoke("POST", "/sync/push", {
    body: {
      team_id: "team_default",
      client_id: "device_editor",
      ops: [
        {
          op_id: "op_cross_team",
          team_id: "team_other",
          actor_user_id: "user_editor",
          created_at: Date.now(),
          op_name: "create_item",
          payload: {
            id: "item_cross",
            project_id: "project_1",
            type: "task",
          },
        },
      ],
    },
    syncDeps: {
      authenticateRequest: async (request) => {
        const session = { user_id: "user_editor", session_id: "session_editor" };
        request.auth = session;
        return session;
      },
      requireTeamMember: async () => "editor",
      appendOrGetServerSeq: async () => 1,
    },
  });
  addCheck(
    "sync push cross-team op rejected",
    crossTeamAttempt.statusCode === 200 &&
      Array.isArray(crossTeamAttempt.json.rejected) &&
      (crossTeamAttempt.json.rejected[0] as Record<string, unknown>)?.reason &&
      ((crossTeamAttempt.json.rejected[0] as Record<string, unknown>)
        .reason as Record<string, unknown>)?.code === "cross_team_access",
    `Expected cross_team_access rejection, got ${JSON.stringify(crossTeamAttempt.json)}`
  );

  const oversizedBody = await invoke("POST", "/sync/push", {
    rawBody: "x".repeat(400_000),
    syncDeps: {
      authenticateRequest: async (request) => {
        const session = { user_id: "user_editor", session_id: "session_editor" };
        request.auth = session;
        return session;
      },
      requireTeamMember: async () => "editor",
    },
  });
  addCheck(
    "sync push oversized payload returns 413",
    oversizedBody.statusCode === 413,
    `Expected 413, got ${oversizedBody.statusCode}`
  );

  const opStore = new Map<string, number>();
  let nextSeq = 1;
  const idempotentDeps: Partial<SyncRouteDependencies> = {
    authenticateRequest: async (request) => {
      const session = { user_id: "user_editor", session_id: "session_editor" };
      request.auth = session;
      return session;
    },
    requireTeamMember: async () => "editor",
    appendOrGetServerSeq: async (_teamId, _clientId, _actorUserId, op) => {
      const existing = opStore.get(op.op_id);
      if (existing) {
        return existing;
      }
      const seq = nextSeq++;
      opStore.set(op.op_id, seq);
      return seq;
    },
  };

  const duplicatePayload = {
    team_id: "team_default",
    client_id: "device_editor",
    ops: [
      {
        op_id: "op_dup_1",
        team_id: "team_default",
        actor_user_id: "user_editor",
        created_at: Date.now(),
        op_name: "create_item",
        payload: {
          id: "item_dup_1",
          project_id: "project_1",
          type: "task",
        },
      },
    ],
  };

  const duplicateFirst = await invoke("POST", "/sync/push", {
    body: duplicatePayload,
    syncDeps: idempotentDeps,
  });
  addCheck(
    "sync push duplicate first call returns 200",
    duplicateFirst.statusCode === 200,
    `Expected 200, got ${duplicateFirst.statusCode}`
  );
  const duplicateFirstAcked = duplicateFirst.json.acked as Array<Record<string, unknown>>;
  addCheck(
    "sync push duplicate first call ack count is 1",
    Array.isArray(duplicateFirstAcked) && duplicateFirstAcked.length === 1
  );

  const duplicateSecond = await invoke("POST", "/sync/push", {
    body: duplicatePayload,
    syncDeps: idempotentDeps,
  });
  addCheck(
    "sync push duplicate second call returns 200",
    duplicateSecond.statusCode === 200,
    `Expected 200, got ${duplicateSecond.statusCode}`
  );
  const duplicateSecondAcked = duplicateSecond.json.acked as Array<Record<string, unknown>>;
  addCheck(
    "sync push duplicate op_id keeps same server_seq",
    Array.isArray(duplicateFirstAcked) &&
      Array.isArray(duplicateSecondAcked) &&
      duplicateFirstAcked[0]?.server_seq === duplicateSecondAcked[0]?.server_seq
  );

  const mixedBatch = await invoke("POST", "/sync/push", {
    body: {
      team_id: "team_default",
      client_id: "device_editor",
      ops: [
        {
          op_id: "op_mixed_acked",
          team_id: "team_default",
          actor_user_id: "user_editor",
          created_at: Date.now(),
          op_name: "create_item",
          payload: {
            id: "item_mixed_1",
            project_id: "project_1",
            type: "task",
          },
        },
        {
          op_id: "op_mixed_rejected",
          team_id: "team_default",
          actor_user_id: "user_editor",
          created_at: Date.now(),
          op_name: "op.not_supported",
          payload: {
            item_id: "item_mixed_1",
          },
        },
      ],
    },
    syncDeps: idempotentDeps,
  });
  addCheck(
    "sync push mixed batch returns 200",
    mixedBatch.statusCode === 200,
    `Expected 200, got ${mixedBatch.statusCode}`
  );
  const mixedAcked = mixedBatch.json.acked as Array<Record<string, unknown>>;
  const mixedRejected = mixedBatch.json.rejected as Array<Record<string, unknown>>;
  addCheck(
    "sync push mixed batch has 1 ack and 1 reject",
    Array.isArray(mixedAcked) &&
      mixedAcked.length === 1 &&
      Array.isArray(mixedRejected) &&
      mixedRejected.length === 1
  );
  addCheck(
    "sync push mixed batch reject reason is unknown_op",
    (mixedRejected[0]?.reason as Record<string, unknown>)?.code === "unknown_op"
  );

  if (!config.databaseUrl) {
    const ready = await invoke("GET", "/health/ready");
    addCheck(
      "health ready returns 503 without DB",
      ready.statusCode === 503,
      `Expected 503, got ${ready.statusCode}`
    );
    addCheck(
      "health ready payload status not_ready without DB",
      ready.json.status === "not_ready"
    );
    addCheck(
      "db check skipped",
      true,
      "DATABASE_URL not set; schema verification skipped"
    );
    return;
  }

  const psql = await ensurePsqlAvailable();
  addCheck("psql installed", psql.ok, psql.ok ? undefined : psql.error);

  await runMigrations();

  const ready = await invoke("GET", "/health/ready");
  addCheck(
    "health ready responds 200 with DB",
    ready.statusCode === 200,
    `Expected 200, got ${ready.statusCode}`
  );
  addCheck("health ready payload ok=true with DB", ready.json.ok === true);

  const tableRows = await queryRows(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;`,
    ["tablename"] as const
  );
  const tableSet = new Set(
    tableRows
      .map((row) => row.tablename)
      .filter((value): value is string => typeof value === "string")
  );

  for (const tableName of [
    "schema_migrations",
    "teams",
    "users",
    "team_members",
    "sessions",
    "team_seq",
    "team_oplog",
  ]) {
    addCheck(
      `table exists: ${tableName}`,
      tableSet.has(tableName),
      `Missing table ${tableName}`
    );
  }
};

run()
  .then(() => {
    console.log("sync-server smoke checks passed.");
    for (const check of checks) {
      const suffix = check.details ? ` (${check.details})` : "";
      console.log(`- OK: ${check.name}${suffix}`);
    }
  })
  .catch((error) => {
    console.error("sync-server smoke checks failed.");
    for (const check of checks) {
      const status = check.ok ? "OK" : "FAIL";
      const suffix = check.details ? ` (${check.details})` : "";
      console.error(`- ${status}: ${check.name}${suffix}`);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
