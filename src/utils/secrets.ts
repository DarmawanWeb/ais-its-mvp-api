/**
 * Public values (from .env.example and similar examples). They are never
 * accepted as a secret, in any environment.
 */
const PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  'your_jwt_secret',
  'your_refresh_token_secret',
  'your_websocket_token',
  'changeme',
  'secret',
]);

/** Secrets used in production need at least this many characters. */
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

/**
 * Why `value` cannot be used as a secret, phrased to follow the variable
 * name ("JWT_SECRET is a placeholder value"), or null when it can be used.
 * Outside production short values are accepted, for local setups.
 */
export const describeSecretProblem = (
  value: string,
  isProduction: boolean,
): string | null => {
  if (value.length === 0) return 'is not set';
  if (PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
    return 'is a placeholder value';
  }
  if (isProduction && value.length < MIN_PRODUCTION_SECRET_LENGTH) {
    return `is shorter than ${MIN_PRODUCTION_SECRET_LENGTH} characters`;
  }
  return null;
};
