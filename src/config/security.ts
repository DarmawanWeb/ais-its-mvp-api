import config from './config';
import logger from './logger';
import {
  getAccessTokenSecretProblem,
  isAccessTokenExpirationValid,
} from '../utils/jwt';
import {
  describeSecretProblem,
  MIN_PRODUCTION_SECRET_LENGTH,
} from '../utils/secrets';

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const ORIGIN = /^https?:\/\/[^/]+$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface ConfigProblem {
  /** 'error': a phase 0 feature is disabled (login, writes, ingest). */
  level: 'error' | 'warn';
  message: string;
}

const isLocalOrigin = (origin: string): boolean => {
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
};

/**
 * Security-relevant configuration problems. Logged at startup and checked
 * before a deploy by `pnpm check:env` (bin/check-env.ts).
 */
export const collectConfigProblems = (): ConfigProblem[] => {
  const isProduction = config.environment === 'production';
  const problems: ConfigProblem[] = [];
  const report = (level: ConfigProblem['level'], message: string) =>
    problems.push({ level, message });

  const secretProblem = getAccessTokenSecretProblem();
  if (secretProblem) {
    report(
      'error',
      `JWT_SECRET ${secretProblem}: login is disabled and Bearer tokens are refused. ` +
        `Use at least ${MIN_PRODUCTION_SECRET_LENGTH} random characters, e.g. from: openssl rand -hex 32`,
    );
  } else if ((process.env.JWT_SECRET ?? '').length < MIN_PRODUCTION_SECRET_LENGTH) {
    report(
      'warn',
      `JWT_SECRET is shorter than ${MIN_PRODUCTION_SECRET_LENGTH} characters: production refuses it.`,
    );
  }

  if (!isAccessTokenExpirationValid()) {
    report(
      'error',
      `JWT_EXPIRATION "${process.env.JWT_EXPIRATION}" is not a valid duration ` +
        '(e.g. 1h, 30m or a number of seconds): login is disabled.',
    );
  }

  if (!config.auth.adminEmail || !config.auth.adminPasswordHash) {
    report(
      isProduction ? 'error' : 'warn',
      'ADMIN_EMAIL / ADMIN_PASSWORD_HASH are not set: POST /api/v1/auth/login is disabled.',
    );
  } else if (!BCRYPT_HASH.test(config.auth.adminPasswordHash)) {
    report(
      'error',
      'ADMIN_PASSWORD_HASH is not a bcrypt hash: login always fails. ' +
        "Generate one with: pnpm exec bcrypt '<password>' 12",
    );
  }

  config.auth.telemetryApiKeys.forEach((key, index) => {
    const keyProblem = describeSecretProblem(key, isProduction);
    if (keyProblem) {
      report(
        'error',
        `TELEMETRY_API_KEYS entry ${index + 1} ${keyProblem}: it is refused.`,
      );
    }
  });

  if (config.auth.trustForwardAuth) {
    report(
      'warn',
      'TRUST_FORWARD_AUTH=true: requests carrying X-User-Id are treated as authenticated. ' +
        'This service must only be reachable through the v2 gateway.',
    );
  }

  if (config.server.trustProxy === true) {
    report(
      'warn',
      'TRUST_PROXY=true trusts every X-Forwarded-For entry, so clients choose their own IP ' +
        'and bypass the login rate limit. Set the number of proxies in front (e.g. 1) or their addresses.',
    );
  }

  const origins = config.cors.origin;
  for (const origin of origins) {
    if (origin !== '*' && !ORIGIN.test(origin)) {
      report(
        'warn',
        `ALLOWED_ORIGINS entry "${origin}" is not an origin such as https://dashboard.example.com: it never matches.`,
      );
    }
  }
  if (origins.includes('*') && config.auth.trustForwardAuth) {
    report(
      'warn',
      'ALLOWED_ORIGINS=* with TRUST_FORWARD_AUTH=true: pages on any site can send writes through the gateway.',
    );
  }
  if (isProduction && !origins.includes('*') && origins.every(isLocalOrigin)) {
    report(
      'warn',
      'ALLOWED_ORIGINS is not set or lists only localhost: browsers can read from any origin, ' +
        'but logging in and writes from the dashboards are refused (403).',
    );
  }

  return problems;
};

/** Logs the configuration problems and the CORS allowlist once, at startup. */
export const logSecurityWarnings = (): void => {
  for (const { level, message } of collectConfigProblems()) {
    logger[level](message);
  }
  logger.info(
    `CORS: every origin may read; login and writes are accepted from ${
      config.cors.origin.includes('*')
        ? 'every origin'
        : config.cors.origin.join(', ') || 'no browser origin'
    } (ALLOWED_ORIGINS) and from clients without an Origin header.`,
  );
};
