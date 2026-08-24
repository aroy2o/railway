/**
 * Ranked task queue with a visible breakdown - FR2.4.
 *
 * DATA SOURCE: the task documents, not the schedule's decisionLog.
 *
 * The decision log carries a task's priority *value*, but not the per-factor
 * breakdown or which factor dominated - and FR2.4 asks specifically for "a
 * visible breakdown of why (which factor dominated)". T10 persists
 * `priorityScore`, `dominantPriorityFactor` and `priorityBreakdown` onto the
 * tasks themselves (D-035), which is the only source that can answer that.
 *
 * It also covers the whole backlog rather than only the tasks that made it into
 * a plan, which is what a priority queue is for. See docs/DECISIONS.md D-038.
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { Schedule, Task } from '../api/apiSlice.ts'
import { DepartmentPill } from './Table.tsx'

const FACTOR_LABEL: Record<string, string> = {
  severity: 'severity',
  asset_criticality: 'asset criticality',
  failure_risk: 'predicted risk',
  sla_urgency: 'SLA urgency',
  sla_breach: 'overdue',
}

/**
 * PRD 9.1 / NG4, shown wherever the FR2.2 score is.
 *
 * Not optional decoration: the score is a model output over SIMULATED
 * degradation data, and PRD Section 6 lists presenting it as a real failure
 * forecast as an explicit non-goal. A test asserts this string renders whenever
 * a risk figure does.
 */
const RISK_FRAMING =
  'Predicted risk is a prototype model trained on simulated asset degradation patterns, ' +
  'designed to be retrained on real railway asset-health data when available. It does not ' +
  'predict real Indian Railways asset failures.'


interface PriorityQueueProps {
  tasks: Task[]
  schedule?: Schedule
  limit?: number
  /** T20: renders a "What if?" trigger per row when the caller wants one. */
  onWhatIf?: (taskId: string) => void
}

export function PriorityQueue({ tasks, schedule, limit = 12, onWhatIf }: PriorityQueueProps) {
  const scheduledIds = useMemo(
    () => new Set(schedule?.blocks.flatMap((block) => block.taskIds) ?? []),
    [schedule],
  )

  // Sorted here rather than by the API: /api/tasks orders by severity and
  // SLA date, which predates real priority scores existing. Its own comment
  // flags that the ordering should move server-side now that they do - noted
  // as a follow-up rather than reaching into the backend from this task.
  const ranked = useMemo(
    () =>
      [...tasks]
        .filter((task) => task.priorityScore !== null)
        .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
        .slice(0, limit),
    [tasks, limit],
  )

  const unscored = tasks.filter((task) => task.priorityScore === null).length
  // The framing appears only when a risk figure does - a disclaimer on a screen
  // showing no risk scores is noise that trains people to skip disclaimers.
  const showsRisk = ranked.some(
    (task) => task.failureRiskScore !== null && task.failureRiskScore !== undefined,
  )

  return (
    <section
      data-tour="dashboard-priority-queue"
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <header className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Priority queue</h2>
        <p className="text-xs text-slate-500">
          Ranked by severity, asset criticality, predicted risk and SLA pressure. Top{' '}
          {ranked.length} of{' '}
          {tasks.length}.
        </p>
      </header>

      {ranked.length === 0 ? (
        <p className="px-4 py-8 text-sm text-slate-500">
          No priority scores yet. Generate a schedule to rank the backlog.
        </p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {ranked.map((task, index) => {
            const isScheduled = scheduledIds.has(task._id)
            return (
              <li key={task._id} className="px-4 py-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex items-baseline gap-2">
                    <span className="w-4 text-right text-[11px] tabular-nums text-slate-400">
                      {index + 1}
                    </span>
                    <Link
                      to={`/corridors/${encodeURIComponent(task.corridorId)}`}
                      className="font-mono text-xs text-sky-700 hover:underline"
                    >
                      {task._id}
                    </Link>
                    <DepartmentPill department={task.department} />
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-slate-900">
                    {task.priorityScore?.toFixed(1)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 pl-6">
                  <span className="truncate text-[11px] text-slate-500">
                    {task.defectType} · driven by{' '}
                    <span className="font-medium text-slate-700">
                      {FACTOR_LABEL[task.dominantPriorityFactor ?? ''] ??
                        task.dominantPriorityFactor}
                    </span>
                    {task.failureRiskScore !== null &&
                      task.failureRiskScore !== undefined && (
                        <span
                          className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-800 ring-1 ring-violet-200 ring-inset"
                          title={RISK_FRAMING}
                        >
                          risk {Math.round(task.failureRiskScore)}
                        </span>
                      )}
                    {task.priorityBreakdown?.isOverdue && (
                      <span className="ml-1 font-medium text-rose-600">· overdue</span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {schedule && (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          isScheduled
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {isScheduled ? 'scheduled' : 'deferred'}
                      </span>
                    )}
                    {onWhatIf && schedule && (
                      <button
                        type="button"
                        data-tour={index === 0 ? 'dashboard-whatif-trigger' : undefined}
                        onClick={() => onWhatIf(task._id)}
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-violet-700 ring-1 ring-violet-200 ring-inset hover:bg-violet-50"
                      >
                        What if?
                      </button>
                    )}
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      {unscored > 0 && (
        <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
          {unscored} task{unscored > 1 ? 's' : ''} not yet scored — generate a schedule to rank
          them.
        </p>
      )}

      {showsRisk && (
        <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500">
          <span className="font-medium text-slate-600">Predicted risk:</span> {RISK_FRAMING}
        </p>
      )}
    </section>
  )
}

export default PriorityQueue
