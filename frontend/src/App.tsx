/**
 * Application shell and routing.
 *
 * The Controller Dashboard (PRD Section 8) is the landing route; the read-only
 * data views remain reachable from the nav.
 *
 * Still to come: what-if simulation (T20) and policy sliders (T23).
 */
import { Navigate, Route, Routes } from 'react-router-dom'

import AppHeader from './components/AppHeader.tsx'
import PrototypeBanner from './components/PrototypeBanner.tsx'
import TourOverlay from './components/TourOverlay.tsx'
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

function NotFound() {
  return (
    <div className="py-16 text-center">
      <p className="text-sm font-medium text-slate-700">No such page.</p>
    </div>
  )
}

function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <PrototypeBanner />
      <AppHeader />

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <Routes>
          {/* PRD Section 8 calls the Controller Dashboard the primary demo
              screen and its build order puts it first, so it is now the
              landing route. See docs/DECISIONS.md D-039. */}
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<ControllerDashboard />} />
          <Route path="/comparison" element={<ComparisonPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/oversight" element={<DrmOversightPage />} />
          <Route path="/corridors" element={<CorridorsPage />} />
          <Route path="/corridors/:id" element={<CorridorDetailPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/resources" element={<ResourcesPage />} />
          <Route path="/status" element={<StatusPage />} />
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
