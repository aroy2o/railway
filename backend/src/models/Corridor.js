/**
 * `corridors` collection - PRD Section 15.
 *
 * Structural facts about a real corridor section, produced by T2 from
 * datameet/railways route data. Occupancy lives in a separate collection
 * (see CorridorCalendar.js and docs/DECISIONS.md D-009/D-016).
 */
import mongoose from 'mongoose';

const stationSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    zone: { type: String, default: null },
    state: { type: String, default: null },
    address: { type: String, default: null },
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
  },
  { _id: false },
);

const corridorSchema = new mongoose.Schema(
  {
    // Human-readable string id ("GZB-SBB") rather than an ObjectId, so the
    // sorted station-code pair stays the key across every file, collection and
    // URL. See docs/DECISIONS.md D-017.
    _id: { type: String, required: true },

    // --- PRD Section 15 shape -------------------------------------------
    name: { type: String, required: true },
    zone: { type: String, default: null },
    section: { type: String, required: true },
    // Deliberately NOT stored here - see D-009. Occupancy and free windows
    // live in `corridor_calendar` and are joined on read.
    seasonalRiskFlag: { type: String, default: null },

    // --- real extensions produced by T2 ---------------------------------
    stationA: { type: stationSchema, required: true },
    stationB: { type: stationSchema, required: true },
    zones: { type: [String], default: [] },
    states: { type: [String], default: [] },
    trainTraversals: { type: Number, default: 0 },
    distinctTrains: { type: Number, default: 0 },
    directionalTraversals: { type: Map, of: Number, default: {} },
    publishedDistanceKm: { type: Number, default: null },
    straightLineKm: { type: Number, default: null },
    derivedFlags: {
      longHop: { type: Boolean, default: false },
    },
    sources: { type: [String], default: [] },

    // --- denormalised at seed time --------------------------------------
    // True when T4 generated assets for this section. This is what lets the
    // dashboard fetch the ~30 relevant corridors out of 10,149 with an index
    // hit instead of a collection scan (D-018).
    hasSyntheticDemand: { type: Boolean, default: false, index: true },

    // Small scalar summary of the calendar, copied here so list views can sort
    // and filter on utilisation without loading the heavy window arrays.
    occupancySummary: {
      trainsObserved: { type: Number, default: 0 },
      occupiedMinutes: { type: Number, default: 0 },
      freeMinutes: { type: Number, default: 0 },
      utilisationPct: { type: Number, default: 0 },
      blockWindowCount: { type: Number, default: 0 },
      lowConfidence: { type: Boolean, default: false },
    },
  },
  { versionKey: false, timestamps: false, _id: false },
);

corridorSchema.index({ hasSyntheticDemand: 1, 'occupancySummary.utilisationPct': -1 });
corridorSchema.index({ zone: 1 });

export const Corridor = mongoose.model('Corridor', corridorSchema, 'corridors');
export default Corridor;
