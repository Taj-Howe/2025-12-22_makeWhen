import type { IncomingMessage } from "node:http";
import { buildHandler } from "../src/app.ts";
import { ApiError } from "../src/auth/errors.ts";
import type { SyncRouteDependencies } from "../src/routes/sync.ts";
import type { OpEnvelope } from "../../../src/rpc/types.ts";

type Result = {
  name: string;
  ok: boolean;
  detail?: string;
};

type Role = "owner" | "editor" | "viewer";

type RemoteLogEntry = {
  server_seq: number;
  op: OpEnvelope;
  client_id: string;
};

type TeamLog = {
  latestSeq: number;
  byOpId: Map<string, number>;
  entries: RemoteLogEntry[];
};

const TEAM_ID = "team_e2e";
const USER_ID = "user_sync";
const TOKEN_A = "token_a";
const TOKEN_B = "token_b";

const deepClone = <T>(value: T): T => {
  return JSON.parse(JSON.stringify(value)) as T;
};

class InMemoryRemoteLog {
  private teams = new Map<string, TeamLog>();

  private ensureTeam(teamId: string): TeamLog {
    const existing = this.teams.get(teamId);
    if (existing) {
      return existing;
    }
    const created: TeamLog = {
      latestSeq: 0,
      byOpId: new Map<string, number>(),
      entries: [],
    };
    this.teams.set(teamId, created);
    return created;
  }

  getLatestSeq(teamId: string) {
    return this.ensureTeam(teamId).latestSeq;
  }

  listOpsSince(teamId: string, sinceSeq: number, limit: number) {
    return this.ensureTeam(teamId).entries
      .filter((entry) => entry.server_seq > sinceSeq)
      .sort((a, b) => a.server_seq - b.server_seq)
      .slice(0, limit)
      .map((entry) => deepClone({ server_seq: entry.server_seq, op: entry.op }));
  }

  appendOrGetServerSeq(
    teamId: string,
    clientId: string,
    actorUserId: string,
    op: OpEnvelope
  ) {
    const team = this.ensureTeam(teamId);
    const existingSeq = team.byOpId.get(op.op_id);
    if (typeof existingSeq === "number") {
      return existingSeq;
    }

    const nextSeq = team.latestSeq + 1;
    const storedOp: OpEnvelope = {
      ...deepClone(op),
      team_id: teamId,
      actor_user_id: actorUserId,
    };
    team.latestSeq = nextSeq;
    team.byOpId.set(storedOp.op_id, nextSeq);
    team.entries.push({
      server_seq: nextSeq,
      op: storedOp,
      client_id: clientId,
    });
    return nextSeq;
  }

  getCount(teamId: string) {
    return this.ensureTeam(teamId).entries.length;
  }
}

const membership = new Map<string, Map<string, Role>>([
  [TEAM_ID, new Map([[USER_ID, "editor"]])],
]);

const sessions = new Map<string, string>([
  [TOKEN_A, USER_ID],
  [TOKEN_B, USER_ID],
]);

const roleRank: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

const getBearer = (request: IncomingMessage) => {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
};

const remote = new InMemoryRemoteLog();

const syncDeps: Partial<SyncRouteDependencies> = {
  authenticateRequest: async (request) => {
    const token = getBearer(request);
    if (!token) {
      throw new ApiError(401, "UNAUTHENTICATED", "Missing bearer token.");
    }
    const userId = sessions.get(token);
    if (!userId) {
      throw new ApiError(401, "UNAUTHENTICATED", "Invalid bearer token.");
    }
    const session = {
      user_id: userId,
      session_id: token,
    };
    request.auth = session;
    return session;
  },
  requireTeamMember: async (userId, teamId) => {
    const role = membership.get(teamId)?.get(userId);
    if (!role) {
      throw new ApiError(403, "NOT_TEAM_MEMBER", "User is not a member.");
    }
    return role;
  },
  requireRoleAtLeast: (actual, required) => {
    if (roleRank[actual] >= roleRank[required]) {
      return actual;
    }
    throw new ApiError(
      403,
      "INSUFFICIENT_ROLE",
      `Role ${actual} is below required ${required}.`
    );
  },
  getLatestSeq: async (teamId) => remote.getLatestSeq(teamId),
  listOpsSince: async (teamId, sinceSeq, limit) =>
    remote.listOpsSince(teamId, sinceSeq, limit),
  appendOrGetServerSeq: async (teamId, clientId, actorUserId, op) =>
    remote.appendOrGetServerSeq(teamId, clientId, actorUserId, op),
};

const handler = buildHandler("*", syncDeps);

const invoke = async (
  method: "GET" | "POST",
  url: string,
  token: string,
  body?: unknown
) => {
  const responseState: { statusCode: number; body: string } = {
    statusCode: 200,
    body: "",
  };
  const bodyText = body === undefined ? "" : JSON.stringify(body);

  const request = {
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    [Symbol.asyncIterator]: async function* () {
      if (!bodyText) {
        return;
      }
      yield Buffer.from(bodyText);
    },
  } as unknown as Parameters<typeof handler>[0];

  const response = {
    statusCode: 200,
    setHeader: () => {},
    end: (payload?: string) => {
      responseState.statusCode = response.statusCode;
      responseState.body = payload ?? "";
    },
  } as unknown as Parameters<typeof handler>[1];

  await handler(request, response);
  return {
    statusCode: responseState.statusCode,
    json: responseState.body
      ? (JSON.parse(responseState.body) as Record<string, unknown>)
      : {},
  };
};

type DeviceStateItem = {
  id: string;
  type: string;
  title: string;
  project_id: string;
};

type DeviceState = {
  items: Map<string, DeviceStateItem>;
  scheduledByItem: Map<string, { block_id: string; start_at: number; duration_minutes: number }>;
  dependencies: Set<string>;
};

class SimDevice {
  readonly name: string;
  readonly clientId: string;
  readonly userId: string;
  readonly token: string;

  private clock = 1000;
  private opCounter = 1;
  private readonly appliedOpIds = new Set<string>();
  private lastAppliedSeq = 0;
  private outbox: OpEnvelope[] = [];
  private state: DeviceState = {
    items: new Map(),
    scheduledByItem: new Map(),
    dependencies: new Set(),
  };

  constructor(name: string, clientId: string, userId: string, token: string) {
    this.name = name;
    this.clientId = clientId;
    this.userId = userId;
    this.token = token;
  }

  getState() {
    return this.state;
  }

  enqueue(
    op_name: string,
    payload: Record<string, unknown>,
    opId?: string,
    options?: { applyLocal?: boolean }
  ) {
    const op: OpEnvelope = {
      op_id: opId ?? `${this.clientId}_op_${this.opCounter++}`,
      team_id: TEAM_ID,
      actor_user_id: this.userId,
      created_at: this.clock++,
      op_name,
      payload,
    };
    if (options?.applyLocal !== false) {
      this.applyOp(op);
    }
    this.outbox.push(deepClone(op));
    return op;
  }

  requeue(op: OpEnvelope) {
    this.outbox.push(deepClone(op));
  }

  async push() {
    if (this.outbox.length === 0) {
      return {
        acked: [] as Array<{ op_id: string; server_seq: number }>,
        rejected: [] as Array<{ op_id: string; reason: unknown }>,
      };
    }
    const response = await invoke("POST", "/sync/push", this.token, {
      team_id: TEAM_ID,
      client_id: this.clientId,
      ops: this.outbox,
    });
    if (response.statusCode !== 200) {
      throw new Error(`${this.name} push failed (${response.statusCode}).`);
    }

    const ackedRaw = Array.isArray(response.json.acked)
      ? response.json.acked
      : [];
    const rejectedRaw = Array.isArray(response.json.rejected)
      ? response.json.rejected
      : [];

    const acked = ackedRaw
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const rec = entry as Record<string, unknown>;
        if (typeof rec.op_id !== "string") {
          return null;
        }
        const seq = Number(rec.server_seq);
        if (!Number.isFinite(seq)) {
          return null;
        }
        return { op_id: rec.op_id, server_seq: seq };
      })
      .filter((entry): entry is { op_id: string; server_seq: number } => entry !== null);

    const rejected = rejectedRaw
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const rec = entry as Record<string, unknown>;
        if (typeof rec.op_id !== "string") {
          return null;
        }
        return { op_id: rec.op_id, reason: rec.reason };
      })
      .filter((entry): entry is { op_id: string; reason: unknown } => entry !== null);

    const doneIds = new Set<string>([
      ...acked.map((entry) => entry.op_id),
      ...rejected.map((entry) => entry.op_id),
    ]);
    this.outbox = this.outbox.filter((entry) => !doneIds.has(entry.op_id));

    return { acked, rejected };
  }

  async pull() {
    const response = await invoke(
      "GET",
      `/sync/pull?team_id=${TEAM_ID}&since_seq=${this.lastAppliedSeq}&limit=5000`,
      this.token
    );
    if (response.statusCode !== 200) {
      throw new Error(`${this.name} pull failed (${response.statusCode}).`);
    }

    const ops = Array.isArray(response.json.ops)
      ? response.json.ops
      : [];

    for (const entry of ops) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const rec = entry as Record<string, unknown>;
      const op = rec.op;
      if (!op || typeof op !== "object") {
        continue;
      }
      const opRec = op as Record<string, unknown>;
      if (
        typeof opRec.op_id !== "string" ||
        typeof opRec.team_id !== "string" ||
        typeof opRec.actor_user_id !== "string" ||
        typeof opRec.op_name !== "string"
      ) {
        continue;
      }
      const created = Number(opRec.created_at);
      if (!Number.isFinite(created)) {
        continue;
      }
      const payload =
        opRec.payload && typeof opRec.payload === "object"
          ? (opRec.payload as Record<string, unknown>)
          : {};
      this.applyOp({
        op_id: opRec.op_id,
        team_id: opRec.team_id,
        actor_user_id: opRec.actor_user_id,
        created_at: created,
        op_name: opRec.op_name,
        payload,
      });
    }

    const latestSeq = Number(response.json.latest_seq ?? this.lastAppliedSeq);
    if (Number.isFinite(latestSeq)) {
      this.lastAppliedSeq = Math.max(this.lastAppliedSeq, latestSeq);
    }

    return {
      pulledCount: ops.length,
      latestSeq: this.lastAppliedSeq,
    };
  }

  async syncOnce() {
    const pushResult = await this.push();
    const pullResult = await this.pull();
    return {
      pushResult,
      pullResult,
    };
  }

  private applyOp(op: OpEnvelope) {
    if (this.appliedOpIds.has(op.op_id)) {
      return;
    }
    this.appliedOpIds.add(op.op_id);

    const payload =
      op.payload && typeof op.payload === "object"
        ? (op.payload as Record<string, unknown>)
        : {};

    switch (op.op_name) {
      case "create_item": {
        const id = typeof payload.id === "string" ? payload.id : null;
        const type = typeof payload.type === "string" ? payload.type : null;
        const projectId =
          typeof payload.project_id === "string"
            ? payload.project_id
            : id;
        if (!id || !type || !projectId) {
          return;
        }
        this.state.items.set(id, {
          id,
          type,
          project_id: projectId,
          title:
            typeof payload.title === "string" && payload.title.trim().length > 0
              ? payload.title
              : id,
        });
        return;
      }
      case "update_item_fields": {
        const itemId =
          typeof payload.item_id === "string"
            ? payload.item_id
            : typeof payload.id === "string"
              ? payload.id
              : null;
        if (!itemId) {
          return;
        }
        const existing = this.state.items.get(itemId);
        if (!existing) {
          return;
        }
        if (typeof payload.title === "string" && payload.title.trim().length > 0) {
          existing.title = payload.title;
        }
        return;
      }
      case "scheduled_block.create": {
        const itemId = typeof payload.item_id === "string" ? payload.item_id : null;
        const blockId = typeof payload.block_id === "string" ? payload.block_id : null;
        const startAt = Number(payload.start_at);
        const duration = Number(payload.duration_minutes ?? 60);
        if (!itemId || !blockId || !Number.isFinite(startAt) || !Number.isFinite(duration)) {
          return;
        }
        this.state.scheduledByItem.set(itemId, {
          block_id: blockId,
          start_at: startAt,
          duration_minutes: duration,
        });
        return;
      }
      case "dependency.create": {
        const itemId = typeof payload.item_id === "string" ? payload.item_id : null;
        const dependsOnId =
          typeof payload.depends_on_id === "string" ? payload.depends_on_id : null;
        if (!itemId || !dependsOnId) {
          return;
        }
        this.state.dependencies.add(`${itemId}->${dependsOnId}`);
        return;
      }
      default:
        return;
    }
  }
}

const results: Result[] = [];

const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail: ok ? undefined : detail });
  if (!ok) {
    throw new Error(detail ? `${name}: ${detail}` : name);
  }
};

const run = async () => {
  const deviceA = new SimDevice("Device A", "client_a", USER_ID, TOKEN_A);
  const deviceB = new SimDevice("Device B", "client_b", USER_ID, TOKEN_B);

  const projectId = "project_alpha";
  const taskAId = "task_alpha";
  const taskBId = "task_beta";

  deviceA.enqueue("create_item", {
    id: projectId,
    project_id: projectId,
    type: "project",
    title: "Project Alpha",
  });
  deviceA.enqueue("create_item", {
    id: taskAId,
    project_id: projectId,
    type: "task",
    title: "Task Alpha",
  });
  await deviceA.syncOnce();
  await deviceB.pull();

  check(
    "A creates project/task -> B pulls same IDs",
    deviceB.getState().items.has(projectId) && deviceB.getState().items.has(taskAId),
    "Device B did not converge on created project/task IDs"
  );

  deviceA.enqueue("scheduled_block.create", {
    block_id: "block_alpha_1",
    item_id: taskAId,
    start_at: 1730003600000,
    duration_minutes: 60,
  });
  await deviceA.syncOnce();
  await deviceB.pull();

  const firstBlock = deviceB.getState().scheduledByItem.get(taskAId);
  check(
    "A schedules block -> B pulls block",
    Boolean(firstBlock && firstBlock.block_id === "block_alpha_1"),
    "Scheduled block missing after pull"
  );

  deviceA.enqueue("scheduled_block.create", {
    block_id: "block_alpha_2",
    item_id: taskAId,
    start_at: 1730007200000,
    duration_minutes: 90,
  });
  await deviceA.syncOnce();
  await deviceB.pull();

  const secondBlock = deviceB.getState().scheduledByItem.get(taskAId);
  check(
    "One-block-per-item invariant holds on convergence",
    Boolean(secondBlock && secondBlock.block_id === "block_alpha_2"),
    "Expected only latest scheduled block for item"
  );

  deviceA.enqueue("create_item", {
    id: taskBId,
    project_id: projectId,
    type: "task",
    title: "Task Beta",
  });
  deviceA.enqueue("dependency.create", {
    item_id: taskBId,
    depends_on_id: taskAId,
  });
  await deviceA.syncOnce();
  await deviceB.pull();

  check(
    "A adds dependency -> B pulls dependency",
    deviceB.getState().dependencies.has(`${taskBId}->${taskAId}`),
    "Dependency edge missing on device B"
  );

  deviceA.enqueue("update_item_fields", {
    item_id: taskAId,
    title: "Task title from A",
  }, undefined, { applyLocal: false });
  deviceB.enqueue("update_item_fields", {
    item_id: taskAId,
    title: "Task title from B",
  }, undefined, { applyLocal: false });

  await deviceA.push();
  await deviceB.push();
  await deviceA.pull();
  await deviceB.pull();

  const titleA = deviceA.getState().items.get(taskAId)?.title ?? "";
  const titleB = deviceB.getState().items.get(taskAId)?.title ?? "";
  check(
    "Concurrent edits converge by last server_seq wins",
    titleA === "Task title from B" && titleB === "Task title from B",
    `Expected both devices to converge to B's title, got A='${titleA}' B='${titleB}'`
  );

  const replayOp = deviceA.enqueue(
    "update_item_fields",
    {
      item_id: taskBId,
      title: "Replay stable title",
    },
    "replay_op_1"
  );
  await deviceA.syncOnce();
  await deviceB.pull();

  const countBeforeReplay = remote.getCount(TEAM_ID);
  const firstReplayPush = await deviceA.push();
  check(
    "Replay setup push had no pending ops",
    firstReplayPush.acked.length === 0 && firstReplayPush.rejected.length === 0,
    "Expected replay setup to drain outbox"
  );

  deviceA.requeue(replayOp);
  const duplicatePushResult = await deviceA.push();
  await deviceB.pull();
  const countAfterReplay = remote.getCount(TEAM_ID);

  check(
    "Resending same op_id is idempotent",
    duplicatePushResult.acked.length === 1 && countBeforeReplay === countAfterReplay,
    "Duplicate op_id created additional side effects"
  );

  const finalTitle = deviceB.getState().items.get(taskBId)?.title ?? "";
  check(
    "Duplicate replay does not duplicate side effects",
    finalTitle === "Replay stable title",
    `Unexpected final title after replay: '${finalTitle}'`
  );
};

run()
  .then(() => {
    const passed = results.filter((entry) => entry.ok).length;
    console.log("E2E Sync Convergence Report");
    for (const result of results) {
      console.log(`- PASS: ${result.name}`);
      if (result.detail) {
        console.log(`  ${result.detail}`);
      }
    }
    console.log(`Summary: ${passed}/${results.length} checks passed.`);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("E2E Sync Convergence Report");
    for (const result of results) {
      const state = result.ok ? "PASS" : "FAIL";
      console.error(`- ${state}: ${result.name}`);
      if (result.detail) {
        console.error(`  ${result.detail}`);
      }
    }
    console.error(`Failure: ${message}`);
    process.exitCode = 1;
  });
