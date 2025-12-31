import { useCallback, useEffect, useMemo, useState } from "react";
import "./app.css";
import SidebarProjects from "./SidebarProjects";
import { UNGROUPED_PROJECT_ID, UNGROUPED_PROJECT_LABEL } from "./constants";
import ListView from "./ListView";
import CalendarView from "./CalendarView";
import DashboardView from "./DashboardView";
import GanttView from "./GanttView";
import KanbanView from "./KanbanView";
import AddItemForm from "./AddItemForm";
import RightSheet from "./RightSheet";
import CommandPalette from "./CommandPalette";
import ThemeSettings from "./ThemeSettings";
import SampleDataPanel from "./SampleDataPanel";
import { mutate, query } from "../rpc/clientSingleton";
import type { ListItem } from "../domain/listTypes";
import type { Scope } from "../domain/scope";
import { ScopeProvider } from "./ScopeContext";

type UserLite = {
  user_id: string;
  display_name: string;
  avatar_url?: string | null;
};

// Placeholder current user until real auth/users are wired.
const DEFAULT_USER: UserLite = {
  user_id: "me",
  display_name: "Me",
  avatar_url: null,
};

const App = () => {
  const [projectItems, setProjectItems] = useState<ListItem[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    UNGROUPED_PROJECT_ID
  );
  const [users, setUsers] = useState<UserLite[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
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
  const [activeView, setActiveView] = useState<
    "list" | "calendar" | "gantt" | "kanban" | "dashboard"
  >("list");
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const loadUsers = useCallback(async () => {
    setUsersError(null);
    try {
      const data = await query<{
        users: UserLite[];
        current_user_id?: string | null;
      }>("users_list", {});
      let list = data.users;
      let currentId =
        typeof data.current_user_id === "string" ? data.current_user_id : null;
      if (list.length === 0) {
        await mutate("user.create", { display_name: "Me" });
        const refreshed = await query<{
          users: UserLite[];
          current_user_id?: string | null;
        }>("users_list", {});
        list = refreshed.users;
        currentId =
          typeof refreshed.current_user_id === "string"
            ? refreshed.current_user_id
            : currentId;
      }
      if (list.length === 0) {
        list = [DEFAULT_USER];
      }
      setUsers(list);
      setSelectedUserId((prev) => {
        if (prev && list.some((user) => user.user_id === prev)) {
          return prev;
        }
        if (currentId && list.some((user) => user.user_id === currentId)) {
          return currentId;
        }
        return list[0]?.user_id ?? null;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setUsersError(message);
      setUsers([DEFAULT_USER]);
      setSelectedUserId((prev) => prev ?? DEFAULT_USER.user_id);
    }
  }, []);

  useEffect(() => {
    setError(null);
    loadProjectItems().catch((err) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    });
  }, [loadProjectItems, refreshToken]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers, refreshToken]);

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

  const currentUser = useMemo(() => {
    const list = users.length > 0 ? users : [DEFAULT_USER];
    if (selectedUserId) {
      const match = list.find((user) => user.user_id === selectedUserId);
      if (match) {
        return match;
      }
    }
    return list[0] ?? DEFAULT_USER;
  }, [selectedUserId, users]);

  // Scope drives all views; user scope is assignee-only with no parent inference.
  const activeScope = useMemo<Scope>(() => {
    if (scope) {
      return scope;
    }
    if (selectedUserId) {
      return { kind: "user", userId: selectedUserId };
    }
    return {
      kind: "project",
      projectId: selectedProjectId ?? UNGROUPED_PROJECT_ID,
    };
  }, [scope, selectedProjectId, selectedUserId]);

  useEffect(() => {
    if (scope) {
      return;
    }
    if (selectedUserId) {
      setScope({ kind: "user", userId: selectedUserId });
      return;
    }
    if (selectedProjectId) {
      setScope({ kind: "project", projectId: selectedProjectId });
    }
  }, [scope, selectedProjectId, selectedUserId]);

  useEffect(() => {
    if (!selectedUserId) {
      return;
    }
    setScope((prev) => {
      if (prev?.kind === "user" && prev.userId !== selectedUserId) {
        return { kind: "user", userId: selectedUserId };
      }
      return prev;
    });
  }, [selectedUserId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    setScope((prev) => {
      if (prev?.kind === "project" && prev.projectId !== selectedProjectId) {
        return { kind: "project", projectId: selectedProjectId };
      }
      return prev;
    });
  }, [selectedProjectId]);

  const handleSelectProject = useCallback(
    (projectId: string | null) => {
      if (!projectId) {
        return;
      }
      setSelectedProjectId(projectId);
      setScope({ kind: "project", projectId });
    },
    []
  );

  const handleSetProjectId = useCallback((projectId: string | null) => {
    if (!projectId) {
      return;
    }
    setSelectedProjectId(projectId);
    setScope((prev) =>
      prev?.kind === "project" ? { kind: "project", projectId } : prev
    );
  }, []);

  const handleSelectUser = useCallback((userId: string) => {
    setSelectedUserId(userId);
    setScope({ kind: "user", userId });
  }, []);

  const handleDeleteProjectById = useCallback(
    async (projectId: string, projectTitle: string) => {
      if (!projectId || projectId === UNGROUPED_PROJECT_ID) {
        return;
      }
      if (
        !confirm(`Delete ${projectTitle}? This removes all descendants.`)
      ) {
        return;
      }
      setDeleteError(null);
      try {
        await mutate("delete_item", { item_id: projectId });
        if (selectedProjectId === projectId) {
          setSelectedProjectId(UNGROUPED_PROJECT_ID);
          setScope({ kind: "project", projectId: UNGROUPED_PROJECT_ID });
        }
        triggerRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setDeleteError(message);
      }
    },
    [selectedProjectId, triggerRefresh]
  );

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

  const handleDashboardItemSelect = useCallback(
    (itemId: string, projectId: string | null) => {
      if (activeScope.kind !== "user") {
        openTaskEditor(itemId);
        return;
      }
      const targetId = projectId ?? UNGROUPED_PROJECT_ID;
      if (selectedProjectId === targetId) {
        openTaskEditor(itemId);
        return;
      }
      setActiveView("list");
      setSelectedProjectId(targetId);
      setScope({ kind: "project", projectId: targetId });
    },
    [activeScope.kind, openTaskEditor, selectedProjectId]
  );

  const handleSeededProject = useCallback(
    (projectId: string) => {
      setSelectedProjectId(projectId);
      setScope({ kind: "project", projectId });
      setActiveView("list");
    },
    []
  );

  const handleSheetOpenChange = useCallback((open: boolean) => {
    setSheetOpen(open);
    if (!open) {
      setSheetFocusTitle(false);
      setSheetItemId(null);
      setSheetMode("create");
    }
  }, []);

  return (
    <ScopeProvider scope={activeScope} setScope={setScope}>
      <div className="app-root">
        <div className="layout">
        <SidebarProjects
          scope={activeScope}
          selectedProjectId={selectedProjectId}
          onSelect={handleSelectProject}
          onSetProjectId={handleSetProjectId}
          refreshToken={refreshToken}
          onAddProject={() => openSheet("project")}
          onDeleteProject={handleDeleteProjectById}
          users={users}
          usersError={usersError}
          selectedUserId={selectedUserId ?? currentUser.user_id}
          onSelectUser={handleSelectUser}
        />
        <main className="main">
          <div className="top-bar">
            <div className="top-bar-left">
              <div className="top-tabs">
                <button
                  type="button"
                  className={
                    activeView === "dashboard"
                      ? "top-tab top-tab-active"
                      : "top-tab"
                  }
                  onClick={() => setActiveView("dashboard")}
                >
                  Dashboard
                </button>
                <button
                  type="button"
                  className={
                    activeView === "list"
                      ? "top-tab top-tab-active"
                      : "top-tab"
                  }
                  onClick={() => setActiveView("list")}
                >
                  List
                </button>
                <button
                  type="button"
                  className={
                    activeView === "calendar"
                      ? "top-tab top-tab-active"
                      : "top-tab"
                  }
                  onClick={() => setActiveView("calendar")}
                >
                  Calendar
                </button>
                <button
                  type="button"
                  className={
                    activeView === "kanban"
                      ? "top-tab top-tab-active"
                      : "top-tab"
                  }
                  onClick={() => setActiveView("kanban")}
                >
                  Kanban
                </button>
                <button
                  type="button"
                  className={
                    activeView === "gantt"
                      ? "top-tab top-tab-active"
                      : "top-tab"
                  }
                  onClick={() => setActiveView("gantt")}
                >
                  Gantt
                </button>
              </div>
              <div className="top-title">
                {activeView === "dashboard"
                  ? "Dashboard"
                  : activeScope.kind === "user"
                    ? currentUser.display_name
                    : selectedProject
                      ? selectedProject.title
                      : "Select a project"}
              </div>
            </div>
            <div className="top-bar-right">
              <div className="user-chip" title={currentUser.display_name}>
                <span className="user-chip-icon" aria-hidden="true">
                  👤
                </span>
                <span className="user-chip-label">
                  {currentUser.display_name}
                </span>
              </div>
              <button
                type="button"
                className="button"
                onClick={() => setSettingsOpen((prev) => !prev)}
              >
                Settings
              </button>
            </div>
          </div>
          {settingsOpen ? (
            <div className="settings-panel">
              <ThemeSettings />
              <SampleDataPanel
                onSeeded={handleSeededProject}
                onRefresh={triggerRefresh}
              />
            </div>
          ) : null}
          {activeScope.kind === "project" && activeView !== "dashboard" ? (
            <div className="title-actions">
              <button
                type="button"
                className="button"
                onClick={() => openSheet("milestone")}
              >
                New Milestone
              </button>
            </div>
          ) : null}
          {deleteError ? <div className="error">{deleteError}</div> : null}
          {error ? <div className="error">{error}</div> : null}
          {activeView === "dashboard" ? (
            <DashboardView
              scope={activeScope}
              refreshToken={refreshToken}
              onSelectItem={handleDashboardItemSelect}
            />
          ) : activeView === "list" ? (
            <ListView
              scope={activeScope}
              refreshToken={refreshToken}
              onRefresh={triggerRefresh}
              onOpenItem={openTaskEditor}
            />
          ) : activeView === "kanban" ? (
            <KanbanView
              scope={activeScope}
              refreshToken={refreshToken}
              onRefresh={triggerRefresh}
              onOpenItem={openTaskEditor}
            />
          ) : activeView === "calendar" ? (
            <CalendarView
              scope={activeScope}
              projectItems={projectItems}
              refreshToken={refreshToken}
              onRefresh={triggerRefresh}
              onOpenItem={openTaskEditor}
            />
          ) : (
            <GanttView
              scope={activeScope}
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
    </ScopeProvider>
  );
};

export default App;
