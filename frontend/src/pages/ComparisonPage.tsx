/**
 * Baseline vs AI comparison - PRD FR9.3 / Section 12, task T14.
 *
 * Reads the comparison T10 already computed and stored; it never re-runs a
 * solve. Both plans came from the same input on the same run, which is what
 * makes them comparable at all.
 *
 * THE LAYOUT IS THE HONESTY MECHANISM
 * -----------------------------------
 * D-031 records how easily this screen misleads, and its three rules shape the
 * structure here rather than sitting in small print:
 *
 *   1. The contestable denominator is stated *before* any number, in its own
 *      band, because 53 of the 89 tasks are impossible for both engines and a
 *      comparison drawn from 89 would credit the optimizer for them.
 *   2. Conflicts and batching are the headline. Scheduled-task count is a
 *      supporting row explicitly marked "no difference" - both engines place
 *      the same work, and leading with that number would be a false claim.
 *   3. Utilisation is rendered *inside the same card* as the over-subscription
 *      count that causes it. The baseline's utilisation is higher; shown alone
 *      it reads as the baseline winning.
 *
 * The ordering and the pairing come from `lib/comparison.ts`, which is unit
 * tested, so a future edit that headlines throughput fails a test rather than a
 * dry run.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { useGetLatestScheduleQuery } from '../api/apiSlice.ts'
import type { DoubleBooking, OverSubscribedWindow } from '../api/apiSlice.ts'
import { groupConflicts, type ConflictReport } from '../lib/conflicts.ts'
import { buildMetricRows, headlineRows, supportingRows, type MetricRow } from '../lib/comparison.ts'
import { useAutoTour } from '../lib/useAutoTour.ts'
import { COMPARISON_TOUR_ID, COMPARISON_TOUR_STEPS } from '../tours/comparisonTour.ts'
import { PageHeader, TableShell, Td, Th } from '../components/Table.tsx'
import QueryState from '../components/QueryState.tsx'

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
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
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

          {(() => {
            const rows = buildMetricRows(comparison)
            return (
              <>
                <section className="mt-10">
                  <h2 className="mb-1 text-sm font-semibold text-slate-900">
                    What coordination actually changes
                  </h2>
                  <p className="mb-4 max-w-3xl text-xs text-slate-500">
                    The optimizer's advantage is that its plan can be executed — not that it
                    schedules more work.
                  </p>
                  <HeadlineGroup rows={headlineRows(rows)} />
                </section>

                <section className="mt-10">
                  <h2 className="mb-3 text-sm font-semibold text-slate-900">
                    Numbers that need their context
                  </h2>
                  <div data-tour="comparison-supporting" className="grid gap-4 lg:grid-cols-2">
                    {supportingRows(rows).map((row) => (
                      <SupportingCard key={row.key} row={row} />
                    ))}
                  </div>
                </section>
              </>
            )
          })()}

          <ConflictEvidence
            conflictReport={plan.baseline?.conflictReport}
            doubleBookings={plan.baseline?.conflicts.doubleBookings ?? []}
            overSubscribed={plan.baseline?.conflicts.overSubscribedWindows ?? []}
            note={plan.baseline?.conflicts.note ?? ''}
          />

          <Caveats caveats={comparison.caveats} />

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
    <div data-tour="comparison-scope-band" className="border-b border-slate-100 pb-5">
      <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
        What this comparison covers
      </h2>
      <p className="mt-2 max-w-4xl text-sm text-slate-600">
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
      <div className="mt-4 flex overflow-hidden rounded-md text-[11px] font-medium">
        <div
          className="bg-slate-900 px-2 py-1.5 text-center text-white"
          style={{ width: `${(contestable / total) * 100}%` }}
        >
          {contestable} contestable
        </div>
        {splitOnly > 0 && (
          <div
            className="bg-sky-700 px-2 py-1.5 text-center text-white"
            style={{ width: `${(splitOnly / total) * 100}%` }}
          >
            {splitOnly} split-only
          </div>
        )}
        <div
          className="bg-slate-300 px-2 py-1.5 text-center text-slate-700"
          style={{ width: `${(impossible / total) * 100}%` }}
        >
          {impossible} impossible for either engine
        </div>
      </div>
    </div>
  )
}

/**
 * The two numbers this page exists to show: double-booked corridors and
 * cross-department shared blocks. Deliberately the largest, boldest thing on
 * the page - everything else (including `SecondaryHeadlineCard`, below) is
 * sized to stay out of their way.
 */
const DOMINANT_ROW_KEYS = new Set(['doubleBookings', 'batches'])

/**
 * Groups the headline rows so the two dominant metrics (see
 * `DOMINANT_ROW_KEYS`) read as one bold moment, while a row like "tasks
 * placeable only by splitting" stays present - it is real, load-bearing
 * context per T29 Phase 1 - but visually secondary. Row order itself is
 * untouched (`buildMetricRows`' ordering, not this component, owns that).
 */
function HeadlineGroup({ rows }: { rows: MetricRow[] }) {
  const secondary = rows.filter((row) => !DOMINANT_ROW_KEYS.has(row.key))
  const dominant = rows.filter((row) => DOMINANT_ROW_KEYS.has(row.key))
  return (
    <div data-tour="comparison-headline" className="space-y-4">
      {secondary.map((row) => (
        <SecondaryHeadlineCard key={row.key} row={row} />
      ))}
      <div className="grid gap-6 sm:grid-cols-2">
        {dominant.map((row) => (
          <DominantHeadlineCard key={row.key} row={row} />
        ))}
      </div>
    </div>
  )
}

/** A real, defensible difference. These are the largest numbers on the page. */
function DominantHeadlineCard({ row }: { row: MetricRow }) {
  return (
    <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-100">
      <h3 className="text-sm font-semibold text-slate-900">{row.label}</h3>
      <div className="mt-4 flex items-center gap-5">
        <Side label="Baseline" value={row.baseline} tone="bad" size="lg" />
        <span className="text-2xl text-slate-300" aria-hidden="true">
          →
        </span>
        <Side label="AI-optimised" value={row.optimized} tone="good" size="lg" />
      </div>
      <p className="mt-4 text-xs leading-relaxed text-slate-600">{row.note}</p>
    </section>
  )
}

/** Present, not competing - stays legible without pulling focus from the dominant pair above. */
function SecondaryHeadlineCard({ row }: { row: MetricRow }) {
  return (
    <section className="rounded-xl bg-slate-50 p-4">
      <h3 className="text-xs font-semibold text-slate-700">{row.label}</h3>
      <div className="mt-2 flex items-center gap-3">
        <Side label="Baseline" value={row.baseline} tone="bad" size="sm" />
        <span className="text-sm text-slate-300" aria-hidden="true">
          →
        </span>
        <Side label="AI-optimised" value={row.optimized} tone="good" size="sm" />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">{row.note}</p>
    </section>
  )
}

/**
 * A number that would mislead on its own.
 *
 * Where a row carries `pairedWith`, both metrics render in this one card - that
 * is caveat 3 enforced structurally rather than by remembering to put them near
 * each other.
 */
function SupportingCard({ row }: { row: MetricRow }) {
  const misleading = row.verdict === 'baseline-higher-but-worse'
  const neutral = row.verdict === 'no-difference'
  // T24: a smaller optimizer number that is CORRECT, not a defect - its own
  // tone, distinct from both "reads backwards" (amber, a trap) and
  // "improvement" (emerald, a bigger/better number). Sky keeps it visually
  // neutral-to-positive without claiming either of those.
  const fewerByDesign = row.verdict === 'optimizer-fewer-by-design'

  return (
    <section
      className={`rounded-xl p-5 ${
        misleading
          ? 'bg-amber-50 ring-1 ring-amber-200'
          : fewerByDesign
            ? 'bg-sky-50 ring-1 ring-sky-200'
            : 'bg-white ring-1 ring-slate-100'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{row.label}</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
            misleading
              ? 'bg-amber-200 text-amber-900'
              : neutral
                ? 'bg-slate-200 text-slate-700'
                : fewerByDesign
                  ? 'bg-sky-200 text-sky-900'
                  : 'bg-emerald-100 text-emerald-800'
          }`}
        >
          {misleading
            ? 'reads backwards'
            : neutral
              ? 'no difference'
              : fewerByDesign
                ? 'fewer, by design'
                : 'improvement'}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-4">
        <Side label="Baseline" value={row.baseline} tone={misleading ? 'warn' : 'neutral'} />
        <span className="text-lg text-slate-300" aria-hidden="true">
          {neutral ? '=' : '→'}
        </span>
        <Side label="AI-optimised" value={row.optimized} tone="neutral" />
      </div>

      {/* Same card, deliberately - see the module docstring, caveat 3. */}
      {row.pairedWith && (
        <div className="mt-3 rounded-lg bg-white/70 p-3 ring-1 ring-amber-200 ring-inset">
          <p className="text-[11px] font-semibold tracking-wide text-amber-900 uppercase">
            {row.pairedWith.label}
          </p>
          <div className="mt-1 flex items-center gap-3 text-sm">
            <span className="tabular-nums text-slate-900">
              Baseline <strong>{row.pairedWith.baseline}</strong>
            </span>
            <span className="text-slate-300">→</span>
            <span className="tabular-nums text-slate-900">
              AI <strong>{row.pairedWith.optimized}</strong>
            </span>
          </div>
          <p className="mt-1 text-[11px] text-amber-900">{row.pairedWith.note}</p>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-slate-700">{row.note}</p>
    </section>
  )
}

function Side({
  label,
  value,
  tone,
  size = 'md',
}: {
  label: string
  value: string
  tone: 'good' | 'bad' | 'warn' | 'neutral'
  /** `lg` for the two dominant headline cards, `sm` for secondary ones. Default matches the old fixed size. */
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
      <p className="text-[11px] tracking-wide text-slate-500 uppercase">{label}</p>
      <p className={`${valueSize} leading-tight font-semibold tabular-nums ${colour}`}>{value}</p>
    </div>
  )
}

/** PRD 9.5 type name, so a conflict is named rather than merely counted. */
function ConflictTypeBadge({ label }: { label: string }) {
  return (
    <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-rose-800 uppercase ring-1 ring-rose-200 ring-inset">
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
          className="shrink-0 text-xs font-medium text-sky-700 hover:underline"
        >
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
          <span className="text-[11px] text-slate-500">
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
            <p className="mt-1 text-[11px] text-slate-500">
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
    <section data-tour="comparison-caveats" className="mt-10 border-t border-slate-100 pt-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
      >
        <span aria-hidden="true" className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>
          ›
        </span>
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
                <span className="font-semibold text-slate-400">{index + 1}.</span>
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
