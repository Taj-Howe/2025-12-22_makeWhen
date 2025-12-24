import type { FC } from "react";
import type { QueryFilters, Scope } from "../../rpc/types";

type ProjectPlaceholderViewProps = {
  scope: Scope;
  filters: QueryFilters;
  title: string;
};

const ProjectPlaceholderView: FC<ProjectPlaceholderViewProps> = ({ title }) => (
  <div className="list-view">
    <div className="list-empty">{title} view (not implemented yet)</div>
  </div>
);

export default ProjectPlaceholderView;
