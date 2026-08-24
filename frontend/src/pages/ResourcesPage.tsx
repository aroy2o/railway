/**
 * `/resources` - crews, machines and permissions (PRD 9.8).
 *
 * The corridor-scope column is the interesting one: resources are shared across
 * a depot's corridors, which is what makes resource conflict a real constraint
 * for the optimizer rather than a formality.
 */
import { Link } from 'react-router-dom'
import { useGetResourcesQuery } from '../api/apiSlice.ts'
import { useAutoTour } from '../lib/useAutoTour.ts'
import { RESOURCES_TOUR_ID, RESOURCES_TOUR_STEPS } from '../tours/referenceTours.ts'
import { DepartmentPill, PageHeader, TableShell, Td, Th } from '../components/Table.tsx'
import QueryState from '../components/QueryState.tsx'
import SyntheticBadge from '../components/SyntheticBadge.tsx'

export function ResourcesPage() {
  const resources = useGetResourcesQuery({ limit: 200 })
  const rows = resources.data?.data ?? []
  useAutoTour(RESOURCES_TOUR_ID, RESOURCES_TOUR_STEPS, !resources.isLoading)

  return (
    <>
      <PageHeader
        title="Resources"
        subtitle="Crews, machines and permissions. Each is scoped to a depot covering several
          corridors, so two tasks on different corridors can contend for the same machine."
        meta={
          <span
            data-tour="resources-count-badge"
            className="rounded-lg bg-white px-3 py-1.5 text-xs text-slate-600 ring-1 ring-slate-200 ring-inset"
          >
            {resources.data?.pagination.total ?? 0} resources
          </span>
        }
      />

      <QueryState
        isLoading={resources.isLoading}
        error={resources.error}
        isEmpty={rows.length === 0}
        emptyMessage="No resources seeded yet."
      >
        <div data-tour="resources-table">
        <TableShell>
          <thead>
            <tr>
              <Th>Resource</Th>
              <Th>Type</Th>
              <Th>Dept</Th>
              <Th>Depot</Th>
              <Th>Corridor scope</Th>
              <Th>Data</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((resource) => (
              <tr key={resource._id} className="hover:bg-slate-50">
                <Td>{resource.name}</Td>
                <Td>
                  <span className="text-xs text-slate-500">{resource.type}</span>
                </Td>
                <Td>
                  <DepartmentPill department={resource.department} />
                </Td>
                <Td mono>{resource.depot}</Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {resource.corridorScope.map((corridorId) => (
                      <Link
                        key={corridorId}
                        to={`/corridors/${encodeURIComponent(corridorId)}`}
                        className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 hover:bg-slate-200"
                      >
                        {corridorId}
                      </Link>
                    ))}
                  </span>
                </Td>
                <Td>
                  <SyntheticBadge synthetic={resource.synthetic} />
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
        </div>
      </QueryState>
    </>
  )
}

export default ResourcesPage
