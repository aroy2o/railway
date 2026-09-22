/**
 * PRD Section 8 screen 1 - Login / Role selector (FR10).
 *
 * A plain username/password form, not a manual role dropdown: real JWT auth
 * (FR10.2) means the role comes from which account logs in, not from a
 * client-side selector next to it. Demo account credentials (from
 * `DEMO_ACCOUNTS.md` at the repo root) are shown alongside the form so a
 * judge/evaluator can self-serve login without that file - a deliberate
 * reversal of this screen's original "credentials stay out of the UI"
 * design, made for demo/evaluation convenience.
 */
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'

import { describeApiError, useLoginMutation } from '../api/apiSlice.ts'
import { credentialsReceived, roleLandingRoute } from '../store/slices/authSlice.ts'
import { useAppDispatch, useAppSelector } from '../store/hooks.ts'

const DEMO_ACCOUNTS = [
  {
    role: 'Dept Engineer',
    username: 'engineer',
    password: 'engineer123',
    note: 'Submits maintenance requests, sees only their own.',
  },
  {
    role: 'Controller',
    username: 'controller',
    password: 'controller123',
    note: 'Full read/write on Dashboard, Comparison, Approval & Audit.',
  },
  {
    role: 'DRM',
    username: 'drm',
    password: 'drm123',
    note: 'Read-only: Oversight view and Approval & Audit.',
  },
  {
    role: 'Super Admin',
    username: 'admin',
    password: 'admin123',
    note: 'Demo convenience account, bypasses every role gate.',
  },
] as const

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

  function fillCredentials(account: (typeof DEMO_ACCOUNTS)[number]) {
    setUsername(account.username)
    setPassword(account.password)
  }

  return (
    <div className="mx-auto mt-12 flex max-w-3xl flex-col gap-6 sm:mt-20 sm:flex-row sm:items-start">
      <form
        onSubmit={onSubmit}
        className="w-full space-y-5 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm sm:max-w-sm"
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
          className="w-full rounded-lg bg-slate-900 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 active:bg-slate-950 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loginState.isLoading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <aside className="w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:max-w-xs">
        <h2 className="text-sm font-semibold text-slate-900">Demo accounts</h2>
        <p className="mt-1 text-xs text-slate-500">
          For evaluators — click an account to fill the form, then Sign in.
        </p>
        <ul className="mt-4 space-y-3">
          {DEMO_ACCOUNTS.map((account) => (
            <li key={account.username}>
              <button
                type="button"
                onClick={() => fillCredentials(account)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-left text-xs transition hover:border-slate-400 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                <p className="font-medium text-slate-900">{account.role}</p>
                <p className="mt-1 font-mono text-slate-600">
                  {account.username} / {account.password}
                </p>
                <p className="mt-1 text-slate-400">{account.note}</p>
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-2xs text-slate-400">
          Not real secrets — fixed demo accounts only. Full details in{' '}
          <code>DEMO_ACCOUNTS.md</code> at the repo root.
        </p>
      </aside>
    </div>
  )
}

export default LoginPage
