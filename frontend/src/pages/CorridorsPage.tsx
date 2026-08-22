/**
 * `/corridors` - the real corridor sections that carry maintenance demand.
 *
 * Defaults to `hasSyntheticDemand=true`, which is the whole point: the network
 * has 10,149 real sections and only ~30 carry generated demand. The filter is
 * an indexed lookup, so the page never pages through the full collection.
 */
import { Link } from 'react-router-dom'
import { useGetCorridorsQuery, useGetTasksQuery } from '../api/apiSlice.ts'
import { PageHeader, TableShell, Td, Th } from '../components/Table.tsx'
import QueryState from '../components/QueryState.tsx'

function band(utilisationPct: number): string {
  if (utilisationPct > 60) return 'saturated'
  if (utilisationPct > 30) return 'busy'
  if (utilisationPct > 10) return 'moderate'
  return 'quiet'
}

export function CorridorsPage() {
  const corridors = useGetCorridorsQuery({ hasSyntheticDemand: true, limit: 100 })
  // One extra request gives the per-corridor task count without an aggregate
  // endpoint; 89 tasks is small enough that counting client-side is cheaper
  // than adding a $lookup the dashboard would only use here.
  const tasks = useGetTasksQuery({ limit: 200 })

  const taskCounts = new Map<string, number>()
  for (const task of tasks.data?.data ?? []) {
    taskCounts.set(task.corridorId, (taskCounts.get(task.corridorId) ?? 0) + 1)
  }

  const rows = corridors.data?.data ?? []

  return (
    <>
      <PageHeader
        title="Corridors"
        subtitle="Real corridor sections derived from published route data. Occupancy and free
          block windows are computed from real timetable arrival/departure times."
        meta={
          <span className="rounded-lg bg-white px-3 py-1.5 text-xs text-slate-600 ring-1 ring-slate-200 ring-inset">
            {rows.length} with demand&nbsp;·&nbsp;10,149 in network
          </span>
        }
      />

      <QueryState
        isLoading={corridors.isLoading}
        error={corridors.error}
        isEmpty={rows.length === 0}
        emptyMessage="No corridors seeded yet. Run npm run seed in /backend."
      >
        <TableShell>
          <thead>
            <tr>
              <Th>Section</Th>
              <Th>Name</Th>
              <Th>Band</Th>
              <Th align="right">Trains/day</Th>
              <Th align="right">Utilisation</Th>
              <Th align="right">Free min</Th>
              <Th align="right">Windows</Th>
              <Th align="right">Tasks</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((corridor) => {
              const summary = corridor.occupancySummary
              return (
                <tr key={corridor._id} className="hover:bg-slate-50">
                  <Td mono>
                    <Link
                      to={`/corridors/${encodeURIComponent(corridor._id)}`}
                      className="font-medium text-sky-700 hover:underline"
                    >
                      {corridor._id}
                    </Link>
                  </Td>
                  <Td>{corridor.name}</Td>
                  <Td>
                    <span className="text-xs text-slate-500">{band(summary.utilisationPct)}</span>
                  </Td>
                  <Td align="right">{summary.trainsObserved}</Td>
                  <Td align="right">{summary.utilisationPct.toFixed(1)}%</Td>
                  <Td align="right">{summary.freeMinutes}</Td>
                  <Td align="right">{summary.blockWindowCount}</Td>
                  <Td align="right">{taskCounts.get(corridor._id) ?? 0}</Td>
                </tr>
              )
            })}
          </tbody>
        </TableShell>
      </QueryState>
    </>
  )
}

export default CorridorsPage
