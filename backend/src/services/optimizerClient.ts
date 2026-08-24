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
    // FastAPI puts our own message in `detail`. Surfacing it is the D-037
    // standard applied one layer out: "no ANTHROPIC_API_KEY is set" tells a
    // Controller what to do, "Optimizer responded 503" tells them nothing, and
    // burying the first inside the second is the same failure with extra steps.
    // Only a string `detail` is passed through - a 422's detail is a list of
    // validation objects, which is debugging output, not a message.
    const detail = (parsed as { detail?: unknown } | null)?.detail;
    const message =
      typeof detail === 'string' && detail.trim()
        ? detail
        : `Optimizer responded ${response.status}`;
    const details = { url, status: response.status, body: parsed };

    // 503 from the optimizer means the service is up and a dependency is not.
    // Relabelling that as 502 would claim the optimizer itself is broken.
    throw response.status === 503
      ? ApiError.serviceUnavailable(message, { details })
      : ApiError.badGateway(message, { details });
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

/** T22: when trains hold the corridor. Costing input only, never schedulable. */
export interface OptimizerOccupiedWindow {
  startMinute: number;
  endMinute: number;
}

export interface OptimizerCorridor {
  corridorId: string;
  dailyWindows: OptimizerWindow[];
  lowConfidence: boolean;
  /** T22 costing input. Optional so an older caller still validates. */
  occupiedWindows?: OptimizerOccupiedWindow[];
  trainClassMix?: Record<string, number> | null;
  /** T26, PRD 9.9. Real, from Ministry of Jal Shakti flood-risk state data.
   * Advisory only - never a scheduling constraint. */
  seasonalRiskFlag?: 'monsoon-risk' | 'none' | 'flood-prone' | null;
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

/**
 * T23's policy sliders (PRD 13.1). Every term optional - an omitted one keeps
 * its D-023 default, decided and validated by the optimizer (D-061), not
 * re-derived here.
 */
export interface PolicyWeightsOverride {
  coverage?: number;
  slaCompliance?: number;
  batching?: number;
  unusedMinute?: number;
  fragmentation?: number;
}

export interface OptimizerScenario {
  tasks: OptimizerTask[];
  corridors: OptimizerCorridor[];
  horizonStart: string;
  horizonDays: number;
  /** T23. Omitted means "use every D-023 default". */
  policyWeights?: PolicyWeightsOverride;
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
  /** PRD 9.5 typed conflicts derived from knownGaps by the optimizer. */
  conflictReport: unknown;
  /**
   * T23: the weights actually applied to THIS solve - every term present,
   * defaults filled in for whatever the request omitted. Never the request's
   * raw (possibly partial) object; persisted onto `schedule.policyWeights`
   * verbatim so "what was this plan built with" never has to be guessed.
   */
  policyWeights: Required<PolicyWeightsOverride>;
}

export interface BaselineSchedule {
  metrics: Record<string, number>;
  blocks: OptimizerBlock[];
  deferredTasks: OptimizerDeferredTask[];
  conflicts: unknown;
  contestableTaskIds: string[];
  /** PRD 9.5 typed conflicts for the baseline layer. */
  conflictReport: unknown;
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

/**
 * T20 (PRD FR5, 9.4) - "what if this task were placed differently?"
 *
 * Sent alongside `policyWeights` from the SCHEDULE being asked about, not the
 * D-023 default - the what-if's own baseline solve must reproduce the plan
 * already committed, or the diff it shows is against something that never
 * existed (D-064).
 */
export interface WhatIfScenario extends OptimizerScenario {
  taskId: string;
}

export interface WhatIfTaskOutcome {
  placed: boolean;
  corridorId: string | null;
  date: string | null;
  windowIndex: number | null;
}

export interface WhatIfDiff {
  newlyScheduled: string[];
  newlyDeferred: string[];
  reshuffledCount: number;
  reshuffledSample: string[];
}

export interface WhatIfOption {
  label: string;
  kind: 'move' | 'defer' | 'traffic-block';
  taskOutcome: WhatIfTaskOutcome;
  diff: WhatIfDiff | null;
  metrics: Record<string, unknown>;
  reason: string;
  solveSeconds: number | null;
}

/** The optimizer's own result shape - returned verbatim, never reshaped. */
export interface WhatIfResult {
  taskId: string;
  currentlyScheduled: boolean;
  baselineMetrics: Record<string, number>;
  options: WhatIfOption[];
  recommendedIndex: number | null;
  framing: string;
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

/**
 * T20 - a real re-solve of the same CP-SAT model, with one task's placement
 * forced, diffed against the plan without that constraint. Nothing about this
 * call persists anywhere (D-064): same scenario, same answer, every time.
 */
export async function requestWhatIf(payload: WhatIfScenario): Promise<WhatIfResult> {
  return (await requestOptimizer('/whatif', {
    method: 'POST',
    // Up to 4 real solves in one request - see WHATIF_TIMEOUT_MS's own
    // comment for the arithmetic. Sharing /optimize's 30s budget (sized for
    // exactly one solve) risked the request timing out before the optimizer's
    // own shorter per-solve ceiling could even finish all four.
    timeoutMs: config.optimizer.whatIfTimeoutMs,
    body: payload,
  })) as WhatIfResult;
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
/** One asset's FR2.2 risk assessment (T16, PRD 9.1). */
export interface RiskAssessment {
  assetId: string;
  failureRiskScore: number | null;
  /** False when the model could not assess the asset; `reason` says why. */
  computed: boolean;
  reason: string | null;
  breakdown: Record<string, unknown>;
  /** PRD 9.1 honesty framing. Must survive every hop - see D-055. */
  framing: string;
}

export interface RiskResponse {
  assessments: RiskAssessment[];
  count: number;
  scoredCount: number;
  framing: string;
  modelType: string;
}

/**
 * Score assets against the FR2.2 predictive risk model.
 *
 * Runs BEFORE the three scheduling calls, not alongside them: the risk score is
 * an input to the FR2.3 priority score, so it has to exist before /prioritize
 * and /optimize see the tasks.
 */
export async function requestAssetRisk(
  assets: Array<{ assetId: string; degradationHistory: Array<{ healthMetric: number }> }>,
): Promise<RiskResponse> {
  return (await requestOptimizer('/risk', {
    method: 'POST',
    body: { assets },
  })) as RiskResponse;
}

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
