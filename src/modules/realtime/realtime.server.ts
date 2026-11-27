import type { Server as HttpServer } from 'node:http';
import { Server, type ExtendedError } from 'socket.io';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { authenticateUserSocket } from './realtime.auth.js';
import { setRealtimeServer } from './realtime.emitter.js';
import { sessionRoom, USER_NAMESPACE, userRoom, type RealtimeServer } from './realtime.events.js';

/** Open connections allowed per customer (tabs + devices), per server. */
export const MAX_SOCKETS_PER_USER = 20;
/** Clients send no events, so anything bigger than a handshake is refused. */
const MAX_MESSAGE_BYTES = 16 * 1024;
/** setTimeout cannot wait longer than this (about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

function refusal(message: string, code: ErrorCode, status: number): ExtendedError {
  const error: ExtendedError = new Error(message);
  error.data = { code, status };
  return error;
}

let server: RealtimeServer | null = null;

/**
 * Attach Socket.IO to the HTTP server. Customers connect to the `/user`
 * namespace with their access token; nothing else is served.
 *
 * To run more than one API server, add the Redis adapter here
 * (`server.adapter(createAdapter(pub, sub))`); every emit already goes
 * through rooms in realtime.emitter.ts.
 */
export function attachRealtime(httpServer: HttpServer): RealtimeServer {
  const io: RealtimeServer = new Server(httpServer, {
    serveClient: false,
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
    cors: {
      // Same rule as the REST API: browsers from allowed origins; clients
      // without an Origin header (mobile apps) are allowed too.
      origin: (origin, callback) => callback(null, !origin || env.CORS_ALLOWED_ORIGINS.includes(origin)),
      credentials: true,
    },
  });

  // Nothing is served on the default namespace.
  io.use((_socket, next) => next(refusal('Not found', ErrorCode.NOT_FOUND, 404)));

  const users = io.of(USER_NAMESPACE);

  users.use((socket, next) => void authenticateUserSocket(socket, next));
  users.use((socket, next) => {
    const open = users.adapter.rooms.get(userRoom(socket.data.userId))?.size ?? 0;
    if (open >= MAX_SOCKETS_PER_USER) {
      next(refusal('Too many open connections', ErrorCode.RATE_LIMITED, 429));
      return;
    }
    next();
  });

  users.on('connection', (socket) => {
    const { userId, sessionId, tokenExpiresAt } = socket.data;
    void socket.join([userRoom(userId), sessionRoom(sessionId)]);

    // The connection may not outlive the token it was opened with: at expiry
    // the client refreshes and reconnects, which runs the full check again.
    const expiry = setTimeout(
      () => {
        socket.emit('auth:expired');
        socket.disconnect(true);
      },
      Math.min(Math.max(tokenExpiresAt.getTime() - Date.now(), 0), MAX_TIMER_MS),
    );

    socket.on('disconnect', () => clearTimeout(expiry));
  });

  server = io;
  setRealtimeServer(io);
  logger.info({ namespace: USER_NAMESPACE }, 'Real-time server attached');
  return io;
}

/**
 * Drop every connection and stop accepting new ones. Call before closing the
 * HTTP server: open sockets would otherwise keep it from closing. Leaves the
 * HTTP server itself to the caller.
 *
 * Connections are cut at the transport level, without a Socket.IO
 * "disconnect" packet, so clients see `transport close` and reconnect by
 * themselves once the server (or another instance) is back. A disconnect
 * packet would tell them they were thrown out on purpose, and they would
 * stay offline after every restart or deploy.
 */
export function closeRealtime(): void {
  if (!server) return;
  setRealtimeServer(null);
  server.engine.close();
  server = null;
}
