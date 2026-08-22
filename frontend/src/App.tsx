/**
 * Application shell.
 *
 * Currently renders the build-phase landing screen: the PRD Section 5
 * prototype banner plus a live check that all three services are wired
 * together. Role-based routing and the Controller Dashboard (PRD Section 8)
 * replace this content in tasks T11 and T13.
 */
import AppHeader from './components/AppHeader.tsx'
import PrototypeBanner from './components/PrototypeBanner.tsx'
import ServiceStatusPanel from './components/ServiceStatusPanel.tsx'

/**
 * Build order from PRD Section 16, mirrored from TASKS.md so the landing screen
 * states plainly what is and is not implemented yet. No metrics appear here -
 * every number in this app must come from an actual solver run.
 */
const BUILD_PHASES = [
  {
    tier: 'Now',
    title: 'Data foundation',
    items: ['Corridor ingestion (T2)', 'Timetable calendar (T3)', 'Synthetic generator (T4)'],
  },
  {
    tier: 'Next',
    title: 'Optimization core',
    items: ['CP-SAT scheduler (T6)', 'Priority engine (T7)', 'Naive baseline (T8)'],
  },
  {
    tier: 'Then',
    title: 'Decision support',
    items: ['Controller dashboard (T13)', 'Baseline vs AI screen (T14)', 'Manual override (T15)'],
  },
]

function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <PrototypeBanner />
      <AppHeader />

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-slate-900">Project skeleton</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            The three services are scaffolded and talking to each other. Planning features are
            built in the priority order defined by the PRD, starting with real corridor and
            timetable data.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <ServiceStatusPanel />
          </div>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
            <h2 className="text-sm font-semibold text-slate-900">Build order</h2>
            <p className="mb-4 text-xs text-slate-500">PRD Section 16 &middot; tracked in TASKS.md</p>

            <ol className="space-y-4">
              {BUILD_PHASES.map((phase) => (
                <li key={phase.tier}>
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
                      {phase.tier}
                    </span>
                    <span className="text-sm font-medium text-slate-800">{phase.title}</span>
                  </div>
                  <ul className="mt-1.5 ml-1 space-y-1">
                    {phase.items.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-xs text-slate-600">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-slate-400 sm:px-6">
        Decision-support prototype — not a certified safety system (PRD non-goal NG3).
      </footer>
    </div>
  )
}

export default App
