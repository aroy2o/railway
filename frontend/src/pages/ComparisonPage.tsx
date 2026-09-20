/**
 * Baseline vs AI comparison - PRD FR9.3 / Section 12, task T14.
 *
 * Reads the comparison T10 already computed and stored; it never re-runs a
 * solve. Both plans came from the same input on the same run, which is what
 * makes them comparable at all.
 *
 * THE LAYOUT IS THE HONESTY MECHANISM
 * -----------------------------------
 * D-031 records how easily this screen misleads, and its rules shape the
 * structure here rather than sitting in small print:
 *
 *   1. The contestable denominator is stated *before* any number, in its own
 *      band, because 240 of 818 tasks are impossible for both engines and a
 *      comparison drawn from 818 would credit the optimizer for them.
 *   2. Conflicts and batching are the headline. Scheduled-task count is a
 *      supporting row explicitly marked "fewer, by design" - the optimizer
 *      places less of the backlog because it enforces real constraints, and
 *      leading with that number would be a false claim of throughput loss.
 *   3. Utilisation is rendered *inside the same card* as the over-subscription
 *      count that causes it. The baseline's utilisation is higher; shown alone
 *      it reads as the baseline winning.
 *
 * THREE TIERS, NOT ONE CARD SHAPE REPEATED EIGHT TIMES
 * -----------------------------------------------------
 * A redesign found that 8 KPI cards in one shape forces the reader to parse
 * each individually. The rows fall into three genuinely different kinds of
 * claim, so each gets a shape matched to it:
 *
 *   Tier 1 - BreakdownPanel: real, unambiguous structural wins (double
 *   booking, batching, split-only-when-present). No badge needed - nothing
 *   here is confounded.
 *
 *   Tier 2 - UtilisationSpotlight: the one number that would fool you if
 *   read alone. Gets a solo, full-width moment and a capacity bar chart that
 *   makes the over-subscription visible, not just stated.
 *
 *   Tier 3 - MechanismTable: five rows (scheduled, fragmentation, SLA
 *   compliance, priority coverage, risk reduction) that all share ONE root
 *   cause - the baseline's raw counts are inflated by ignoring real
 *   constraints. A shared paragraph states that once; each row's own note is
 *   trimmed to what is actually specific to it.
 *
 * The ordering and the pairing come from `lib/comparison.ts`, which is unit
 * tested, so a future edit that headlines throughput fails a test rather than
 * a dry run. Which row lands in which tier here is driven by `emphasis` (Tier
 * 1 = headline, Tier 3 = supporting) plus one key check for `utilisation`
 * (Tier 2) - the same key-based split `DOMINANT_ROW_KEYS` used before this
 * redesign, just one level up.
 */
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  GitCompare,
  Info,
  Table2,
  type LucideIcon,
} from 'lucide-react'

import { useGetLatestScheduleQuery } from '../api/apiSlice.ts'
import type { DoubleBooking, OverSubscribedWindow } from '../api/apiSlice.ts'
import { groupConflicts, type ConflictReport } from '../lib/conflicts.ts'
import {
  buildMetricRows,
  buildRateComparisonRows,
  headlineRows,
  supportingRows,
  type MetricRow,
  type RateComparisonRow,
  type Verdict,
} from '../lib/comparison.ts'
import { useAutoTour } from '../lib/useAutoTour.ts'
import { COMPARISON_TOUR_ID, COMPARISON_TOUR_STEPS } from '../tours/comparisonTour.ts'
import { PageHeader, TableShell, Td, Th } from '../components/Table.tsx'
import QueryState from '../components/QueryState.tsx'

/** Tier 2's key. Everything else in `supportingRows` is Tier 3. */
const SPOTLIGHT_KEY = 'utilisation'

export function ComparisonPage() {
  const schedule = useGetLatestScheduleQuery()
  const plan = schedule.data?.data
  const comparison = plan?.comparisonToBaseline ?? null
  const noScheduleYet = schedule.error && (schedule.error as { status?: number }).status === 404
  useAutoTour(COMPARISON_TOUR_ID, COMPARISON_TOUR_STEPS, !schedule.isLoading)

  if (noScheduleYet) {
    return (
      <>
        <PageHeader title="Baseline vs AI" />
        <EmptyState />
      </>
    )
  }

  return (
    <QueryState isLoading={schedule.isLoading} error={schedule.error}>
      {plan && !comparison && (
        <>
          <PageHeader title="Baseline vs AI" />
          <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700"
              aria-hidden="true"
            >
              <AlertCircle className="h-3.5 w-3.5" />
            </span>
            <div>
              <p className="text-sm font-medium text-amber-900">No comparison was computed</p>
              <p className="mt-1 text-sm text-amber-800">
                The baseline run did not complete for this plan, so there is nothing to compare
                against. That is deliberately distinguishable from a comparison of zero.
                {plan.generationErrors.length > 0 && (
                  <span className="mt-1 block font-mono text-xs">
                    {plan.generationErrors.map((e) => `${e.call}: ${e.message}`).join(' · ')}
                  </span>
                )}
              </p>
            </div>
          </div>
        </>
      )}

      {plan && comparison && (
        <>
          <PageHeader
            title="Baseline vs AI"
            subtitle="The current departmental booking process, run against the same backlog as the optimizer."
            meta={
              <span className="text-xs text-slate-500">
                {plan._id} · {new Date(plan.generatedAt).toLocaleString()}
              </span>
            }
          />

          {/* Caveat 1, made structural: the denominator before any number. */}
          <ScopeBand
            contestable={comparison.contestableTaskCount}
            splitOnly={comparison.splitOnlyTaskCount ?? 0}
            impossible={comparison.structurallyImpossibleCount}
          />

          {/*
           * Read-once background info, not per-KPI data - moved here from
           * the bottom of the page so it's available before the numbers
           * start, still collapsed by default (unchanged behavior, just a
           * new position) rather than scattered into per-field icons.
           */}
          <Caveats caveats={comparison.caveats} />

          {(() => {
            const rows = buildMetricRows(comparison)
            const tier1 = headlineRows(rows)
            const supporting = supportingRows(rows)
            const spotlight = supporting.find((row) => row.key === SPOTLIGHT_KEY)
            const tier3 = supporting.filter((row) => row.key !== SPOTLIGHT_KEY)

            return (
              <>
                <TierSection
                  icon={GitCompare}
                  title="Where the current process actually breaks"
                  intro="Real, unambiguous differences - structurally unreachable for a process where departments book blocks with no visibility into each other."
                >
                  <TierFrame>
                    <BreakdownPanel rows={tier1} />
                  </TierFrame>
                </TierSection>

                {spotlight && (
                  <TierSection
                    icon={AlertTriangle}
                    tone="amber"
                    title="The number that would fool you"
                    intro="Every other number on this page shows the AI ahead. This one doesn't - and that's the point."
                    badge="Flagged metric"
                  >
                    <TierFrame tone="amber">
                      <UtilisationSpotlight row={spotlight} />
                    </TierFrame>
                  </TierSection>
                )}

                {tier3.length > 0 && (
                  <TierSection
                    icon={Table2}
                    title="Why the AI's numbers look smaller here — and why that's not a defect"
                    intro={
                      'In every row below, the baseline\'s raw count reads higher — not because it ' +
                      'manages deadlines, severity, or risk better, but because it schedules more ' +
                      'of the backlog overall by double-booking corridors and ignoring dependency ' +
                      'order (see "Contestable tasks scheduled"). Each row shows what\'s actually ' +
                      'specific to it once you account for that.'
                    }
                  >
                    <TierFrame>
                      <RateComparisonChart rows={buildRateComparisonRows(comparison)} />
                      <MechanismTable rows={tier3} />
                    </TierFrame>
                  </TierSection>
                )}
              </>
            )
          })()}

          <ConflictEvidence
            conflictReport={plan.baseline?.conflictReport}
            doubleBookings={plan.baseline?.conflicts.doubleBookings ?? []}
            overSubscribed={plan.baseline?.conflicts.overSubscribedWindows ?? []}
            note={plan.baseline?.conflicts.note ?? ''}
          />

          <p className="mt-10 text-xs text-slate-500">
            Both plans were produced from the same backlog in the same run.{' '}
            <Link to="/dashboard" className="text-sky-700 hover:underline">
              See the optimized plan on the dashboard →
            </Link>
          </p>
        </>
      )}
    </QueryState>
  )
}

/**
 * Caveat 1 as layout: some tasks fit no window on their corridor at all and
 * are impossible for either engine. Every "contestable" figure below excludes
 * them, and saying so first is what stops the comparison being read as
 * covering the whole backlog.
 *
 * T29 Phase 1 (D-084) split what used to be a two-way band into three: a task
 * that fits no single window is no longer automatically impossible for the
 * OPTIMIZER, even though it stays impossible for the baseline (which never
 * splits, by design). `splitOnly` names that middle category explicitly
 * rather than letting it hide inside "impossible" - `splitOnly={0}` (a
 * pre-T29 stored schedule, or a corpus with no split-only-eligible tasks)
 * collapses back to exactly the old two-way band.
 */
/**
 * `Chip` is presentational only - a compact echo of the counts already
 * stated in the paragraph above it, not a filter control. This page has no
 * per-task list to filter into (every number below is already an aggregate
 * drawn from `contestable` by construction, per rule 1 in this file's top
 * comment), so a clickable "explore" control here would promise an
 * interaction this screen cannot deliver - the exact fabricated-capability
 * trap `designskill.md` warns against. `<span>`, not `<button>`, on purpose.
 */
function ScopeChip({ tone, children }: { tone: 'active' | 'neutral'; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
        tone === 'active' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200'
      }`}
    >
      {children}
    </span>
  )
}

function ScopeBand({
  contestable,
  splitOnly,
  impossible,
}: {
  contestable: number
  splitOnly: number
  impossible: number
}) {
  const total = contestable + splitOnly + impossible
  return (
    <div
      data-tour="comparison-scope-band"
      className="flex gap-3 rounded-xl bg-sky-50 p-4 ring-1 ring-sky-100"
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-600 text-white"
        aria-hidden="true"
      >
        <Info className="h-3.5 w-3.5" />
      </span>
      <div>
        <h2 className="text-xs font-semibold tracking-wide text-sky-900 uppercase">
          What this comparison covers
        </h2>
        <p className="mt-1.5 max-w-4xl text-sm text-slate-700">
          Of {total} pending tasks, <strong>{impossible} fit no combination of windows at all</strong>{' '}
          (even considering splitting) and are impossible for <em>both</em> engines — traffic leaves
          no gap long enough, so that work needs a traffic block that displaces trains.
          {splitOnly > 0 && (
            <>
              {' '}
              A further <strong>{splitOnly} fit no single window</strong> but{' '}
              <em>are</em> placeable by the optimizer via splitting work across non-contiguous
              sessions — a capability this baseline process structurally does not have, at any
              horizon length.
            </>
          )}{' '}
          Every figure in the cards below is drawn from the{' '}
          <strong>{contestable} contestable tasks</strong> that either engine could actually place —
          the split-only tasks are reported on their own, separately, never folded into that count.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-2xs font-semibold tracking-wide text-slate-500 uppercase">
            Breakdown
          </span>
          <ScopeChip tone="active">{contestable} contestable</ScopeChip>
          {splitOnly > 0 && <ScopeChip tone="neutral">{splitOnly} split-only</ScopeChip>}
          <ScopeChip tone="neutral">{impossible} impossible for either engine</ScopeChip>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Shared backbone across all 3 tiers                                        */
/* -------------------------------------------------------------------------- */

/**
 * The same header treatment for all 3 tiers (identical size/weight/spacing),
 * so the page reads as one deliberate 3-act structure rather than three
 * stitched-together components. Three clearly distinct type-scale steps on
 * this page, each a step already used elsewhere in this codebase: the page
 * title is `text-xl` (`PageHeader`, unchanged), a tier header is `text-base`,
 * and a card/row label is `text-sm` - see `BreakdownPanel`/`UtilisationSpotlight`/
 * `MechanismTable`.
 */
function TierSection({
  icon: Icon,
  tone = 'plain',
  title,
  intro,
  badge,
  children,
}: {
  /** Identifies which of the 3 acts this is at a glance, matching the
   * icon-in-chip pattern now used app-wide (KpiStrip, AskThePlanner,
   * DeferredTasksPanel) - purely a wayfinding anchor, never a status signal
   * of its own (that's what `badge`/`VerdictBadge` are for). */
  icon: LucideIcon
  /** 'amber' only for Tier 2, matching its `TierFrame`/`badge` tone below -
   * reusing an already-established meaning, never a new color choice. */
  tone?: 'plain' | 'amber'
  title: string
  intro: string
  /** Tier 2 only - a section-level flag that this tier's number reads
   * backwards. Additive to, never a replacement for, `VerdictBadge`'s own
   * "reads backwards" pill on the row itself (below) - the established
   * wording designskill.md calls out as load-bearing stays exactly where
   * it already was; this is purely a second, more visible cue at the top
   * of the card. */
  badge?: string
  children: ReactNode
}) {
  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
              tone === 'amber' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'
            }`}
            aria-hidden="true"
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            <p className="mt-1 mb-4 max-w-3xl text-xs text-slate-500">{intro}</p>
          </div>
        </div>
        {badge && (
          <span className="shrink-0 rounded-full bg-amber-200 px-2.5 py-1 text-2xs font-semibold tracking-wide text-amber-900 uppercase">
            {badge}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

/**
 * The same outer frame for all 3 tiers - rounded-2xl, ring-1, p-8 - so a
 * bare split panel, a tinted spotlight, and a table don't read as three
 * different UI kits. Only the fill (`tone`) and the inner content differ.
 */
function TierFrame({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'amber'
  children: ReactNode
}) {
  return (
    <div
      className={`rounded-2xl p-8 ring-1 ${
        tone === 'amber' ? 'bg-amber-50 ring-amber-200' : 'bg-white ring-slate-100'
      }`}
    >
      {children}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Shared: glossary popovers - definitions only, never a caveat in disguise  */
/* -------------------------------------------------------------------------- */

const POSSESSION_DEFINITION =
  'The maintenance department\'s own term for one claimed block window on a corridor - the same ' +
  'thing this page elsewhere calls a "block" or a "window".'

/**
 * A small (i) with a click-to-reveal definition - for domain VOCABULARY a
 * reader might not know but doesn't need in order to trust the number
 * (PRD/house-style term of art), never for a caveat. The risk model's
 * FRAMING, the "reads backwards" reasoning, and every badge's underlying
 * explanation stay inline and always visible, at full weight - none of that
 * belongs behind an icon, and none of it uses this component.
 */
function GlossaryTerm({ term, definition }: { term: string; definition: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-flex items-baseline gap-1 whitespace-nowrap">
      {term}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`What does "${term}" mean?`}
        className="inline-flex h-3.5 w-3.5 shrink-0 translate-y-px items-center justify-center rounded-full bg-slate-300 text-white hover:bg-slate-400"
      >
        <Info aria-hidden="true" className="h-2.5 w-2.5" />
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute top-full left-0 z-10 mt-1.5 w-64 rounded-lg bg-slate-900 p-2.5 text-2xs leading-relaxed whitespace-normal text-white shadow-lg"
        >
          {definition}
        </span>
      )}
    </span>
  )
}

/**
 * Splits `text` at the first case-sensitive occurrence of `term` and wraps
 * just that occurrence in a `GlossaryTerm`, leaving the rest of the sentence
 * as plain text. Falls back to the plain string untouched if `term` isn't
 * found, so a future copy edit that removes the word can never crash this.
 */
function withGlossary(text: string, term: string, definition: string): ReactNode {
  const index = text.indexOf(term)
  if (index === -1) return text
  return (
    <>
      {text.slice(0, index)}
      <GlossaryTerm term={term} definition={definition} />
      {text.slice(index + term.length)}
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Shared: click-to-reveal MECHANISM color (never a caveat - see call sites) */
/* -------------------------------------------------------------------------- */

/**
 * A small (i) toggle, controlled by the caller so both the icon and the
 * revealed content it controls can live in different parts of the DOM (the
 * icon sits beside a stat's name; the revealed paragraph sits below the
 * stat itself). Reuses this file's own established disclosure convention
 * (`ConflictEvidence`'s "View details", `Caveats`' toggle - a button plus
 * `aria-expanded`) rather than a floating tooltip, since what it reveals is
 * a full paragraph, not a short definition (`GlossaryTerm`, above, is the
 * right shape for that instead).
 *
 * ONLY for mechanism/narrative color where the stat is already
 * self-evidently good or bad without it - never for a caveat. This page's
 * badged rows, the risk model's FRAMING, and the "reads backwards"
 * reasoning never use this component; see each call site for why.
 */
function ExplainerIcon({
  open,
  onToggle,
  label,
}: {
  open: boolean
  onToggle: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? 'Hide' : 'Show'} why: ${label}`}
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-slate-200 text-3xs leading-none font-semibold text-slate-600 hover:bg-slate-300"
    >
      i
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Tier 1 - the wide split panel                                              */
/* -------------------------------------------------------------------------- */

/**
 * One card per genuinely unambiguous structural win, side by side - a
 * redesign found that these two (or three, with `splitOnly`) read as more
 * confident stated separately than stacked as rows under one shared header,
 * since each is its own self-contained claim with its own explanation.
 * `splitOnly`, when present, stays full-width underneath (it already read
 * as secondary before this redesign - its note is a caveat-length paragraph,
 * not a card-sized one - and that hierarchy survives the move into cards)
 * but never with a badge - like double-booking and batching, it is a
 * genuine, unconfounded capability gap.
 *
 * "Possession" (the batches row's own note text) is real maintenance-
 * department jargon this page never otherwise defines - it gets the one
 * glossary popover on this page whose term isn't already fully explained in
 * running prose elsewhere (compare `ScopeBand`, which already fully defines
 * "contestable" - no icon needed on a term that already has a visible
 * definition).
 */
function BreakdownPanel({ rows }: { rows: MetricRow[] }) {
  const cardRows = rows.filter((row) => row.key !== 'splitOnly')
  const splitOnlyRow = rows.find((row) => row.key === 'splitOnly')

  return (
    <div data-tour="comparison-headline" className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {cardRows.map((row) => (
          <BreakdownCard key={row.key} row={row} />
        ))}
      </div>
      {splitOnlyRow && <BreakdownCard row={splitOnlyRow} compact />}
    </div>
  )
}

/**
 * `doubleBookings`/`batches` are unambiguous wins with no badge - the stat
 * is already self-evidently good/bad, so their explanation is mechanism
 * color, collapsed behind `ExplainerIcon` by default. `splitOnly` is not in
 * that set on purpose - it stays exactly as it was, note always visible.
 */
function BreakdownCard({ row, compact = false }: { row: MetricRow; compact?: boolean }) {
  const collapsible = row.key === 'doubleBookings' || row.key === 'batches'
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-xl bg-white p-5 ring-1 ring-slate-100">
      <div className="flex items-center gap-1.5">
        <h3
          className={
            compact ? 'text-xs font-semibold text-slate-700' : 'text-sm font-semibold text-slate-900'
          }
        >
          {row.label}
        </h3>
        {collapsible && (
          <ExplainerIcon open={open} onToggle={() => setOpen((value) => !value)} label={row.label} />
        )}
      </div>
      <div className="mt-3 flex items-baseline gap-6">
        <Side label="Baseline" value={row.baseline} tone="bad" size={compact ? 'sm' : 'lg'} />
        <Side label="AI-optimised" value={row.optimized} tone="good" size={compact ? 'sm' : 'lg'} />
      </div>
      {(!collapsible || open) && (
        <p className="mt-3 max-w-md text-xs leading-relaxed text-slate-600">
          {row.key === 'batches'
            ? withGlossary(row.note, 'possession', POSSESSION_DEFINITION)
            : row.note}
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Shared: the badge vocabulary - exactly 3 badges, and NONE for a plain win  */
/* -------------------------------------------------------------------------- */

/**
 * `optimizer-better` renders no badge at all - a plain, honest win needs no
 * flag, and a 4th "improvement" pill would be exactly the "badge on a plain
 * win, just to celebrate it" this vocabulary is required to avoid. This
 * matters concretely in `MechanismTable`: a Tier 3 row can genuinely resolve
 * to `optimizer-better` (e.g. the optimizer schedules on-time work at both a
 * higher rate AND more of it in absolute terms) - that row's Evaluation column
 * is blank, not a 4th color.
 */
function VerdictBadge({ verdict }: { verdict: Verdict }) {
  if (verdict === 'optimizer-better') return null

  const misleading = verdict === 'baseline-higher-but-worse'
  const neutral = verdict === 'no-difference'
  // The only remaining possibility, since `optimizer-better` already
  // returned above and `Verdict` has exactly four members.

  return (
    <span
      className={`inline-block shrink-0 rounded-full px-2 py-0.5 text-3xs font-semibold tracking-wide uppercase ${
        misleading
          ? 'bg-amber-200 text-amber-900'
          : neutral
            ? 'bg-slate-200 text-slate-700'
            : 'bg-sky-200 text-sky-900'
      }`}
    >
      {misleading ? 'reads backwards' : neutral ? 'no difference' : 'fewer, by design'}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Tier 2 - the spotlight, with a capacity bar chart                         */
/* -------------------------------------------------------------------------- */

/**
 * Cut to 2 representations, deliberately: the number+bar (the bar already
 * proves the over-subscription point visually) and ONE line of text folding
 * in the paired over-subscribed-windows count. An earlier version stacked 4
 * forms of the same fact (number, bar, a separate boxed callout, and a full
 * paragraph) - genuinely redundant, not thoroughness. The one line still
 * carries both real numbers from `row.pairedWith` (never dropped) and the
 * "defect, not an advantage" reasoning (never hidden behind a badge alone) -
 * `lib/comparison.ts`'s own data shape (`note` + `pairedWith`) is unchanged,
 * only how this one card renders them collapses into a single sentence.
 *
 * AI's number stays neutral (never emerald/"good") here, deliberately - this
 * is not a normal win/loss pair, and recoloring it would repurpose the
 * page's one color signal for something it doesn't mean.
 */
function UtilisationSpotlight({ row }: { row: MetricRow }) {
  const baselinePct = parseFloat(row.baseline)
  const optimizedPct = parseFloat(row.optimized)

  return (
    <section data-tour="comparison-headline">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{row.label}</h3>
        <VerdictBadge verdict={row.verdict} />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-6">
        <Side label="Baseline" value={row.baseline} tone="warn" size="lg" />
        <span className="text-2xl text-slate-300" aria-hidden="true">
          →
        </span>
        <Side label="AI-optimised" value={row.optimized} tone="neutral" size="lg" />
      </div>

      <CapacityBarChart baselinePct={baselinePct} optimizedPct={optimizedPct} />

      <p className="mt-5 max-w-2xl text-sm leading-relaxed text-slate-700">
        {row.pairedWith ? (
          <>
            The baseline scores higher only because it over-subscribes{' '}
            <strong className="tabular-nums">{row.pairedWith.baseline}</strong> window
            {row.pairedWith.baseline === '1' ? '' : 's'} beyond capacity, against the
            AI-optimised plan's <strong className="tabular-nums">{row.pairedWith.optimized}</strong>{' '}
            — a defect showing through, not an advantage.
          </>
        ) : (
          row.note
        )}
      </p>
    </section>
  )
}

/**
 * Two horizontal bars against a shared 0%-`maxScale`% axis, with a labelled
 * reference line at 100%. Baseline's bar is allowed to cross it - the
 * overflow segment renders in a distinctly darker, more saturated fill (not
 * merely a lighter/darker step of the same shade) so the distinction survives
 * more than hue alone, and the "100% capacity" text label is the actual
 * non-color explanation of where the line falls, never the color by itself.
 *
 * Colors: rose-700 (`#be123c`) / emerald-600 (`#059669`) - validated via the
 * dataviz skill's palette checker (CVD deuteranopia ΔE 8.0, clears the floor)
 * rather than eyeballed. This is one shade off this page's usual rose-700/
 * emerald-700 TEXT pairing (which fails that same check at ΔE 6.0) - text
 * with its own adjacent label carries identity redundantly in a way two bar
 * fills sitting in the same small chart do not, so the fill gets the
 * validated pair instead of reusing the text shade unchecked.
 */
function CapacityBarChart({ baselinePct, optimizedPct }: { baselinePct: number; optimizedPct: number }) {
  const maxScale = Math.max(120, Math.ceil(baselinePct) + 15)

  return (
    <div className="mt-6 max-w-xl space-y-4">
      <CapacityBar
        label="Baseline"
        pct={baselinePct}
        maxScale={maxScale}
        fillClassName="bg-rose-300"
        overflowClassName="bg-rose-700"
        showReferenceLabel
      />
      <CapacityBar
        label="AI-optimised"
        pct={optimizedPct}
        maxScale={maxScale}
        fillClassName="bg-emerald-600"
      />
    </div>
  )
}

function CapacityBar({
  label,
  pct,
  maxScale,
  fillClassName,
  overflowClassName,
  showReferenceLabel = false,
}: {
  label: string
  pct: number
  maxScale: number
  fillClassName: string
  overflowClassName?: string
  showReferenceLabel?: boolean
}) {
  const referencePct = (100 / maxScale) * 100
  const fillPct = (Math.min(pct, 100) / maxScale) * 100
  const overflowPct = pct > 100 ? ((pct - 100) / maxScale) * 100 : 0
  const labelPct = Math.min(fillPct + overflowPct, 100)

  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-2xs font-medium tracking-wide text-slate-500 uppercase">
        {label}
      </span>
      <div className="relative h-6 flex-1 rounded-sm bg-slate-100">
        {showReferenceLabel && (
          <span
            className="absolute -top-4 -translate-x-1/2 text-3xs font-medium whitespace-nowrap text-slate-500"
            style={{ left: `${referencePct}%` }}
          >
            100% capacity
          </span>
        )}

        <div
          className={`absolute inset-y-0 left-0 rounded-sm ${fillClassName}`}
          style={{ width: `calc(${fillPct}% - 1px)` }}
          aria-hidden="true"
        />
        {overflowPct > 0 && overflowClassName && (
          <div
            className={`absolute inset-y-0 rounded-r-sm ${overflowClassName}`}
            style={{ left: `calc(${referencePct}% + 1px)`, width: `${overflowPct}%` }}
            aria-hidden="true"
          />
        )}

        {/* The actual non-color explanation of the threshold - the label,
            not the fill color, is what says "past here doesn't fit". */}
        <div
          className="absolute inset-y-0 border-l-2 border-slate-400"
          style={{ left: `${referencePct}%` }}
          aria-hidden="true"
        />

        <span
          className="absolute inset-y-0 flex items-center pl-1.5 text-xs font-semibold tabular-nums text-slate-900"
          style={{ left: `${labelPct}%` }}
        >
          {pct}%
        </span>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Tier 3 - the rate comparison chart, above the mechanism table              */
/* -------------------------------------------------------------------------- */

/**
 * A dumbbell chart - the dataviz skill's own recommended form for "before ->
 * after per item" - so the pattern across all four rate-shaped Tier 3 rows
 * (the AI at or ahead on every one) is visible at a glance instead of
 * requiring four separate rows of mental arithmetic. `buildRateComparisonRows`
 * is the only source of the percentages plotted here - see its own doc
 * comment for why `slaCompliance` uses a different denominator than its table
 * row, and why `fragmentation` ("Possessions used") never appears here at all.
 *
 * Colors reuse this app's reserved, already-validated baseline/AI pair
 * (rose-700 / emerald-600 - the same one `CapacityBarChart` uses, checked via
 * the dataviz skill's palette script) rather than a new choice. A legend
 * sits above the rows once, per the skill's "legend always present for 2+
 * series" rule, rather than repeating "Baseline"/"AI-optimised" on every dot
 * a `sparing labels` chart would otherwise be crowded by.
 */
function RateComparisonChart({ rows }: { rows: RateComparisonRow[] }) {
  if (rows.length === 0) return null

  return (
    <div className="mb-6 border-b border-slate-100 pb-6">
      <div className="mb-4 flex items-center gap-4">
        <RateLegendSwatch tone="bad" label="Baseline" />
        <RateLegendSwatch tone="good" label="AI-optimised" />
      </div>
      <div className="space-y-4">
        {rows.map((row) => (
          <RateComparisonRowView key={row.key} row={row} />
        ))}
      </div>
    </div>
  )
}

function RateLegendSwatch({ tone, label }: { tone: 'good' | 'bad'; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-2xs font-medium text-slate-600">
      <span
        className={`h-2.5 w-2.5 rounded-full ${tone === 'good' ? 'bg-emerald-600' : 'bg-rose-700'}`}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}

/**
 * One row: the label and both values on top (numbers are text, never the
 * dot's own fill color, per the mark spec), the dumbbell itself below - a
 * baseline dot and an AI dot on a shared 0-100% track, joined by a line. Dot
 * size and the white ring around each follow the dataviz skill's mark spec
 * (>=8px marker, 2px surface-color ring) so two close values stay legible
 * where they nearly overlap.
 */
function RateComparisonRowView({ row }: { row: RateComparisonRow }) {
  // On the real corpus a tie is common (several D-093 KPIs land both engines
  // at 100%), and two identical-position dots render as one - the later dot
  // fully hides the earlier one, which reads as "the baseline dot vanished"
  // rather than "these are equal". Nudge apart just far enough to keep both
  // rings visible; the TEXT values above stay exact regardless - this only
  // moves where the marks sit, never what they say.
  const MIN_GAP_PCT = 3
  const tied = row.baselinePct === row.optimizedPct
  const baselineDotPct = tied
    ? Math.max(0, Math.min(100 - MIN_GAP_PCT, row.baselinePct - MIN_GAP_PCT / 2))
    : row.baselinePct
  const optimizedDotPct = tied ? baselineDotPct + MIN_GAP_PCT : row.optimizedPct

  const left = Math.min(baselineDotPct, optimizedDotPct)
  const width = Math.abs(optimizedDotPct - baselineDotPct)

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-xs font-medium text-slate-700">{row.label}</p>
        <p className="shrink-0 text-xs font-semibold tabular-nums">
          <span className="text-rose-700">{row.baselinePct}%</span>
          <span className="mx-1 text-slate-300" aria-hidden="true">
            →
          </span>
          <span className="text-emerald-700">{row.optimizedPct}%</span>
          {tied && <span className="ml-1 font-normal text-slate-400">(tied)</span>}
        </p>
      </div>
      <div className="relative mt-2.5 h-3">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-slate-100" />
        <div
          className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-slate-300"
          style={{ left: `${left}%`, width: `${width}%` }}
          aria-hidden="true"
        />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-700 ring-2 ring-white"
          style={{ left: `${baselineDotPct}%` }}
          title={`Baseline: ${row.baselinePct}%`}
        />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-600 ring-2 ring-white"
          style={{ left: `${optimizedDotPct}%` }}
          title={`AI-optimised: ${row.optimizedPct}%`}
        />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Tier 3 - the mechanism table                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every KPI is actually two `<tr>`s: a compact data row, then a full-width
 * explanation row. Risk reduction's explanation row is simply the one that's
 * taller, because it additionally carries the FRAMING caveat box at full,
 * undiminished visual weight (same box styling this page has always used for
 * it) - it needs no special-case "breakout" layout, just the row every KPI
 * already has.
 *
 * Deliberately NOT `TableShell` here - that component's own rounded-xl/
 * border/shadow would compete with the `TierFrame` this now sits inside
 * (two concentric rounded borders reads as an accident, not a choice), so
 * this uses the same `Th`/`Td` cell primitives with a lighter wrapper.
 */
function MechanismTable({ rows }: { rows: MetricRow[] }) {
  if (rows.length === 0) return null

  return (
    <div data-tour="comparison-supporting" className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr>
            <Th>KPI</Th>
            <Th align="right">Baseline</Th>
            <Th align="right">AI-optimised</Th>
            <Th>Evaluation</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <MechanismRowPair key={row.key} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * `slaCompliance` is the one row here whose explanation is collapsed behind
 * `ExplainerIcon` - it's mechanism color (the rate-vs-raw-count framing),
 * not a caveat about whether to trust the number. The other four rows
 * (`scheduled`, `fragmentation`, `priorityCoverage`, `riskReduction`) all
 * carry a badge for a reason and keep their explanation - including risk
 * reduction's FRAMING box - exactly as visible as it has ever been; this
 * component never collapses those, regardless of what verdict they resolve
 * to on a given run.
 */
const COLLAPSIBLE_MECHANISM_KEYS = new Set(['slaCompliance'])

function MechanismRowPair({ row }: { row: MetricRow }) {
  const collapsible = COLLAPSIBLE_MECHANISM_KEYS.has(row.key)
  const [open, setOpen] = useState(false)
  const showExplanation = !collapsible || open

  return (
    <>
      <tr className="hover:bg-slate-50">
        <Td>
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            {row.label}
            {collapsible && (
              <ExplainerIcon open={open} onToggle={() => setOpen((value) => !value)} label={row.label} />
            )}
          </span>
        </Td>
        <Td align="right">
          <span className="text-base font-semibold tabular-nums text-slate-900">
            {row.baseline}
          </span>
        </Td>
        <Td align="right">
          <span className="text-base font-semibold tabular-nums text-slate-900">
            {row.optimized}
          </span>
        </Td>
        <Td>
          <VerdictBadge verdict={row.verdict} />
        </Td>
      </tr>
      {showExplanation && (
        <tr>
          <td colSpan={4} className="border-b border-slate-100 bg-slate-50/60 px-4 py-3">
            {/*
             * D-093: the caveat about the MODEL behind the number (risk.py's
             * PRD 9.1 FRAMING) - same box styling this page has always used
             * for it, unchanged, so it never reads as diminished just because
             * it now sits inside a table cell. Never collapsed - see
             * `COLLAPSIBLE_MECHANISM_KEYS` above.
             */}
            {row.caveatBox && (
              <div className="mb-2 rounded-lg bg-white p-3 ring-1 ring-amber-200">
                <p className="text-2xs font-semibold tracking-wide text-amber-900 uppercase">
                  {row.caveatBox.label}
                </p>
                <p className="mt-1 text-2xs leading-relaxed text-amber-900">
                  {row.caveatBox.note}
                </p>
              </div>
            )}
            <p className="text-xs leading-relaxed text-slate-600">{row.note}</p>
          </td>
        </tr>
      )}
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Shared number display                                                     */
/* -------------------------------------------------------------------------- */

function Side({
  label,
  value,
  tone,
  size = 'md',
}: {
  /** Omitted in `BreakdownPanel`, where the column heading carries this meaning once. */
  label?: string
  value: string
  tone: 'good' | 'bad' | 'warn' | 'neutral'
  size?: 'sm' | 'md' | 'lg'
}) {
  const colour =
    tone === 'good'
      ? 'text-emerald-700'
      : tone === 'bad'
        ? 'text-rose-700'
        : tone === 'warn'
          ? 'text-amber-800'
          : 'text-slate-900'
  const valueSize = size === 'lg' ? 'text-5xl sm:text-6xl' : size === 'sm' ? 'text-xl' : 'text-3xl'
  return (
    <div>
      {label && <p className="text-2xs tracking-wide text-slate-500 uppercase">{label}</p>}
      <p className={`${valueSize} leading-tight font-semibold tabular-nums ${colour}`}>{value}</p>
    </div>
  )
}

/** PRD 9.5 type name, so a conflict is named rather than merely counted. */
function ConflictTypeBadge({ label }: { label: string }) {
  return (
    <span className="rounded bg-rose-50 px-1.5 py-0.5 text-3xs font-semibold tracking-wide text-rose-800 uppercase ring-1 ring-rose-200 ring-inset">
      {label}
    </span>
  )
}

/**
 * The conflicts themselves, not just the count.
 *
 * A number can be argued with; "these two departments both booked BBPR-SYU from
 * 04:14 to 06:14 on the 24th" cannot. This is the most concrete evidence in the
 * project that the current process fails.
 */
function ConflictEvidence({
  doubleBookings,
  overSubscribed,
  note,
  conflictReport,
}: {
  doubleBookings: DoubleBooking[]
  overSubscribed: OverSubscribedWindow[]
  note: string
  /** T21: supplies the PRD 9.5 type name and resolution for each block. */
  conflictReport?: ConflictReport | null
}) {
  const [open, setOpen] = useState(false)

  if (doubleBookings.length === 0 && overSubscribed.length === 0) return null

  // Every group here is on the `baseline` layer by construction - these are the
  // naive process's conflicts, never this system's plan's (D-045).
  const byType = new Map(
    groupConflicts(conflictReport, 'baseline').map((group) => [group.type, group]),
  )
  const doubleBookingType = byType.get('CORRIDOR_DOUBLE_BOOKING')
  const overSubscriptionType = byType.get('WINDOW_OVER_SUBSCRIPTION')

  // One line, drawn from the same data as the full table below - never a
  // separate/invented figure, just the same conflicts summarised.
  const uniqueDepartmentPairs = Array.from(
    new Set(doubleBookings.map((conflict) => conflict.departments.join(' vs '))),
  )
  const shownPairs = uniqueDepartmentPairs.slice(0, 3)
  const morePairs = uniqueDepartmentPairs.length - shownPairs.length

  return (
    <section data-tour="comparison-conflict-evidence" className="mt-10">
      <h2 className="mb-1 text-sm font-semibold text-slate-900">The conflicts themselves</h2>
      <p className="mb-3 max-w-3xl text-xs text-slate-500">{note}</p>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-rose-50 px-4 py-3">
        <p className="text-sm text-rose-900">
          {doubleBookings.length > 0 && (
            <>
              <strong>
                {doubleBookings.length} double-booked corridor pair
                {doubleBookings.length === 1 ? '' : 's'}
              </strong>{' '}
              — {shownPairs.join(', ')}
              {morePairs > 0 ? `, +${morePairs} more` : ''}
            </>
          )}
          {doubleBookings.length > 0 && overSubscribed.length > 0 && ' · '}
          {overSubscribed.length > 0 && (
            <strong>
              {overSubscribed.length} window{overSubscribed.length === 1 ? '' : 's'} booked beyond
              capacity
            </strong>
          )}
        </p>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-sky-700 transition-colors hover:bg-white/70"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
          {open ? 'Hide details' : 'View details'}
        </button>
      </div>

      {open && (
        <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <ConflictTypeBadge label={doubleBookingType?.label ?? 'Corridor double-booking'} />
        <span className="text-xs text-slate-500">
          {doubleBookings.length} on the baseline plan
        </span>
        {doubleBookingType && (
          <span className="text-2xs text-slate-500">
            · Resolution: <strong className="font-medium text-slate-700">
              {doubleBookingType.strategies.join(' / ')}
            </strong>
          </span>
        )}
      </div>

      <TableShell>
        <thead>
          <tr>
            <Th>Corridor</Th>
            <Th>Date</Th>
            <Th>Departments</Th>
            <Th>Overlapping window</Th>
            <Th align="right">Overlap</Th>
            <Th>Tasks</Th>
          </tr>
        </thead>
        <tbody>
          {doubleBookings.map((conflict) => (
            <tr key={`${conflict.corridorId}-${conflict.taskIds.join('-')}`} className="hover:bg-slate-50">
              <Td mono>
                <Link
                  to={`/corridors/${encodeURIComponent(conflict.corridorId)}`}
                  className="text-sky-700 hover:underline"
                >
                  {conflict.corridorId}
                </Link>
              </Td>
              <Td mono>{conflict.date}</Td>
              <Td>
                <span className="font-medium text-rose-700">
                  {conflict.departments.join(' vs ')}
                </span>
              </Td>
              <Td mono>
                {conflict.overlapStart}–{conflict.overlapEnd}
              </Td>
              <Td align="right">
                <span className="font-semibold text-rose-700">{conflict.overlapMinutes} min</span>
              </Td>
              <Td mono>{conflict.taskIds.join(', ')}</Td>
            </tr>
          ))}
        </tbody>
      </TableShell>

      {overSubscribed.length > 0 && (
        <div className="mt-4 rounded-xl bg-white p-5 ring-1 ring-slate-100">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <ConflictTypeBadge
              label={overSubscriptionType?.label ?? 'Window over-subscription'}
            />
            <h3 className="text-sm font-semibold text-slate-900">
              Windows booked beyond capacity{' '}
              <span className="font-normal text-slate-500">({overSubscribed.length})</span>
            </h3>
          </div>
          {overSubscriptionType && (
            <p className="mt-1 text-2xs text-slate-500">
              Resolution:{' '}
              <strong className="font-medium text-slate-700">
                {overSubscriptionType.strategies.join(' / ')}
              </strong>{' '}
              — classified, not applied.
            </p>
          )}
          <ul className="mt-2 space-y-1">
            {overSubscribed.map((window) => (
              <li key={`${window.corridorId}-${window.date}-${window.windowIndex}`} className="text-xs text-slate-600">
                <span className="font-mono text-slate-800">{window.corridorId}</span> on{' '}
                {window.date} — {window.departments.join(' + ')} claimed{' '}
                <strong>{window.claimedMinutes} min</strong> of a{' '}
                <strong>{window.capacityMinutes} min</strong> window,{' '}
                <span className="font-semibold text-rose-700">
                  {window.excessMinutes} min over
                </span>
                .
              </li>
            ))}
          </ul>
        </div>
      )}
        </div>
      )}
    </section>
  )
}

/**
 * The caveats verbatim.
 *
 * By this point they have already shaped everything above - the scope band, the
 * ordering, the paired utilisation card. They are restated here so the rules
 * the screen was built to obey are legible to anyone checking it.
 */
function Caveats({ caveats }: { caveats: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <section data-tour="comparison-caveats" className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="-ml-1.5 flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        How to read this comparison
      </button>
      {open && (
        <div className="mt-3">
          <p className="mb-2 text-xs text-slate-500">
            Stored with the comparison by the system that computed it, not written by this page.
          </p>
          <ol className="space-y-1.5">
            {caveats.map((caveat, index) => (
              <li key={caveat} className="flex gap-2 text-xs leading-relaxed text-slate-600">
                <span className="font-semibold text-slate-500">{index + 1}.</span>
                <span>{caveat}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
      <h2 className="text-sm font-semibold text-slate-900">No plan generated yet</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
        The comparison runs against a generated plan. Generate one on the dashboard and both the
        optimizer and the baseline will be computed from the same backlog.
      </p>
      <Link
        to="/dashboard"
        className="mt-4 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Go to the dashboard
      </Link>
    </div>
  )
}

export default ComparisonPage
