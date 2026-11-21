import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import {
  createApiKeyAuth,
  createRequireAuth,
  createRequireAuthForMutations,
} from '../src/middlewares/auth.middleware';
import { generateAccessToken, verifyAccessToken } from '../src/utils/jwt';

const fakeRequest = (
  headers: Record<string, string> = {},
  method = 'POST',
): Request => {
  const lowerCased = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    method,
    headers: lowerCased,
    get: (name: string) => lowerCased[name.toLowerCase()],
  } as unknown as Request;
};

const fakeResponse = () => {
  const res = {
    locals: {} as Record<string, unknown>,
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
  };
  return res;
};

const run = (
  middleware: ReturnType<typeof createRequireAuth>,
  req: Request,
) => {
  const res = fakeResponse();
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  middleware(req, res as unknown as Response, next);
  return { res, next };
};

const requireAuth = createRequireAuth({
  trustForwardAuth: false,
  verifyToken: verifyAccessToken,
});
const requireAuthBehindGateway = createRequireAuth({
  trustForwardAuth: true,
  verifyToken: verifyAccessToken,
});

const validToken = () =>
  generateAccessToken({
    sub: 'admin',
    email: 'admin@example.com',
    roles: ['admin'],
  });

describe('requireAuth', () => {
  it('rejects a request without Authorization header', () => {
    const { res, next } = run(requireAuth, fakeRequest());

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body).toMatchObject({ status: 401, success: false });
  });

  it.each([
    ['a non-Bearer scheme', 'Basic YWRtaW46c2VjcmV0'],
    ['an empty Bearer token', 'Bearer '],
    ['a malformed token', 'Bearer not-a-jwt'],
    [
      'a token signed with another secret',
      `Bearer ${jwt.sign({ sub: 'admin' }, 'another-secret')}`,
    ],
    [
      'an expired token',
      `Bearer ${jwt.sign({ sub: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: -10 })}`,
    ],
    [
      'an unsigned token',
      `Bearer ${jwt.sign({ sub: 'admin' }, '', { algorithm: 'none' })}`,
    ],
  ])('rejects %s', (_label, authorization) => {
    const { res, next } = run(requireAuth, fakeRequest({ authorization }));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid access token and exposes the user', () => {
    const { res, next } = run(
      requireAuth,
      fakeRequest({ Authorization: `Bearer ${validToken()}` }),
    );

    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBe(200);
    expect(res.locals.user).toEqual({
      id: 'admin',
      email: 'admin@example.com',
      roles: ['admin'],
      source: 'jwt',
    });
  });

  it('accepts the scheme case-insensitively', () => {
    const { next } = run(
      requireAuth,
      fakeRequest({ authorization: `bearer ${validToken()}` }),
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('ignores X-User-Id unless TRUST_FORWARD_AUTH is enabled', () => {
    const { res, next } = run(
      requireAuth,
      fakeRequest({ 'X-User-Id': 'user-1', 'X-Roles': 'super_admin' }),
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('trusts the gateway headers when TRUST_FORWARD_AUTH is enabled', () => {
    const { res, next } = run(
      requireAuthBehindGateway,
      fakeRequest({
        'X-User-Id': 'user-1',
        'X-Org-Id': 'org-9',
        'X-Roles': 'fleet_manager, viewer',
        // The v2 access token is forwarded too; it is not a legacy token.
        Authorization: 'Bearer v2-token-signed-by-the-auth-service',
      }),
    );

    expect(next).toHaveBeenCalledWith();
    expect(res.locals.user).toEqual({
      id: 'user-1',
      orgId: 'org-9',
      roles: ['fleet_manager', 'viewer'],
      source: 'forward-auth',
    });
  });

  it('still requires a token behind the gateway when X-User-Id is missing or empty', () => {
    const gatewayHeaders: Record<string, string>[] = [
      {},
      { 'X-User-Id': '   ' },
    ];
    for (const headers of gatewayHeaders) {
      const { res, next } = run(requireAuthBehindGateway, fakeRequest(headers));
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    }

    const { next } = run(
      requireAuthBehindGateway,
      fakeRequest({ Authorization: `Bearer ${validToken()}` }),
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('fails closed when the token cannot be verified (e.g. no JWT_SECRET)', () => {
    const failingAuth = createRequireAuth({
      trustForwardAuth: false,
      verifyToken: () => {
        throw new Error('JWT_SECRET is not defined');
      },
    });
    const { res, next } = run(
      failingAuth,
      fakeRequest({ Authorization: `Bearer ${validToken()}` }),
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      message: 'Invalid or expired access token',
    });
  });
});

describe('requireAuthForMutations', () => {
  const auth = vi.fn((_req: Request, _res: Response, next: NextFunction) =>
    next(),
  );
  const guard = createRequireAuthForMutations(auth);

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('authenticates %s', (method) => {
    auth.mockClear();
    const next = vi.fn();
    guard(fakeRequest({}, method), fakeResponse() as unknown as Response, next);
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('leaves %s public', (method) => {
    auth.mockClear();
    const next = vi.fn();
    guard(fakeRequest({}, method), fakeResponse() as unknown as Response, next);
    expect(auth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });
});

describe('createApiKeyAuth (TELEMETRY_API_KEYS)', () => {
  const KEYS = [
    'first-key-0123456789abcdef0123456789',
    'second-key-0123456789abcdef012345',
  ];
  const apiKeyAuth = createApiKeyAuth({
    apiKeys: KEYS,
    role: 'telemetry:ingest',
  });

  it('passes requests without X-API-Key on, unauthenticated', () => {
    const { res, next } = run(apiKeyAuth, fakeRequest());
    expect(next).toHaveBeenCalledWith();
    expect(res.locals.user).toBeUndefined();
  });

  it('authenticates a configured key', () => {
    const { res, next } = run(
      apiKeyAuth,
      fakeRequest({ 'X-API-Key': KEYS[1] }),
    );
    expect(next).toHaveBeenCalledWith();
    expect(res.locals.user).toEqual({
      id: 'api-key-2',
      roles: ['telemetry:ingest'],
      source: 'api-key',
    });
  });

  it.each([
    ['a wrong key', apiKeyAuth, 'wrong-key'],
    ['an empty key', apiKeyAuth, ''],
    [
      'any key when none is configured',
      createApiKeyAuth({ apiKeys: [], role: 'x' }),
      KEYS[0],
    ],
  ])('rejects %s with 401', (_label, middleware, key) => {
    const { res, next } = run(middleware, fakeRequest({ 'X-API-Key': key }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ message: 'Invalid API key' });
  });

  it('lets requireAuthForMutations pass requests it authenticated', () => {
    const auth = vi.fn();
    const guard = createRequireAuthForMutations(auth);
    const res = fakeResponse();
    res.locals.user = { id: 'api-key-1', roles: [], source: 'api-key' };
    const next = vi.fn();

    guard(fakeRequest({}, 'POST'), res as unknown as Response, next);

    expect(auth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });
});
