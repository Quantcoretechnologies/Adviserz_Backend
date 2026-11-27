import type { Namespace, Server } from 'socket.io';
import type { SerializedNotification } from '../notifications/notification.serializer.js';

/**
 * The real-time contract for customers (Socket.IO namespace `/user`).
 * docs/realtime.md describes it for client developers (web and mobile).
 *
 * The server only pushes; customers send no events. An event says that
 * something changed — clients refetch over REST, which stays the source of
 * truth (permissions, validation and history live there).
 */
export const USER_NAMESPACE = '/user';

export interface UserServerToClientEvents {
  /** A new notification for the bell. */
  'notification:new': (payload: { notification: SerializedNotification }) => void;
  /** Notifications were marked read (possibly on another device): refresh the badge. */
  'notification:read': (payload: { unreadCount: number }) => void;
  /**
   * The access token used to connect has expired. The server disconnects
   * right after; refresh the token and connect again.
   */
  'auth:expired': () => void;
  /**
   * The session was signed out (logout, password change, revoked from another
   * device, account blocked). The server disconnects right after; do NOT
   * reconnect with this session.
   */
  'session:revoked': (payload: { reason: string }) => void;
}

/** Customers send nothing in this version. */
export type UserClientToServerEvents = Record<string, never>;

export type InterServerEvents = Record<string, never>;

/** Attached to each customer socket by the handshake check. */
export interface UserSocketData {
  userId: string;
  sessionId: string;
  /** When the access token used to connect expires. */
  tokenExpiresAt: Date;
}

/** The socket server, typed with the customer contract (the only namespace served). */
export type RealtimeServer = Server<UserClientToServerEvents, UserServerToClientEvents, InterServerEvents, UserSocketData>;
export type UserNamespace = Namespace<UserClientToServerEvents, UserServerToClientEvents, InterServerEvents, UserSocketData>;

export const userRoom = (userId: string): string => `user:${userId}`;
export const sessionRoom = (sessionId: string): string => `session:${sessionId}`;
