import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from '../../config/logger.js';

/**
 * Structured access log: one line per request with method, path, status,
 * latency and request id. Bodies are never logged.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage) => (req as Request).requestId,
  customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  autoLogging: { ignore: (req: IncomingMessage) => req.url === '/health' || req.url === '/ready' },
  serializers: {
    req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
  },
});
