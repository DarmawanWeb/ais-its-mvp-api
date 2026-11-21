import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import dotenv from 'dotenv';
import { describeSecretProblem } from './secrets';
dotenv.config();

const CONFIGURED_JWT_SECRET = process.env.JWT_SECRET || '';
/** Why JWT_SECRET cannot be used (missing, placeholder, too short), or null. */
const JWT_SECRET_PROBLEM = describeSecretProblem(
  CONFIGURED_JWT_SECRET,
  process.env.NODE_ENV === 'production',
);
// An unusable secret counts as not set: no token is issued or accepted.
const JWT_SECRET = JWT_SECRET_PROBLEM === null ? CONFIGURED_JWT_SECRET : '';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || '';
const REFRESH_TOKEN_EXPIRATION = process.env.REFRESH_TOKEN_EXPIRATION || '30d';

/**
 * JWT_EXPIRATION as jsonwebtoken's `expiresIn`: a timespan such as "1h" or
 * "30m", or a number of seconds. A bare number is converted, because
 * jsonwebtoken would read the string "3600" as 3600 milliseconds.
 */
const toExpiresIn = (value: string): SignOptions['expiresIn'] =>
  /^\d+$/.test(value) ? Number(value) : (value as SignOptions['expiresIn']);

/** Lifetime in seconds of tokens signed with `expiresIn`; null if it is invalid. */
const tokenLifetimeSeconds = (
  expiresIn: SignOptions['expiresIn'],
): number | null => {
  try {
    const { iat, exp } = jwt.decode(
      jwt.sign({}, 'lifetime-check', { expiresIn }),
    ) as JwtPayload;
    return typeof iat === 'number' && typeof exp === 'number'
      ? exp - iat
      : null;
  } catch {
    return null; // e.g. the .env.example placeholder "your_jwt_expiration_time"
  }
};

const JWT_EXPIRATION = toExpiresIn(process.env.JWT_EXPIRATION || '1h');
const ACCESS_TOKEN_LIFETIME = tokenLifetimeSeconds(JWT_EXPIRATION);

/**
 * True when JWT_SECRET can be used, i.e. access tokens can be issued and
 * verified. It cannot when it is missing or a placeholder value (such as
 * `your_jwt_secret` from .env.example), or in production when it is shorter
 * than 32 characters.
 */
export const isAccessTokenSecretConfigured = (): boolean =>
  JWT_SECRET.length > 0;

/** Why JWT_SECRET cannot be used ("is not set", ...), or null when it can. */
export const getAccessTokenSecretProblem = (): string | null =>
  JWT_SECRET_PROBLEM;

/** True when JWT_EXPIRATION is a positive duration jsonwebtoken accepts. */
export const isAccessTokenExpirationValid = (): boolean =>
  ACCESS_TOKEN_LIFETIME !== null && ACCESS_TOKEN_LIFETIME > 0;

export const generateAccessToken = (payload: object): string => {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not defined');

  const options: SignOptions = { expiresIn: JWT_EXPIRATION };
  return jwt.sign(payload, JWT_SECRET, options);
};

export const generateRefreshToken = (payload: object): string => {
  if (!REFRESH_TOKEN_SECRET)
    throw new Error('REFRESH_TOKEN_SECRET is not defined');

  const options: SignOptions = {
    expiresIn: REFRESH_TOKEN_EXPIRATION as SignOptions['expiresIn'],
  };
  return jwt.sign(payload, REFRESH_TOKEN_SECRET, options);
};

export const verifyAccessToken = (token: string): JwtPayload | string => {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not defined');

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    return decoded;
  } catch (error: unknown) {
    throw new Error(`Invalid or expired access token with error ${error}`);
  }
};
export const verifyRefreshToken = (token: string): JwtPayload | string => {
  if (!REFRESH_TOKEN_SECRET)
    throw new Error('REFRESH_TOKEN_SECRET is not defined');

  try {
    const decoded = jwt.verify(token, REFRESH_TOKEN_SECRET) as JwtPayload;
    return decoded;
  } catch (error: unknown) {
    throw new Error(`Invalid or expired refresh token with eeror ${error}`);
  }
};

export const decodeToken = (token: string): JwtPayload | null => {
  try {
    return jwt.decode(token) as JwtPayload;
  } catch {
    return null;
  }
};
