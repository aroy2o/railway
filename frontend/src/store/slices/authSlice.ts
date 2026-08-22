/**
 * Authenticated session state (FR10.1 - role-based access).
 *
 * Scope today is the shape plus the reducers the API layer needs to attach a
 * bearer token. The login flow that populates it is task T11; role-gated
 * routing (Dept Engineer / Controller / DRM) lands with it.
 *
 * The token is held in Redux only - deliberately not in localStorage, so a
 * stale token cannot outlive the tab. Persisting it is a T11 decision.
 */
import { createSlice } from '@reduxjs/toolkit'
import type { PayloadAction } from '@reduxjs/toolkit'

/** PRD Section 4 personas, as the roles the API authorises against. */
export type UserRole = 'engineer' | 'controller' | 'drm'

export interface AuthUser {
  id: string
  name: string
  role: UserRole
  /** Only set for engineers: which department's queue they belong to. */
  department?: 'Engineering' | 'S&T' | 'TRD'
}

export interface AuthState {
  token: string | null
  user: AuthUser | null
}

const initialState: AuthState = {
  token: null,
  user: null,
}

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    credentialsReceived(state, action: PayloadAction<{ token: string; user: AuthUser }>) {
      state.token = action.payload.token
      state.user = action.payload.user
    },
    loggedOut(state) {
      state.token = null
      state.user = null
    },
  },
})

export const { credentialsReceived, loggedOut } = authSlice.actions
export default authSlice.reducer
