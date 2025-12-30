import type { FC } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { parseCommand } from "../cli/parseCommand";
import { mutate, query } from "../rpc/clientSingleton";
import { UNGROUPED_PROJECT_ID } from "./constants";

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedProjectId: string | null;
  onCreated: () => void;
};

const DEFAULT_SCHEDULE_MINUTES = 60;

const CommandPalette: FC<CommandPaletteProps> = ({
  open,
  onOpenChange,
  selectedProjectId,
  onCreated,
}) => {
  const [inputValue, setInputValue] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setSubmitError(null);
      const raf = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    setInputValue("");
    return;
  }, [open]);

  const parseResult = useMemo(() => {
    if (!inputValue.trim()) {
      return null;
    }
    return parseCommand(inputValue);
  }, [inputValue]);

  const helpMode = useMemo(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      return { kind: "general" as const };
    }
    const token = trimmed.split(/\s+/)[0]?.toLowerCase();
    if (token && COMMAND_HELP[token]) {
      return { kind: "command" as const, command: token };
    }
    if (token && ["create", "edit", "delete"].includes(token)) {
      return { kind: "command" as const, command: token };
    }
    return { kind: "general" as const };
  }, [inputValue]);

  const resolveTargetId = async (
    type: string,
    target: string,
    projectId?: string | null
  ) => {
    const data = await query<{ items: Array<{ id: string; title: string; type: string }> }>(
      "listItems",
      {
        projectId: projectId ?? selectedProjectId ?? undefined,
        includeDone: true,
        includeCanceled: true,
      }
    );
    const matches = data.items.filter((item) => {
      if (item.type !== type) {
        return false;
      }
      if (item.id === target) {
        return true;
      }
      return item.title.toLowerCase() === target.toLowerCase();
    });
    if (matches.length === 0) {
      throw new Error(`No ${type} found for "${target}"`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple ${type} items named "${target}"`);
    }
    return matches[0].id;
  };

  const resolveProjectId = async (target: string) => {
    const data = await query<{ items: Array<{ id: string; title: string; type: string }> }>(
      "listItems",
      {
        includeDone: true,
        includeCanceled: true,
      }
    );
    const matches = data.items.filter((item) => {
      if (item.type !== "project") {
        return false;
      }
      if (item.id === target) {
        return true;
      }
      return item.title.toLowerCase() === target.toLowerCase();
    });
    if (matches.length === 0) {
      throw new Error(`No project found for "${target}"`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple projects named "${target}"`);
    }
    return matches[0].id;
  };

  const handleSubmit = async () => {
    if (!inputValue.trim()) {
      setSubmitError("Enter a command");
      return;
    }
    const result = parseCommand(inputValue);
    if (!result.ok) {
      setSubmitError(result.error.message);
      return;
    }
    const value = result.value;
    if (value.verb === "delete") {
      let projectScopeId: string | null = null;
      if (value.inProject) {
        try {
          projectScopeId = await resolveProjectId(value.inProject);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setSubmitError(message);
          return;
        }
      }
      const targetId =
        value.id ??
        (value.target
          ? await resolveTargetId(value.type, value.target, projectScopeId)
          : null);
      if (!targetId) {
        setSubmitError("Delete requires an id or title");
        return;
      }
      try {
        await mutate("delete_item", { item_id: targetId });
        setSubmitError(null);
        setInputValue("");
        onOpenChange(false);
        onCreated();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setSubmitError(message);
      }
      return;
    }

    if (value.verb === "edit") {
      let projectScopeId: string | null = null;
      if (value.inProject) {
        try {
          projectScopeId = await resolveProjectId(value.inProject);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setSubmitError(message);
          return;
        }
      }
      const targetId =
        value.id ??
        (value.target
          ? await resolveTargetId(value.type, value.target, projectScopeId)
          : null);
      if (!targetId) {
        setSubmitError("Edit requires an id or title");
        return;
      }
      try {
        if (value.title) {
          await mutate("update_item_fields", {
            id: targetId,
            fields: { title: value.title },
          });
        }
        if (value.dueAt !== undefined) {
          await mutate("update_item_fields", {
            id: targetId,
            fields: { due_at: value.dueAt ?? null },
          });
        }
        if (value.priority !== undefined) {
          await mutate("update_item_fields", {
            id: targetId,
            fields: { priority: value.priority },
          });
        }
        if (value.status) {
          await mutate("set_status", { id: targetId, status: value.status });
        }
        if (value.notes !== undefined) {
          await mutate("update_item_fields", {
            id: targetId,
            fields: { notes: value.notes || null },
          });
        }
        if (value.estimateMode || value.estimateMinutes !== undefined) {
          await mutate("update_item_fields", {
            id: targetId,
            fields: {
              estimate_mode: value.estimateMode,
              estimate_minutes:
                value.estimateMinutes !== undefined ? value.estimateMinutes : undefined,
            },
          });
        }
        if (value.tags) {
          await mutate("set_item_tags", { item_id: targetId, tags: value.tags });
        }
        if (value.assignees) {
          await mutate("set_item_assignees", {
            item_id: targetId,
            assignee_ids: value.assignees,
          });
        }
        if (value.dependsOn) {
          const data = await query<{
            items: Array<{ id: string; depends_on: string[] }>;
          }>("listItems", {
            projectId: selectedProjectId ?? undefined,
            includeDone: true,
            includeCanceled: true,
          });
          const current = data.items.find((item) => item.id === targetId);
          const currentDeps = new Set(current?.depends_on ?? []);
          const desiredDeps = new Set(value.dependsOn);
          for (const depId of desiredDeps) {
            if (!currentDeps.has(depId)) {
              await mutate("add_dependency", {
                item_id: targetId,
                depends_on_id: depId,
              });
            }
          }
          for (const depId of currentDeps) {
            if (!desiredDeps.has(depId)) {
              await mutate("remove_dependency", {
                item_id: targetId,
                depends_on_id: depId,
              });
            }
          }
        }
        if (value.scheduledFor) {
          await mutate("create_block", {
            item_id: targetId,
            start_at: value.scheduledFor,
            duration_minutes: DEFAULT_SCHEDULE_MINUTES,
            locked: 0,
            source: "manual",
          });
        }
        setSubmitError(null);
        setInputValue("");
        onOpenChange(false);
        onCreated();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setSubmitError(message);
      }
      return;
    }

    const createArgs: Record<string, unknown> = {
      type: value.type,
      title: value.title,
      estimate_minutes: value.estimateMinutes ?? 0,
      estimate_mode: value.estimateMode,
    };

    const targetProjectId =
      selectedProjectId && selectedProjectId !== UNGROUPED_PROJECT_ID
        ? selectedProjectId
        : null;
    let resolvedProjectId: string | null = null;
    if (value.inProject) {
      try {
        resolvedProjectId = await resolveProjectId(value.inProject);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setSubmitError(message);
        return;
      }
    }

    if (value.parentId) {
      createArgs.parent_id = value.parentId;
    } else if (value.type === "milestone") {
      const projectParentId = resolvedProjectId ?? targetProjectId;
      if (!projectParentId) {
        setSubmitError("Milestone needs a project selected, in:<name>, or parent:<id>");
        return;
      }
      createArgs.parent_id = projectParentId;
    } else if (value.type === "task") {
      if (resolvedProjectId) {
        createArgs.parent_id = resolvedProjectId;
      } else if (targetProjectId) {
        createArgs.parent_id = targetProjectId;
      }
    }

    if (value.dueAt !== undefined) {
      createArgs.due_at = value.dueAt;
    } else {
      createArgs.due_at = null;
    }

    if (value.priority !== undefined) {
      createArgs.priority = value.priority;
    }

    try {
      const created = await mutate("create_item", createArgs);
      const itemId = created?.result?.id ?? created?.id;
      if (!itemId) {
        throw new Error("Create failed");
      }
      if (value.tags && value.tags.length > 0) {
        await mutate("set_item_tags", { item_id: itemId, tags: value.tags });
      }
      if (value.assignees && value.assignees.length > 0) {
        await mutate("set_item_assignees", {
          item_id: itemId,
          assignee_ids: value.assignees,
        });
      }
      if (value.dependsOn && value.dependsOn.length > 0) {
        for (const depId of value.dependsOn) {
          await mutate("add_dependency", {
            item_id: itemId,
            depends_on_id: depId,
          });
        }
      }
      if (value.scheduledFor) {
        await mutate("create_block", {
          item_id: itemId,
          start_at: value.scheduledFor,
          duration_minutes: DEFAULT_SCHEDULE_MINUTES,
          locked: 0,
          source: "manual",
        });
      }
      setSubmitError(null);
      setInputValue("");
      onOpenChange(false);
      onCreated();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setSubmitError(message);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <div className="palette-root" role="presentation">
          <Dialog.Overlay className="palette-overlay" />
          <Dialog.Content
            className="palette-content"
            aria-label="Command palette"
          >
        <div className="palette-header">
          <input
            ref={inputRef}
            className="palette-input"
            type="text"
            value={inputValue}
            onChange={(event) => {
              setInputValue(event.target.value);
              setSubmitError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleSubmit();
              }
            }}
            placeholder='task "Fix bug" due:2025-01-01 pri:3 tags:ui,bug'
          />
          {submitError ? (
            <div className="palette-error">{submitError}</div>
          ) : null}
          {parseResult && !parseResult.ok ? (
            <div className="palette-error">{parseResult.error.message}</div>
          ) : null}
          {parseResult && parseResult.ok ? (
            <div className="palette-preview">
              <div>
                <strong>Type:</strong> {parseResult.value.type}
              </div>
              <div>
                <strong>Title:</strong> {parseResult.value.title}
              </div>
              {parseResult.value.parentId ? (
                <div>
                  <strong>Parent:</strong> {parseResult.value.parentId}
                </div>
              ) : null}
              {parseResult.value.dueAt ? (
                <div>
                  <strong>Due:</strong>{" "}
                  {new Date(parseResult.value.dueAt).toLocaleString()}
                </div>
              ) : null}
              {parseResult.value.scheduledFor ? (
                <div>
                  <strong>Scheduled:</strong>{" "}
                  {new Date(parseResult.value.scheduledFor).toLocaleString()}
                  <span> ({DEFAULT_SCHEDULE_MINUTES} min)</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="palette-help">
          {helpMode.kind === "command" ? (
            <CommandHelp command={helpMode.command} />
          ) : (
            <GeneralHelp />
          )}
        </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

const COMMAND_HELP: Record<string, CommandHelpData> = {
  create: {
    title: "create",
    description: "Create an item.",
    props: [
      "type",
      "title",
      "parent/under",
      "in",
      "due",
      "priority/pri",
      "status",
      "tags",
      "depends_on/dep",
      "assignees",
      "notes",
      "estimate_mode",
      "estimate_minutes",
      "scheduled_for",
    ],
    examples: [
      'create task "Write outline" due:"2026-01-03 17:00" priority:3',
      'create task "No due date task" priority:1',
      'create milestone "Phase 1" parent:project_id',
      'create milestone "Follow Up" in:"Sample Project"',
    ],
  },
  edit: {
    title: "edit",
    description: "Edit by id or exact title match.",
    props: ["type", "id or \"title\"", "in", "title", "status", "priority", "tags"],
    examples: [
      'edit task 01H... title:"New title" status:in_progress',
      'edit task "Weekly sync" in:"Sample Project" priority:2',
      'edit milestone 01H... due:"2026-01-03 17:00"',
    ],
  },
  delete: {
    title: "delete",
    description: "Delete by id or exact title match.",
    props: ["type", "id or \"title\"", "in"],
    examples: [
      'delete task 01H...',
      'delete task "Old task" in:"Sample Project"',
      'delete milestone 01H...',
    ],
  },
  project: {
    title: "project (alias)",
    description: "Alias for create project.",
    props: ["title", "due", "priority/pri", "tags"],
    examples: [
      'project "Website revamp"',
      'project title:"Infra cleanup" pri:2',
      'project "Launch Plan" due:2025-01-01',
    ],
  },
  milestone: {
    title: "milestone (alias)",
    description: "Alias for create milestone.",
    props: ["title", "parent", "under", "in", "due", "pri", "tags", "dep"],
    examples: [
      'milestone "MVP" parent:project_id',
      'milestone title:"Phase 1" under:project_id',
      'milestone "Follow Up" in:"Sample Project"',
      'milestone "Beta" due:2025-03-01',
    ],
  },
  task: {
    title: "task (alias)",
    description: "Alias for create task.",
    props: [
      "title",
      "parent",
      "under",
      "in",
      "due",
      "pri",
      "tags",
      "dep",
      "scheduled_for",
    ],
    examples: [
      'task "Fix bug" pri:3',
      'task title:"API audit" parent:milestone_id',
      'task "Ship build" in:"Sample Project" pri:2',
      'task "Ship build" due:2025-02-15 tags:release',
    ],
  },
  subtask: {
    title: "subtask (alias)",
    description: "Alias for create subtask.",
    props: ["title", "parent", "under", "due", "pri", "tags", "dep"],
    examples: [
      'subtask "Refactor module" parent:task_id',
      'subtask title:"Write tests" under:task_id',
      'subtask "Patch docs" pri:1',
    ],
  },
};

type CommandHelpData = {
  title: string;
  description: string;
  props: string[];
  examples: string[];
};

const GeneralHelp = () => {
  return (
    <div className="palette-help-block">
      <div className="palette-help-title">Commands</div>
      <ul className="palette-help-list">
        <li>create</li>
        <li>edit</li>
        <li>delete</li>
        <li>project (alias)</li>
        <li>milestone (alias)</li>
        <li>task (alias)</li>
        <li>subtask (alias)</li>
      </ul>
      <div className="palette-help-title">Examples</div>
      <ul className="palette-help-list">
        <li>create task "Write outline" due:"2026-01-03 17:00"</li>
        <li>edit task 01H... title:"New title"</li>
        <li>delete task 01H...</li>
      </ul>
    </div>
  );
};

const CommandHelp = ({ command }: { command: string }) => {
  const data = COMMAND_HELP[command];
  if (!data) {
    return <GeneralHelp />;
  }
  return (
    <div className="palette-help-block">
      <div className="palette-help-title">{data.title}</div>
      <div className="palette-help-desc">{data.description}</div>
      <div className="palette-help-title">Props</div>
      <ul className="palette-help-list">
        {data.props.map((prop) => (
          <li key={prop}>{prop}</li>
        ))}
      </ul>
      <div className="palette-help-title">Examples</div>
      <ul className="palette-help-list">
        {data.examples.map((example) => (
          <li key={example}>{example}</li>
        ))}
      </ul>
    </div>
  );
};

export default CommandPalette;
