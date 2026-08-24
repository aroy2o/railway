/**
 * Ask the Planner - gathering half (PRD 9.2, FR8.2, task T18).
 *
 * The division of labour follows the architecture this project has used since
 * T9: Node owns MongoDB, the optimizer owns the reasoning. So Node gathers the
 * real records and posts them; it does not decide which ones bear on the
 * question, and it does not talk to the Claude API. The grounding contract
 * lives in `optimizer/app/core/grounding.py`, in one place, next to the
 * scheduler whose decisions it explains.
 *
 * WHY OVERRIDES ARE GATHERED TOO
 * ------------------------------
 * `decisionLog` records what the SOLVER decided. By D-043 the schedule is never
 * mutated, so after a manual override the log and the current plan disagree on
 * purpose - both facts are true, about different things. An explanation that
 * saw only the log would confidently give a Controller the time their own
 * override replaced. Both go into the payload; the grounding step keeps them
 * distinct.
 *
 * WHY THE WORKFLOW STATE IS SENT ALREADY FOLDED
 * ---------------------------------------------
 * T19 makes a plan's state a fold over its append-only approval rows. The
 * optimizer is sent the RESULT of that fold, not the transition table, so the
 * state machine exists in exactly one place - the same call D-046 made for the
 * conflict taxonomy. A second implementation in a second language is a second
 * thing to drift, and drift here would mean telling a Controller that a plan is
 * published when it is not.
 */
import { Task } from '../models/index.js';
import { config } from '../config/env.js';
import { requestOptimizer } from './optimizerClient.js';
import { findLatestSchedule, findScheduleById } from './scheduleOrchestrator.js';
import { listOverrides } from './scheduleOverrides.js';
import { getWorkflowState, listApprovals } from './workflowState.js';
import { allowedActions, OVERRIDABLE_STATES } from './approvalEngine.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Fields the grounding contract reads from a task document.
 *
 * Projected rather than sending whole documents: the payload is posted on every
 * question, and an explicit list is also a statement of what the explanation
 * layer is allowed to know about a task.
 */
const TASK_FIELDS = [
  'corridorId', 'assetId', 'department', 'defectType', 'severity', 'workflowStage',
  'status', 'slaDueDate', 'dateRaised', 'estBlockDurationMins', 'dependsOnTaskId',
  'requiredResourceIds', 'priorityScore', 'dominantPriorityFactor', 'failureRiskScore',
].join(' ');

export interface ExplainResult {
  answer: string;
  answered: boolean;
  groundedIn: string[];
  verification: { grounded: boolean; ungroundedNumbers: string[]; unknownRecordIds: string[] };
  context: Record<string, unknown>;
  scheduleId: string;
}

export async function explainSchedule({
  scheduleId,
  question,
}: {
  /** Omit to explain the most recent plan. */
  scheduleId?: string;
  question: string;
}): Promise<ExplainResult> {
  // findScheduleById throws its own 404; findLatestSchedule returns null when
  // nothing has ever been generated, which needs a different message - "no
  // schedule exists yet" is a setup problem, not a bad id.
  const schedule = scheduleId
    ? await findScheduleById(scheduleId)
    : await findLatestSchedule();

  if (!schedule) {
    throw ApiError.notFound(
      'No schedule has been generated yet, so there is nothing to explain',
    );
  }

  const id = String(schedule._id);
  const taskIds = (schedule.decisionLog ?? []).map((entry) => (entry as { taskId: string }).taskId);

  const [tasks, overrides, approvals, workflowState] = await Promise.all([
    Task.find({ _id: { $in: taskIds } }).select(TASK_FIELDS).lean(),
    listOverrides(id),
    listApprovals(id),
    getWorkflowState(id),
  ]);

  const publishRow = [...approvals].reverse().find((row) => row.action === 'publish') ?? null;

  const response = (await requestOptimizer('/explain', {
    method: 'POST',
    // The LLM call is the slow part, not the gather - see EXPLAIN_TIMEOUT_MS.
    timeoutMs: config.optimizer.explainTimeoutMs,
    body: {
      question,
      schedule,
      tasks,
      overrides,
      approvals,
      workflow: {
        state: workflowState,
        version: publishRow?.version ?? null,
        publishedAt: publishRow?.createdAt ?? null,
        allowedActions: allowedActions(workflowState),
        overridable: OVERRIDABLE_STATES.has(workflowState),
      },
    },
  })) as Omit<ExplainResult, 'scheduleId'>;

  return { ...response, scheduleId: id };
}
