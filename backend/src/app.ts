/**
 * Express application wiring.
 *
 * Kept separate from server.ts (which owns ports, database connection and
 * signal handling) so tests can mount the app in-process with supertest and
 * never bind a socket.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';

import apiRouter from './routes/index.js';
import { config } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';

export function createApp(): Express {
  const app = express();

  // Behind docker-compose / a reverse proxy, trust X-Forwarded-* so client IPs
  // and protocol are read correctly.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    cors({
      origin: [...config.corsOrigins],
      credentials: true,
    }),
  );

  // Bounded body size - an unbounded JSON parser is a trivial memory DoS, and
  // bulk CSV/JSON import (FR1.3) will stream through its own route instead.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use(requestLogger);

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** Logs method, path, status and duration once the response is flushed. */
function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.debug('request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
    });
  });

  next();
}

export default createApp;
