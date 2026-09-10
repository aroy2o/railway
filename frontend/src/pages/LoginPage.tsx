/**
 * PRD Section 8 screen 1 - Login / Role selector (FR10).
 *
 * A plain username/password form, not a manual role dropdown: real JWT auth
 * (FR10.2) means the role comes from which account logs in, not from a
 * client-side selector next to it. Demo account credentials are documented in
 * `DEMO_ACCOUNTS.md` at the repo root, deliberately not shown here - see that
 * file's own note on why.
 */
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'

import { describeApiError, useLoginMutation } from '../api/apiSlice.ts'
import { credentialsReceived, roleLandingRoute } from '../store/slices/authSlice.ts'
import { useAppDispatch, useAppSelector } from '../store/hooks.ts'

export function LoginPage() {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const user = useAppSelector((state) => state.auth.user)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [login, loginState] = useLoginMutation()

  // Already logged in - do not show a login form to someone who has one.
  // Deliberately NOT "return to wherever RequireRole redirected from" -
  // React Router's `location.state` can survive a full page reload on the
  // same URL (e.g. re-visiting /login after a logout+login cycle), which
  // would silently send a freshly-logged-in user back to a PREVIOUS
  // session's page. Always landing on the role's own default route is
  // simpler and has no stale-state hazard.
  if (user) {
    return <Navigate to={roleLandingRoute(user.role)} replace />
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    try {
      const result = await login({ username, password }).unwrap()
      dispatch(credentialsReceived(result.data))
      navigate(roleLandingRoute(result.data.user.role), { replace: true })
    } catch {
      // loginState.error already carries the failure; describeApiError below renders it.
    }
  }

  return (
    <div className="mx-auto mt-12 max-w-sm sm:mt-20">
      <form
        onSubmit={onSubmit}
        className="space-y-5 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
      >
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500">Use your Rex Planner account to continue.</p>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="username" className="mb-1.5 block text-xs font-medium text-slate-600">
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm transition focus:border-slate-500 focus:ring-1 focus:ring-slate-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-slate-600">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm transition focus:border-slate-500 focus:ring-1 focus:ring-slate-500 focus:outline-none"
            />
          </div>
        </div>

        {loginState.error && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-rose-600/20 ring-inset">
            {describeApiError(loginState.error)}
          </p>
        )}

        <button
          type="submit"
          disabled={loginState.isLoading}
          className="w-full rounded-lg bg-slate-900 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loginState.isLoading ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="text-center text-xs text-slate-400">
          Demo account credentials: see <code>DEMO_ACCOUNTS.md</code> at the repo root.
        </p>
      </form>
    </div>
  )
}

export default LoginPage
