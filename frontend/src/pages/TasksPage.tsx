/**
 * `/tasks` - the synthetic maintenance backlog.
 *
 * Ordered by severity then SLA date. That is NOT the FR2.3 priority ranking -
 * `priorityScore` is null until the priority engine (T7) exists, and the column
 * says so rather than showing a zero that would read as "lowest priority".
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Department } from '../api/apiSlice.ts'
import { useGetTasksQuery } from '../api/apiSlice.ts'
import { useAutoTour } from '../lib/useAutoTour.ts'
import { TASKS_TOUR_ID, TASKS_TOUR_STEPS } from '../tours/referenceTours.ts'
import { DepartmentPill, PageHeader, SeverityPill, TableShell, Td, Th } from '../components/Table.tsx'
import QueryState from '../components/QueryState.tsx'
import SyntheticBadge from '../components/SyntheticBadge.tsx'

const DEPARTMENTS: Array<Department | 'All'> = ['All', 'Engineering', 'S&T', 'TRD']

export function TasksPage() {
  const [department, setDepartment] = useState<Department | 'All'>('All')
  const tasks = useGetTasksQuery({
    limit: 200,
    department: department === 'All' ? undefined : department,
  })
  const rows = tasks.data?.data ?? []
  useAutoTour(TASKS_TOUR_ID, TASKS_TOUR_STEPS, !tasks.isLoading)

  return (
    <>
      <PageHeader
        title="Maintenance backlog"
        subtitle="Pending defect and maintenance tasks awaiting a block allocation."
        meta={
          <div
            data-tour="tasks-department-filter"
            className="flex gap-1 rounded-lg bg-white p-1 ring-1 ring-slate-200 ring-inset"
          >
            {DEPARTMENTS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setDepartment(option)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                  department === option
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        }
      />

      <QueryState
        isLoading={tasks.isLoading}
        error={tasks.error}
        isEmpty={rows.length === 0}
        emptyMessage="No tasks match this filter."
      >
        <p className="mb-2 text-xs text-slate-500">
          Showing {rows.length} of {tasks.data?.pagination.total ?? 0}. Priority score is empty
          until the priority engine (T7) computes it — empty means unscored, not zero.
        </p>
        <div data-tour="tasks-table">
        <TableShell>
          <thead>
            <tr>
              <Th>Task</Th>
              <Th>Corridor</Th>
              <Th>Dept</Th>
              <Th>Defect type</Th>
              <Th>Sev</Th>
              <Th align="right">Duration</Th>
              <Th>Raised</Th>
              <Th>SLA due</Th>
              <Th>Status</Th>
              <Th align="right">Priority</Th>
              <Th>Data</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((task) => (
              <tr key={task._id} className="hover:bg-slate-50">
                <Td mono>{task._id}</Td>
                <Td mono>
                  <Link
                    to={`/corridors/${encodeURIComponent(task.corridorId)}`}
                    className="text-sky-700 hover:underline"
                  >
                    {task.corridorId}
                  </Link>
                </Td>
                <Td>
                  <DepartmentPill department={task.department} />
                </Td>
                <Td>{task.defectType}</Td>
                <Td>
                  <SeverityPill severity={task.severity} />
                </Td>
                <Td align="right">{task.estBlockDurationMins}m</Td>
                <Td mono>{task.dateRaised}</Td>
                <Td mono>{task.slaDueDate}</Td>
                <Td>
                  <span className="text-xs text-slate-500">{task.status}</span>
                </Td>
                <Td align="right">
                  {task.priorityScore ?? <span className="text-slate-300">unscored</span>}
                </Td>
                <Td>
                  <SyntheticBadge synthetic={task.synthetic} />
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

export default TasksPage
