export const startOfDay = (value: Date) => {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
};

export const addDays = (value: Date, days: number) => {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
};

export const startOfWeek = (value: Date) => {
  const next = startOfDay(value);
  const day = next.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  next.setDate(next.getDate() + diff);
  return next;
};

export const getTodayRange = (now = new Date()) => {
  const start = startOfDay(now);
  return { start, end: addDays(start, 1) };
};

export const getWeekRange = (now = new Date()) => {
  const start = startOfWeek(now);
  return { start, end: addDays(start, 7) };
};
