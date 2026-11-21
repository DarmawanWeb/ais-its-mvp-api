import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import logger from '../src/config/logger';

vi.mock('../src/config/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const STRONG_SECRET = 'prod-jwt-secret-0123456789abcdef0123456789';
const ADMIN_HASH = bcrypt.hashSync('correct-horse', 4);

/** A production configuration without any problem. */
const PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  JWT_SECRET: STRONG_SECRET,
  JWT_EXPIRATION: '1h',
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD_HASH: ADMIN_HASH,
  ALLOWED_ORIGINS: 'https://dashboard.example.com',
  TRUST_PROXY: '1',
  TRUST_FORWARD_AUTH: 'false',
  TELEMETRY_API_KEYS: 'fuel-meter-key-0123456789abcdef0123',
  INGEST_SOCKET_TOKEN: 'ingest-token-0123456789abcdef0123456',
};

/** Reloads the configuration (read once, at import) with `env`. */
const loadWith = async (env: Record<string, string | undefined>) => {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return {
    security: await import('../src/config/security'),
    jwtUtils: await import('../src/utils/jwt'),
    authService: await import('../src/services/auth.service'),
  };
};

const messages = (problems: { level: string; message: string }[]) =>
  problems.map(({ level, message }) => `${level}: ${message}`);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('pre-deploy configuration check', () => {
  it('reports nothing for a complete production configuration', async () => {
    const { security } = await loadWith(PRODUCTION_ENV);
    expect(security.collectDeployProblems()).toEqual([]);
  });

  it('fails a production .env copied from the old .env.example', async () => {
    const { security } = await loadWith({
      ...PRODUCTION_ENV,
      JWT_SECRET: 'your_jwt_secret',
      JWT_EXPIRATION: 'your_jwt_expiration_time',
      ADMIN_EMAIL: undefined,
      ADMIN_PASSWORD_HASH: undefined,
      ALLOWED_ORIGINS: 'http://localhost:3000',
      TRUST_PROXY: 'true',
      TELEMETRY_API_KEYS: undefined,
      INGEST_SOCKET_TOKEN: undefined,
    });

    const problems = messages(security.collectDeployProblems());

    expect(problems).toEqual([
      expect.stringMatching(
        /^error: JWT_SECRET is a placeholder value: login is disabled and Bearer tokens are refused/,
      ),
      expect.stringMatching(
        /^error: JWT_EXPIRATION "your_jwt_expiration_time" is not a valid duration/,
      ),
      expect.stringMatching(/^error: ADMIN_EMAIL \/ ADMIN_PASSWORD_HASH/),
      expect.stringMatching(/^warn: TELEMETRY_API_KEYS is not set/),
      expect.stringMatching(/^warn: TRUST_PROXY=true trusts every/),
      expect.stringMatching(
        /^warn: ALLOWED_ORIGINS is not set or lists only localhost/,
      ),
      expect.stringMatching(/^error: INGEST_SOCKET_TOKEN is not set/),
    ]);
  });

  it('refuses short secrets and keys in production only', async () => {
    const shortValues = {
      JWT_SECRET: 'short-secret',
      TELEMETRY_API_KEYS: 'short-key',
      INGEST_SOCKET_TOKEN: 'short-token',
    };

    const production = await loadWith({ ...PRODUCTION_ENV, ...shortValues });
    expect(messages(production.security.collectDeployProblems())).toEqual([
      expect.stringMatching(/^error: JWT_SECRET is shorter than 32 characters/),
      expect.stringMatching(
        /^error: TELEMETRY_API_KEYS entry 1 is shorter than 32 characters/,
      ),
      expect.stringMatching(/^warn: INGEST_SOCKET_TOKEN is shorter than 32/),
    ]);

    const development = await loadWith({
      ...PRODUCTION_ENV,
      ...shortValues,
      NODE_ENV: 'development',
    });
    expect(messages(development.security.collectDeployProblems())).toEqual([
      expect.stringMatching(
        /^warn: JWT_SECRET is shorter than 32 characters: production refuses it/,
      ),
    ]);
  });

  it('warns about ALLOWED_ORIGINS entries that never match', async () => {
    const { security } = await loadWith({
      ...PRODUCTION_ENV,
      ALLOWED_ORIGINS: 'dashboard.example.com, https://ok.example.com',
    });
    expect(messages(security.collectDeployProblems())).toEqual([
      expect.stringMatching(
        /^warn: ALLOWED_ORIGINS entry "dashboard.example.com" is not an origin/,
      ),
    ]);
  });

  it('logs the problems and the CORS allowlist at startup', async () => {
    const { security } = await loadWith({
      ...PRODUCTION_ENV,
      ALLOWED_ORIGINS: 'https://Dashboard.example.com/',
      TRUST_PROXY: 'true',
    });

    security.logSecurityWarnings();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('TRUST_PROXY=true'),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'CORS: every origin may read; login and writes are accepted from ' +
        'https://dashboard.example.com (ALLOWED_ORIGINS) and from clients without an Origin header.',
    );
  });
});

describe('JWT_SECRET', () => {
  it.each(['production', 'development'])(
    'refuses the .env.example placeholder in %s: no token is issued or accepted',
    async (environment) => {
      const { jwtUtils, authService } = await loadWith({
        ...PRODUCTION_ENV,
        NODE_ENV: environment,
        JWT_SECRET: 'your_jwt_secret',
      });
      const forged = jwt.sign(
        { sub: 'attacker', roles: ['admin'] },
        'your_jwt_secret',
      );

      expect(jwtUtils.isAccessTokenSecretConfigured()).toBe(false);
      expect(jwtUtils.getAccessTokenSecretProblem()).toBe(
        'is a placeholder value',
      );
      expect(() => jwtUtils.verifyAccessToken(forged)).toThrow();
      expect(() => jwtUtils.generateAccessToken({ sub: 'admin' })).toThrow();
      await expect(
        new authService.AuthService().login(
          'admin@example.com',
          'correct-horse',
        ),
      ).rejects.toMatchObject({ statusCode: 503 });
    },
  );

  it('refuses secrets shorter than 32 characters in production only', async () => {
    const production = await loadWith({
      ...PRODUCTION_ENV,
      JWT_SECRET: 'only-20-characters!!',
    });
    expect(production.jwtUtils.isAccessTokenSecretConfigured()).toBe(false);

    const development = await loadWith({
      ...PRODUCTION_ENV,
      NODE_ENV: 'development',
      JWT_SECRET: 'only-20-characters!!',
    });
    expect(development.jwtUtils.isAccessTokenSecretConfigured()).toBe(true);
  });
});

describe('JWT_EXPIRATION', () => {
  const lifetimeOf = (token: string) => {
    const { iat, exp } = jwt.decode(token) as JwtPayload;
    return (exp as number) - (iat as number);
  };

  it.each([
    ['1h', 3600],
    ['30m', 1800],
    ['3600', 3600], // seconds, not jsonwebtoken's milliseconds
  ])('%s gives tokens valid for %i seconds', async (expiration, seconds) => {
    const { jwtUtils } = await loadWith({
      ...PRODUCTION_ENV,
      JWT_EXPIRATION: expiration,
    });
    expect(jwtUtils.isAccessTokenExpirationValid()).toBe(true);
    expect(lifetimeOf(jwtUtils.generateAccessToken({ sub: 'admin' }))).toBe(
      seconds,
    );
  });

  it.each(['your_jwt_expiration_time', '0', '-1h'])(
    'treats %j as invalid: login answers 503 instead of failing with 500',
    async (expiration) => {
      const { jwtUtils, authService } = await loadWith({
        ...PRODUCTION_ENV,
        JWT_EXPIRATION: expiration,
      });
      const service = new authService.AuthService();

      expect(jwtUtils.isAccessTokenExpirationValid()).toBe(false);
      expect(service.isLoginConfigured()).toBe(false);
      await expect(
        service.login('admin@example.com', 'correct-horse'),
      ).rejects.toMatchObject({
        statusCode: 503,
        message: 'Login is not configured on this server',
      });
    },
  );
});
