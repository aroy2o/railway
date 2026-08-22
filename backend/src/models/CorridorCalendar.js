/**
 * `corridor_calendar` collection - the T3 occupancy calendar.
 *
 * Kept separate from `corridors` for the reason recorded in D-009: the two
 * stages must stay independently rebuildable. There is now a second, practical
 * reason (D-016): a busy section carries hundreds of merged occupancy windows,
 * and embedding those would make every corridor list query drag ~47 MB of
 * window arrays around for data the list view never displays.
 *
 * `maxDailyBlockWindows` - the FREE windows, which is what the CP-SAT solver
 * needs - lives here and is joined onto the corridor on the detail endpoint.
 */
import mongoose from 'mongoose';

const windowSchema = new mongoose.Schema(
  {
    start: { type: String, required: true },
    end: { type: String, required: true },
    startMin: { type: Number, required: true },
    endMin: { type: Number, required: true },
    durationMin: { type: Number, required: true },
  },
  { _id: false },
);

const corridorCalendarSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    corridorId: { type: String, required: true, index: true },

    // Raw IR class-code counts observed on the section. No grouping applied -
    // consumers define their own (T4 derives passengerDependency, T22 will
    // derive train priority).
    trainClassMix: { type: Map, of: Number, default: {} },

    // PRD Section 15 calls this `corridors.maxDailyBlockWindows`. It is stored
    // here and joined at read time.
    maxDailyBlockWindows: { type: [windowSchema], default: [] },
    occupiedWindows: { type: [windowSchema], default: [] },

    trainsObserved: { type: Number, default: 0 },
    transitWindows: { type: Number, default: 0 },
    occupiedMinutes: { type: Number, default: 0 },
    freeMinutes: { type: Number, default: 0 },
    utilisationPct: { type: Number, default: 0 },
    lowConfidence: { type: Boolean, default: false },
    lowConfidenceReasons: { type: [String], default: [] },
  },
  { versionKey: false, _id: false },
);

export const CorridorCalendar = mongoose.model(
  'CorridorCalendar',
  corridorCalendarSchema,
  'corridor_calendar',
);
export default CorridorCalendar;
