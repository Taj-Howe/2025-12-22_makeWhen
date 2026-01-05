import { useMemo, useState } from "react";
import { AppButton, AppSelect, AppTextArea } from "./controls";
import { serverOps } from "./serverApi";

type PlanConstraints = {
  targetDueDate?: string;
  workingHours?: string;
  style?: "web_dev" | "generic";
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

type PlanResponse = {
  ok: boolean;
  proposal?: PlanProposal;
  ops?: AiOp[];
  error?: string;
};

type AiPlanPanelProps = {
  projectId: string;
  projectTitle: string;
  onClose: () => void;
  onApplied: () => void;
};

const toIsoOrNull = (value: string) => {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
};

const AiPlanPanel = ({
  projectId,
  projectTitle,
  onClose,
  onApplied,
}: AiPlanPanelProps) => {
  const [promptText, setPromptText] = useState("");
  const [targetDueDate, setTargetDueDate] = useState("");
  const [workingHours, setWorkingHours] = useState("");
  const [style, setStyle] = useState<"generic" | "web_dev">("generic");
  const [proposal, setProposal] = useState<PlanProposal | null>(null);
  const [ops, setOps] = useState<AiOp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  const dependencyLabels = useMemo(() => {
    if (!proposal) {
      return [];
    }
    const titleByKey = new Map<string, string>();
    for (const milestone of proposal.milestones) {
      for (const task of milestone.tasks) {
        titleByKey.set(task.key, task.title);
      }
    }
    return proposal.dependencies.map((dep) => {
      const from = titleByKey.get(dep.predecessor_key) ?? dep.predecessor_key;
      const to = titleByKey.get(dep.successor_key) ?? dep.successor_key;
      return `${from} → ${to} (${dep.type})`;
    });
  }, [proposal]);

  const handleGenerate = async () => {
    if (!promptText.trim()) {
      setError("Add a prompt to generate a plan.");
      return;
    }
    setError(null);
    setLoading(true);
    setProposal(null);
    setOps([]);
    try {
      const response = await fetch("/api/ai/plan_project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          promptText,
          constraints: {
            targetDueDate: toIsoOrNull(targetDueDate),
            workingHours: workingHours.trim() || undefined,
            style,
          } satisfies PlanConstraints,
        }),
      });
      const payload = (await response.json()) as PlanResponse;
      if (!payload.ok) {
        throw new Error(payload.error || "AI plan failed");
      }
      setProposal(payload.proposal ?? null);
      setOps(payload.ops ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "AI plan failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const applyOps = async () => {
    if (!proposal || ops.length === 0) {
      return;
    }
    setApplying(true);
    setError(null);
    const idMap = new Map<string, string>();
    const createOps = ops.filter((op) => op.op_name === "item.create");
    const depOps = ops.filter((op) => op.op_name === "dependency.add");

    const runCreateOps = async (batch: AiOp[]) => {
      if (batch.length === 0) {
        return;
      }
      const payloadOps = batch.map((op) => {
        const args = op.args as Record<string, unknown>;
        const parentTempId =
          typeof args.parentTempId === "string" ? args.parentTempId : null;
        const parentId =
          parentTempId && idMap.has(parentTempId)
            ? idMap.get(parentTempId)
            : (args.parentId as string | null | undefined) ?? null;
        return {
          op_name: "item.create",
          args: {
            projectId: args.projectId,
            parentId,
            type: args.type,
            title: args.title,
            status: args.status ?? "backlog",
            priority: args.priority ?? 0,
            estimateMode: args.estimateMode ?? "manual",
            estimateMinutes: args.estimateMinutes ?? 0,
            dueAt: args.dueAt ?? null,
            notes: args.notes ?? null,
            assigneeUserId: args.assigneeUserId ?? null,
          },
        };
      });
      const response = await serverOps(payloadOps);
      if (!response.ok) {
        throw new Error(response.error || "Apply failed");
      }
      response.results?.forEach((result, index) => {
        const tempId = (batch[index].args as Record<string, unknown>).tempId;
        const createdId =
          result?.data && typeof (result.data as { id?: string }).id === "string"
            ? (result.data as { id: string }).id
            : null;
        if (result?.ok && typeof tempId === "string" && createdId) {
          idMap.set(tempId, createdId);
        }
      });
    };

    try {
      const milestoneOps = createOps.filter(
        (op) => (op.args as { type?: string }).type === "milestone"
      );
      const taskOps = createOps.filter(
        (op) => (op.args as { type?: string }).type !== "milestone"
      );
      await runCreateOps(milestoneOps);
      await runCreateOps(taskOps);

      const dependencyPayload = depOps
        .map((op) => {
          const args = op.args as Record<string, unknown>;
          const itemTempId = typeof args.itemTempId === "string" ? args.itemTempId : null;
          const dependsOnTempId =
            typeof args.dependsOnTempId === "string" ? args.dependsOnTempId : null;
          const itemId =
            typeof args.itemId === "string"
              ? args.itemId
              : itemTempId
                ? idMap.get(itemTempId) ?? null
                : null;
          const dependsOnId =
            typeof args.dependsOnId === "string"
              ? args.dependsOnId
              : dependsOnTempId
                ? idMap.get(dependsOnTempId) ?? null
                : null;
          if (!itemId || !dependsOnId) {
            return null;
          }
          return {
            op_name: "dependency.add",
            args: {
              itemId,
              dependsOnId,
              type: args.type ?? "FS",
              lagMinutes: args.lagMinutes ?? 0,
            },
          };
        })
        .filter(Boolean) as Array<{ op_name: string; args: Record<string, unknown> }>;

      if (dependencyPayload.length > 0) {
        const response = await serverOps(dependencyPayload);
        if (!response.ok) {
          throw new Error(response.error || "Apply failed");
        }
      }
      onApplied();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Apply failed";
      setError(message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="ai-panel">
      <div className="ai-panel-header">
        <div>
          <div className="ai-panel-title">AI Plan</div>
          <div className="ai-panel-subtitle">{projectTitle}</div>
        </div>
        <AppButton type="button" size="1" variant="ghost" onClick={onClose}>
          Close
        </AppButton>
      </div>

      <label className="ai-panel-label">
        Describe the plan you want
        <AppTextArea
          value={promptText}
          onChange={(event) => setPromptText(event.target.value)}
          placeholder="E.g. Plan a launch timeline with milestones and dependencies."
          rows={4}
        />
      </label>

      <div className="ai-panel-row">
        <label className="ai-panel-label">
          Target due date
          <input
            className="ai-panel-input"
            type="datetime-local"
            value={targetDueDate}
            onChange={(event) => setTargetDueDate(event.target.value)}
          />
        </label>
        <label className="ai-panel-label">
          Working hours
          <input
            className="ai-panel-input"
            type="text"
            placeholder="Mon–Fri, 9–5"
            value={workingHours}
            onChange={(event) => setWorkingHours(event.target.value)}
          />
        </label>
        <label className="ai-panel-label">
          Style
          <AppSelect
            value={style}
            onChange={(value) => setStyle(value as "generic" | "web_dev")}
            options={[
              { value: "generic", label: "Generic" },
              { value: "web_dev", label: "Web dev" },
            ]}
          />
        </label>
      </div>

      <div className="ai-panel-actions">
        <AppButton type="button" variant="surface" onClick={handleGenerate} disabled={loading}>
          {loading ? "Generating…" : "Generate plan"}
        </AppButton>
        <AppButton
          type="button"
          variant="solid"
          onClick={applyOps}
          disabled={!proposal || applying}
        >
          {applying ? "Applying…" : "Apply ops"}
        </AppButton>
      </div>

      {error ? <div className="ai-panel-error">{error}</div> : null}

      {proposal ? (
        <div className="ai-panel-preview">
          <div className="ai-panel-section-title">Proposal</div>
          <div className="ai-panel-section">
            <div className="ai-panel-section-label">{proposal.title}</div>
            {proposal.milestones.map((milestone) => (
              <div key={milestone.key} className="ai-panel-milestone">
                <div className="ai-panel-milestone-title">{milestone.title}</div>
                <ul className="ai-panel-task-list">
                  {milestone.tasks.map((task) => (
                    <li key={task.key}>
                      {task.title} · {task.estimate_minutes} min
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="ai-panel-section">
            <div className="ai-panel-section-label">Dependencies</div>
            {dependencyLabels.length > 0 ? (
              <ul className="ai-panel-task-list">
                {dependencyLabels.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            ) : (
              <div className="ai-panel-empty">No dependencies.</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default AiPlanPanel;
