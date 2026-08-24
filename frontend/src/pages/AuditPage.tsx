/**
 * PRD Section 8 screen 5 - Approval & Audit Trail.
 *
 * One plan at a time, defaulting to the latest. The version list doubles as
 * FR6.3's "prior versions remain viewable": every generation is its own
 * document (D-034), so the history of plans IS the version history.
 */
import { useState } from 'react'

import {
  useGetAuditTrailQuery,
  useGetLatestScheduleQuery,
  useGetSchedulesQuery,
} from '../api/apiSlice.ts'
import { describeState } from '../lib/approval.ts'
import { useAutoTour } from '../lib/useAutoTour.ts'
import { AUDIT_TOUR_ID, AUDIT_TOUR_STEPS } from '../tours/auditTour.ts'
import AuditTrail from '../components/AuditTrail.tsx'
import WorkflowPanel from '../components/WorkflowPanel.tsx'
import QueryState from '../components/QueryState.tsx'

export function AuditPage() {
  const latest = useGetLatestScheduleQuery()
  const versions = useGetSchedulesQuery({ limit: 20 })
  const [picked, setPicked] = useState<string | null>(null)

  const scheduleId = picked ?? latest.data?.data._id ?? null
  const trail = useGetAuditTrailQuery(scheduleId ?? '', { skip: !scheduleId })
  useAutoTour(AUDIT_TOUR_ID, AUDIT_TOUR_STEPS, !versions.isLoading && !latest.isLoading && !trail.isLoading)

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">Approval &amp; audit trail</h1>
        <p className="mt-1 text-sm text-slate-500">
          Every plan the system has produced, what was changed on it, and who signed it off. PRD
          FR6.1–FR6.3.
        </p>
      </header>

      <QueryState
        isLoading={versions.isLoading || latest.isLoading}
        error={latest.error && !latest.data ? latest.error : null}
        isEmpty={(versions.data?.data.length ?? 0) === 0}
        emptyMessage="No plan has been generated yet."
      >
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <nav data-tour="audit-versions" className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <header className="border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-900">Plan versions</h2>
              <p className="text-[11px] text-slate-500">
                Each generation is its own document — nothing is overwritten (FR6.3).
              </p>
            </header>
            <ol className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">
              {versions.data?.data.map((version) => {
                const state = describeState(version.workflowState ?? 'draft')
                const active = version._id === scheduleId
                return (
                  <li key={version._id}>
                    <button
                      type="button"
                      onClick={() => setPicked(version._id)}
                      className={`w-full px-4 py-2.5 text-left transition ${
                        active ? 'bg-slate-100' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span className="block truncate font-mono text-[11px] text-slate-700">
                        {version._id}
                      </span>
                      <span className="mt-0.5 flex items-baseline justify-between gap-2">
                        <span className="text-[11px] text-slate-400">
                          {new Date(version.generatedAt).toLocaleDateString()}
                        </span>
                        <span className="text-[11px] font-medium text-slate-600">
                          {state.label}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </nav>

          <div className="space-y-6">
            <QueryState isLoading={trail.isLoading} error={trail.error}>
              {trail.data && scheduleId && (
                <>
                  <div data-tour="audit-workflow">
                    <WorkflowPanel
                      scheduleId={scheduleId}
                      state={trail.data.data.state}
                      allowedActions={trail.data.data.allowedActions}
                      version={trail.data.data.version}
                    />
                  </div>
                  <AuditTrail trail={trail.data.data} />
                </>
              )}
            </QueryState>
          </div>
        </div>
      </QueryState>
    </div>
  )
}

export default AuditPage
