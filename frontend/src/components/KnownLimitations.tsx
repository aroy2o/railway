/**
 * Constraints this plan does NOT enforce, and any partial failure.
 *
 * The solver reports the constraints it leaves unmodelled - resource
 * no-overlap (T25) and dependency precedence (T24) - and that report has
 * survived three hops to get here: dataclass, HTTP, MongoDB. Dropping it at the
 * last one would make the plan look cleaner on screen than it is, which is the
 * only direction that actually matters.
 *
 * Deliberately understated rather than alarming: these are known, scoped gaps,
 * not defects. But they are visible.
 */
import type { KnownGaps, Schedule } from '../api/apiSlice.ts'

interface KnownLimitationsProps {
  knownGaps: KnownGaps
  generationErrors: Schedule['generationErrors']
}

export function KnownLimitations({ knownGaps, generationErrors }: KnownLimitationsProps) {
  const items = [
    {
      label: 'Resource conflicts not enforced',
      count: knownGaps.resourceConflicts.count,
      note: knownGaps.resourceConflicts.note,
    },
    {
      label: 'Dependency ordering not enforced',
      count: knownGaps.dependencyViolations.count,
      note: knownGaps.dependencyViolations.note,
    },
  ]

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 px-5 py-4">
      <h2 className="text-sm font-semibold text-slate-900">Known limitations of this plan</h2>
      <p className="mb-3 text-xs text-slate-500">
        Reported by the solver itself, so the plan is never presented as more constrained than it
        actually is.
      </p>

      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.label} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 rounded bg-white px-1.5 py-0.5 font-semibold tabular-nums text-slate-700 ring-1 ring-slate-200 ring-inset">
              {item.count}
            </span>
            <span>
              <span className="font-medium text-slate-800">{item.label}</span>
              <span className="block text-slate-500">{item.note}</span>
            </span>
          </li>
        ))}
      </ul>

      {generationErrors.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-900">
            Part of this generation did not complete
          </p>
          <ul className="mt-1 space-y-0.5">
            {generationErrors.map((error) => (
              <li key={error.call} className="text-[11px] text-amber-800">
                <span className="font-mono">{error.call}</span> — {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

export default KnownLimitations
