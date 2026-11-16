import type { Response } from 'express';

/**
 * Uniform success envelope:
 *   { success: true, message, data, requestId }
 * Errors share the shape with `success: false`, `data: null` and a stable
 * `code` (see common/middleware/errorHandler.ts).
 */
export function sendSuccess<T>(res: Response, data: T, message = 'OK', statusCode = 200): void {
  res.status(statusCode).json({
    success: true,
    message,
    data,
    requestId: res.req.requestId,
  });
}

export function sendCreated<T>(res: Response, data: T, message = 'Created'): void {
  sendSuccess(res, data, message, 201);
}
