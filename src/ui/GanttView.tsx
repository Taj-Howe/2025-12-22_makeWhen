import type { FC } from "react";
import type { Scope } from "../domain/scope";

type GanttViewProps = {
  scope: Scope;
  refreshToken: number;
  onRefresh: () => void;
  onOpenItem: (itemId: string) => void;
};

const GanttView: FC<GanttViewProps> = ({ scope }) => {
  const label = scope.kind === "user" ? "user" : "project";
  return (
    <div className="view-placeholder">
      Gantt is not available in server mode yet for {label} scope.
    </div>
  );
};

export default GanttView;
