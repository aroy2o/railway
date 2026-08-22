/**
 * `resources` collection - PRD Section 15 / PRD 9.8.
 *
 * SYNTHETIC. Crews, machines and permissions, scoped to a depot rather than a
 * single corridor - that sharing is what creates genuine resource contention
 * for the optimizer to resolve.
 */
import mongoose from 'mongoose';

const resourceSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    type: { type: String, enum: ['crew', 'machine', 'permission'], required: true, index: true },
    name: { type: String, required: true },
    // Corridors this resource can be deployed to. Indexed because "which
    // resources serve this corridor" is a per-request lookup.
    corridorScope: { type: [String], default: [], index: true },
    department: {
      type: String,
      enum: ['Engineering', 'S&T', 'TRD'],
      required: true,
      index: true,
    },
    depot: { type: String, required: true, index: true },
    synthetic: { type: Boolean, default: true },
  },
  { versionKey: false, _id: false },
);

export const Resource = mongoose.model('Resource', resourceSchema, 'resources');
export default Resource;
