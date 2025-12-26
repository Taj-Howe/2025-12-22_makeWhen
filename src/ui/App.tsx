import { useCallback, useEffect, useMemo, useState } from "react";
import "./app.css";
import SidebarProjects from "./SidebarProjects";
import ListView from "./ListView";
import AddItemForm from "./AddItemForm";
import RightSheet from "./RightSheet";
import CommandPalette from "./CommandPalette";
import { mutate, query } from "../rpc/clientSingleton";

type ItemTraits = {
  id: string;
  type: "project" | "milestone" | "task";
  title: string;
  parent_id: string | null;
  project_id: string;
  depth: number;
  status: string;
  priority: number;
  due_at: number;
  estimate_minutes: number;
  notes: string | null;
  health: string;
  health_mode: string;
  schedule: {
    has_blocks: boolean;
    scheduled_minutes_total: number;
    schedule_start_at: number | null;
    schedule_end_at: number | null;
  };
  blocked: {
    is_blocked: boolean;
    blocked_by_deps: boolean;
    blocked_by_blockers: boolean;
    active_blocker_count: number;
    unmet_dependency_count: number;
    scheduled_but_blocked?: boolean;
  };
  assignees: { id: string; name: string | null }[];
  tags: { id: string; name: string }[];
  sequence_rank: number;
};

const App = () => {
  const [projectItems, setProjectItems] = useState<ItemTraits[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetType, setSheetType] = useState<"project" | "milestone" | "task">(
    "task"
  );
  const [paletteOpen, setPaletteOpen] = useState(false);

  const loadProjectItems = useCallback(async () => {
    if (!selectedProjectId) {
      setProjectItems([]);
      return;
    }
    const data = await query<{ items: ItemTraits[] }>("listItems", {
      projectId: selectedProjectId,
      includeDone: true,
      includeCanceled: true,
      orderBy: "due_at",
      orderDir: "asc",
    });
    setProjectItems(data.items);
  }, [selectedProjectId]);

  const triggerRefresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

  useEffect(() => {
    setError(null);
    loadProjectItems().catch((err) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    });
  }, [loadProjectItems, refreshToken]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isK = event.key.toLowerCase() === "k";
      if (!isK) {
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      if (sheetOpen) {
        return;
      }
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sheetOpen]);

  const selectedProject = useMemo(
    () => projectItems.find((item) => item.id === selectedProjectId) ?? null,
    [projectItems, selectedProjectId]
  );

  const handleDeleteProject = useCallback(async () => {
    if (!selectedProjectId || !selectedProject) {
      return;
    }
    if (
      !confirm(
        `Delete ${selectedProject.title}? This removes all descendants.`
      )
    ) {
      return;
    }
    setDeleteError(null);
    try {
      await mutate("delete_item", { item_id: selectedProjectId });
      setSelectedProjectId(null);
      triggerRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setDeleteError(message);
    }
  }, [selectedProject, selectedProjectId, triggerRefresh]);

  const openSheet = useCallback(
    (type: "project" | "milestone" | "task") => {
      setPaletteOpen(false);
      setSheetType(type);
      setSheetOpen(true);
    },
    []
  );

  return (
    <div className="app-root">
      <div className="layout">
        <SidebarProjects
          selectedProjectId={selectedProjectId}
          onSelect={setSelectedProjectId}
          refreshToken={refreshToken}
        />
        <main className="main">
          <div className="title-row">
            <h1 className="title">
              {selectedProject ? selectedProject.title : "Select a project"}
            </h1>
            <div className="title-actions">
              <button
                type="button"
                className="button"
                onClick={() => openSheet("project")}
              >
                New Project
              </button>
              <button
                type="button"
                className="button"
                onClick={() => openSheet("milestone")}
              >
                New Milestone
              </button>
              <button
                type="button"
                className="button"
                onClick={() => openSheet("task")}
              >
                New Task
              </button>
              <button
                type="button"
                className="button"
                onClick={handleDeleteProject}
                disabled={!selectedProjectId}
              >
                Delete Project
              </button>
            </div>
          </div>
          {deleteError ? <div className="error">{deleteError}</div> : null}
          {error ? <div className="error">{error}</div> : null}
          <ListView
            selectedProjectId={selectedProjectId}
            refreshToken={refreshToken}
            onRefresh={triggerRefresh}
          />
          <RightSheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            title={`New ${sheetType}`}
          >
            <AddItemForm
              key={`${sheetType}-${selectedProjectId ?? "none"}`}
              selectedProjectId={selectedProjectId}
              items={projectItems}
              onRefresh={triggerRefresh}
              initialType={sheetType}
              onCreated={() => setSheetOpen(false)}
            />
          </RightSheet>
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            selectedProjectId={selectedProjectId}
            onCreated={triggerRefresh}
          />
        </main>
      </div>
    </div>
  );
};

export default App;
