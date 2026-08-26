/**
 * Application shell and routing.
 *
 * Every route except /login sits behind `RequireRole` (FR10.1): unauthenticated
 * -> /login, wrong role -> that role's own landing route, never a bare 403.
 * `super_admin` is a demo/dev-convenience role, not in FR10.1's three named
 * roles, and passes every gate - see docs/DECISIONS.md.
 */
import { Navigate, Route, Routes } from 'react-router-dom'

import AppHeader from './components/AppHeader.tsx'
import PrototypeBanner from './components/PrototypeBanner.tsx'
import TourOverlay from './components/TourOverlay.tsx'
import RequireRole from './components/RequireRole.tsx'
import LoginPage from './pages/LoginPage.tsx'
import DeptEngineerPortal from './pages/DeptEngineerPortal.tsx'
import AssetsPage from './pages/AssetsPage.tsx'
import AuditPage from './pages/AuditPage.tsx'
import ComparisonPage from './pages/ComparisonPage.tsx'
import ControllerDashboard from './pages/ControllerDashboard.tsx'
import CorridorDetailPage from './pages/CorridorDetailPage.tsx'
import CorridorsPage from './pages/CorridorsPage.tsx'
import DrmOversightPage from './pages/DrmOversightPage.tsx'
import ResourcesPage from './pages/ResourcesPage.tsx'
import StatusPage from './pages/StatusPage.tsx'
import TasksPage from './pages/TasksPage.tsx'
import { useAppSelector } from './store/hooks.ts'
import { roleLandingRoute } from './store/slices/authSlice.ts'

function NotFound() {
  return (
    <div className="py-16 text-center">
      <p className="text-sm font-medium text-slate-700">No such page.</p>
    </div>
  )
}

/** `/` redirects to whichever landing route the current session's role gets. */
function RootRedirect() {
  const user = useAppSelector((state) => state.auth.user)
  return <Navigate to={user ? roleLandingRoute(user.role) : '/login'} replace />
}

function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <PrototypeBanner />
      <AppHeader />

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<RootRedirect />} />

          {/* PRD Section 8 calls the Controller Dashboard the primary demo
              screen and its build order puts it first (D-039). Controller
              only - see docs/DECISIONS.md's auth-session entry. */}
          <Route
            path="/dashboard"
            element={
              <RequireRole roles={['controller']}>
                <ControllerDashboard />
              </RequireRole>
            }
          />
          <Route
            path="/comparison"
            element={
              <RequireRole roles={['controller']}>
                <ComparisonPage />
              </RequireRole>
            }
          />
          {/* Controller: full read/write. DRM: read-only (AuditPage itself
              hides the write-capable WorkflowPanel for drm). */}
          <Route
            path="/audit"
            element={
              <RequireRole roles={['controller', 'drm']}>
                <AuditPage />
              </RequireRole>
            }
          />
          <Route
            path="/oversight"
            element={
              <RequireRole roles={['drm']}>
                <DrmOversightPage />
              </RequireRole>
            }
          />
          <Route
            path="/engineer"
            element={
              <RequireRole roles={['dept_engineer']}>
                <DeptEngineerPortal />
              </RequireRole>
            }
          />

          {/*
            Read-only reference/browsing pages. Never role-scoped in the PRD
            (only the seven PRD Section 8 screens above are) - flagged rather
            than guessed: kept open to controller/drm/super_admin as shared
            reference data, not offered to dept_engineer, whose PRD-defined
            scope is narrower (own requests + published schedule only, both
            served by /engineer above).
          */}
          <Route
            path="/corridors"
            element={
              <RequireRole roles={['controller', 'drm']}>
                <CorridorsPage />
              </RequireRole>
            }
          />
          <Route
            path="/corridors/:id"
            element={
              <RequireRole roles={['controller', 'drm']}>
                <CorridorDetailPage />
              </RequireRole>
            }
          />
          <Route
            path="/assets"
            element={
              <RequireRole roles={['controller', 'drm']}>
                <AssetsPage />
              </RequireRole>
            }
          />
          <Route
            path="/tasks"
            element={
              <RequireRole roles={['controller', 'drm']}>
                <TasksPage />
              </RequireRole>
            }
          />
          <Route
            path="/resources"
            element={
              <RequireRole roles={['controller', 'drm']}>
                <ResourcesPage />
              </RequireRole>
            }
          />
          <Route
            path="/status"
            element={
              <RequireRole roles={['controller', 'drm']}>
                <StatusPage />
              </RequireRole>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-10 text-xs text-slate-400 sm:px-6">
        Decision-support prototype — not a certified safety system (PRD non-goal NG3).
      </footer>

      <TourOverlay />
    </div>
  )
}

export default App
