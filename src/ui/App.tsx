import { useCallback, useEffect, useMemo, useState } from "react";
import "./app.css";
import SidebarProjects from "./SidebarProjects";
import { UNGROUPED_PROJECT_ID, UNGROUPED_PROJECT_LABEL } from "./constants";
import ListView from "./ListView";
import CalendarView from "./CalendarView";
import AddItemForm from "./AddItemForm";
import RightSheet from "./RightSheet";
import CommandPalette from "./CommandPalette";
import { mutate, query } from "../rpc/clientSingleton";
import type { ListItem } from "../domain/listTypes";

const App = () => {
  const [projectItems, setProjectItems] = useState<ListItem[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetType, setSheetType] = useState<"project" | "milestone" | "task">(
    "task"
  );
  const [sheetMode, setSheetMode] = useState<"create" | "edit">("create");
  const [sheetItemId, setSheetItemId] = useState<string | null>(null);
  const [sheetFocusTitle, setSheetFocusTitle] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activeView, setActiveView] = useState<"list" | "calendar">("list");

  const loadProjectItems = useCallback(async () => {
    if (!selectedProjectId) {
      setProjectItems([]);
      return;
    }
    const data = await query<{ items: ListItem[] }>("listItems", {
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

  const selectedProject = useMemo(() => {
    if (selectedProjectId === UNGROUPED_PROJECT_ID) {
      return { id: UNGROUPED_PROJECT_ID, title: UNGROUPED_PROJECT_LABEL };
    }
    return (
      projectItems.find((item) => item.id === selectedProjectId) ?? null
    );
  }, [projectItems, selectedProjectId]);

  const handleDeleteProject = useCallback(async () => {
    if (
      !selectedProjectId ||
      selectedProjectId === UNGROUPED_PROJECT_ID ||
      !selectedProject
    ) {
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
      setSelectedProjectId(UNGROUPED_PROJECT_ID);
      triggerRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setDeleteError(message);
    }
  }, [selectedProject, selectedProjectId, triggerRefresh]);

  const openSheet = useCallback(
    (type: "project" | "milestone" | "task") => {
      setPaletteOpen(false);
      setSheetMode("create");
      setSheetType(type);
      setSheetItemId(null);
      setSheetFocusTitle(false);
      setSheetOpen(true);
    },
    []
  );

  const openTaskEditor = useCallback((itemId: string) => {
    setPaletteOpen(false);
    setSheetMode("edit");
    setSheetType("task");
    setSheetItemId(itemId);
    setSheetFocusTitle(true);
    setSheetOpen(true);
  }, []);

  const handleSheetOpenChange = useCallback((open: boolean) => {
    setSheetOpen(open);
    if (!open) {
      setSheetFocusTitle(false);
      setSheetItemId(null);
      setSheetMode("create");
    }
  }, []);

  return (
    <div className="app-root">
      <div className="layout">
        <SidebarProjects
          selectedProjectId={selectedProjectId}
          onSelect={setSelectedProjectId}
          refreshToken={refreshToken}
          onAddProject={() => openSheet("project")}
        />
        <main className="main">
          <div className="title-row">
            <h1 className="title">
              {selectedProject ? selectedProject.title : "Select a project"}
            </h1>
            <div className="view-toggle">
              <button
                type="button"
                className={
                  activeView === "list"
                    ? "view-toggle-button view-toggle-active"
                    : "view-toggle-button"
                }
                onClick={() => setActiveView("list")}
              >
                List
              </button>
              <button
                type="button"
                className={
                  activeView === "calendar"
                    ? "view-toggle-button view-toggle-active"
                    : "view-toggle-button"
                }
                onClick={() => setActiveView("calendar")}
              >
                Calendar
              </button>
            </div>
            <div className="title-actions">
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
                onClick={handleDeleteProject}
                disabled={
                  !selectedProjectId ||
                  selectedProjectId === UNGROUPED_PROJECT_ID
                }
              >
                Delete Project
              </button>
            </div>
          </div>
          {deleteError ? <div className="error">{deleteError}</div> : null}
          {error ? <div className="error">{error}</div> : null}
          {activeView === "list" ? (
            <ListView
              selectedProjectId={selectedProjectId}
              refreshToken={refreshToken}
              onRefresh={triggerRefresh}
            />
          ) : (
            <CalendarView
              selectedProjectId={selectedProjectId}
              projectItems={projectItems}
              refreshToken={refreshToken}
              onRefresh={triggerRefresh}
              onOpenItem={openTaskEditor}
            />
          )}
          <RightSheet
            open={sheetOpen}
            onOpenChange={handleSheetOpenChange}
            title={sheetMode === "edit" ? "Edit task" : `New ${sheetType}`}
          >
            <AddItemForm
              key={`${sheetMode}-${sheetType}-${selectedProjectId ?? "none"}-${sheetItemId ?? "none"}`}
              selectedProjectId={selectedProjectId}
              items={projectItems}
              onRefresh={triggerRefresh}
              initialType={sheetType}
              initialMode={sheetMode}
              initialItemId={sheetItemId}
              autoFocusTitle={sheetFocusTitle}
              onCreated={() => {
                handleSheetOpenChange(false);
              }}
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
