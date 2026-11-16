import type { NextFunction, Request, Response } from 'express';
import { UniqueConstraintError, ForeignKeyConstraintError } from 'sequelize';
import { logger } from '../../config/logger.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';

interface ErrorBody {
  success: false;
  message: string;
  code: ErrorCode;
  data: null;
  details?: unknown;
  requestId: string;
}

function send(res: Response, req: Request, status: number, code: ErrorCode, message: string, details?: unknown): void {
  const body: ErrorBody = { success: false, message, code, data: null, requestId: req.requestId };
  if (details !== undefined) body.details = details;
  res.status(status).json(body);
}

interface HttpParserError extends Error {
  type?: string;
  status?: number;
}

/**
 * Central error handler. Known errors become structured client responses;
 * everything else is logged in full server-side and returned as an opaque 500,
 * so stack traces, SQL and internals never leak to clients.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    send(res, req, err.statusCode, err.code, err.message, err.details);
    return;
  }

  // body-parser errors (malformed JSON, oversized payloads)
  const parserError = err as HttpParserError;
  if (parserError?.type === 'entity.parse.failed') {
    send(res, req, 400, ErrorCode.BAD_REQUEST, 'Malformed JSON request body');
    return;
  }
  if (parserError?.type === 'entity.too.large') {
    send(res, req, 413, ErrorCode.PAYLOAD_TOO_LARGE, 'Request body is too large');
    return;
  }

  // Constraint violations that slipped past service-level checks (e.g. races).
  if (err instanceof UniqueConstraintError) {
    logger.warn({ err, requestId: req.requestId }, 'Unique constraint violation');
    send(res, req, 409, ErrorCode.CONFLICT, 'The resource conflicts with an existing record');
    return;
  }
  if (err instanceof ForeignKeyConstraintError) {
    logger.warn({ err, requestId: req.requestId }, 'Foreign key constraint violation');
    send(res, req, 409, ErrorCode.CONFLICT, 'The request references a record that does not exist or is in use');
    return;
  }

  logger.error({ err, requestId: req.requestId, method: req.method, url: req.originalUrl }, 'Unhandled error');
  send(res, req, 500, ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred. Please try again later.');
}

export function notFoundHandler(req: Request, res: Response): void {
  send(res, req, 404, ErrorCode.ROUTE_NOT_FOUND, `Route ${req.method} ${req.path} not found`);
}
