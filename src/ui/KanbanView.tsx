import type { FC } from "react";
import type { Scope } from "../domain/scope";

type KanbanViewProps = {
  scope: Scope;
  refreshToken: number;
  onRefresh: () => void;
  onOpenItem: (itemId: string) => void;
};

const KanbanView: FC<KanbanViewProps> = ({ scope }) => {
  const label = scope.kind === "user" ? "user" : "project";
  return (
    <div className="view-placeholder">
      Kanban is not available in server mode yet for {label} scope.
    </div>
  );
};

export default KanbanView;
