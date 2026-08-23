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
import type { ScheduleBlock } from '../models/Schedule.js';
import { config } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

export interface OptimizerRequestOptions {
  method?: 'GET' | 'POST';
  /** Serialised as JSON when present. */
  body?: unknown;
  /** Defaults to OPTIMIZER_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Issue a JSON request against the optimizer with a hard timeout.
 *
 * Any failure - unreachable, timed out, non-2xx, unparseable body - is raised
 * as a 502 ApiError. The optimizer being down is an upstream fault, not a
 * client mistake, and must never surface to the browser as a generic 500.
 *
 * Returns `unknown` rather than a generic: the caller names the shape it
 * expects, so no wrapper can silently claim a response is something it is not.
 */
export async function requestOptimizer(
  path: string,
  { method = 'GET', body, timeoutMs }: OptimizerRequestOptions = {},
): Promise<unknown> {
  const url = `${config.optimizer.baseUrl}${path}`;
  const budget = timeoutMs ?? config.optimizer.timeoutMs;

  // AbortSignal.timeout gives a real deadline; without one a hung solver would
  // hold the Express request open indefinitely.
  const signal = AbortSignal.timeout(budget);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const error = err as Error;
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw ApiError.badGateway(
      timedOut
        ? `Optimizer did not respond within ${budget}ms`
        : 'Could not reach the optimizer service',
      { cause: error, details: { url, method } },
    );
  }

  const text = await response.text();
  let parsed: unknown;
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

export interface OptimizerHealth {
  reachable: boolean;
  ready: boolean;
  /** False when the service answers but OR-Tools CP-SAT is not usable. */
  solverAvailable: boolean;
  url: string;
  error?: string;
}

/**
 * Readiness probe used by GET /api/health/dependencies.
 *
 * Returns a status object instead of throwing: a health endpoint should report
 * that a dependency is down, not fail with the same error the dependency did.
 */
export async function checkOptimizerHealth({ timeoutMs = 3000 } = {}): Promise<OptimizerHealth> {
  try {
    const body = (await requestOptimizer('/health/ready', { timeoutMs })) as
      | { status?: string; checks?: { solver?: { available?: boolean } } }
      | null;
    return {
      reachable: true,
      ready: body?.status === 'ready',
      // Surfaced so the dashboard can distinguish "service up but solver
      // broken" from "service unreachable" without a second call.
      solverAvailable: Boolean(body?.checks?.solver?.available),
      url: config.optimizer.baseUrl,
    };
  } catch (err) {
    const error = err as Error;
    logger.warn('Optimizer health check failed', { message: error.message });
    return {
      reachable: false,
      ready: false,
      solverAvailable: false,
      url: config.optimizer.baseUrl,
      error: error.message,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Scheduling calls                                                            */
/* -------------------------------------------------------------------------- */

/** One free window in a corridor's repeating daily pattern (T3). */
export interface OptimizerWindow {
  startMinute: number;
  endMinute: number;
}

export interface OptimizerCorridor {
  corridorId: string;
  dailyWindows: OptimizerWindow[];
  lowConfidence: boolean;
}

export interface OptimizerTask {
  taskId: string;
  corridorId: string;
  department: string;
  estBlockDurationMins: number;
  slaDueDate: string;
  severity: number;
  /** REAL - joined from the assets collection by Node (D-032). */
  assetCriticalityScore: number | null;
  /** Load-bearing for the baseline's FCFS ordering (D-029). */
  dateRaised: string | null;
  dependsOnTaskId: string | null;
  requiredResourceIds: string[];
  failureRiskScore: number | null;
}

export interface OptimizerScenario {
  tasks: OptimizerTask[];
  corridors: OptimizerCorridor[];
  horizonStart: string;
  horizonDays: number;
}

/**
 * A block as it comes off the wire.
 *
 * Deliberately the same type the schedule persists rather than a parallel
 * declaration: the block is stored verbatim (D-033), so two structurally
 * identical interfaces would only create somewhere for them to drift apart.
 */
export type OptimizerBlock = ScheduleBlock;

export interface OptimizerDeferredTask {
  taskId: string;
  reason: string;
  detail: string;
}

/** The optimizer's own result shape - returned verbatim, never reshaped. */
export interface OptimizedSchedule {
  horizon: string;
  horizonStart: string;
  horizonDays: number;
  status: string;
  objectiveValue: number;
  solveSeconds: number;
  metrics: Record<string, number>;
  blocks: OptimizerBlock[];
  deferredTasks: OptimizerDeferredTask[];
  decisionLog: unknown[];
  knownGaps: unknown;
}

export interface BaselineSchedule {
  metrics: Record<string, number>;
  blocks: OptimizerBlock[];
  deferredTasks: OptimizerDeferredTask[];
  conflicts: unknown;
  contestableTaskIds: string[];
}

export interface PriorityQueueEntry {
  taskId: string;
  priorityScore: number;
  solverPriority: number;
  components: Record<string, number>;
  contributions: Record<string, number>;
  dominantFactor: string;
  daysToDue: number;
  isOverdue: boolean;
  /** False until T16; the flag travels so nobody assumes otherwise. */
  usesFailureRisk: boolean;
}

export interface PriorityQueueResponse {
  asOf: string;
  count: number;
  queue: PriorityQueueEntry[];
}

/** FR3 - run the CP-SAT optimizer (PRD Section 13). */
export async function requestOptimizedSchedule(
  payload: OptimizerScenario,
): Promise<OptimizedSchedule> {
  return (await requestOptimizer('/optimize', {
    method: 'POST',
    body: payload,
  })) as OptimizedSchedule;
}

/** FR9.1 - run the naive per-department baseline (PRD Section 12). */
export async function requestBaselineSchedule(
  payload: OptimizerScenario,
): Promise<BaselineSchedule> {
  return (await requestOptimizer('/baseline', {
    method: 'POST',
    body: payload,
  })) as BaselineSchedule;
}

/**
 * FR2.4 - the ranked priority queue with per-factor breakdowns.
 *
 * `assetCriticalityScore` must already be joined on - the optimizer rejects the
 * request without it, deliberately, because scoring without the real value
 * would produce a weaker ranking that still looked authoritative.
 */
export async function requestPriorityQueue({
  tasks,
  asOf,
}: {
  tasks: OptimizerTask[];
  asOf: string;
}): Promise<PriorityQueueResponse> {
  return (await requestOptimizer('/prioritize', {
    method: 'POST',
    body: { tasks, asOf },
  })) as PriorityQueueResponse;
}
