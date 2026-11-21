import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Router } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import v1Routes from '../src/routes/v1/index';
import authRoutes from '../src/routes/v1/auth.routes';
import { Port } from '../src/models/Port';
import { AnnualCIIRepository } from '../src/repositories/cii/annualcii.repository';
import { DailyCIIRepository } from '../src/repositories/cii/dailycii.repository';
import { ZValueRepository } from '../src/repositories/cii/zvalue.repository';
import { ShipRepository } from '../src/repositories/ships/ships.repository';
import type { IShipData } from '../src/types/ship.type';
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ALLOWED_ORIGIN,
} from './test-env';

/** Every POST/PUT/PATCH/DELETE route of /api/v1 (path parameters filled in). */
const MUTATING_ROUTES: [string, string][] = [
  ['POST', '/port'],
  ['PUT', '/port/id'],
  ['DELETE', '/port/id'],
  ['POST', '/telemetry'],
  ['PUT', '/telemetry/123456789'],
  ['DELETE', '/telemetry/123456789'],
  ['POST', '/telemetry/123456789/fuel'],
  ['POST', '/cii/annual'],
  ['PUT', '/cii/annual/123456789/year/2025'],
  ['DELETE', '/cii/annual/123456789'],
  ['POST', '/cii/daily'],
  ['DELETE', '/cii/daily/123456789'],
  ['POST', '/cii/zvalue'],
  ['PUT', '/cii/zvalue/id'],
  ['DELETE', '/cii/zvalue/id'],
  ...['general', 'size', 'fuel', 'type', 'auxengine', 'mainengine'].flatMap(
    (resource): [string, string][] => [
      ['POST', `/ships/${resource}`],
      ['PUT', `/ships/${resource}/id`],
      ['DELETE', `/ships/${resource}/id`],
    ],
  ),
  ['POST', '/ships/firstformula'],
  ['PUT', '/ships/firstformula/id'],
  ['DELETE', '/ships/firstformula/id'],
  ['POST', '/ships/data'],
  ['PUT', '/ships/data/id'],
  ['DELETE', '/ships/data/id'],
  ['POST', '/ships/fuel-data'],
  ['DELETE', '/ships/fuel-data/123456789'],
];

const countMutatingHandlers = (router: Router): number =>
  router.stack.reduce((count, layer) => {
    if (layer.route) {
      const methods = Object.keys(
        (layer.route as unknown as { methods: Record<string, boolean> })
          .methods,
      );
      return (
        count +
        methods.filter((method) =>
          ['post', 'put', 'patch', 'delete'].includes(method),
        ).length
      );
    }
    const nested = layer.handle as unknown as Partial<Router>;
    return nested.stack
      ? count + countMutatingHandlers(nested as Router)
      : count;
  }, 0);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

const call = (
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

const login = (email: string, password: string) =>
  call('POST', '/api/v1/auth/login', { body: { email, password } });

describe('authentication of /api/v1', () => {
  it('the route table above lists every mutating route (41)', () => {
    expect(MUTATING_ROUTES).toHaveLength(41);
    expect(
      countMutatingHandlers(v1Routes) - countMutatingHandlers(authRoutes),
    ).toBe(MUTATING_ROUTES.length);
  });

  it.each(MUTATING_ROUTES)(
    '%s %s answers 401 without a token',
    async (method, path) => {
      const response = await call(method, `/api/v1${path}`, { body: {} });

      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      await expect(response.json()).resolves.toMatchObject({
        status: 401,
        success: false,
      });
    },
  );

  it('rejects an invalid token', async () => {
    const response = await call('POST', '/api/v1/port', {
      token: 'not-a-valid-token',
      body: {},
    });
    expect(response.status).toBe(401);
  });

  it('keeps GET / and read endpoints public', async () => {
    vi.spyOn(Port, 'find').mockResolvedValue([] as never);

    expect((await call('GET', '/')).status).toBe(200);
    const response = await call('GET', '/api/v1/port');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [] });
  });

  it('protects GET /cii/data/:mmsi, which writes a new daily CII', async () => {
    expect((await call('GET', '/api/v1/cii/data/123456789')).status).toBe(401);
  });

  describe('POST /api/v1/auth/login', () => {
    it('validates the body with the existing loginValidation', async () => {
      const response = await login('not-an-email', '123');

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(
        body.errors.map((error: { field: string }) => error.field),
      ).toEqual(['email', 'password']);
      expect(JSON.stringify(body)).not.toContain('123');
    });

    it('rejects a wrong password or an unknown email', async () => {
      for (const response of [
        await login(TEST_ADMIN_EMAIL, 'wrong-password'),
        await login('someone@example.com', TEST_ADMIN_PASSWORD),
      ]) {
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({
          message: 'Invalid email or password',
        });
      }
    });

    it('issues a token that unlocks the mutating routes', async () => {
      // Normalized like the submitted email (case is ignored).
      const response = await login('Admin@Example.com', TEST_ADMIN_PASSWORD);
      expect(response.status).toBe(200);
      const { data } = await response.json();
      expect(data).toMatchObject({ tokenType: 'Bearer', expiresIn: '1h' });

      const save = vi
        .spyOn(Port.prototype, 'save')
        .mockImplementation(async function (this: unknown) {
          return this;
        } as never);
      const created = await call('POST', '/api/v1/port', {
        token: data.accessToken,
        body: {
          name: 'Tanjung Perak',
          code: 'IDSUB',
          administrativeLocation: 'Surabaya',
          location: { latitude: -7.2, longitude: 112.73 },
        },
      });

      expect(created.status).toBe(201);
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('is rate limited per client (LOGIN_RATE_LIMIT_MAX=5 in tests)', async () => {
      let response = await login(TEST_ADMIN_EMAIL, 'wrong-password');
      for (
        let attempt = 0;
        attempt < 10 && response.status !== 429;
        attempt++
      ) {
        response = await login(TEST_ADMIN_EMAIL, 'wrong-password');
      }

      expect(response.status).toBe(429);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    });
  });
});

describe('CORS', () => {
  it('answers 403 to browsers from origins outside ALLOWED_ORIGINS', async () => {
    const response = await call('GET', '/', {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows the configured origin, including PATCH preflights', async () => {
    const simple = await call('GET', '/', {
      headers: { origin: TEST_ALLOWED_ORIGIN },
    });
    expect(simple.status).toBe(200);
    expect(simple.headers.get('access-control-allow-origin')).toBe(
      TEST_ALLOWED_ORIGIN,
    );
    expect(simple.headers.get('access-control-allow-credentials')).toBe('true');

    const preflight = await call('OPTIONS', '/api/v1/port/id', {
      headers: {
        origin: TEST_ALLOWED_ORIGIN,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain(
      'PATCH',
    );
    expect(preflight.headers.get('access-control-allow-headers')).toContain(
      'Authorization',
    );
  });
});

describe('CII not available', () => {
  const expectCIINotAvailable = async (response: Response) => {
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: 'CII_NOT_AVAILABLE',
      status: 404,
      success: false,
    });
  };

  it('daily, latest and attained answer 404 instead of empty or fabricated data', async () => {
    vi.spyOn(DailyCIIRepository.prototype, 'getByMmsi').mockResolvedValue(null);
    vi.spyOn(DailyCIIRepository.prototype, 'getLatestByMmsi').mockResolvedValue(
      null,
    );
    vi.spyOn(ShipRepository.prototype, 'getShipTypeByMmsi').mockResolvedValue(
      null,
    );

    await expectCIINotAvailable(
      await call('GET', '/api/v1/cii/daily/123456789'),
    );
    await expectCIINotAvailable(
      await call('GET', '/api/v1/cii/daily/123456789/latest'),
    );
    await expectCIINotAvailable(
      await call('GET', '/api/v1/cii/daily/123456789/attained'),
    );
  });

  it('SEEMP answers 404 when the ship has no CII yet', async () => {
    vi.spyOn(AnnualCIIRepository.prototype, 'getByMmsi').mockResolvedValue(
      null,
    );
    vi.spyOn(DailyCIIRepository.prototype, 'getLatestByMmsi').mockResolvedValue(
      null,
    );
    vi.spyOn(ShipRepository.prototype, 'getByMMSI').mockResolvedValue({
      mmsi: '123456789',
    } as IShipData);
    vi.spyOn(ZValueRepository.prototype, 'getHighestYear').mockResolvedValue(
      2030,
    );

    await expectCIINotAvailable(await call('GET', '/api/v1/seemp/123456789'));
  });
});
