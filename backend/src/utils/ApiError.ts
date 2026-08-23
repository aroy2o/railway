/**
 * Error type carrying an HTTP status and optional machine-readable details.
 *
 * Route handlers throw this instead of shaping responses inline, so every
 * failure leaves the API in one consistent envelope (see errorHandler.ts) and
 * nothing is swallowed on the way out.
 */

/** Stable machine-readable codes the client can branch on. */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE_ENTITY'
  | 'BAD_GATEWAY'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ApiErrorOptions {
  code?: ApiErrorCode;
  /** Extra context (e.g. validation issues). Serialised to the client. */
  details?: unknown;
  /** Underlying error, kept for the log only - never sent to a client. */
  cause?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(status: number, message: string, options: ApiErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = options.code ?? httpCodeFor(status);
    this.details = options.details;
  }

  static badRequest(message: string, options?: ApiErrorOptions): ApiError {
    return new ApiError(400, message, options);
  }

  static unauthorized(message = 'Authentication required', options?: ApiErrorOptions): ApiError {
    return new ApiError(401, message, options);
  }

  static forbidden(message = 'Not permitted', options?: ApiErrorOptions): ApiError {
    return new ApiError(403, message, options);
  }

  static notFound(message = 'Resource not found', options?: ApiErrorOptions): ApiError {
    return new ApiError(404, message, options);
  }

  static conflict(message: string, options?: ApiErrorOptions): ApiError {
    return new ApiError(409, message, options);
  }

  /** Upstream optimizer service unreachable, timed out, or returned garbage. */
  static badGateway(message = 'Optimizer service unavailable', options?: ApiErrorOptions): ApiError {
    return new ApiError(502, message, options);
  }
}

function httpCodeFor(status: number): ApiErrorCode {
  const codes: Record<number, ApiErrorCode> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'UNPROCESSABLE_ENTITY',
    502: 'BAD_GATEWAY',
    503: 'SERVICE_UNAVAILABLE',
  };
  return codes[status] ?? 'INTERNAL_ERROR';
}

export default ApiError;
