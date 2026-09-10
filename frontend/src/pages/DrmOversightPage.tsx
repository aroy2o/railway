/**
 * DRM oversight view - PRD Section 14, task T28.
 *
 * "Group dashboard KPIs by category rather than one flat list — this makes
 * the DRM/oversight view much stronger." All 16 of PRD's named KPIs are
 * computed here from real data (`lib/oversight.ts`); a KPI PRD names that
 * this prototype's data model genuinely cannot support (no execution
 * tracking, no runtime asset state) is shown as unavailable with the
 * specific reason, never a plausible-looking invented number.
 */
import { useState } from 'react'

import {
  useGetAssetsQuery,
  useGetLatestScheduleQuery,
  useGetScheduleQuery,
  useGetSchedulesQuery,
  useGetTasksQuery,
} from '../api/apiSlice.ts'
import { buildKpiHierarchy, type Kpi, type KpiCategory } from '../lib/oversight.ts'
import {
  MIN_POINTS_FOR_TREND,
  buildTrendSeries,
  hasEnoughHistory,
  sameHorizonHistory,
} from '../lib/trends.ts'
import { buildKpiReportCsv, reportFileName } from '../lib/exportReport.ts'
import { useAutoTour } from '../lib/useAutoTour.ts'
import { OVERSIGHT_TOUR_ID, OVERSIGHT_TOUR_STEPS } from '../tours/oversightTour.ts'
import QueryState from '../components/QueryState.tsx'
import TrendChart from '../components/TrendChart.tsx'
import { PageHeader } from '../components/Table.tsx'

const CATEGORY_NOTE: Record<KpiCategory['category'], string> = {
  Operations: 'Train-network impact of this plan and how much corridor time it actually used.',
  Maintenance: 'The real maintenance backlog this plan is working through.',
  Planning: 'How the plan itself was built, and how much it moves between re-solves.',
  Asset: 'What still needs attention once this plan is committed.',
}

/** The other KPIs in a category, once expanded — deliberately smaller and
 *  quieter than the headline so the one number a fast health check needs
 *  doesn't compete with the other three. */
function KpiCard({ kpi }: { kpi: Kpi }) {
  if (!kpi.available) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-3 py-2.5">
        <p className="text-[10px] font-medium tracking-wide text-slate-500 uppercase">{kpi.label}</p>
        <p className="mt-0.5 text-sm font-semibold text-slate-400">not tracked</p>
        <p className="mt-0.5 text-[11px] text-slate-500">{kpi.reason}</p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-slate-100 bg-white px-3 py-2.5">
      <p className="text-[10px] font-medium tracking-wide text-slate-500 uppercase">{kpi.label}</p>
      <p className="mt-0.5 text-base font-semibold text-slate-800 tabular-nums">{kpi.value}</p>
      <p className="mt-0.5 text-[11px] text-slate-500">{kpi.detail}</p>
    </div>
  )
}

/** The one number a DRM checks first for this category — full size, visible
 *  whether or not the category is expanded. Picks the first AVAILABLE KPI in
 *  the category's own array (already PRD-priority-ordered per `oversight.ts`),
 *  falling back to the first KPI so a category that is entirely unavailable
 *  still has something to show rather than an empty headline. */
function pickHeadline(kpis: Kpi[]): Kpi {
  return kpis.find((kpi) => kpi.available) ?? kpis[0]!
}

function HeadlineStat({ kpi }: { kpi: Kpi }) {
  return (
    <div className="text-right">
      <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{kpi.label}</p>
      <p
        className={`text-xl font-semibold tabular-nums ${
          kpi.available ? 'text-slate-900' : 'text-slate-400'
        }`}
      >
        {kpi.available ? kpi.value : 'not tracked'}
      </p>
    </div>
  )
}

function CategorySection({
  category,
  kpis,
  note,
}: {
  category: KpiCategory['category']
  kpis: Kpi[]
  note: string
}) {
  // Collapsed by default: a DRM should be able to read all four headline
  // numbers in one screenful before choosing which category to drill into.
  const [expanded, setExpanded] = useState(false)
  const headline = pickHeadline(kpis)
  const rest = kpis.filter((kpi) => kpi !== headline)

  return (
    <section
      data-tour={`oversight-category-${category}`}
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">{category}</h3>
          <p className="mt-0.5 text-xs text-slate-500">{note}</p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <HeadlineStat kpi={headline} />
          <span className="text-xs text-slate-400" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-100 px-5 py-4">
          {/* The headline's own detail text, elided from the collapsed row —
              shown once, here, rather than duplicated in both places. */}
          <p className="mb-3 text-xs text-slate-500">
            {headline.available ? headline.detail : headline.reason}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((kpi) => (
              <KpiCard key={kpi.label} kpi={kpi} />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/** Client-side CSV download - a Blob URL and a synthetic click, no library. */
function downloadCsv(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function DrmOversightPage() {
  const latest = useGetLatestScheduleQuery()
  // TX6: 50, not 20 - the light list `getSchedules` returns (id, metrics,
  // horizonDays, generatedAt - no blocks) is what the trend chart plots, so
  // it needs real history, not just the version picker's short list.
  const versions = useGetSchedulesQuery({ limit: 50 })
  const tasks = useGetTasksQuery({ limit: 200 })
  const assets = useGetAssetsQuery({ limit: 200 })

  const plan = latest.data?.data
  const noScheduleYet = latest.error && (latest.error as { status?: number }).status === 404
  useAutoTour(
    OVERSIGHT_TOUR_ID,
    OVERSIGHT_TOUR_STEPS,
    !latest.isLoading && !tasks.isLoading && !assets.isLoading,
  )

  // The most recent OTHER plan built on the SAME horizon - comparing a
  // weekly plan's placements against a monthly one's would be a meaningless
  // ratio (different day counts, different corridor-day granularity), so
  // schedule stability is only ever measured within one horizon type.
  const previousId = plan
    ? versions.data?.data.find((v) => v._id !== plan._id && v.horizonDays === plan.horizonDays)?._id
    : undefined
  const previous = useGetScheduleQuery(previousId ?? '', { skip: !previousId })

  const categories =
    plan && tasks.data && assets.data
      ? buildKpiHierarchy(
          plan,
          tasks.data.data,
          assets.data.data,
          plan.conflictReport,
          previous.data?.data ?? null,
        )
      : []

  // TX6: the trend is scoped to this plan's own horizon type (D-070's rule -
  // see trends.ts), and refuses to draw a "trend" out of fewer real points
  // than `MIN_POINTS_FOR_TREND` rather than smoothing two dots into a line.
  const horizonHistory = plan ? sameHorizonHistory(versions.data?.data ?? [], plan.horizonDays) : []
  const trendReady = hasEnoughHistory(horizonHistory)
  const trendSeries = trendReady ? buildTrendSeries(horizonHistory) : []

  function onDownloadReport() {
    if (!plan) return
    const csv = buildKpiReportCsv(
      { scheduleId: plan._id, generatedAt: plan.generatedAt, horizon: plan.horizon },
      categories,
      { series: trendSeries, hasEnoughHistory: trendReady },
    )
    downloadCsv(reportFileName(plan._id), csv)
  }

  return (
    <>
      <PageHeader
        title="DRM oversight"
        subtitle="Every KPI PRD Section 14 names, grouped by category - real where the data supports it, marked unavailable where it does not."
        meta={
          plan && (
            <button
              type="button"
              onClick={onDownloadReport}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Download report (CSV)
            </button>
          )
        }
      />

      {noScheduleYet ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
          <h2 className="text-sm font-semibold text-slate-900">No plan generated yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Generate a schedule on the Controller Dashboard first - every KPI here reads from a
            real, committed plan.
          </p>
        </div>
      ) : (
        <QueryState
          isLoading={latest.isLoading || tasks.isLoading || assets.isLoading}
          error={noScheduleYet ? null : latest.error}
        >
          {plan && (
            <div className="space-y-6">
              <p className="text-xs text-slate-500">
                {plan._id} · {plan.horizon} · generated {new Date(plan.generatedAt).toLocaleString()}
              </p>
              {categories.map(({ category, kpis }) => (
                <CategorySection
                  key={category}
                  category={category}
                  kpis={kpis}
                  note={CATEGORY_NOTE[category]}
                />
              ))}

              <section
                data-tour="oversight-trends"
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <h3 className="text-sm font-semibold text-slate-900">Trend history</h3>
                <p className="mb-3 text-xs text-slate-500">
                  Real KPI values across every {plan.horizon}-horizon plan this prototype has
                  generated, oldest first - not literally "monthly": PRD names this "monthly
                  trend charts", but a hackathon prototype's real operating history runs hours to
                  days, never months. Plotting what actually exists, honestly labelled, beats
                  claiming a cadence this data cannot back up.
                </p>
                {trendReady ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {trendSeries.map((series) => (
                      <TrendChart key={series.key} series={series} />
                    ))}
                  </div>
                ) : (
                  <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-3.5 py-3 text-sm text-slate-500">
                    Not enough history yet to show a trend: {horizonHistory.length} real{' '}
                    {plan.horizon}-horizon generation{horizonHistory.length === 1 ? '' : 's'}{' '}
                    recorded, {MIN_POINTS_FOR_TREND} needed. Generate a schedule again later to
                    add another point - this section draws a line only once there is a real
                    direction to show, never from one or two points alone.
                  </p>
                )}
              </section>
            </div>
          )}
        </QueryState>
      )}
    </>
  )
}

export default DrmOversightPage
