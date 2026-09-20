/**
 * KPI strip for the Controller Dashboard (PRD Section 8 / Section 14).
 *
 * Optimizer-only figures. Nothing here compares against the baseline - that is
 * T14's screen, and D-031 records exactly how easy it is to draw a misleading
 * comparison, so a half-version here would be worse than none.
 */
import {
  ClipboardCheck,
  Clock,
  Gauge,
  Layers,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'

import type { AssetAvailability, ScheduleMetrics } from '../api/apiSlice.ts'

interface KpiStripProps {
  metrics: ScheduleMetrics
  solveSeconds: number
  status: string
  /** fulldata-ktv-psa branch only - null on plans where it wasn't computed
   * (e.g. an emergency re-solve). Card omitted, not shown as zero, when null. */
  assetAvailability?: AssetAvailability | null
}

/** Chip tint follows the card's existing tone meaning (plain/warn/highlight) -
 * never a per-card colour picked for variety, per DESIGN_SYSTEM.md's icon rule. */
const CHIP_TONE: Record<'plain' | 'warn' | 'highlight', string> = {
  plain: 'bg-slate-100 text-slate-600',
  warn: 'bg-amber-100 text-amber-700',
  highlight: 'bg-violet-100 text-violet-700',
}

const VALUE_TONE: Record<'plain' | 'warn' | 'highlight', string> = {
  plain: 'text-slate-900',
  warn: 'text-amber-700',
  highlight: 'text-violet-700',
}

interface PrimaryCard {
  label: string
  value: string | number
  note: string
  tone: 'plain' | 'warn' | 'highlight'
  icon: LucideIcon
}

export function KpiStrip({ metrics, solveSeconds, status, assetAvailability }: KpiStripProps) {
  // The figures a Controller decides from. Full-size cards.
  const primaryCards: PrimaryCard[] = [
    {
      label: 'Tasks scheduled',
      value: metrics.tasksScheduled,
      note: 'placed into a block',
      tone: 'plain',
      icon: ClipboardCheck,
    },
    {
      label: 'Deferred',
      value: metrics.tasksDeferred,
      note: 'each with a stated reason',
      tone: metrics.tasksDeferred > 0 ? 'warn' : 'plain',
      icon: Clock,
    },
    {
      label: 'Block utilisation',
      value: `${metrics.blockUtilisationPct}%`,
      // Same D-031 wording as lib/oversight.ts's planningKpis() and
      // lib/trends.ts's utilisation series - reused verbatim, not
      // paraphrased, per DESIGN_SYSTEM.md's metric-caveat rule.
      note: `${metrics.blockMinutesUsed} of ${metrics.blockMinutesCapacity} min. Never read alone: a higher figure can mean over-subscription rather than efficiency (D-031).`,
      tone: 'plain',
      icon: Gauge,
    },
    {
      label: 'Shared blocks',
      value: metrics.crossDepartmentBatches,
      note: 'serving 2+ departments',
      tone: 'highlight',
      icon: Layers,
    },
    // SIH 26027's own headline goal, distinct from block utilisation above -
    // see AssetAvailability's doc comment in api/apiSlice.ts. Omitted, not
    // rendered as 0%, when the plan never computed it.
    ...(assetAvailability
      ? [
          {
            label: 'Asset availability',
            value: `${assetAvailability.overallPct}%`,
            note: `${assetAvailability.assetsTouched} assets touched this horizon`,
            tone: 'plain' as const,
            icon: ShieldCheck,
          },
        ]
      : []),
  ]

  // Implementation detail rather than decision signal — a quieter line
  // underneath the primary cards, not cards of their own.
  const secondaryStats = [
    { label: 'Blocks used', value: metrics.blocksUsed },
    { label: 'Solve time', value: `${solveSeconds.toFixed(2)}s (${status.toLowerCase()})` },
  ] as const

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {primaryCards.map((card) => (
          <div
            key={card.label}
            className={`rounded-xl border bg-white px-4 py-3 shadow-sm ${
              card.tone === 'highlight' ? 'border-violet-300 ring-1 ring-violet-200' : 'border-slate-200'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${CHIP_TONE[card.tone]}`}
                aria-hidden="true"
              >
                <card.icon className="h-3.5 w-3.5" />
              </span>
              <p className="text-2xs tracking-wide text-slate-500 uppercase">{card.label}</p>
            </div>
            <p className={`mt-1.5 text-2xl font-semibold tabular-nums ${VALUE_TONE[card.tone]}`}>
              {card.value}
            </p>
            <p className="mt-0.5 text-2xs text-slate-500">{card.note}</p>
          </div>
        ))}
      </div>

      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-1 text-2xs text-slate-500">
        {secondaryStats.map((stat) => (
          <span key={stat.label}>
            <span className="text-slate-600">{stat.label}:</span> {stat.value}
          </span>
        ))}
      </p>
    </div>
  )
}

export default KpiStrip
