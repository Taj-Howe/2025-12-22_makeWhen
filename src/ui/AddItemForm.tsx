import { useEffect, useMemo, useState, type FC, type FormEvent } from "react";
import { mutate, query } from "../rpc/clientSingleton";
import { UNGROUPED_PROJECT_ID } from "./constants";
import { toDateTimeLocal } from "../domain/formatters";
import { ItemAutocomplete } from "./ItemAutocomplete";

type ItemType = "project" | "milestone" | "task";

type ItemRow = {
  id: string;
  type: ItemType;
  title: string;
  parent_id: string | null;
  project_id: string;
  depth: number;
  status: string;
  priority: number;
  due_at: number | null;
  estimate_minutes: number;
  notes: string | null;
  health: string;
  health_mode: string;
  tags: { id: string; name: string }[];
  assignees: { id: string; name: string | null }[];
};

type ItemDetails = {
  id: string;
  type: ItemType;
  title: string;
  parent_id: string | null;
  status: string;
  priority: number;
  due_at: number | null;
  estimate_mode: string;
  estimate_minutes: number;
  health: string;
  health_mode: string;
  notes: string | null;
  dependencies: string[];
  blockers: {
    blocker_id: string;
    kind: string;
    text: string;
    created_at: number;
    cleared_at: number | null;
  }[];
};

type AddItemFormProps = {
  selectedProjectId: string | null;
  items: ItemRow[];
  onRefresh: () => void;
  initialType?: ItemType;
  onCreated?: () => void;
};

const formatOptionLabel = (item: ItemRow, parentType: ItemType | null) => {
  const labelType =
    item.type === "task" && parentType === "task" ? "Subtask" : item.type;
  return `${" ".repeat(item.depth * 2)}${item.title} (${labelType})`;
};

const parseCommaList = (value: string) =>
  Array.from(
    new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );

const normalizeAssignees = (value: string) => parseCommaList(value).join(", ");

const AddItemForm: FC<AddItemFormProps> = ({
  selectedProjectId,
  items,
  onRefresh,
  initialType,
  onCreated,
}) => {
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [type, setType] = useState<ItemType>(initialType ?? "task");
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [dueAt, setDueAt] = useState("");
  const [estimateMode, setEstimateMode] = useState<"manual" | "rollup">(
    "manual"
  );
  const [estimateMinutes, setEstimateMinutes] = useState("0");
  const [scheduledFor, setScheduledFor] = useState("");
  const [scheduledMinutes, setScheduledMinutes] = useState("60");
  const [status, setStatus] = useState("backlog");
  const [priority, setPriority] = useState("0");
  const [healthMode, setHealthMode] = useState<"auto" | "manual">("auto");
  const [health, setHealth] = useState("unknown");
  const [notes, setNotes] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [tagChips, setTagChips] = useState<string[]>([]);
  const [assigneesInput, setAssigneesInput] = useState("");
  const [depChips, setDepChips] = useState<string[]>([]);
  const [blockerKind, setBlockerKind] = useState("general");
  const [blockerText, setBlockerText] = useState("");
  const [blockers, setBlockers] = useState<ItemDetails["blockers"]>([]);
  const [currentDeps, setCurrentDeps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const parentTypeMap = useMemo(() => {
    const map = new Map<string, ItemType>();
    for (const item of items) {
      map.set(item.id, item.type);
    }
    return map;
  }, [items]);

  const projectItems = useMemo(() => {
    if (selectedProjectId === UNGROUPED_PROJECT_ID) {
      return items;
    }
    return items.filter((item) => item.project_id === selectedProjectId);
  }, [items, selectedProjectId]);

  const taskParentOptions = useMemo(() => {
    if (!selectedProjectId) {
      return [];
    }
    return projectItems.filter(
      (item) => item.type === "milestone" || item.type === "task"
    );
  }, [projectItems, selectedProjectId]);

  const editableItems = useMemo(
    () => projectItems.filter((item) => item.type !== "project"),
    [projectItems]
  );

  const tagSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      for (const tag of item.tags ?? []) {
        if (tag.name) {
          set.add(tag.name);
        }
      }
    }
    return Array.from(set).sort();
  }, [items]);

  const filteredTagSuggestions = useMemo(() => {
    const input = tagsInput.trim().toLowerCase();
    if (!input) {
      return [];
    }
    return tagSuggestions
      .filter((tag) => tag.toLowerCase().includes(input))
      .filter((tag) => !tagChips.includes(tag))
      .slice(0, 6);
  }, [tagChips, tagSuggestions, tagsInput]);

  const dependencyExcludeIds = useMemo(() => {
    const exclude = new Set(depChips);
    if (mode === "edit" && selectedItemId) {
      exclude.add(selectedItemId);
    }
    return Array.from(exclude);
  }, [depChips, mode, selectedItemId]);

  useEffect(() => {
    if (mode === "edit" && selectedItemId) {
      setLoadingDetails(true);
      query<ItemDetails | null>("getItemDetails", { itemId: selectedItemId })
        .then((data) => {
          if (!data) {
            return;
          }
          setType(data.type);
          setTitle(data.title);
          setParentId(data.parent_id);
          setDueAt(toDateTimeLocal(data.due_at));
          setEstimateMode(
            data.estimate_mode === "rollup" ? "rollup" : "manual"
          );
          setEstimateMinutes(String(data.estimate_minutes));
          setStatus(data.status);
          setPriority(String(data.priority));
          setHealthMode(data.health_mode === "manual" ? "manual" : "auto");
          setHealth(data.health);
          setNotes(data.notes ?? "");
          setBlockers(data.blockers);
          setCurrentDeps(data.dependencies ?? []);
          setDepChips(data.dependencies ?? []);
          const fromList = items.find((item) => item.id === data.id);
          if (fromList) {
            setTagsInput("");
            setTagChips(fromList.tags.map((tag) => tag.name));
            setAssigneesInput(
              fromList.assignees.map((assignee) => assignee.id).join(", ")
            );
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : "Unknown error";
          setError(message);
        })
        .finally(() => {
          setLoadingDetails(false);
        });
      return;
    }
    if (mode === "edit" && !selectedItemId) {
      resetForm();
    }
  }, [items, mode, selectedItemId]);

  const handleEstimateMinutesChange = (value: string) => {
    setEstimateMinutes(value);
  };

  const normalizeEstimateMinutes = () => {
    if (estimateMode !== "manual") {
      return;
    }
    const trimmed = estimateMinutes.trim();
    if (trimmed === "") {
      setEstimateMinutes("0");
      return;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric < 0) {
      setEstimateMinutes("0");
      return;
    }
    setEstimateMinutes(String(Math.floor(numeric)));
  };

  useEffect(() => {
    if (mode === "edit") {
      return;
    }
    if (type === "task") {
      setEstimateMode("manual");
      return;
    }
    setEstimateMode("rollup");
  }, [mode, type]);

  useEffect(() => {
    if (mode === "create" && initialType) {
      setType(initialType);
    }
  }, [initialType, mode]);

  useEffect(() => {
    if (
      type === "task" &&
      selectedProjectId &&
      selectedProjectId !== UNGROUPED_PROJECT_ID &&
      !parentId
    ) {
      setParentId(selectedProjectId);
    }
  }, [parentId, selectedProjectId, type]);

  const resetForm = () => {
    setTitle("");
    setDueAt("");
    setNotes("");
    setEstimateMinutes("0");
    setEstimateMode("manual");
    setScheduledFor("");
    setScheduledMinutes("60");
    setPriority("0");
    setStatus("backlog");
    setHealthMode("auto");
    setHealth("unknown");
    setTagsInput("");
    setTagChips([]);
    setAssigneesInput("");
    setDepsInput("");
    setDepChips([]);
    setBlockerKind("general");
    setBlockerText("");
    setBlockers([]);
    setCurrentDeps([]);
  };

  const validate = () => {
    if (!title.trim()) {
      return "Title is required.";
    }
    if (dueAt) {
      const dueMs = new Date(dueAt).getTime();
      if (!Number.isFinite(dueMs)) {
        return "Deadline must be valid.";
      }
    }
    if (!estimateMode) {
      return "Estimate mode is required.";
    }
    const estimateValue = estimateMinutes.trim();
    const estimate =
      estimateMode === "manual"
        ? estimateValue === ""
          ? 0
          : Number(estimateValue)
        : 0;
    if (estimateMode === "manual") {
      if (!Number.isFinite(estimate) || estimate < 0) {
        return "Estimate must be 0 or greater.";
      }
    }
    if (scheduledFor) {
      const scheduledValue = Number(scheduledMinutes);
      if (!Number.isFinite(scheduledValue) || scheduledValue <= 0) {
        return "Scheduled minutes must be greater than 0.";
      }
    }
    if (type === "milestone" && !selectedProjectId) {
      return "Select a project before adding a milestone.";
    }
    if (type === "milestone" && selectedProjectId === UNGROUPED_PROJECT_ID) {
      return "Milestones must belong to a project.";
    }
    if (type === "task" && !selectedProjectId) {
      return "Select a project or Ungrouped before adding a task.";
    }
    if (mode === "edit" && !selectedItemId) {
      return "Select an item to edit.";
    }
    return null;
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    const dueMs = dueAt ? new Date(dueAt).getTime() : null;
    const estimateValue = estimateMinutes.trim();
    const estimate =
      estimateMode === "rollup"
        ? 0
        : Math.max(0, Number(estimateValue === "" ? 0 : estimateValue));
    const resolvedParentId =
      type === "project"
        ? null
        : type === "milestone"
          ? selectedProjectId
          : parentId ??
            (selectedProjectId === UNGROUPED_PROJECT_ID
              ? null
              : selectedProjectId);

    try {
      if (mode === "create") {
        const result = await mutate<{ id: string }>("create_item", {
          type,
          title: title.trim(),
          parent_id: resolvedParentId ?? null,
          due_at: dueMs,
          estimate_mode: estimateMode,
          estimate_minutes: estimate,
          status,
          priority: Number(priority),
          health,
          health_mode: healthMode,
          notes: notes.trim() ? notes.trim() : null,
        });
        const itemId = result?.id;
        if (itemId) {
          if (scheduledFor) {
            const startAt = new Date(scheduledFor).getTime();
            const durationMinutes = Math.max(
              1,
              Math.round(Number(scheduledMinutes))
            );
            await mutate("scheduled_block.create", {
              item_id: itemId,
              start_at: startAt,
              duration_minutes: durationMinutes,
              source: "manual",
            });
          }
          const tags = tagChips;
          if (tags.length > 0) {
            await mutate("set_item_tags", { item_id: itemId, tags });
          }
          const assignees = parseCommaList(assigneesInput);
          if (assignees.length > 0) {
            await mutate("set_item_assignees", {
              item_id: itemId,
              assignee_ids: assignees,
            });
          }
          for (const depId of depChips) {
            await mutate("add_dependency", {
              item_id: itemId,
              depends_on_id: depId,
            });
          }
        }
        resetForm();
        onCreated?.();
      } else if (selectedItemId) {
        await mutate("update_item_fields", {
          id: selectedItemId,
          fields: {
            title: title.trim(),
            parent_id: resolvedParentId ?? null,
            due_at: dueMs,
            estimate_mode: estimateMode,
            estimate_minutes: estimate,
            priority: Number(priority),
            health,
            health_mode: healthMode,
            notes: notes.trim() ? notes.trim() : null,
          },
        });
        if (scheduledFor) {
          const startAt = new Date(scheduledFor).getTime();
          const durationMinutes = Math.max(
            1,
            Math.round(Number(scheduledMinutes))
          );
          await mutate("scheduled_block.create", {
            item_id: selectedItemId,
            start_at: startAt,
            duration_minutes: durationMinutes,
            source: "manual",
          });
        }
        await mutate("set_status", { id: selectedItemId, status });
        const tags = tagChips;
        await mutate("set_item_tags", { item_id: selectedItemId, tags });
        const assignees = parseCommaList(assigneesInput);
        await mutate("set_item_assignees", {
          item_id: selectedItemId,
          assignee_ids: assignees,
        });
        const desiredDeps = new Set(depChips);
        const existingDeps = new Set(currentDeps);
        for (const depId of desiredDeps) {
          if (!existingDeps.has(depId)) {
            await mutate("add_dependency", {
              item_id: selectedItemId,
              depends_on_id: depId,
            });
          }
        }
        for (const depId of existingDeps) {
          if (!desiredDeps.has(depId)) {
            await mutate("remove_dependency", {
              item_id: selectedItemId,
              depends_on_id: depId,
            });
          }
        }
      }
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleDependencySelect = async (dependencyId: string) => {
    if (depChips.includes(dependencyId)) {
      return;
    }
    if (mode === "edit" && selectedItemId) {
      try {
        await mutate("add_dependency", {
          item_id: selectedItemId,
          depends_on_id: dependencyId,
        });
        setCurrentDeps((prev) =>
          prev.includes(dependencyId) ? prev : [...prev, dependencyId]
        );
        onRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        return;
      }
    }
    setDepChips((prev) => [...prev, dependencyId]);
  };

  const handleAddBlocker = async () => {
    if (!selectedItemId || !blockerText.trim()) {
      return;
    }
    try {
      await mutate("add_blocker", {
        item_id: selectedItemId,
        kind: blockerKind,
        text: blockerText,
      });
      const details = await query<ItemDetails | null>("getItemDetails", {
        itemId: selectedItemId,
      });
      setBlockers(details?.blockers ?? []);
      setBlockerText("");
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleClearBlocker = async (blockerId: string) => {
    if (!selectedItemId) {
      return;
    }
    try {
      await mutate("clear_blocker", { blocker_id: blockerId });
      const details = await query<ItemDetails | null>("getItemDetails", {
        itemId: selectedItemId,
      });
      setBlockers(details?.blockers ?? []);
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  return (
    <form className="add-form" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          Mode
          <select
            value={mode}
            onChange={(event) => {
              const next = event.target.value as "create" | "edit";
              setMode(next);
              setSelectedItemId("");
              resetForm();
            }}
          >
            <option value="create">Create</option>
            <option value="edit">Edit</option>
          </select>
        </label>
        {mode === "edit" ? (
          <label>
            Select item
            <select
              value={selectedItemId}
              onChange={(event) => setSelectedItemId(event.target.value)}
            >
              <option value="">Select item</option>
              {editableItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {mode === "edit" && loadingDetails ? (
          <div className="list-empty">Loading item…</div>
        ) : null}
      </div>

      <div className="form-row">
        <label>
          What are you adding? *
          <select
            value={type}
            onChange={(event) => {
              const next = event.target.value as ItemType;
              setType(next);
              if (next !== "task") {
                setParentId(null);
              }
            }}
            disabled={mode === "edit"}
          >
            <option value="project">Project</option>
            <option value="milestone">Milestone</option>
            <option value="task">Task / Subtask</option>
          </select>
          {mode === "edit" ? (
            <span className="hint">Type cannot be changed</span>
          ) : null}
        </label>
        <label>
          Title *
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="New item"
            autoFocus
          />
        </label>
        <label>
          Deadline
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </label>
        <label>
          Estimate mode *
          <select
            value={estimateMode}
            onChange={(event) => {
              const next = event.target.value as "manual" | "rollup";
              setEstimateMode(next);
              if (next === "rollup") {
                setEstimateMinutes("0");
              }
            }}
          >
            <option value="manual">Manual</option>
            <option value="rollup">Rollup</option>
          </select>
        </label>
        <label>
          Estimate minutes {estimateMode === "manual" ? "*" : ""}
          <input
            type="number"
            min={0}
            inputMode="numeric"
            step={1}
            value={estimateMinutes}
            onChange={(event) =>
              handleEstimateMinutesChange(event.target.value)
            }
            onBlur={normalizeEstimateMinutes}
            disabled={estimateMode === "rollup"}
          />
        </label>
        <label>
          Estimate confidence
          <input disabled value="Not supported yet" />
        </label>
        <label>
          Notes
          <textarea
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Optional"
          />
        </label>
      </div>

      <div className="form-row">
        <label>
          Scheduled for
          <input
            type="datetime-local"
            value={scheduledFor}
            onChange={(event) => setScheduledFor(event.target.value)}
            placeholder="Optional"
          />
        </label>
        <label>
          Duration (minutes)
          <input
            type="number"
            min={1}
            value={scheduledMinutes}
            onChange={(event) => setScheduledMinutes(event.target.value)}
            disabled={!scheduledFor}
          />
        </label>
      </div>

      <div className="form-row">
        <label>
          Parent
          {type === "milestone" ? (
            <input
              value={
                selectedProjectId === UNGROUPED_PROJECT_ID
                  ? "Ungrouped (no project)"
                  : selectedProjectId
                    ? "Selected project"
                    : "Select a project"
              }
              disabled
            />
          ) : (
            <select
              value={parentId ?? ""}
              onChange={(event) =>
                setParentId(event.target.value ? event.target.value : null)
              }
              disabled={type === "project" || !selectedProjectId}
            >
              {selectedProjectId === UNGROUPED_PROJECT_ID ? (
                <option value="">Ungrouped (no parent)</option>
              ) : (
                <option value={selectedProjectId ?? ""}>
                  Project (root)
                </option>
              )}
              {taskParentOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {formatOptionLabel(
                    option,
                    parentTypeMap.get(option.parent_id ?? "") ?? null
                  )}
                </option>
              ))}
            </select>
          )}
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="backlog">backlog</option>
            <option value="ready">ready</option>
            <option value="in_progress">in_progress</option>
            <option value="blocked">blocked</option>
            <option value="review">review</option>
            <option value="done">done</option>
            <option value="canceled">canceled</option>
          </select>
        </label>
        <label>
          Priority
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          >
            {Array.from({ length: 6 }, (_, index) => (
              <option key={index} value={String(index)}>
                {index}
              </option>
            ))}
          </select>
        </label>
        <label>
          Health mode
          <select
            value={healthMode}
            onChange={(event) =>
              setHealthMode(event.target.value as "auto" | "manual")
            }
          >
            <option value="auto">auto</option>
            <option value="manual">manual</option>
          </select>
        </label>
        <label>
          Health
          <select
            value={health}
            onChange={(event) => setHealth(event.target.value)}
            disabled={healthMode !== "manual"}
          >
            <option value="on_track">on_track</option>
            <option value="at_risk">at_risk</option>
            <option value="behind">behind</option>
            <option value="ahead">ahead</option>
            <option value="unknown">unknown</option>
          </select>
        </label>
      </div>

      <div className="form-row">
        <label>
          Tags
          <div className="chip-input">
            <div className="chip-list">
              {tagChips.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="chip"
                  onClick={() =>
                    setTagChips((prev) => prev.filter((entry) => entry !== tag))
                  }
                >
                  {tag} ×
                </button>
              ))}
            </div>
            <input
              value={tagsInput}
              onChange={(event) => setTagsInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && tagsInput.trim()) {
                  event.preventDefault();
                  const nextTag = tagsInput.trim();
                  if (!tagChips.includes(nextTag)) {
                    setTagChips((prev) => [...prev, nextTag]);
                  }
                  setTagsInput("");
                }
              }}
              placeholder="Add tag"
            />
            {filteredTagSuggestions.length > 0 ? (
              <div className="chip-suggestions">
                {filteredTagSuggestions.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="chip-suggestion"
                    onClick={() => {
                      setTagChips((prev) =>
                        prev.includes(tag) ? prev : [...prev, tag]
                      );
                      setTagsInput("");
                    }}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </label>
        <label>
          Assignees (comma-separated IDs)
          <input
            value={assigneesInput}
            onChange={(event) => setAssigneesInput(event.target.value)}
            onBlur={() => setAssigneesInput((current) => normalizeAssignees(current))}
            placeholder="user-1, user-2"
          />
        </label>
        <label>
          Dependencies
          <div className="chip-input">
            <div className="chip-list">
              {depChips.map((depId) => (
                <button
                  key={depId}
                  type="button"
                  className="chip"
                  onClick={async () => {
                    setDepChips((prev) =>
                      prev.filter((entry) => entry !== depId)
                    );
                    if (mode === "edit" && selectedItemId) {
                      try {
                        await mutate("remove_dependency", {
                          item_id: selectedItemId,
                          depends_on_id: depId,
                        });
                        setCurrentDeps((prev) =>
                          prev.filter((entry) => entry !== depId)
                        );
                        onRefresh();
                      } catch (err) {
                        const message =
                          err instanceof Error ? err.message : "Unknown error";
                        setError(message);
                      }
                    }
                  }}
                >
                  {depId.slice(0, 8)} ×
                </button>
              ))}
            </div>
            <ItemAutocomplete
              placeholder="Search items"
              scopeId={selectedProjectId}
              excludeIds={dependencyExcludeIds}
              onSelect={(item) => {
                void handleDependencySelect(item.id);
              }}
            />
          </div>
        </label>
      </div>

      {mode === "edit" ? (
        <div className="form-row">
          <label>
            Blockers
            {blockers.length === 0 ? (
              <div className="list-empty">No blockers</div>
            ) : (
              <div className="blocker-list">
                {blockers.map((blocker) => (
                  <div key={blocker.blocker_id} className="blocker-row">
                    <span>
                      {blocker.kind}: {blocker.text} {blocker.cleared_at ? "(cleared)" : ""}
                    </span>
                    {!blocker.cleared_at ? (
                      <button
                        type="button"
                        className="button button-ghost"
                        onClick={() => handleClearBlocker(blocker.blocker_id)}
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </label>
          <label>
            Add blocker kind
            <input
              value={blockerKind}
              onChange={(event) => setBlockerKind(event.target.value)}
              placeholder="general"
            />
          </label>
          <label>
            Add blocker text
            <input
              value={blockerText}
              onChange={(event) => setBlockerText(event.target.value)}
              placeholder="Reason"
            />
          </label>
          <button type="button" className="button" onClick={handleAddBlocker}>
            Add blocker
          </button>
        </div>
      ) : null}

      {type === "milestone" && !selectedProjectId ? (
        <div className="list-empty">Select a project to add a milestone.</div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      <button
        type="submit"
        className="button"
        disabled={
          (type !== "project" && !selectedProjectId) ||
          (mode === "edit" && !selectedItemId) ||
          loadingDetails
        }
      >
        {mode === "edit" ? "Save changes" : "Create item"}
      </button>
    </form>
  );
};

export default AddItemForm;
