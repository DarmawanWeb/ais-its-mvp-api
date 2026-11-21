import dotenv from 'dotenv';

dotenv.config();

/** "a, b,,c" -> ['a', 'b', 'c'] */
const parseList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const parsePositiveNumber = (
  value: string | undefined,
  fallback: number,
): number => {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback;
};

/** Used when ALLOWED_ORIGINS is not set: the Vite dev server and `pnpm start`. */
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
];

/**
 * An ALLOWED_ORIGINS entry as browsers send it in the Origin header: lower
 * case, without path, trailing slash or default port. "*" (every origin) and
 * entries that are not http(s) URLs are only lower-cased; the latter never
 * match and are reported at startup.
 */
export const normalizeOrigin = (entry: string): string => {
  const trimmed = entry.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:')
      return url.origin;
  } catch {
    // not a URL
  }
  return trimmed.toLowerCase();
};

/**
 * Value for `app.set('trust proxy', ...)`: unset/"false" -> false, "true" -> true,
 * a number -> number of trusted hops, anything else (e.g. "loopback, 10.0.0.0/8")
 * is passed through.
 */
const parseTrustProxy = (
  value: string | undefined,
): boolean | number | string => {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'false') return false;
  if (trimmed === 'true') return true;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
};

interface Config {
  mongo: {
    username: string;
    password: string;
    dbName: string;
    uri: string;
  };
  server: {
    port: number;
    trustProxy: boolean | number | string;
  };
  cors: {
    origin: string[];
  };
  environment: string;
  jwt: {
    secret: string;
    expiration: string;
  };
  refreshToken: {
    secret: string;
    expiration: string;
  };
  auth: {
    adminEmail: string;
    adminPasswordHash: string;
    /** TELEMETRY_API_KEYS: X-API-Key values accepted on the fuel reading routes. */
    telemetryApiKeys: string[];
    trustForwardAuth: boolean;
    loginRateLimit: {
      windowMs: number;
      max: number;
    };
  };
  websocket: {
    url: string;
    batam_url: string;
    token: string;
    serverPort?: number;
  };
  ingest: {
    socketToken: string;
    rateLimit: {
      messagesPerSecond: number;
      burst: number;
    };
  };
  cii: {
    enabledMmsis: string[];
  };
}

const config: Config = {
  mongo: {
    username: process.env.MONGO_INITDB_ROOT_USERNAME || 'your_mongo_username',
    password: process.env.MONGO_INITDB_ROOT_PASSWORD || 'your_mongo_password',
    dbName: process.env.MONGO_DB_NAME || 'your_db_name',
    uri:
      process.env.MONGO_URI ||
      `mongodb://${
        process.env.MONGO_INITDB_ROOT_USERNAME || 'your_mongo_username'
      }:${
        process.env.MONGO_INITDB_ROOT_PASSWORD || 'your_mongo_password'
      }@localhost:27017/${
        process.env.MONGO_DB_NAME || 'your_db_name'
      }?authSource=admin`,
  },
  cors: {
    // Browser origins allowed to log in and write (every origin may read,
    // see cors.ts), normalized like the Origin header; "*" = every origin.
    origin:
      process.env.ALLOWED_ORIGINS === undefined
        ? DEFAULT_ALLOWED_ORIGINS
        : parseList(process.env.ALLOWED_ORIGINS).map(normalizeOrigin),
  },
  server: {
    port: Number(process.env.PORT) || 3003,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  },
  environment: process.env.NODE_ENV || 'development',
  jwt: {
    // Unused: tokens are signed in src/utils/jwt.ts, which refuses placeholders.
    secret: process.env.JWT_SECRET || '',
    expiration: process.env.JWT_EXPIRATION || '1h',
  },
  refreshToken: {
    secret: process.env.REFRESH_TOKEN_SECRET || 'your_refresh_token_secret',
    expiration: process.env.REFRESH_TOKEN_EXPIRATION || '30d',
  },
  auth: {
    adminEmail: process.env.ADMIN_EMAIL?.trim() || '',
    adminPasswordHash: process.env.ADMIN_PASSWORD_HASH?.trim() || '',
    telemetryApiKeys: parseList(process.env.TELEMETRY_API_KEYS),
    // Only enable behind the v2 gateway: see README "Phase 0 hardening".
    trustForwardAuth: process.env.TRUST_FORWARD_AUTH === 'true',
    loginRateLimit: {
      windowMs: parsePositiveNumber(
        process.env.LOGIN_RATE_LIMIT_WINDOW_MS,
        15 * 60 * 1000,
      ),
      max: parsePositiveNumber(process.env.LOGIN_RATE_LIMIT_MAX, 10),
    },
  },
  websocket: {
    url: process.env.WEBSOCKET_URI || 'http://localhost:8080',
    batam_url: process.env.WEBSOCKET_BATAM_URI || 'http://localhost:8080',
    token: process.env.WEBSOCKET_TOKEN || 'your_websocket_token',
    serverPort: Number(process.env.WEBSOCKET_SERVER_PORT) || 3004,
  },
  ingest: {
    socketToken: process.env.INGEST_SOCKET_TOKEN?.trim() || '',
    rateLimit: {
      messagesPerSecond: parsePositiveNumber(
        process.env.INGEST_SOCKET_RATE_LIMIT,
        100,
      ),
      burst: parsePositiveNumber(process.env.INGEST_SOCKET_RATE_BURST, 200),
    },
  },
  cii: {
    // MMSIs whose CII is recomputed on every accepted AIS position. Empty
    // (the default) keeps the automatic CII update disabled, as before.
    enabledMmsis: parseList(process.env.CII_ENABLED_MMSIS),
  },
};

export default config;
