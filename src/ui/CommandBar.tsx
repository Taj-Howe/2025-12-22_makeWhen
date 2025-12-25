import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { mutate } from "../rpc/clientSingleton";
import { parseCommand, type ParsedCommand } from "../cli/parseCommand";
import { resolveCommand } from "../cli/resolveCommand";
import type { Scope } from "../rpc/types";

type CommandBarProps = {
  scope: Scope;
  items: Array<{ id: string; type: "project" | "milestone" | "task"; title: string }>;
  projects: Array<{ id: string; title: string }>;
  onRefresh: () => void;
};

type PreviewState =
  | { ok: false; message: string }
  | { ok: true; value: ParsedCommand; message?: string };

const formatIso = (value?: string) => (value ? new Date(value).toLocaleString() : "—");

const CommandBar: FC<CommandBarProps> = ({
  scope,
  items,
  projects,
  onRefresh,
}) => {
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [status, setStatus] = useState<"idle" | "working" | "created">("idle");
  const [showHelp, setShowHelp] = useState(false);

  const ctx = useMemo(
    () => ({
      now: new Date(),
      timezone: "local",
      defaultProjectId: scope.kind === "project" ? scope.id : undefined,
    }),
    [scope.id, scope.kind]
  );

  useEffect(() => {
    if (!input.trim()) {
      setPreview(null);
      return;
    }
    const result = parseCommand(input, ctx);
    if (!result.ok) {
      setPreview({ ok: false, message: result.error.message });
      return;
    }
    if (result.value.action !== "create") {
      setPreview({ ok: false, message: `action not supported yet: ${result.value.action}` });
      return;
    }
    const resolved = resolveCommand(result.value, { scope, items, projects });
    if (!resolved.ok) {
      setPreview({ ok: false, message: resolved.error.message });
      return;
    }
    if (!resolved.value.due_at) {
      setPreview({ ok: false, message: "due_at is required" });
      return;
    }
    setPreview({ ok: true, value: resolved.value });
  }, [ctx, input, items, scope]);

  const handleCreate = useCallback(async () => {
    if (!preview || !preview.ok) {
      return;
    }
    const parsed = preview.value;
    const type = parsed.type === "subtask" ? "task" : parsed.type;
    const dueAt = parsed.due_at ? new Date(parsed.due_at).getTime() : null;
    if (!dueAt) {
      setPreview({ ok: false, message: "due_at is required" });
      return;
    }
    const parentId = type === "project" ? null : parsed.parent_id ?? scope.id;
    setStatus("working");
    try {
      const result = await mutate<{ id: string }>("create_item", {
        type,
        title: parsed.title,
        parent_id: parentId,
        due_at: dueAt,
        estimate_minutes: parsed.estimate_minutes,
        estimate_mode: parsed.estimate_mode,
        status: parsed.status,
        priority: parsed.priority,
        notes: parsed.notes ?? null,
        health: parsed.health,
        health_mode: parsed.health_mode,
        scheduled_for: parsed.scheduled_for
          ? new Date(parsed.scheduled_for).getTime()
          : null,
        scheduled_duration_minutes: parsed.scheduled_duration_minutes ?? null,
      });
      const itemId = result?.result?.id ?? result?.id;
      if (itemId && parsed.tags.length > 0) {
        await mutate("set_item_tags", { item_id: itemId, tags: parsed.tags });
      }
      if (itemId && parsed.assignees && parsed.assignees.length > 0) {
        await mutate("set_item_assignees", {
          item_id: itemId,
          assignee_ids: parsed.assignees,
        });
      }
      if (itemId && parsed.depends_on.length > 0) {
        for (const depId of parsed.depends_on) {
          await mutate("add_dependency", {
            item_id: itemId,
            depends_on_id: depId,
          });
        }
      }
      setInput("");
      setPreview(null);
      setStatus("created");
      onRefresh();
      window.setTimeout(() => setStatus("idle"), 1200);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create item";
      setPreview({ ok: false, message });
      setStatus("idle");
    }
  }, [onRefresh, preview, scope.id]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        setInput("");
        setPreview(null);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        handleCreate();
      }
    },
    [handleCreate]
  );

  return (
    <div className="command-bar">
      <div className="command-header">
        <label className="command-label">
          Command
          <input
            className="command-input"
            placeholder='create task "Fix bug" under:"Milestone A" due:tomorrow pri:3 tags:ui,bug'
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </label>
        <button
          type="button"
          className="button button-ghost"
          onClick={() => setShowHelp((prev) => !prev)}
        >
          {showHelp ? "Hide help" : "Show help"}
        </button>
      </div>
      {showHelp ? (
        <div className="command-help">
          <div>
            <strong>Format</strong>: action + type + "title" + key:value pairs
          </div>
          <div>
            <strong>Types</strong>: project | milestone | task | subtask
          </div>
          <div>
            <strong>Actions</strong>: create | edit | archive
          </div>
          <div>
            <strong>Keys</strong>: id, in, under, assignee, status, pri, due,
            sched, est, tags, dep, notes, health
          </div>
          <div>
            <strong>Examples</strong>:
            <div className="command-help-example">
              create task "Fix bug" due:tomorrow pri:3 tags:ui,bug
            </div>
            <div className="command-help-example">
              create milestone "MVP v1" in:proj_123 due:2025-01-15 est:0
            </div>
            <div className="command-help-example">
              create task "Schedule sync" sched:2025-12-24T09:00/60
            </div>
          </div>
        </div>
      ) : null}
      <div className="command-meta">
        {status === "created" ? (
          <span className="command-success">Created</span>
        ) : null}
        {preview ? (
          preview.ok ? (
            <div className="command-preview">
              <div>
                <strong>action</strong>: {preview.value.action}
              </div>
              <div>
                <strong>type</strong>: {preview.value.type}
              </div>
              <div>
                <strong>title</strong>: {preview.value.title}
              </div>
              <div>
                <strong>due_at</strong>: {formatIso(preview.value.due_at)}
              </div>
              <div>
                <strong>scheduled_for</strong>:{" "}
                {formatIso(preview.value.scheduled_for)}
              </div>
              <div>
                <strong>duration</strong>:{" "}
                {preview.value.scheduled_duration_minutes ?? "—"}
              </div>
              <div>
                <strong>priority</strong>: {preview.value.priority}
              </div>
              <div>
                <strong>status</strong>: {preview.value.status}
              </div>
              <div>
                <strong>parent</strong>:{" "}
                {preview.value.type === "project"
                  ? "—"
                  : preview.value.parent_id ?? "project root"}
              </div>
            </div>
          ) : (
            <div className="command-error">{preview.message}</div>
          )
        ) : (
          <div className="command-hint">Enter a command to preview.</div>
        )}
      </div>
    </div>
  );
};

export default CommandBar;
