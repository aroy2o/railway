/**
 * Primary application sidebar - replaces the former top nav (`AppHeader`,
 * removed in the sidebar-shell redesign session). Same role-scoping logic
 * (FR10.1) as before: nav items are filtered against the session's role, and
 * `super_admin` passes every gate, exactly as the top nav did.
 *
 * Renders nothing when logged out - App.tsx shows a small guest brand row
 * instead, since a nav rail with no destinations is not useful chrome.
 */
import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  GitCompareArrows,
  ClipboardCheck,
  Eye,
  FileText,
  Database,
  ChevronDown,
  RotateCcw,
  LogOut,
  Menu,
  X,
  type LucideIcon,
} from 'lucide-react'

import { useAppDispatch, useAppSelector } from '../store/hooks.ts'
import { replayRequested } from '../store/slices/tourSlice.ts'
import { loggedOut, type UserRole } from '../store/slices/authSlice.ts'
import RexLogo from './RexLogo.tsx'

interface NavItem {
  to: string
  label: string
  roles: UserRole[]
  icon: LucideIcon
}

/** The screens a role actually acts on. Always visible. */
const PRIMARY_NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', roles: ['controller'], icon: LayoutDashboard },
  { to: '/comparison', label: 'Baseline vs AI', roles: ['controller'], icon: GitCompareArrows },
  { to: '/audit', label: 'Approvals & audit', roles: ['controller', 'drm'], icon: ClipboardCheck },
  { to: '/oversight', label: 'DRM oversight', roles: ['drm'], icon: Eye },
  { to: '/engineer', label: 'My requests', roles: ['dept_engineer'], icon: FileText },
]

/** Read-only lookup tables — grouped behind a collapsible "Reference data" group. */
const REFERENCE_NAV_ITEMS: NavItem[] = [
  { to: '/corridors', label: 'Corridors', roles: ['controller', 'drm'], icon: Database },
  { to: '/assets', label: 'Assets', roles: ['controller', 'drm'], icon: Database },
  { to: '/tasks', label: 'Backlog', roles: ['controller', 'drm'], icon: Database },
  { to: '/resources', label: 'Resources', roles: ['controller', 'drm'], icon: Database },
  { to: '/status', label: 'Status & provenance', roles: ['controller', 'drm'], icon: Database },
]

const ROLE_LABELS: Record<UserRole, string> = {
  dept_engineer: 'Dept Engineer',
  controller: 'Controller',
  drm: 'DRM',
  super_admin: 'Super Admin',
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase()
}

const NAV_ROW =
  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition'
const NAV_ROW_ACTIVE = 'bg-slate-900 text-white'
const NAV_ROW_INACTIVE = 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2'

function NavRows({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <>
      {items.map((item) => (
        <li key={item.to}>
          <NavLink
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              `${NAV_ROW} ${FOCUS_RING} ${isActive ? NAV_ROW_ACTIVE : NAV_ROW_INACTIVE}`
            }
          >
            <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {item.label}
          </NavLink>
        </li>
      ))}
    </>
  )
}

/** Nav list plus the account block at the bottom - shared by the desktop
 * rail and the mobile drawer so the two never drift out of sync. */
function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAppSelector((state) => state.auth.user)
  const [referenceOpen, setReferenceOpen] = useState(false)

  const visiblePrimaryItems = user
    ? PRIMARY_NAV_ITEMS.filter((item) => user.role === 'super_admin' || item.roles.includes(user.role))
    : []
  const visibleReferenceItems = user
    ? REFERENCE_NAV_ITEMS.filter((item) => user.role === 'super_admin' || item.roles.includes(user.role))
    : []
  const referenceActive = visibleReferenceItems.some((item) => location.pathname.startsWith(item.to))

  function onReplayWalkthrough() {
    dispatch(replayRequested())
    onNavigate?.()
  }

  function onLogout() {
    dispatch(loggedOut())
    onNavigate?.()
    navigate('/login', { replace: true })
  }

  if (!user) return null

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-5">
        <RexLogo className="h-9 w-9 shrink-0" />
        <div className="min-w-0">
          <h1 className="text-base leading-tight font-semibold text-slate-900">Rex Planner</h1>
          <p className="truncate text-xs text-slate-500">SIH 26027 · Ministry of Railways</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2" aria-label="Primary">
        <ul className="space-y-0.5">
          <NavRows items={visiblePrimaryItems} onNavigate={onNavigate} />
        </ul>

        {visibleReferenceItems.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setReferenceOpen((open) => !open)}
              aria-expanded={referenceOpen}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold tracking-wide uppercase transition ${FOCUS_RING} ${
                referenceActive ? 'text-slate-900' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Reference data
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${referenceOpen ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
            {referenceOpen && (
              <ul className="mt-0.5 space-y-0.5">
                <NavRows items={visibleReferenceItems} onNavigate={onNavigate} />
              </ul>
            )}
          </div>
        )}
      </nav>

      <div className="space-y-1 border-t border-slate-200 p-3">
        <button
          type="button"
          onClick={onReplayWalkthrough}
          className={`${NAV_ROW} ${NAV_ROW_INACTIVE} ${FOCUS_RING} w-full`}
        >
          <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
          Replay walkthrough
        </button>

        <div className="flex items-center gap-2.5 rounded-lg px-3 py-2">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white"
            aria-hidden="true"
          >
            {initials(user.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-900">{user.name}</p>
            <p className="truncate text-xs text-slate-500">{ROLE_LABELS[user.role]}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={onLogout}
          className={`${NAV_ROW} ${NAV_ROW_INACTIVE} ${FOCUS_RING} w-full`}
        >
          <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
          Log out
        </button>
      </div>
    </>
  )
}

export function Sidebar() {
  const user = useAppSelector((state) => state.auth.user)
  const [mobileOpen, setMobileOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)

  // Close the drawer on Escape, and on route change (NavLink's onClick
  // already closes it on a real navigation - this covers browser back/forward).
  useEffect(() => {
    if (!mobileOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [mobileOpen])

  if (!user) return null

  return (
    <>
      {/* Mobile top bar - the sidebar itself is off-canvas below `lg`. */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <div className="flex items-center gap-2.5">
          <RexLogo className="h-8 w-8 shrink-0" />
          <span className="text-sm font-semibold text-slate-900">Rex Planner</span>
        </div>
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          aria-expanded={mobileOpen}
          className={`rounded-lg border border-slate-300 p-2 text-slate-600 ${FOCUS_RING}`}
        >
          <Menu className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Desktop rail - always visible, no toggle. */}
      <aside className="hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:flex-col lg:border-r lg:border-slate-200 lg:bg-white">
        <SidebarBody />
      </aside>

      {/* Mobile drawer - off-canvas, opened from the top bar above. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-slate-950/50"
          />
          <div
            ref={drawerRef}
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-lg"
          >
            <div className="flex items-center justify-end px-3 pt-3">
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className={`rounded-lg border border-slate-300 p-2 text-slate-600 ${FOCUS_RING}`}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <SidebarBody onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}
    </>
  )
}

export default Sidebar
