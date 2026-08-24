/**
 * Application header and primary navigation.
 *
 * Role switching between the Controller / Engineer / DRM dashboards
 * (PRD Section 8) arrives with the auth flow in the rest of T11.
 */
import { NavLink } from 'react-router-dom'

import { useAppDispatch } from '../store/hooks.ts'
import { replayRequested } from '../store/slices/tourSlice.ts'

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/comparison', label: 'Baseline vs AI' },
  { to: '/audit', label: 'Approvals & audit' },
  { to: '/oversight', label: 'DRM oversight' },
  { to: '/corridors', label: 'Corridors' },
  { to: '/assets', label: 'Assets' },
  { to: '/tasks', label: 'Backlog' },
  { to: '/resources', label: 'Resources' },
  { to: '/status', label: 'Status & provenance' },
]

export function AppHeader() {
  const dispatch = useAppDispatch()

  // Every route has its own tour (docs/DECISIONS.md D-072). This button
  // lives here, globally, because it must be reachable from any page - but
  // it does not navigate anywhere: it just raises the `replayRequested`
  // flag, and whichever page is currently mounted picks it up through its
  // own `useAutoTour` call and restarts ITS OWN tour. A judge doing a second
  // demo replays whatever screen they are looking at right now.
  function onReplayWalkthrough() {
    dispatch(replayRequested())
  }

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-6">
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-sm font-bold text-white"
            aria-hidden="true"
          >
            BP
          </div>
          <div>
            <h1 className="text-base leading-tight font-semibold text-slate-900">
              AI-Assisted Block Planning
            </h1>
            <p className="text-xs text-slate-500">
              Maintenance block planning &amp; decision support
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onReplayWalkthrough}
            className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
          >
            ↻ Replay walkthrough
          </button>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
            SIH 26027 &middot; Ministry of Railways
          </span>
        </div>
      </div>

      <nav className="mx-auto max-w-7xl px-4 sm:px-6">
        <ul className="flex flex-wrap gap-1 pt-3">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  `inline-block rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition ${
                    isActive
                      ? 'border-slate-900 text-slate-900'
                      : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                  }`
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  )
}

export default AppHeader
