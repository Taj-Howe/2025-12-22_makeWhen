import {
  createContext,
  useContext,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from "react";
import type { QueryFilters, Scope } from "../rpc/types";

type ProjectScopeContextValue = {
  scope: Scope;
  filters: QueryFilters;
  setFilters: (next: QueryFilters) => void;
};

const ProjectScopeContext = createContext<ProjectScopeContextValue | null>(null);

export const ProjectScopeProvider: FC<{
  projectId: string;
  children: ReactNode;
}> = ({ projectId, children }) => {
  const [filters, setFilters] = useState<QueryFilters>({});
  const value = useMemo(
    () => ({
      scope: { kind: "project", id: projectId } as Scope,
      filters,
      setFilters,
    }),
    [filters, projectId]
  );

  return (
    <ProjectScopeContext.Provider value={value}>
      {children}
    </ProjectScopeContext.Provider>
  );
};

export const useProjectScope = () => {
  const value = useContext(ProjectScopeContext);
  if (!value) {
    throw new Error("ProjectScopeProvider is missing");
  }
  return value;
};
