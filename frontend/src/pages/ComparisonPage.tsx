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
            impossible={comparison.structurallyImpossibleCount}
          />

          {(() => {
            const rows = buildMetricRows(comparison)
            return (
              <>
                <h2 className="mt-8 mb-1 text-sm font-semibold text-slate-900">
                  What coordination actually changes
                </h2>
                <p className="mb-3 max-w-3xl text-xs text-slate-500">
                  The optimizer's advantage is that its plan can be executed — not that it
                  schedules more work.
                </p>
                <div data-tour="comparison-headline" className="grid gap-4 lg:grid-cols-2">
                  {headlineRows(rows).map((row) => (
                    <HeadlineCard key={row.key} row={row} />
                  ))}
                </div>

                <h2 className="mt-8 mb-3 text-sm font-semibold text-slate-900">
                  Numbers that need their context
                </h2>
                <div data-tour="comparison-supporting" className="grid gap-4 lg:grid-cols-2">
                  {supportingRows(rows).map((row) => (
                    <SupportingCard key={row.key} row={row} />
                  ))}
                </div>
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

          <p className="mt-6 text-xs text-slate-500">
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
 * Caveat 1 as layout: 53 of 89 tasks fit no window on their corridor and are
 * impossible for either engine. Every number below excludes them, and saying so
 * first is what stops the comparison being read as covering the whole backlog.
 */
function ScopeBand({ contestable, impossible }: { contestable: number; impossible: number }) {
  const total = contestable + impossible
  return (
    <div data-tour="comparison-scope-band" className="rounded-xl border border-slate-300 bg-slate-100 px-5 py-4">
      <h2 className="text-sm font-semibold text-slate-900">What this comparison covers</h2>
      <p className="mt-1 max-w-4xl text-sm text-slate-700">
        Of {total} pending tasks, <strong>{impossible} fit no window on their corridor</strong> and
        are impossible for <em>both</em> engines — traffic leaves no gap long enough, so that work
        needs a traffic block that displaces trains. Every figure below is drawn from the{' '}
        <strong>{contestable} contestable tasks</strong> that either engine could actually place.
      </p>
      <div className="mt-3 flex overflow-hidden rounded-md text-[11px] font-medium">
        <div
          className="bg-slate-900 px-2 py-1 text-center text-white"
          style={{ width: `${(contestable / total) * 100}%` }}
        >
          {contestable} contestable
        </div>
        <div
          className="bg-slate-300 px-2 py-1 text-center text-slate-700"
          style={{ width: `${(impossible / total) * 100}%` }}
        >
          {impossible} impossible for either engine
        </div>
      </div>
    </div>
  )
}

/** A real, defensible difference. These are the largest numbers on the page. */
function HeadlineCard({ row }: { row: MetricRow }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-900">{row.label}</h3>
      <div className="mt-3 flex items-center gap-4">
        <Side label="Baseline" value={row.baseline} tone="bad" />
        <span className="text-xl text-slate-300" aria-hidden="true">
          →
        </span>
        <Side label="AI-optimised" value={row.optimized} tone="good" />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-600">{row.note}</p>
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
      className={`rounded-xl border p-5 shadow-sm ${
        misleading
          ? 'border-amber-300 bg-amber-50'
          : fewerByDesign
            ? 'border-sky-300 bg-sky-50'
            : 'border-slate-200 bg-white'
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
}: {
  label: string
  value: string
  tone: 'good' | 'bad' | 'warn' | 'neutral'
}) {
  const colour =
    tone === 'good'
      ? 'text-emerald-700'
      : tone === 'bad'
        ? 'text-rose-700'
        : tone === 'warn'
          ? 'text-amber-800'
          : 'text-slate-900'
  return (
    <div>
      <p className="text-[11px] tracking-wide text-slate-500 uppercase">{label}</p>
      <p className={`text-3xl leading-tight font-semibold tabular-nums ${colour}`}>{value}</p>
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
  if (doubleBookings.length === 0 && overSubscribed.length === 0) return null

  // Every group here is on the `baseline` layer by construction - these are the
  // naive process's conflicts, never this system's plan's (D-045).
  const byType = new Map(
    groupConflicts(conflictReport, 'baseline').map((group) => [group.type, group]),
  )
  const doubleBookingType = byType.get('CORRIDOR_DOUBLE_BOOKING')
  const overSubscriptionType = byType.get('WINDOW_OVER_SUBSCRIPTION')

  return (
    <section data-tour="comparison-conflict-evidence" className="mt-8">
      <h2 className="mb-1 text-sm font-semibold text-slate-900">The conflicts themselves</h2>
      <p className="mb-3 max-w-3xl text-xs text-slate-500">{note}</p>

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
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
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
  return (
    <section data-tour="comparison-caveats" className="mt-8 rounded-xl border border-slate-300 bg-slate-100 px-5 py-4">
      <h2 className="text-sm font-semibold text-slate-900">How to read this comparison</h2>
      <p className="mb-2 text-xs text-slate-500">
        Stored with the comparison by the system that computed it, not written by this page.
      </p>
      <ol className="space-y-1.5">
        {caveats.map((caveat, index) => (
          <li key={caveat} className="flex gap-2 text-xs leading-relaxed text-slate-700">
            <span className="font-semibold text-slate-400">{index + 1}.</span>
            <span>{caveat}</span>
          </li>
        ))}
      </ol>
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
