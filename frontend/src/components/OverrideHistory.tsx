/**
 * What has been manually changed on this plan, and why - FR6.2's audit trail.
 *
 * Every entry keeps the solver's original placement alongside the amendment, so
 * "what did the AI actually say" is answerable after any number of overrides.
 */
import type { ScheduleOverride } from '../api/apiSlice.ts'

export function OverrideHistory({ overrides }: { overrides: ScheduleOverride[] }) {
  if (overrides.length === 0) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Manual overrides</h2>
        <p className="mt-1 text-xs text-slate-500">
          None yet — this plan is exactly as the solver produced it. Click a block on the timeline
          to move a task.
        </p>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="border-b border-slate-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-900">
          Manual overrides <span className="font-normal text-slate-500">({overrides.length})</span>
        </h2>
        <p className="text-xs text-slate-500">
          Every amendment, with the solver's original placement kept for audit.
        </p>
      </header>
      <ol className="divide-y divide-slate-100">
        {overrides.map((override) => (
          <li key={override._id} className="px-5 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-slate-800">{override.taskId}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
                    override.action === 'defer'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-sky-100 text-sky-800'
                  }`}
                >
                  {override.action}
                </span>
              </span>
              <span className="text-[11px] text-slate-400">
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
                  <span className="text-slate-400">
                    {' '}
                    (solver originally: {override.originalAiAssignment.date}{' '}
                    {override.originalAiAssignment.start})
                  </span>
                )}
            </p>

            <p className="mt-1 text-xs text-slate-700 italic">“{override.reason}”</p>

            <p className="mt-1 text-[11px] text-emerald-700">
              ✓ Re-validated — {override.revalidation.checks.length} constraint
              {override.revalidation.checks.length === 1 ? '' : 's'} checked
            </p>
          </li>
        ))}
      </ol>
    </section>
  )
}

export default OverrideHistory
