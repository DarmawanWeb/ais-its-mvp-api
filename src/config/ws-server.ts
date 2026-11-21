import http from 'node:http';
import { Server } from 'socket.io';
import logger from './logger';
import config from './config';
import { isRequestOriginAllowed } from './cors';
import {
  createIngestAllowRequest,
  createIngestSocketAuth,
} from '../middlewares/socket-auth.middleware';
import { parseAisSocketPayload } from '../validation/ais-payload.validation';
import { TokenBucket } from '../utils/token-bucket';
import { AisService } from '../services/ais.service';

const WARNING_INTERVAL_MS = 10_000;

const aisService = new AisService();
const socketServer = http.createServer();

const io = new Server(socketServer, {
  // As before phase 0: pushers are not browsers, INGEST_SOCKET_TOKEN is
  // what authenticates them.
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false,
  },
  // Only filters browsers when no token is configured (development).
  allowRequest: createIngestAllowRequest({
    expectedToken: config.ingest.socketToken,
    isOriginAllowed: isRequestOriginAllowed,
  }),
  // One AIS message is well below 1 KB.
  maxHttpBufferSize: 64 * 1024,
});

io.use(
  createIngestSocketAuth({
    expectedToken: config.ingest.socketToken,
    isProduction: config.environment === 'production',
    logger,
  }),
);

io.on('connection', (socket) => {
  const rateLimiter = new TokenBucket(
    config.ingest.rateLimit.messagesPerSecond,
    config.ingest.rateLimit.burst,
  );
  let droppedMessages = 0;
  let invalidMessages = 0;
  let lastWarningAt = 0;

  const warnThrottled = () => {
    const now = Date.now();
    if (now - lastWarningAt < WARNING_INTERVAL_MS) return;
    lastWarningAt = now;
    logger.warn(
      `Socket ${socket.id}: ${droppedMessages} ais:data messages dropped by the rate limit, ${invalidMessages} invalid`,
    );
  };

  socket.on('joinRoom', (room: unknown) => {
    if (typeof room !== 'string' || room.length === 0 || room.length > 128) {
      return;
    }
    logger.debug(`Socket ${socket.id} joined room: ${room}`);
    socket.join(room);
  });

  socket.on('ais:data', async (payload: unknown) => {
    if (!rateLimiter.tryRemoveToken()) {
      droppedMessages += 1;
      warnThrottled();
      return;
    }

    const data = parseAisSocketPayload(payload);
    if (!data) {
      invalidMessages += 1;
      warnThrottled();
      return;
    }

    try {
      logger.debug(`Received AIS data for MMSI ${data.message.data.mmsi}`);
      await aisService.createOrUpdateAis(data);
    } catch (error) {
      logger.error('Error processing message from server:', error);
      console.error('Error processing message from server:', data);
    }
  });

  socket.on('error', (error: Error) => {
    logger.error('Socket error', error.message);
  });

  socket.on('disconnect', () => {
    logger.info(`Socket ${socket.id} disconnected`);
  });
});

export default socketServer;
