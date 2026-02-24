import { ApiError } from "../auth/errors.ts";
import { loadConfig } from "../config.ts";

type RateLimitBucket = {
  windowStartMs: number;
  count: number;
};

class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  consume(key: string, nowMs: number) {
    const existing = this.buckets.get(key);
    if (!existing || nowMs - existing.windowStartMs >= this.windowMs) {
      this.buckets.set(key, { windowStartMs: nowMs, count: 1 });
      return {
        allowed: true,
        remaining: Math.max(0, this.limit - 1),
        retryAfterSeconds: 0,
      };
    }

    if (existing.count >= this.limit) {
      const retryAfterMs = this.windowMs - (nowMs - existing.windowStartMs);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    existing.count += 1;
    this.buckets.set(key, existing);
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - existing.count),
      retryAfterSeconds: 0,
    };
  }
}

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

// Ensure .env values are loaded before reading SYNC_* env vars.
loadConfig();

const RATE_LIMIT_WINDOW_MS = parseNumber(process.env.SYNC_RATE_LIMIT_WINDOW_MS, 60_000);
const IP_RATE_LIMIT = parseNumber(process.env.SYNC_RATE_LIMIT_IP, 180);
const USER_RATE_LIMIT = parseNumber(process.env.SYNC_RATE_LIMIT_USER, 240);
const TEAM_RATE_LIMIT = parseNumber(process.env.SYNC_RATE_LIMIT_TEAM, 320);

const ipLimiter = new FixedWindowRateLimiter(IP_RATE_LIMIT, RATE_LIMIT_WINDOW_MS);
const userLimiter = new FixedWindowRateLimiter(USER_RATE_LIMIT, RATE_LIMIT_WINDOW_MS);
const teamLimiter = new FixedWindowRateLimiter(TEAM_RATE_LIMIT, RATE_LIMIT_WINDOW_MS);

const assertAllowed = (
  allowed: { allowed: boolean; retryAfterSeconds: number },
  scope: "ip" | "user" | "team",
  key: string
) => {
  if (allowed.allowed) {
    return;
  }
  throw new ApiError(
    429,
    "RATE_LIMITED",
    `Rate limit exceeded for ${scope}:${key}. Retry in ${allowed.retryAfterSeconds}s.`
  );
};

export const applyIpRateLimit = (ip: string, route: string) => {
  const key = `${route}:${ip}`;
  const verdict = ipLimiter.consume(key, Date.now());
  assertAllowed(verdict, "ip", key);
};

export const applyUserRateLimit = (userId: string, route: string) => {
  const key = `${route}:${userId}`;
  const verdict = userLimiter.consume(key, Date.now());
  assertAllowed(verdict, "user", key);
};

export const applyTeamRateLimit = (teamId: string, route: string) => {
  const key = `${route}:${teamId}`;
  const verdict = teamLimiter.consume(key, Date.now());
  assertAllowed(verdict, "team", key);
};

export const getRateLimitConfig = () => {
  return {
    window_ms: RATE_LIMIT_WINDOW_MS,
    ip_limit: IP_RATE_LIMIT,
    user_limit: USER_RATE_LIMIT,
    team_limit: TEAM_RATE_LIMIT,
  };
};
