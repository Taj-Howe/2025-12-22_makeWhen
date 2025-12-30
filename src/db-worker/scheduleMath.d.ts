export type DependencyStatus = "satisfied" | "violated" | "unknown";

export type DependencyStatusInput = {
  predecessorStart: number | null;
  predecessorEnd: number | null;
  successorStart: number | null;
  successorEnd: number | null;
  type: "FS" | "SS" | "FF" | "SF";
  lagMinutes: number;
};

export const deriveEndAtFromDuration: (
  startAt: number,
  durationMinutes: number
) => number | null;

export const deriveDurationMinutesFromEnd: (
  startAt: number,
  endAt: number
) => number | null;

export const computeSlackMinutes: (
  dueAt: number | null,
  plannedEnd: number | null
) => number | null;

export const evaluateDependencyStatus: (
  input: DependencyStatusInput
) => DependencyStatus;
