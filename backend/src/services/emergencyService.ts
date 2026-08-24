/**
 * Emergency rolling re-optimization - PRD FR3.5, 9.10, task T27.
 *
 * Unlike T20's what-if (D-064, no persistence of any kind), this COMMITS: the
 * result is saved as a new schedule, the same way `generateSchedule` saves one
 * (D-034 - a schedule is an event that happened, and an emergency re-solve is
 * one). What makes it "emergency" rather than an ordinary regenerate is scope,
 * not commitment: the optimizer re-solves only the affected corridor's
 * remaining time, holding every other corridor and everything already
 * executed on this one to their EXACT current placement (see
 * `app/core/emergency.py` for why "an unplanned event consumes part of the
 * corridor's remaining calendar" was the reading chosen over "a new task
 * needs a window right now" - docs/DECISIONS.md D-069).
 *
 * CURRENT PLACEMENTS COME FROM THE EFFECTIVE PLAN, NOT A FRESH SOLVE
 * --------------------------------------------------------------------
 * `runWhatIf` (T20) recomputes a fresh baseline via a plain re-solve, which is
 * fine for a hypothetical that need not reflect every manual tweak. This
 * would be a real bug here: the plan being amended may already carry T15
 * overrides, and pinning against a freshly-resolved baseline instead of
 * `getEffectivePlan`'s replayed result would silently discard them the moment
 * an emergency hit - the exact failure D-044 already guards against for
 * override validation, in a new place.
 *
 * NO NEW WORKFLOW GATE
 * ----------------------
 * `assertOverridable` (T19) refuses a WRITE onto a published or rejected
 * schedule's own history, and its refusal message already says what to do
 * instead: "Generate a new plan - it becomes the next version." An emergency
 * re-solve never writes onto the source schedule at all - it reads
 * `effectivePlan` and creates an independent new document, exactly the
 * "generate a new plan" T19 already points to, just triggered by a
 * disruption instead of a manual click. So this deliberately does not call
 * `assertOverridable`: there is nothing here for it to gate.
 */
import {
  requestEmergencyReoptimize,
  type EmergencyCurrentPlacement,
  type EmergencyDisruptedWindow,
} from './optimizerClient.js';
import { gatherScenario } from './scheduleGathering.js';
import { findScheduleById } from './scheduleOrchestrator.js';
import { getEffectivePlan } from './scheduleOverrides.js';
import { Schedule, type EmergencyContext, type ISchedule } from '../models/index.js';
import { logger } from '../utils/logger.js';

export interface EmergencyReoptimizeOptions {
  scheduleId: string;
  corridorId: string;
  disruptedWindows: EmergencyDisruptedWindow[];
  reason: string;
}

/**
 * Re-solve one corridor's remaining time around a disruption and persist the
 * result as a new schedule.
 *
 * Reads the CURRENT live backlog (same choice T20 makes, D-064's reasoning
 * about "the live data, not a frozen snapshot" applies here too) and the
 * REFERENCED schedule's own `policyWeights` and effective plan - so the
 * re-solve amends what is really committed, not a plan nobody is actually
 * running.
 */
export async function runEmergencyReoptimization({
  scheduleId,
  corridorId,
  disruptedWindows,
  reason,
}: EmergencyReoptimizeOptions): Promise<ISchedule> {
  const schedule = await findScheduleById(scheduleId);
  const { effectivePlan } = await getEffectivePlan(scheduleId);
  const { payload } = await gatherScenario({
    horizonStart: schedule.horizonStart,
    horizonDays: schedule.horizonDays,
  });

  const currentPlacements: EmergencyCurrentPlacement[] = effectivePlan.blocks.flatMap((block) =>
    block.taskIds.map((taskId) => ({
      taskId,
      corridorId: block.corridorId,
      date: block.date,
      windowIndex: block.windowIndex,
    })),
  );

  const result = await requestEmergencyReoptimize({
    ...payload,
    ...(schedule.policyWeights ? { policyWeights: schedule.policyWeights } : {}),
    corridorId,
    currentPlacements,
    disruptedWindows,
    reason,
  });

  const newScheduleId = `SCH-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}`;
  const emergencyContext: EmergencyContext = {
    sourceScheduleId: scheduleId,
    ...result.emergencyContext,
  };

  const document: ISchedule = {
    _id: newScheduleId,
    horizon: result.horizon,
    horizonStart: result.horizonStart,
    horizonDays: result.horizonDays,
    generatedAt: new Date(),
    policyWeights: result.policyWeights,
    status: result.status,
    objectiveValue: result.objectiveValue,
    solveSeconds: result.solveSeconds,
    metrics: result.metrics,
    blocks: result.blocks,
    deferredTasks: result.deferredTasks,
    decisionLog: result.decisionLog,
    knownGaps: result.knownGaps,
    conflictReport: result.conflictReport ?? null,
    // Not recomputed: this is a narrow amendment to one corridor, not a full
    // regeneration - re-running the whole-corpus baseline/priority calls
    // would be real work spent on a comparison nobody asked for. `null`
    // here means "not computed for this plan", the same honest absence
    // `riskModel`/`baseline` already carry when their own best-effort call
    // fails (D-036), not a claim that they came out empty.
    riskModel: null,
    baseline: null,
    comparisonToBaseline: null,
    contestableTaskIds: [],
    inputSummary: {
      taskCount: payload.tasks.length,
      corridorCount: payload.corridors.length,
      prioritySource: 'not-recomputed-emergency-reoptimization',
    },
    generationErrors: [],
    emergencyContext,
  };

  const saved = await Schedule.create(document);

  logger.info('emergency reoptimization generated', {
    sourceScheduleId: scheduleId,
    newScheduleId,
    corridorId,
    disruptedWindows: disruptedWindows.length,
    status: result.status,
  });

  return saved.toObject();
}
