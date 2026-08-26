/**
 * Augments Express's Request with the identity `requireAuth` attaches.
 *
 * Declared globally rather than as a generic parameter so every route handler
 * gets `req.user` typed with zero per-file wiring.
 */
import type { Department } from '../models/Asset.js';
import type { UserRole } from '../models/User.js';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username: string;
        role: UserRole;
        department: Department | null;
        name: string;
      };
    }
  }
}

export {};
