/**
 * `dataset_provenance` collection - the honesty framing, made queryable.
 *
 * T4 writes a disclaimer, the generator seed and a field-level real/synthetic
 * provenance map into the HEADER of each processed file. That header is not
 * part of any record, so without somewhere to put it the framing would be lost
 * the moment the data entered MongoDB - which is precisely the failure
 * docs/DECISIONS.md D-015 exists to prevent.
 *
 * One document per seeded source file. Exposed at GET /api/provenance so the
 * UI can render the disclaimer alongside the data it describes.
 */
import mongoose from 'mongoose';

const datasetProvenanceSchema = new mongoose.Schema(
  {
    // The collection this describes, e.g. "assets".
    _id: { type: String, required: true },
    sourceFile: { type: String, required: true },
    // False for the real ingestion outputs (corridors, calendar).
    synthetic: { type: Boolean, required: true },
    disclaimer: { type: String, default: null },
    seed: { type: Number, default: null },
    referenceDate: { type: String, default: null },
    // { real: {...}, synthetic: {...}, computedDownstream: {...} }
    fieldProvenance: { type: mongoose.Schema.Types.Mixed, default: null },
    recordCount: { type: Number, required: true },
    seededAt: { type: Date, required: true },
  },
  { versionKey: false, _id: false },
);

export const DatasetProvenance = mongoose.model(
  'DatasetProvenance',
  datasetProvenanceSchema,
  'dataset_provenance',
);
export default DatasetProvenance;
