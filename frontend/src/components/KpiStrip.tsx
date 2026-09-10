/**
 * KPI strip for the Controller Dashboard (PRD Section 8 / Section 14).
 *
 * Optimizer-only figures. Nothing here compares against the baseline - that is
 * T14's screen, and D-031 records exactly how easy it is to draw a misleading
 * comparison, so a half-version here would be worse than none.
 */
import type { ScheduleMetrics } from '../api/apiSlice.ts'

interface KpiStripProps {
  metrics: ScheduleMetrics
  solveSeconds: number
  status: string
}

export function KpiStrip({ metrics, solveSeconds, status }: KpiStripProps) {
  // The four figures a Controller decides from. Full-size cards.
  const primaryCards = [
    { label: 'Tasks scheduled', value: metrics.tasksScheduled, note: 'placed into a block' },
    {
      label: 'Deferred',
      value: metrics.tasksDeferred,
      note: 'each with a stated reason',
      tone: metrics.tasksDeferred > 0 ? 'warn' : 'plain',
    },
    {
      label: 'Block utilisation',
      value: `${metrics.blockUtilisationPct}%`,
      note: `${metrics.blockMinutesUsed} of ${metrics.blockMinutesCapacity} min`,
    },
    {
      label: 'Shared blocks',
      value: metrics.crossDepartmentBatches,
      note: 'serving 2+ departments',
      tone: 'highlight',
    },
  ] as const

  // Implementation detail rather than decision signal — a quieter line
  // underneath the primary cards, not cards of their own.
  const secondaryStats = [
    { label: 'Blocks used', value: metrics.blocksUsed },
    { label: 'Solve time', value: `${solveSeconds.toFixed(2)}s (${status.toLowerCase()})` },
  ] as const

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {primaryCards.map((card) => (
          <div
            key={card.label}
            className={`rounded-xl border bg-white px-4 py-3 shadow-sm ${
              'tone' in card && card.tone === 'highlight'
                ? 'border-violet-300 ring-1 ring-violet-200'
                : 'border-slate-200'
            }`}
          >
            <p className="text-[11px] tracking-wide text-slate-500 uppercase">{card.label}</p>
            <p
              className={`mt-0.5 text-2xl font-semibold tabular-nums ${
                'tone' in card && card.tone === 'highlight'
                  ? 'text-violet-700'
                  : 'tone' in card && card.tone === 'warn'
                    ? 'text-amber-700'
                    : 'text-slate-900'
              }`}
            >
              {card.value}
            </p>
            <p className="text-[11px] text-slate-400">{card.note}</p>
          </div>
        ))}
      </div>

      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11px] text-slate-400">
        {secondaryStats.map((stat) => (
          <span key={stat.label}>
            <span className="text-slate-500">{stat.label}:</span> {stat.value}
          </span>
        ))}
      </p>
    </div>
  )
}

export default KpiStrip
