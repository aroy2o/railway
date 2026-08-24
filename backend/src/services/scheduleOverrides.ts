/**
 * Recording and replaying manual overrides - PRD FR6.2.
 *
 * The database half of the feature; the reasoning lives in overrideEngine.ts,
 * which is pure and unit-tested. Overrides are appended, never edited, and the
 * schedule document is never mutated (D-043).
 */
import { CorridorCalendar, Schedule, ScheduleOverride, Task } from '../models/index.js';
import type { IScheduleOverride, OverrideAssignment } from '../models/ScheduleOverride.js';
import type { ISchedule } from '../models/Schedule.js';
import {
  applyOverrides,
  findPlacement,
  horizonDates,
  validateMove,
  type CorridorWindow,
  type EffectivePlan,
} from './overrideEngine.js';
import { assertOverridable } from './workflowState.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

export interface OverrideRequest {
  scheduleId: string;
  taskId: string;
  action: 'move' | 'defer';
  targetDate?: string;
  targetWindowIndex?: number;
  reason: string;
  actorRole?: string;
}

export interface EffectivePlanResult {
  schedule: ISchedule;
  overrides: IScheduleOverride[];
  effectivePlan: EffectivePlan;
}

async function loadDurations(taskIds: string[]): Promise<Map<string, number>> {
  const tasks = await Task.find({ _id: { $in: taskIds } })
    .select('_id estBlockDurationMins corridorId')
    .lean();
  return new Map(tasks.map((task) => [task._id, task.estBlockDurationMins]));
}

/** The schedule, its overrides, and the plan as it now stands. */
export async function getEffectivePlan(scheduleId: string): Promise<EffectivePlanResult> {
  const schedule = await Schedule.findById(scheduleId).lean<ISchedule | null>().exec();
  if (!schedule) throw ApiError.notFound(`No schedule ${scheduleId}`);

  const overrides = await ScheduleOverride.find({ scheduleId })
    .sort({ createdAt: 1 })
    .lean<IScheduleOverride[]>()
    .exec();

  const taskIds = [
    ...new Set([
      ...schedule.blocks.flatMap((block) => block.taskIds),
      ...overrides.map((override) => override.taskId),
    ]),
  ];
  const durations = await loadDurations(taskIds);

  return { schedule, overrides, effectivePlan: applyOverrides(schedule.blocks, overrides, durations) };
}

/**
 * Validate and record one override.
 *
 * A rejected move is still an ApiError rather than a stored record: FR6.2 wants
 * an audit trail of what was *changed*, and refusing an invalid change is not a
 * change. The rejection detail names the specific check that failed.
 */
export async function recordOverride(request: OverrideRequest): Promise<IScheduleOverride> {
  const { schedule, overrides, effectivePlan } = await getEffectivePlan(request.scheduleId);

  // T19: a published plan is frozen and a rejected one is discarded. This is a
  // gate in front of T15's logic, not a change to it - everything below runs
  // exactly as it did before.
  await assertOverridable(request.scheduleId);

  const task = await Task.findById(request.taskId).lean();
  if (!task) throw ApiError.notFound(`No task ${request.taskId}`);

  const inSchedule =
    schedule.blocks.some((block) => block.taskIds.includes(request.taskId)) ||
    schedule.deferredTasks.some((deferred) => deferred.taskId === request.taskId);
  if (!inSchedule) {
    throw ApiError.conflict(
      `Task ${request.taskId} is not part of schedule ${request.scheduleId}, so there is ` +
        `nothing to override.`,
    );
  }

  // The solver's own placement, preserved even after repeated overrides (FR6.2).
  const originalAiAssignment = findPlacement(
    { blocks: schedule.blocks, deferredTaskIds: [] },
    request.taskId,
  );
  const fromAssignment = findPlacement(effectivePlan, request.taskId);

  let newAssignment: OverrideAssignment | null = null;
  let revalidation: IScheduleOverride['revalidation'];

  if (request.action === 'defer') {
    if (!fromAssignment) {
      throw ApiError.conflict(`Task ${request.taskId} is already deferred in this plan.`);
    }
    // Deferring frees capacity rather than consuming it, so it cannot break a
    // constraint. Recorded as a passed check so the audit shows what was
    // considered rather than an empty result.
    revalidation = {
      constraintsSatisfied: true,
      checks: [
        {
          check: 'defer-releases-capacity',
          passed: true,
          detail:
            `Removing ${request.taskId} from ${fromAssignment.corridorId} on ` +
            `${fromAssignment.date} releases ${task.estBlockDurationMins} min and cannot ` +
            `violate a capacity or overlap constraint.`,
        },
      ],
      trainImpactDelta: null,
    };
  } else {
    if (!request.targetDate || request.targetWindowIndex === undefined) {
      throw ApiError.badRequest('A move requires targetDate and targetWindowIndex.');
    }

    const calendar = await CorridorCalendar.findById(task.corridorId).lean();
    const corridorWindows: CorridorWindow[] = (calendar?.maxDailyBlockWindows ?? []).map(
      (window) => ({
        start: window.start,
        end: window.end,
        startMin: window.startMin,
        endMin: window.endMin,
        durationMin: window.durationMin,
      }),
    );

    const result = validateMove({
      taskId: request.taskId,
      taskCorridorId: task.corridorId,
      taskDurationMinutes: task.estBlockDurationMins,
      // Cross-corridor moves are refused by the engine; the target corridor is
      // always the task's own.
      targetCorridorId: task.corridorId,
      targetDate: request.targetDate,
      targetWindowIndex: request.targetWindowIndex,
      corridorWindows,
      horizonDates: horizonDates(schedule.horizonStart, schedule.horizonDays),
      effectivePlan,
    });

    if (!result.revalidation.constraintsSatisfied) {
      const failed = result.revalidation.checks.find((check) => !check.passed);
      throw ApiError.conflict(failed?.detail ?? 'Re-validation failed.', {
        details: { revalidation: result.revalidation },
      });
    }

    newAssignment = result.assignment;
    revalidation = result.revalidation;
  }

  const override: IScheduleOverride = {
    _id: `OVR-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}-${request.taskId}`,
    scheduleId: request.scheduleId,
    taskId: request.taskId,
    action: request.action,
    originalAiAssignment,
    fromAssignment,
    newAssignment,
    reason: request.reason,
    revalidation,
    actorRole: request.actorRole ?? 'controller',
    createdAt: new Date(),
  };

  const saved = await ScheduleOverride.create(override);
  logger.info('override recorded', {
    scheduleId: request.scheduleId,
    taskId: request.taskId,
    action: request.action,
    overrideCount: overrides.length + 1,
  });

  return saved.toObject();
}

export function listOverrides(scheduleId: string): Promise<IScheduleOverride[]> {
  return ScheduleOverride.find({ scheduleId })
    .sort({ createdAt: 1 })
    .lean<IScheduleOverride[]>()
    .exec();
}

/**
 * Windows a task could legally be moved into.
 *
 * Runs the same validator the write path uses, so the list a Controller is
 * offered can never contain an option the write path would then refuse.
 */
export async function listValidTargets(
  scheduleId: string,
  taskId: string,
): Promise<Array<{ date: string; windowIndex: number; start: string; end: string; freeMinutes: number }>> {
  const { schedule, effectivePlan } = await getEffectivePlan(scheduleId);
  const task = await Task.findById(taskId).lean();
  if (!task) throw ApiError.notFound(`No task ${taskId}`);

  const calendar = await CorridorCalendar.findById(task.corridorId).lean();
  const corridorWindows: CorridorWindow[] = (calendar?.maxDailyBlockWindows ?? []).map((w) => ({
    start: w.start,
    end: w.end,
    startMin: w.startMin,
    endMin: w.endMin,
    durationMin: w.durationMin,
  }));
  const dates = horizonDates(schedule.horizonStart, schedule.horizonDays);

  const options = [];
  for (const date of dates) {
    for (let index = 0; index < corridorWindows.length; index += 1) {
      const result = validateMove({
        taskId,
        taskCorridorId: task.corridorId,
        taskDurationMinutes: task.estBlockDurationMins,
        targetCorridorId: task.corridorId,
        targetDate: date,
        targetWindowIndex: index,
        corridorWindows,
        horizonDates: dates,
        effectivePlan,
      });
      if (!result.revalidation.constraintsSatisfied || !result.assignment) continue;

      const block = effectivePlan.blocks.find(
        (b) => b.date === date && b.windowIndex === index && b.corridorId === task.corridorId,
      );
      options.push({
        date,
        windowIndex: index,
        start: result.assignment.start,
        end: result.assignment.end,
        freeMinutes: (corridorWindows[index]!.durationMin) - (block?.usedMinutes ?? 0),
      });
    }
  }
  return options;
}
