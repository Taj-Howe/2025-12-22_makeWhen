import { useEffect, useMemo, useState, type FC } from "react";
import type { QueryFilters, Scope } from "../../rpc/types";
import { query } from "../../rpc/clientSingleton";
import AddItemForm from "../AddItemForm";
import ListView from "../ListView";
import CommandBar from "../CommandBar";

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
  scheduled_for: number | null;
  scheduled_duration_minutes: number | null;
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

type SortMode = "sequence_rank" | "manual" | "due_at" | "priority";

const ProjectListView: FC<ProjectListViewProps> = ({
  scope,
  filters,
  refreshToken,
  onRefresh,
}) => {
  const [projectItems, setProjectItems] = useState<ItemTraits[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; title: string }>>(
    []
  );
  const [error, setError] = useState<string | null>(null);
  const storageKey = useMemo(() => `makewhen.sortMode.${scope.id}`, [scope.id]);
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    const stored =
      typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null;
    if (
      stored === "sequence_rank" ||
      stored === "manual" ||
      stored === "due_at" ||
      stored === "priority"
    ) {
      return stored;
    }
    return "sequence_rank";
  });

  useEffect(() => {
    const stored =
      typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null;
    if (
      stored === "sequence_rank" ||
      stored === "manual" ||
      stored === "due_at" ||
      stored === "priority"
    ) {
      setSortMode(stored);
    } else {
      setSortMode("sequence_rank");
    }
  }, [storageKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, sortMode);
    } catch {
      // ignore storage failures
    }
  }, [sortMode, storageKey]);

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

  useEffect(() => {
    let isMounted = true;
    query<{ items: ItemTraits[] }>("listItems", {
      includeDone: true,
      includeCanceled: true,
    })
      .then((data) => {
        if (!isMounted) {
          return;
        }
        const list = data.items
          .filter((item) => item.type === "project")
          .map((item) => ({ id: item.id, title: item.title }));
        setProjects(list);
      })
      .catch(() => {
        if (isMounted) {
          setProjects([]);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [refreshToken]);

  return (
    <>
      <div className="sort-row">
        <label>
          Sort mode
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as SortMode)}
          >
            <option value="sequence_rank">sequence_rank</option>
            <option value="manual">manual</option>
            <option value="due_at">due_at</option>
            <option value="priority">priority</option>
          </select>
        </label>
      </div>
      <CommandBar
        scope={scope}
        items={projectItems}
        projects={projects}
        onRefresh={onRefresh}
      />
      <AddItemForm
        selectedProjectId={scope.id}
        items={projectItems}
        onRefresh={onRefresh}
      />
      {error ? <div className="error">{error}</div> : null}
      <ListView
        scope={scope}
        filters={filters}
        sortMode={sortMode}
        refreshToken={refreshToken}
        onRefresh={onRefresh}
      />
    </>
  );
};

export default ProjectListView;
