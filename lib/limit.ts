type RateLimitResult = {
  allowed: boolean;
  retryAfterMs: number;
};

type RateLimitOptions = {
  windowMs: number;
  max: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const getStore = (): Map<string, Bucket> => {
  const globalAny = globalThis as typeof globalThis & {
    __makewhenRateLimit?: Map<string, Bucket>;
  };
  if (!globalAny.__makewhenRateLimit) {
    globalAny.__makewhenRateLimit = new Map();
  }
  return globalAny.__makewhenRateLimit;
};

export const checkRateLimit = (
  key: string,
  options: RateLimitOptions
): RateLimitResult => {
  const store = getStore();
  const now = Date.now();
  const bucket = store.get(key);
  if (!bucket || now > bucket.resetAt) {
    store.set(key, { count: 1, resetAt: now + options.windowMs });
    return { allowed: true, retryAfterMs: options.windowMs };
  }
  if (bucket.count >= options.max) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  bucket.count += 1;
  store.set(key, bucket);
  return { allowed: true, retryAfterMs: bucket.resetAt - now };
};
