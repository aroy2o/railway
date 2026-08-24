/**
 * Reading a plan's workflow state - PRD FR6.1.
 *
 * Split out from `scheduleApprovals.ts` to break an import cycle rather than to
 * organise anything: T15's override path has to ASK the workflow whether the
 * plan is still open, and the workflow's own write path has to build the
 * effective plan from the overrides. Reads-only lives here, so neither module
 * imports the other.
 */
import { ScheduleApproval } from '../models/index.js';
import type { IScheduleApproval, WorkflowState } from '../models/ScheduleApproval.js';
import { INITIAL_STATE, OVERRIDABLE_STATES, currentState } from './approvalEngine.js';
import { ApiError } from '../utils/ApiError.js';

export function listApprovals(scheduleId: string): Promise<IScheduleApproval[]> {
  return ScheduleApproval.find({ scheduleId })
    .sort({ createdAt: 1 })
    .lean<IScheduleApproval[]>()
    .exec();
}

export async function getWorkflowState(scheduleId: string): Promise<WorkflowState> {
  return currentState(await listApprovals(scheduleId));
}

/**
 * The state of many plans in one query.
 *
 * The list route needs a state per row, and reading each plan's rows separately
 * would be an N+1 - the same shape of mistake T5 found as a full-collection
 * scan. Sorting ascending and overwriting leaves the LAST row per plan, which
 * is what `currentState` folds to.
 */
export async function workflowStates(scheduleIds: string[]): Promise<Map<string, WorkflowState>> {
  const rows = await ScheduleApproval.find({ scheduleId: { $in: scheduleIds } })
    .sort({ createdAt: 1 })
    .select('scheduleId toState')
    .lean<Array<Pick<IScheduleApproval, 'scheduleId' | 'toState'>>>()
    .exec();

  const states = new Map<string, WorkflowState>(scheduleIds.map((id) => [id, INITIAL_STATE]));
  for (const row of rows) states.set(row.scheduleId, row.toState);
  return states;
}

/**
 * Refuse an override on a plan the workflow has closed.
 *
 * A gate placed in front of T15's `recordOverride`, not a change to what it
 * does: everything after it runs exactly as it did before.
 */
export async function assertOverridable(scheduleId: string): Promise<void> {
  const state = await getWorkflowState(scheduleId);
  if (OVERRIDABLE_STATES.has(state)) return;

  throw ApiError.conflict(
    state === 'published'
      ? `Schedule ${scheduleId} is published and is frozen: a published plan is the record ` +
          `of what crews were issued, so it cannot be amended. Generate a new plan - it ` +
          `becomes the next version and this one stays viewable (FR6.3).`
      : `Schedule ${scheduleId} was rejected, so there is nothing to amend. Generate a new plan.`,
    { details: { workflowState: state } },
  );
}
