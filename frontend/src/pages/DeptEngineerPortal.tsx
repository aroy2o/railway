/**
 * PRD Section 8 screen 2 - Dept Engineer Portal.
 *
 * Three parts, exactly PRD's own list: a request-submission form (FR1.1), a
 * list of this account's own submitted requests and their status, and a
 * read-only view of scheduled blocks once a plan is published.
 *
 * `department` and `raisedByUserId` are never sent by the client - the
 * backend derives both from the JWT (backend/src/routes/tasks.ts), so this
 * form can only ever file into the logged-in engineer's own department.
 *
 * **Assumption, flagged**: PRD says "read-only view of their scheduled
 * blocks" without saying whether that means blocks containing tasks THIS
 * account raised, or the published plan's blocks for their whole department.
 * A freshly-submitted request is very unlikely to already sit in an existing
 * published plan, so "their own tasks only" would read as permanently empty
 * during a demo. This reads it as "their department's blocks in the
 * published plan" - genuinely useful ("when is my crew working"), and still
 * literally read-only.
 */
import { useMemo, useState, type FormEvent } from 'react'

import {
  describeApiError,
  useCreateTaskMutation,
  useGetAssetsQuery,
  useGetCorridorsQuery,
  useGetPublishedScheduleQuery,
  useGetResourcesQuery,
  useGetTasksQuery,
} from '../api/apiSlice.ts'
import type { Department } from '../api/apiSlice.ts'
import { useAppSelector } from '../store/hooks.ts'
import { DepartmentPill, PageHeader, SeverityPill, TableShell, Td, Th } from '../components/Table.tsx'
import QueryState from '../components/QueryState.tsx'

/** Mirrors `data/generators/config.py`'s real defect vocabulary per department. */
const DEFECT_TYPES: Record<Department, string[]> = {
  Engineering: ['rail fracture', 'ballast deficiency', 'joint wear', 'track geometry defect'],
  'S&T': ['relay fault', 'cable fault', 'point failure', 'interlocking snag'],
  TRD: ['OHE snag', 'isolator fault', 'feeder fault', 'insulator damage'],
}

/** Mirrors `data/generators/config.py`'s `BLOCK_DURATION_MINS`, shown as guidance, not enforced. */
const DURATION_HINT: Record<Department, [number, number]> = {
  Engineering: [120, 240],
  'S&T': [60, 120],
  TRD: [90, 180],
}

export function DeptEngineerPortal() {
  const user = useAppSelector((state) => state.auth.user)
  const department = (user?.department ?? 'Engineering') as Department

  const corridors = useGetCorridorsQuery({ hasSyntheticDemand: true, limit: 50 })

  const [corridorId, setCorridorId] = useState('')
  const [assetId, setAssetId] = useState('')
  const [defectType, setDefectType] = useState(DEFECT_TYPES[department][0]!)
  const [severity, setSeverity] = useState(3)
  const [duration, setDuration] = useState(DURATION_HINT[department][0])
  const [resourceIds, setResourceIds] = useState<string[]>([])
  const [dependsOnTaskId, setDependsOnTaskId] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [justSubmitted, setJustSubmitted] = useState<string | null>(null)

  const assets = useGetAssetsQuery(
    { corridorId, department, limit: 20 },
    { skip: !corridorId },
  )
  const resources = useGetResourcesQuery(
    { corridorId, department, limit: 20 },
    { skip: !corridorId },
  )
  const corridorTasks = useGetTasksQuery(
    { corridorId, limit: 50 },
    { skip: !corridorId },
  )

  const myRequests = useGetTasksQuery({ raisedByUserId: user?.id, limit: 100 }, { skip: !user })

  const published = useGetPublishedScheduleQuery()
  const publishedNotFound =
    !!published.error && 'status' in published.error && published.error.status === 404

  const myDepartmentBlocks = useMemo(() => {
    const blocks = published.data?.data.effectivePlan?.blocks ?? published.data?.data.blocks ?? []
    return blocks.filter((block) => block.departments.includes(department))
  }, [published.data, department])

  const [createTask, createState] = useCreateTaskMutation()

  function resetForm() {
    setCorridorId('')
    setAssetId('')
    setDefectType(DEFECT_TYPES[department][0]!)
    setSeverity(3)
    setDuration(DURATION_HINT[department][0])
    setResourceIds([])
    setDependsOnTaskId('')
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitError(null)
    setJustSubmitted(null)
    try {
      const result = await createTask({
        corridorId,
        assetId,
        defectType,
        severity,
        estBlockDurationMins: duration,
        requiredResourceIds: resourceIds,
        dependsOnTaskId: dependsOnTaskId || null,
      }).unwrap()
      setJustSubmitted(result.data._id)
      resetForm()
    } catch (err) {
      setSubmitError(describeApiError(err))
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="My maintenance requests"
        subtitle={`Logged in as ${user?.name ?? 'Dept Engineer'} — ${department} department.`}
      />

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-slate-900">Log a new request (FR1.1)</h2>

        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Corridor</label>
            <select
              required
              value={corridorId}
              onChange={(event) => {
                setCorridorId(event.target.value)
                setAssetId('')
                setResourceIds([])
                setDependsOnTaskId('')
              }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Select a corridor…</option>
              {corridors.data?.data.map((corridor) => (
                <option key={corridor._id} value={corridor._id}>
                  {corridor._id} — {corridor.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Asset</label>
            <select
              required
              disabled={!corridorId}
              value={assetId}
              onChange={(event) => setAssetId(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            >
              <option value="">
                {corridorId ? 'Select an asset…' : 'Pick a corridor first'}
              </option>
              {assets.data?.data.map((asset) => (
                <option key={asset._id} value={asset._id}>
                  {asset._id} ({asset.assetType})
                </option>
              ))}
            </select>
            {corridorId && !assets.isLoading && assets.data?.data.length === 0 && (
              <p className="mt-1 text-xs text-amber-700">
                No {department} assets on this corridor — pick a different one.
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Defect type</label>
            <select
              value={defectType}
              onChange={(event) => setDefectType(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {DEFECT_TYPES[department].map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Severity (1–5)</label>
            <select
              value={severity}
              onChange={(event) => setSeverity(Number(event.target.value))}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Estimated block duration (minutes)
            </label>
            <input
              type="number"
              min={1}
              max={1440}
              required
              value={duration}
              onChange={(event) => setDuration(Number(event.target.value))}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Typical {department} range: {DURATION_HINT[department][0]}–{DURATION_HINT[department][1]} min
            </p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Optional dependency (must complete first)
            </label>
            <select
              disabled={!corridorId}
              value={dependsOnTaskId}
              onChange={(event) => setDependsOnTaskId(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            >
              <option value="">None</option>
              {corridorTasks.data?.data.map((task) => (
                <option key={task._id} value={task._id}>
                  {task._id} — {task.defectType}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Required resources (optional)
            </label>
            <div className="flex flex-wrap gap-2">
              {!corridorId && <span className="text-xs text-slate-400">Pick a corridor first</span>}
              {resources.data?.data.map((resource) => {
                const checked = resourceIds.includes(resource._id)
                return (
                  <label
                    key={resource._id}
                    className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs ${
                      checked
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-300 text-slate-600 hover:border-slate-400'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={() =>
                        setResourceIds((current) =>
                          checked
                            ? current.filter((id) => id !== resource._id)
                            : [...current, resource._id],
                        )
                      }
                    />
                    {resource.name}
                  </label>
                )
              })}
            </div>
          </div>

          <div className="sm:col-span-2">
            {submitError && (
              <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-rose-600/20 ring-inset">
                {submitError}
              </p>
            )}
            {justSubmitted && (
              <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 ring-1 ring-emerald-600/20 ring-inset">
                Submitted as {justSubmitted}. It will be picked up the next time a schedule is generated.
              </p>
            )}
            <button
              type="submit"
              disabled={createState.isLoading || !corridorId || !assetId}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
            >
              {createState.isLoading ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">My submitted requests</h2>
        <QueryState
          isLoading={myRequests.isLoading}
          error={myRequests.error}
          isEmpty={(myRequests.data?.data.length ?? 0) === 0}
          emptyMessage="You haven't submitted any requests yet."
        >
          <TableShell>
            <thead>
              <tr>
                <Th>Task</Th>
                <Th>Corridor</Th>
                <Th>Defect type</Th>
                <Th>Sev</Th>
                <Th>Raised</Th>
                <Th>SLA due</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {myRequests.data?.data.map((task) => (
                <tr key={task._id} className="hover:bg-slate-50">
                  <Td mono>{task._id}</Td>
                  <Td mono>{task.corridorId}</Td>
                  <Td>{task.defectType}</Td>
                  <Td>
                    <SeverityPill severity={task.severity} />
                  </Td>
                  <Td mono>{task.dateRaised}</Td>
                  <Td mono>{task.slaDueDate}</Td>
                  <Td>
                    <span className="text-xs text-slate-500">{task.status}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </QueryState>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">
          Published plan — {department} blocks
        </h2>
        <p className="mb-3 text-xs text-slate-500">Read-only. Ask your Controller for changes.</p>
        {publishedNotFound ? (
          <p className="px-1 text-sm text-slate-500">No plan has been published yet.</p>
        ) : (
          <QueryState
            isLoading={published.isLoading}
            error={publishedNotFound ? null : published.error}
            isEmpty={myDepartmentBlocks.length === 0}
            emptyMessage={`No ${department} blocks in the currently published plan.`}
          >
            <TableShell>
              <thead>
                <tr>
                  <Th>Corridor</Th>
                  <Th>Date</Th>
                  <Th>Window</Th>
                  <Th>Departments</Th>
                  <Th>Tasks</Th>
                </tr>
              </thead>
              <tbody>
                {myDepartmentBlocks.map((block) => (
                  <tr key={`${block.corridorId}-${block.date}-${block.windowIndex}`} className="hover:bg-slate-50">
                    <Td mono>{block.corridorId}</Td>
                    <Td mono>{block.date}</Td>
                    <Td mono>
                      {block.start}–{block.end}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {block.departments.map((dept) => (
                          <DepartmentPill key={dept} department={dept} />
                        ))}
                      </div>
                    </Td>
                    <Td mono>{block.taskIds.join(', ')}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </QueryState>
        )}
      </section>
    </div>
  )
}

export default DeptEngineerPortal
