import type { ExtendedError, Socket } from 'socket.io';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import { logger } from '../../config/logger.js';
import { User } from '../../models/index.js';
import { assertSessionActive } from '../auth/session.service.js';
import { extractBearerToken, verifyAccessToken } from '../auth/token.service.js';
import type {
  InterServerEvents,
  UserClientToServerEvents,
  UserServerToClientEvents,
  UserSocketData,
} from './realtime.events.js';

type UserSocket = Socket<UserClientToServerEvents, UserServerToClientEvents, InterServerEvents, UserSocketData>;

/** The error a client receives in `connect_error`: `err.message` and `err.data.code`. */
function connectError(error: unknown): ExtendedError {
  const known = error instanceof AppError;
  if (!known) logger.error({ err: error }, 'Socket handshake failed unexpectedly');
  const failure: ExtendedError = new Error(known ? error.message : 'Something went wrong, please try again');
  failure.data = known
    ? { code: error.code, status: error.statusCode }
    : { code: ErrorCode.INTERNAL_ERROR, status: 500 };
  return failure;
}

/**
 * The access token, from `auth: { token }` (web and React Native clients) or
 * an `Authorization: Bearer` header (clients that can set headers). Never
 * from the query string: URLs end up in logs.
 */
function readToken(socket: UserSocket): string | null {
  const auth: unknown = socket.handshake.auth;
  if (auth && typeof auth === 'object' && 'token' in auth) {
    const token = (auth as { token: unknown }).token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  }
  return extractBearerToken(socket.handshake.headers.authorization);
}

/**
 * Handshake check for customer sockets: the same checks as authenticateUser
 * on REST (signature, live session, active account). Runs once per
 * connection; the connection is then closed when the token expires and on
 * any sign-out, so it never outlives what REST would accept.
 */
export async function authenticateUserSocket(socket: UserSocket, next: (error?: ExtendedError) => void): Promise<void> {
  try {
    const token = readToken(socket);
    if (!token) throw AppError.unauthorized('Authentication required', ErrorCode.UNAUTHENTICATED);

    const claims = verifyAccessToken('user', token);
    await assertSessionActive(claims.sid, 'user', claims.sub);

    const user = await User.findByPk(claims.sub, { attributes: ['id', 'status'] });
    if (!user) throw AppError.unauthorized('Access token is invalid', ErrorCode.ACCESS_TOKEN_INVALID);
    if (user.status !== 'active') {
      throw AppError.forbidden('Your account has been disabled. Please contact support', ErrorCode.ACCOUNT_DISABLED);
    }

    socket.data = { userId: user.id, sessionId: claims.sid, tokenExpiresAt: claims.expiresAt };
    next();
  } catch (error) {
    next(connectError(error));
  }
}
