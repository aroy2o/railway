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
  requestBaselineSchedule,
  requestOptimizedSchedule,
  requestPriorityQueue,
  type BaselineSchedule,
  type OptimizedSchedule,
  type PriorityQueueEntry,
} from './optimizerClient.js';
import { Schedule, Task, type GenerationError, type ISchedule, type ITask } from '../models/index.js';
import { gatherScenario } from './scheduleGathering.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

export interface GenerateOptions {
  horizonStart?: string;
  horizonDays?: number;
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
}: GenerateOptions = {}): Promise<ISchedule> {
  const gathered = await gatherScenario({ horizonStart, horizonDays });
  const { payload } = gathered;

  logger.info('generating schedule', {
    tasks: gathered.taskCount,
    corridors: gathered.corridorCount,
    horizonStart: payload.horizonStart,
    horizonDays: payload.horizonDays,
  });

  const [optimizeOutcome, baselineOutcome, priorityOutcome] = await Promise.allSettled([
    requestOptimizedSchedule(payload),
    requestBaselineSchedule(payload),
    requestPriorityQueue({ tasks: payload.tasks, asOf: payload.horizonStart }),
  ]);

  if (optimizeOutcome.status === 'rejected') {
    // No plan means no schedule. Re-thrown as-is so the optimizerClient's 502
    // envelope (unreachable / timed out / non-JSON) reaches the client intact.
    throw optimizeOutcome.reason;
  }

  const optimized = optimizeOutcome.value;
  const generationErrors: GenerationError[] = [];

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
    // Exposed as sliders in T23; null rather than a fabricated default set.
    policyWeights: null,
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
    baseline: baseline ?? null,
    contestableTaskIds,
    comparisonToBaseline: baseline ? buildComparison(optimized, baseline) : null,
    inputSummary: {
      taskCount: gathered.taskCount,
      corridorCount: gathered.corridorCount,
      prioritySource: priorityQueue ? 'fr2.3-priority-engine' : 'severity-fallback',
    },
    generationErrors,
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
      'Do not lead with a scheduled-task count: on this dataset both engines schedule the ' +
        'same work. The real difference is that the baseline double-books corridors and ' +
        'cannot batch across departments.',
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
