import { mutate, query } from "../rpc/clientSingleton";

const now = () => Date.now();

const assert = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(`ASSERT: ${message}`);
  }
};

export const runScheduledForSmoke = async () => {
  console.groupCollapsed("%cscheduledForSmoke: start", "font-weight:bold;");
  try {
    const dueAt = now() + 60 * 60 * 1000;
    const scheduledFor = now() + 30 * 60 * 1000;
    const scheduledDuration = 45;

    const project = await mutate<{ id: string }>("create_item", {
      type: "project",
      title: `SMOKE Project ${new Date().toISOString()}`,
      due_at: dueAt,
      estimate_minutes: 0,
    });
    const projectId = project?.result?.id ?? project?.id;
    assert(typeof projectId === "string", "create project should return id");

    const task = await mutate<{ id: string }>("create_item", {
      type: "task",
      parent_id: projectId,
      title: "SMOKE Task Scheduled",
      due_at: dueAt,
      estimate_minutes: 30,
      scheduled_for: scheduledFor,
      scheduled_duration_minutes: scheduledDuration,
    });
    const taskId = task?.result?.id ?? task?.id;
    assert(typeof taskId === "string", "create task should return id");

    const list = await query<{ items: Array<Record<string, unknown>> }>(
      "listItems",
      {
        scope: { kind: "project", id: projectId },
        includeDone: true,
        includeCanceled: true,
        orderBy: "due_at",
        orderDir: "asc",
      }
    );
    const items = Array.isArray(list?.items) ? list.items : [];
    const found = items.find((item) => item.id === taskId);
    assert(found, "listItems should include created task");
    assert(
      found?.scheduled_for === scheduledFor,
      "scheduled_for should round-trip"
    );
    assert(
      found?.scheduled_duration_minutes === scheduledDuration,
      "scheduled_duration_minutes should round-trip"
    );

    console.log("%cscheduledForSmoke: ✅ passed", "font-weight:bold;");
  } catch (error) {
    console.error("scheduledForSmoke: ❌ failed", error);
    throw error;
  } finally {
    console.groupEnd();
  }
};
