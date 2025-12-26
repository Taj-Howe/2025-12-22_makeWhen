import { useCallback, useEffect, useState, type FC } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { PlusIcon } from "@radix-ui/react-icons";
import { query } from "../rpc/clientSingleton";
import { UNGROUPED_PROJECT_ID, UNGROUPED_PROJECT_LABEL } from "./constants";
import ThemeSettings from "./ThemeSettings";

type Project = {
  id: string;
  title: string;
  type: "project" | "milestone" | "task";
};

type SidebarProjectsProps = {
  selectedProjectId: string | null;
  onSelect: (projectId: string | null) => void;
  refreshToken: number;
  onAddProject: () => void;
};

const SidebarProjects: FC<SidebarProjectsProps> = ({
  selectedProjectId,
  onSelect,
  refreshToken,
  onAddProject,
}) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setError(null);
    let isMounted = true;
    try {
      const data = await query<{ items: Project[] }>("listItems", {
      includeDone: true,
      includeCanceled: true,
      });
      if (!isMounted) {
        return;
      }
      const list = data.items.filter((item) => item.type === "project");
      setProjects(list);
      if (!selectedProjectId) {
        onSelect(UNGROUPED_PROJECT_ID);
        return;
      }
      if (
        selectedProjectId !== UNGROUPED_PROJECT_ID &&
        !list.some((item) => item.id === selectedProjectId)
      ) {
        onSelect(list[0]?.id ?? UNGROUPED_PROJECT_ID);
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
  }, [onSelect, selectedProjectId]);

  useEffect(() => {
    const cleanup = loadProjects();
    return () => {
      void cleanup;
    };
  }, [loadProjects, refreshToken]);

  return (
    <aside className="sidebar">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className="sidebar-header">
            <div className="sidebar-title">Projects</div>
            <button
              type="button"
              className="icon-button"
              onClick={(event) => {
                event.stopPropagation();
                onAddProject();
              }}
              aria-label="Add project"
              title="Add project"
            >
              <PlusIcon />
            </button>
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
        <button
          key={UNGROUPED_PROJECT_ID}
          className={
            selectedProjectId === UNGROUPED_PROJECT_ID
              ? "sidebar-item is-active"
              : "sidebar-item"
          }
          type="button"
          onClick={() => onSelect(UNGROUPED_PROJECT_ID)}
        >
          {UNGROUPED_PROJECT_LABEL}
        </button>
        {projects.length === 0 ? (
          <div className="sidebar-empty">No projects yet</div>
        ) : (
          projects.map((project) => (
            <button
              key={project.id}
              className={
                project.id === selectedProjectId
                  ? "sidebar-item is-active"
                  : "sidebar-item"
              }
              type="button"
              onClick={() => onSelect(project.id)}
            >
              {project.title}
            </button>
          ))
        )}
      </div>
      <div className="sidebar-footer">
        <ThemeSettings />
      </div>
    </aside>
  );
};

export default SidebarProjects;
