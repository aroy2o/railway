/**
 * Route guard - FR10.1. Unauthenticated -> /login; wrong role -> that role's
 * OWN landing route, never a bare 403 (per the auth session's explicit
 * instruction: a misrouted user should land somewhere useful, not a dead end).
 *
 * `super_admin` always passes, mirroring the backend's `requireRole` bypass
 * (backend/src/middleware/auth.ts) - one explicit check here too, rather than
 * listing it at every call site.
 */
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'

import { useAppSelector } from '../store/hooks.ts'
import { roleLandingRoute, type UserRole } from '../store/slices/authSlice.ts'

export function RequireRole({ roles, children }: { roles: UserRole[]; children: ReactNode }) {
  const { token, user } = useAppSelector((state) => state.auth)

  // No `state: { from }` round-trip back to LoginPage - see its own comment
  // on why that turned out to be a stale-state hazard across a full page
  // reload on /login.
  if (!token || !user) {
    return <Navigate to="/login" replace />
  }

  if (user.role !== 'super_admin' && !roles.includes(user.role)) {
    return <Navigate to={roleLandingRoute(user.role)} replace />
  }

  return <>{children}</>
}

export default RequireRole
