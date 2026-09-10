/**
 * `/status` - service health plus the data provenance record.
 *
 * The provenance section is the delivery half of docs/DECISIONS.md D-015: the
 * disclaimer and the field-level real/simulated map were written alongside the
 * data by the generator, stored in MongoDB at seed time, and are rendered here
 * from the API. Nothing on this page is written by the UI.
 */
import { useState } from 'react'

import { useGetProvenanceQuery } from '../api/apiSlice.ts'
import { useAppSelector } from '../store/hooks.ts'
import { useAutoTour } from '../lib/useAutoTour.ts'
import { STATUS_TOUR_ID, STATUS_TOUR_STEPS } from '../tours/referenceTours.ts'
import ServiceStatusPanel from '../components/ServiceStatusPanel.tsx'
import { PageHeader } from '../components/Table.tsx'
import QueryState from '../components/QueryState.tsx'
import SyntheticBadge from '../components/SyntheticBadge.tsx'

type StatusTab = 'service' | 'provenance'

const STATUS_TABS: { id: StatusTab; label: string }[] = [
  { id: 'service', label: 'Service status' },
  { id: 'provenance', label: 'Data provenance' },
]

/** Which tab a given tour step's target lives in, so the guided tour can
 *  switch tabs to match as it advances — same mechanism as the Controller
 *  Dashboard's sidebar tabs (see ControllerDashboard.tsx's own comment). */
const TAB_FOR_TOUR_STEP: Partial<Record<string, StatusTab>> = {
  'service-panel': 'service',
  provenance: 'provenance',
}

function ProvenanceList({ title, entries }: { title: string; entries?: Record<string, string> }) {
  if (!entries || Object.keys(entries).length === 0) return null
  return (
    <div className="mt-2">
      <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {Object.entries(entries).map(([field, source]) => (
          <li key={field} className="text-xs text-slate-600">
            <code className="rounded bg-slate-100 px-1 py-0.5 text-[11px] text-slate-700">
              {field}
            </code>{' '}
            — {source}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function StatusPage() {
  const provenance = useGetProvenanceQuery()
  const entries = provenance.data?.data ?? []
  const [tab, setTab] = useState<StatusTab>('service')
  useAutoTour(STATUS_TOUR_ID, STATUS_TOUR_STEPS, !provenance.isLoading)

  // Keep the guided tour working across tabs, same pattern and same reason
  // as ControllerDashboard.tsx's sidebar tabs: computed during render (not a
  // useEffect) so the DOM is already correct before TourOverlay's own layout
  // effect measures the target on this same step change.
  const currentTourStep = useAppSelector((state) => state.tour.steps[state.tour.stepIndex] ?? null)
  const desiredTab = currentTourStep ? TAB_FOR_TOUR_STEP[currentTourStep.id] : undefined
  if (desiredTab && desiredTab !== tab) {
    setTab(desiredTab)
  }

  return (
    <>
      <PageHeader
        title="System status & data provenance"
        subtitle="Live service wiring, and where every collection's data actually came from."
      />

      <div
        role="tablist"
        aria-label="Status sections"
        className="mb-6 flex w-fit items-center gap-1 rounded-lg bg-slate-100 p-1"
      >
        {STATUS_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              tab === item.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Both panels stay mounted (CSS-hidden, not conditionally rendered) so
          the tour's data-tour selectors are always findable regardless of
          the active tab - see TAB_FOR_TOUR_STEP above. */}
      <div
        data-tour="status-service-panel"
        className={tab === 'service' ? 'max-w-2xl' : 'hidden'}
        aria-hidden={tab !== 'service'}
      >
        <ServiceStatusPanel />
      </div>

      <div className={tab === 'provenance' ? '' : 'hidden'} aria-hidden={tab !== 'provenance'}>
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Data provenance</h3>
        <p className="mb-3 max-w-3xl text-xs text-slate-500">
          Served from the database, not written by this page. The real/simulated boundary runs
          through individual records — an asset's train count is measured while its degradation
          history is simulated — so the split is recorded field by field.
        </p>

        <QueryState
          isLoading={provenance.isLoading}
          error={provenance.error}
          isEmpty={entries.length === 0}
          emptyMessage="No provenance recorded. Run npm run seed in /backend."
        >
          <div data-tour="status-provenance" className="grid gap-4 lg:grid-cols-2">
            {entries.map((entry) => (
              <section
                key={entry._id}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <h4 className="font-mono text-sm font-semibold text-slate-900">{entry._id}</h4>
                  <SyntheticBadge synthetic={entry.synthetic} />
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {entry.sourceFile} · {entry.recordCount.toLocaleString()} records
                  {entry.seed !== null && ` · seed ${entry.seed}`}
                  {entry.referenceDate && ` · reference date ${entry.referenceDate}`}
                </p>

                {entry.disclaimer && (
                  <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                    {entry.disclaimer}
                  </p>
                )}

                <ProvenanceList title="Real" entries={entry.fieldProvenance?.real} />
                <ProvenanceList title="Simulated" entries={entry.fieldProvenance?.synthetic} />
                <ProvenanceList
                  title="Computed later"
                  entries={entry.fieldProvenance?.computedDownstream}
                />
              </section>
            ))}
          </div>
        </QueryState>
      </div>
    </>
  )
}

export default StatusPage
