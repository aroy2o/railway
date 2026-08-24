/**
 * `schedule_approvals` collection - PRD FR6.1, FR6.3, Section 9.3.
 *
 * One row per workflow transition. Append-only: a plan's current state is a
 * FOLD over its rows, never a field anyone updates.
 *
 * WHY THE STATE IS NOT A FIELD ON THE SCHEDULE
 * -------------------------------------------
 * D-034 made a schedule an event; D-043 made an override an event and put it in
 * its own collection rather than mutating the plan. An approval is a third
 * event of the same kind, so it gets the same treatment - and that is what
 * keeps T19 from touching the schedule document at all.
 *
 * That matters more than tidiness. D-043 exists so that `blocks` and
 * `decisionLog` cannot shift underneath T17's explanations. A workflow field
 * updated in place would be a second mutable surface on the same document, and
 * "the schedule document is immutable" would become "the schedule document is
 * immutable except for one field" - a rule with an exception is a rule people
 * stop checking. Deriving the state instead keeps the original guarantee whole
 * and needs no migration: a schedule with no rows here is a draft, which every
 * schedule generated before T19 correctly is.
 *
 * WHY THIS IS NOT THE SAME COLLECTION AS `schedule_overrides`
 * ----------------------------------------------------------
 * PRD Section 15 sketches a single `audit_logs` with
 * `action: "override"|"approve"|"reject"`. It is stored as two collections and
 * joined on read instead, because the two records have different arity: an
 * override is keyed (scheduleId, taskId) and is a delta on one PLACEMENT, while
 * an approval is keyed (scheduleId) alone and is a verdict on the WHOLE PLAN.
 * In one table, `taskId`, `originalAssignment`, `newAssignment` and
 * `revalidationResult` would be structurally null on every approve/reject row -
 * a union pretending to be a table. The PRD's audit_logs is honoured as the
 * merged AUDIT VIEW (`GET /api/schedules/:id/audit`), which is what it is
 * actually for. See docs/DECISIONS.md D-057.
 */
import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

/** The workflow states of FR6.1. `rejected` and `published` are terminal. */
export type WorkflowState = 'draft' | 'under_review' | 'approved' | 'rejected' | 'published';

/** The transitions a Controller can request. `draft` is the absence of any. */
export type WorkflowAction = 'submit' | 'approve' | 'reject' | 'publish';

export interface PlanCheck {
  check: string;
  passed: boolean;
  detail: string;
}

/**
 * Whole-plan constraint re-validation - FR6.1's step between Accept and Final
 * Approval. Run on `approve`, and recorded whether it passed or not.
 */
export interface PlanValidation {
  constraintsSatisfied: boolean;
  checks: PlanCheck[];
  /**
   * Conflicts the SOLVER already reported as out of scope (T25's resource
   * contention gap). Dependency precedence (PRD 9.7) is enforced as of T24, so
   * it no longer contributes here. These do not block approval - every plan on
   * this corpus has resource conflicts, so blocking would make every plan
   * unapprovable - but a signature has to state what was known-unresolved when
   * it was given, or it is a signature on an unstated risk.
   */
  knownUnresolved: Array<{ type: string; count: number }>;
}

export interface IScheduleApproval {
  _id: string;
  scheduleId: string;
  action: WorkflowAction;
  /** State immediately before this row, recomputed from the rows before it. */
  fromState: WorkflowState;
  toState: WorkflowState;
  /** Mandatory on reject, same reasoning as FR6.2's override reason. */
  reason: string;
  actorRole: string;

  /** Present on `approve`. Null on every other action. */
  validation: PlanValidation | null;

  /**
   * FR6.3 version number, assigned on `publish` and dense (1, 2, 3...).
   *
   * Counted over published plans, not generated ones: ten discarded drafts
   * should not make the second published plan "version 11".
   */
  version: number | null;
  /**
   * A digest of the effective plan at the moment of publication.
   *
   * Publishing freezes a plan by REFUSING further writes, not by copying the
   * plan into a snapshot - copying would mean storing the blocks a second time
   * and inventing a second source of truth for what the plan is. The effective
   * plan therefore stays reproducible from immutable base blocks plus the
   * closed override log.
   *
   * That reproduction has one live input the freeze does not cover: task
   * durations, which `applyOverrides` reads from the tasks collection. This
   * build never edits them, so the risk is latent rather than active - but
   * latent is not absent, and a hash costs nothing. `GET /:id/audit` re-derives
   * it and reports whether it still matches, so drift would be visible instead
   * of silent.
   */
  publishedPlanDigest: string | null;
  createdAt: Date;
}

export type ScheduleApprovalDocument = HydratedDocument<IScheduleApproval>;

const planCheckSchema = new Schema<PlanCheck>(
  {
    check: { type: String, required: true },
    passed: { type: Boolean, required: true },
    detail: { type: String, required: true },
  },
  { _id: false },
);

// Declared field by field rather than as `Mixed`. Mongoose silently DROPS keys
// a sub-schema does not declare - the subtraction D-033 first caught and T22
// hit again with `displacementOption` - so every field a reader depends on is
// named here.
const validationSchema = new Schema<PlanValidation>(
  {
    constraintsSatisfied: { type: Boolean, required: true },
    checks: { type: [planCheckSchema], default: [] },
    knownUnresolved: {
      type: [new Schema({ type: String, count: Number }, { _id: false })],
      default: [],
    },
  },
  { _id: false },
);

const scheduleApprovalSchema = new Schema<IScheduleApproval>(
  {
    _id: { type: String, required: true },
    scheduleId: { type: String, required: true, index: true },
    action: {
      type: String,
      enum: ['submit', 'approve', 'reject', 'publish'],
      required: true,
    },
    fromState: { type: String, required: true },
    toState: { type: String, required: true },
    reason: { type: String, default: '' },
    actorRole: { type: String, default: 'controller' },
    validation: { type: validationSchema, default: null },
    version: { type: Number, default: null },
    publishedPlanDigest: { type: String, default: null },
    createdAt: { type: Date, required: true },
  },
  { versionKey: false, _id: false },
);

// The state is a fold in creation order, so reads must be able to get the rows
// for one plan already ordered.
scheduleApprovalSchema.index({ scheduleId: 1, createdAt: 1 });

export const ScheduleApproval: Model<IScheduleApproval> = mongoose.model<IScheduleApproval>(
  'ScheduleApproval',
  scheduleApprovalSchema,
  'schedule_approvals',
);
export default ScheduleApproval;
