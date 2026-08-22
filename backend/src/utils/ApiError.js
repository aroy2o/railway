/**
 * Error type carrying an HTTP status and optional machine-readable details.
 *
 * Route handlers throw this instead of shaping responses inline, so every
 * failure leaves the API in one consistent envelope (see errorHandler.js) and
 * nothing is swallowed on the way out.
 */
export class ApiError extends Error {
  /**
   * @param {number} status  HTTP status code to send.
   * @param {string} message Human-readable, safe to show a client.
   * @param {object} [options]
   * @param {string} [options.code]    Stable machine-readable error code.
   * @param {unknown} [options.details] Extra context (e.g. validation issues).
   * @param {unknown} [options.cause]  Underlying error, kept for the log only.
   */
  constructor(status, message, { code, details, cause } = {}) {
    super(message, { cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = code ?? httpCodeFor(status);
    this.details = details;
  }

  static badRequest(message, options) {
    return new ApiError(400, message, options);
  }

  static unauthorized(message = 'Authentication required', options) {
    return new ApiError(401, message, options);
  }

  static forbidden(message = 'Not permitted', options) {
    return new ApiError(403, message, options);
  }

  static notFound(message = 'Resource not found', options) {
    return new ApiError(404, message, options);
  }

  static conflict(message, options) {
    return new ApiError(409, message, options);
  }

  /** Upstream optimizer service unreachable, timed out, or returned garbage. */
  static badGateway(message = 'Optimizer service unavailable', options) {
    return new ApiError(502, message, options);
  }
}

function httpCodeFor(status) {
  const codes = {
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
