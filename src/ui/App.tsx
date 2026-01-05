"use client";

import { Tabs } from "@radix-ui/themes";
import { useCallback, useEffect, useMemo, useState } from "react";
import SidebarProjects from "./SidebarProjects";
import ListView from "./ListView";
import CalendarView from "./CalendarView";
import DashboardView from "./DashboardView";
import GanttView from "./GanttView";
import KanbanView from "./KanbanView";
import AddItemForm from "./AddItemForm";
import RightSheet from "./RightSheet";
import CommandPalette from "./CommandPalette";
import ThemeSettings from "./ThemeSettings";
import AiPlanPanel from "./AiPlanPanel";
import { AppButton } from "./controls";
import { serverQuery } from "./serverApi";
import { createInviteLink, revokeInviteLink } from "./serverActions";
import type { Scope } from "../domain/scope";
import { ScopeProvider } from "./ScopeContext";
import { useSse } from "./useSse";

type UserLite = {
  user_id: string;
  display_name: string;
  avatar_url?: string | null;
};

type ProjectLite = {
  id: string;
  title: string;
};

type InviteLink = {
  id: string;
  role: "viewer" | "editor";
  url: string;
  revoked_at: string | null;
  created_at: string;
};

// Placeholder current user until real auth/users are wired.
const DEFAULT_USER: UserLite = {
  user_id: "me",
  display_name: "Me",
  avatar_url: null,
};

const App = () => {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null
  );
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [collaborators, setCollaborators] = useState<UserLite[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [collaboratorsError, setCollaboratorsError] = useState<string | null>(
    null
  );
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
  const [aiOpen, setAiOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [inviteRole, setInviteRole] = useState<"viewer" | "editor">("viewer");
  const [inviteLinks, setInviteLinks] = useState<InviteLink[]>([]);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);

  const loadProjects = useCallback(async () => {
    setError(null);
    try {
      const data = await serverQuery<{ projects: ProjectLite[] }>(
        "projects_list",
        {}
      );
      setProjects(data.projects);
      setSelectedProjectId((prev) => {
        if (prev && data.projects.some((project) => project.id === prev)) {
          return prev;
        }
        return data.projects[0]?.id ?? null;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      setProjects([]);
    }
  }, [setError]);

  const triggerRefresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

  useSse(scope, () => {
    triggerRefresh();
  });

  const loadUsers = useCallback(async () => {
    setUsersError(null);
    try {
      const data = await serverQuery<{
        users: UserLite[];
        current_user_id?: string | null;
      }>("users_list", {});
      let list = data.users;
      let currentId =
        typeof data.current_user_id === "string" ? data.current_user_id : null;
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

  const loadCollaborators = useCallback(async () => {
    setCollaboratorsError(null);
    try {
      const data = await serverQuery<{ collaborators: UserLite[] }>(
        "collaborators_list",
        {}
      );
      setCollaborators(data.collaborators ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setCollaboratorsError(message);
      setCollaborators([]);
    }
  }, []);

  useEffect(() => {
    setError(null);
    void loadProjects();
  }, [loadProjects, refreshToken]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers, refreshToken]);

  useEffect(() => {
    void loadCollaborators();
  }, [loadCollaborators, refreshToken]);

  const loadInviteLinks = useCallback(async () => {
    if (!selectedProjectId) {
      setInviteLinks([]);
      setInviteError(null);
      return;
    }
    setInviteLoading(true);
    setInviteError(null);
    try {
      const data = await serverQuery<{ invites: InviteLink[] }>(
        "project_invite_links",
        { projectId: selectedProjectId }
      );
      setInviteLinks(data.invites ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setInviteError(message);
      setInviteLinks([]);
    } finally {
      setInviteLoading(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (!shareOpen) {
      return;
    }
    void loadInviteLinks();
  }, [loadInviteLinks, shareOpen]);

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
    if (!selectedProjectId) {
      return null;
    }
    return projects.find((project) => project.id === selectedProjectId) ?? null;
  }, [projects, selectedProjectId]);

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
    return { kind: "project", projectId: selectedProjectId ?? "" };
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

  useEffect(() => {
    if (activeScope.kind !== "project") {
      setShareOpen(false);
      setAiOpen(false);
    }
  }, [activeScope.kind]);

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
      if (!projectId) {
        return;
      }
      setDeleteError(null);
      setDeleteError(
        `Delete ${projectTitle} is not available in server mode yet.`
      );
    },
    []
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
      if (!projectId) {
        openTaskEditor(itemId);
        return;
      }
      if (selectedProjectId === projectId) {
        openTaskEditor(itemId);
        return;
      }
      setActiveView("list");
      setSelectedProjectId(projectId);
      setScope({ kind: "project", projectId });
    },
    [activeScope.kind, openTaskEditor, selectedProjectId]
  );

  const handleSheetOpenChange = useCallback((open: boolean) => {
    setSheetOpen(open);
    if (!open) {
      setSheetFocusTitle(false);
      setSheetItemId(null);
      setSheetMode("create");
    }
  }, []);

  const handleOpenProjectFromCommand = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    setScope({ kind: "project", projectId });
  }, []);

  const handleCopyInviteLink = async (url: string) => {
    if (typeof navigator === "undefined") {
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Copy failed";
      setInviteError(message);
    }
  };

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
          collaborators={collaborators}
          collaboratorsError={collaboratorsError}
          selectedUserId={selectedUserId ?? currentUser.user_id}
          onSelectUser={handleSelectUser}
        />
        <main className="main">
          <div className="top-bar">
            <div className="top-bar-left">
              <Tabs.Root
                value={activeView}
                onValueChange={(value) =>
                  setActiveView(value as typeof activeView)
                }
              >
                <Tabs.List className="top-tabs">
                  <Tabs.Trigger value="dashboard">Dashboard</Tabs.Trigger>
                  <Tabs.Trigger value="list">List</Tabs.Trigger>
                  <Tabs.Trigger value="calendar">Calendar</Tabs.Trigger>
                  <Tabs.Trigger value="kanban">Kanban</Tabs.Trigger>
                  <Tabs.Trigger value="gantt">Gantt</Tabs.Trigger>
                </Tabs.List>
              </Tabs.Root>
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
              {activeScope.kind === "project" && selectedProjectId ? (
                <>
                  <AppButton
                    type="button"
                    variant="surface"
                    onClick={() => setAiOpen((prev) => !prev)}
                  >
                    AI Plan
                  </AppButton>
                  <AppButton
                    type="button"
                    variant="surface"
                    onClick={() => setShareOpen((prev) => !prev)}
                  >
                    Share
                  </AppButton>
                </>
              ) : null}
              <div className="user-chip" title={currentUser.display_name}>
                <span className="user-chip-icon" aria-hidden="true">
                  👤
                </span>
                <span className="user-chip-label">
                  {currentUser.display_name}
                </span>
              </div>
              <AppButton
                type="button"
                variant="surface"
                onClick={() => setSettingsOpen((prev) => !prev)}
              >
                Settings
              </AppButton>
            </div>
          </div>
          {settingsOpen ? (
            <div className="settings-panel">
              <ThemeSettings />
            </div>
          ) : null}
          {aiOpen && activeScope.kind === "project" && selectedProject ? (
            <AiPlanPanel
              projectId={selectedProject.id}
              projectTitle={selectedProject.title}
              onClose={() => setAiOpen(false)}
              onApplied={() => triggerRefresh()}
            />
          ) : null}
          {shareOpen && activeScope.kind === "project" ? (
            <div className="share-panel">
              <div className="share-panel-header">
                <div className="share-panel-title">Invite link</div>
                <AppButton
                  type="button"
                  size="1"
                  variant="ghost"
                  onClick={() => setShareOpen(false)}
                >
                  Close
                </AppButton>
              </div>
              <div className="share-panel-row">
                <label className="share-panel-label">Role</label>
                <select
                  className="share-panel-select"
                  value={inviteRole}
                  onChange={(event) =>
                    setInviteRole(event.target.value as "viewer" | "editor")
                  }
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <AppButton
                  type="button"
                  size="1"
                  variant="surface"
                  onClick={async () => {
                    if (!selectedProjectId) {
                      return;
                    }
                    setInviteError(null);
                    try {
                      await createInviteLink(selectedProjectId, inviteRole);
                      await loadInviteLinks();
                    } catch (err) {
                      const message =
                        err instanceof Error ? err.message : "Unknown error";
                      setInviteError(message);
                    }
                  }}
                >
                  Generate
                </AppButton>
              </div>
              {inviteError ? <div className="error">{inviteError}</div> : null}
              {inviteLoading ? (
                <div className="share-panel-empty">Loading links…</div>
              ) : inviteLinks.length === 0 ? (
                <div className="share-panel-empty">No invite links yet.</div>
              ) : (
                <div className="share-panel-list">
                  {inviteLinks.map((invite) => (
                    <div
                      key={invite.id}
                      className={
                        invite.revoked_at
                          ? "share-panel-item is-revoked"
                          : "share-panel-item"
                      }
                    >
                      <div className="share-panel-item-meta">
                        <div className="share-panel-item-role">
                          {invite.role}
                        </div>
                        <div className="share-panel-item-url">
                          {invite.url}
                        </div>
                      </div>
                      <div className="share-panel-item-actions">
                        <AppButton
                          type="button"
                          size="1"
                          variant="ghost"
                          onClick={() => void handleCopyInviteLink(invite.url)}
                        >
                          Copy
                        </AppButton>
                        {!invite.revoked_at ? (
                          <AppButton
                            type="button"
                            size="1"
                            variant="ghost"
                            onClick={async () => {
                              setInviteError(null);
                              try {
                                await revokeInviteLink(invite.id);
                                await loadInviteLinks();
                              } catch (err) {
                                const message =
                                  err instanceof Error
                                    ? err.message
                                    : "Unknown error";
                                setInviteError(message);
                              }
                            }}
                          >
                            Revoke
                          </AppButton>
                        ) : (
                          <span className="share-panel-item-revoked">
                            Revoked
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          {activeScope.kind === "project" && activeView !== "dashboard" ? (
            <div className="title-actions">
              <AppButton
                type="button"
                variant="surface"
                onClick={() => openSheet("milestone")}
              >
                New Milestone
              </AppButton>
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
              defaultProjectId={selectedProjectId}
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
              items={[]}
              onRefresh={triggerRefresh}
              initialType={sheetType}
              initialMode={sheetMode}
              initialItemId={sheetItemId}
              autoFocusTitle={sheetFocusTitle}
              onCreated={() => {
                handleSheetOpenChange(false);
              }}
              onDeleted={() => {
                handleSheetOpenChange(false);
              }}
            />
          </RightSheet>
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            selectedProjectId={selectedProjectId}
            onCreated={triggerRefresh}
            onOpenProject={handleOpenProjectFromCommand}
            onOpenView={setActiveView}
          />
        </main>
        </div>
      </div>
    </ScopeProvider>
  );
};

export default App;
