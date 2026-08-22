/**
 * HTTP client for the Python optimizer service.
 *
 * All Node -> Python traffic goes through this module. Node never runs OR-Tools
 * itself (CLAUDE.md tech-stack rule), so this is the single seam between the
 * two services and the only place that knows the optimizer's URL shape.
 *
 * All four calls - the health probe plus /prioritize, /optimize and /baseline -
 * go through the same `requestOptimizer` helper, so timeout handling and the
 * 502 envelope are uniform. Nothing here reshapes a response: the optimizer's
 * payload is returned verbatim, because every honesty-critical field it carries
 * (knownGaps, priorityIsPlaceholder, the baseline conflict report) would be one
 * careless destructure away from being lost (D-033).
 */
import { config } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

/**
 * Issue a JSON request against the optimizer with a hard timeout.
 *
 * Any failure - unreachable, timed out, non-2xx, unparseable body - is raised
 * as a 502 ApiError. The optimizer being down is an upstream fault, not a
 * client mistake, and must never surface to the browser as a generic 500.
 *
 * @param {string} path        Path beginning with '/', e.g. '/optimize'.
 * @param {object} [options]
 * @param {'GET'|'POST'} [options.method]
 * @param {unknown} [options.body]      Serialised as JSON when present.
 * @param {number} [options.timeoutMs]  Defaults to OPTIMIZER_TIMEOUT_MS.
 * @returns {Promise<unknown>} Parsed JSON response body.
 */
export async function requestOptimizer(path, { method = 'GET', body, timeoutMs } = {}) {
  const url = `${config.optimizer.baseUrl}${path}`;
  const budget = timeoutMs ?? config.optimizer.timeoutMs;

  // AbortSignal.timeout gives a real deadline; without one a hung solver would
  // hold the Express request open indefinitely.
  const signal = AbortSignal.timeout(budget);

  let response;
  try {
    response = await fetch(url, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw ApiError.badGateway(
      timedOut
        ? `Optimizer did not respond within ${budget}ms`
        : 'Could not reach the optimizer service',
      { cause: err, details: { url, method } },
    );
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (err) {
    throw ApiError.badGateway('Optimizer returned a non-JSON response', {
      cause: err,
      details: { url, status: response.status },
    });
  }

  if (!response.ok) {
    throw ApiError.badGateway(`Optimizer responded ${response.status}`, {
      details: { url, status: response.status, body: parsed },
    });
  }

  return parsed;
}

/**
 * Readiness probe used by GET /api/health/dependencies.
 *
 * Returns a status object instead of throwing: a health endpoint should report
 * that a dependency is down, not fail with the same error the dependency did.
 */
export async function checkOptimizerHealth({ timeoutMs = 3000 } = {}) {
  try {
    const body = await requestOptimizer('/health/ready', { timeoutMs });
    return {
      reachable: true,
      ready: body?.status === 'ready',
      // Surfaced so the dashboard can distinguish "service up but solver
      // broken" from "service unreachable" without a second call.
      solverAvailable: Boolean(body?.checks?.solver?.available),
      url: config.optimizer.baseUrl,
    };
  } catch (err) {
    logger.warn('Optimizer health check failed', { message: err.message });
    return {
      reachable: false,
      ready: false,
      solverAvailable: false,
      url: config.optimizer.baseUrl,
      error: err.message,
    };
  }
}


/**
 * FR3 - run the CP-SAT optimizer (PRD Section 13).
 *
 * @param {object} payload A ScenarioIn + horizon body; see D-032 for the shape.
 * @returns {Promise<object>} The solver's full result, unmodified.
 */
export function requestOptimizedSchedule(payload) {
  return requestOptimizer('/optimize', { method: 'POST', body: payload });
}

/** FR9.1 - run the naive per-department baseline (PRD Section 12). */
export function requestBaselineSchedule(payload) {
  return requestOptimizer('/baseline', { method: 'POST', body: payload });
}

/**
 * FR2.4 - the ranked priority queue with per-factor breakdowns.
 *
 * Takes the same task list as a solve, plus the date SLA urgency is measured
 * against. `assetCriticalityScore` must already be joined on - the optimizer
 * rejects the request without it, deliberately, because scoring without the
 * real value would produce a weaker ranking that still looked authoritative.
 */
export function requestPriorityQueue({ tasks, asOf }) {
  return requestOptimizer('/prioritize', { method: 'POST', body: { tasks, asOf } });
}
