import { useCallback, useEffect, useState, type FC } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { PlusIcon } from "@radix-ui/react-icons";
import { serverQuery } from "./serverApi";
import { UNGROUPED_PROJECT_ID, UNGROUPED_PROJECT_LABEL } from "./constants";
import type { Scope } from "../domain/scope";
import { AppButton, AppIconButton } from "./controls";
type Project = {
  id: string;
  title: string;
};

type UserLite = {
  user_id: string;
  display_name: string;
};

type SidebarProjectsProps = {
  scope: Scope;
  selectedProjectId: string | null;
  onSelect: (projectId: string | null) => void;
  onSetProjectId: (projectId: string | null) => void;
  refreshToken: number;
  onAddProject: () => void;
  onDeleteProject: (projectId: string, projectTitle: string) => void;
  collaborators: UserLite[];
  collaboratorsError: string | null;
  selectedUserId: string | null;
  onSelectUser: (userId: string) => void;
};

const SidebarProjects: FC<SidebarProjectsProps> = ({
  scope,
  selectedProjectId,
  onSelect,
  onSetProjectId,
  refreshToken,
  onAddProject,
  onDeleteProject,
  collaborators,
  collaboratorsError,
  selectedUserId,
  onSelectUser,
}) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setError(null);
    let isMounted = true;
    try {
      const data = await serverQuery<{ projects: Project[] }>(
        "projects_list",
        {}
      );
      if (!isMounted) {
        return;
      }
      const list = data.projects;
      setProjects(list);
      if (!selectedProjectId || !list.some((item) => item.id === selectedProjectId)) {
        const fallback = list[0]?.id ?? null;
        if (scope.kind === "project") {
          onSelect(fallback);
        } else {
          onSetProjectId(fallback);
        }
      }
    } catch (err) {
      if (isMounted) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        setProjects([]);
      }
    }
    return () => {
      isMounted = false;
    };
  }, [onSelect, onSetProjectId, scope.kind, selectedProjectId]);

  useEffect(() => {
    const cleanup = loadProjects();
    return () => {
      void cleanup;
    };
  }, [loadProjects, refreshToken]);

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <div className="sidebar-header">
              <div className="sidebar-title">Projects</div>
              <AppIconButton
                type="button"
                variant="ghost"
                className="icon-button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAddProject();
                }}
                aria-label="Add project"
                title="Add project"
              >
                <PlusIcon />
              </AppIconButton>
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content className="context-menu-content">
              <ContextMenu.Item
                className="context-menu-item"
                onSelect={onAddProject}
              >
                New project…
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
        <div className="sidebar-list">
          {error ? <div className="error">{error}</div> : null}
          {projects.length === 0 ? (
            <AppButton
              key={UNGROUPED_PROJECT_ID}
              className="sidebar-item is-active"
              type="button"
              variant="ghost"
              onClick={() => onSelect(UNGROUPED_PROJECT_ID)}
            >
              {UNGROUPED_PROJECT_LABEL}
            </AppButton>
          ) : null}
          {projects.length === 0 ? (
            <div className="sidebar-empty">No projects yet</div>
          ) : (
            projects.map((project) => (
              <ContextMenu.Root key={project.id}>
                <ContextMenu.Trigger asChild>
                  <AppButton
                    className={
                      scope.kind === "project" &&
                      project.id === selectedProjectId
                        ? "sidebar-item is-active"
                        : "sidebar-item"
                    }
                    type="button"
                    variant="ghost"
                    onClick={() => onSelect(project.id)}
                  >
                    {project.title}
                  </AppButton>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content className="context-menu-content">
                    <ContextMenu.Item
                      className="context-menu-item"
                      onSelect={() =>
                        onDeleteProject(project.id, project.title)
                      }
                    >
                      Delete project…
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            ))
          )}
        </div>
      </div>
      <div className="sidebar-section">
        <div className="sidebar-title">Collaborators</div>
        <div className="sidebar-list">
          {collaboratorsError ? (
            <div className="error">{collaboratorsError}</div>
          ) : null}
          {collaborators.length === 0 ? (
            <div className="sidebar-empty">No collaborators yet</div>
          ) : (
            collaborators.map((user) => (
              <AppButton
                key={user.user_id}
                className={
                  scope.kind === "user" &&
                  user.user_id === selectedUserId
                    ? "sidebar-item is-active"
                    : "sidebar-item"
                }
                type="button"
                variant="ghost"
                onClick={() => onSelectUser(user.user_id)}
              >
                {user.display_name}
              </AppButton>
            ))
          )}
        </div>
      </div>
    </aside>
  );
};

export default SidebarProjects;
