import bcrypt from 'bcryptjs';
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ALLOWED_ORIGIN,
} from './test-env';

// Runs before every test file, i.e. before src/config/config.ts reads the
// environment. Values are set explicitly so a local .env cannot leak in.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789-abcdefghijklmnop';
process.env.JWT_EXPIRATION = '1h';
process.env.ADMIN_EMAIL = TEST_ADMIN_EMAIL;
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(TEST_ADMIN_PASSWORD, 4);
process.env.ALLOWED_ORIGINS = TEST_ALLOWED_ORIGIN;
process.env.TRUST_FORWARD_AUTH = 'false';
process.env.TRUST_PROXY = 'false';
process.env.INGEST_SOCKET_TOKEN = '';
process.env.CII_ENABLED_MMSIS = '';
process.env.LOGIN_RATE_LIMIT_MAX = '5';
process.env.LOGIN_RATE_LIMIT_WINDOW_MS = '60000';
