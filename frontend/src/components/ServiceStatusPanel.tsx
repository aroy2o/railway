/**
 * Live wiring check for the three-service architecture (PRD Section 11).
 *
 * Calls one backend endpoint that probes MongoDB and the Python optimizer, so
 * a broken link in React -> Express -> {MongoDB, CP-SAT} is visible on screen
 * instead of surfacing later as an unexplained failure mid-demo.
 *
 * This panel is scaffolding for the build phase. The Controller Dashboard
 * (task T13) replaces it as the landing screen.
 */
import { describeApiError, useGetDependencyHealthQuery } from '../api/apiSlice.ts'
import type { DependencyHealth } from '../api/apiSlice.ts'
import { StatusPill } from './StatusPill.tsx'
import type { StatusTone } from './StatusPill.tsx'

interface ServiceRow {
  name: string
  detail: string
  tone: StatusTone
  label: string
}

/** Map the health payload onto one row per service in the chain. */
function toRows(
  data: DependencyHealth | undefined,
  isLoading: boolean,
  errorMessage: string | null,
): ServiceRow[] {
  if (isLoading) {
    return SERVICE_NAMES.map((service) => ({
      ...service,
      detail: 'Checking…',
      tone: 'pending' as StatusTone,
      label: 'Checking',
    }))
  }

  // The probe itself travels through Express, so a transport failure tells us
  // the API is unreachable and says nothing about the services behind it.
  if (errorMessage || !data) {
    return [
      {
        name: 'Express API',
        detail: errorMessage ?? 'No response',
        tone: 'down',
        label: 'Unreachable',
      },
      { name: 'MongoDB', detail: 'Unknown - probe runs through the API', tone: 'pending', label: 'Unknown' },
      { name: 'Optimizer (CP-SAT)', detail: 'Unknown - probe runs through the API', tone: 'pending', label: 'Unknown' },
    ]
  }

  const { database, optimizer } = data.checks

  return [
    { name: 'Express API', detail: 'Responding', tone: 'ok', label: 'Online' },
    {
      name: 'MongoDB',
      detail: database.connected ? 'Connected' : `Not connected (${database.state})`,
      tone: database.connected ? 'ok' : 'down',
      label: database.connected ? 'Online' : 'Offline',
    },
    {
      name: 'Optimizer (CP-SAT)',
      detail: optimizerDetail(optimizer),
      tone: optimizerTone(optimizer),
      label: optimizerLabel(optimizer),
    },
  ]
}

const SERVICE_NAMES = [
  { name: 'Express API' },
  { name: 'MongoDB' },
  { name: 'Optimizer (CP-SAT)' },
]

/** "Service up but solver broken" is a distinct failure from "service down". */
function optimizerTone(optimizer: DependencyHealth['checks']['optimizer']): StatusTone {
  if (!optimizer.reachable) return 'down'
  return optimizer.solverAvailable ? 'ok' : 'warn'
}

function optimizerLabel(optimizer: DependencyHealth['checks']['optimizer']): string {
  if (!optimizer.reachable) return 'Unreachable'
  return optimizer.solverAvailable ? 'Online' : 'Degraded'
}

function optimizerDetail(optimizer: DependencyHealth['checks']['optimizer']): string {
  if (!optimizer.reachable) return optimizer.error ?? `No response from ${optimizer.url}`
  if (!optimizer.solverAvailable) return 'Service up, but OR-Tools CP-SAT is not usable'
  return 'Solver ready'
}

export function ServiceStatusPanel() {
  const { data, error, isLoading, isFetching, refetch } = useGetDependencyHealthQuery()
  const errorMessage = error ? describeApiError(error) : null
  const rows = toRows(data, isLoading, errorMessage)

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Service status</h2>
          <p className="text-xs text-slate-500">React → Express → MongoDB + Python optimizer</p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isFetching ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      <ul className="divide-y divide-slate-100">
        {rows.map((row) => (
          <li key={row.name} className="flex items-center justify-between gap-4 px-5 py-3.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800">{row.name}</p>
              <p className="truncate text-xs text-slate-500">{row.detail}</p>
            </div>
            <StatusPill tone={row.tone} label={row.label} />
          </li>
        ))}
      </ul>

      {data && (
        <p className="border-t border-slate-100 px-5 py-2.5 text-[11px] text-slate-400">
          Last checked {new Date(data.timestamp).toLocaleTimeString()}
        </p>
      )}
    </section>
  )
}

export default ServiceStatusPanel
