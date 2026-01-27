export const deriveEndAtFromDuration = (startAt, durationMinutes) => {
  if (!Number.isFinite(startAt) || !Number.isFinite(durationMinutes)) {
    return null;
  }
  return startAt + durationMinutes * 60000;
};

export const deriveDurationMinutesFromEnd = (startAt, endAt) => {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) {
    return null;
  }
  const minutes = Math.ceil((endAt - startAt) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  return minutes;
};

export const computeSlackMinutes = (dueAt, plannedEnd) => {
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
}) => {
  const lagMs = (Number.isFinite(lagMinutes) ? lagMinutes : 0) * 60000;
  if (!Number.isFinite(lagMs)) {
    return "unknown";
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
