import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Assign every request a correlation id. An inbound X-Request-Id (e.g. from a
 * load balancer) is reused only if it is well-formed, so clients cannot inject
 * arbitrary content into logs.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.get('x-request-id');
  req.requestId = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
