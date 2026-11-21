#!/usr/bin/env node

/**
 * Pre-deploy check of the configuration (environment and .env in the current
 * directory), run by the deploy workflow before PM2 is restarted:
 *
 *   NODE_ENV=production node dist/bin/check-env.js    (or pnpm check:env)
 *
 * Prints the problems the API would log at startup and exits with 1 when one
 * of them disables login, authenticated writes or the ingest socket, so that
 * a deploy stops instead of a "healthy" API refusing every writer.
 */
import config from '../src/config/config';
import { collectConfigProblems } from '../src/config/security';

const isProduction = config.environment === 'production';
const problems = collectConfigProblems();

if (!config.ingest.socketToken) {
  problems.push({
    level: isProduction ? 'error' : 'warn',
    message:
      'INGEST_SOCKET_TOKEN is not set: the ingest socket server rejects every connection in production.',
  });
}

for (const { level, message } of problems) {
  console[level === 'error' ? 'error' : 'warn'](
    `${level.toUpperCase()}: ${message}`,
  );
}

const errors = problems.filter(({ level }) => level === 'error').length;
console.log(
  `NODE_ENV=${config.environment}: ${errors} error(s), ${problems.length - errors} warning(s).`,
);
process.exit(errors > 0 ? 1 : 0);
