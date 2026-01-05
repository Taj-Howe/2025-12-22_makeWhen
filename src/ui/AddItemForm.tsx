import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type FormEvent,
} from "react";
import { serverQuery } from "./serverApi";
import { UNGROUPED_PROJECT_ID } from "./constants";
import { toDateTimeLocal } from "../domain/formatters";
import { ItemAutocomplete } from "./ItemAutocomplete";
import UserSelect from "./UserSelect";
import { AppButton, AppInput, AppSelect, AppTextArea } from "./controls";
import {
  addBlocker,
  addDependency,
  archiveItem,
  createBlock,
  createItem,
  deleteItem,
  moveBlock,
  removeDependency,
  resizeBlock,
  resolveBlocker,
  setItemAssignee,
  setItemTags,
  setStatus,
  updateItemFields,
} from "./serverActions";

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
  health_mode?: string;
  tags: { id: string; name: string }[];
  assignees: { id: string; name: string | null }[];
  assignee_id?: string | null;
  assignee_name?: string | null;
};

type ItemDetails = {
  id: string;
  project_id?: string;
  type: ItemType;
  title: string;
  parent_id: string | null;
  status: string;
  priority: number;
  due_at: string | null;
  estimate_mode: string;
  estimate_minutes: number;
  health: string;
  health_mode: string;
  notes: string | null;
  dependencies: string[];
  scheduled_minutes_total: number;
  schedule_start_at: string | null;
  primary_block_id: string | null;
  assignee_id?: string | null;
  assignee_name?: string | null;
  blockers: {
    blocker_id: string;
    kind: string;
    text: string;
    created_at: string;
    cleared_at: string | null;
  }[];
};

type ServerListItem = {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: "project" | "milestone" | "task" | "subtask";
  title: string;
  status: string;
  priority: number;
  due_at: string | null;
  estimate_minutes: number;
  notes: string | null;
  assignee_user_id?: string | null;
};

type AddItemFormProps = {
  selectedProjectId: string | null;
  items: ItemRow[];
  onRefresh: () => void;
  initialType?: ItemType;
  initialMode?: "create" | "edit";
  initialItemId?: string | null;
  autoFocusTitle?: boolean;
  onCreated?: () => void;
  onDeleted?: () => void;
};

const toMs = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
};

const normalizeItems = (items: ServerListItem[]): ItemRow[] => {
  const map = new Map<string, ServerListItem>();
  for (const item of items) {
    map.set(item.id, item);
  }
  const depthCache = new Map<string, number>();
  const resolveDepth = (itemId: string, guard = new Set<string>()) => {
    if (depthCache.has(itemId)) {
      return depthCache.get(itemId) ?? 0;
    }
    if (guard.has(itemId)) {
      return 0;
    }
    guard.add(itemId);
    const item = map.get(itemId);
    if (!item || !item.parent_id) {
      depthCache.set(itemId, 0);
      return 0;
    }
    const parent = map.get(item.parent_id);
    if (!parent) {
      depthCache.set(itemId, 0);
      return 0;
    }
    const depth = resolveDepth(parent.id, guard) + 1;
    depthCache.set(itemId, depth);
    return depth;
  };
  return items.map((item) => ({
    id: item.id,
    type: item.type === "subtask" ? "task" : (item.type as ItemType),
    title: item.title,
    parent_id: item.parent_id,
    project_id: item.project_id,
    depth: resolveDepth(item.id),
    status: item.status,
    priority: item.priority,
    due_at: toMs(item.due_at),
    estimate_minutes: item.estimate_minutes ?? 0,
    notes: item.notes ?? null,
    health: "unknown",
    tags: [],
    assignees: item.assignee_user_id
      ? [{ id: item.assignee_user_id, name: null }]
      : [],
    assignee_id: item.assignee_user_id ?? null,
    assignee_name: null,
  }));
};

const formatOptionLabel = (item: ItemRow, parentType: ItemType | null) => {
  const labelType =
    item.type === "task" && parentType === "task" ? "Subtask" : item.type;
  return `${" ".repeat(item.depth * 2)}${item.title} (${labelType})`;
};

const EMPTY_SELECT_VALUE = "__none__";

const AddItemForm: FC<AddItemFormProps> = ({
  selectedProjectId,
  items,
  onRefresh,
  initialType,
  initialMode,
  initialItemId,
  autoFocusTitle,
  onCreated,
  onDeleted,
}) => {
  const [mode, setMode] = useState<"create" | "edit">(
    initialMode ?? "create"
  );
  const [selectedItemId, setSelectedItemId] = useState<string>(
    initialMode === "edit" && initialItemId ? initialItemId : ""
  );
  const [type, setType] = useState<ItemType>(initialType ?? "task");
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [dueAt, setDueAt] = useState("");
  const [estimateMode, setEstimateMode] = useState<"manual" | "rollup">(
    "manual"
  );
  const [estimateMinutes, setEstimateMinutes] = useState("0");
  const [scheduledFor, setScheduledFor] = useState("");
  const [scheduledBlockId, setScheduledBlockId] = useState<string | null>(null);
  const scheduledForInitialRef = useRef("");
  const [status, setStatus] = useState("backlog");
  const [priority, setPriority] = useState("0");
  const [healthMode, setHealthMode] = useState<"auto" | "manual">("auto");
  const [health, setHealth] = useState("unknown");
  const [notes, setNotes] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [tagChips, setTagChips] = useState<string[]>([]);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [depChips, setDepChips] = useState<string[]>([]);
  const [blockerKind, setBlockerKind] = useState("general");
  const [blockerText, setBlockerText] = useState("");
  const [blockers, setBlockers] = useState<ItemDetails["blockers"]>([]);
  const [currentDeps, setCurrentDeps] = useState<string[]>([]);
  const [availableItems, setAvailableItems] = useState<ItemRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const itemsSource = useMemo(
    () => (items.length > 0 ? items : availableItems),
    [availableItems, items]
  );

  useEffect(() => {
    if (items.length > 0) {
      return;
    }
    if (!selectedProjectId || selectedProjectId === UNGROUPED_PROJECT_ID) {
      setAvailableItems([]);
      return;
    }
    let isMounted = true;
    serverQuery<ServerListItem[]>("list_view", {
      scopeType: "project",
      scopeId: selectedProjectId,
      includeArchived: true,
      includeCompleted: true,
    })
      .then((data) => {
        if (!isMounted) {
          return;
        }
        setAvailableItems(normalizeItems(data));
      })
      .catch(() => {
        if (isMounted) {
          setAvailableItems([]);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [items.length, selectedProjectId]);

  const parentTypeMap = useMemo(() => {
    const map = new Map<string, ItemType>();
    for (const item of itemsSource) {
      map.set(item.id, item.type);
    }
    return map;
  }, [itemsSource]);

  const projectItems = useMemo(() => {
    if (selectedProjectId === UNGROUPED_PROJECT_ID) {
      return itemsSource;
    }
    return itemsSource.filter((item) => item.project_id === selectedProjectId);
  }, [itemsSource, selectedProjectId]);

  const childMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const item of projectItems) {
      if (!item.parent_id) {
        continue;
      }
      const list = map.get(item.parent_id) ?? [];
      list.push(item.id);
      map.set(item.parent_id, list);
    }
    return map;
  }, [projectItems]);

  const descendantIds = useMemo(() => {
    if (mode !== "edit" || !selectedItemId) {
      return new Set<string>();
    }
    const visited = new Set<string>();
    const stack = [selectedItemId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      const children = childMap.get(current) ?? [];
      for (const child of children) {
        if (!visited.has(child)) {
          stack.push(child);
        }
      }
    }
    return visited;
  }, [childMap, mode, selectedItemId]);

  const taskParentOptions = useMemo(() => {
    if (!selectedProjectId) {
      return [];
    }
    return projectItems.filter(
      (item) =>
        (item.type === "milestone" || item.type === "task") &&
        !descendantIds.has(item.id)
    );
  }, [descendantIds, projectItems, selectedProjectId]);

  const editableItems = useMemo(
    () => projectItems.filter((item) => item.type !== "project"),
    [projectItems]
  );

  const tagSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const item of itemsSource) {
      for (const tag of item.tags ?? []) {
        if (tag.name) {
          set.add(tag.name);
        }
      }
    }
    return Array.from(set).sort();
  }, [itemsSource]);

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
      serverQuery<ItemDetails | null>("item_details", {
        itemId: selectedItemId,
      })
        .then((data) => {
          if (!data) {
            return;
          }
          setType(data.type);
          setTitle(data.title);
          setParentId(data.parent_id);
          setDueAt(toDateTimeLocal(toMs(data.due_at)));
          setEstimateMode(
            data.estimate_mode === "rollup" ? "rollup" : "manual"
          );
          const scheduleMinutes = data.scheduled_minutes_total ?? 0;
          const estimateFromItem = Number(data.estimate_minutes ?? 0);
          const estimateValue =
            data.estimate_mode === "manual" &&
            estimateFromItem <= 0 &&
            scheduleMinutes > 0
              ? scheduleMinutes
              : estimateFromItem;
          setEstimateMinutes(String(estimateValue));
          setStatus(data.status);
          setPriority(String(data.priority));
          setHealthMode(data.health_mode === "manual" ? "manual" : "auto");
          setHealth(data.health);
          setNotes(data.notes ?? "");
          setBlockers(data.blockers);
          setCurrentDeps(data.dependencies ?? []);
          setDepChips(data.dependencies ?? []);
          const nextScheduledFor = toDateTimeLocal(toMs(data.schedule_start_at));
          setScheduledFor(nextScheduledFor);
          setScheduledBlockId(data.primary_block_id ?? null);
          scheduledForInitialRef.current = nextScheduledFor;
          setAssigneeId(data.assignee_id ?? null);
          const fromList = itemsSource.find((item) => item.id === data.id);
          if (fromList) {
            setTagsInput("");
            setTagChips(fromList.tags.map((tag) => tag.name));
            if (!data.assignee_id) {
              setAssigneeId(
                fromList.assignee_id ??
                  fromList.assignees[0]?.id ??
                  null
              );
            }
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
  }, [itemsSource, mode, selectedItemId]);

  useEffect(() => {
    if (!initialMode) {
      return;
    }
    setMode(initialMode);
    if (initialMode === "edit") {
      setSelectedItemId(initialItemId ?? "");
    } else {
      setSelectedItemId("");
    }
  }, [initialItemId, initialMode]);

  useEffect(() => {
    if (!autoFocusTitle) {
      return;
    }
    if (loadingDetails) {
      return;
    }
    if (mode === "edit" && !selectedItemId) {
      return;
    }
    const input = titleInputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, [autoFocusTitle, loadingDetails, mode, selectedItemId]);

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
    setScheduledBlockId(null);
    scheduledForInitialRef.current = "";
    setPriority("0");
    setStatus("backlog");
    setHealthMode("auto");
    setHealth("unknown");
    setTagsInput("");
    setTagChips([]);
    setAssigneeId(null);
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
    const scheduleChange =
      scheduledFor &&
      (mode === "create" || scheduledFor !== scheduledForInitialRef.current);
    if (scheduleChange && estimate <= 0) {
      return "Est Dur must be greater than 0 to schedule.";
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
        if (type !== "project" && (!selectedProjectId || selectedProjectId === UNGROUPED_PROJECT_ID)) {
          throw new Error("Select a project before creating items.");
        }
        const result = await createItem({
          type,
          title: title.trim(),
          parent_id: resolvedParentId ?? null,
          project_id: type === "project" ? null : selectedProjectId,
          due_at: dueMs,
          estimate_mode: estimateMode,
          estimate_minutes: estimate,
          status,
          priority: Number(priority),
          health,
          health_mode: healthMode,
          notes: notes.trim() ? notes.trim() : null,
        });
        const itemId = (result as { id?: string } | null)?.id;
        if (itemId) {
        if (scheduledFor) {
          const startAt = new Date(scheduledFor).getTime();
          const durationMinutes = Math.round(estimate);
          await createBlock({
            item_id: itemId,
            start_at: startAt,
            duration_minutes: durationMinutes,
          });
        }
          const tags = tagChips;
          if (tags.length > 0) {
            await setItemTags(itemId, tags);
          }
          await setItemAssignee(itemId, assigneeId ?? null);
          for (const depId of depChips) {
            await addDependency(itemId, depId);
          }
        }
        resetForm();
        onCreated?.();
      } else if (selectedItemId) {
        await updateItemFields(selectedItemId, {
          title: title.trim(),
          parent_id: resolvedParentId ?? null,
          due_at: dueMs,
          estimate_mode: estimateMode,
          estimate_minutes: estimate,
          priority: Number(priority),
          health,
          health_mode: healthMode,
          notes: notes.trim() ? notes.trim() : null,
        });
        const scheduleChanged =
          scheduledFor &&
          scheduledFor !== scheduledForInitialRef.current;
        if (scheduleChanged) {
          const startAt = new Date(scheduledFor).getTime();
          const durationMinutes = Math.round(estimate);
          if (scheduledBlockId) {
            await moveBlock(scheduledBlockId, startAt);
            await resizeBlock(scheduledBlockId, durationMinutes);
          } else {
            const created = await createBlock({
              item_id: selectedItemId,
              start_at: startAt,
              duration_minutes: durationMinutes,
            });
            setScheduledBlockId((created as { id?: string } | null)?.id ?? null);
          }
          scheduledForInitialRef.current = scheduledFor;
        }
        await setStatus(selectedItemId, status);
        const tags = tagChips;
        await setItemTags(selectedItemId, tags);
        await setItemAssignee(selectedItemId, assigneeId ?? null);
        const desiredDeps = new Set(depChips);
        const existingDeps = new Set(currentDeps);
        for (const depId of desiredDeps) {
          if (!existingDeps.has(depId)) {
            await addDependency(selectedItemId, depId);
          }
        }
        for (const depId of existingDeps) {
          if (!desiredDeps.has(depId)) {
            await removeDependency(selectedItemId, depId);
          }
        }
        onCreated?.();
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
        await addDependency(selectedItemId, dependencyId);
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
      await addBlocker(selectedItemId, blockerKind, blockerText);
      const details = await serverQuery<ItemDetails | null>("item_details", {
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
      await resolveBlocker(blockerId);
      const details = await serverQuery<ItemDetails | null>("item_details", {
        itemId: selectedItemId,
      });
      setBlockers(details?.blockers ?? []);
      onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleArchiveItem = async () => {
    if (mode !== "edit" || !selectedItemId) {
      return;
    }
    if (!confirm("Archive this item? This hides its descendants from the list.")) {
      return;
    }
    try {
      await archiveItem(selectedItemId);
      onRefresh();
      onDeleted?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleDeleteItem = async () => {
    if (mode !== "edit" || !selectedItemId) {
      return;
    }
    if (!confirm("Delete permanently? This removes all descendants.")) {
      return;
    }
    try {
      await deleteItem(selectedItemId);
      onRefresh();
      onDeleted?.();
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
          <AppSelect
            value={mode}
            onChange={(value) => {
              const next = value as "create" | "edit";
              setMode(next);
              setSelectedItemId("");
              resetForm();
            }}
            options={[
              { value: "create", label: "Create" },
              { value: "edit", label: "Edit" },
            ]}
          />
        </label>
        {mode === "edit" ? (
          <label>
            Select item
            <AppSelect
              value={selectedItemId || undefined}
              onChange={(value) => setSelectedItemId(value)}
              placeholder="Select item"
              options={[
                ...editableItems.map((item) => ({
                  value: item.id,
                  label: item.title,
                })),
              ]}
            />
          </label>
        ) : null}
        {mode === "edit" && loadingDetails ? (
          <div className="list-empty">Loading item…</div>
        ) : null}
      </div>

      <div className="form-row">
        <label>
          What are you adding? *
          <AppSelect
            value={type}
            onChange={(value) => {
              const next = value as ItemType;
              setType(next);
              if (next !== "task") {
                setParentId(null);
              }
            }}
            disabled={mode === "edit"}
            options={[
              { value: "project", label: "Project" },
              { value: "milestone", label: "Milestone" },
              { value: "task", label: "Task / Subtask" },
            ]}
          />
          {mode === "edit" ? (
            <span className="hint">Type cannot be changed</span>
          ) : null}
        </label>
        <label>
          Title *
          <AppInput
            ref={titleInputRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="New item"
            autoFocus
          />
        </label>
        <label>
          Deadline
          <AppInput
            type="datetime-local"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </label>
        <label>
          Estimate mode *
          <AppSelect
            value={estimateMode}
            onChange={(value) => {
              const next = value as "manual" | "rollup";
              setEstimateMode(next);
              if (next === "rollup") {
                setEstimateMinutes("0");
              }
            }}
            options={[
              { value: "manual", label: "Manual" },
              { value: "rollup", label: "Rollup" },
            ]}
          />
        </label>
        <label>
          Estimate minutes {estimateMode === "manual" ? "*" : ""}
          <AppInput
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
          <AppInput disabled value="Not supported yet" />
        </label>
        <label>
          Notes
          <AppTextArea
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Optional"
          />
        </label>
      </div>

      <div className="form-row">
        <label>
          Start time
          <AppInput
            type="datetime-local"
            value={scheduledFor}
            onChange={(event) => setScheduledFor(event.target.value)}
            placeholder="Optional"
          />
        </label>
      </div>

      <div className="form-row">
        <label>
          Parent
          {type === "milestone" ? (
            <AppInput
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
            <AppSelect
              value={parentId ?? EMPTY_SELECT_VALUE}
              onChange={(value) =>
                setParentId(value === EMPTY_SELECT_VALUE ? null : value)
              }
              disabled={type === "project" || !selectedProjectId}
              options={[
                selectedProjectId === UNGROUPED_PROJECT_ID
                  ? {
                      value: EMPTY_SELECT_VALUE,
                      label: "Ungrouped (no parent)",
                    }
                  : {
                      value: selectedProjectId ?? EMPTY_SELECT_VALUE,
                      label: selectedProjectId ? "Project (root)" : "Select a project",
                    },
                ...taskParentOptions.map((option) => ({
                  value: option.id,
                  label: formatOptionLabel(
                    option,
                    parentTypeMap.get(option.parent_id ?? "") ?? null
                  ),
                })),
              ]}
            />
          )}
        </label>
        <label>
          Status
          <AppSelect
            value={status}
            onChange={(value) => setStatus(value)}
            options={[
              { value: "backlog", label: "backlog" },
              { value: "ready", label: "ready" },
              { value: "in_progress", label: "in_progress" },
              { value: "blocked", label: "blocked" },
              { value: "review", label: "review" },
              { value: "done", label: "done" },
              { value: "canceled", label: "canceled" },
            ]}
          />
        </label>
        <label>
          Priority
          <AppSelect
            value={priority}
            onChange={(value) => setPriority(value)}
            options={Array.from({ length: 6 }, (_, index) => ({
              value: String(index),
              label: String(index),
            }))}
          />
        </label>
        <label>
          Health mode
          <AppSelect
            value={healthMode}
            onChange={(value) => setHealthMode(value as "auto" | "manual")}
            options={[
              { value: "auto", label: "auto" },
              { value: "manual", label: "manual" },
            ]}
          />
        </label>
        <label>
          Health
          <AppSelect
            value={health}
            onChange={(value) => setHealth(value)}
            disabled={healthMode !== "manual"}
            options={[
              { value: "on_track", label: "on_track" },
              { value: "at_risk", label: "at_risk" },
              { value: "behind", label: "behind" },
              { value: "ahead", label: "ahead" },
              { value: "unknown", label: "unknown" },
            ]}
          />
        </label>
      </div>

      <div className="form-row">
        <label>
          Tags
          <div className="chip-input">
            <div className="chip-list">
              {tagChips.map((tag) => (
                <AppButton
                  key={tag}
                  type="button"
                  size="1"
                  variant="soft"
                  className="chip"
                  onClick={() =>
                    setTagChips((prev) => prev.filter((entry) => entry !== tag))
                  }
                >
                  {tag} ×
                </AppButton>
              ))}
            </div>
            <AppInput
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
                  <AppButton
                    key={tag}
                    type="button"
                    size="1"
                    variant="soft"
                    className="chip-suggestion"
                    onClick={() => {
                      setTagChips((prev) =>
                        prev.includes(tag) ? prev : [...prev, tag]
                      );
                      setTagsInput("");
                    }}
                  >
                    {tag}
                  </AppButton>
                ))}
              </div>
            ) : null}
          </div>
        </label>
        <label>
          Assignee
          <UserSelect
            value={assigneeId}
            onChange={setAssigneeId}
            placeholder="Search users"
            projectId={selectedProjectId}
          />
        </label>
        <label>
          Dependencies
          <div className="chip-input">
            <div className="chip-list">
              {depChips.map((depId) => (
                <AppButton
                  key={depId}
                  type="button"
                  size="1"
                  variant="soft"
                  className="chip"
                  onClick={async () => {
                    setDepChips((prev) =>
                      prev.filter((entry) => entry !== depId)
                    );
                    if (mode === "edit" && selectedItemId) {
                      try {
                        await removeDependency(selectedItemId, depId);
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
                </AppButton>
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
                      {blocker.kind}: {blocker.text}{" "}
                      {blocker.cleared_at ? "(cleared)" : ""}
                    </span>
                    {!blocker.cleared_at ? (
                      <AppButton
                        type="button"
                        size="1"
                        variant="ghost"
                        onClick={() => handleClearBlocker(blocker.blocker_id)}
                      >
                        Clear
                      </AppButton>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </label>
          <label>
            Add blocker kind
            <AppInput
              value={blockerKind}
              onChange={(event) => setBlockerKind(event.target.value)}
              placeholder="general"
            />
          </label>
          <label>
            Add blocker text
            <AppInput
              value={blockerText}
              onChange={(event) => setBlockerText(event.target.value)}
              placeholder="Reason"
            />
          </label>
          <AppButton type="button" variant="surface" onClick={handleAddBlocker}>
            Add blocker
          </AppButton>
        </div>
      ) : null}

      {type === "milestone" && !selectedProjectId ? (
        <div className="list-empty">Select a project to add a milestone.</div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      <div className="form-actions">
        {mode === "edit" ? (
          <>
            <AppButton type="button" variant="surface" onClick={handleArchiveItem}>
              Archive
            </AppButton>
            <AppButton type="button" variant="ghost" onClick={handleDeleteItem}>
              Delete permanently
            </AppButton>
          </>
        ) : null}
        <AppButton
          type="submit"
          variant="surface"
          disabled={
            (type !== "project" && !selectedProjectId) ||
            (mode === "edit" && !selectedItemId) ||
            loadingDetails
          }
        >
          {mode === "edit" ? "Save changes" : "Create item"}
        </AppButton>
      </div>
    </form>
  );
};

export default AddItemForm;
