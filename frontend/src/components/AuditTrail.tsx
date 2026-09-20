/**
 * PRD Section 8 screen 5 - the Approval & Audit Trail view.
 *
 * FR6.2 calls auditability a talking point, which only holds if the trail is
 * legible rather than merely complete. So the three record kinds are shown as
 * one narrative in time order, each with the thing a reader actually wants:
 * what generated the plan, what a Controller changed and why, and what a
 * sign-off accepted as still open.
 */
import { Check, ScrollText } from 'lucide-react'
import type { ReactNode } from 'react'

import {
  publicationDriftWarning,
  summariseEntry,
  type AuditEntry,
  type AuditTrail as AuditTrailData,
} from '../lib/approval.ts'

const KIND_STYLE: Record<AuditEntry['kind'], { dot: string; label: string }> = {
  generated: { dot: 'bg-slate-400', label: 'Generated' },
  override: { dot: 'bg-sky-500', label: 'Override' },
  approval: { dot: 'bg-emerald-500', label: 'Workflow' },
}

/** DESIGN_SYSTEM.md's glyph migration: ✓ → `Check`, everywhere it appears. */
function CheckedLine({ children }: { children: ReactNode }) {
  return (
    <p className="mt-0.5 flex items-center gap-1 text-2xs text-emerald-700">
      <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
      {children}
    </p>
  )
}

function EntryDetail({ entry }: { entry: AuditEntry }) {
  if (entry.kind === 'generated') {
    const detail = entry.detail as Record<string, unknown>
    return (
      <p className="mt-0.5 text-2xs text-slate-500">
        {String(detail.tasksScheduled ?? '?')} scheduled, {String(detail.tasksDeferred ?? '?')}{' '}
        deferred · solver returned {String(detail.solverStatus ?? '?')} in{' '}
        {String(detail.solveSeconds ?? '?')}s
      </p>
    )
  }

  if (entry.kind === 'override') {
    const override = entry.detail
    return (
      <>
        <p className="mt-1 text-xs text-slate-700 italic">“{override.reason}”</p>
        {override.originalAiAssignment && (
          <p className="mt-0.5 text-2xs text-slate-500">
            Solver originally placed it on {override.originalAiAssignment.date}{' '}
            {override.originalAiAssignment.start}
          </p>
        )}
        <CheckedLine>
          Re-validated — {override.revalidation.checks.length} constraint
          {override.revalidation.checks.length === 1 ? '' : 's'} checked
        </CheckedLine>
      </>
    )
  }

  const approval = entry.detail
  return (
    <>
      {approval.reason && (
        <p className="mt-1 text-xs text-slate-700 italic">“{approval.reason}”</p>
      )}
      {approval.validation && (
        <CheckedLine>
          Whole-plan re-validation passed — {approval.validation.checks.length} check
          {approval.validation.checks.length === 1 ? '' : 's'}
        </CheckedLine>
      )}
      {/* What a signature accepted as still-open is the substance of the
          sign-off, so it is shown beside it rather than buried. */}
      {approval.validation && approval.validation.knownUnresolved.length > 0 && (
        <p className="mt-0.5 text-2xs text-amber-700">
          Signed off with{' '}
          {approval.validation.knownUnresolved
            .map((gap) => `${gap.count} ${gap.type.toLowerCase().replace(/_/g, ' ')}`)
            .join(', ')}{' '}
          still unresolved — the solver does not yet enforce these.
        </p>
      )}
      {approval.publishedPlanDigest && (
        <p className="mt-0.5 font-mono text-3xs text-slate-500">
          plan fingerprint {approval.publishedPlanDigest}
        </p>
      )}
    </>
  )
}

export function AuditTrail({ trail }: { trail: AuditTrailData }) {
  const drift = publicationDriftWarning(trail)

  return (
    <section data-tour="audit-trail" className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-start gap-2.5 border-b border-slate-100 px-5 py-3">
        <span
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600"
          aria-hidden="true"
        >
          <ScrollText className="h-3.5 w-3.5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Audit trail{' '}
            <span className="font-normal text-slate-500">({trail.entries.length} events)</span>
          </h2>
          <p className="text-xs text-slate-500">
            Everything that has happened to <span className="font-mono">{trail.scheduleId}</span>,
            in order. Records are appended, never edited (FR6.2).
          </p>
        </div>
      </header>

      {drift && (
        <p className="mx-5 mt-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{drift}</p>
      )}

      {trail.digestMatchesPublished === true && (
        <p className="mx-5 mt-4 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          This plan still matches the version that was published — verified by re-deriving its
          fingerprint from the immutable solver output plus the override log.
        </p>
      )}

      <ol className="divide-y divide-slate-100">
        {trail.entries.map((entry, index) => {
          const style = KIND_STYLE[entry.kind]
          return (
            <li key={`${entry.kind}-${index}`} className="flex gap-3 px-5 py-3">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${style.dot}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-slate-800">
                    {summariseEntry(entry)}
                  </span>
                  <span className="text-2xs text-slate-500">
                    {style.label} · {new Date(entry.at).toLocaleString()}
                  </span>
                </div>
                <EntryDetail entry={entry} />
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export default AuditTrail
