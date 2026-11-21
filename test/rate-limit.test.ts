import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../src/middlewares/rate-limit.middleware';

const WINDOW_MS = 60_000;

const setup = (options: { max: number; maxTrackedClients?: number }) => {
  let currentTime = 0;
  const limiter = createRateLimiter({
    windowMs: WINDOW_MS,
    now: () => currentTime,
    ...options,
  });
  /** Status of one request from `ip`: 200 when it is let through. */
  const request = (ip: string): number => {
    const res = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) {
        res.headers[name] = value;
      },
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json: vi.fn(),
    };
    let passed = false;
    limiter({ ip } as Request, res as unknown as Response, () => {
      passed = true;
    });
    return passed ? 200 : res.statusCode;
  };
  return {
    request,
    advance: (ms: number) => {
      currentTime += ms;
    },
  };
};

describe('createRateLimiter', () => {
  it('allows `max` requests per client and window, then answers 429', () => {
    const { request, advance } = setup({ max: 2 });

    expect([request('a'), request('a'), request('a')]).toEqual([200, 200, 429]);
    expect(request('b')).toBe(200); // per client

    advance(WINDOW_MS);
    expect(request('a')).toBe(200); // a new window
  });

  it('tracks at most maxTrackedClients clients, forgetting the oldest first', () => {
    const { request } = setup({ max: 1, maxTrackedClients: 2 });

    expect([request('a'), request('b'), request('a')]).toEqual([200, 200, 429]);
    // "c" makes three clients: "a", whose window started first, is forgotten.
    expect(request('c')).toBe(200);
    expect(request('b')).toBe(429);
    expect(request('a')).toBe(200); // starts over; now "b" is forgotten
    expect(request('c')).toBe(429);
  });
});
