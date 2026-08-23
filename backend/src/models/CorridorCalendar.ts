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
import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

export interface TimeWindow {
  start: string;
  end: string;
  startMin: number;
  endMin: number;
  durationMin: number;
}

export interface ICorridorCalendar {
  _id: string;
  corridorId: string;
  /** Raw IR class-code counts. No grouping applied - consumers define theirs. */
  trainClassMix: Map<string, number>;
  /** PRD Section 15's `corridors.maxDailyBlockWindows`, stored here. */
  maxDailyBlockWindows: TimeWindow[];
  occupiedWindows: TimeWindow[];
  trainsObserved: number;
  transitWindows: number;
  occupiedMinutes: number;
  freeMinutes: number;
  utilisationPct: number;
  lowConfidence: boolean;
  lowConfidenceReasons: string[];
}

export type CorridorCalendarDocument = HydratedDocument<ICorridorCalendar>;

const windowSchema = new Schema<TimeWindow>(
  {
    start: { type: String, required: true },
    end: { type: String, required: true },
    startMin: { type: Number, required: true },
    endMin: { type: Number, required: true },
    durationMin: { type: Number, required: true },
  },
  { _id: false },
);

const corridorCalendarSchema = new Schema<ICorridorCalendar>(
  {
    _id: { type: String, required: true },
    corridorId: { type: String, required: true, index: true },
    trainClassMix: { type: Map, of: Number, default: {} },
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

export const CorridorCalendar: Model<ICorridorCalendar> = mongoose.model<ICorridorCalendar>(
  'CorridorCalendar',
  corridorCalendarSchema,
  'corridor_calendar',
);
export default CorridorCalendar;
