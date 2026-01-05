import { randomUUID } from "crypto";
import { requireUser } from "../../../../lib/auth/session";
import { getDb } from "../../../../lib/db/connection";
import { checkRateLimit } from "../../../../lib/limit";

export const runtime = "nodejs";

type PlanConstraints = {
  targetDueDate?: string;
  workingHours?: string;
  style?: "web_dev" | "generic";
};

type PlanRequest = {
  projectId?: string;
  promptText?: string;
  constraints?: PlanConstraints;
};

type ProposalTask = {
  key: string;
  title: string;
  estimate_minutes: number;
};

type ProposalMilestone = {
  key: string;
  title: string;
  tasks: ProposalTask[];
};

type ProposalDependency = {
  predecessor_key: string;
  successor_key: string;
  type: "FS" | "SS" | "FF" | "SF";
  lag_minutes: number;
};

type PlanProposal = {
  title: string;
  milestones: ProposalMilestone[];
  dependencies: ProposalDependency[];
};

type AiOp = {
  op_name: "item.create" | "dependency.add";
  args: Record<string, unknown>;
};

const ensureProjectAccess = async (projectId: string, userId: string) => {
  const db = getDb();
  const member = await db
    .selectFrom("project_members")
    .select(["role"])
    .where("project_id", "=", projectId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!member) {
    throw new Error("FORBIDDEN");
  }
  return member.role;
};

const createKey = () => `tmp_${randomUUID().slice(0, 8)}`;

const buildMockPlan = (
  projectTitle: string,
  promptText: string,
  _constraints?: PlanConstraints
) => {
  const planTitle =
    promptText.trim().length > 0 ? promptText.trim() : `Plan for ${projectTitle}`;
  const milestones: ProposalMilestone[] = [
    {
      key: createKey(),
      title: "Discovery & Scope",
      tasks: [
        { key: createKey(), title: "Clarify goals and constraints", estimate_minutes: 90 },
        { key: createKey(), title: "Inventory existing tasks and risks", estimate_minutes: 60 },
      ],
    },
    {
      key: createKey(),
      title: "Execution",
      tasks: [
        { key: createKey(), title: "Build the first milestone slice", estimate_minutes: 180 },
        { key: createKey(), title: "Review progress and adjust scope", estimate_minutes: 60 },
      ],
    },
    {
      key: createKey(),
      title: "Launch & Follow-up",
      tasks: [
        { key: createKey(), title: "Finalize deliverables", estimate_minutes: 120 },
        { key: createKey(), title: "Post-launch checklist", estimate_minutes: 45 },
      ],
    },
  ];

  const flatTasks = milestones.flatMap((milestone) => milestone.tasks);
  const dependencies: ProposalDependency[] = flatTasks.slice(1).map((task, index) => ({
    predecessor_key: flatTasks[index].key,
    successor_key: task.key,
    type: "FS",
    lag_minutes: 0,
  }));

  return { title: planTitle, milestones, dependencies } satisfies PlanProposal;
};

const buildOps = (
  projectId: string,
  proposal: PlanProposal
): AiOp[] => {
  const ops: AiOp[] = [];
  for (const milestone of proposal.milestones) {
    ops.push({
      op_name: "item.create",
      args: {
        tempId: milestone.key,
        projectId,
        type: "milestone",
        title: milestone.title,
        parentId: null,
        status: "backlog",
        priority: 0,
        estimateMode: "rollup",
        estimateMinutes: 0,
      },
    });
    for (const task of milestone.tasks) {
      ops.push({
        op_name: "item.create",
        args: {
          tempId: task.key,
          parentTempId: milestone.key,
          projectId,
          type: "task",
          title: task.title,
          status: "backlog",
          priority: 0,
          estimateMode: "manual",
          estimateMinutes: task.estimate_minutes,
        },
      });
    }
  }
  for (const dep of proposal.dependencies) {
    ops.push({
      op_name: "dependency.add",
      args: {
        itemTempId: dep.successor_key,
        dependsOnTempId: dep.predecessor_key,
        type: dep.type,
        lagMinutes: dep.lag_minutes,
      },
    });
  }
  return ops;
};

export const POST = async (request: Request) => {
  try {
    const actor = await requireUser();
    const rate = checkRateLimit(`ai:${actor.userId}`, {
      windowMs: 60_000,
      max: 10,
    });
    if (!rate.allowed) {
      return Response.json(
        { ok: false, error: "Rate limit exceeded" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) } }
      );
    }
    const payload = (await request.json()) as PlanRequest;
    const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
    const promptText =
      typeof payload.promptText === "string" ? payload.promptText.trim() : "";
    if (!projectId) {
      return Response.json(
        { ok: false, error: "projectId is required" },
        { status: 400 }
      );
    }
    if (!promptText) {
      return Response.json(
        { ok: false, error: "promptText is required" },
        { status: 400 }
      );
    }

    await ensureProjectAccess(projectId, actor.userId);

    const db = getDb();
    const project = await db
      .selectFrom("projects")
      .select(["id", "title"])
      .where("id", "=", projectId)
      .executeTakeFirst();
    if (!project) {
      return Response.json({ ok: false, error: "Project not found" }, { status: 404 });
    }

    const proposal = buildMockPlan(project.title, promptText, payload.constraints);
    const ops = buildOps(projectId, proposal);

    return Response.json({
      ok: true,
      proposal,
      ops,
      source: "mock",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "UNAUTHORIZED" ? 401 : message === "FORBIDDEN" ? 403 : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
};
