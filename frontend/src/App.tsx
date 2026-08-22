/**
 * Application shell and routing.
 *
 * Read-only views over the real + synthetic pipeline output. The Controller
 * Dashboard, Gantt timeline and KPI strip (PRD Section 8, tasks T12/T13) are
 * deliberately not here yet - there is no schedule to visualise until the
 * CP-SAT solver (T6) exists.
 */
import { Navigate, Route, Routes } from 'react-router-dom'

import AppHeader from './components/AppHeader.tsx'
import PrototypeBanner from './components/PrototypeBanner.tsx'
import AssetsPage from './pages/AssetsPage.tsx'
import CorridorDetailPage from './pages/CorridorDetailPage.tsx'
import CorridorsPage from './pages/CorridorsPage.tsx'
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
          <Route path="/" element={<Navigate to="/corridors" replace />} />
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
    </div>
  )
}

export default App
