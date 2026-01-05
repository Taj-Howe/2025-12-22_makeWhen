import type { FC, KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@radix-ui/themes";
import { parseCommand } from "../cli/parseCommand";
import { UNGROUPED_PROJECT_ID } from "./constants";
import type { ItemLite } from "./ItemAutocomplete";
import { AppButton, AppInput } from "./controls";
import { serverQuery } from "./serverApi";
import {
  addBlocker,
  archiveItem,
  createBlock,
  createDependencyEdge,
  createItem,
  deleteDependencyEdge,
  deleteItem,
  moveBlock,
  resizeBlock,
  restoreItem,
  setItemAssignee,
  setItemTags,
  setStatus,
  updateDependencyEdge,
  updateItemFields,
} from "./serverActions";

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedProjectId: string | null;
  onCreated: () => void;
  onOpenProject?: (projectId: string) => void;
  onOpenView?: (view: "list" | "calendar" | "kanban" | "gantt" | "dashboard") => void;
};

type ListViewLite = {
  id: string;
  title: string;
  type: string;
  project_id?: string | null;
};

type ListViewEdge = {
  edge_id: string;
  depends_on_id: string;
  type?: string | null;
  lag_minutes?: number | null;
};

type ListViewRow = ListViewLite & {
  depends_on_edges?: ListViewEdge[];
  estimate_minutes?: number | null;
};


const CommandPalette: FC<CommandPaletteProps> = ({
  open,
  onOpenChange,
  selectedProjectId,
  onCreated,
  onOpenProject,
  onOpenView,
}) => {
  const [inputValue, setInputValue] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [autoItems, setAutoItems] = useState<ItemLite[]>([]);
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoIndex, setAutoIndex] = useState(-1);
  const [autoToken, setAutoToken] = useState<{
    key: string;
    valueStart: number;
    valueEnd: number;
    rawValue: string;
  } | null>(null);
  const [autoScopeId, setAutoScopeId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const autoRequestId = useRef(0);
  const autoTimeoutId = useRef<number | null>(null);

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
    if (
      token &&
      ["create", "edit", "delete", "schedule", "archive", "restore", "open"].includes(
        token
      )
    ) {
      return { kind: "command" as const, command: token };
    }
    return { kind: "general" as const };
  }, [inputValue]);

  const inProjectToken = useMemo(() => {
    const match = inputValue.match(/(?:^|\s)in:("([^"]+)"|[^\s]+)/i);
    if (!match) {
      return null;
    }
    return match[2] ?? match[1] ?? null;
  }, [inputValue]);

  const resolveTargetId = async (
    type: string,
    target: string,
    projectId?: string | null
  ) => {
    const scopeId = projectId ?? selectedProjectId;
    if (!scopeId || scopeId === UNGROUPED_PROJECT_ID) {
      throw new Error("Select a project to resolve items");
    }
    const data = await serverQuery<ListViewLite[]>("list_view", {
      scopeType: "project",
      scopeId,
      includeArchived: true,
      includeCompleted: true,
    });
    const matches = data.filter((item) => {
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

  const resolveItemId = async (
    target: string,
    projectId: string | null,
    allowProject = false
  ) => {
    const scopeId = projectId ?? selectedProjectId;
    if (!scopeId || scopeId === UNGROUPED_PROJECT_ID) {
      throw new Error("Select a project to resolve items");
    }
    const data = await serverQuery<ListViewLite[]>("list_view", {
      scopeType: "project",
      scopeId,
      includeArchived: true,
      includeCompleted: true,
    });
    const items = allowProject
      ? data
      : data.filter((item) => item.type !== "project");
    const byId = items.find((item) => item.id === target);
    if (byId) {
      return byId.id;
    }
    const matches = items.filter(
      (item) => item.title.toLowerCase() === target.toLowerCase()
    );
    if (matches.length === 0) {
      throw new Error(`No item found for "${target}"`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple items named "${target}"`);
    }
    return matches[0].id;
  };

  const resolveItemProjectId = async (itemId: string) => {
    const details = await serverQuery<{ project_id?: string | null } | null>(
      "item_details",
      { itemId }
    );
    if (!details?.project_id) {
      throw new Error("Parent item has no project");
    }
    return details.project_id;
  };

  const resolveProjectId = async (target: string) => {
    const data = await serverQuery<{ projects: Array<{ id: string; title: string }> }>(
      "projects_list",
      {}
    );
    const matches = data.projects.filter((project) => {
      if (project.id === target) {
        return true;
      }
      return project.title.toLowerCase() === target.toLowerCase();
    });
    if (matches.length === 0) {
      throw new Error(`No project found for "${target}"`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple projects named "${target}"`);
    }
    return matches[0].id;
  };

  useEffect(() => {
    if (!inProjectToken) {
      setAutoScopeId(null);
      return;
    }
    let cancelled = false;
    resolveProjectId(inProjectToken)
      .then((projectId) => {
        if (!cancelled) {
          setAutoScopeId(projectId);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAutoScopeId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inProjectToken]);

  useEffect(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setAutoItems([]);
      setAutoOpen(false);
      setAutoIndex(-1);
      setAutoToken(null);
      return;
    }
    const match = /(^|\s)(under|parent|dep|depends_on):([^\s]*)$/i.exec(
      inputValue
    );
    if (!match) {
      setAutoItems([]);
      setAutoOpen(false);
      setAutoIndex(-1);
      setAutoToken(null);
      return;
    }
    const key = match[2].toLowerCase();
    const valueStart = match.index + match[1].length + key.length + 1;
    const valueEnd = inputValue.length;
    const rawValue = inputValue.slice(valueStart, valueEnd);
    setAutoToken({ key, valueStart, valueEnd, rawValue });
    const segments = rawValue.split(",");
    const lastSegment = segments[segments.length - 1]?.trim() ?? "";
    const queryText = lastSegment.replace(/^"|"$/g, "");
    if (queryText.length < 1) {
      setAutoItems([]);
      setAutoOpen(false);
      setAutoIndex(-1);
      return;
    }
    setAutoOpen(true);
    if (autoTimeoutId.current) {
      window.clearTimeout(autoTimeoutId.current);
    }
    const requestId = ++autoRequestId.current;
    autoTimeoutId.current = window.setTimeout(() => {
      serverQuery<{ items: ItemLite[] }>("searchItems", {
        text: queryText,
        limit: 12,
        scopeProjectId: autoScopeId ?? selectedProjectId ?? undefined,
      })
        .then((data) => {
          if (requestId !== autoRequestId.current) {
            return;
          }
          setAutoItems(data.items ?? []);
          setAutoIndex(data.items && data.items.length > 0 ? 0 : -1);
        })
        .catch(() => {
          if (requestId !== autoRequestId.current) {
            return;
          }
          setAutoItems([]);
          setAutoIndex(-1);
        });
    }, 180);
  }, [autoScopeId, inputValue, selectedProjectId]);

  const formatTokenValue = (value: string) => {
    const safe = value.replace(/"/g, "'");
    if (/[,\s]/.test(safe)) {
      return `"${safe}"`;
    }
    return safe;
  };

  const applyAutocompleteSelection = (item: ItemLite) => {
    if (!autoToken) {
      return;
    }
    const formatted = formatTokenValue(item.title);
    const segments = autoToken.rawValue.split(",");
    segments[segments.length - 1] = formatted;
    const nextValue =
      inputValue.slice(0, autoToken.valueStart) +
      segments.join(",") +
      inputValue.slice(autoToken.valueEnd);
    setInputValue(nextValue);
    setAutoItems([]);
    setAutoOpen(false);
    setAutoIndex(-1);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextValue.length, nextValue.length);
    });
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (autoOpen && autoItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setAutoIndex((prev) => (prev + 1) % autoItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setAutoIndex((prev) => (prev - 1 + autoItems.length) % autoItems.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = autoItems[autoIndex] ?? autoItems[0];
        if (item) {
          applyAutocompleteSelection(item);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setAutoOpen(false);
        setAutoIndex(-1);
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void handleSubmit();
    }
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
    if (value.verb === "open") {
      const nextView = value.openView ?? "list";
      if (value.openProject) {
        try {
          const projectId = await resolveProjectId(value.openProject);
          onOpenProject?.(projectId);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setSubmitError(message);
          return;
        }
      }
      onOpenView?.(nextView);
      setSubmitError(null);
      setInputValue("");
      onOpenChange(false);
      return;
    }
    if (value.verb === "archive" || value.verb === "restore") {
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
        setSubmitError(`${value.verb} requires an id or title`);
        return;
      }
      try {
        if (value.verb === "archive") {
          await archiveItem(targetId);
        } else {
          await restoreItem(targetId);
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

    if (value.verb === "schedule") {
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
        setSubmitError("Schedule requires an id or title");
        return;
      }
      if (!value.scheduledFor || !value.scheduledDurationMinutes) {
        setSubmitError("Schedule requires start and duration.");
        return;
      }
      try {
        const details = await serverQuery<{
          primary_block_id?: string | null;
        }>("item_details", { itemId: targetId });
        const blockId = details?.primary_block_id ?? null;
        const durationMinutes = Math.round(value.scheduledDurationMinutes);
        if (blockId) {
          await moveBlock(blockId, value.scheduledFor);
          await resizeBlock(blockId, durationMinutes);
        } else {
          await createBlock({
            item_id: targetId,
            start_at: value.scheduledFor,
            duration_minutes: durationMinutes,
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
        await deleteItem(targetId);
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
          await updateItemFields(targetId, { title: value.title });
        }
        if (value.dueAt !== undefined) {
          await updateItemFields(targetId, { due_at: value.dueAt ?? null });
        }
        if (value.priority !== undefined) {
          await updateItemFields(targetId, { priority: value.priority });
        }
        if (value.status) {
          await setStatus(targetId, value.status);
        }
        if (value.notes !== undefined) {
          await updateItemFields(targetId, { notes: value.notes || null });
        }
        if (value.estimateMode || value.estimateMinutes !== undefined) {
          await updateItemFields(targetId, {
            estimate_mode: value.estimateMode,
            estimate_minutes:
              value.estimateMinutes !== undefined ? value.estimateMinutes : undefined,
          });
        }
        if (value.tags) {
          await setItemTags(targetId, value.tags);
        }
        if (value.assignees && value.assignees.length > 0) {
          await setItemAssignee(targetId, value.assignees[0]);
        }
        if (value.dependsOn) {
          const scopeId = value.inProject
            ? await resolveProjectId(value.inProject)
            : selectedProjectId ?? null;
          const resolvedDeps: string[] = [];
          for (const depTarget of value.dependsOn) {
            resolvedDeps.push(await resolveItemId(depTarget, scopeId, false));
          }
          const data = await serverQuery<ListViewRow[]>("list_view", {
            scopeType: "project",
            scopeId: scopeId ?? selectedProjectId,
            includeArchived: true,
            includeCompleted: true,
          });
          const current = data.find((item) => item.id === targetId);
          const currentEdges = new Map(
            (current?.depends_on_edges ?? []).map((edge) => [
              edge.depends_on_id,
              edge,
            ])
          );
          const currentDeps = new Set(currentEdges.keys());
          const desiredDeps = new Set(resolvedDeps);
          const depTypeForCreate = value.depType ?? "FS";
          const hasDepUpdates =
            value.depType !== undefined || value.depLagMinutes !== undefined;
          for (const depId of desiredDeps) {
            if (!currentDeps.has(depId)) {
              await createDependencyEdge({
                predecessor_id: depId,
                successor_id: targetId,
                type: depTypeForCreate,
                lag_minutes: value.depLagMinutes,
              });
            } else if (hasDepUpdates) {
              const edgeId = currentEdges.get(depId)?.edge_id;
              if (edgeId) {
                await updateDependencyEdge({
                  edge_id: edgeId,
                  type: value.depType,
                  lag_minutes: value.depLagMinutes,
                });
              }
            }
          }
          for (const depId of currentDeps) {
            if (!desiredDeps.has(depId)) {
              const edgeId = currentEdges.get(depId)?.edge_id;
              if (edgeId) {
                await deleteDependencyEdge({ edge_id: edgeId });
              }
            }
          }
        }
        if (value.scheduledFor) {
          let durationMinutes =
            value.scheduledDurationMinutes ?? value.estimateMinutes ?? null;
          if (!durationMinutes || durationMinutes <= 0) {
            const scopeId = projectScopeId ?? selectedProjectId ?? null;
            const data = await serverQuery<ListViewRow[]>("list_view", {
              scopeType: "project",
              scopeId: scopeId ?? selectedProjectId,
              includeArchived: true,
              includeCompleted: true,
            });
            const current = data.find((item) => item.id === targetId);
            durationMinutes = current?.estimate_minutes ?? null;
          }
          if (!durationMinutes || durationMinutes <= 0) {
            setSubmitError("Est Dur must be greater than 0 to schedule.");
            return;
          }
          await createBlock({
            item_id: targetId,
            start_at: value.scheduledFor,
            duration_minutes: Math.round(durationMinutes),
          });
        }
        if (value.blockerTexts && value.blockerTexts.length > 0) {
          for (const text of value.blockerTexts) {
            await addBlocker(targetId, value.blockerKind ?? "general", text);
          }
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

    let projectIdForCreate = resolvedProjectId ?? targetProjectId;

    if (value.parentId) {
      const scopeId = resolvedProjectId ?? targetProjectId ?? null;
      try {
        createArgs.parent_id = await resolveItemId(
          value.parentId,
          scopeId,
          false
        );
        if (!projectIdForCreate) {
          projectIdForCreate = await resolveItemProjectId(
            createArgs.parent_id as string
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setSubmitError(message);
        return;
      }
    } else if (value.type === "milestone") {
      const projectParentId = resolvedProjectId ?? targetProjectId;
      if (!projectParentId) {
        setSubmitError("Milestone needs a project selected, in:<name>, or parent:<id>");
        return;
      }
      createArgs.parent_id = projectParentId;
      projectIdForCreate = projectParentId;
    } else if (value.type === "task") {
      if (resolvedProjectId) {
        createArgs.parent_id = resolvedProjectId;
        projectIdForCreate = resolvedProjectId;
      } else if (targetProjectId) {
        createArgs.parent_id = targetProjectId;
        projectIdForCreate = targetProjectId;
      }
    }

    if (value.type !== "project") {
      if (!projectIdForCreate) {
        setSubmitError("Select a project or use in:<name> for non-project items.");
        return;
      }
      createArgs.project_id = projectIdForCreate;
    }

    if (value.dueAt !== undefined) {
      createArgs.due_at = value.dueAt;
    } else {
      createArgs.due_at = null;
    }

    if (value.priority !== undefined) {
      createArgs.priority = value.priority;
    }
    if (value.status) {
      createArgs.status = value.status;
    }
    if (value.notes !== undefined) {
      createArgs.notes = value.notes || null;
    }
    if (value.health) {
      createArgs.health = value.health;
    }
    if (value.healthMode) {
      createArgs.health_mode = value.healthMode;
    }

    try {
      const created = await createItem(createArgs);
      const itemId = (created as { id?: string })?.id;
      if (!itemId) {
        throw new Error("Create failed");
      }
      if (value.tags && value.tags.length > 0) {
        await setItemTags(itemId, value.tags);
      }
      if (value.assignees && value.assignees.length > 0) {
        await setItemAssignee(itemId, value.assignees[0]);
      }
      if (value.blockerTexts && value.blockerTexts.length > 0) {
        for (const text of value.blockerTexts) {
          await addBlocker(itemId, value.blockerKind ?? "general", text);
        }
      }
      if (value.dependsOn && value.dependsOn.length > 0) {
        const scopeId = resolvedProjectId ?? targetProjectId ?? null;
        const depTypeForCreate = value.depType ?? "FS";
        for (const depTarget of value.dependsOn) {
          const depId = await resolveItemId(depTarget, scopeId, false);
          await createDependencyEdge({
            predecessor_id: depId,
            successor_id: itemId,
            type: depTypeForCreate,
            lag_minutes: value.depLagMinutes,
          });
        }
      }
      if (value.scheduledFor) {
        const durationMinutes =
          value.scheduledDurationMinutes ?? value.estimateMinutes ?? 0;
        if (durationMinutes <= 0) {
          setSubmitError("Est Dur must be greater than 0 to schedule.");
          return;
        }
        await createBlock({
          item_id: itemId,
          start_at: value.scheduledFor,
          duration_minutes: Math.round(durationMinutes),
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
      <Dialog.Content
        className="palette-content"
        aria-label="Command palette"
      >
        <div className="palette-header">
          <div className="autocomplete">
            <AppInput
              ref={inputRef}
              rootClassName="palette-input"
              type="text"
              value={inputValue}
              onChange={(event) => {
                setInputValue(event.target.value);
                setSubmitError(null);
              }}
              onKeyDown={handleInputKeyDown}
              placeholder='task "Fix bug" due:2025-01-01 pri:3 tags:ui,bug'
            />
            {autoOpen && autoItems.length > 0 ? (
              <div className="autocomplete-list" role="listbox">
                {autoItems.map((item, index) => (
                  <AppButton
                    key={item.id}
                    type="button"
                    variant="ghost"
                    className={`autocomplete-option ${
                      index === autoIndex ? "is-active" : ""
                    }`}
                    role="option"
                    aria-selected={index === autoIndex}
                    onMouseEnter={() => setAutoIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyAutocompleteSelection(item);
                    }}
                  >
                    <span className="autocomplete-title">{item.title}</span>
                    <span className="autocomplete-meta">
                      {item.item_type}
                    </span>
                  </AppButton>
                ))}
              </div>
            ) : null}
          </div>
          {submitError ? (
            <div className="palette-error">{submitError}</div>
          ) : null}
          {parseResult && !parseResult.ok ? (
            <div className="palette-error">
              {parseResult.error.message}
            </div>
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
                  {parseResult.value.scheduledDurationMinutes ||
                  parseResult.value.estimateMinutes
                    ? ` (${
                        parseResult.value.scheduledDurationMinutes ??
                        parseResult.value.estimateMinutes
                      } min)`
                    : ""}
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
      "start/start_at",
      "duration/dur",
      "priority/pri",
      "status",
      "tags",
      "depends_on/dep",
      "dep_type",
      "dep_lag/lag",
      "assignee/assignees",
      "blocker/blockers",
      "blocker_kind",
      "notes",
      "estimate_mode",
      "estimate_minutes",
      "health",
      "health_mode",
    ],
    examples: [
      'create task "Write outline" due:"2026-01-03 17:00" priority:3',
      'create task "Plan sprint" start:"2026-01-03 09:00" dur:"90m"',
      'create task "Fix bug" blocker:"Needs API key" blocker_kind:general',
      'create task "No due date task" priority:1',
      'create milestone "Phase 1" parent:project_id',
      'create milestone "Follow Up" in:"Sample Project"',
    ],
  },
  edit: {
    title: "edit",
    description: "Edit by id or exact title match.",
    props: [
      "type",
      "id or \"title\"",
      "in",
      "title",
      "status",
      "priority",
      "tags",
      "start/start_at",
      "duration/dur",
      "dep_type",
      "dep_lag/lag",
      "assignee/assignees",
      "blocker/blockers",
      "blocker_kind",
      "health",
      "health_mode",
    ],
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
  schedule: {
    title: "schedule",
    description: "Create or update the primary scheduled block.",
    props: [
      "type",
      "id or \"title\"",
      "in",
      "start/start_at",
      "duration/dur",
    ],
    examples: [
      'schedule task 01H... start:"2026-01-03 09:00" dur:"45m"',
      'schedule task "Fix bug" in:"Sample Project" start:"2026-01-03 09:00" dur:"45m"',
    ],
  },
  archive: {
    title: "archive",
    description: "Archive by id or exact title match.",
    props: ["type", "id or \"title\"", "in"],
    examples: [
      'archive task 01H...',
      'archive task "Old task" in:"Sample Project"',
    ],
  },
  restore: {
    title: "restore",
    description: "Restore an archived item by id or exact title match.",
    props: ["type", "id or \"title\"", "in"],
    examples: [
      'restore task 01H...',
      'restore task "Old task" in:"Sample Project"',
    ],
  },
  open: {
    title: "open",
    description: "Switch view and/or project scope.",
    props: ["\"project name\" (optional)", "view (optional)"],
    examples: [
      'open "Sample Project"',
      'open "calendar"',
      'open "Sample Project" "kanban"',
    ],
  },
  project: {
    title: "project (alias)",
    description: "Alias for create project.",
    props: [
      "title",
      "due",
      "priority/pri",
      "tags",
      "assignee/assignees",
      "health",
      "health_mode",
    ],
    examples: [
      'project "Website revamp"',
      'project title:"Infra cleanup" pri:2',
      'project "Launch Plan" due:2025-01-01',
    ],
  },
  milestone: {
    title: "milestone (alias)",
    description: "Alias for create milestone.",
    props: [
      "title",
      "parent",
      "under",
      "in",
      "due",
      "pri",
      "tags",
      "dep",
      "dep_type",
      "dep_lag/lag",
      "assignee/assignees",
      "blocker/blockers",
      "blocker_kind",
      "health",
      "health_mode",
    ],
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
      "start/start_at",
      "duration/dur",
      "pri",
      "tags",
      "dep",
      "dep_type",
      "dep_lag/lag",
      "assignee/assignees",
      "blocker/blockers",
      "blocker_kind",
      "health",
      "health_mode",
    ],
    examples: [
      'task "Fix bug" pri:3',
      'task "Fix bug" start:"2026-01-03 09:00" dur:"45m"',
      'task title:"API audit" parent:milestone_id',
      'task "Ship build" in:"Sample Project" pri:2',
      'task "Ship build" due:2025-02-15 tags:release',
    ],
  },
  subtask: {
    title: "subtask (alias)",
    description: "Alias for create subtask.",
    props: [
      "title",
      "parent",
      "under",
      "due",
      "start/start_at",
      "duration/dur",
      "pri",
      "tags",
      "dep",
      "dep_type",
      "dep_lag/lag",
      "assignee/assignees",
      "blocker/blockers",
      "blocker_kind",
      "health",
      "health_mode",
    ],
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
          <li>schedule</li>
          <li>archive</li>
          <li>restore</li>
          <li>open</li>
          <li>project (alias)</li>
          <li>milestone (alias)</li>
          <li>task (alias)</li>
          <li>subtask (alias)</li>
        </ul>
        <div className="palette-help-title">Examples</div>
        <ul className="palette-help-list">
          <li>create task "Write outline" due:"2026-01-03 17:00"</li>
          <li>create task "Plan sprint" start:"2026-01-03 09:00" dur:"90m"</li>
          <li>edit task 01H... title:"New title"</li>
          <li>delete task 01H...</li>
          <li>schedule task "Fix bug" start:"2026-01-03 09:00" dur:"45m"</li>
          <li>archive task "Old task"</li>
          <li>open "Sample Project" "kanban"</li>
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
