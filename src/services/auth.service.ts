import bcrypt from 'bcryptjs';
import { body } from 'express-validator';
import config from '../config/config';
import {
  generateAccessToken,
  isAccessTokenExpirationValid,
  isAccessTokenSecretConfigured,
} from '../utils/jwt';
import {
  AuthenticationError,
  ServiceUnavailableError,
} from '../middlewares/error.middleware';

export interface AdminCredentials {
  email: string;
  /** bcrypt hash, e.g. from `pnpm exec bcrypt '<password>' 12` */
  passwordHash: string;
}

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: string;
}

/** Applies the same normalization as `loginValidation` does to the submitted email. */
const normalizeEmail = async (email: string): Promise<string> => {
  const req = { body: { email } };
  await body('email').normalizeEmail().run(req);
  return String(req.body.email);
};

/**
 * Phase 0 login: a single bootstrap admin configured with ADMIN_EMAIL and
 * ADMIN_PASSWORD_HASH. Users, roles and sessions arrive with the v2 auth service.
 */
export class AuthService {
  private normalizedAdminEmail?: Promise<string>;

  constructor(
    private readonly admin: AdminCredentials = {
      email: config.auth.adminEmail,
      passwordHash: config.auth.adminPasswordHash,
    },
  ) {}

  /** Admin credentials, a usable JWT_SECRET and a valid JWT_EXPIRATION. */
  isLoginConfigured(): boolean {
    return (
      Boolean(this.admin.email && this.admin.passwordHash) &&
      isAccessTokenSecretConfigured() &&
      isAccessTokenExpirationValid()
    );
  }

  /** `email` must already be normalized by `loginValidation`. */
  async login(email: string, password: string): Promise<LoginResult> {
    if (!this.isLoginConfigured()) {
      throw new ServiceUnavailableError(
        'Login is not configured on this server',
      );
    }
    // loginValidation only lets strings through; bcrypt throws on anything else.
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new AuthenticationError('Invalid email or password');
    }

    this.normalizedAdminEmail ??= normalizeEmail(this.admin.email);
    const adminEmail = await this.normalizedAdminEmail;
    // Always run bcrypt, so the response time does not reveal a wrong email.
    const passwordMatches = await bcrypt.compare(
      password,
      this.admin.passwordHash,
    );
    if (email !== adminEmail || !passwordMatches) {
      throw new AuthenticationError('Invalid email or password');
    }

    return {
      accessToken: generateAccessToken({
        sub: 'admin',
        email: adminEmail,
        roles: ['admin'],
      }),
      tokenType: 'Bearer',
      expiresIn: config.jwt.expiration,
    };
  }
}
