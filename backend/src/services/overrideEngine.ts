/**
 * Applying and validating manual overrides - PRD FR6.2.
 *
 * Pure functions over plain data: no Mongoose, no I/O. The re-validation logic
 * is the part of this feature where a bug is dangerous, so it is written to be
 * unit-testable directly rather than only through an endpoint.
 *
 * THE DIRECTION THAT MATTERS
 * --------------------------
 * A validator that wrongly REJECTS fails loudly - a Controller sees an error
 * and complains. A validator that wrongly ACCEPTS fails silently, producing a
 * plan that looks valid and cannot be executed. Everything here is written
 * against the second failure mode.
 *
 * The specific trap: capacity must be checked against the EFFECTIVE plan
 * (base + every prior override), never against the solver's original blocks. A
 * validator reading the original blocks would not see work an earlier override
 * moved into the target window, and would happily accept a move that
 * over-fills it. There is a dedicated adversarial test for exactly this.
 */
import type { ScheduleBlock } from '../models/Schedule.js';
import type {
  IScheduleOverride,
  OverrideAssignment,
  RevalidationCheck,
  RevalidationResult,
} from '../models/ScheduleOverride.js';

/** A free window on a corridor, as stored by T3. */
export interface CorridorWindow {
  start: string;
  end: string;
  startMin: number;
  endMin: number;
  durationMin: number;
}

export interface EffectivePlan {
  blocks: ScheduleBlock[];
  /** Tasks removed from the plan by a `defer` override. */
  deferredTaskIds: string[];
}

function clone(block: ScheduleBlock): ScheduleBlock {
  return { ...block, taskIds: [...block.taskIds], departments: [...block.departments] };
}

function blockKey(corridorId: string, date: string, windowIndex: number): string {
  return `${corridorId}|${date}|${windowIndex}`;
}

/**
 * Replay overrides over the solver's plan to get the plan as it stands now.
 *
 * Order matters and is creation order, so the result is deterministic and a
 * task can be moved more than once - each override acting on the placement the
 * previous one produced.
 */
export function applyOverrides(
  baseBlocks: ScheduleBlock[],
  overrides: IScheduleOverride[],
  durationByTask: Map<string, number>,
): EffectivePlan {
  const blocks = new Map<string, ScheduleBlock>();
  for (const block of baseBlocks) {
    blocks.set(blockKey(block.corridorId, block.date, block.windowIndex), clone(block));
  }
  const deferred = new Set<string>();

  const departmentOf = (block: ScheduleBlock, taskId: string): string | undefined => {
    const at = block.taskIds.indexOf(taskId);
    return at === -1 ? undefined : block.departments[at];
  };

  for (const override of overrides) {
    // 1. Lift the task out of wherever it currently sits.
    let department: string | undefined;
    for (const [key, block] of blocks) {
      const at = block.taskIds.indexOf(override.taskId);
      if (at === -1) continue;
      department = departmentOf(block, override.taskId);
      block.taskIds.splice(at, 1);
      block.departments.splice(at, 1);
      block.usedMinutes = (block.usedMinutes ?? 0) - (durationByTask.get(override.taskId) ?? 0);
      block.unusedMinutes = (block.capacityMinutes ?? 0) - block.usedMinutes;
      block.isCrossDepartmentBatch = new Set(block.departments).size > 1;
      // An emptied window is a possession no longer taken - drop it rather
      // than leaving a zero-task block in the plan.
      if (block.taskIds.length === 0) blocks.delete(key);
      break;
    }

    if (override.action === 'defer') {
      deferred.add(override.taskId);
      continue;
    }

    const target = override.newAssignment;
    if (!target) continue;
    deferred.delete(override.taskId);

    // 2. Put it into the target window, opening that window if needed.
    const key = blockKey(target.corridorId, target.date, target.windowIndex);
    const duration = durationByTask.get(override.taskId) ?? 0;
    const existing = blocks.get(key);

    if (existing) {
      existing.taskIds.push(override.taskId);
      existing.departments.push((department ?? 'Engineering') as ScheduleBlock['departments'][number]);
      existing.usedMinutes = (existing.usedMinutes ?? 0) + duration;
      existing.unusedMinutes = (existing.capacityMinutes ?? 0) - existing.usedMinutes;
      existing.isCrossDepartmentBatch = new Set(existing.departments).size > 1;
    } else {
      blocks.set(key, {
        corridorId: target.corridorId,
        date: target.date,
        windowIndex: target.windowIndex,
        start: target.start,
        end: target.end,
        startMinute: target.startMinute,
        endMinute: target.endMinute,
        capacityMinutes: target.capacityMinutes,
        usedMinutes: duration,
        unusedMinutes: target.capacityMinutes - duration,
        taskIds: [override.taskId],
        departments: [(department ?? 'Engineering') as ScheduleBlock['departments'][number]],
        isCrossDepartmentBatch: false,
        trainImpact: null,
      });
    }
  }

  return {
    blocks: [...blocks.values()].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.corridorId.localeCompare(b.corridorId) ||
        (a.startMinute ?? 0) - (b.startMinute ?? 0),
    ),
    deferredTaskIds: [...deferred].sort(),
  };
}

/** Where a task currently sits in a given plan, or null if it is not placed. */
export function findPlacement(plan: EffectivePlan, taskId: string): OverrideAssignment | null {
  for (const block of plan.blocks) {
    if (!block.taskIds.includes(taskId)) continue;
    return {
      corridorId: block.corridorId,
      date: block.date,
      windowIndex: block.windowIndex,
      start: block.start ?? '',
      end: block.end ?? '',
      startMinute: block.startMinute ?? 0,
      endMinute: block.endMinute ?? 0,
      capacityMinutes: block.capacityMinutes ?? 0,
    };
  }
  return null;
}

export interface ValidateMoveInput {
  taskId: string;
  taskCorridorId: string;
  taskDurationMinutes: number;
  targetCorridorId: string;
  targetDate: string;
  targetWindowIndex: number;
  /** The corridor's free windows, from T3's calendar. */
  corridorWindows: CorridorWindow[];
  /** Dates the schedule covers, so a move cannot land outside the horizon. */
  horizonDates: string[];
  /** Base plus every prior override - NOT the solver's original blocks. */
  effectivePlan: EffectivePlan;
}

export interface ValidateMoveOutput {
  revalidation: RevalidationResult;
  /** Present only when every check passed. */
  assignment: OverrideAssignment | null;
}

/**
 * Re-validate a proposed move against the same constraints the solver honoured.
 *
 * Every check is reported, passed or failed, so the Controller sees what was
 * actually verified rather than a bare accept/reject.
 */
export function validateMove(input: ValidateMoveInput): ValidateMoveOutput {
  const checks: RevalidationCheck[] = [];
  const fail = (check: string, detail: string): ValidateMoveOutput => {
    checks.push({ check, passed: false, detail });
    return {
      revalidation: { constraintsSatisfied: false, checks, trainImpactDelta: null },
      assignment: null,
    };
  };
  const pass = (check: string, detail: string): void => {
    checks.push({ check, passed: true, detail });
  };

  // 1. A defect is physically on its corridor. Moving the work to a different
  //    corridor would not move the rail that is cracked, so it is refused
  //    outright rather than treated as a capacity question.
  if (input.targetCorridorId !== input.taskCorridorId) {
    return fail(
      'same-corridor',
      `Task ${input.taskId} is on ${input.taskCorridorId}; work cannot be moved to ` +
        `${input.targetCorridorId} because the asset does not move with it.`,
    );
  }
  pass('same-corridor', `Target is on the task's own corridor ${input.taskCorridorId}.`);

  // 2. Within the plan's horizon.
  if (!input.horizonDates.includes(input.targetDate)) {
    return fail(
      'within-horizon',
      `${input.targetDate} is outside this plan's horizon (${input.horizonDates[0]} to ` +
        `${input.horizonDates[input.horizonDates.length - 1]}).`,
    );
  }
  pass('within-horizon', `${input.targetDate} is inside the plan's horizon.`);

  // 3. The window has to be one the timetable actually leaves free.
  const window = input.corridorWindows[input.targetWindowIndex];
  if (!window) {
    return fail(
      'window-exists',
      `Window ${input.targetWindowIndex} does not exist on ${input.targetCorridorId}; ` +
        `the corridor has ${input.corridorWindows.length} free window(s) per day.`,
    );
  }
  pass(
    'window-exists',
    `Window ${input.targetWindowIndex} (${window.start}-${window.end}) is a real free window.`,
  );

  const current = findPlacement(input.effectivePlan, input.taskId);
  if (
    current &&
    current.date === input.targetDate &&
    current.windowIndex === input.targetWindowIndex
  ) {
    return fail(
      'different-placement',
      `Task ${input.taskId} is already in that window on ${input.targetDate}.`,
    );
  }
  pass('different-placement', 'Target differs from the current placement.');

  // 4. The task has to fit the window at all.
  if (input.taskDurationMinutes > window.durationMin) {
    return fail(
      'duration-fits-window',
      `Task needs ${input.taskDurationMinutes} min but window ${window.start}-${window.end} is ` +
        `only ${window.durationMin} min. Traffic leaves no longer gap here.`,
    );
  }
  pass(
    'duration-fits-window',
    `${input.taskDurationMinutes} min fits inside the ${window.durationMin} min window.`,
  );

  // 5. THE ONE THAT MATTERS. Remaining capacity is measured on the EFFECTIVE
  //    plan, so work an earlier override moved into this window is counted.
  //    Reading the solver's original blocks here would silently accept an
  //    over-filled window.
  const targetBlock = input.effectivePlan.blocks.find(
    (block) =>
      block.corridorId === input.targetCorridorId &&
      block.date === input.targetDate &&
      block.windowIndex === input.targetWindowIndex,
  );
  const alreadyUsed = targetBlock
    ? (targetBlock.usedMinutes ?? 0) -
      // If the task is somehow already counted here, do not double-count it.
      (targetBlock.taskIds.includes(input.taskId) ? input.taskDurationMinutes : 0)
    : 0;
  const remaining = window.durationMin - alreadyUsed;

  if (input.taskDurationMinutes > remaining) {
    return fail(
      'window-capacity',
      `Window ${window.start}-${window.end} on ${input.targetDate} already holds ` +
        `${alreadyUsed} min of work, leaving ${remaining} min. Task needs ` +
        `${input.taskDurationMinutes} min.`,
    );
  }
  pass(
    'window-capacity',
    `Window has ${remaining} min free after existing work; task needs ` +
      `${input.taskDurationMinutes} min.`,
  );

  return {
    revalidation: { constraintsSatisfied: true, checks, trainImpactDelta: null },
    assignment: {
      corridorId: input.targetCorridorId,
      date: input.targetDate,
      windowIndex: input.targetWindowIndex,
      start: window.start,
      end: window.end,
      startMinute: window.startMin,
      endMinute: window.endMin,
      capacityMinutes: window.durationMin,
    },
  };
}

/** Every date the plan covers, in order. */
export function horizonDates(horizonStart: string, horizonDays: number): string[] {
  const start = new Date(`${horizonStart}T00:00:00Z`);
  return Array.from({ length: horizonDays }, (_, offset) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + offset);
    return day.toISOString().slice(0, 10);
  });
}
