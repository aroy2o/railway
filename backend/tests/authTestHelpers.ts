/**
 * Shared token minting for tests written before FR10 existed.
 *
 * Not `*.test.ts` (see `package.json`'s `test` glob), so it is imported as a
 * plain helper module rather than run as its own suite.
 *
 * `signToken` needs no database round-trip - the payload is self-contained -
 * so every test file can mint a token for whichever role a given request
 * needs without seeding `User` documents into its own isolated test database.
 */
import request from 'supertest';
import type { Express } from 'express';

import { signToken } from '../src/services/authTokens.js';
import type { Department } from '../src/models/Asset.js';
import type { UserRole } from '../src/models/User.js';

export function tokenFor(role: UserRole, department: Department | null = null): string {
  const names: Record<UserRole, string> = {
    dept_engineer: 'Dept Engineer (test)',
    controller: 'Controller (test)',
    drm: 'DRM (test)',
    super_admin: 'Super Admin (test)',
  };
  return signToken({
    sub: `USR-test-${role}`,
    username: `test-${role}`,
    role,
    department: role === 'dept_engineer' ? (department ?? 'Engineering') : department,
    name: names[role],
  });
}

export const CONTROLLER_TOKEN = tokenFor('controller');
export const DRM_TOKEN = tokenFor('drm');
export const ENGINEER_TOKEN = tokenFor('dept_engineer');
export const SUPER_ADMIN_TOKEN = tokenFor('super_admin');

/** `.set(...)` shorthand: `request(app).get(url).set(...authHeader(CONTROLLER_TOKEN))`. */
export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Drop-in replacement for `request(app)` in every test file written before
 * FR10 existed: `authed(app)` behaves exactly like `request(app)` but every
 * `.get(...)`/`.post(...)` already carries a bearer token, defaulting to
 * `controller` - the one role with access to every route those files
 * exercise (generation, override, workflow, whatif, emergency, plus every
 * read endpoint). Role-specific behaviour (refusals, the super_admin bypass)
 * is covered separately in `auth.test.ts`, not re-derived here.
 */
export function authed(app: Express, token: string = CONTROLLER_TOKEN) {
  return {
    get: (url: string) => request(app).get(url).set(authHeader(token)),
    post: (url: string) => request(app).post(url).set(authHeader(token)),
  };
}
