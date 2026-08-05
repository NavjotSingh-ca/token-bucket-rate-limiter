import { describe, it, expect, vi } from 'vitest';
import {
  checkRateLimit,
  checkRateLimitAsync,
  configureRedis,
  addRateLimitHeaders,
  withRateLimit,
  type RateLimitResult,
} from './index.js';

describe('checkRateLimit (in-memory token bucket)', () => {
  it('allows the first request and reports remaining tokens', () => {
    const result = checkRateLimit('test-initial:1', 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.limit).toBe(5);
    expect(result.resetMs).toBeGreaterThan(0);
  });

  it('enforces the token bucket limit', () => {
    const key = `test-bucket:${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(key, 3, 60_000).allowed).toBe(true);
    }
    const denied = checkRateLimit(key, 3, 60_000);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('resets after the window expires', () => {
    const key = `test-reset:${Date.now()}`;
    for (let i = 0; i < 2; i++) {
      checkRateLimit(key, 2, 50); // 50ms window
    }
    expect(checkRateLimit(key, 2, 50).allowed).toBe(false);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = checkRateLimit(key, 2, 50);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(1);
        resolve();
      }, 60);
    });
  });

  it('uses independent buckets for different keys', () => {
    const key1 = `test-key1:${Date.now()}`;
    const key2 = `test-key2:${Date.now()}`;

    for (let i = 0; i < 2; i++) {
      checkRateLimit(key1, 2, 60_000);
    }
    expect(checkRateLimit(key1, 2, 60_000).allowed).toBe(false);
    expect(checkRateLimit(key2, 2, 60_000).allowed).toBe(true);
  });

  it('defaults to 10 tokens per 60s window', () => {
    const key = `test-defaults:${Date.now()}`;
    const first = checkRateLimit(key);
    expect(first.limit).toBe(10);
    expect(first.allowed).toBe(true);
  });

  it('buckets are keyed by key only — the first window configured for a key wins', () => {
    // This documents the invariant: a key has exactly one bucket. Callers
    // must use consistent window sizes per key (the withRateLimit helper
    // guarantees this by deriving keys from the request).
    const key = `test-windows:${Date.now()}`;
    expect(checkRateLimit(key, 1, 60_000).allowed).toBe(true);
    expect(checkRateLimit(key, 1, 60_000).allowed).toBe(false);
    // A different window size on the same key does not create a new bucket.
    expect(checkRateLimit(key, 1, 30_000).allowed).toBe(false);
  });
});

describe('checkRateLimitAsync (fallback behavior)', () => {
  it('falls back to the in-memory bucket when Redis is not configured', async () => {
    const key = `test-async:${Date.now()}`;
    // maxTokens=2 → calls 1 and 2 are allowed, call 3 is denied.
    const first = await checkRateLimitAsync(key, 2, 60_000);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);

    const second = await checkRateLimitAsync(key, 2, 60_000);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);

    const denied = await checkRateLimitAsync(key, 2, 60_000);
    expect(denied.allowed).toBe(false);
  });

  it('throws when configureRedis is called without credentials', () => {
    expect(() => configureRedis({ url: '', token: 'x' })).toThrow(/url and a token/i);
    expect(() => configureRedis({ url: 'https://x.upstash.io', token: '' })).toThrow(
      /url and a token/i,
    );
  });

  it('fails open when Redis is unreachable (never blocks traffic)', async () => {
    // Operate on a fresh module instance so the dead-Redis config does not
    // leak into the static instance used by the rest of this file.
    vi.resetModules();
    const fresh = await import('./index.js');
    fresh.configureRedis({ url: 'http://127.0.0.1:1', token: 'invalid-token' });
    const key = `test-unreachable:${Date.now()}`;
    const result = await fresh.checkRateLimitAsync(key, 1, 60_000);
    expect(result.allowed).toBe(true);
  });
});

describe('addRateLimitHeaders', () => {
  it('writes limit, remaining, and reset headers', () => {
    const headers = new Headers();
    const result: RateLimitResult = { allowed: true, limit: 10, remaining: 7, resetMs: 30_000 };
    addRateLimitHeaders(headers, result);
    expect(headers.get('X-RateLimit-Limit')).toBe('10');
    expect(headers.get('X-RateLimit-Remaining')).toBe('7');
    expect(headers.get('X-RateLimit-Reset')).toBe('30'); // ceil(30000/1000)
  });
});

describe('withRateLimit', () => {
  it('passes requests through and decorates the response', async () => {
    const handler = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const wrapped = withRateLimit(handler, { maxTokens: 5, windowMs: 60_000 });
    const request = new Request('https://example.com/api/data');
    const response = await wrapped(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('4');
  });

  it('returns 429 with Retry-After when the limit is exhausted', async () => {
    const handler = async () => new Response('ok', { status: 200 });
    // Unique keyPrefix so this test never shares a bucket with other tests.
    const wrapped = withRateLimit(handler, {
      maxTokens: 1,
      windowMs: 60_000,
      keyPrefix: '/api/limited',
    });
    const request = new Request('https://example.com/api/limited');

    const first = await wrapped(request);
    expect(first.status).toBe(200);

    const second = await wrapped(request);
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBeTruthy();
    expect(second.headers.get('X-RateLimit-Remaining')).toBe('0');
    const body = await second.json();
    expect(body.error).toBe('Too many requests');
  });

  it('keys by x-user-id when present, otherwise by IP', async () => {
    const wrapped = withRateLimit(
      async () => new Response('ok', { status: 200 }),
      { maxTokens: 1, windowMs: 60_000, keyPrefix: 'api' },
    );

    const userRequest = new Request('https://example.com/api/data', {
      headers: { 'x-user-id': 'user-1' },
    });
    const secondUserRequest = new Request('https://example.com/api/data', {
      headers: { 'x-user-id': 'user-1' },
    });
    const otherUserRequest = new Request('https://example.com/api/data', {
      headers: { 'x-user-id': 'user-2' },
    });

    expect((await wrapped(userRequest)).status).toBe(200);
    expect((await wrapped(secondUserRequest)).status).toBe(429);
    // A different user has a different bucket.
    expect((await wrapped(otherUserRequest)).status).toBe(200);
  });

  it('supports a custom key function', async () => {
    let capturedKey = '';
    const wrapped = withRateLimit(
      async () => new Response('ok', { status: 200 }),
      {
        maxTokens: 1,
        windowMs: 60_000,
        key: (request) => {
          capturedKey = `custom:${request.headers.get('x-tenant') ?? 'none'}`;
          return capturedKey;
        },
      },
    );

    const request = new Request('https://example.com/api/data', {
      headers: { 'x-tenant': 'acme' },
    });
    expect((await wrapped(request)).status).toBe(200);
    expect(capturedKey).toBe('custom:acme');
  });
});
