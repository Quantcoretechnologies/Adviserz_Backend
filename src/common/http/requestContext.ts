import type { Request } from 'express';
import { truncate } from '../utils/normalize.js';

/**
 * Network/client facts about a request, captured for sessions and audit logs.
 * `req.ip` honours the TRUST_PROXY setting, so it is the real client address
 * behind a load balancer and cannot be spoofed via X-Forwarded-For otherwise.
 */
export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string;
}

export function getRequestContext(req: Request): RequestContext {
  return {
    ipAddress: truncate(req.ip, 45),
    userAgent: truncate(req.get('user-agent'), 512),
    requestId: req.requestId,
  };
}
