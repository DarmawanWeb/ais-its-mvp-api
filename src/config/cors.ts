import type { CorsOptionsDelegate } from 'cors';
import type { Request, RequestHandler } from 'express';
import config from './config';
import { MUTATING_METHODS } from '../middlewares/auth.middleware';

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** The method of a request; for a CORS preflight, the method it asks for. */
const requestedMethod = (req: Pick<Request, 'method' | 'headers'>): string => {
  const preflighted =
    req.method === 'OPTIONS'
      ? req.headers['access-control-request-method']
      : undefined;
  return (preflighted || req.method).toUpperCase();
};

export interface CorsPolicy {
  /** No Origin header, "*" in the list, or a listed origin. */
  isRequestOriginAllowed: (origin: string | undefined) => boolean;
  /** 403 for browsers on origins that are not allowed. */
  rejectDisallowedOrigin: RequestHandler;
  /** rejectDisallowedOrigin, for POST/PUT/PATCH/DELETE and their preflights. */
  rejectDisallowedOriginForWrites: RequestHandler;
  corsOptions: CorsOptionsDelegate<Request>;
}

/**
 * Browser access for the origins of ALLOWED_ORIGINS (normalized by
 * config.ts; "*" = every origin):
 * - every origin may read (GET, HEAD), without credentials, as before
 *   phase 0 (`origin: '*'`): the dashboards keep working wherever they run;
 * - logging in, writes (POST, PUT, PATCH, DELETE) and authenticated reads
 *   need an allowed origin, other origins get 403;
 * - requests without an Origin header (servers, devices, curl, health
 *   checks) are not affected.
 */
export const createCorsPolicy = (
  allowedOrigins: readonly string[],
): CorsPolicy => {
  const anyOrigin = allowedOrigins.includes('*');
  const listedOrigins = new Set(
    allowedOrigins.filter((origin) => origin !== '*'),
  );
  const isListed = (origin: string | undefined): boolean =>
    origin !== undefined && listedOrigins.has(origin.toLowerCase());

  const isRequestOriginAllowed = (origin: string | undefined): boolean =>
    origin === undefined || anyOrigin || isListed(origin);

  const rejectDisallowedOrigin: RequestHandler = (req, res, next) => {
    const { origin } = req.headers;
    if (isRequestOriginAllowed(origin)) {
      next();
      return;
    }
    res.status(403).json({
      message: `Origin ${origin} is not allowed`,
      status: 403,
      success: false,
    });
  };

  // Rejected before a route runs: without this, "simple" cross-site
  // requests would still be executed even though the browser hides the
  // response.
  const rejectDisallowedOriginForWrites: RequestHandler = (req, res, next) => {
    if (MUTATING_METHODS.has(requestedMethod(req))) {
      rejectDisallowedOrigin(req, res, next);
      return;
    }
    next();
  };

  const corsOptions: CorsOptionsDelegate<Request> = (req, callback) => {
    const { origin } = req.headers;
    callback(null, {
      // Reflects the origin. Writes from other origins never get here.
      origin: true,
      methods: isRequestOriginAllowed(origin) ? ALL_METHODS : READ_METHODS,
      allowedHeaders: ['Content-Type', 'Authorization'],
      // Only for explicitly listed origins, never for "*" or other origins.
      credentials: isListed(origin),
      // Lets browsers cache preflights (sent once a token is attached) for 10 min.
      maxAge: 600,
    });
  };

  return {
    isRequestOriginAllowed,
    rejectDisallowedOrigin,
    rejectDisallowedOriginForWrites,
    corsOptions,
  };
};

const policy = createCorsPolicy(config.cors.origin);

export const {
  isRequestOriginAllowed,
  rejectDisallowedOrigin,
  rejectDisallowedOriginForWrites,
} = policy;

export default policy.corsOptions;
