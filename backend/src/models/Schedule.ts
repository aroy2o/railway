/**
 * `schedules` collection - PRD Section 15.
 *
 * Stores a generated plan together with everything needed to explain and audit
 * it. The PRD's shape is honoured, and the optimizer's richer output is kept
 * rather than trimmed - the same choice T2-T4 made with the pipeline data, for
 * the same reason: discarding a field that already exists means a later task
 * has to recompute or re-request it.
 *
 * Schedules are APPENDED, never replaced. FR6.3 requires published plans to be
 * versioned with prior versions viewable for audit, so each generation is a new
 * document. That is deliberately the opposite of the seed script's
 * replace-everything strategy (D-019): the seed mirrors deterministic source
 * files, while a schedule is an event that happened at a point in time.
 * See docs/DECISIONS.md D-034.
 */
import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import type { Department } from './Asset.js';

export interface ScheduleBlock {
  corridorId: string;
  date: string;
  windowIndex: number;
  start?: string;
  end?: string;
  startMinute?: number;
  endMinute?: number;
  capacityMinutes?: number;
  usedMinutes?: number;
  unusedMinutes?: number;
  taskIds: string[];
  departments: Department[];
  isCrossDepartmentBatch?: boolean;
  /** Null until train-impact scoring exists (PRD 9.6, T22) - not "no impact". */
  trainImpact: unknown | null;
}

/**
 * T23 (PRD 13.1) - the D-023 objective weights actually used to build this
 * plan. Every term present, whether the generation request named it or not -
 * see D-062 for why this stays a plain field rather than a fold like FR6.1's
 * workflow state (D-057).
 */
export interface PolicyWeights {
  coverage: number;
  slaCompliance: number;
  batching: number;
  unusedMinute: number;
  fragmentation: number;
}

export interface ScheduleDeferredTask {
  taskId: string;
  reason?: string;
  detail?: string;
  /** T22: what a traffic block for this task would cost. Absent when uncosted. */
  displacementOption?: unknown;
}

export interface GenerationError {
  call: string;
  message: string;
  code: string;
}

/**
 * T27 (PRD FR3.5, 9.10) - present only on a schedule produced by an emergency
 * re-solve. `sourceScheduleId` is the plan this one amends; the rest is the
 * optimizer's own `emergencyContext`, stored verbatim for the same reason
 * `decisionLog`/`knownGaps` are (D-033).
 */
export interface EmergencyContext {
  sourceScheduleId: string;
  corridorId: string;
  disruptedWindows: Array<{ date: string; windowIndex: number }>;
  asOf: string;
  reason: string;
  pinnedTaskCount: number;
  blockedWindowCount: number;
}

export interface ISchedule {
  /** Readable, sortable, generated: SCH-<compact ISO timestamp>. See D-017. */
  _id: string;

  // --- PRD Section 15 shape ---------------------------------------------
  horizon: string;
  generatedAt: Date;
  /**
   * T23: the weights this generation actually used. Recorded once, at
   * creation, and never touched again - see D-062 for why that makes it safe
   * to store as a plain field despite D-057's "derive, do not store" rule for
   * workflow state.
   */
  policyWeights: PolicyWeights | null;
  blocks: ScheduleBlock[];
  deferredTasks: ScheduleDeferredTask[];
  comparisonToBaseline: unknown | null;

  // --- real extensions from the optimizer's response ---------------------
  horizonStart: string;
  horizonDays: number;
  status: string;
  objectiveValue: number;
  solveSeconds: number;
  metrics: Record<string, number>;
  /** T17 builds grounded explanations from this (PRD Section 18). */
  decisionLog: unknown[];
  /** Both PRD 9.7 (dependency precedence, T24) and PRD 9.8 (resource
   * no-overlap, T25) are hard CP-SAT constraints, so both counts here are
   * always 0 - this is now an invariant check, not a gap report. */
  knownGaps: unknown | null;
  /**
   * PRD 9.5 - the same gaps, named by type with a resolution strategy each.
   * Derived by the optimizer from `knownGaps`; stored rather than recomputed so
   * the taxonomy lives in exactly one place (D-046). The baseline's own typed
   * report rides along inside `baseline`, which is stored verbatim.
   */
  conflictReport: unknown | null;
  /**
   * FR2.2 (T16): how the predictive risk model was applied to THIS plan.
   *
   * Stored per schedule, not only per asset, because the priority weights this
   * plan was built with depend on whether risk was available. A plan generated
   * while /risk was down used the renormalised four-factor weights, and that
   * has to stay knowable afterwards rather than being inferred from whatever
   * the assets happen to hold now. `framing` is PRD 9.1's disclaimer (D-055).
   */
  riskModel: {
    applied: boolean;
    assetsScored: number;
    tasksWithRisk: number;
    modelType: string | null;
    framing: string | null;
  } | null;
  /** The full FR9.1 baseline result, including its conflict report. */
  baseline: unknown | null;
  /** D-031: the comparison denominator, so T14 cannot use the full backlog. */
  contestableTaskIds: string[];

  inputSummary: {
    taskCount: number;
    corridorCount: number;
    prioritySource: string;
  };
  /**
   * Best-effort calls that failed. Recorded rather than swallowed, so a missing
   * comparison is distinguishable from a comparison of zero.
   *
   * Named `generationErrors` rather than `errors`: Mongoose reserves the latter
   * as a document pathname and warns that it may break validation.
   */
  generationErrors: GenerationError[];

  /** T27. `null` for every ordinarily-generated plan. */
  emergencyContext: EmergencyContext | null;
}

export type ScheduleDocument = HydratedDocument<ISchedule>;

const blockSchema = new Schema<ScheduleBlock>(
  {
    corridorId: { type: String, required: true },
    date: { type: String, required: true },
    windowIndex: { type: Number, required: true },
    start: String,
    end: String,
    startMinute: Number,
    endMinute: Number,
    capacityMinutes: Number,
    usedMinutes: Number,
    unusedMinutes: Number,
    taskIds: [String],
    departments: [String],
    isCrossDepartmentBatch: Boolean,
    trainImpact: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

/**
 * A best-effort optimizer call that failed.
 *
 * Given a real sub-schema rather than `Mixed`: the shape is known, and the JS
 * version's `Mixed` typing was looseness the migration surfaced rather than a
 * deliberate choice.
 */
const generationErrorSchema = new Schema<GenerationError>(
  {
    call: { type: String, required: true },
    message: { type: String, required: true },
    code: { type: String, required: true },
  },
  { _id: false },
);

/** T27. Declared for the same D-033 reason `generationErrorSchema` is. */
const emergencyContextSchema = new Schema<EmergencyContext>(
  {
    sourceScheduleId: { type: String, required: true },
    corridorId: { type: String, required: true },
    disruptedWindows: {
      type: [
        new Schema(
          { date: { type: String, required: true }, windowIndex: { type: Number, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
    asOf: { type: String, required: true },
    reason: { type: String, required: true },
    pinnedTaskCount: { type: Number, required: true },
    blockedWindowCount: { type: Number, required: true },
  },
  { _id: false },
);

const deferredSchema = new Schema<ScheduleDeferredTask>(
  {
    taskId: { type: String, required: true },
    reason: String,
    detail: String,
    // T22's traffic-block costing. Declared because Mongoose silently DROPS
    // undeclared keys - which is exactly how this field went missing on its
    // first run, the same subtraction D-033 caught in a response schema.
    displacementOption: { type: Schema.Types.Mixed, default: undefined },
  },
  { _id: false },
);

const scheduleSchema = new Schema<ISchedule>(
  {
    _id: { type: String, required: true },

    horizon: { type: String, required: true },
    generatedAt: { type: Date, required: true, index: true },
    policyWeights: {
      type: new Schema(
        {
          coverage: { type: Number, required: true },
          slaCompliance: { type: Number, required: true },
          batching: { type: Number, required: true },
          unusedMinute: { type: Number, required: true },
          fragmentation: { type: Number, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    blocks: { type: [blockSchema], default: [] },
    deferredTasks: { type: [deferredSchema], default: [] },
    comparisonToBaseline: { type: Schema.Types.Mixed, default: null },

    horizonStart: { type: String, required: true },
    horizonDays: { type: Number, required: true },
    status: { type: String, required: true },
    objectiveValue: Number,
    solveSeconds: Number,
    metrics: { type: Schema.Types.Mixed, default: {} },
    decisionLog: { type: Schema.Types.Mixed, default: [] },
    knownGaps: { type: Schema.Types.Mixed, default: null },
    conflictReport: { type: Schema.Types.Mixed, default: null },
    riskModel: { type: Schema.Types.Mixed, default: null },
    baseline: { type: Schema.Types.Mixed, default: null },
    contestableTaskIds: { type: [String], default: [] },

    inputSummary: {
      taskCount: Number,
      corridorCount: Number,
      prioritySource: String,
    },
    generationErrors: { type: [generationErrorSchema], default: [] },
    emergencyContext: { type: emergencyContextSchema, default: null },
  },
  {
    versionKey: false,
    _id: false,
    // T25 bug, found by its own test: Mongoose's default `minimize: true`
    // silently strips an empty nested object (e.g. `conflictReport.byPlan:
    // {}`, now the normal shape once every PRD 9.5 type on the optimized
    // plan is a hard constraint) before it ever reaches MongoDB - proven by
    // reproducing it against the native driver, which stores `{}` correctly.
    // The same failure D-015/D-033 guarded against in other layers, in a
    // third one: `{}` is a real, meaningful value ("checked, none found"),
    // not an omission, and must survive the round trip.
    minimize: false,
  },
);

scheduleSchema.index({ generatedAt: -1 });

export const Schedule: Model<ISchedule> = mongoose.model<ISchedule>(
  'Schedule',
  scheduleSchema,
  'schedules',
);
export default Schedule;
