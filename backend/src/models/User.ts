/**
 * `users` collection - FR10 (auth & roles).
 *
 * Not a PRD Section 15 collection - the PRD's data model predates FR10.1 being
 * built, and never named a `users` shape. Added net-new for this task.
 *
 * No self-registration (per the auth session brief): the seed script creates
 * exactly four fixed demo accounts, one per role, and this model never gains a
 * public write path. `super_admin` is a demo/dev-convenience role beyond
 * FR10.1's three named roles - see docs/DECISIONS.md for the entry recording
 * that explicitly.
 */
import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import type { Department } from './Asset.js';

export type UserRole = 'dept_engineer' | 'controller' | 'drm' | 'super_admin';

export interface IUser {
  _id: string;
  username: string;
  email: string | null;
  passwordHash: string;
  role: UserRole;
  name: string;
  /** Only meaningful for dept_engineer accounts - which department's queue
   * they submit into. Absent for the other three roles. */
  department: Department | null;
  createdAt: Date;
}

export type UserDocument = HydratedDocument<IUser>;

const userSchema = new Schema<IUser>(
  {
    _id: { type: String, required: true },
    username: { type: String, required: true, unique: true, index: true },
    email: { type: String, default: null },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ['dept_engineer', 'controller', 'drm', 'super_admin'],
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    department: { type: String, enum: ['Engineering', 'S&T', 'TRD'], default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false, _id: false },
);

export const User: Model<IUser> = mongoose.model<IUser>('User', userSchema, 'users');
export default User;
