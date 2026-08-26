/**
 * Password hashing and JWT issue/verify - FR10.2.
 *
 * `bcryptjs` rather than native `bcrypt`: pure JS, no node-gyp compile step,
 * which matters for TX1's still-unverified Docker build (D-005) - one fewer
 * native dependency to fail inside a container image.
 *
 * The JWT payload carries everything a request needs (id, username, role,
 * department) so `requireAuth` never has to round-trip to Mongo per request -
 * defensible because there are exactly four fixed, seed-owned accounts with no
 * self-registration or profile editing, so the token can never go stale
 * against a user record that changed underneath it.
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { config } from '../config/env.js';
import type { Department } from '../models/Asset.js';
import type { UserRole } from '../models/User.js';

const SALT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface AuthTokenPayload {
  sub: string;
  username: string;
  role: UserRole;
  department: Department | null;
  name: string;
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'] });
}

/** Returns null on any verification failure (expired, malformed, wrong signature) rather than throwing. */
export function verifyToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, config.jwt.secret) as AuthTokenPayload;
  } catch {
    return null;
  }
}
