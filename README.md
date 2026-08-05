# token-bucket-rate-limiter

Token-bucket rate limiting for **Node.js, browsers, and edge runtimes** — zero runtime dependencies. Zero-config in-memory backend that Just Works, with an **optional** distributed Upstash Redis backend for multi-instance deployments — plus fetch-friendly helpers for any request framework.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Features

- **Zero-config start** — `checkRateLimit()` works immediately with an in-memory token bucket. No Redis, no env vars, no dependencies.
- **Zero runtime dependencies** — the Upstash packages are *optional peer dependencies*; they are only loaded if you call `configureRedis()`. The in-memory path works in any environment, including browsers.
- **Distributed mode** — one call to `configureRedis()` switches async checks to Upstash Redis (ideal for Vercel, Lambda, K8s).
- **Fail-open by design** — if Redis is unreachable, traffic is never blocked; it degrades to the in-memory bucket.
- **Fetch-friendly** — `withRateLimit()` wraps any `Request`/`Response` handler and emits standard `X-RateLimit-*` + `Retry-After` headers.
- **Per-window limiter caching** — `maxTokens`/`windowMs` parameters are honored in distributed mode (no more "10 per 60s" being silently hardcoded).

## Install

```bash
npm install token-bucket-rate-limiter
```

The Upstash backend is optional — install these only if you use `configureRedis()`:

```bash
npm install @upstash/redis @upstash/ratelimit
```

Requires Node.js 18+ (ESM). Works in any runtime with the fetch API (Node, Deno, Bun, Workers) and in browsers (in-memory mode).

## Usage

### In-memory (no setup)

```ts
import { checkRateLimit } from 'token-bucket-rate-limiter';

// 10 requests per 60s per key — synchronous, no I/O
const { allowed, limit, remaining, resetMs } = checkRateLimit('user:42', 10, 60_000);

if (!allowed) {
  throw new Response('Too many requests', { status: 429 });
}
```

### Distributed (Upstash Redis, optional)

```ts
import { configureRedis, checkRateLimitAsync } from 'token-bucket-rate-limiter';

// Call once at startup (or module scope):
await configureRedis({
  url: process.env.UPSTASH_REDIS_URL!,
  token: process.env.UPSTASH_REDIS_TOKEN!,
});

// In your API route:
const result = await checkRateLimitAsync(`route:${userId}`, 30, 60_000);
if (!result.allowed) {
  // result.resetMs tells you how long to wait
}
```

### Middleware for fetch-style handlers

```ts
import { withRateLimit } from 'token-bucket-rate-limiter';

export const GET = withRateLimit(
  async (request: Request) => {
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  },
  { maxTokens: 30, windowMs: 60_000, keyPrefix: '/api/data' },
);
```

Exceeding the limit returns `429` with `Retry-After` and `X-RateLimit-*` headers. Allowed responses get decorated with the remaining budget.

## API

### `checkRateLimit(key, maxTokens?, windowMs?): RateLimitResult`

Synchronous in-memory token-bucket check. Never throws (fail-open on internal errors).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `key` | `string` | — | Unique client identifier (e.g. `route:userId`, `route:ip`) |
| `maxTokens` | `number` | `10` | Maximum burst capacity |
| `windowMs` | `number` | `60_000` | Refill window in milliseconds |

### `checkRateLimitAsync(key, maxTokens?, windowMs?): Promise<RateLimitResult>`

Async check. Uses the distributed backend when configured, otherwise the in-memory bucket. Fails open if Redis errors.

### `configureRedis(config: { url, token, prefix? }): Promise<void>`

Enables the distributed backend. Loads the Upstash packages lazily and throws if `url` or `token` is missing, or if the optional packages are not installed.

### `addRateLimitHeaders(headers, result): void`

Writes `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` into a `Headers` instance.

### `withRateLimit(handler, options?): ApiHandler`

Wraps a `(request, ...args) => Response` handler. Options: `maxTokens`, `windowMs`, `keyPrefix` (defaults to the request path), or a custom `key(request)` function. Keys are derived from `x-user-id` when present, otherwise `x-forwarded-for`/`x-real-ip`.

## Behavior notes

- **Fail-open**: rate-limit infrastructure errors never block traffic. If you need fail-closed behavior, wrap `checkRateLimitAsync` yourself and handle the error case.
- **Bucket identity**: buckets are keyed by `key` only — the first window configured for a key wins. Use consistent `windowMs` per key (the built-in middleware guarantees this).
- **Memory fallback**: the in-memory bucket is per-process — fine for a single instance, not shared across instances.

## Development

```bash
npm install
npm test        # vitest unit tests
npm run typecheck
npm run build   # emit dist/ + .d.ts
```

## License

MIT © [Navjot Singh](https://github.com/NavjotSingh-ca)
