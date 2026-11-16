import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';

export type SubjectType = 'user' | 'admin';

export interface AccessTokenClaims {
  /** Subject: user id or admin id. */
  sub: string;
  /** Session id — every request re-checks the session is still live. */
  sid: string;
}

interface IssuedAccessToken {
  accessToken: string;
  accessTokenExpiresAt: Date;
}

/**
 * Users and admins use different signing secrets AND audiences, so a user
 * token can never be replayed against admin endpoints even if one secret
 * leaked.
 */
function secretFor(subjectType: SubjectType): string {
  return subjectType === 'admin' ? env.JWT_ADMIN_ACCESS_SECRET : env.JWT_ACCESS_SECRET;
}

function audienceFor(subjectType: SubjectType): string {
  return subjectType === 'admin' ? 'adviserz-admin' : 'adviserz-user';
}

export function signAccessToken(subjectType: SubjectType, claims: AccessTokenClaims): IssuedAccessToken {
  const ttl = env.ACCESS_TOKEN_TTL_SECONDS;
  const accessToken = jwt.sign({ sid: claims.sid, typ: 'access' }, secretFor(subjectType), {
    algorithm: 'HS256',
    subject: claims.sub,
    audience: audienceFor(subjectType),
    issuer: env.JWT_ISSUER,
    expiresIn: ttl,
  });
  return { accessToken, accessTokenExpiresAt: new Date(Date.now() + ttl * 1000) };
}

export function verifyAccessToken(subjectType: SubjectType, token: string): AccessTokenClaims {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, secretFor(subjectType), {
      algorithms: ['HS256'],
      audience: audienceFor(subjectType),
      issuer: env.JWT_ISSUER,
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw AppError.unauthorized('Access token has expired', ErrorCode.ACCESS_TOKEN_EXPIRED);
    }
    throw AppError.unauthorized('Access token is invalid', ErrorCode.ACCESS_TOKEN_INVALID);
  }

  if (
    typeof decoded === 'string' ||
    decoded['typ'] !== 'access' ||
    typeof decoded.sub !== 'string' ||
    typeof decoded['sid'] !== 'string'
  ) {
    throw AppError.unauthorized('Access token is invalid', ErrorCode.ACCESS_TOKEN_INVALID);
  }

  return { sub: decoded.sub, sid: decoded['sid'] };
}

/** Extract a Bearer token from the Authorization header, if present. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}
