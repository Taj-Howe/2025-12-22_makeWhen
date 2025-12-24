import { useEffect, useState, type FC } from "react";
import type { QueryFilters, Scope } from "../../rpc/types";
import { query } from "../../rpc/clientSingleton";
import AddItemForm from "../AddItemForm";
import ListView from "../ListView";

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

type ProjectListViewProps = {
  scope: Scope;
  filters: QueryFilters;
  refreshToken: number;
  onRefresh: () => void;
};

const ProjectListView: FC<ProjectListViewProps> = ({
  scope,
  filters,
  refreshToken,
  onRefresh,
}) => {
  const [projectItems, setProjectItems] = useState<ItemTraits[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    setError(null);
    query<{ items: ItemTraits[] }>("listItems", {
      scope,
      filters,
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
  }, [filters, refreshToken, scope]);

  return (
    <>
      <AddItemForm
        selectedProjectId={scope.id}
        items={projectItems}
        onRefresh={onRefresh}
      />
      {error ? <div className="error">{error}</div> : null}
      <ListView
        scope={scope}
        filters={filters}
        refreshToken={refreshToken}
        onRefresh={onRefresh}
      />
    </>
  );
};

export default ProjectListView;
