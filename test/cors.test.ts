import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeOrigin } from '../src/config/config';
import { createCorsPolicy } from '../src/config/cors';

const DASHBOARD = 'https://dashboard.example.com';
const OTHER = 'https://other.example.com';

const fakeRequest = (
  method: string,
  headers: Record<string, string> = {},
): Request => ({ method, headers }) as unknown as Request;

const run = (
  middleware: ReturnType<typeof createCorsPolicy>['rejectDisallowedOrigin'],
  req: Request,
) => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  middleware(req, res as unknown as Response, next);
  return { res, next };
};

const optionsFor = (
  policy: ReturnType<typeof createCorsPolicy>,
  origin: string,
) => {
  let options: Record<string, unknown> = {};
  policy.corsOptions(fakeRequest('GET', { origin }), (_error, value) => {
    options = value as Record<string, unknown>;
  });
  return options;
};

describe('ALLOWED_ORIGINS parsing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [' https://Dashboard.Example.com/ ', DASHBOARD],
    ['HTTPS://DASHBOARD.EXAMPLE.COM', DASHBOARD],
    ['https://dashboard.example.com:443', DASHBOARD],
    ['http://localhost:5173/app/', 'http://localhost:5173'],
    ['*', '*'],
    ['LOCALHOST:5173', 'localhost:5173'], // not an origin: reported at startup
  ])('normalizes %j to %j, as browsers send the Origin', (entry, origin) => {
    expect(normalizeOrigin(entry)).toBe(origin);
  });

  it('defaults to the Vite dev server and `pnpm start` when unset', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', undefined);
    vi.resetModules();
    const config = (await import('../src/config/config')).default;
    expect(config.cors.origin).toEqual([
      'http://localhost:5173',
      'http://localhost:3000',
    ]);
  });
});

describe('createCorsPolicy', () => {
  const policy = createCorsPolicy([DASHBOARD]);

  it('allows requests without Origin and listed origins, ignoring case', () => {
    expect(policy.isRequestOriginAllowed(undefined)).toBe(true);
    expect(policy.isRequestOriginAllowed(DASHBOARD)).toBe(true);
    expect(policy.isRequestOriginAllowed(DASHBOARD.toUpperCase())).toBe(true);
    expect(policy.isRequestOriginAllowed(OTHER)).toBe(false);
  });

  it('lets other origins read, but not write or preflight a write', () => {
    for (const req of [
      fakeRequest('GET', { origin: OTHER }),
      fakeRequest('HEAD', { origin: OTHER }),
      fakeRequest('OPTIONS', {
        origin: OTHER,
        'access-control-request-method': 'GET',
      }),
      fakeRequest('POST'), // servers, devices, curl
      fakeRequest('DELETE', { origin: DASHBOARD }),
    ]) {
      expect(
        run(policy.rejectDisallowedOriginForWrites, req).next,
      ).toHaveBeenCalledWith();
    }

    for (const req of [
      fakeRequest('POST', { origin: OTHER }),
      fakeRequest('PUT', { origin: OTHER }),
      fakeRequest('PATCH', { origin: OTHER }),
      fakeRequest('DELETE', { origin: OTHER }),
      fakeRequest('OPTIONS', {
        origin: OTHER,
        'access-control-request-method': 'delete',
      }),
    ]) {
      const { res, next } = run(policy.rejectDisallowedOriginForWrites, req);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        message: `Origin ${OTHER} is not allowed`,
        status: 403,
        success: false,
      });
    }
  });

  it('sends credentials and the write methods to listed origins only', () => {
    expect(optionsFor(policy, DASHBOARD)).toMatchObject({
      origin: true,
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    });
    expect(optionsFor(policy, OTHER)).toMatchObject({
      origin: true,
      credentials: false,
      methods: ['GET', 'HEAD', 'OPTIONS'],
    });
  });

  it('"*" lets every origin write, still without credentials', () => {
    const anyOrigin = createCorsPolicy(['*']);

    expect(
      run(
        anyOrigin.rejectDisallowedOriginForWrites,
        fakeRequest('POST', { origin: OTHER }),
      ).next,
    ).toHaveBeenCalledWith();
    expect(optionsFor(anyOrigin, OTHER)).toMatchObject({
      credentials: false,
      methods: expect.arrayContaining(['POST', 'DELETE']),
    });
  });

  it('allows no browser writes when ALLOWED_ORIGINS is empty', () => {
    const none = createCorsPolicy([]);
    expect(none.isRequestOriginAllowed(undefined)).toBe(true);
    expect(none.isRequestOriginAllowed(DASHBOARD)).toBe(false);
  });
});
