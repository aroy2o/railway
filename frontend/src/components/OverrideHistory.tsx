/**
 * What has been manually changed on this plan, and why - FR6.2's audit trail.
 *
 * Every entry keeps the solver's original placement alongside the amendment, so
 * "what did the AI actually say" is answerable after any number of overrides.
 */
import { Check, PenLine } from 'lucide-react'

import type { ScheduleOverride } from '../api/apiSlice.ts'

export function OverrideHistory({ overrides }: { overrides: ScheduleOverride[] }) {
  if (overrides.length === 0) {
    return (
      <section className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <span
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600"
          aria-hidden="true"
        >
          <PenLine className="h-3.5 w-3.5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Manual overrides</h2>
          <p className="mt-1 text-xs text-slate-500">
            None yet — this plan is exactly as the solver produced it. Click a block on the
            timeline to move a task.
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-start gap-2.5 border-b border-slate-100 px-5 py-3">
        <span
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600"
          aria-hidden="true"
        >
          <PenLine className="h-3.5 w-3.5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Manual overrides{' '}
            <span className="font-normal text-slate-500">({overrides.length})</span>
          </h2>
          <p className="text-xs text-slate-500">
            Every amendment, with the solver's original placement kept for audit.
          </p>
        </div>
      </header>
      <ol className="divide-y divide-slate-100">
        {overrides.map((override) => (
          <li key={override._id} className="px-5 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-slate-800">{override.taskId}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-3xs font-semibold tracking-wide uppercase ${
                    override.action === 'defer'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-sky-100 text-sky-800'
                  }`}
                >
                  {override.action}
                </span>
              </span>
              <span className="text-2xs text-slate-500">
                {override.actorRole} · {new Date(override.createdAt).toLocaleString()}
              </span>
            </div>

            <p className="mt-1 text-xs text-slate-600">
              {override.action === 'defer' ? (
                <>
                  Removed from{' '}
                  <span className="font-mono">
                    {override.fromAssignment?.date} {override.fromAssignment?.start}
                  </span>
                </>
              ) : (
                <>
                  <span className="font-mono">
                    {override.fromAssignment?.date} {override.fromAssignment?.start}
                  </span>{' '}
                  →{' '}
                  <span className="font-mono text-slate-900">
                    {override.newAssignment?.date} {override.newAssignment?.start}–
                    {override.newAssignment?.end}
                  </span>
                </>
              )}
              {override.originalAiAssignment &&
                override.originalAiAssignment.date !== override.fromAssignment?.date && (
                  <span className="text-slate-500">
                    {' '}
                    (solver originally: {override.originalAiAssignment.date}{' '}
                    {override.originalAiAssignment.start})
                  </span>
                )}
            </p>

            <p className="mt-1 text-xs text-slate-700 italic">“{override.reason}”</p>

            <p className="mt-1 flex items-center gap-1 text-2xs text-emerald-700">
              <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
              Re-validated — {override.revalidation.checks.length} constraint
              {override.revalidation.checks.length === 1 ? '' : 's'} checked
            </p>
          </li>
        ))}
      </ol>
    </section>
  )
}

export default OverrideHistory
