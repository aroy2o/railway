/**
 * Terminal error handling for the API.
 *
 * Two rules this enforces for the whole service:
 *   1. Nothing is swallowed - every unhandled error is logged with its stack
 *      before a response goes out.
 *   2. Every error response has the same shape, so the React client has exactly
 *      one error contract to code against:
 *        { error: { code, message, details? } }
 */
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';

import { ApiError } from '../utils/ApiError.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    debug?: { message: string; stack?: string };
  };
}

/** Catch-all for unmatched routes; hands a 404 to the error handler below. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`No route matches ${req.method} ${req.originalUrl}`));
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  const error = err as Error & { cause?: unknown };
  const status = error instanceof ApiError ? error.status : 500;

  // Client errors are expected traffic (bad input, missing token) and only
  // warrant a warn; anything 5xx is a bug or an upstream outage worth a stack.
  if (status >= 500) {
    logger.error('Unhandled request error', {
      method: req.method,
      path: req.originalUrl,
      status,
      message: error.message,
      stack: error.stack,
      cause: error.cause instanceof Error ? error.cause.message : undefined,
    });
  } else {
    logger.warn('Request rejected', {
      method: req.method,
      path: req.originalUrl,
      status,
      message: error.message,
    });
  }

  if (res.headersSent) {
    // Response already streaming - let Express tear the connection down rather
    // than appending a second, malformed body.
    next(error);
    return;
  }

  const body: ErrorEnvelope = {
    error: {
      code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
      // An ApiError message is author-written and safe to show by construction
      // (see ApiError's contract), so it is passed through at any status. Only
      // an UNEXPECTED error is masked, which is what the no-leaking rule was
      // actually for.
      //
      // This distinction was missed until T10: a 502 from an unreachable
      // optimizer reported "Internal server error" rather than "Could not reach
      // the optimizer service", turning the single most likely operational
      // failure into the least actionable message the API can produce.
      message: error instanceof ApiError || status < 500 ? error.message : 'Internal server error',
    },
  };

  if (error instanceof ApiError && error.details !== undefined) {
    body.error.details = error.details;
  }
  if (status >= 500 && !config.isProduction) {
    body.error.debug = { message: error.message, stack: error.stack };
  }

  res.status(status).json(body);
};
