/**
 * Driving the approval workflow and reading the audit trail - PRD FR6.1-FR6.3.
 *
 * The database half; the reasoning is in approvalEngine.ts, which is pure and
 * unit-tested. Rows are appended, never edited, and the schedule document is
 * not written to at all (D-057).
 */
import { CorridorCalendar, Schedule, ScheduleApproval, Task } from '../models/index.js';
import type {
  IScheduleApproval,
  PlanValidation,
  WorkflowAction,
  WorkflowState,
} from '../models/ScheduleApproval.js';
import type { IScheduleOverride } from '../models/ScheduleOverride.js';
import { horizonDates, type CorridorWindow, type EffectivePlan } from './overrideEngine.js';
import {
  OVERRIDABLE_STATES,
  allowedActions,
  checkTransition,
  currentState,
  planDigest,
  validatePlan,
} from './approvalEngine.js';
import { listApprovals } from './workflowState.js';
import { getEffectivePlan } from './scheduleOverrides.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

export { assertOverridable, getWorkflowState, listApprovals, workflowStates } from './workflowState.js';

export interface TransitionRequest {
  scheduleId: string;
  action: WorkflowAction;
  reason?: string;
  actorRole?: string;
}

/** Windows per corridor for the corridors this plan actually touches. */
async function loadWindows(corridorIds: string[]): Promise<Map<string, CorridorWindow[]>> {
  const calendars = await CorridorCalendar.find({ _id: { $in: corridorIds } })
    .select('_id maxDailyBlockWindows')
    .lean();
  return new Map(
    calendars.map((calendar) => [
      calendar._id,
      (calendar.maxDailyBlockWindows ?? []).map((window) => ({
        start: window.start,
        end: window.end,
        startMin: window.startMin,
        endMin: window.endMin,
        durationMin: window.durationMin,
      })),
    ]),
  );
}

async function revalidateEffectivePlan(
  schedule: { horizonStart: string; horizonDays: number; conflictReport?: unknown },
  effectivePlan: EffectivePlan,
): Promise<PlanValidation> {
  const taskIds = [
    ...new Set([
      ...effectivePlan.blocks.flatMap((block) => block.taskIds),
      ...effectivePlan.deferredTaskIds,
    ]),
  ];
  const [tasks, windowsByCorridor] = await Promise.all([
    Task.find({ _id: { $in: taskIds } }).select('_id estBlockDurationMins').lean(),
    loadWindows([...new Set(effectivePlan.blocks.map((block) => block.corridorId))]),
  ]);

  const report = (schedule.conflictReport ?? {}) as { conflicts?: Array<{ type?: string }> };

  return validatePlan({
    effectivePlan,
    windowsByCorridor,
    durationByTask: new Map(tasks.map((task) => [task._id, task.estBlockDurationMins])),
    horizonDates: horizonDates(schedule.horizonStart, schedule.horizonDays),
    knownConflicts: report.conflicts ?? [],
  });
}

/** How many plans have been published before, so the next version is dense. */
async function nextVersion(): Promise<number> {
  return (await ScheduleApproval.countDocuments({ action: 'publish' })) + 1;
}

/**
 * Run one workflow transition, or refuse it with the reason.
 *
 * A refused transition is an ApiError, not a stored row - the same call T15
 * made for a refused override (D-043). An audit trail records what HAPPENED to
 * a plan; an action the system never performed did not happen to it.
 */
export async function recordTransition(request: TransitionRequest): Promise<IScheduleApproval> {
  const { schedule, effectivePlan } = await getEffectivePlan(request.scheduleId);

  const approvals = await listApprovals(request.scheduleId);
  const fromState = currentState(approvals);

  const transition = checkTransition(fromState, request.action);
  if (!transition.legal) {
    throw ApiError.conflict(transition.refusal.reason, {
      details: {
        workflowState: fromState,
        allowedActions: allowedActions(fromState),
      },
    });
  }

  // FR6.1 puts constraint re-validation immediately before final approval, so
  // it is the guard on `approve` and its result is stored whether or not it
  // passed. A plan that no longer validates is refused here, which is the
  // single point at which the workflow can stop an unworkable plan reaching
  // publication.
  let validation: PlanValidation | null = null;
  if (request.action === 'approve') {
    validation = await revalidateEffectivePlan(schedule, effectivePlan);
    if (!validation.constraintsSatisfied) {
      const failed = validation.checks.find((check) => !check.passed);
      throw ApiError.conflict(
        `Re-validation failed, so this plan cannot be approved: ${failed?.detail ?? ''}`.trim(),
        { details: { workflowState: fromState, validation } },
      );
    }
  }

  const isPublish = request.action === 'publish';
  const now = new Date();

  const row: IScheduleApproval = {
    _id: `APR-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}-${request.action}`,
    scheduleId: request.scheduleId,
    action: request.action,
    fromState,
    toState: transition.to,
    reason: request.reason ?? '',
    actorRole: request.actorRole ?? 'controller',
    validation,
    version: isPublish ? await nextVersion() : null,
    publishedPlanDigest: isPublish ? planDigest(effectivePlan) : null,
    createdAt: now,
  };

  const saved = await ScheduleApproval.create(row);
  logger.info('workflow transition', {
    scheduleId: request.scheduleId,
    action: request.action,
    fromState,
    toState: transition.to,
    version: row.version,
  });

  return saved.toObject();
}

/* -------------------------------------------------------------------------- */
/* The audit trail - PRD Section 8 screen 5, FR6.2's "auditability"            */
/* -------------------------------------------------------------------------- */

export type AuditEntry =
  | { kind: 'generated'; at: Date; detail: Record<string, unknown> }
  | { kind: 'override'; at: Date; detail: IScheduleOverride }
  | { kind: 'approval'; at: Date; detail: IScheduleApproval };

export interface AuditTrail {
  scheduleId: string;
  state: WorkflowState;
  allowedActions: WorkflowAction[];
  overridable: boolean;
  version: number | null;
  publishedAt: Date | null;
  /**
   * On a published plan: does replaying the override log still reproduce the
   * plan that was published? Null when the plan has never been published.
   *
   * The freeze is enforced by refusing writes rather than by snapshotting, so
   * this is the check that the enforcement actually held. See D-058.
   */
  digestMatchesPublished: boolean | null;
  entries: AuditEntry[];
}

/**
 * Everything that has happened to one plan, in one time-ordered list.
 *
 * This is what PRD Section 15's `audit_logs` is actually for. The two record
 * kinds stay in their own collections, where each has a shape that fits it, and
 * are merged HERE - a view, not a storage decision (D-057).
 */
export async function getAuditTrail(scheduleId: string): Promise<AuditTrail> {
  const { schedule, overrides, effectivePlan } = await getEffectivePlan(scheduleId);
  const approvals = await listApprovals(scheduleId);

  const state = currentState(approvals);
  const publishRow = [...approvals].reverse().find((row) => row.action === 'publish') ?? null;

  const entries: AuditEntry[] = [
    {
      kind: 'generated' as const,
      at: schedule.generatedAt,
      detail: {
        scheduleId,
        solverStatus: schedule.status,
        horizonStart: schedule.horizonStart,
        horizonDays: schedule.horizonDays,
        tasksScheduled: schedule.metrics?.tasksScheduled ?? null,
        tasksDeferred: schedule.metrics?.tasksDeferred ?? null,
        solveSeconds: schedule.solveSeconds ?? null,
        // FR6.2 asks who or what produced the plan. It was the solver, and
        // naming it is the difference between an audit trail and a list of
        // human edits to an unattributed document.
        generatedBy: `CP-SAT optimizer (${schedule.inputSummary?.prioritySource ?? 'unknown'} priorities)`,
      },
    },
    ...overrides.map((override): AuditEntry => ({
      kind: 'override',
      at: override.createdAt,
      detail: override,
    })),
    ...approvals.map((approval): AuditEntry => ({
      kind: 'approval',
      at: approval.createdAt,
      detail: approval,
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return {
    scheduleId,
    state,
    allowedActions: allowedActions(state),
    overridable: OVERRIDABLE_STATES.has(state),
    version: publishRow?.version ?? null,
    publishedAt: publishRow?.createdAt ?? null,
    digestMatchesPublished: publishRow
      ? planDigest(effectivePlan) === publishRow.publishedPlanDigest
      : null,
    entries,
  };
}

/**
 * The plan currently in force - PRD Section 8's read-only view for engineers.
 *
 * Deliberately NOT the same query as `/latest`. Generating a new plan does not
 * retract the published one: the latest plan is the newest draft, the published
 * plan is what crews are working to, and conflating them would show a
 * department a possession nobody has approved.
 */
export async function findPublishedSchedule(): Promise<{
  scheduleId: string;
  version: number | null;
  publishedAt: Date;
} | null> {
  const row = await ScheduleApproval.findOne({ action: 'publish' })
    .sort({ createdAt: -1 })
    .lean<IScheduleApproval | null>()
    .exec();
  if (!row) return null;

  // Guard against a published plan whose document has since been removed -
  // returning an id that resolves to nothing would be worse than saying none.
  const exists = await Schedule.exists({ _id: row.scheduleId });
  if (!exists) return null;

  return { scheduleId: row.scheduleId, version: row.version, publishedAt: row.createdAt };
}
