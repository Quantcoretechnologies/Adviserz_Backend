import { ErrorCode } from './errorCodes.js';

export interface ErrorDetail {
  path?: string;
  message: string;
  [key: string]: unknown;
}

/**
 * An expected, client-facing error. Anything thrown that is NOT an AppError is
 * treated as an unexpected failure: logged with full detail and returned to
 * the client as a generic 500 that exposes no internals.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: ErrorDetail[] | undefined;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, code: ErrorCode = ErrorCode.BAD_REQUEST, details?: ErrorDetail[]): AppError {
    return new AppError(400, code, message, details);
  }

  static unauthorized(message = 'Authentication required', code: ErrorCode = ErrorCode.UNAUTHENTICATED): AppError {
    return new AppError(401, code, message);
  }

  static forbidden(message: string, code: ErrorCode = ErrorCode.INSUFFICIENT_PERMISSIONS): AppError {
    return new AppError(403, code, message);
  }

  static notFound(message = 'Resource not found', code: ErrorCode = ErrorCode.NOT_FOUND): AppError {
    return new AppError(404, code, message);
  }

  static conflict(message: string, code: ErrorCode = ErrorCode.CONFLICT, details?: ErrorDetail[]): AppError {
    return new AppError(409, code, message, details);
  }

  static unprocessable(
    message: string,
    code: ErrorCode = ErrorCode.VALIDATION_ERROR,
    details?: ErrorDetail[],
  ): AppError {
    return new AppError(422, code, message, details);
  }

  static tooManyRequests(
    message: string,
    code: ErrorCode = ErrorCode.RATE_LIMITED,
    details?: ErrorDetail[],
  ): AppError {
    return new AppError(429, code, message, details);
  }
}
