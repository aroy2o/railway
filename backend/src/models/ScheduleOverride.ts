/**
 * `schedule_overrides` collection - PRD FR6.2.
 *
 * A Controller amending a generated plan. Append-only, and stored SEPARATELY
 * from the schedule rather than mutating it.
 *
 * WHY NOT MUTATE THE SCHEDULE DOCUMENT
 * ------------------------------------
 * Two reasons, the second decisive:
 *
 * 1. D-034 treats a schedule as an event - what the solver decided at a moment,
 *    against the data as it stood. An override is also an event, so it gets the
 *    same treatment rather than rewriting history.
 *
 * 2. `schedule.decisionLog` explains the SOLVER's decisions, and T17 builds
 *    grounded explanations from it under a hard rule that the LLM never invents
 *    numbers (PRD Section 18). Mutating `blocks` would leave the log saying a
 *    task runs at 01:00 while the blocks say 14:00 - the explanation layer
 *    would then be grounded in something that is no longer true.
 *
 * So the schedule stays exactly as the solver produced it, and the effective
 * plan is base + overrides applied in order. See docs/DECISIONS.md D-043.
 */
import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

/** Where a task sits, or sat. Null placement means deferred. */
export interface OverrideAssignment {
  corridorId: string;
  date: string;
  windowIndex: number;
  start: string;
  end: string;
  startMinute: number;
  endMinute: number;
  capacityMinutes: number;
}

export interface RevalidationCheck {
  check: string;
  passed: boolean;
  detail: string;
}

export interface RevalidationResult {
  constraintsSatisfied: boolean;
  checks: RevalidationCheck[];
  /**
   * FR6.2 also asks for a train-impact delta. Train-impact scoring is task T22
   * (PRD 9.6), so this is null - meaning "not computed", never "no impact".
   */
  trainImpactDelta: null;
}

export interface IScheduleOverride {
  _id: string;
  scheduleId: string;
  taskId: string;
  /** `move` places the task in a different window; `defer` removes it. */
  action: 'move' | 'defer';

  /**
   * The solver's own placement, preserved across repeated overrides.
   *
   * FR6.2 asks for "original AI assignment". After a second override the
   * immediately-previous placement is another override's target, not the AI's,
   * so both are recorded: this one always points at what the solver decided.
   */
  originalAiAssignment: OverrideAssignment | null;
  /** Where the task was immediately before this override. */
  fromAssignment: OverrideAssignment | null;
  /** Where it is now. Null when the action is `defer`. */
  newAssignment: OverrideAssignment | null;

  /** FR6.2 makes this mandatory - an unexplained override is not auditable. */
  reason: string;
  revalidation: RevalidationResult;
  actorRole: string;
  createdAt: Date;
}

export type ScheduleOverrideDocument = HydratedDocument<IScheduleOverride>;

const assignmentSchema = new Schema<OverrideAssignment>(
  {
    corridorId: { type: String, required: true },
    date: { type: String, required: true },
    windowIndex: { type: Number, required: true },
    start: { type: String, required: true },
    end: { type: String, required: true },
    startMinute: { type: Number, required: true },
    endMinute: { type: Number, required: true },
    capacityMinutes: { type: Number, required: true },
  },
  { _id: false },
);

const checkSchema = new Schema<RevalidationCheck>(
  {
    check: { type: String, required: true },
    passed: { type: Boolean, required: true },
    detail: { type: String, required: true },
  },
  { _id: false },
);

const scheduleOverrideSchema = new Schema<IScheduleOverride>(
  {
    _id: { type: String, required: true },
    scheduleId: { type: String, required: true, index: true },
    taskId: { type: String, required: true, index: true },
    action: { type: String, enum: ['move', 'defer'], required: true },

    originalAiAssignment: { type: assignmentSchema, default: null },
    fromAssignment: { type: assignmentSchema, default: null },
    newAssignment: { type: assignmentSchema, default: null },

    reason: { type: String, required: true },
    revalidation: {
      constraintsSatisfied: { type: Boolean, required: true },
      checks: { type: [checkSchema], default: [] },
      trainImpactDelta: { type: Schema.Types.Mixed, default: null },
    },
    actorRole: { type: String, default: 'controller' },
    createdAt: { type: Date, required: true },
  },
  { versionKey: false, _id: false },
);

// Overrides replay in creation order, so the effective plan is deterministic.
scheduleOverrideSchema.index({ scheduleId: 1, createdAt: 1 });

export const ScheduleOverride: Model<IScheduleOverride> = mongoose.model<IScheduleOverride>(
  'ScheduleOverride',
  scheduleOverrideSchema,
  'schedule_overrides',
);
export default ScheduleOverride;
