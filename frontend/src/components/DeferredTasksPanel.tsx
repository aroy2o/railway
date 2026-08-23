/**
 * Deferred work, with the solver's own reasons - FR3.3.
 *
 * PRD FR3.3 makes "deferred with reason" a first-class outcome, not an
 * afterthought, so this is a full panel rather than a footnote. On the real
 * corpus it is the larger half of the answer: 53 of 89 tasks cannot fit any
 * window their corridor offers, which is the scarcity the whole project is
 * about (D-024).
 *
 * Grouped by reason, and the solver's `detail` text is rendered verbatim. That
 * text already names the remedy - "requires a traffic block that displaces
 * trains" - and rewording it here would only weaken it.
 */
import { useMemo, useState } from 'react'
import type { DeferredTask } from '../api/apiSlice.ts'

const REASON_LABEL: Record<DeferredTask['reason'], string> = {
  EXCEEDS_LONGEST_WINDOW: 'No gap long enough on the corridor',
  NO_CAPACITY: 'Lost a capacity contest to higher-priority work',
  NO_WINDOW_ON_CORRIDOR: 'Corridor has no free window at all',
}

const REASON_HINT: Record<DeferredTask['reason'], string> = {
  EXCEEDS_LONGEST_WINDOW:
    'Traffic leaves no window long enough. This work needs a traffic block that displaces trains — train-impact-aware planning (PRD 9.6).',
  NO_CAPACITY: 'A window could have held it, but higher-priority work used the time.',
  NO_WINDOW_ON_CORRIDOR: 'No free window exists on this corridor in the horizon.',
}

export function DeferredTasksPanel({ deferred }: { deferred: DeferredTask[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  const groups = useMemo(() => {
    const byReason = new Map<DeferredTask['reason'], DeferredTask[]>()
    for (const task of deferred) {
      const bucket = byReason.get(task.reason) ?? []
      bucket.push(task)
      byReason.set(task.reason, bucket)
    }
    return [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [deferred])

  if (deferred.length === 0) {
    return (
      <section className="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4">
        <h2 className="text-sm font-semibold text-emerald-900">Nothing deferred</h2>
        <p className="text-xs text-emerald-700">Every pending task was placed into a block.</p>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-900">
          Deferred work{' '}
          <span className="font-normal text-slate-500">({deferred.length} tasks)</span>
        </h2>
        <p className="text-xs text-slate-500">
          Every task the solver could not place, with the reason it gave. Nothing is dropped
          silently.
        </p>
      </header>

      <div className="divide-y divide-slate-100">
        {groups.map(([reason, tasks]) => (
          <div key={reason} className="px-5 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-slate-800">{REASON_LABEL[reason]}</h3>
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-600/20 ring-inset">
                {tasks.length} task{tasks.length > 1 ? 's' : ''}
              </span>
            </div>
            <p className="mt-1 max-w-3xl text-xs text-slate-500">{REASON_HINT[reason]}</p>

            <button
              type="button"
              onClick={() => setExpanded(expanded === reason ? null : reason)}
              className="mt-2 text-xs font-medium text-sky-700 hover:underline"
            >
              {expanded === reason ? 'Hide' : 'Show'} the solver's reasoning
            </button>

            {expanded === reason && (
              <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto rounded-lg bg-slate-50 p-3">
                {tasks.map((task) => (
                  <li key={task.taskId} className="text-[11px] leading-relaxed text-slate-600">
                    <span className="font-mono text-slate-800">{task.taskId}</span> — {task.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

export default DeferredTasksPanel
