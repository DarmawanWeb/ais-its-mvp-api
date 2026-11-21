import type { RequestHandler } from 'express';

export interface RateLimitOptions {
  windowMs: number;
  /** Requests allowed per client IP and window. */
  max: number;
  message?: string;
  now?: () => number;
  /**
   * Clients tracked at most. When full, the client whose window started
   * first is forgotten, so memory and the cost per request stay bounded
   * even when the IP addresses keep changing.
   */
  maxTrackedClients?: number;
}

const MAX_TRACKED_CLIENTS = 10_000;

/**
 * Small in-memory fixed-window rate limiter keyed by client IP (`req.ip`;
 * set TRUST_PROXY when running behind a reverse proxy). State is per process.
 */
export const createRateLimiter = ({
  windowMs,
  max,
  message = 'Too many requests, please try again later',
  now = Date.now,
  maxTrackedClients = MAX_TRACKED_CLIENTS,
}: RateLimitOptions): RequestHandler => {
  // Insertion order is the order in which the windows started (an entry is
  // re-inserted when its window restarts), so the oldest entries come first.
  const clients = new Map<string, { count: number; resetAt: number }>();

  const forgetExpiredClients = (currentTime: number): void => {
    for (const [key, entry] of clients) {
      if (entry.resetAt > currentTime) return;
      clients.delete(key);
    }
  };

  return (req, res, next) => {
    const currentTime = now();
    forgetExpiredClients(currentTime);

    const key = req.ip ?? 'unknown';
    let entry = clients.get(key);
    if (!entry || entry.resetAt <= currentTime) {
      clients.delete(key);
      if (clients.size >= maxTrackedClients) {
        const oldestKey = clients.keys().next().value;
        if (oldestKey !== undefined) clients.delete(oldestKey);
      }
      entry = { count: 0, resetAt: currentTime + windowMs };
      clients.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - currentTime) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ message, status: 429, success: false });
      return;
    }
    next();
  };
};
