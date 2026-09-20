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
  type OptimizerTask,
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

  // SIH problem statement 26027's own headline goal ("maximize asset
  // availability"), not just block utilisation - computed here rather than
  // by the optimizer because the task->asset join it needs only Node has
  // (OptimizerTask carries no assetId - see optimizerClient.ts).
  const assetAvailability = await computeAssetAvailability(optimized, gathered.corridorCount);

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
    assetAvailability,
    contestableTaskIds,
    comparisonToBaseline: baseline
      ? buildComparison(optimized, baseline, payload.tasks, riskResult.framing)
      : null,
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
  /**
   * T29 Phase 1 (D-084). How many of `splitOnlyTaskCount` this engine
   * actually placed. Structurally 0 for the baseline, always - it has no
   * splitting concept at all, not merely a lower success rate.
   */
  splitOnlyScheduled: number;
  crossDepartmentBatches: number;
  doubleBookings: number;
  doubleBookedMinutes: number;
  overSubscribedWindows: number;
  blockMinutesUsed: number;
  blockUtilisationPct: number;
  /**
   * D-093. The ν objective term's own proxy (fewer, fuller possessions) -
   * already computed identically by both engines' `metrics()`, just not
   * previously carried into the comparison.
   */
  blocksUsed: number;
  /**
   * D-093. Of the contestable tasks THIS engine scheduled, how many landed
   * on or before their real `slaDueDate`. A split task's LAST segment
   * decides it, matching the optimizer's own `within_sla` CP-SAT variable
   * exactly (`scheduler.py`'s `last_window.day <= task.sla_due_date`).
   */
  contestableWithinSla: number;
  /** D-093. Of `BaselineComparison.criticalContestableCount`, how many did this engine schedule. */
  criticalScheduled: number;
  /**
   * D-093. Of `BaselineComparison.highRiskContestableCount`, how many did
   * this engine schedule. Always 0 when `riskFraming` is null - never
   * render this number without that framing alongside it (PRD 9.1).
   */
  highRiskScheduled: number;
}

export interface BaselineComparison {
  contestableTaskCount: number;
  /**
   * T29 Phase 1 (docs/DECISIONS.md D-084). Tasks that fit no single window
   * (so are NOT in `contestableTaskCount`) but that the optimizer can place
   * by splitting work across non-contiguous sessions - a capability the
   * baseline structurally does not have. Reported separately, never folded
   * into `contestableTaskCount`: doing so would imply the baseline could
   * also do this work, which it cannot, at any horizon length.
   */
  splitOnlyTaskCount: number;
  structurallyImpossibleCount: number;
  /**
   * D-093 - priority coverage's fixed denominator. Severity 5 is PRD 5.2's
   * own discrete "critical" defect-severity bucket, not a top-N cut of the
   * continuous `priorityScore` - so it needs no calibration argument, and
   * is identical for both engines by construction (a fact about the task,
   * not about who schedules it).
   */
  criticalContestableCount: number;
  /**
   * D-093 - risk reduction's fixed denominator. The top quartile by
   * `failureRiskScore` among contestable tasks the model actually scored -
   * a RELATIVE cut, since the calibrated probability `risk.py` produces has
   * no absolute "this is high risk" line named anywhere in PRD 9.1 or the
   * model itself. 0 whenever `riskFraming` is null (no task this generation
   * carries a real score).
   */
  highRiskContestableCount: number;
  /**
   * D-093 - `risk.py`'s PRD 9.1 FRAMING, carried through verbatim (never
   * paraphrased - NG4). Null whenever no task in this generation carries a
   * real risk score (the /risk call was skipped or failed - see
   * `applyAssetRisk`'s `empty` return) - the frontend must never render
   * `highRiskContestableCount`/`highRiskScheduled` without this alongside.
   */
  riskFraming: string | null;
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
 *   1. Some tasks fit no window on their corridor and are impossible for
 *      either algorithm, so the comparison is drawn from the contestable
 *      subset. Using the full backlog would credit the optimizer for work
 *      nothing could have placed.
 *   2. The baseline's utilisation is HIGHER, because it over-subscribes
 *      windows. Rendered alone it reads as the baseline winning.
 *
 * T29 Phase 1 added a THIRD structural category (D-084), because splitting
 * genuinely split D-024's old binary in two: a task that fits no single
 * window is no longer automatically impossible for the OPTIMIZER, even
 * though it stays impossible for the baseline (which never splits, by
 * design - D-082). Reporting that gap silently as still "impossible for
 * both" would understate the optimizer's real, demonstrated capability -
 * exactly the opposite failure mode from crediting it with work neither
 * could do, and just as dishonest. `splitOnlyTaskCount` names it explicitly
 * rather than letting it hide inside `structurallyImpossibleCount`.
 */
function buildComparison(
  optimized: OptimizedSchedule,
  baseline: BaselineSchedule,
  // D-093: the exact task list both engines solved against - real slaDueDate/
  // severity/failureRiskScore, already gathered once for the /optimize and
  // /baseline requests themselves, so no extra join or optimizer call is
  // needed to add the four KPIs below.
  tasks: OptimizerTask[],
  riskFraming: string | null,
): BaselineComparison {
  const contestable = new Set(baseline.contestableTaskIds ?? []);
  const splitOnly = new Set(baseline.splitOnlyTaskIds ?? []);
  const scheduledMatching = (
    result: { blocks: Array<{ taskIds: string[] }> },
    ids: Set<string>,
  ): Set<string> =>
    new Set(result.blocks.flatMap((block) => block.taskIds).filter((id) => ids.has(id)));

  const optimizedScheduled = scheduledMatching(optimized, contestable);
  const baselineScheduled = scheduledMatching(baseline, contestable);
  const optimizedSplitOnly = scheduledMatching(optimized, splitOnly);
  const baselineSplitOnly = scheduledMatching(baseline, splitOnly);

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

  // T29 Phase 1 (D-084): a real, load-bearing distinction, not a footnote -
  // only added when the set is non-empty, since an older/pre-T29 schedule's
  // baseline response has no `splitOnlyTaskIds` at all and should not carry
  // a caveat about a capability that generation never considered.
  const splitOnlyCaveat =
    splitOnly.size > 0
      ? `${splitOnly.size} further task(s) fit no single window but ARE placeable by the ` +
        `optimizer via splitting work across non-contiguous sessions (T29 Phase 1) - a ` +
        `capability this baseline process structurally does not have, at any horizon length. ` +
        `The optimizer places ${optimizedSplitOnly.size} of them here. Never counted inside ` +
        `the ${contestable.size}-task contestable comparison above: crediting the baseline ` +
        `with a capability it does not have would be its own kind of misleading comparison.`
      : null;

  const totalTasks = (optimized.metrics.tasksScheduled ?? 0) + (optimized.metrics.tasksDeferred ?? 0);

  // D-093: SLA compliance, computed from block dates directly rather than
  // re-reading decisionLog's loosely-typed `contributingFactors` - the SAME
  // logic then works for the baseline, whose decision log never carried a
  // `withinSla` flag at all. A split task's LAST segment decides it, exactly
  // matching scheduler.py's `within_sla` CP-SAT variable
  // (`last_window.day <= task.sla_due_date`).
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));

  const latestScheduledDateByTask = (
    blocks: Array<{ date: string; taskIds: string[] }>,
  ): Map<string, string> => {
    const latest = new Map<string, string>();
    for (const block of blocks) {
      for (const taskId of block.taskIds) {
        const current = latest.get(taskId);
        // ISO date strings (YYYY-MM-DD) compare correctly lexicographically.
        if (!current || block.date > current) latest.set(taskId, block.date);
      }
    }
    return latest;
  };
  const optimizedLatestDate = latestScheduledDateByTask(optimized.blocks);
  const baselineLatestDate = latestScheduledDateByTask(baseline.blocks);

  const countWithinSla = (scheduled: Set<string>, latestDate: Map<string, string>): number => {
    let count = 0;
    for (const taskId of scheduled) {
      const date = latestDate.get(taskId);
      const task = taskById.get(taskId);
      if (date && task && date <= task.slaDueDate) count += 1;
    }
    return count;
  };

  // D-093: priority coverage. PRD 5.2's severity scale is 1-5, but the real
  // fulldata-ktv-psa corpus contains zero severity-5 defects (max observed:
  // 4, on 59 of 935 real tasks) - a severity-5-only bucket would be a
  // permanent, silent 0/0 on the actual demo dataset, not a rare edge case.
  // Widened to severity >= 4 ("high severity", the top real band) so the
  // card reports something on the corpus this ships against; still a fixed
  // discrete PRD band, not a top-N cut of a continuous score, and identical
  // for both engines by construction (a fact about the task, not about who
  // schedules it).
  const criticalIds = new Set(
    tasks.filter((task) => contestable.has(task.taskId) && task.severity >= 4).map((task) => task.taskId),
  );
  const countMatching = (scheduled: Set<string>, ids: Set<string>): number => {
    let count = 0;
    for (const taskId of scheduled) if (ids.has(taskId)) count += 1;
    return count;
  };

  // D-093: risk reduction. "Flagged high-risk" is the top quartile by
  // `failureRiskScore` among contestable tasks the model actually scored -
  // relative, not an absolute cutoff, since the calibrated probability has
  // no PRD- or model-named "high risk" line to draw one against. Empty
  // whenever `riskFraming` is null, so the frontend never has a nonzero
  // count with nothing to caveat it.
  const scoredContestable = riskFraming
    ? tasks
        .filter((task) => contestable.has(task.taskId) && task.failureRiskScore !== null)
        .sort((a, b) => (b.failureRiskScore ?? 0) - (a.failureRiskScore ?? 0))
    : [];
  const highRiskIds = new Set(
    scoredContestable.slice(0, Math.ceil(scoredContestable.length * 0.25)).map((task) => task.taskId),
  );

  return {
    contestableTaskCount: contestable.size,
    splitOnlyTaskCount: splitOnly.size,
    // Genuinely impossible for EITHER engine, even considering splitting -
    // corrected from the pre-T29 arithmetic that only ever subtracted the
    // contestable set, silently miscounting every split-only task as
    // "impossible for both" (D-084).
    structurallyImpossibleCount: totalTasks - contestable.size - splitOnly.size,
    criticalContestableCount: criticalIds.size,
    highRiskContestableCount: highRiskIds.size,
    riskFraming,
    optimized: {
      contestableScheduled: optimizedScheduled.size,
      splitOnlyScheduled: optimizedSplitOnly.size,
      crossDepartmentBatches: optimized.metrics.crossDepartmentBatches ?? 0,
      doubleBookings: 0,
      doubleBookedMinutes: 0,
      overSubscribedWindows: 0,
      blockMinutesUsed: optimized.metrics.blockMinutesUsed ?? 0,
      blockUtilisationPct: optimized.metrics.blockUtilisationPct ?? 0,
      blocksUsed: optimized.metrics.blocksUsed ?? 0,
      contestableWithinSla: countWithinSla(optimizedScheduled, optimizedLatestDate),
      criticalScheduled: countMatching(optimizedScheduled, criticalIds),
      highRiskScheduled: countMatching(optimizedScheduled, highRiskIds),
    },
    baseline: {
      contestableScheduled: baselineScheduled.size,
      splitOnlyScheduled: baselineSplitOnly.size,
      crossDepartmentBatches: baseline.metrics.crossDepartmentBatches ?? 0,
      doubleBookings: baseline.metrics.doubleBookings ?? 0,
      doubleBookedMinutes: baseline.metrics.doubleBookedMinutes ?? 0,
      overSubscribedWindows: baseline.metrics.overSubscribedWindows ?? 0,
      blockMinutesUsed: baseline.metrics.blockMinutesUsed ?? 0,
      blockUtilisationPct: baseline.metrics.blockUtilisationPct ?? 0,
      blocksUsed: baseline.metrics.blocksUsed ?? 0,
      contestableWithinSla: countWithinSla(baselineScheduled, baselineLatestDate),
      criticalScheduled: countMatching(baselineScheduled, criticalIds),
      highRiskScheduled: countMatching(baselineScheduled, highRiskIds),
    },
    // Not decoration. A screen that renders the numbers without these is
    // making a claim the data does not support (D-031).
    caveats: [
      'Counts are drawn from the structurally contestable subset - tasks that fit a single ' +
        'window and so are placeable by either algorithm. Tasks that fit no combination of ' +
        'windows at all, even considering splitting, are genuinely impossible for both ' +
        'algorithms and are excluded here.',
      ...(splitOnlyCaveat ? [splitOnlyCaveat] : []),
      throughputCaveat,
      "Baseline block utilisation is HIGHER than the optimizer's because it over-subscribes " +
        'windows. Never render utilisation without the double-booking count beside it.',
    ],
  };
}

/** Lowest-availability assets kept per plan - see ISchedule.assetAvailability. */
const WORST_ASSETS_LIMIT = 50;

/**
 * SIH problem statement 26027's headline goal is to "maximize asset
 * availability", not just block utilisation - `blockUtilisationPct` measures
 * how much of the ALLOCATED maintenance window got used, which is a
 * different question from how much of the day an asset stayed available for
 * train operations. This answers that second question instead.
 *
 * `overallPct` is corridor-wide (1 - total block minutes used across every
 * corridor / (corridor count * horizon minutes)). `worstAssets` goes one
 * level deeper than the corridor aggregate the rest of this file works at:
 * a corridor's block window can serve ONE asset while every other asset on
 * that corridor stays fully available, so each asset's own downtime is
 * summed from the tasks actually scheduled against it (via Task.assetId -
 * OptimizerTask carries no assetId, so this join can only happen here, not
 * in the optimizer), not the corridor's block time. Capped at
 * WORST_ASSETS_LIMIT - the lowest-availability assets, which is what a
 * Controller actually needs to see, not a dump of every touched asset.
 */
async function computeAssetAvailability(
  optimized: OptimizedSchedule,
  corridorCount: number,
): Promise<NonNullable<ISchedule['assetAvailability']>> {
  const horizonMinutes = optimized.horizonDays * 1440;
  const corridorMinutesCapacity = corridorCount * horizonMinutes;
  const blockMinutesUsed = optimized.metrics.blockMinutesUsed ?? 0;
  const overallPct = round2(
    corridorMinutesCapacity > 0 ? 100 * (1 - blockMinutesUsed / corridorMinutesCapacity) : 100,
  );

  const scheduledTaskIds = Array.from(new Set(optimized.blocks.flatMap((block) => block.taskIds ?? [])));
  if (scheduledTaskIds.length === 0) {
    return { overallPct, corridorMinutesCapacity, assetsTouched: 0, worstAssets: [] };
  }

  const scheduledTasks = await Task.find({ _id: { $in: scheduledTaskIds } })
    .select('_id assetId estBlockDurationMins')
    .lean();

  const minutesByAsset = new Map<string, number>();
  for (const task of scheduledTasks) {
    if (!task.assetId) continue;
    minutesByAsset.set(
      task.assetId,
      (minutesByAsset.get(task.assetId) ?? 0) + (task.estBlockDurationMins ?? 0),
    );
  }

  const touchedAssets = await Asset.find({ _id: { $in: Array.from(minutesByAsset.keys()) } })
    .select('_id corridorId department blockSection')
    .lean();
  const assetById = new Map(touchedAssets.map((asset) => [asset._id, asset]));

  const worstAssets = Array.from(minutesByAsset.entries())
    .map(([assetId, scheduledMinutes]) => {
      const asset = assetById.get(assetId);
      return {
        assetId,
        corridorId: asset?.corridorId ?? 'unknown',
        department: asset?.department ?? null,
        blockSection: asset?.blockSection ?? null,
        scheduledMinutes,
        availabilityPct: round2(100 * (1 - scheduledMinutes / horizonMinutes)),
      };
    })
    .sort((a, b) => a.availabilityPct - b.availabilityPct)
    .slice(0, WORST_ASSETS_LIMIT);

  return {
    overallPct,
    corridorMinutesCapacity,
    assetsTouched: minutesByAsset.size,
    worstAssets,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Most recently generated schedule, or null if none exists.
 *
 * `horizonDays`, when given, scopes this to the latest plan generated AT
 * that horizon specifically, rather than the latest plan overall. This is
 * what lets the frontend keep an independent "current plan" per horizon
 * (weekly vs monthly) - pre-solving one in the background no longer steals
 * the other's "latest" pointer, which previously made switching horizons
 * either re-solve every time or silently show the wrong horizon's plan
 * (dashboard UX fix, deferred work session - no PRD task #).
 */
export function findLatestSchedule(horizonDays?: number): Promise<ISchedule | null> {
  return Schedule.findOne(horizonDays ? { horizonDays } : {})
    .sort({ generatedAt: -1 })
    .lean<ISchedule | null>()
    .exec();
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
