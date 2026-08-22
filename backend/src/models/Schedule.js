/**
 * `schedules` collection - PRD Section 15.
 *
 * Stores a generated plan together with everything needed to explain and audit
 * it. The PRD's shape is honoured, and the optimizer's richer output is kept
 * rather than trimmed to fit - the same choice T2-T4 made with the pipeline
 * data, for the same reason: discarding a field that already exists means a
 * later task has to recompute or re-request it.
 *
 * Schedules are APPENDED, never replaced. FR6.3 requires published plans to be
 * versioned with prior versions viewable for audit, so each generation is a new
 * document. That is deliberately the opposite of the seed script's
 * replace-everything strategy (D-019): the seed mirrors deterministic source
 * files, while a schedule is an event that happened at a point in time.
 * See docs/DECISIONS.md D-035.
 */
import mongoose from 'mongoose';

const blockSchema = new mongoose.Schema(
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
    // PRD Section 15 puts trainImpact on a block. It stays null until train-
    // impact scoring exists (PRD 9.6, task T22) - null means "not computed",
    // never "no impact".
    trainImpact: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const deferredSchema = new mongoose.Schema(
  { taskId: { type: String, required: true }, reason: String, detail: String },
  { _id: false },
);

const scheduleSchema = new mongoose.Schema(
  {
    // Readable, sortable, generated: SCH-<compact ISO timestamp>. No natural
    // key exists for a schedule, but keeping ids human-readable matches D-017
    // and makes GET /api/schedules/:id legible in a demo.
    _id: { type: String, required: true },

    // --- PRD Section 15 shape -------------------------------------------
    horizon: { type: String, required: true },
    generatedAt: { type: Date, required: true, index: true },
    // Exposed as policy sliders in T23; null until then rather than a fake set.
    policyWeights: { type: mongoose.Schema.Types.Mixed, default: null },
    blocks: { type: [blockSchema], default: [] },
    deferredTasks: { type: [deferredSchema], default: [] },
    comparisonToBaseline: { type: mongoose.Schema.Types.Mixed, default: null },

    // --- real extensions from the optimizer's response -------------------
    horizonStart: { type: String, required: true },
    horizonDays: { type: Number, required: true },
    status: { type: String, required: true },
    objectiveValue: Number,
    solveSeconds: Number,
    metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    // T17 builds grounded explanations from this; PRD Section 18 forbids the
    // LLM inventing numbers, so every figure it needs must already be here.
    decisionLog: { type: mongoose.Schema.Types.Mixed, default: [] },
    // Constraints the solver does not yet enforce (T24 dependency ordering,
    // T25 resource no-overlap). Stored so a plan never looks cleaner than it is.
    knownGaps: { type: mongoose.Schema.Types.Mixed, default: null },
    // The full FR9.1 baseline result, including its conflict report.
    baseline: { type: mongoose.Schema.Types.Mixed, default: null },
    // D-031: the comparison denominator. Stored so T14 cannot accidentally
    // draw it from the full backlog.
    contestableTaskIds: { type: [String], default: [] },

    inputSummary: {
      taskCount: Number,
      corridorCount: Number,
      prioritySource: String,
    },
    // Best-effort calls that failed. Recorded rather than swallowed, so a
    // missing comparison is distinguishable from a comparison of zero.
    // Named `generationErrors` rather than `errors`: Mongoose reserves the
    // latter as a document pathname and warns that it may break validation.
    generationErrors: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { versionKey: false, _id: false },
);

scheduleSchema.index({ generatedAt: -1 });

export const Schedule = mongoose.model('Schedule', scheduleSchema, 'schedules');
export default Schedule;
