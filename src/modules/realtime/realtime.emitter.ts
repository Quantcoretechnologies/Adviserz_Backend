import type { Transaction } from 'sequelize';
import { logger } from '../../config/logger.js';
import {
  sessionRoom,
  USER_NAMESPACE,
  userRoom,
  type RealtimeServer,
  type UserNamespace,
  type UserServerToClientEvents,
} from './realtime.events.js';

/**
 * The only way the rest of the app talks to connected clients.
 *
 * Every call is a no-op until the socket server is attached (CLI scripts,
 * migrations, tests that do not start sockets), so services can call these
 * helpers unconditionally. Rooms work across servers once a Redis adapter is
 * added in realtime.server.ts — nothing here needs to change for that.
 */
type UserEvent = keyof UserServerToClientEvents;

let io: RealtimeServer | null = null;

/** Called by realtime.server.ts only. */
export function setRealtimeServer(server: RealtimeServer | null): void {
  io = server;
}

function users(): UserNamespace | null {
  return io ? io.of(USER_NAMESPACE) : null;
}

/** Push an event to every connected device of a customer. */
export function emitToUser<E extends UserEvent>(
  userId: string,
  event: E,
  ...args: Parameters<UserServerToClientEvents[E]>
): void {
  users()
    ?.to(userRoom(userId))
    .emit(event, ...args);
}

/** Tell one signed-out session's sockets why, then disconnect them. */
export function endSessionSockets(sessionId: string, reason: string): void {
  const namespace = users();
  if (!namespace) return;
  namespace.to(sessionRoom(sessionId)).emit('session:revoked', { reason });
  namespace.in(sessionRoom(sessionId)).disconnectSockets(true);
}

/**
 * Disconnect every socket of a customer whose sessions were signed out,
 * optionally keeping the sockets of one session (password change keeps the
 * device that made the change).
 */
export function endUserSockets(userId: string, reason: string, exceptSessionId?: string): void {
  const namespace = users();
  if (!namespace) return;
  if (!exceptSessionId) {
    namespace.to(userRoom(userId)).emit('session:revoked', { reason });
    namespace.in(userRoom(userId)).disconnectSockets(true);
    return;
  }
  void namespace
    .in(userRoom(userId))
    .fetchSockets()
    .then((sockets) => {
      for (const socket of sockets) {
        if (socket.data.sessionId === exceptSessionId) continue;
        socket.emit('session:revoked', { reason });
        socket.disconnect(true);
      }
    })
    .catch((error: unknown) => logger.error({ err: error, userId }, 'Could not disconnect signed-out sockets'));
}

/**
 * Run real-time work once a transaction has committed, detached from it: a
 * failure here is logged and can never turn a committed change into an error
 * response (Sequelize awaits afterCommit hooks inside commit()).
 */
export function afterCommitPush(transaction: Transaction, label: string, work: () => void | Promise<void>): void {
  transaction.afterCommit(() => {
    void Promise.resolve()
      .then(work)
      .catch((error: unknown) => logger.error({ err: error, label }, 'Real-time push after commit failed'));
  });
}
