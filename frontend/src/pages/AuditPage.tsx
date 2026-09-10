/**
 * PRD Section 8 screen 5 - Approval & Audit Trail.
 *
 * One plan at a time, defaulting to the latest. The version list doubles as
 * FR6.3's "prior versions remain viewable": every generation is its own
 * document (D-034), so the history of plans IS the version history.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'

import {
  useGetAuditTrailQuery,
  useGetLatestScheduleQuery,
  useGetSchedulesQuery,
} from '../api/apiSlice.ts'
import { describeState, type AuditEntry } from '../lib/approval.ts'
import { useAutoTour } from '../lib/useAutoTour.ts'
import { AUDIT_TOUR_ID, AUDIT_TOUR_STEPS } from '../tours/auditTour.ts'
import AuditTrail from '../components/AuditTrail.tsx'
import OverrideHistory from '../components/OverrideHistory.tsx'
import WorkflowPanel from '../components/WorkflowPanel.tsx'
import QueryState from '../components/QueryState.tsx'
import { useAppSelector } from '../store/hooks.ts'

export function AuditPage() {
  // DRM has read-only access to this screen (auth session decision, recorded
  // in docs/DECISIONS.md) - the backend already refuses a DRM's
  // POST /workflow with a 403, but hiding the panel here means a DRM never
  // sees controls that would just be refused.
  const role = useAppSelector((state) => state.auth.user?.role)
  const canAct = role === 'controller' || role === 'super_admin'

  const latest = useGetLatestScheduleQuery()
  const versions = useGetSchedulesQuery({ limit: 20 })
  const [picked, setPicked] = useState<string | null>(null)

  const scheduleId = picked ?? latest.data?.data._id ?? null
  const trail = useGetAuditTrailQuery(scheduleId ?? '', { skip: !scheduleId })
  useAutoTour(AUDIT_TOUR_ID, AUDIT_TOUR_STEPS, !versions.isLoading && !latest.isLoading && !trail.isLoading)

  const header = (
    <header>
      <h1 className="text-lg font-semibold text-slate-900">Approval &amp; audit trail</h1>
      <p className="mt-1 text-sm text-slate-500">
        Every plan the system has produced, what was changed on it, and who signed it off. PRD
        FR6.1–FR6.3.
      </p>
    </header>
  )

  // D-077: a fresh database has no schedule yet, and `useGetLatestScheduleQuery`
  // surfaces that as a 404 - a real RTK Query "error", but not a genuine
  // failure. `QueryState`'s generic `error` branch doesn't know the
  // difference and was rendering the raw backend error text plus a
  // developer-facing debugging hint ("has npm run seed been run?") to
  // whoever opened this page first. Distinguishing "no plan yet" from an
  // actual failure here, the same way ComparisonPage already does, is what
  // lets a real failure (backend down, network error) still show as an
  // error while this ordinary first-boot case shows the friendly empty
  // state that was already written below but never reachable.
  const noScheduleYet =
    !versions.isLoading &&
    !latest.isLoading &&
    (versions.data?.data.length ?? 0) === 0 &&
    latest.error &&
    (latest.error as { status?: number }).status === 404

  if (noScheduleYet) {
    return (
      <div className="space-y-6">
        {header}
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
          <h2 className="text-sm font-semibold text-slate-900">No plan has been generated yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            The audit trail records what happens to a generated plan. Generate one on the
            dashboard and its history will start here.
          </p>
          <Link
            to="/dashboard"
            className="mt-4 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Go to the dashboard
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {header}

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
                    {canAct ? (
                      <WorkflowPanel
                        scheduleId={scheduleId}
                        state={trail.data.data.state}
                        allowedActions={trail.data.data.allowedActions}
                        version={trail.data.data.version}
                      />
                    ) : (
                      <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                        Read-only — DRM oversight view. Only a Controller can review, approve,
                        reject or publish a plan.
                      </p>
                    )}
                  </div>
                  <AuditTrail trail={trail.data.data} />
                  {/* Moved here from the Dashboard's Actions tab (decluttering
                      pass, round 1) — this is the audit-history read of the
                      same overrides AuditTrail already narrates above. */}
                  <OverrideHistory
                    overrides={trail.data.data.entries
                      .filter(
                        (entry): entry is Extract<AuditEntry, { kind: 'override' }> =>
                          entry.kind === 'override',
                      )
                      .map((entry) => entry.detail)}
                  />
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
