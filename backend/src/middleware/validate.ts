/**
 * Request validation middleware factory.
 *
 * Every API boundary that accepts client input runs through this, so validation
 * lives beside the route definition instead of being re-implemented inside each
 * handler. On success the parsed (and coerced) value REPLACES req.body/query/
 * params, which means downstream handlers only ever see data that matched the
 * schema - there is no path where an unvalidated field reaches business logic.
 *
 * Usage:
 *   router.get('/', validate({ query: listQuerySchema }), (req, res) => {
 *     const { limit, offset } = validated<ListQuery>(req.query);
 *   });
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

import { ApiError } from '../utils/ApiError.js';

const TARGETS = ['body', 'query', 'params'] as const;
type Target = (typeof TARGETS)[number];

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export interface ValidationIssue {
  location: Target;
  path: string;
  message: string;
}

/**
 * Read a validated value at its schema's type.
 *
 * This is a cast, and deliberately a named one. Express types `req.query` as a
 * string record, but `validate()` has already replaced it with the parsed and
 * coerced output - so the cast is safe exactly when the matching schema was
 * applied, and naming it keeps that assumption visible at the call site rather
 * than scattering bare `as` expressions through the routes.
 */
export function validated<T>(value: unknown): T {
  return value as T;
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  const active = TARGETS.filter((target) => schemas[target]);
  if (active.length === 0) {
    // A programming error, not a runtime one - fail at wiring time, loudly.
    throw new Error('validate() requires at least one of: body, query, params');
  }

  return function validateRequest(req: Request, _res: Response, next: NextFunction): void {
    const issues: ValidationIssue[] = [];

    for (const target of active) {
      const schema = schemas[target];
      if (!schema) continue;

      const result = schema.safeParse(req[target]);

      if (result.success) {
        // Express 5 exposes req.query as a getter, so assigning to it throws.
        // Define the parsed value as an own property instead.
        Object.defineProperty(req, target, {
          value: result.data,
          writable: true,
          configurable: true,
          enumerable: true,
        });
        continue;
      }

      for (const issue of result.error.issues) {
        issues.push({
          location: target,
          path: issue.path.join('.'),
          message: issue.message,
        });
      }
    }

    if (issues.length > 0) {
      next(ApiError.badRequest('Request validation failed', { details: issues }));
      return;
    }
    next();
  };
}

export default validate;
