/**
 * `resources` collection - PRD Section 15 / PRD 9.8.
 *
 * SYNTHETIC. Crews, machines and permissions, scoped to a depot rather than a
 * single corridor - that sharing is what creates genuine resource contention
 * for the optimizer to resolve.
 */
import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import type { Department } from './Asset.js';

export type ResourceType = 'crew' | 'machine' | 'permission';

export interface IResource {
  _id: string;
  type: ResourceType;
  name: string;
  /** Corridors this resource can be deployed to. */
  corridorScope: string[];
  department: Department;
  depot: string;
  synthetic: boolean;
}

export type ResourceDocument = HydratedDocument<IResource>;

const resourceSchema = new Schema<IResource>(
  {
    _id: { type: String, required: true },
    type: { type: String, enum: ['crew', 'machine', 'permission'], required: true, index: true },
    name: { type: String, required: true },
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

export const Resource: Model<IResource> = mongoose.model<IResource>(
  'Resource',
  resourceSchema,
  'resources',
);
export default Resource;
