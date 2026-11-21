import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'socket.io';

type Handshake = Pick<Socket['handshake'], 'auth' | 'headers'>;
type SocketMiddleware = (
  socket: Pick<Socket, 'id' | 'handshake'>,
  next: (err?: Error) => void,
) => void;

export interface IngestSocketAuthOptions {
  /** INGEST_SOCKET_TOKEN; empty when not configured. */
  expectedToken: string;
  isProduction: boolean;
  logger: { warn: (message: string) => void; error: (message: string) => void };
}

/**
 * The token of an ingest client: `io(url, { auth: { token } })`, or an
 * `Authorization: Bearer <token>` header (a bare token is accepted as well).
 */
export const extractSocketToken = (handshake: Handshake): string | null => {
  const authToken: unknown = handshake.auth?.token;
  if (typeof authToken === 'string' && authToken.length > 0) return authToken;

  const header = handshake.headers.authorization;
  if (typeof header !== 'string') return null;
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return token.length > 0 ? token : null;
};

/**
 * Constant-time comparison. Both values are hashed first, so the comparison
 * takes the same time whatever their lengths.
 */
export const tokensMatch = (provided: string, expected: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(provided).digest(),
    createHash('sha256').update(expected).digest(),
  );

/**
 * socket.io middleware for the ingest server (`ais:data` pushers). Without
 * INGEST_SOCKET_TOKEN, production refuses every connection (fail closed) and
 * development allows them after a loud warning.
 */
export const createIngestSocketAuth = ({
  expectedToken,
  isProduction,
  logger,
}: IngestSocketAuthOptions): SocketMiddleware => {
  if (!expectedToken) {
    if (isProduction) {
      logger.error(
        'INGEST_SOCKET_TOKEN is not set: the ingest socket server rejects every connection.',
      );
    } else {
      logger.warn(
        '!!! INGEST_SOCKET_TOKEN is not set: the ingest socket server accepts ' +
          'ais:data from ANY client. This is only allowed outside production. !!!',
      );
    }
  }

  return (socket, next) => {
    if (!expectedToken) {
      if (isProduction) {
        next(new Error('Ingest socket disabled: no token configured'));
      } else {
        next();
      }
      return;
    }

    const provided = extractSocketToken(socket.handshake);
    if (provided === null || !tokensMatch(provided, expectedToken)) {
      logger.warn(
        `Rejected ingest socket ${socket.id}: ${provided === null ? 'missing' : 'invalid'} token`,
      );
      next(new Error('Unauthorized'));
      return;
    }
    next();
  };
};

type AllowRequest = (
  req: IncomingMessage,
  callback: (err: string | null | undefined, success: boolean) => void,
) => void;

export interface IngestAllowRequestOptions {
  /** INGEST_SOCKET_TOKEN; empty when not configured. */
  expectedToken: string;
  /** Browser origins allowed by ALLOWED_ORIGINS (true without an Origin). */
  isOriginAllowed: (origin: string | undefined) => boolean;
}

/** True when `origin` is the server itself, e.g. `Origin: http://<Host>`. */
const isOwnOrigin = (
  origin: string | undefined,
  host: string | undefined,
): boolean => {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
};

/**
 * socket.io `allowRequest` (handshake filter) of the ingest server.
 *
 * With INGEST_SOCKET_TOKEN there is none: the token decides. Pushers have no
 * cookies, so their Origin protects nothing, and some send one anyway
 * (Python's websocket-client sends `Origin: http://<host:port>` of the
 * server by default).
 *
 * Without a token (development only: anyone may push), browsers on other
 * sites are refused: requests must have no Origin, a listed origin or the
 * server's own origin.
 */
export const createIngestAllowRequest = ({
  expectedToken,
  isOriginAllowed,
}: IngestAllowRequestOptions): AllowRequest | undefined => {
  if (expectedToken) return undefined;
  return (req, callback) => {
    const { origin, host } = req.headers;
    callback(null, isOriginAllowed(origin) || isOwnOrigin(origin, host));
  };
};
