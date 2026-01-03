import { useState, type FC } from "react";
import { mutate, query } from "../rpc/clientSingleton";
import { AppButton } from "./controls";

type SampleDataPanelProps = {
  onSeeded: (projectId: string) => void;
  onRefresh: () => void;
};

type UserLite = {
  user_id: string;
  display_name: string;
};

const createItem = async (args: Record<string, unknown>) => {
  const result = (await mutate("create_item", args)) as { id?: string };
  if (!result?.id) {
    throw new Error("Create item failed");
  }
  return result.id;
};

const getTime = (daysFromNow: number, hour: number, minute = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
};

const findOrCreateUser = async (name: string) => {
  const data = await query<{ users: UserLite[]; current_user_id?: string | null }>(
    "users_list",
    {}
  );
  const found = data.users.find((user) => user.display_name === name);
  if (found) {
    return found.user_id;
  }
  const created = (await mutate("user.create", {
    display_name: name,
  })) as { user_id?: string };
  if (!created?.user_id) {
    throw new Error("Create user failed");
  }
  return created.user_id;
};

const pickProjectTitle = (existing: string[], base: string) => {
  if (!existing.includes(base)) {
    return base;
  }
  let suffix = 2;
  let candidate = `${base} (${suffix})`;
  while (existing.includes(candidate)) {
    suffix += 1;
    candidate = `${base} (${suffix})`;
  }
  return candidate;
};

const seedSampleProject = async () => {
  const list = await query<{ items: Array<{ id: string; type: string; title: string }> }>(
    "listItems",
    { includeDone: true, includeCanceled: true }
  );
  const projectTitles = list.items
    .filter((item) => item.type === "project")
    .map((item) => item.title);
  const projectTitle = pickProjectTitle(projectTitles, "Sample Project");
  const currentUser = await findOrCreateUser("Me");
  const secondaryUser = await findOrCreateUser("Alex");

  const projectId = await createItem({
    type: "project",
    title: projectTitle,
    due_at: getTime(30, 17),
    estimate_mode: "rollup",
    estimate_minutes: 0,
    status: "in_progress",
    priority: 3,
    health: "on_track",
    health_mode: "manual",
    notes: "Sample project with milestones, tasks, blocks, and dependencies.",
  });
  await mutate("item.set_assignee", { item_id: projectId, user_id: currentUser });
  await mutate("set_item_tags", {
    item_id: projectId,
    tags: ["sample", "roadmap"],
  });

  const discoveryId = await createItem({
    type: "milestone",
    title: "Discovery & Scope",
    parent_id: projectId,
    due_at: getTime(7, 17),
    estimate_mode: "rollup",
    estimate_minutes: 0,
    status: "in_progress",
    priority: 2,
    health: "at_risk",
    health_mode: "manual",
    notes: "Define goals, constraints, and success metrics.",
  });
  await mutate("item.set_assignee", {
    item_id: discoveryId,
    user_id: currentUser,
  });

  const buildId = await createItem({
    type: "milestone",
    title: "Build & Iterate",
    parent_id: projectId,
    due_at: getTime(21, 17),
    estimate_mode: "rollup",
    estimate_minutes: 0,
    status: "ready",
    priority: 2,
    health: "unknown",
    health_mode: "auto",
    notes: "Execute engineering and design tasks.",
  });
  await mutate("item.set_assignee", { item_id: buildId, user_id: secondaryUser });

  const launchId = await createItem({
    type: "milestone",
    title: "Launch & Learn",
    parent_id: projectId,
    due_at: getTime(30, 12),
    estimate_mode: "rollup",
    estimate_minutes: 0,
    status: "backlog",
    priority: 1,
    health: "unknown",
    health_mode: "auto",
    notes: "Finalize rollout checklist and launch.",
  });
  await mutate("item.set_assignee", { item_id: launchId, user_id: currentUser });

  const interviewsId = await createItem({
    type: "task",
    title: "Interview power users",
    parent_id: discoveryId,
    due_at: getTime(3, 16),
    estimate_mode: "manual",
    estimate_minutes: 120,
    status: "in_progress",
    priority: 3,
    notes: "Capture workflows and pain points.",
  });
  await mutate("item.set_assignee", {
    item_id: interviewsId,
    user_id: currentUser,
  });
  await mutate("set_item_tags", {
    item_id: interviewsId,
    tags: ["research", "users"],
  });

  const synthId = await createItem({
    type: "task",
    title: "Synthesize findings",
    parent_id: discoveryId,
    due_at: getTime(5, 14),
    estimate_mode: "manual",
    estimate_minutes: 90,
    status: "ready",
    priority: 2,
    notes: "Summarize patterns and opportunities.",
  });
  await mutate("item.set_assignee", { item_id: synthId, user_id: currentUser });
  await mutate("set_item_tags", {
    item_id: synthId,
    tags: ["research", "analysis"],
  });

  const designId = await createItem({
    type: "task",
    title: "Draft system map",
    parent_id: discoveryId,
    due_at: getTime(6, 12),
    estimate_mode: "manual",
    estimate_minutes: 180,
    status: "ready",
    priority: 2,
    notes: "Diagram services, data flows, and key integrations.",
  });
  await mutate("item.set_assignee", {
    item_id: designId,
    user_id: secondaryUser,
  });
  await mutate("set_item_tags", {
    item_id: designId,
    tags: ["design", "architecture"],
  });
  await mutate("add_blocker", {
    item_id: designId,
    kind: "dependency",
    text: "Waiting on platform analytics access",
  });

  const apiId = await createItem({
    type: "task",
    title: "Implement API surface",
    parent_id: buildId,
    due_at: getTime(14, 17),
    estimate_mode: "manual",
    estimate_minutes: 240,
    status: "ready",
    priority: 3,
    notes: "Build endpoints and auth flows.",
  });
  await mutate("item.set_assignee", { item_id: apiId, user_id: secondaryUser });
  await mutate("set_item_tags", { item_id: apiId, tags: ["backend"] });

  const authSubId = await createItem({
    type: "task",
    title: "Auth endpoints",
    parent_id: apiId,
    due_at: getTime(10, 11),
    estimate_mode: "manual",
    estimate_minutes: 90,
    status: "done",
    priority: 2,
    notes: "Token issuance + refresh.",
  });
  await mutate("item.set_assignee", {
    item_id: authSubId,
    user_id: secondaryUser,
  });
  await mutate("add_time_entry", {
    item_id: authSubId,
    start_at: getTime(4, 9),
    end_at: getTime(4, 10, 30),
    duration_minutes: 90,
    note: "Initial auth implementation",
    source: "manual",
  });

  const uiId = await createItem({
    type: "task",
    title: "Ship UI polish",
    parent_id: buildId,
    due_at: getTime(18, 16),
    estimate_mode: "manual",
    estimate_minutes: 150,
    status: "ready",
    priority: 2,
    notes: "Refine styling and accessibility.",
  });
  await mutate("item.set_assignee", { item_id: uiId, user_id: currentUser });
  await mutate("set_item_tags", { item_id: uiId, tags: ["frontend"] });

  const updateId = await createItem({
    type: "task",
    title: "Stakeholder update",
    parent_id: projectId,
    due_at: getTime(4, 15),
    estimate_mode: "manual",
    estimate_minutes: 30,
    status: "ready",
    priority: 1,
    notes: "Send weekly update with progress + risks.",
  });
  await mutate("item.set_assignee", {
    item_id: updateId,
    user_id: currentUser,
  });

  const chainItems = [
    projectId,
    discoveryId,
    buildId,
    launchId,
    interviewsId,
    synthId,
    designId,
    apiId,
    authSubId,
    uiId,
    updateId,
  ];

  for (let index = 0; index < chainItems.length; index += 1) {
    const itemId = chainItems[index];
    const startAt = getTime(index + 1, 9 + (index % 3));
    const durationMinutes = 60 + (index % 3) * 30;
    await mutate("scheduled_block.create", {
      item_id: itemId,
      start_at: startAt,
      duration_minutes: durationMinutes,
      locked: 0,
      source: "manual",
    });
    if (index > 0) {
      await mutate("dependency.create", {
        predecessor_id: chainItems[index - 1],
        successor_id: itemId,
        type: "FS",
        lag_minutes: 0,
      });
    }
  }

  return projectId;
};

const SampleDataPanel: FC<SampleDataPanelProps> = ({ onSeeded, onRefresh }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSeed = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const projectId = await seedSampleProject();
      setSuccess("Sample project created.");
      onSeeded(projectId);
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sample-data-panel">
      <div className="sample-data-title">Sample Data</div>
      <p className="sample-data-help">
        Creates a project with milestones, tasks, subtasks, dependencies, blocks,
        tags, assignees, and blockers.
      </p>
      <AppButton
        type="button"
        variant="surface"
        onClick={() => void handleSeed()}
        disabled={loading}
      >
        {loading ? "Creating…" : "Create Sample Project"}
      </AppButton>
      {error ? <div className="error">{error}</div> : null}
      {success ? <div className="success">{success}</div> : null}
    </div>
  );
};

export default SampleDataPanel;
