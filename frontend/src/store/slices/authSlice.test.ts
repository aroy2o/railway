import { describe, expect, it } from 'vitest'
import authReducer, {
  credentialsReceived,
  loggedOut,
  roleLandingRoute,
  type AuthState,
  type AuthUser,
} from './authSlice.ts'

// This import alone is the regression test for the `window`-at-module-scope
// trap D-072 already hit once for lib/tour.ts: authSlice.ts calls
// `loadPersisted()` at module load time, and this suite runs under plain
// Node with no jsdom configured - if the `typeof window === 'undefined'`
// guard were ever removed, every test file that imports the store
// (transitively, via apiSlice.ts) would fail to even load.

function initial(): AuthState {
  return { token: null, user: null }
}

const user: AuthUser = {
  id: 'USR-1',
  username: 'controller',
  name: 'Controller (demo)',
  role: 'controller',
}

describe('authSlice', () => {
  it('credentialsReceived stores the token and user', () => {
    const state = authReducer(initial(), credentialsReceived({ token: 'abc', user }))
    expect(state.token).toBe('abc')
    expect(state.user).toEqual(user)
  })

  it('loggedOut clears both', () => {
    const loggedIn = authReducer(initial(), credentialsReceived({ token: 'abc', user }))
    const state = authReducer(loggedIn, loggedOut())
    expect(state.token).toBeNull()
    expect(state.user).toBeNull()
  })
})

describe('roleLandingRoute', () => {
  it('sends dept_engineer to their portal', () => {
    expect(roleLandingRoute('dept_engineer')).toBe('/engineer')
  })

  it('sends drm to the oversight view', () => {
    expect(roleLandingRoute('drm')).toBe('/oversight')
  })

  it('sends controller to the dashboard', () => {
    expect(roleLandingRoute('controller')).toBe('/dashboard')
  })

  it('sends super_admin to the dashboard too - the most useful demo view', () => {
    expect(roleLandingRoute('super_admin')).toBe('/dashboard')
  })
})
