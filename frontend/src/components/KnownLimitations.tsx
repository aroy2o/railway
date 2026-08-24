/**
 * Constraints this plan does NOT enforce, typed per PRD 9.5, plus any partial
 * failure of the generation.
 *
 * As of T25, PRD 9.5 names nothing the optimized plan leaves genuinely
 * unenforced any more - dependency precedence (T24) and resource no-overlap
 * (T25) are both hard CP-SAT constraints. This screen's typed-conflicts list
 * is normally empty; what it renders instead is the "Checked, and none
 * found" section - an earned zero for every type this build can check, not a
 * silent absence.
 *
 * T21 turns any live conflict that DID occur into a named type with a named
 * resolution each. Three things that must stay true on this screen:
 *
 *   1. A resolution strategy is a LABEL, not an action taken. The heading says
 *      "would resolve it", and nothing here changes the plan.
 *   2. Types nothing checks for are listed separately as not checked, never as
 *      a count of zero. Zero would claim a check that does not exist.
 *   3. A modern schedule with zero live conflicts (the ordinary case, now)
 *      must never be confused with a genuinely pre-T21 schedule that never
 *      carried a typed report at all - see `hasTypedReport` below. T25 found
 *      this component conflating the two, and fixed it.
 *
 * Deliberately understated rather than alarming: these are known, scoped gaps,
 * not defects. But they are visible.
 */
import type { KnownGaps, Schedule } from '../api/apiSlice.ts'
import { groupConflicts, type ConflictReport } from '../lib/conflicts.ts'

interface KnownLimitationsProps {
  knownGaps: KnownGaps
  /** Absent on schedules generated before T21; the counts still render. */
  conflictReport?: ConflictReport | null
  generationErrors: Schedule['generationErrors']
}

export function KnownLimitations({
  knownGaps,
  conflictReport,
  generationErrors,
}: KnownLimitationsProps) {
  const groups = groupConflicts(conflictReport, 'optimized', { limit: 3 })
  const notYetDetectable = conflictReport?.notYetDetectable ?? []
  const checkedAndClear = conflictReport?.checkedAndClear ?? []
  // Pre-T21 schedules carry no `conflictReport` at all - genuinely nothing to
  // group. That is different from a MODERN schedule with `groups.length ===
  // 0`, which (since T24/T25 made both PRD 9.5 types on the optimized plan
  // hard constraints) is now the ordinary case, not a legacy one - `groups`
  // being empty must never fall back to the stale "not enforced" labels
  // below, which would misreport a constraint that IS enforced.
  const hasTypedReport = conflictReport != null

  // Pre-T21 fallback: counts only, which is what used to be shown here.
  const countsOnly = [
    { label: 'Resource conflicts not enforced', ...knownGaps.resourceConflicts },
    { label: 'Dependency ordering not enforced', ...knownGaps.dependencyViolations },
  ]

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 px-5 py-4">
      <h2 className="text-sm font-semibold text-slate-900">Known limitations of this plan</h2>
      <p className="mb-3 text-xs text-slate-500">
        Reported by the solver itself, so the plan is never presented as more constrained than it
        actually is. Each type carries the strategy that <em>would</em> resolve it — labelled, not
        applied.
      </p>

      {hasTypedReport ? (
        groups.length > 0 ? (
        <ul className="space-y-2">
          {groups.map((group) => (
            <li
              key={group.type}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2.5"
            >
              <div className="flex items-baseline gap-2">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-slate-700">
                  {group.count}
                </span>
                <span className="text-xs font-medium text-slate-800">{group.label}</span>
                {group.enforcedBy.length > 0 && (
                  <span className="ml-auto text-[10px] text-slate-400">
                    would be enforced by {group.enforcedBy.join(', ')}
                  </span>
                )}
              </div>

              <p className="mt-1 text-[11px] text-slate-600">
                <span className="font-medium text-slate-700">Resolution: </span>
                {group.strategies.join(' / ')}
              </p>

              <ul className="mt-1.5 space-y-1 border-t border-slate-100 pt-1.5">
                {group.conflicts.map((conflict, index) => (
                  <li
                    key={`${conflict.type}-${conflict.taskIds.join('-')}-${index}`}
                    className="text-[11px] text-slate-500"
                  >
                    <span className="font-mono text-slate-400">
                      {conflict.corridorId ?? '—'} · {conflict.date ?? '—'}
                    </span>{' '}
                    {conflict.detail}
                  </li>
                ))}
                {group.count > group.conflicts.length && (
                  <li className="text-[11px] text-slate-400">
                    + {group.count - group.conflicts.length} more of this type
                  </li>
                )}
              </ul>
            </li>
          ))}
        </ul>
        ) : (
          <p className="text-xs text-slate-500">
            No live conflicts of any PRD 9.5 type on the optimized plan — see "Checked, and none
            found" below for what that claim is based on.
          </p>
        )
      ) : (
        <ul className="space-y-2">
          {countsOnly.map((item) => (
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
      )}

      {notYetDetectable.length > 0 && (
        <div className="mt-3 border-t border-slate-200 pt-2.5">
          <p className="text-[11px] font-medium text-slate-700">Not checked for at all</p>
          <ul className="mt-1 space-y-1">
            {notYetDetectable.map((entry) => (
              <li key={entry.type} className="text-[11px] text-slate-500">
                <span className="font-medium text-slate-600">
                  {entry.type.replace(/_/g, ' ').toLowerCase()}
                </span>{' '}
                — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {checkedAndClear.length > 0 && (
        <div className="mt-3 border-t border-slate-200 pt-2.5">
          <p className="text-[11px] font-medium text-emerald-700">Checked, and none found</p>
          <ul className="mt-1 space-y-1">
            {checkedAndClear.map((entry) => (
              <li key={entry.type} className="text-[11px] text-slate-500">
                <span className="font-medium text-slate-600">
                  {entry.type.replace(/_/g, ' ').toLowerCase()}
                </span>{' '}
                — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

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
