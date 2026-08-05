/**
 * token-bucket-rate-limiter — token-bucket rate limiting for Node.js and edge runtimes.
 *
 * Two backends:
 *
 * 1. **In-memory token bucket** (default, zero configuration) — synchronous,
 *    per-process. Perfect for single-instance deployments, dev, and tests.
 * 2. **Upstash Redis** (distributed) — configure once with {@link configureRedis}.
 *    Suitable for multi-instance deployments (Vercel, Lambda, K8s) where
 *    per-process buckets would drift out of sync.
 *
 * When Redis is configured, the async checks route to it and fall back to the
 * in-memory bucket if Redis is unreachable (fail-open, so a Redis outage never
 * blocks legitimate traffic).
 *
 * @example
 * import { configureRedis, checkRateLimit } from 'token-bucket-rate-limiter';
 *
 * // In-memory (no setup):
 * const { allowed, remaining, resetMs } = checkRateLimit('user:42', 10, 60_000);
 *
 * // Distributed (call once at startup):
 * configureRedis({ url: process.env.UPSTASH_REDIS_URL, token: process.env.UPSTASH_REDIS_TOKEN });
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

/** The decision returned by every rate-limit check. */
export interface RateLimitResult {
  /** Whether the request is allowed through. */
  allowed: boolean;
  /** Maximum burst capacity of the bucket. */
  limit: number;
  /** Tokens remaining after this check. */
  remaining: number;
  /** Milliseconds until the bucket refills. */
  resetMs: number;
}

/** Configuration for the distributed (Upstash Redis) backend. */
export interface RedisConfig {
  /** Upstash Redis REST URL (e.g. `https://your-region.upstash.io`). */
  url: string;
  /** Upstash Redis REST token. */
  token: string;
  /** Key prefix for Redis entries. Defaults to `rl:`. */
  prefix?: string;
}

const HEADER_LIMIT = 'X-RateLimit-Limit';
const HEADER_REMAINING = 'X-RateLimit-Remaining';
const HEADER_RESET = 'X-RateLimit-Reset';

let redis: Redis | null = null;
const limiterCache = new Map<string, Ratelimit>();

/**
 * Configures the distributed rate-limit backend backed by Upstash Redis.
 *
 * Safe to call more than once (e.g. in tests); each call replaces the
 * previous configuration.
 *
 * @param config - The Redis connection details.
 * @throws {Error} If the URL or token is missing or blank.
 */
export function configureRedis(config: RedisConfig): void {
  if (!config.url || !config.token) {
    throw new Error('configureRedis requires both a url and a token');
  }

  redis = new Redis({ url: config.url, token: config.token });
  limiterCache.clear();
}

/**
 * Creates an Upstash limiter tuned to a specific window and caches it.
 * Limiters are cached per (maxTokens, windowMs) pair so per-request
 * parameters are respected without rebuilding the client every call.
 *
 * Returns null when Redis is not configured (caller falls back to
 * the in-memory bucket).
 */
function getLimiter(maxTokens: number, windowMs: number): Ratelimit | null {
  if (!redis) return null;

  const cacheKey = `${maxTokens}:${windowMs}`;
  const cached = limiterCache.get(cacheKey);
  if (cached) return cached;

  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(maxTokens, `${windowMs} ms`),
    analytics: true,
    prefix: 'rl:',
  });
  limiterCache.set(cacheKey, limiter);
  return limiter;
}

// ─── In-memory token bucket ─────────────────────────────────────────

const memoryBuckets = new Map<string, { tokens: number; resetAt: number }>();

function getMemoryBucket(key: string, maxTokens: number, windowMs: number): {
  tokens: number;
  resetAt: number;
} {
  const now = Date.now();
  const existing = memoryBuckets.get(key);
  if (existing && existing.resetAt > now) {
    return existing;
  }
  const bucket = { tokens: maxTokens, resetAt: now + windowMs };
  memoryBuckets.set(key, bucket);
  return bucket;
}

function checkRateLimitInMemory(
  key: string,
  maxTokens: number,
  windowMs: number,
): RateLimitResult {
  const bucket = getMemoryBucket(key, maxTokens, windowMs);
  const now = Date.now();

  if (bucket.tokens > 0) {
    bucket.tokens -= 1;
    return {
      allowed: true,
      limit: maxTokens,
      remaining: bucket.tokens,
      resetMs: bucket.resetAt - now,
    };
  }

  return {
    allowed: false,
    limit: maxTokens,
    remaining: 0,
    resetMs: bucket.resetAt - now,
  };
}

/**
 * Checks whether the given key has remaining request budget using the
 * in-memory token bucket. Synchronous, no I/O — usable anywhere.
 *
 * @param key - Unique identifier for the client (e.g. `route:userId` or `route:ip`).
 * @param maxTokens - Maximum burst capacity (default 10).
 * @param windowMs - Refill window in milliseconds (default 60s).
 * @returns The rate-limit decision.
 */
export function checkRateLimit(
  key: string,
  maxTokens = 10,
  windowMs = 60_000,
): RateLimitResult {
  try {
    return checkRateLimitInMemory(key, maxTokens, windowMs);
  } catch (error) {
    console.error('[token-bucket-rate-limiter] in-memory check failed:', error);
    // Fail open to avoid blocking legitimate traffic.
    return { allowed: true, limit: maxTokens, remaining: maxTokens - 1, resetMs: windowMs };
  }
}

/**
 * Checks the rate limit using the distributed backend when Redis is
 * configured, falling back to the in-memory bucket otherwise.
 *
 * Use this in API routes and server handlers for multi-instance safety.
 *
 * @param key - Unique identifier for the client (e.g. `route:userId` or `route:ip`).
 * @param maxTokens - Maximum burst capacity (default 10).
 * @param windowMs - Refill window in milliseconds (default 60s).
 * @returns The rate-limit decision.
 */
export async function checkRateLimitAsync(
  key: string,
  maxTokens = 10,
  windowMs = 60_000,
): Promise<RateLimitResult> {
  const limiter = getLimiter(maxTokens, windowMs);

  // Fall back to in-memory when Redis is not configured.
  if (!limiter) {
    return checkRateLimitInMemory(key, maxTokens, windowMs);
  }

  try {
    const result = await limiter.limit(key);
    return {
      allowed: result.success,
      limit: result.limit,
      remaining: result.remaining,
      resetMs: result.reset - Date.now(),
    };
  } catch (error) {
    console.error('[token-bucket-rate-limiter] async check failed:', error);
    // Fail open on Redis errors — an outage must not block traffic.
    return { allowed: true, limit: maxTokens, remaining: maxTokens - 1, resetMs: windowMs };
  }
}

// ─── Fetch-friendly helpers ─────────────────────────────────────────

/**
 * Writes standard rate-limit headers (`X-RateLimit-*`) into a Headers object.
 *
 * @param headers - The Headers instance to mutate.
 * @param result - The decision from {@link checkRateLimit} or {@link checkRateLimitAsync}.
 */
export function addRateLimitHeaders(headers: Headers, result: RateLimitResult): void {
  headers.set(HEADER_LIMIT, String(result.limit));
  headers.set(HEADER_REMAINING, String(result.remaining));
  headers.set(HEADER_RESET, String(Math.ceil(result.resetMs / 1000)));
}

/** Any async request handler compatible with the fetch API. */
export type ApiHandler = (request: Request, ...args: unknown[]) => Promise<Response> | Response;

/**
 * Wraps a fetch-style request handler with rate limiting. Returns a 429
 * response with `Retry-After` and `X-RateLimit-*` headers when the limit
 * is exceeded; otherwise passes the request through and decorates the
 * response with the remaining budget.
 *
 * @param handler - The request handler to wrap.
 * @param options - Rate-limit configuration.
 * @param options.maxTokens - Maximum burst capacity.
 * @param options.windowMs - Refill window in milliseconds.
 * @param options.keyPrefix - Prefix for the rate-limit key (defaults to the request path).
 * @param options.key - Custom key function, overrides `keyPrefix`.
 * @returns A wrapped handler enforcing the rate limit.
 */
export function withRateLimit(
  handler: ApiHandler,
  options: {
    maxTokens?: number;
    windowMs?: number;
    keyPrefix?: string;
    key?: (request: Request) => string;
  } = {},
): ApiHandler {
  return async (request: Request, ...args: unknown[]): Promise<Response> => {
    let key: string;
    if (options.key) {
      key = options.key(request);
    } else {
      const url = new URL(request.url);
      // Prefer an authenticated identity header, fall back to IP.
      const userId = request.headers.get('x-user-id');
      const ip =
        request.headers.get('x-forwarded-for') ||
        request.headers.get('x-real-ip') ||
        'unknown';
      key = `${options.keyPrefix ?? url.pathname}:${userId ?? ip}`;
    }

    const result = await checkRateLimitAsync(key, options.maxTokens, options.windowMs);

    if (!result.allowed) {
      const headers = new Headers();
      addRateLimitHeaders(headers, result);
      headers.set('Retry-After', String(Math.ceil(result.resetMs / 1000)));
      headers.set('Content-Type', 'application/json');
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers,
      });
    }

    const response = await handler(request, ...args);
    const responseHeaders = new Headers(response.headers);
    addRateLimitHeaders(responseHeaders, result);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  };
}
