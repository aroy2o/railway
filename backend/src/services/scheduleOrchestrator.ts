/**
 * Generate, persist and read back block schedules.
 *
 * The full loop, and the first place all four layers run together:
 *   MongoDB -> gatherScenario -> optimizer HTTP -> MongoDB
 *
 * Three optimizer calls are made per generation. `/optimize` produces the plan
 * and is required. `/prioritize` supplies the FR2.4 breakdowns that get written
 * back onto tasks, and `/baseline` supplies the FR9.1 comparison - both are
 * best-effort, because losing either should not throw away a good plan.
 */
import type { AnyBulkWriteOperation } from 'mongoose';

import {
  requestAssetRisk,
  requestBaselineSchedule,
  requestOptimizedSchedule,
  requestPriorityQueue,
  type BaselineSchedule,
  type OptimizedSchedule,
  type PolicyWeightsOverride,
  type PriorityQueueEntry,
  type RiskAssessment,
  type RiskResponse,
} from './optimizerClient.js';
import { Asset, Schedule, Task, type GenerationError, type ISchedule, type ITask } from '../models/index.js';
import { gatherScenario, type GatheredScenario } from './scheduleGathering.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

export interface GenerateOptions {
  horizonStart?: string;
  horizonDays?: number;
  /** T23. Omitted terms use the D-023 default (see optimizerClient.ts). */
  policyWeights?: PolicyWeightsOverride;
}

/**
 * Run a full generation: gather, solve, compare, persist.
 *
 * The three calls run in parallel with `allSettled` rather than sequentially.
 * They are independent, each takes well under a second, and - more importantly -
 * `Promise.all` would discard a successful optimize because the baseline
 * failed. Only `/optimize` is allowed to fail the request; the other two record
 * their failure on the schedule so a missing comparison is distinguishable from
 * a comparison that genuinely came out zero.
 */
export async function generateSchedule({
  horizonStart,
  horizonDays = 7,
  policyWeights,
}: GenerateOptions = {}): Promise<ISchedule> {
  const gathered = await gatherScenario({ horizonStart, horizonDays });
  const { payload } = gathered;
  // T23: attached only to the /optimize call. /baseline is a fixed FCFS
  // algorithm with no objective (D-029) and /prioritize scores tasks, not
  // windows, so neither reads an objective weight - sending it to either
  // would be a silently-ignored parameter, which is worse than not sending it.
  const optimizePayload = { ...payload, ...(policyWeights ? { policyWeights } : {}) };

  logger.info('generating schedule', {
    tasks: gathered.taskCount,
    corridors: gathered.corridorCount,
    horizonStart: payload.horizonStart,
    horizonDays: payload.horizonDays,
  });

  // FR2.2 first, and on its own: the risk score is an INPUT to the FR2.3
  // priority score, so it cannot run alongside /prioritize and /optimize. A
  // failure here is not fatal - tasks keep `failureRiskScore: null`, the
  // priority engine renormalises its remaining four weights, and
  // `usesFailureRisk` reports false. That is the D-036 rule applied to a fourth
  // call: only /optimize failing aborts the request.
  const generationErrors: GenerationError[] = [];
  const riskResult = await applyAssetRisk(gathered, generationErrors);

  const [optimizeOutcome, baselineOutcome, priorityOutcome] = await Promise.allSettled([
    requestOptimizedSchedule(optimizePayload),
    requestBaselineSchedule(payload),
    requestPriorityQueue({ tasks: payload.tasks, asOf: payload.horizonStart }),
  ]);

  if (optimizeOutcome.status === 'rejected') {
    // No plan means no schedule. Re-thrown as-is so the optimizerClient's 502
    // envelope (unreachable / timed out / non-JSON) reaches the client intact.
    throw optimizeOutcome.reason;
  }

  const optimized = optimizeOutcome.value;

  const baseline = takeOptional(baselineOutcome, 'baseline', generationErrors);
  const priorityQueue = takeOptional(priorityOutcome, 'prioritize', generationErrors);

  const contestableTaskIds = baseline?.contestableTaskIds ?? [];
  const scheduleId = `SCH-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}`;

  const document: ISchedule = {
    _id: scheduleId,
    horizon: optimized.horizon,
    horizonStart: optimized.horizonStart,
    horizonDays: optimized.horizonDays,
    generatedAt: new Date(),
    // T23: the weights ACTUALLY applied to this solve - every term present,
    // real defaults filled in for whatever the request omitted. Never the
    // request's raw input, and never faked when the request sent nothing.
    policyWeights: optimized.policyWeights,
    status: optimized.status,
    objectiveValue: optimized.objectiveValue,
    solveSeconds: optimized.solveSeconds,
    metrics: optimized.metrics,
    // Stored verbatim. Never destructure these - knownGaps and the decision log
    // are what stop a plan looking cleaner than it is (D-033).
    blocks: optimized.blocks,
    deferredTasks: optimized.deferredTasks,
    decisionLog: optimized.decisionLog,
    knownGaps: optimized.knownGaps,
    conflictReport: optimized.conflictReport ?? null,
    riskModel: {
      // "A risk score actually reached a task" - NOT "the /risk call returned".
      // Those differ whenever the assets have too little degradation history to
      // score, and the first spelling claimed the model had been applied to a
      // plan where every task still ranked on four factors.
      applied: payload.tasks.some((task) => task.failureRiskScore !== null),
      assetsScored: riskResult.assessments.filter((entry) => entry.computed).length,
      tasksWithRisk: payload.tasks.filter((task) => task.failureRiskScore !== null).length,
      modelType: riskResult.modelType,
      framing: riskResult.framing,
    },
    baseline: baseline ?? null,
    contestableTaskIds,
    comparisonToBaseline: baseline ? buildComparison(optimized, baseline) : null,
    inputSummary: {
      taskCount: gathered.taskCount,
      corridorCount: gathered.corridorCount,
      prioritySource: priorityQueue ? 'fr2.3-priority-engine' : 'severity-fallback',
    },
    generationErrors,
    // T27. Only an emergency re-solve sets this - an ordinary generation
    // never did and never claims to have.
    emergencyContext: null,
  };

  const saved = await Schedule.create(document);

  const priorityUpdates = priorityQueue ? await persistPriorityScores(priorityQueue.queue) : 0;

  logger.info('schedule generated', {
    scheduleId,
    status: optimized.status,
    scheduled: optimized.metrics.tasksScheduled,
    deferred: optimized.metrics.tasksDeferred,
    priorityScoresWritten: priorityUpdates,
    failedCalls: generationErrors.map((entry) => entry.call),
  });

  return saved.toObject();
}

/** Unwrap a best-effort call, recording the failure instead of throwing. */
function takeOptional<T>(
  outcome: PromiseSettledResult<T>,
  call: string,
  sink: GenerationError[],
): T | null {
  if (outcome.status === 'fulfilled') return outcome.value;

  const reason = outcome.reason as (Error & { code?: string }) | undefined;
  logger.warn(`optimizer ${call} call failed; continuing without it`, {
    message: reason?.message,
  });
  sink.push({
    call,
    message: reason?.message ?? 'unknown error',
    code: reason?.code ?? 'UNKNOWN',
  });
  return null;
}

/**
 * Write FR2.3 scores back onto the task documents.
 *
 * WHY EVERY GENERATION UPDATES THEM. Priority depends on SLA urgency, which
 * depends on the date the plan is measured from - so a score is only meaningful
 * relative to a horizon. Recomputing on each generation keeps the stored score
 * consistent with the plan that was just produced, instead of leaving a stale
 * number from a previous week sitting on the task. `POST /api/tasks/reprioritize`
 * exists for the cheaper "re-rank without solving" case (D-035).
 */
export async function persistPriorityScores(queue: PriorityQueueEntry[]): Promise<number> {
  if (!Array.isArray(queue) || queue.length === 0) return 0;

  const computedAt = new Date();
  const operations: AnyBulkWriteOperation<ITask>[] = queue.map((entry) => ({
    updateOne: {
      filter: { _id: entry.taskId },
      update: {
        $set: {
          priorityScore: entry.priorityScore,
          priorityBreakdown: {
            components: entry.components,
            contributions: entry.contributions,
            daysToDue: entry.daysToDue,
            isOverdue: entry.isOverdue,
            // FR2.2 is T16's; the flag travels so nobody mistakes this for a
            // risk-aware score.
            usesFailureRisk: entry.usesFailureRisk,
          },
          dominantPriorityFactor: entry.dominantFactor,
          priorityComputedAt: computedAt,
        },
      },
    },
  }));

  const result = await Task.bulkWrite(operations, { ordered: false });
  return result.modifiedCount ?? 0;
}

export interface ComparisonSide {
  contestableScheduled: number;
  crossDepartmentBatches: number;
  doubleBookings: number;
  doubleBookedMinutes: number;
  overSubscribedWindows: number;
  blockMinutesUsed: number;
  blockUtilisationPct: number;
}

export interface BaselineComparison {
  contestableTaskCount: number;
  structurallyImpossibleCount: number;
  optimized: ComparisonSide;
  baseline: ComparisonSide;
  caveats: string[];
}

/**
 * FR9.3 - the metrics table, computed once here so T14 cannot get it wrong.
 *
 * The denominators and the caveats are baked in on purpose. D-031 records two
 * traps that a naive comparison screen would fall into, and both are structural
 * rather than advisory:
 *
 *   1. 53 of the 89 tasks fit no window on their corridor and are impossible
 *      for either algorithm, so the comparison is drawn from the contestable
 *      subset. Using the full backlog would credit the optimizer for work
 *      nothing could have placed.
 *   2. The baseline's utilisation is HIGHER, because it over-subscribes
 *      windows. Rendered alone it reads as the baseline winning.
 */
function buildComparison(
  optimized: OptimizedSchedule,
  baseline: BaselineSchedule,
): BaselineComparison {
  const contestable = new Set(baseline.contestableTaskIds ?? []);
  const scheduledIn = (result: { blocks: Array<{ taskIds: string[] }> }): Set<string> =>
    new Set(result.blocks.flatMap((block) => block.taskIds).filter((id) => contestable.has(id)));

  const optimizedScheduled = scheduledIn(optimized);
  const baselineScheduled = scheduledIn(baseline);

  // T24 changed this from a constant to a real either/or: on this corpus the
  // optimizer now schedules one FEWER contestable task than the baseline
  // (TSK-00025, whose PRD 9.7 prerequisite the baseline places nowhere but
  // schedules anyway - see docs/DECISIONS.md). A hardcoded "both engines
  // schedule the same work" caveat would misreport that as a tie, so the
  // wording is derived from the real counts every time instead.
  const throughputCaveat =
    optimizedScheduled.size === baselineScheduled.size
      ? 'Do not lead with a scheduled-task count: on this dataset both engines schedule the ' +
        'same work. The real difference is that the baseline double-books corridors and ' +
        'cannot batch across departments.'
      : `Do not lead with a scheduled-task count as if higher were simply better: the ` +
        `optimizer schedules ${optimizedScheduled.size} of ${contestable.size} contestable ` +
        `tasks against the baseline's ${baselineScheduled.size}. The optimizer's figure is ` +
        `lower because it enforces PRD 9.7 dependency precedence and refuses to schedule a ` +
        `task before its prerequisite - a real constraint the baseline, which has no ` +
        `dependency awareness, silently ignores. The baseline also still double-books ` +
        `corridors and cannot batch across departments.`;

  return {
    contestableTaskCount: contestable.size,
    structurallyImpossibleCount:
      (optimized.metrics.tasksScheduled ?? 0) +
      (optimized.metrics.tasksDeferred ?? 0) -
      contestable.size,
    optimized: {
      contestableScheduled: optimizedScheduled.size,
      crossDepartmentBatches: optimized.metrics.crossDepartmentBatches ?? 0,
      doubleBookings: 0,
      doubleBookedMinutes: 0,
      overSubscribedWindows: 0,
      blockMinutesUsed: optimized.metrics.blockMinutesUsed ?? 0,
      blockUtilisationPct: optimized.metrics.blockUtilisationPct ?? 0,
    },
    baseline: {
      contestableScheduled: baselineScheduled.size,
      crossDepartmentBatches: baseline.metrics.crossDepartmentBatches ?? 0,
      doubleBookings: baseline.metrics.doubleBookings ?? 0,
      doubleBookedMinutes: baseline.metrics.doubleBookedMinutes ?? 0,
      overSubscribedWindows: baseline.metrics.overSubscribedWindows ?? 0,
      blockMinutesUsed: baseline.metrics.blockMinutesUsed ?? 0,
      blockUtilisationPct: baseline.metrics.blockUtilisationPct ?? 0,
    },
    // Not decoration. A screen that renders the numbers without these is
    // making a claim the data does not support (D-031).
    caveats: [
      'Counts are drawn from the structurally contestable subset. Tasks longer than ' +
        'any window on their corridor are impossible for both algorithms and are excluded.',
      throughputCaveat,
      "Baseline block utilisation is HIGHER than the optimizer's because it over-subscribes " +
        'windows. Never render utilisation without the double-booking count beside it.',
    ],
  };
}

/** Most recently generated schedule, or null if none exists. */
export function findLatestSchedule(): Promise<ISchedule | null> {
  return Schedule.findOne({}).sort({ generatedAt: -1 }).lean<ISchedule | null>().exec();
}

export async function findScheduleById(scheduleId: string): Promise<ISchedule> {
  const schedule = await Schedule.findById(scheduleId).lean<ISchedule | null>().exec();
  if (!schedule) throw ApiError.notFound(`No schedule ${scheduleId}`);
  return schedule;
}


/**
 * Score assets with the FR2.2 model and fold the result into the task payload.
 *
 * Mutates `gathered.payload.tasks` in place so the three scheduling calls that
 * follow see the risk scores. Returns what was written, for persistence and for
 * the schedule's own record of how the priority was computed.
 *
 * On failure this degrades rather than throwing: an error is recorded, scores
 * stay null, and the priority engine renormalises. PRD 9.1's honesty rule cuts
 * both ways - a risk score that could not be computed must not be invented, and
 * that includes not quietly substituting zero.
 */
async function applyAssetRisk(
  gathered: GatheredScenario,
  generationErrors: GenerationError[],
): Promise<{ assessments: RiskAssessment[]; framing: string | null; modelType: string | null }> {
  const empty = { assessments: [] as RiskAssessment[], framing: null, modelType: null };
  if (gathered.assetHistories.length === 0) return empty;

  let response: RiskResponse;
  try {
    response = await requestAssetRisk(gathered.assetHistories);
  } catch (err) {
    const error = err as ApiError;
    logger.warn('asset risk scoring failed; priority will run without FR2.2', {
      message: error.message,
    });
    generationErrors.push({
      call: 'risk',
      message: error.message,
      code: (error as { code?: string }).code ?? 'RISK_FAILED',
    });
    return empty;
  }

  const scoreByAsset = new Map(
    response.assessments.map((entry) => [entry.assetId, entry.failureRiskScore]),
  );

  // Persist onto the asset documents, framing included. Stored rather than
  // recomputed per read, and never stored as a bare number (D-055).
  const operations = response.assessments.map((entry) => ({
    updateOne: {
      filter: { _id: entry.assetId },
      update: {
        $set: {
          failureRiskScore: entry.failureRiskScore,
          failureRiskBreakdown: entry.breakdown,
          failureRiskComputed: entry.computed,
          failureRiskReason: entry.reason,
          failureRiskFraming: entry.framing,
          failureRiskComputedAt: new Date(),
        },
      },
    },
  }));
  if (operations.length > 0) await Asset.bulkWrite(operations, { ordered: false });

  const taskAssetIds = await Task.find({
    _id: { $in: gathered.payload.tasks.map((task) => task.taskId) },
  })
    .select('_id assetId')
    .lean();
  const assetByTask = new Map(taskAssetIds.map((task) => [task._id, task.assetId]));

  const taskUpdates: AnyBulkWriteOperation<ITask>[] = [];
  for (const task of gathered.payload.tasks) {
    const assetId = assetByTask.get(task.taskId);
    const score = assetId ? (scoreByAsset.get(assetId) ?? null) : null;
    task.failureRiskScore = score;
    // Denormalised onto the task as well as the asset, the same way T7 writes
    // `priorityScore` back (D-032's join happens here, not downstream). The
    // asset holds the model's output and its reasoning; the task holds the
    // number it was actually prioritised with, which is what the explanation
    // layer reads and what a Controller sees in the queue.
    taskUpdates.push({
      updateOne: { filter: { _id: task.taskId }, update: { $set: { failureRiskScore: score } } },
    });
  }
  if (taskUpdates.length > 0) await Task.bulkWrite(taskUpdates, { ordered: false });

  logger.info('asset risk scored', {
    assets: response.count,
    scored: response.scoredCount,
    tasksWithRisk: gathered.payload.tasks.filter((task) => task.failureRiskScore !== null).length,
  });

  return {
    assessments: response.assessments,
    framing: response.framing,
    modelType: response.modelType,
  };
}
