import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIngestSocketAuth,
  extractSocketToken,
  tokensMatch,
} from '../src/middlewares/socket-auth.middleware';

const TOKEN = 'ingest-token-1234567890';

const fakeSocket = (
  auth: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => ({
  id: 'socket-1',
  handshake: { auth, headers } as never,
});

const fakeLogger = () => ({ warn: vi.fn(), error: vi.fn() });

describe('ingest socket auth check', () => {
  it('reads the token from auth.token or the Authorization header', () => {
    expect(extractSocketToken({ auth: { token: TOKEN }, headers: {} })).toBe(
      TOKEN,
    );
    expect(
      extractSocketToken({
        auth: {},
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    ).toBe(TOKEN);
    expect(
      extractSocketToken({ auth: {}, headers: { authorization: TOKEN } }),
    ).toBe(TOKEN);
    expect(extractSocketToken({ auth: {}, headers: {} })).toBeNull();
    expect(extractSocketToken({ auth: { token: 42 }, headers: {} })).toBeNull();
  });

  it('compares tokens of any length', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokensMatch('', TOKEN)).toBe(false);
    expect(tokensMatch(TOKEN.toUpperCase(), TOKEN)).toBe(false);
  });

  it('accepts a matching token and rejects a missing or wrong one', () => {
    const logger = fakeLogger();
    const check = createIngestSocketAuth({
      expectedToken: TOKEN,
      isProduction: true,
      logger,
    });

    for (const socket of [
      fakeSocket({ token: TOKEN }),
      fakeSocket({}, { authorization: `Bearer ${TOKEN}` }),
    ]) {
      const next = vi.fn();
      check(socket, next);
      expect(next).toHaveBeenCalledWith();
    }

    for (const socket of [
      fakeSocket(),
      fakeSocket({ token: 'wrong' }),
      fakeSocket({}, { authorization: 'Bearer wrong' }),
    ]) {
      const next = vi.fn();
      check(socket, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect((next.mock.calls[0][0] as Error).message).toBe('Unauthorized');
    }
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('refuses every connection in production when no token is configured', () => {
    const logger = fakeLogger();
    const check = createIngestSocketAuth({
      expectedToken: '',
      isProduction: true,
      logger,
    });
    const next = vi.fn();

    check(fakeSocket({ token: 'anything' }), next);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('warns loudly and allows connections in development when no token is configured', () => {
    const logger = fakeLogger();
    const check = createIngestSocketAuth({
      expectedToken: '',
      isProduction: false,
      logger,
    });
    const next = vi.fn();

    check(fakeSocket(), next);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('INGEST_SOCKET_TOKEN is not set'),
    );
    expect(next).toHaveBeenCalledWith();
  });

  describe('with a real socket.io server', () => {
    let server: Server | undefined;
    const clients: ClientSocket[] = [];

    afterEach(async () => {
      clients.splice(0).forEach((client) => client.close());
      await new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      );
      server = undefined;
    });

    const startServer = async () => {
      const httpServer = createServer();
      server = new Server(httpServer);
      server.use(
        createIngestSocketAuth({
          expectedToken: TOKEN,
          isProduction: true,
          logger: fakeLogger(),
        }),
      );
      await new Promise<void>((resolve) =>
        httpServer.listen(0, '127.0.0.1', resolve),
      );
      return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    };

    const tryConnect = (url: string, auth?: Record<string, string>) =>
      new Promise<'connected' | string>((resolve) => {
        const client = connect(url, {
          auth,
          transports: ['websocket'],
          reconnection: false,
        });
        clients.push(client);
        client.on('connect', () => resolve('connected'));
        client.on('connect_error', (error) => resolve(error.message));
      });

    it('rejects a client without token and accepts one with the token', async () => {
      const url = await startServer();

      await expect(tryConnect(url)).resolves.toBe('Unauthorized');
      await expect(tryConnect(url, { token: 'wrong' })).resolves.toBe(
        'Unauthorized',
      );
      await expect(tryConnect(url, { token: TOKEN })).resolves.toBe(
        'connected',
      );
    });
  });
});
