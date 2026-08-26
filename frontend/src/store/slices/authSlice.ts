/**
 * Authenticated session state (FR10.1 - role-based access).
 *
 * `super_admin` is a demo/dev-convenience role beyond FR10.1's three named
 * roles - see docs/DECISIONS.md.
 *
 * Persisted to `sessionStorage`, not `localStorage`: it survives an accidental
 * page refresh mid-demo (the practical risk that mattered here) while still
 * never outliving the tab - closing it clears the session exactly as the
 * original in-memory-only design intended. Every read/write is wrapped in
 * try/catch: a private-browsing tab or a blocked storage API must degrade to
 * "not persisted", never throw and break login.
 */
import { createSlice } from '@reduxjs/toolkit'
import type { PayloadAction } from '@reduxjs/toolkit'

/** PRD Section 4 personas, as FR10.1 names them, plus the demo-convenience bypass role. */
export type UserRole = 'dept_engineer' | 'controller' | 'drm' | 'super_admin'

export interface AuthUser {
  id: string
  username: string
  name: string
  role: UserRole
  /** Only set for dept_engineer accounts: which department's queue they submit into. */
  department?: 'Engineering' | 'S&T' | 'TRD' | null
}

export interface AuthState {
  token: string | null
  user: AuthUser | null
}

const STORAGE_KEY = 'railway-block-planning:auth'

/**
 * `window` does not exist outside a browser - this project's frontend test
 * suite runs under plain Node with no jsdom configured (confirmed the hard
 * way once already: `lib/tour.ts`'s first version hit exactly this
 * `ReferenceError` importing `window.localStorage` at module scope, per
 * docs/DECISIONS.md D-072). This module is imported by `apiSlice.ts` and the
 * store, which any component test could pull in transitively, so the guard
 * has to be here even though nothing here is unit-tested directly.
 */
function loadPersisted(): AuthState {
  if (typeof window === 'undefined') return { token: null, user: null }
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return { token: null, user: null }
    const parsed = JSON.parse(raw) as AuthState
    if (!parsed.token || !parsed.user) return { token: null, user: null }
    return parsed
  } catch {
    return { token: null, user: null }
  }
}

function persist(state: AuthState): void {
  if (typeof window === 'undefined') return
  try {
    if (state.token && state.user) {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // Storage blocked (private mode, etc.) - the session still works for the
    // rest of this page load, it just will not survive a refresh.
  }
}

const initialState: AuthState = loadPersisted()

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    credentialsReceived(state, action: PayloadAction<{ token: string; user: AuthUser }>) {
      state.token = action.payload.token
      state.user = action.payload.user
      persist(state)
    },
    loggedOut(state) {
      state.token = null
      state.user = null
      persist(state)
    },
  },
})

export const { credentialsReceived, loggedOut } = authSlice.actions
export default authSlice.reducer

/** Where each role lands after login, or when it hits a route it cannot use. */
export function roleLandingRoute(role: UserRole): string {
  switch (role) {
    case 'dept_engineer':
      return '/engineer'
    case 'drm':
      return '/oversight'
    case 'controller':
    case 'super_admin':
    default:
      return '/dashboard'
  }
}
