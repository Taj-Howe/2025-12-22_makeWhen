import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrations.ts";
import { buildHandler } from "../src/app.ts";
import { ApiError } from "../src/auth/errors.ts";
import type { SyncRouteDependencies } from "../src/routes/sync.ts";
import type { AdminRouteDependencies } from "../src/routes/admin.ts";
import type { AuthRouteDependencies } from "../src/routes/auth.ts";
import type { TeamRouteDependencies } from "../src/routes/team.ts";
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
  addCheck("auth mode valid", ["local", "clerk"].includes(config.authMode));

  if (config.databaseUrl) {
    await runMigrations();
    addCheck("migrations apply", true);
  } else {
    addCheck("migrations skipped without DATABASE_URL", true);
  }

  const invoke = async (
    method: string,
    url: string,
    options: {
      headers?: Record<string, string>;
      syncDeps?: Partial<SyncRouteDependencies>;
      adminDeps?: Partial<AdminRouteDependencies>;
      authDeps?: Partial<AuthRouteDependencies>;
      teamDeps?: Partial<TeamRouteDependencies>;
      body?: unknown;
      rawBody?: string;
    } = {}
  ) => {
    const handler = buildHandler(
      config.corsOrigin,
      options.syncDeps,
      options.adminDeps,
      options.authDeps,
      options.teamDeps
    );
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

  const ready = await invoke("GET", "/health/ready");
  const expectedReadyStatus = config.databaseUrl ? 200 : 503;
  addCheck(
    "health ready status",
    ready.statusCode === expectedReadyStatus,
    `Expected ${expectedReadyStatus}, got ${ready.statusCode}`
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

  const clerkExchangeWithoutToken = await invoke("POST", "/auth/clerk/exchange", {
    body: {},
  });
  const expectedExchangeStatus = config.authMode === "clerk" ? 401 : 404;
  addCheck(
    "auth clerk exchange guard",
    clerkExchangeWithoutToken.statusCode === expectedExchangeStatus,
    `Expected ${expectedExchangeStatus}, got ${clerkExchangeWithoutToken.statusCode}`
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

  const adminUnauthenticated = await invoke("GET", "/admin/metrics?team_id=team_default");
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

  const pullAfterCursor = await invoke("GET", "/sync/pull?team_id=team_default&since_seq=2", {
    syncDeps: {
      authenticateRequest: async (request) => {
        const session = { user_id: "user_viewer", session_id: "session_viewer" };
        request.auth = session;
        return session;
      },
      requireTeamMember: async () => "viewer",
      getLatestSeq: async () => 9,
      listOpsSince: async () => [
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
      ],
    },
  });

  addCheck(
    "sync pull after cursor returns 200",
    pullAfterCursor.statusCode === 200,
    `Expected 200, got ${pullAfterCursor.statusCode}`
  );
  const pullOps = Array.isArray(pullAfterCursor.json.ops)
    ? (pullAfterCursor.json.ops as Array<Record<string, unknown>>)
    : [];
  addCheck(
    "sync pull sorted ascending",
    pullOps.length === 2 && pullOps[0]?.server_seq === 3 && pullOps[1]?.server_seq === 4
  );

  const teamMembersUnauthorized = await invoke("GET", "/teams/team_default/members");
  addCheck(
    "team members unauthenticated returns 401",
    teamMembersUnauthorized.statusCode === 401,
    `Expected 401, got ${teamMembersUnauthorized.statusCode}`
  );

  const teamUnknownRoute = await invoke("GET", "/teams/team_default/not-real", {
    teamDeps: {
      authenticateRequest: async (request) => {
        const session = { user_id: "user_viewer", session_id: "session_viewer" };
        request.auth = session;
        return session;
      },
      requireTeamMember: async () => "viewer",
    },
  });

  addCheck(
    "team route unknown path returns 404",
    teamUnknownRoute.statusCode === 404,
    `Expected 404, got ${teamUnknownRoute.statusCode}`
  );

  console.log("Smoke checks passed:");
  for (const check of checks) {
    console.log(`- ${check.name}`);
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
