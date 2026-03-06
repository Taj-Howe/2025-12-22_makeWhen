import { Tabs } from "@radix-ui/themes";
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
import SettingsWindow from "./SettingsWindow";
import { AppButton, AppSelect } from "./controls";
import { mutate, query } from "../rpc/clientSingleton";
import {
  authProvider,
  getAuthRemoteBaseUrl,
  getSessionOptions,
} from "../auth/authProvider";
import type { ListItem } from "../domain/listTypes";
import type { Scope } from "../domain/scope";
import {
  applySemanticColorVars,
  normalizeSemanticColorMap,
} from "../domain/semanticColors";
import {
  applyThemeTokenVars,
  clearThemeTokenVars,
  normalizeThemeTokenOverrides,
} from "../domain/themeTokens";
import {
  DEFAULT_TYPOGRAPHY_SETTINGS,
  applyTypographySettings,
  normalizeTypographySettings,
} from "../domain/typographySettings";
import { ScopeProvider } from "./ScopeContext";
import type {
  AuthSessionCurrentResult,
  AuthSessionOptionsResult,
} from "../rpc/types";

type UserLite = {
  user_id: string;
  display_name: string;
  avatar_url?: string | null;
};

const DEFAULT_USER: UserLite = {
  user_id: "me",
  display_name: "Me",
  avatar_url: null,
};

const EMPTY_AUTH_OPTIONS: AuthSessionOptionsResult = {
  users: [],
  teams: [],
  memberships: [],
};

const parseInviteTokenFromLocation = () => {
  if (typeof window === "undefined") {
    return null;
  }
  const match = window.location.pathname.match(/^\/invite\/([^/]+)$/);
  if (!match?.[1]) {
    return null;
  }
  return decodeURIComponent(match[1]);
};

const readCookie = (name: string) => {
  if (typeof document === "undefined") {
    return "";
  }
  const entries = document.cookie.split(";").map((part) => part.trim());
  for (const entry of entries) {
    if (!entry.startsWith(`${name}=`)) {
      continue;
    }
    return decodeURIComponent(entry.slice(name.length + 1));
  }
  return "";
};

const App = () => {
  const [projectItems, setProjectItems] = useState<ListItem[]>([]);
  const [projectTitleById, setProjectTitleById] = useState<Record<string, string>>(
    () => ({ [UNGROUPED_PROJECT_ID]: UNGROUPED_PROJECT_LABEL })
  );
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
  const [authCurrent, setAuthCurrent] = useState<AuthSessionCurrentResult | null>(
    null
  );
  const [authOptions, setAuthOptions] =
    useState<AuthSessionOptionsResult>(EMPTY_AUTH_OPTIONS);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authActionError, setAuthActionError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountUserId, setAccountUserId] = useState("");
  const [accountTeamId, setAccountTeamId] = useState("");
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(
    () => parseInviteTokenFromLocation()
  );
  const [inviteStatusMessage, setInviteStatusMessage] = useState<string | null>(
    null
  );
  const [inviteStatusError, setInviteStatusError] = useState<string | null>(
    null
  );

  const activeSession = authCurrent?.session ?? null;
  const activeSessionId = activeSession?.session_id ?? null;

  const refreshAuth = useCallback(async () => {
    const current = await authProvider.getSession();
    const options = await getSessionOptions();
    setAuthCurrent(current);
    setAuthOptions(options);
  }, []);

  const acceptInviteToken = useCallback(async (token: string) => {
    const baseUrl = getAuthRemoteBaseUrl();
    if (!baseUrl) {
      throw new Error("AUTH_REMOTE_BASE_URL is required to accept team invites.");
    }
    const csrf = readCookie("mw_csrf");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (csrf) {
      headers["X-CSRF-Token"] = csrf;
    }
    const response = await fetch(
      `${baseUrl}/invites/${encodeURIComponent(token)}/accept`,
      {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers,
      }
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { message?: string }
        | null;
      const message = payload?.message ?? `HTTP ${response.status}`;
      throw new Error(`Invite accept failed: ${message}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }, []);

  const triggerRefresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

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

  const loadProjectTitleIndex = useCallback(async () => {
    const data = await query<{ items: ListItem[] }>("listItems", {
      includeDone: true,
      includeCanceled: true,
      orderBy: "due_at",
      orderDir: "asc",
    });
    const next: Record<string, string> = {
      [UNGROUPED_PROJECT_ID]: UNGROUPED_PROJECT_LABEL,
    };
    for (const item of data.items) {
      if (item.type === "project") {
        next[item.id] = item.title;
      }
    }
    setProjectTitleById(next);
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
    let canceled = false;
    setAuthLoading(true);
    setAuthError(null);
    refreshAuth()
      .catch((err) => {
        if (canceled) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setAuthError(message);
      })
      .finally(() => {
        if (!canceled) {
          setAuthLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, [refreshAuth]);

  useEffect(() => {
    if (!activeSessionId || !pendingInviteToken) {
      return;
    }
    let canceled = false;
    setInviteStatusError(null);
    setInviteStatusMessage(null);
    acceptInviteToken(pendingInviteToken)
      .then(async () => {
        if (canceled) {
          return;
        }
        setInviteStatusMessage("Team invite accepted.");
        setPendingInviteToken(null);
        if (typeof window !== "undefined" && window.location.pathname.startsWith("/invite/")) {
          window.history.replaceState({}, "", "/");
        }
        await refreshAuth();
        triggerRefresh();
      })
      .catch((err) => {
        if (canceled) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setInviteStatusError(message);
      });
    return () => {
      canceled = true;
    };
  }, [
    acceptInviteToken,
    activeSessionId,
    pendingInviteToken,
    refreshAuth,
    triggerRefresh,
  ]);

  useEffect(() => {
    if (!activeSessionId) {
      setProjectItems([]);
      setError(null);
      return;
    }
    setError(null);
    loadProjectItems().catch((err) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    });
  }, [activeSessionId, loadProjectItems, refreshToken]);

  useEffect(() => {
    if (!activeSessionId) {
      setProjectTitleById({ [UNGROUPED_PROJECT_ID]: UNGROUPED_PROJECT_LABEL });
      return;
    }
    loadProjectTitleIndex().catch(() => {
      // Keep current title cache if this refresh fails.
    });
  }, [activeSessionId, loadProjectTitleIndex, refreshToken]);

  useEffect(() => {
    if (!activeSessionId) {
      setUsers([]);
      setSelectedUserId(null);
      setUsersError(null);
      return;
    }
    void loadUsers();
  }, [activeSessionId, loadUsers, refreshToken]);

  useEffect(() => {
    let mounted = true;
    query<Record<string, unknown>>("getSettings", {})
      .then((settings) => {
        if (!mounted || typeof document === "undefined") {
          return;
        }
        const semanticColors = normalizeSemanticColorMap(
          settings["ui.semantic_colors"]
        );
        const themeTokenOverrides = normalizeThemeTokenOverrides(
          settings["ui.theme_tokens"]
        );
        const typographySettings = normalizeTypographySettings(
          settings["ui.typography"]
        );
        applySemanticColorVars(document.documentElement, semanticColors);
        clearThemeTokenVars(document.documentElement);
        applyThemeTokenVars(document.documentElement, themeTokenOverrides);
        applyTypographySettings(document.documentElement, typographySettings);
      })
      .catch(() => {
        if (!mounted || typeof document === "undefined") {
          return;
        }
        applySemanticColorVars(
          document.documentElement,
          normalizeSemanticColorMap(undefined)
        );
        clearThemeTokenVars(document.documentElement);
        applyTypographySettings(
          document.documentElement,
          DEFAULT_TYPOGRAPHY_SETTINGS
        );
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isOptionK =
        event.code === "KeyK" &&
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey;
      if (!isOptionK) {
        return;
      }
      if (sheetOpen || !activeSessionId) {
        return;
      }
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeSessionId, sheetOpen]);

  const selectedProject = useMemo(() => {
    if (selectedProjectId === UNGROUPED_PROJECT_ID) {
      return { id: UNGROUPED_PROJECT_ID, title: UNGROUPED_PROJECT_LABEL };
    }
    return projectItems.find((item) => item.id === selectedProjectId) ?? null;
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

  useEffect(() => {
    setAccountUserId((prev) => {
      if (prev && authOptions.users.some((user) => user.user_id === prev)) {
        return prev;
      }
      if (activeSession?.user_id) {
        return activeSession.user_id;
      }
      return authOptions.users[0]?.user_id ?? "";
    });
  }, [activeSession?.user_id, authOptions.users]);

  const accountTeamOptions = useMemo(() => {
    if (!accountUserId) {
      return [];
    }
    const allowedTeamIds = new Set(
      authOptions.memberships
        .filter((membership) => membership.user_id === accountUserId)
        .map((membership) => membership.team_id)
    );
    return authOptions.teams.filter((team) => allowedTeamIds.has(team.team_id));
  }, [accountUserId, authOptions.memberships, authOptions.teams]);

  useEffect(() => {
    setAccountTeamId((prev) => {
      if (
        activeSession &&
        activeSession.user_id === accountUserId &&
        accountTeamOptions.some((team) => team.team_id === activeSession.team_id)
      ) {
        return activeSession.team_id;
      }
      if (prev && accountTeamOptions.some((team) => team.team_id === prev)) {
        return prev;
      }
      return accountTeamOptions[0]?.team_id ?? "";
    });
  }, [accountTeamOptions, accountUserId, activeSession]);

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

  const activeProjectTitle = useMemo(() => {
    const projectId =
      activeScope.kind === "project" ? activeScope.projectId : selectedProjectId;
    if (!projectId) {
      return "Select a project";
    }
    return (
      projectTitleById[projectId] ??
      (projectId === selectedProject?.id ? selectedProject.title : null) ??
      "Select a project"
    );
  }, [activeScope, projectTitleById, selectedProject, selectedProjectId]);

  const activeScopeLabel = useMemo(() => {
    if (activeScope.kind === "project") {
      return `Project: ${activeProjectTitle}`;
    }
    const userLabel =
      users.find((user) => user.user_id === activeScope.userId)?.display_name ??
      (activeScope.userId === currentUser.user_id
        ? currentUser.display_name
        : activeScope.userId);
    return `User: ${userLabel}`;
  }, [activeProjectTitle, activeScope, currentUser.display_name, currentUser.user_id, users]);

  const activeViewLabel = useMemo(() => {
    switch (activeView) {
      case "dashboard":
        return "Dashboard";
      case "list":
        return "List";
      case "calendar":
        return "Calendar";
      case "kanban":
        return "Kanban";
      case "gantt":
        return "Gantt";
      default:
        return "View";
    }
  }, [activeView]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    if (!activeSessionId) {
      document.title = "makewhen";
      return;
    }
    document.title = `${activeViewLabel} · ${activeScopeLabel} · makewhen`;
  }, [activeScopeLabel, activeSessionId, activeViewLabel]);

  const activeUserLabel = authCurrent?.user?.display_name ?? currentUser.display_name;
  const activeTeamLabel = authCurrent?.team?.name ?? "No team";
  const isClerkMode = authProvider.mode === "clerk";

  const canApplySession =
    !!accountUserId &&
    !!accountTeamId &&
    (activeSession?.user_id !== accountUserId ||
      activeSession?.team_id !== accountTeamId);

  const applySessionSelection = useCallback(async () => {
    if (!accountTeamId && !isClerkMode) {
      return;
    }
    if (!isClerkMode && !accountUserId) {
      return;
    }
    setAuthActionError(null);
    setAuthBusy(true);
    try {
      const signIn = await authProvider.signIn(
        isClerkMode
          ? { team_id: accountTeamId || undefined }
          : {
              user_id: accountUserId,
              team_id: accountTeamId,
            }
      );
      if (signIn.status !== "signed_in") {
        setAccountOpen(true);
        return;
      }
      await refreshAuth();
      if (accountUserId) {
        setSelectedUserId(accountUserId);
      }
      setSelectedProjectId(UNGROUPED_PROJECT_ID);
      setScope({ kind: "project", projectId: UNGROUPED_PROJECT_ID });
      setError(null);
      setDeleteError(null);
      setPaletteOpen(false);
      setSheetOpen(false);
      setAccountOpen(false);
      triggerRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setAuthActionError(message);
    } finally {
      setAuthBusy(false);
    }
  }, [
    isClerkMode,
    accountTeamId,
    accountUserId,
    refreshAuth,
    triggerRefresh,
  ]);

  const handleSignOut = useCallback(async () => {
    setAuthActionError(null);
    setAuthBusy(true);
    try {
      await authProvider.signOut();
      await refreshAuth();
      setSelectedProjectId(UNGROUPED_PROJECT_ID);
      setScope({ kind: "project", projectId: UNGROUPED_PROJECT_ID });
      setSelectedUserId(null);
      setProjectItems([]);
      setUsers([]);
      setPaletteOpen(false);
      setSheetOpen(false);
      setAccountOpen(false);
      triggerRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setAuthActionError(message);
    } finally {
      setAuthBusy(false);
    }
  }, [refreshAuth, triggerRefresh]);

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
      if (!confirm(`Delete ${projectTitle}? This removes all descendants.`)) {
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

  const handleSeededProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    setScope({ kind: "project", projectId });
    setActiveView("list");
  }, []);

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

  return (
    <ScopeProvider scope={activeScope} setScope={setScope}>
      <div className="app-root">
        <div className="layout">
          {activeSessionId ? (
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
              onSelectUser={handleSelectUser}
              currentUserName={activeUserLabel}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : (
            <aside className="sidebar sidebar-signed-out">
              <div className="sidebar-title">Workspace</div>
              <div className="sidebar-empty">Sign in to view projects and team calendars.</div>
            </aside>
          )}
          <main className="main">
            <div className="top-strip">
              <div className="top-strip-row">
                <div className="top-strip-tabs">
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
                </div>
                <div className="top-strip-right">
                  <div className="account-control">
                    <AppButton
                      type="button"
                      variant="surface"
                      className="account-trigger"
                      onClick={() => {
                        if (activeSessionId) {
                          setAccountOpen((open) => !open);
                          return;
                        }
                        setAuthActionError(null);
                        void authProvider
                          .signIn()
                          .then((result) => {
                            if (
                              result.status === "picker_required" &&
                              authProvider.mode === "local"
                            ) {
                              setAccountOpen(true);
                            }
                          })
                          .catch((err) => {
                            const message =
                              err instanceof Error ? err.message : "Unknown error";
                            setAuthActionError(message);
                          });
                      }}
                    >
                      {activeSessionId
                        ? `${activeUserLabel} · ${activeTeamLabel}`
                        : "Account"}
                    </AppButton>
                    {accountOpen ? (
                      <div className="account-menu">
                        {isClerkMode ? (
                          <>
                            <div className="account-menu-label">User</div>
                            <div>{activeUserLabel}</div>
                          </>
                        ) : (
                          <>
                            <div className="account-menu-label">User</div>
                            <AppSelect
                              value={accountUserId}
                              onChange={setAccountUserId}
                              options={authOptions.users.map((user) => ({
                                value: user.user_id,
                                label: user.display_name,
                              }))}
                              placeholder="Choose user"
                            />
                          </>
                        )}
                        <div className="account-menu-label">Team</div>
                        <AppSelect
                          value={accountTeamId}
                          onChange={setAccountTeamId}
                          options={accountTeamOptions.map((team) => ({
                            value: team.team_id,
                            label: team.name,
                          }))}
                          placeholder="Choose team"
                        />
                        <div className="account-menu-actions">
                          <AppButton
                            type="button"
                            variant="surface"
                            onClick={() => {
                              void applySessionSelection();
                            }}
                            disabled={authBusy || !canApplySession || !accountTeamId}
                          >
                            {isClerkMode ? "Switch team" : "Switch"}
                          </AppButton>
                          <AppButton
                            type="button"
                            variant="surface"
                            onClick={() => {
                              void handleSignOut();
                            }}
                            disabled={!activeSessionId || authBusy}
                          >
                            Sign out
                          </AppButton>
                        </div>
                        {authActionError ? (
                          <div className="error">{authActionError}</div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
            <div className="main-content">
              {authLoading ? (
                <div className="auth-state-message">Loading session...</div>
              ) : null}
              {authError ? <div className="error">{authError}</div> : null}
              {!authLoading && !activeSessionId ? (
                <div className="signed-out-panel">
                  <div className="signed-out-title">Signed out</div>
                  <div className="signed-out-help">
                    {isClerkMode
                      ? "Sign in with Clerk to open your workspace."
                      : "Choose a local user and team to start a dev session."}
                  </div>
                  {pendingInviteToken ? (
                    <div className="signed-out-help">
                      Invite detected. Sign in to accept it automatically.
                    </div>
                  ) : null}
                  {isClerkMode ? null : (
                    <>
                      <div className="signed-out-field">
                        <div className="account-menu-label">User</div>
                        <AppSelect
                          value={accountUserId}
                          onChange={setAccountUserId}
                          options={authOptions.users.map((user) => ({
                            value: user.user_id,
                            label: user.display_name,
                          }))}
                          placeholder="Choose user"
                        />
                      </div>
                      <div className="signed-out-field">
                        <div className="account-menu-label">Team</div>
                        <AppSelect
                          value={accountTeamId}
                          onChange={setAccountTeamId}
                          options={accountTeamOptions.map((team) => ({
                            value: team.team_id,
                            label: team.name,
                          }))}
                          placeholder="Choose team"
                        />
                      </div>
                    </>
                  )}
                  <AppButton
                    type="button"
                    variant="surface"
                    onClick={() => {
                      if (isClerkMode) {
                        setAuthActionError(null);
                        setAuthBusy(true);
                        void authProvider
                          .signIn()
                          .catch((err) => {
                            const message =
                              err instanceof Error ? err.message : "Unknown error";
                            setAuthActionError(message);
                          })
                          .finally(() => setAuthBusy(false));
                        return;
                      }
                      void applySessionSelection();
                    }}
                    disabled={
                      authBusy ||
                      (!isClerkMode && (!accountUserId || !accountTeamId))
                    }
                  >
                    {isClerkMode ? "Sign in with Clerk" : "Start session"}
                  </AppButton>
                  {authActionError ? <div className="error">{authActionError}</div> : null}
                </div>
              ) : null}
              {activeSessionId ? (
                <>
                  {inviteStatusMessage ? (
                    <div className="auth-state-message">{inviteStatusMessage}</div>
                  ) : null}
                  {inviteStatusError ? <div className="error">{inviteStatusError}</div> : null}
                  <div className="top-title-row">
                    <div className="top-title">
                      {activeViewLabel} · {activeScopeLabel}
                    </div>
                  </div>
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
                  <div className="view-stack">
                    <section
                      className={`view-panel${activeView === "dashboard" ? " is-active" : ""}`}
                      aria-hidden={activeView !== "dashboard"}
                    >
                      <DashboardView
                        scope={activeScope}
                        refreshToken={refreshToken}
                        onSelectItem={handleDashboardItemSelect}
                      />
                    </section>
                    <section
                      className={`view-panel${activeView === "list" ? " is-active" : ""}`}
                      aria-hidden={activeView !== "list"}
                    >
                      <ListView
                        scope={activeScope}
                        refreshToken={refreshToken}
                        onRefresh={triggerRefresh}
                        onOpenItem={openTaskEditor}
                      />
                    </section>
                    <section
                      className={`view-panel${activeView === "kanban" ? " is-active" : ""}`}
                      aria-hidden={activeView !== "kanban"}
                    >
                      <KanbanView
                        scope={activeScope}
                        refreshToken={refreshToken}
                        onRefresh={triggerRefresh}
                        onOpenItem={openTaskEditor}
                      />
                    </section>
                    <section
                      className={`view-panel${activeView === "calendar" ? " is-active" : ""}`}
                      aria-hidden={activeView !== "calendar"}
                    >
                      <CalendarView
                        scope={activeScope}
                        projectItems={projectItems}
                        refreshToken={refreshToken}
                        onRefresh={triggerRefresh}
                        onOpenItem={openTaskEditor}
                      />
                    </section>
                    <section
                      className={`view-panel${activeView === "gantt" ? " is-active" : ""}`}
                      aria-hidden={activeView !== "gantt"}
                    >
                      <GanttView
                        scope={activeScope}
                        refreshToken={refreshToken}
                        onRefresh={triggerRefresh}
                        onOpenItem={openTaskEditor}
                      />
                    </section>
                  </div>
                </>
              ) : null}
            </div>
            <RightSheet
              open={sheetOpen && !!activeSessionId}
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
                onDeleted={() => {
                  handleSheetOpenChange(false);
                }}
              />
            </RightSheet>
            <CommandPalette
              open={paletteOpen && !!activeSessionId}
              onOpenChange={setPaletteOpen}
              selectedProjectId={selectedProjectId}
              onCreated={triggerRefresh}
              onOpenProject={handleOpenProjectFromCommand}
              onOpenView={setActiveView}
            />
            <SettingsWindow
              open={settingsOpen && !!activeSessionId}
              onOpenChange={setSettingsOpen}
              onSettingsChanged={triggerRefresh}
              onSeeded={handleSeededProject}
              authMode={authProvider.mode}
              activeSession={activeSession}
              onAuthRefresh={refreshAuth}
              pendingInviteToken={pendingInviteToken}
              onInviteTokenHandled={() => setPendingInviteToken(null)}
            />
          </main>
        </div>
      </div>
    </ScopeProvider>
  );
};

export default App;
