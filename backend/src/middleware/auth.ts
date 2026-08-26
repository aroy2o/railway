/**
 * FR10 - JWT auth (`requireAuth`) and role gating (`requireRole`).
 *
 * `super_admin` is a demo/dev-convenience role, NOT in FR10.1's three named
 * roles (Dept Engineer / Controller / DRM). It satisfies `requireRole` for ANY
 * role list via one explicit bypass check here - never by listing
 * `super_admin` in every call site's argument list, which would be one missed
 * route away from a hole. See docs/DECISIONS.md for the entry recording this
 * as beyond PRD scope.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { UserRole } from '../models/User.js';
import { verifyToken } from '../services/authTokens.js';
import { ApiError } from '../utils/ApiError.js';

const BEARER_PREFIX = 'Bearer ';

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    next(ApiError.unauthorized('Missing or malformed Authorization header'));
    return;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  const payload = verifyToken(token);
  if (!payload) {
    next(ApiError.unauthorized('Invalid or expired token'));
    return;
  }

  req.user = {
    id: payload.sub,
    username: payload.username,
    role: payload.role,
    department: payload.department,
    name: payload.name,
  };
  next();
}

/**
 * Restricts a route to the given roles. `super_admin` always passes,
 * regardless of what is listed - the one explicit bypass this project's auth
 * design calls for, rather than a convention every call site has to remember.
 *
 * Must run after `requireAuth` - it throws INTERNAL_ERROR (not UNAUTHORIZED)
 * if `req.user` is missing, since that is a wiring bug, not a client error.
 */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return function requireRoleHandler(req: Request, _res: Response, next: NextFunction): void {
    if (!req.user) {
      next(new ApiError(500, 'requireRole used without requireAuth', { code: 'INTERNAL_ERROR' }));
      return;
    }
    if (req.user.role === 'super_admin' || roles.includes(req.user.role)) {
      next();
      return;
    }
    next(
      ApiError.forbidden(
        `This action requires one of: ${roles.join(', ')}. Your role is ${req.user.role}.`,
      ),
    );
  };
}
