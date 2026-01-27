export type DependencyType = "FS" | "SS" | "FF" | "SF";

export const deriveEndAtFromDuration = (
  startAt: number | null,
  durationMinutes: number | null
) => {
  if (!Number.isFinite(startAt) || !Number.isFinite(durationMinutes)) {
    return null;
  }
  return startAt + durationMinutes * 60000;
};

export const computeSlackMinutes = (
  dueAt: number | null,
  plannedEnd: number | null
) => {
  if (!Number.isFinite(dueAt) || !Number.isFinite(plannedEnd)) {
    return null;
  }
  return Math.round((dueAt - plannedEnd) / 60000);
};

export const evaluateDependencyStatus = ({
  predecessorStart,
  predecessorEnd,
  successorStart,
  successorEnd,
  type,
  lagMinutes,
}: {
  predecessorStart: number | null;
  predecessorEnd: number | null;
  successorStart: number | null;
  successorEnd: number | null;
  type: DependencyType;
  lagMinutes: number;
}) => {
  const lagMs = (Number.isFinite(lagMinutes) ? lagMinutes : 0) * 60000;
  if (!Number.isFinite(lagMs)) {
    return "unknown" as const;
  }
  const predStart = Number.isFinite(predecessorStart) ? predecessorStart : null;
  const predEnd = Number.isFinite(predecessorEnd) ? predecessorEnd : null;
  const succStart = Number.isFinite(successorStart) ? successorStart : null;
  const succEnd = Number.isFinite(successorEnd) ? successorEnd : null;
  switch (type) {
    case "FS":
      if (predEnd === null || succStart === null) return "unknown";
      return succStart >= predEnd + lagMs ? "satisfied" : "violated";
    case "SS":
      if (predStart === null || succStart === null) return "unknown";
      return succStart >= predStart + lagMs ? "satisfied" : "violated";
    case "FF":
      if (predEnd === null || succEnd === null) return "unknown";
      return succEnd >= predEnd + lagMs ? "satisfied" : "violated";
    case "SF":
      if (predStart === null || succEnd === null) return "unknown";
      return succEnd >= predStart + lagMs ? "satisfied" : "violated";
    default:
      return "unknown";
  }
};
