import { useCallback, useEffect, useState, type FC } from "react";
import { query } from "../rpc/clientSingleton";

type Project = {
  id: string;
  title: string;
  type: "project" | "milestone" | "task";
};

type SidebarProjectsProps = {
  selectedProjectId: string | null;
  onSelect: (projectId: string | null) => void;
  refreshToken: number;
};

const SidebarProjects: FC<SidebarProjectsProps> = ({
  selectedProjectId,
  onSelect,
  refreshToken,
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
      if (!selectedProjectId && list.length > 0) {
        onSelect(list[0].id);
        return;
      }
      if (selectedProjectId && !list.some((item) => item.id === selectedProjectId)) {
        onSelect(list[0]?.id ?? null);
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
      <div className="sidebar-title">Projects</div>
      <div className="sidebar-list">
        {error ? <div className="error">{error}</div> : null}
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
    </aside>
  );
};

export default SidebarProjects;
