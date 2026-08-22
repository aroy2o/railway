/**
 * Request validation middleware factory.
 *
 * Every API boundary that accepts client input runs through this, so validation
 * lives beside the route definition instead of being re-implemented inside each
 * handler. On success the parsed (and coerced) value REPLACES req.body/query/
 * params, which means downstream handlers only ever see data that matched the
 * schema - there is no path where an unvalidated field reaches business logic.
 *
 * Usage (from T10 onward):
 *   router.post('/', validate({ body: createTaskSchema }), createTask);
 */
import { ApiError } from '../utils/ApiError.js';

const TARGETS = ['body', 'query', 'params'];

/**
 * @param {{ body?: import('zod').ZodType,
 *           query?: import('zod').ZodType,
 *           params?: import('zod').ZodType }} schemas
 */
export function validate(schemas) {
  const active = TARGETS.filter((target) => schemas[target]);
  if (active.length === 0) {
    // A programming error, not a runtime one - fail at wiring time, loudly.
    throw new Error('validate() requires at least one of: body, query, params');
  }

  return function validateRequest(req, _res, next) {
    const issues = [];

    for (const target of active) {
      const result = schemas[target].safeParse(req[target]);

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
      return next(ApiError.badRequest('Request validation failed', { details: issues }));
    }
    return next();
  };
}

export default validate;
