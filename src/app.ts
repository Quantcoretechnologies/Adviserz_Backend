import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { sequelize } from './db/sequelize.js';
import { errorHandler, notFoundHandler } from './common/middleware/errorHandler.js';
import { httpLogger } from './common/middleware/httpLogger.js';
import { globalLimiter } from './common/middleware/rateLimiters.js';
import { requestId } from './common/middleware/requestId.js';
import './models/index.js';
import { apiRouter } from './routes.js';

/**
 * Build the Express application. Has no side effects beyond construction —
 * the server bootstrap owns DB connectivity and the listening socket.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Number of trusted proxy hops; makes req.ip the real client address.
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(httpLogger);
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Non-browser clients (mobile apps, server-to-server) send no Origin.
        callback(null, !origin || env.CORS_ALLOWED_ORIGINS.includes(origin));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '512kb' }));
  app.use(cookieParser());

  /** Liveness: the process is up. Never touches dependencies. */
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  /** Readiness: the database is reachable. */
  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      await sequelize.authenticate();
      res.status(200).json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable', reason: 'database' });
    }
  });

  app.use(env.API_PREFIX, globalLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
