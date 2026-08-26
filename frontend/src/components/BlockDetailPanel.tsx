/**
 * Task/Block Detail Drill-down - PRD Section 8 screen 7, TX5.
 *
 * "Batched tasks, department mix, plain-English reasoning, asset criticality
 * + risk score breakdown, resource assignment, dependency chain if any."
 *
 * Read-only, and deliberately a SEPARATE action from overriding. Before this
 * panel existed, clicking a block only ever started an override
 * (`ControllerDashboard.tsx`'s `onSelectBlock={overridable ? setSelected :
 * undefined}`), which meant a block was entirely unclickable - no way to
 * inspect it at all - the moment a plan was published or the viewer's role
 * had no write access (a DRM, always). Inspecting a possession and amending
 * one are different questions; this panel answers the first regardless of
 * who is looking or what state the plan is in, and hands off to the existing
 * `OverridePanel` only when the second is actually legal.
 *
 * Every field here is assembled from data this project already computes -
 * the block itself, the schedule's own decision log (FR2.4/FR8.1), the task
 * documents, their assets, and the resource catalogue - fetched and joined
 * client-side rather than a new backend endpoint. See `lib/blockDetail.ts`
 * for the pure assembly logic this component only renders.
 */
import { useMemo } from 'react'

import {
  useGetAssetsQuery,
  useGetResourcesQuery,
  type DecisionLogEntry,
  type ScheduleBlock,
  type Task,
} from '../api/apiSlice.ts'
import {
  departmentMix,
  dependencyChain,
  describeReasoning,
  resolveResources,
} from '../lib/blockDetail.ts'
import { FACTOR_LABEL, RISK_FRAMING } from '../lib/priorityFraming.ts'
import { DepartmentPill, SeverityPill } from './Table.tsx'

interface BlockDetailPanelProps {
  block: ScheduleBlock
  tasks: Task[]
  decisionLog: DecisionLogEntry[]
  /** Task ids placed anywhere in the CURRENT (post-override) plan. */
  scheduledTaskIds: Set<string>
  /** Whether this plan's workflow state still allows an override (D-043). */
  overridable: boolean
  onClose: () => void
  /** Hands off to `OverridePanel` for this same block. */
  onOverride: () => void
}

export function BlockDetailPanel({
  block,
  tasks,
  decisionLog,
  scheduledTaskIds,
  overridable,
  onClose,
  onOverride,
}: BlockDetailPanelProps) {
  const assets = useGetAssetsQuery({ limit: 200 })
  const resources = useGetResourcesQuery({ limit: 200 })

  const tasksById = useMemo(() => new Map(tasks.map((t) => [t._id, t])), [tasks])
  const assetsById = useMemo(
    () => new Map((assets.data?.data ?? []).map((a) => [a._id, a])),
    [assets.data],
  )
  const resourcesById = useMemo(
    () =>
      new Map(
        (resources.data?.data ?? []).map((r) => [r._id, { _id: r._id, name: r.name, type: r.type }]),
      ),
    [resources.data],
  )
  const decisionByTaskId = useMemo(
    () => new Map(decisionLog.map((entry) => [entry.taskId, entry])),
    [decisionLog],
  )

  const groups = departmentMix(block)
  const loadingLookups = assets.isLoading || resources.isLoading

  return (
    <section
      data-tour="dashboard-block-detail"
      className="rounded-xl border-2 border-slate-300 bg-white shadow-sm"
    >
      <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            {block.isCrossDepartmentBatch ? 'Shared block detail' : 'Block detail'}
          </h3>
          <p className="text-xs text-slate-500">
            <span className="font-mono">{block.corridorId}</span> · {block.date} · {block.start}–
            {block.end} · {block.usedMinutes}/{block.capacityMinutes} min used
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
        >
          Close
        </button>
      </header>

      <div className="space-y-4 px-5 py-4">
        <div>
          <p className="mb-1.5 text-xs font-medium text-slate-700">
            Department mix{' '}
            <span className="font-normal text-slate-500">
              — {groups.length > 1 ? 'a shared possession' : 'one department, this possession'}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            {groups.map((group) => (
              <span key={group.department} className="flex items-center gap-1.5">
                <DepartmentPill department={group.department} />
                <span className="text-xs text-slate-500">
                  {group.taskIds.length} task{group.taskIds.length > 1 ? 's' : ''}
                </span>
              </span>
            ))}
          </div>
        </div>

        {loadingLookups ? (
          <p className="text-xs text-slate-500">Loading asset and resource records…</p>
        ) : (
          <div className="space-y-3">
            {block.taskIds.map((taskId) => {
              const task = tasksById.get(taskId)
              const asset = task ? assetsById.get(task.assetId) : undefined
              const entry = decisionByTaskId.get(taskId)
              const chain = task
                ? dependencyChain(task, tasksById, scheduledTaskIds)
                : []
              const resolvedResources = task
                ? resolveResources(task.requiredResourceIds, resourcesById)
                : []

              return (
                <div key={taskId} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-slate-800">{taskId}</span>
                    {task && <DepartmentPill department={task.department} />}
                    {task && <SeverityPill severity={task.severity} />}
                    {task && (
                      <span className="text-xs text-slate-600">{task.defectType}</span>
                    )}
                  </div>

                  {!task ? (
                    <p className="mt-1.5 text-xs text-rose-700">
                      This task id is not in the currently loaded backlog.
                    </p>
                  ) : (
                    <>
                      <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                        {describeReasoning(entry)}
                      </p>

                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div className="rounded border border-slate-100 bg-slate-50 px-2.5 py-2">
                          <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">
                            Asset criticality
                          </p>
                          {asset ? (
                            <>
                              <p className="text-sm font-semibold text-slate-900 tabular-nums">
                                {asset.criticalityScore.toFixed(1)}
                              </p>
                              <p className="text-[11px] text-slate-500">
                                {asset.assetType} on {asset.corridorId} · driven by{' '}
                                {asset.dominantCriticalityFactor?.replace(/_/g, ' ') ?? 'n/a'}
                              </p>
                            </>
                          ) : (
                            <p className="text-[11px] text-slate-500">Asset record not loaded.</p>
                          )}
                        </div>

                        <div className="rounded border border-slate-100 bg-slate-50 px-2.5 py-2">
                          <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">
                            Predicted risk
                          </p>
                          {task.failureRiskScore !== null && task.failureRiskScore !== undefined ? (
                            <>
                              <p className="text-sm font-semibold text-slate-900 tabular-nums">
                                {Math.round(task.failureRiskScore)}
                              </p>
                              <p className="text-[11px] text-slate-500" title={RISK_FRAMING}>
                                {RISK_FRAMING}
                              </p>
                            </>
                          ) : (
                            <p className="text-[11px] text-slate-500">
                              Not scored (T16's risk model has not run against this task).
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="mt-2">
                        <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">
                          Resource assignment
                        </p>
                        {resolvedResources.length === 0 ? (
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            No resource required for this task.
                          </p>
                        ) : (
                          <ul className="mt-0.5 flex flex-wrap gap-1.5">
                            {resolvedResources.map((resource) => (
                              <li
                                key={resource._id}
                                className={`rounded px-1.5 py-0.5 text-[11px] ring-1 ring-inset ${
                                  resource.resolved
                                    ? 'bg-slate-100 text-slate-700 ring-slate-500/20'
                                    : 'bg-rose-50 text-rose-700 ring-rose-600/20'
                                }`}
                              >
                                {resource.resolved
                                  ? `${resource.type}: ${resource.name}`
                                  : `unresolved id: ${resource._id}`}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      {chain.length > 0 && (
                        <div className="mt-2">
                          <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">
                            Dependency chain
                          </p>
                          <ol className="mt-0.5 space-y-1">
                            {chain.map((link, index) => (
                              <li
                                key={link.taskId}
                                className="flex items-center gap-1.5 text-[11px] text-slate-600"
                              >
                                <span className="text-slate-400">
                                  {'→'.repeat(index + 1)}
                                </span>
                                <span className="font-mono">{link.taskId}</span>
                                {link.defectType ? (
                                  <span>{link.defectType}</span>
                                ) : (
                                  <span className="rounded bg-rose-50 px-1.5 py-0.5 font-medium text-rose-700 ring-1 ring-rose-600/20 ring-inset">
                                    unresolved id
                                  </span>
                                )}
                                <span
                                  className={`rounded px-1.5 py-0.5 font-medium ring-1 ring-inset ${
                                    link.scheduledInThisPlan
                                      ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                                      : 'bg-amber-50 text-amber-800 ring-amber-600/20'
                                  }`}
                                >
                                  {link.scheduledInThisPlan
                                    ? 'has its own block in this plan'
                                    : 'not scheduled in this plan'}
                                </span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}

                      {task.dominantPriorityFactor && (
                        <p className="mt-2 text-[11px] text-slate-400">
                          Priority driven by{' '}
                          {FACTOR_LABEL[task.dominantPriorityFactor] ?? task.dominantPriorityFactor}.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {overridable && (
        <footer className="border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            onClick={onOverride}
            className="rounded-lg border border-sky-300 px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-50"
          >
            Override this block →
          </button>
        </footer>
      )}
    </section>
  )
}

export default BlockDetailPanel
