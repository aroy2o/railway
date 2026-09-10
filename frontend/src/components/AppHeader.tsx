/**
 * Application header and primary navigation.
 *
 * Nav items are role-scoped (FR10.1): super_admin sees every route, the three
 * real roles see only what their `RequireRole` route guards actually let them
 * reach (see App.tsx) - the same bypass check as the backend's `requireRole`.
 */
import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'

import { useAppDispatch, useAppSelector } from '../store/hooks.ts'
import { replayRequested } from '../store/slices/tourSlice.ts'
import { loggedOut, type UserRole } from '../store/slices/authSlice.ts'
import RexLogo from './RexLogo.tsx'

interface NavItem {
  to: string
  label: string
  roles: UserRole[]
}

/** The screens a role actually acts on. Always visible. */
const PRIMARY_NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', roles: ['controller'] },
  { to: '/comparison', label: 'Baseline vs AI', roles: ['controller'] },
  { to: '/audit', label: 'Approvals & audit', roles: ['controller', 'drm'] },
  { to: '/oversight', label: 'DRM oversight', roles: ['drm'] },
  { to: '/engineer', label: 'My requests', roles: ['dept_engineer'] },
]

/** Read-only lookup tables — grouped behind "Reference data" (decluttering pass). */
const REFERENCE_NAV_ITEMS: NavItem[] = [
  { to: '/corridors', label: 'Corridors', roles: ['controller', 'drm'] },
  { to: '/assets', label: 'Assets', roles: ['controller', 'drm'] },
  { to: '/tasks', label: 'Backlog', roles: ['controller', 'drm'] },
  { to: '/resources', label: 'Resources', roles: ['controller', 'drm'] },
  { to: '/status', label: 'Status & provenance', roles: ['controller', 'drm'] },
]

const ROLE_LABELS: Record<UserRole, string> = {
  dept_engineer: 'Dept Engineer',
  controller: 'Controller',
  drm: 'DRM',
  super_admin: 'Super Admin',
}

export function AppHeader() {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAppSelector((state) => state.auth.user)
  const [referenceOpen, setReferenceOpen] = useState(false)
  const referenceMenuRef = useRef<HTMLLIElement>(null)

  const visiblePrimaryItems = user
    ? PRIMARY_NAV_ITEMS.filter((item) => user.role === 'super_admin' || item.roles.includes(user.role))
    : []
  const visibleReferenceItems = user
    ? REFERENCE_NAV_ITEMS.filter((item) => user.role === 'super_admin' || item.roles.includes(user.role))
    : []
  const referenceActive = visibleReferenceItems.some((item) => location.pathname.startsWith(item.to))

  // Close the dropdown on an outside click or Escape — it isn't a native
  // <details> element, so nothing does this for free.
  useEffect(() => {
    if (!referenceOpen) return
    function onPointerDown(event: MouseEvent) {
      if (!referenceMenuRef.current?.contains(event.target as Node)) {
        setReferenceOpen(false)
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setReferenceOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [referenceOpen])

  // Every route has its own tour (docs/DECISIONS.md D-072). This button
  // lives here, globally, because it must be reachable from any page - but
  // it does not navigate anywhere: it just raises the `replayRequested`
  // flag, and whichever page is currently mounted picks it up through its
  // own `useAutoTour` call and restarts ITS OWN tour. A judge doing a second
  // demo replays whatever screen they are actually looking at.
  function onReplayWalkthrough() {
    dispatch(replayRequested())
  }

  function onLogout() {
    dispatch(loggedOut())
    navigate('/login', { replace: true })
  }

  return (
    <header className="border-b border-slate-200 bg-white">
      <div
        className={`mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-6 ${
          // The nav row below (only rendered once logged in) supplies its own
          // bottom spacing before the header's bottom edge - without it, this
          // row has no bottom padding at all and sits cramped right against
          // that edge (visible on /login, the one route with no nav row).
          user ? '' : 'pb-4'
        }`}
      >
        <div className="flex items-center gap-3">
          <RexLogo className="h-9 w-9 shrink-0" />
          <div>
            <h1 className="text-base leading-tight font-semibold text-slate-900">
              Rex Planner
            </h1>
            <p className="text-xs text-slate-500">
              Maintenance block planning &amp; decision support
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {user && (
            <>
              <button
                type="button"
                onClick={onReplayWalkthrough}
                className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
              >
                ↻ Replay walkthrough
              </button>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                {user.name} · {ROLE_LABELS[user.role]}
              </span>
              <button
                type="button"
                onClick={onLogout}
                className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
              >
                Log out
              </button>
            </>
          )}
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
            Rex &middot; SIH 26027 &middot; Ministry of Railways
          </span>
        </div>
      </div>

      {user && (
        <nav className="mx-auto max-w-7xl px-4 sm:px-6">
          <ul className="flex flex-wrap items-center gap-1 pt-3">
            {visiblePrimaryItems.map((item) => (
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

            {visibleReferenceItems.length > 0 && (
              <li ref={referenceMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setReferenceOpen((open) => !open)}
                  aria-expanded={referenceOpen}
                  aria-haspopup="true"
                  className={`inline-flex items-center gap-1 rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition ${
                    referenceActive
                      ? 'border-slate-900 text-slate-900'
                      : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                  }`}
                >
                  Reference data
                  <span className={`text-[10px] transition-transform ${referenceOpen ? 'rotate-180' : ''}`} aria-hidden="true">
                    ▾
                  </span>
                </button>

                {referenceOpen && (
                  <ul className="absolute left-0 z-10 mt-1 w-48 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                    {visibleReferenceItems.map((item) => (
                      <li key={item.to}>
                        <NavLink
                          to={item.to}
                          onClick={() => setReferenceOpen(false)}
                          className={({ isActive }) =>
                            `block px-3 py-2 text-sm transition ${
                              isActive
                                ? 'bg-slate-100 font-medium text-slate-900'
                                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                            }`
                          }
                        >
                          {item.label}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )}
          </ul>
        </nav>
      )}
    </header>
  )
}

export default AppHeader
