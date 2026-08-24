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
import {
  useGetAssetsQuery,
  useGetLatestScheduleQuery,
  useGetScheduleQuery,
  useGetSchedulesQuery,
  useGetTasksQuery,
} from '../api/apiSlice.ts'
import { buildKpiHierarchy, type Kpi, type KpiCategory } from '../lib/oversight.ts'
import QueryState from '../components/QueryState.tsx'
import { PageHeader } from '../components/Table.tsx'

const CATEGORY_NOTE: Record<KpiCategory['category'], string> = {
  Operations: 'Train-network impact of this plan and how much corridor time it actually used.',
  Maintenance: 'The real maintenance backlog this plan is working through.',
  Planning: 'How the plan itself was built, and how much it moves between re-solves.',
  Asset: 'What still needs attention once this plan is committed.',
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  if (!kpi.available) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-3.5 py-3">
        <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{kpi.label}</p>
        <p className="mt-1 text-sm font-semibold text-slate-400">not tracked</p>
        <p className="mt-1 text-[11px] text-slate-500">{kpi.reason}</p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3.5 py-3">
      <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{kpi.label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900 tabular-nums">{kpi.value}</p>
      <p className="mt-1 text-[11px] text-slate-500">{kpi.detail}</p>
    </div>
  )
}

export function DrmOversightPage() {
  const latest = useGetLatestScheduleQuery()
  const versions = useGetSchedulesQuery({ limit: 20 })
  const tasks = useGetTasksQuery({ limit: 200 })
  const assets = useGetAssetsQuery({ limit: 200 })

  const plan = latest.data?.data
  const noScheduleYet = latest.error && (latest.error as { status?: number }).status === 404

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

  return (
    <>
      <PageHeader
        title="DRM oversight"
        subtitle="Every KPI PRD Section 14 names, grouped by category - real where the data supports it, marked unavailable where it does not."
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
                <section key={category} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-sm font-semibold text-slate-900">{category}</h3>
                  <p className="mb-3 text-xs text-slate-500">{CATEGORY_NOTE[category]}</p>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {kpis.map((kpi) => (
                      <KpiCard key={kpi.label} kpi={kpi} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </QueryState>
      )}
    </>
  )
}

export default DrmOversightPage
