/**
 * `/corridors/:id` - one section: real infrastructure facts, real occupancy,
 * and the synthetic assets and tasks generated against it.
 *
 * `maxDailyBlockWindows` shown here is joined from `corridor_calendar` by the
 * API (docs/DECISIONS.md D-016), not stored on the corridor document.
 */
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  useGetAssetsQuery,
  useGetCorridorQuery,
  useGetResourcesQuery,
  useGetTasksQuery,
} from '../api/apiSlice.ts'
import { DepartmentPill, PageHeader, SeverityPill, TableShell, Td, Th } from '../components/Table.tsx'
import QueryState from '../components/QueryState.tsx'
import SyntheticBadge from '../components/SyntheticBadge.tsx'

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <p className="text-[11px] tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-slate-900 tabular-nums">{value}</p>
      {note && <p className="text-[11px] text-slate-400">{note}</p>}
    </div>
  )
}

type DetailTab = 'assets' | 'backlog' | 'resources'

function DetailTabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
        active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {label}
      {count != null && (
        <span className={active ? 'ml-1.5 text-slate-300' : 'ml-1.5 text-slate-400'}>{count}</span>
      )}
    </button>
  )
}

export function CorridorDetailPage() {
  const { id = '' } = useParams()
  const corridor = useGetCorridorQuery(id, { skip: !id })
  const assets = useGetAssetsQuery({ corridorId: id }, { skip: !id })
  const tasks = useGetTasksQuery({ corridorId: id }, { skip: !id })
  const resources = useGetResourcesQuery({ corridorId: id }, { skip: !id })

  const data = corridor.data?.data

  // Decluttering pass: the 4 stat cards + block windows above stay the
  // dominant top section; these 3 were always-expanded full tables stacked
  // underneath. One at a time, on demand, is enough - nothing here is cut.
  const [tab, setTab] = useState<DetailTab>('assets')

  return (
    <>
      <Link to="/corridors" className="mb-3 inline-block text-sm text-sky-700 hover:underline">
        ← All corridors
      </Link>

      <QueryState isLoading={corridor.isLoading} error={corridor.error} isEmpty={!data}>
        {data && (
          <>
            <PageHeader
              title={data.name}
              subtitle={`${data.stationA.name} (${data.stationA.code}) → ${data.stationB.name} (${data.stationB.code})`}
              meta={<SyntheticBadge synthetic={false} />}
            />

            <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Trains / day"
                value={String(data.occupancy?.trainsObserved ?? 0)}
                note="observed in real timetable"
              />
              <Stat
                label="Utilisation"
                value={`${(data.occupancy?.utilisationPct ?? 0).toFixed(1)}%`}
                note={`${data.occupancy?.occupiedMinutes ?? 0} min occupied`}
              />
              <Stat
                label="Free minutes"
                value={String(data.occupancy?.freeMinutes ?? 0)}
                note="complement of occupancy"
              />
              <Stat
                label="Section length"
                value={
                  data.publishedDistanceKm != null
                    ? `${data.publishedDistanceKm} km`
                    : data.straightLineKm != null
                      ? `~${data.straightLineKm.toFixed(1)} km`
                      : '—'
                }
                note={data.publishedDistanceKm != null ? 'published' : 'straight-line estimate'}
              />
            </div>

            <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-900">
                Available block windows{' '}
                <span className="font-normal text-slate-500">(maxDailyBlockWindows)</span>
              </h3>
              <p className="mb-3 text-xs text-slate-500">
                Free time left after scheduled traffic, with a clearance margin. This is what the
                CP-SAT solver places maintenance into.
              </p>
              {data.maxDailyBlockWindows.length === 0 ? (
                <p className="text-sm text-rose-700">
                  No usable window — this section is fully occupied all day.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {data.maxDailyBlockWindows.map((window) => (
                    <span
                      key={`${window.startMin}-${window.endMin}`}
                      className="rounded-lg bg-emerald-50 px-2.5 py-1 font-mono text-xs text-emerald-800 ring-1 ring-emerald-600/20 ring-inset"
                    >
                      {window.start}–{window.end} ({window.durationMin}m)
                    </span>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
              <div
                role="tablist"
                aria-label="Corridor detail"
                className="flex items-center gap-1 border-b border-slate-100 p-2"
              >
                <DetailTabButton
                  active={tab === 'assets'}
                  onClick={() => setTab('assets')}
                  label="Assets"
                  count={assets.data?.pagination.total}
                />
                <DetailTabButton
                  active={tab === 'backlog'}
                  onClick={() => setTab('backlog')}
                  label="Backlog"
                  count={tasks.data?.pagination.total}
                />
                <DetailTabButton
                  active={tab === 'resources'}
                  onClick={() => setTab('resources')}
                  label="Resources"
                  count={resources.data?.pagination.total}
                />
              </div>

              <div className="p-5">
                {tab === 'assets' && (
                  <QueryState
                    isLoading={assets.isLoading}
                    error={assets.error}
                    isEmpty={(assets.data?.data.length ?? 0) === 0}
                    emptyMessage="No assets on this corridor."
                  >
                    <TableShell>
                      <thead>
                        <tr>
                          <Th>Asset</Th>
                          <Th>Type</Th>
                          <Th>Dept</Th>
                          <Th align="right">Criticality</Th>
                          <Th>Dominant factor</Th>
                          <Th align="right">Trains affected</Th>
                          <Th>Data</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {(assets.data?.data ?? []).map((asset) => (
                          <tr key={asset._id} className="hover:bg-slate-50">
                            <Td mono>{asset._id}</Td>
                            <Td>{asset.assetType}</Td>
                            <Td>
                              <DepartmentPill department={asset.department} />
                            </Td>
                            <Td align="right">{asset.criticalityScore.toFixed(2)}</Td>
                            <Td>
                              <span className="text-xs text-slate-500">
                                {asset.dominantCriticalityFactor?.replace(/_/g, ' ')}
                              </span>
                            </Td>
                            <Td align="right">
                              {asset.criticality.trainsAffectedCount}{' '}
                              <SyntheticBadge synthetic realNote="Real — trains observed in the timetable (T3)" />
                            </Td>
                            <Td>
                              <SyntheticBadge synthetic={asset.synthetic} />
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </TableShell>
                  </QueryState>
                )}

                {tab === 'backlog' && (
                  <QueryState
                    isLoading={tasks.isLoading}
                    error={tasks.error}
                    isEmpty={(tasks.data?.data.length ?? 0) === 0}
                    emptyMessage="No pending tasks on this corridor."
                  >
                    <TableShell>
                      <thead>
                        <tr>
                          <Th>Task</Th>
                          <Th>Dept</Th>
                          <Th>Defect</Th>
                          <Th>Sev</Th>
                          <Th align="right">Duration</Th>
                          <Th>SLA due</Th>
                          <Th>Depends on</Th>
                          <Th>Data</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {(tasks.data?.data ?? []).map((task) => (
                          <tr key={task._id} className="hover:bg-slate-50">
                            <Td mono>{task._id}</Td>
                            <Td>
                              <DepartmentPill department={task.department} />
                            </Td>
                            <Td>{task.defectType}</Td>
                            <Td>
                              <SeverityPill severity={task.severity} />
                            </Td>
                            <Td align="right">{task.estBlockDurationMins}m</Td>
                            <Td mono>{task.slaDueDate}</Td>
                            <Td mono>{task.dependsOnTaskId ?? '—'}</Td>
                            <Td>
                              <SyntheticBadge synthetic={task.synthetic} />
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </TableShell>
                  </QueryState>
                )}

                {tab === 'resources' && (
                  <>
                    <p className="mb-3 text-xs text-slate-500">
                      Depot-scoped, so the same machine can be contended for by tasks on other
                      corridors.
                    </p>
                    {(resources.data?.data.length ?? 0) === 0 ? (
                      <p className="text-sm text-slate-500">No resources scoped to this corridor.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {(resources.data?.data ?? []).map((resource) => (
                          <span
                            key={resource._id}
                            className="rounded-lg bg-white px-2.5 py-1 text-xs text-slate-700 ring-1 ring-slate-200 ring-inset"
                          >
                            {resource.name}{' '}
                            <span className="text-slate-400">· {resource.type}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>
          </>
        )}
      </QueryState>
    </>
  )
}

export default CorridorDetailPage
