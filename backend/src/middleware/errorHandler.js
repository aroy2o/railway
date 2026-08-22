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
import { ApiError } from '../utils/ApiError.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

/** Catch-all for unmatched routes; hands a 404 to the error handler below. */
export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`No route matches ${req.method} ${req.originalUrl}`));
}

/* eslint-disable-next-line no-unused-vars -- Express identifies the error
   handler by its four-argument signature, so `next` must stay declared. */
export function errorHandler(err, req, res, next) {
  const status = err instanceof ApiError ? err.status : 500;

  // Client errors are expected traffic (bad input, missing token) and only
  // warrant a warn; anything 5xx is a bug or an upstream outage worth a stack.
  if (status >= 500) {
    logger.error('Unhandled request error', {
      method: req.method,
      path: req.originalUrl,
      status,
      message: err.message,
      stack: err.stack,
      cause: err.cause instanceof Error ? err.cause.message : undefined,
    });
  } else {
    logger.warn('Request rejected', {
      method: req.method,
      path: req.originalUrl,
      status,
      message: err.message,
    });
  }

  if (res.headersSent) {
    // Response already streaming - let Express tear the connection down rather
    // than appending a second, malformed body.
    return next(err);
  }

  const body = {
    error: {
      code: err instanceof ApiError ? err.code : 'INTERNAL_ERROR',
      // Never leak an internal exception message to a client.
      message: status >= 500 ? 'Internal server error' : err.message,
    },
  };

  if (err instanceof ApiError && err.details !== undefined) {
    body.error.details = err.details;
  }
  if (status >= 500 && !config.isProduction) {
    body.error.debug = { message: err.message, stack: err.stack };
  }

  res.status(status).json(body);
}
