export const formatDate = (value: number | null) =>
  value ? new Date(value).toLocaleString() : "—";

export const shortId = (value: string | null) => {
  if (!value) {
    return "—";
  }
  return value.slice(0, 8);
};

export const truncate = (value: string | null, max = 40) => {
  if (!value) {
    return "—";
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
};

export const toDateTimeLocal = (value: number | null) => {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(value - offset).toISOString().slice(0, 16);
};

export const formatEstimateMinutes = (minutes: number) => {
  if (!Number.isFinite(minutes)) {
    return "0 min";
  }
  const total = Math.max(0, Math.floor(minutes));
  if (total < 60) {
    return `${total} min`;
  }
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return `${hours}:${String(mins).padStart(2, "0")} hrs`;
};

export const parseEstimateMinutesInput = (raw: string): number | null => {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }
  const plain = value.match(/^\d+$/);
  if (plain) {
    return Number(plain[0]);
  }
  const minutesMatch = value.match(/^(\d+)\s*(m|min|mins|minute|minutes)$/);
  if (minutesMatch) {
    return Number(minutesMatch[1]);
  }
  const hoursMatch = value.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)$/);
  if (hoursMatch) {
    return Math.round(Number(hoursMatch[1]) * 60);
  }
  const clockMatch = value.match(
    /^(\d+):(\d{1,2})(\s*(h|hr|hrs|hour|hours))?$/
  );
  if (clockMatch) {
    const hours = Number(clockMatch[1]);
    const minutes = Number(clockMatch[2]);
    if (minutes >= 60) {
      return null;
    }
    return hours * 60 + minutes;
  }
  return null;
};
