import type { Request, RequestHandler, Response } from 'express';
import type { JwtPayload } from 'jsonwebtoken';
import config from '../config/config';
import { verifyAccessToken } from '../utils/jwt';
import { describeSecretProblem } from '../utils/secrets';
import { tokensMatch } from './socket-auth.middleware';

/** Stored in `res.locals.user` for authenticated requests. */
export interface AuthenticatedUser {
  id: string;
  email?: string;
  orgId?: string;
  roles: string[];
  /**
   * 'jwt': token from POST /auth/login. 'forward-auth': v2 gateway headers.
   * 'api-key': X-API-Key from TELEMETRY_API_KEYS.
   */
  source: 'jwt' | 'forward-auth' | 'api-key';
}

export interface RequireAuthOptions {
  /**
   * Trust the X-User-Id header set by the v2 gateway forwardAuth. Only safe
   * when the service cannot be reached except through the gateway.
   */
  trustForwardAuth: boolean;
  /** Returns the token payload or throws when the token is invalid. */
  verifyToken: (token: string) => JwtPayload | string;
}

export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

const MAX_FORWARDED_ID_LENGTH = 200;

const sendUnauthorized = (res: Response, message: string): void => {
  res.setHeader('WWW-Authenticate', 'Bearer');
  res.status(401).json({ message, status: 401, success: false });
};

const extractBearerToken = (header: string | undefined): string | null => {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match ? match[1] : null;
};

const readForwardedUser = (req: Request): AuthenticatedUser | null => {
  const id = req.get('x-user-id')?.trim();
  if (!id || id.length > MAX_FORWARDED_ID_LENGTH) return null;
  return {
    id,
    orgId: req.get('x-org-id')?.trim() || undefined,
    roles: (req.get('x-roles') ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter((role) => role.length > 0),
    source: 'forward-auth',
  };
};

const toUser = (payload: JwtPayload): AuthenticatedUser => ({
  id: String(payload.sub ?? ''),
  email: typeof payload.email === 'string' ? payload.email : undefined,
  roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
  source: 'jwt',
});

export const createRequireAuth =
  ({ trustForwardAuth, verifyToken }: RequireAuthOptions): RequestHandler =>
  (req, res, next) => {
    if (trustForwardAuth) {
      const forwardedUser = readForwardedUser(req);
      if (forwardedUser) {
        res.locals.user = forwardedUser;
        next();
        return;
      }
    }

    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      sendUnauthorized(
        res,
        'Authentication required: send "Authorization: Bearer <token>"',
      );
      return;
    }

    let payload: JwtPayload | string;
    try {
      payload = verifyToken(token);
    } catch {
      sendUnauthorized(res, 'Invalid or expired access token');
      return;
    }
    if (typeof payload === 'string') {
      sendUnauthorized(res, 'Invalid or expired access token');
      return;
    }

    res.locals.user = toUser(payload);
    next();
  };

export interface ApiKeyAuthOptions {
  /** Accepted keys. With none, every X-API-Key header is refused. */
  apiKeys: readonly string[];
  /** Role of requests authenticated with a key. */
  role: string;
}

/**
 * Long-lived credentials for machine clients: `X-API-Key: <key>`, the header
 * v2 uses for API keys. Requests without the header are passed on, to the
 * Bearer token check of requireAuthForMutations.
 */
export const createApiKeyAuth =
  ({ apiKeys, role }: ApiKeyAuthOptions): RequestHandler =>
  (req, res, next) => {
    const provided = req.get('x-api-key');
    if (provided === undefined) {
      next();
      return;
    }

    // Every key is compared, so the time taken does not depend on which one matches.
    let matchedKey = -1;
    apiKeys.forEach((key, index) => {
      if (tokensMatch(provided, key)) matchedKey = index;
    });
    if (matchedKey === -1) {
      sendUnauthorized(res, 'Invalid API key');
      return;
    }

    const user: AuthenticatedUser = {
      id: `api-key-${matchedKey + 1}`,
      roles: [role],
      source: 'api-key',
    };
    res.locals.user = user;
    next();
  };

/** The TELEMETRY_API_KEYS that may be used (production refuses short ones). */
export const usableTelemetryApiKeys = config.auth.telemetryApiKeys.filter(
  (key) =>
    describeSecretProblem(key, config.environment === 'production') === null,
);

/** Fuel meters: TELEMETRY_API_KEYS, mounted on the fuel reading routes only. */
export const telemetryApiKeyAuth: RequestHandler = createApiKeyAuth({
  apiKeys: usableTelemetryApiKeys,
  role: 'telemetry:ingest',
});

/** Verifies `Authorization: Bearer <token>` (and gateway headers if trusted). */
export const requireAuth: RequestHandler = createRequireAuth({
  trustForwardAuth: config.auth.trustForwardAuth,
  verifyToken: verifyAccessToken,
});

/**
 * Phase 0 policy: POST, PUT, PATCH and DELETE need authentication; reads stay
 * public so existing dashboards and clients keep working. Requests already
 * authenticated by an earlier middleware (an API key) are passed on.
 */
export const createRequireAuthForMutations =
  (auth: RequestHandler): RequestHandler =>
  (req, res, next) => {
    if (MUTATING_METHODS.has(req.method) && res.locals.user === undefined) {
      auth(req, res, next);
      return;
    }
    next();
  };

export const requireAuthForMutations: RequestHandler =
  createRequireAuthForMutations(requireAuth);
