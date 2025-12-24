import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import "./app.css";
import SidebarProjects from "./SidebarProjects";
import { mutate, query } from "../rpc/clientSingleton";
import { ProjectScopeProvider, useProjectScope } from "./ProjectScopeProvider";
import ProjectListView from "./views/ProjectListView";
import ProjectPlaceholderView from "./views/ProjectPlaceholderView";
import type { QueryFilters, Scope } from "../rpc/types";

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

type ViewKey = "list" | "kanban" | "calendar" | "gantt" | "today";

type ProjectRouteProps = {
  view: ViewKey;
  children: (props: {
    scope: Scope;
    filters: QueryFilters;
    refreshToken: number;
    onRefresh: () => void;
  }) => React.ReactNode;
};

const ProjectRoute: FC<ProjectRouteProps> = ({ view, children }) => {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [projectItems, setProjectItems] = useState<ItemTraits[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const triggerRefresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!projectId) {
      setProjectItems([]);
      setError(null);
      return;
    }
    let isMounted = true;
    setError(null);
    query<{ items: ItemTraits[] }>("listItems", {
      scope: { kind: "project", id: projectId },
      filters: {},
      includeDone: true,
      includeCanceled: true,
      orderBy: "due_at",
      orderDir: "asc",
    })
      .then((data) => {
        if (!isMounted) {
          return;
        }
        setProjectItems(data.items);
      })
      .catch((err) => {
        if (!isMounted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      });
    return () => {
      isMounted = false;
    };
  }, [projectId, refreshToken]);

  const selectedProject = useMemo(
    () => projectItems.find((item) => item.id === projectId) ?? null,
    [projectId, projectItems]
  );

  const handleDeleteProject = useCallback(async () => {
    if (!projectId || !selectedProject) {
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
      await mutate("delete_item", { item_id: projectId });
      navigate("/");
      triggerRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setDeleteError(message);
    }
  }, [navigate, projectId, selectedProject, triggerRefresh]);

  const handleSelectProject = useCallback(
    (nextId: string | null) => {
      if (!nextId) {
        return;
      }
      navigate(`/projects/${nextId}/${view}`);
    },
    [navigate, view]
  );

  return (
    <div className="app-root">
      <div className="layout">
        <SidebarProjects
          selectedProjectId={projectId ?? null}
          onSelect={handleSelectProject}
          refreshToken={refreshToken}
        />
        <main className="main">
          <div className="title-row">
            <h1 className="title">
              {selectedProject ? selectedProject.title : "Select a project"}
            </h1>
            <button
              type="button"
              className="button"
              onClick={handleDeleteProject}
              disabled={!projectId}
            >
              Delete Project
            </button>
          </div>
          {deleteError ? <div className="error">{deleteError}</div> : null}
          {error ? <div className="error">{error}</div> : null}
          {projectId ? (
            <ProjectScopeProvider projectId={projectId}>
              <ProjectScopeConsumer>
                {(value) =>
                  children({
                    scope: value.scope,
                    filters: value.filters,
                    refreshToken,
                    onRefresh: triggerRefresh,
                  })
                }
              </ProjectScopeConsumer>
            </ProjectScopeProvider>
          ) : (
            <div className="list-view">Select a project</div>
          )}
        </main>
      </div>
    </div>
  );
};

const ProjectScopeConsumer: FC<{
  children: (value: { scope: Scope; filters: QueryFilters }) => React.ReactNode;
}> = ({ children }) => {
  const { scope, filters } = useProjectScope();
  return <>{children({ scope, filters })}</>;
};

const App = () => (
  <Routes>
    <Route
      path="/"
      element={
        <ProjectRoute view="list">
          {({ scope, filters, refreshToken, onRefresh }) => (
            <ProjectListView
              scope={scope}
              filters={filters}
              refreshToken={refreshToken}
              onRefresh={onRefresh}
            />
          )}
        </ProjectRoute>
      }
    />
    <Route
      path="/projects/:projectId/list"
      element={
        <ProjectRoute view="list">
          {({ scope, filters, refreshToken, onRefresh }) => (
            <ProjectListView
              scope={scope}
              filters={filters}
              refreshToken={refreshToken}
              onRefresh={onRefresh}
            />
          )}
        </ProjectRoute>
      }
    />
    <Route
      path="/projects/:projectId/kanban"
      element={
        <ProjectRoute view="kanban">
          {({ scope, filters }) => (
            <ProjectPlaceholderView
              scope={scope}
              filters={filters}
              title="Kanban"
            />
          )}
        </ProjectRoute>
      }
    />
    <Route
      path="/projects/:projectId/calendar"
      element={
        <ProjectRoute view="calendar">
          {({ scope, filters }) => (
            <ProjectPlaceholderView
              scope={scope}
              filters={filters}
              title="Calendar"
            />
          )}
        </ProjectRoute>
      }
    />
    <Route
      path="/projects/:projectId/gantt"
      element={
        <ProjectRoute view="gantt">
          {({ scope, filters }) => (
            <ProjectPlaceholderView
              scope={scope}
              filters={filters}
              title="Gantt"
            />
          )}
        </ProjectRoute>
      }
    />
    <Route
      path="/projects/:projectId/today"
      element={
        <ProjectRoute view="today">
          {({ scope, filters }) => (
            <ProjectPlaceholderView
              scope={scope}
              filters={filters}
              title="Today"
            />
          )}
        </ProjectRoute>
      }
    />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
);

export default App;
