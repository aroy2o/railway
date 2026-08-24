/**
 * The approval state machine and whole-plan re-validation - PRD FR6.1, 9.3.
 *
 * Pure, like overrideEngine.ts and for the same reason: the interesting part of
 * a workflow is which transitions it REFUSES, and a refusal is only testable if
 * deciding it needs no database.
 *
 * FR6.1's chain maps onto four transitions:
 *
 *   AI Generated              -> `draft`        (the absence of any record)
 *   Controller Review         -> `submit`   => under_review
 *   Modify                    -> an FR6.2 override; no state change (T15)
 *   Accept + Re-validation
 *     + Final Approval        -> `approve`  => approved
 *   Reject                    -> `reject`   => rejected   (terminal)
 *   Published Block Plan      -> `publish`  => published  (terminal)
 *
 * Re-validation is not a separate state. FR6.1 draws it as a step between
 * Accept and Final Approval, and a state a plan can only ever be in for the
 * duration of one request is a state no one can observe. It is the GUARD on
 * `approve` instead: the transition happens only if the plan still validates,
 * and the result is stored on the row either way.
 */
import { createHash } from 'node:crypto';

import type { ScheduleBlock } from '../models/Schedule.js';
import type { PlanCheck, PlanValidation, WorkflowAction, WorkflowState } from '../models/ScheduleApproval.js';
import type { IScheduleApproval } from '../models/ScheduleApproval.js';
import type { CorridorWindow, EffectivePlan } from './overrideEngine.js';

/** A plan with no approval rows has never entered the workflow. */
export const INITIAL_STATE: WorkflowState = 'draft';

/**
 * The whole legal transition set. Anything not in here is refused.
 *
 * Written as data rather than as branches so the guard cannot drift from the
 * documentation of it, and so a test can enumerate every (state, action) pair
 * and assert the complement is rejected - which is the only way to know the
 * illegal set is complete rather than merely non-empty.
 */
export const TRANSITIONS: ReadonlyArray<{
  from: WorkflowState;
  action: WorkflowAction;
  to: WorkflowState;
}> = [
  { from: 'draft', action: 'submit', to: 'under_review' },
  { from: 'under_review', action: 'approve', to: 'approved' },
  { from: 'under_review', action: 'reject', to: 'rejected' },
  { from: 'approved', action: 'publish', to: 'published' },
];

/** States from which nothing further can happen. FR6.3's "prior version". */
export const TERMINAL_STATES: ReadonlySet<WorkflowState> = new Set(['rejected', 'published']);

/**
 * States in which a plan may still be amended by an FR6.2 override.
 *
 * Publishing FREEZES the plan: once it has been issued, the published record
 * has to be what the crews were handed, and an amendment that silently edited
 * it would make the audit trail describe a plan nobody worked to. Amending a
 * published plan means generating a new one, which D-034 already makes a new
 * document and FR6.3 already versions.
 *
 * `rejected` is closed for the opposite reason: nothing downstream will read
 * that plan again, so an override on it is edits to a discarded document.
 */
export const OVERRIDABLE_STATES: ReadonlySet<WorkflowState> = new Set([
  'draft',
  'under_review',
  'approved',
]);

/** Fold the append-only rows into the state they leave the plan in. */
export function currentState(approvals: Pick<IScheduleApproval, 'toState'>[]): WorkflowState {
  return approvals.length === 0 ? INITIAL_STATE : approvals[approvals.length - 1]!.toState;
}

/** Which actions are legal from here. Drives the UI's buttons. */
export function allowedActions(state: WorkflowState): WorkflowAction[] {
  return TRANSITIONS.filter((t) => t.from === state).map((t) => t.action);
}

export interface TransitionRefusal {
  /** Why this exact request is illegal, naming the state it was made from. */
  reason: string;
}

export type TransitionCheck =
  | { legal: true; to: WorkflowState }
  | { legal: false; refusal: TransitionRefusal };

/**
 * Is this transition legal from this state?
 *
 * Refusals name the current state and what would have to happen first, because
 * "409 Conflict" on its own tells a Controller nothing about what to do next.
 */
export function checkTransition(state: WorkflowState, action: WorkflowAction): TransitionCheck {
  const match = TRANSITIONS.find((t) => t.from === state && t.action === action);
  if (match) return { legal: true, to: match.to };

  if (TERMINAL_STATES.has(state)) {
    return {
      legal: false,
      refusal: {
        reason:
          `This plan is ${state}, which is a terminal state - it cannot be ${action}d. ` +
          `Generate a new plan instead; prior versions stay viewable (FR6.3).`,
      },
    };
  }

  const wouldNeed = TRANSITIONS.filter((t) => t.action === action).map((t) => t.from);
  return {
    legal: false,
    refusal: {
      reason:
        `Cannot ${action} a plan that is ${state}. ` +
        (wouldNeed.length
          ? `\`${action}\` is only legal from: ${wouldNeed.join(', ')}. `
          : '') +
        `From ${state} the legal actions are: ${allowedActions(state).join(', ') || 'none'}.`,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Whole-plan re-validation - the guard on `approve` (FR6.1)                   */
/* -------------------------------------------------------------------------- */

export interface ValidatePlanInput {
  effectivePlan: EffectivePlan;
  /** Free windows per corridor, as stored by T3. */
  windowsByCorridor: Map<string, CorridorWindow[]>;
  durationByTask: Map<string, number>;
  horizonDates: string[];
  /** `schedule.conflictReport.conflicts` - the solver's own typed gaps (T21). */
  knownConflicts: Array<{ type?: string }>;
}

/**
 * Re-validate the plan a Controller is about to sign, not the one the solver
 * produced.
 *
 * The distinction is D-044's, and it is the whole point of running this at
 * approval time at all: the solver's output was valid when it was produced, and
 * every override since was validated against the plan as it stood at that
 * moment. What nothing has ever checked is the plan that came out the far end.
 * These checks are written against the failure that is silent - a plan that
 * looks fine and cannot be worked.
 */
export function validatePlan(input: ValidatePlanInput): PlanValidation {
  const { effectivePlan, windowsByCorridor, durationByTask, horizonDates } = input;
  const checks: PlanCheck[] = [];
  const horizon = new Set(horizonDates);

  // 1. Capacity. An over-filled window is a possession that cannot be worked.
  const overfilled = effectivePlan.blocks.filter(
    (block) => (block.usedMinutes ?? 0) > (block.capacityMinutes ?? 0),
  );
  checks.push({
    check: 'no-window-over-capacity',
    passed: overfilled.length === 0,
    detail: overfilled.length
      ? `${overfilled.length} window(s) hold more work than they have minutes, first: ` +
        `${overfilled[0]!.corridorId} ${overfilled[0]!.date} ` +
        `(${overfilled[0]!.usedMinutes}/${overfilled[0]!.capacityMinutes} min).`
      : `All ${effectivePlan.blocks.length} block(s) fit inside their window's capacity.`,
  });

  // 2. A task in two places at once.
  const placements = new Map<string, number>();
  for (const block of effectivePlan.blocks) {
    for (const taskId of block.taskIds) {
      placements.set(taskId, (placements.get(taskId) ?? 0) + 1);
    }
  }
  const doubled = [...placements.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  checks.push({
    check: 'no-task-placed-twice',
    passed: doubled.length === 0,
    detail: doubled.length
      ? `Placed in more than one block: ${doubled.slice(0, 5).join(', ')}.`
      : `Each of the ${placements.size} placed task(s) appears in exactly one block.`,
  });

  // 3. Placed and deferred at the same time - a replay bug, not a solver bug,
  //    which is precisely why it is checked here rather than trusted.
  const contradictory = effectivePlan.deferredTaskIds.filter((id) => placements.has(id));
  checks.push({
    check: 'no-task-both-placed-and-deferred',
    passed: contradictory.length === 0,
    detail: contradictory.length
      ? `Both placed and deferred: ${contradictory.join(', ')}.`
      // Names the OVERRIDE-deferred count explicitly. `effectivePlan` carries
      // only tasks a Controller deferred by hand; the solver's own deferrals
      // live in `schedule.deferredTasks` and are a different, much larger
      // number. "None of the 0 deferred tasks" beside a plan that defers 53
      // reads as a claim that nothing was deferred at all.
      : `No task is both placed and manually deferred (${effectivePlan.deferredTaskIds.length} ` +
        `override-deferred; the solver's own deferrals are counted separately).`,
  });

  // 4. Every block sits on a real free window of its own corridor.
  const offCalendar = effectivePlan.blocks.filter((block) => {
    const window = windowsByCorridor.get(block.corridorId)?.[block.windowIndex];
    return !window || window.start !== block.start || window.end !== block.end;
  });
  checks.push({
    check: 'every-block-on-a-real-corridor-window',
    passed: offCalendar.length === 0,
    detail: offCalendar.length
      ? `${offCalendar.length} block(s) do not match a stored window on their corridor, first: ` +
        `${offCalendar[0]!.corridorId} window ${offCalendar[0]!.windowIndex}.`
      : `All ${effectivePlan.blocks.length} block(s) sit on a window from the corridor calendar.`,
  });

  // 5. Every block falls inside the horizon the plan was solved for.
  const offHorizon = effectivePlan.blocks.filter((block) => !horizon.has(block.date));
  checks.push({
    check: 'every-block-inside-the-horizon',
    passed: offHorizon.length === 0,
    detail: offHorizon.length
      ? `${offHorizon.length} block(s) fall outside ${horizonDates[0]}..` +
        `${horizonDates[horizonDates.length - 1]}, first: ${offHorizon[0]!.date}.`
      : `All block(s) fall inside ${horizonDates[0]}..${horizonDates[horizonDates.length - 1]}.`,
  });

  // 6. The minutes booked match the work actually in the window.
  //
  //    This is the check that would catch the one live input the publish freeze
  //    cannot close: `applyOverrides` reads task durations from the tasks
  //    collection, so a duration edited after a plan was built would change the
  //    replayed plan without touching a single immutable record.
  const mismatched = effectivePlan.blocks.filter((block) => {
    const summed = block.taskIds.reduce((total, id) => total + (durationByTask.get(id) ?? 0), 0);
    return summed !== (block.usedMinutes ?? 0);
  });
  checks.push({
    check: 'booked-minutes-match-task-durations',
    passed: mismatched.length === 0,
    detail: mismatched.length
      ? `${mismatched.length} block(s) book minutes that do not sum to their tasks' durations, ` +
        `first: ${mismatched[0]!.corridorId} ${mismatched[0]!.date}.`
      : `Booked minutes reconcile with task durations in every block.`,
  });

  const byType = new Map<string, number>();
  for (const conflict of input.knownConflicts) {
    const type = conflict.type ?? 'unknown';
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }

  return {
    constraintsSatisfied: checks.every((check) => check.passed),
    checks,
    knownUnresolved: [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  };
}

/* -------------------------------------------------------------------------- */
/* The publication digest                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A stable fingerprint of the plan as published.
 *
 * Deliberately covers only what a crew would act on - where and when work
 * happens, and what is not happening - so a change to a presentational field
 * does not read as the plan having changed.
 */
export function planDigest(plan: EffectivePlan): string {
  const canonical = {
    blocks: plan.blocks
      .map((block: ScheduleBlock) => ({
        c: block.corridorId,
        d: block.date,
        w: block.windowIndex,
        s: block.start,
        e: block.end,
        t: [...block.taskIds].sort(),
      }))
      .sort((a, b) => a.d.localeCompare(b.d) || a.c.localeCompare(b.c) || a.w - b.w),
    deferred: [...plan.deferredTaskIds].sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}
