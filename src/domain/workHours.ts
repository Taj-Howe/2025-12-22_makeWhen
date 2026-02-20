export const DEFAULT_WORKDAY_START_HOUR = 6;
export const DEFAULT_WORKDAY_END_HOUR = 20;

export type WorkdayHours = {
  startHour: number;
  endHour: number;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const clampInt = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.trunc(value)));

export const normalizeWorkdayHours = (
  startRaw: unknown,
  endRaw: unknown
): WorkdayHours => {
  let startHour = isFiniteNumber(startRaw)
    ? clampInt(startRaw, 0, 23)
    : DEFAULT_WORKDAY_START_HOUR;
  let endHour = isFiniteNumber(endRaw)
    ? clampInt(endRaw, 1, 24)
    : DEFAULT_WORKDAY_END_HOUR;

  if (endHour <= startHour) {
    if (startHour >= 23) {
      startHour = 22;
      endHour = 23;
    } else {
      endHour = startHour + 1;
    }
  }

  return { startHour, endHour };
};

export const formatHourLabel = (hour: number) =>
  `${String(hour).padStart(2, "0")}:00`;
