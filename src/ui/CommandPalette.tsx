import type { FC } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { parseCommand } from "../cli/parseCommand";
import { mutate } from "../rpc/clientSingleton";
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
    return { kind: "general" as const };
  }, [inputValue]);

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
    const createArgs: Record<string, unknown> = {
      type: value.type,
      title: value.title,
      estimate_minutes: 0,
    };

    const targetProjectId =
      selectedProjectId && selectedProjectId !== UNGROUPED_PROJECT_ID
        ? selectedProjectId
        : null;

    if (value.parentId) {
      createArgs.parent_id = value.parentId;
    } else if (value.type === "milestone") {
      if (!targetProjectId) {
        setSubmitError("Milestone needs a project selected or parent:<id>");
        return;
      }
      createArgs.parent_id = targetProjectId;
    } else if (value.type === "task" && targetProjectId) {
      createArgs.parent_id = targetProjectId;
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
  project: {
    title: "project",
    description: "Create a top-level project.",
    props: ["title", "due", "pri", "tags", "dep", "scheduled_for"],
    examples: [
      'project "Website revamp"',
      'project title:"Infra cleanup" pri:2',
      'project "Launch Plan" due:2025-01-01',
    ],
  },
  milestone: {
    title: "milestone",
    description: "Create a milestone under a project.",
    props: ["title", "parent", "under", "due", "pri", "tags", "dep"],
    examples: [
      'milestone "MVP" parent:project_id',
      'milestone title:"Phase 1" under:project_id',
      'milestone "Beta" due:2025-03-01',
    ],
  },
  task: {
    title: "task",
    description: "Create a task (parent optional).",
    props: [
      "title",
      "parent",
      "under",
      "due",
      "pri",
      "tags",
      "dep",
      "scheduled_for",
    ],
    examples: [
      'task "Fix bug" pri:3',
      'task title:"API audit" parent:milestone_id',
      'task "Ship build" due:2025-02-15 tags:release',
    ],
  },
  subtask: {
    title: "subtask",
    description: "Create a subtask (parent required).",
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
        <li>project</li>
        <li>milestone</li>
        <li>task</li>
        <li>subtask</li>
      </ul>
      <div className="palette-help-title">Examples</div>
      <ul className="palette-help-list">
        <li>task "Fix bug" due:2025-01-01 pri:3</li>
        <li>milestone title:"Phase 1" parent:project_id</li>
        <li>project "Launch Plan"</li>
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
