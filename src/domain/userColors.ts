const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

const USER_COLOR_PALETTE = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#0891b2",
  "#7c3aed",
  "#65a30d",
  "#d97706",
  "#0f766e",
  "#c2410c",
];

const hashString = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
};

export const normalizeUserColorMap = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const next: Record<string, string> = {};
  for (const [userId, color] of Object.entries(record)) {
    if (typeof color !== "string") {
      continue;
    }
    const normalized = color.trim();
    if (!HEX_COLOR_RE.test(normalized)) {
      continue;
    }
    next[userId] = normalized;
  }
  return next;
};

export const resolveUserColor = (
  userId: string,
  configured: Record<string, string>
) => {
  const configuredColor = configured[userId];
  if (configuredColor && HEX_COLOR_RE.test(configuredColor)) {
    return configuredColor;
  }
  const hash = hashString(userId);
  return USER_COLOR_PALETTE[hash % USER_COLOR_PALETTE.length];
};
