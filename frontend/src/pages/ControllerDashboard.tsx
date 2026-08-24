/**
 * Controller Dashboard - PRD Section 8, the primary decision-maker's screen.
 *
 * Reads the most recently generated plan and lets the Controller regenerate it.
 * Everything on this page comes from one schedule document produced by the
 * solver; nothing is computed in the browser.
 *
 * Deliberately NOT here yet, each because it belongs to a later task rather
 * than because it was forgotten:
 *   Baseline-vs-AI comparison  T14  (comparisonToBaseline is in the response
 *                                    already, left untouched - D-031 shows how
 *                                    easily that screen misleads)
 *   Manual override            T15
 *   Ask the Planner            T18
 *   What-if simulation         T20
 *   Policy sliders             T23  (policyWeights stays null; no faked control)
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'

import {
  useGenerateScheduleMutation,
  useGetLatestScheduleQuery,
  useGetTasksQuery,
} from '../api/apiSlice.ts'
import { describeApiError } from '../api/apiSlice.ts'
import type { ScheduleBlock } from '../api/apiSlice.ts'
import DeferredTasksPanel from '../components/DeferredTasksPanel.tsx'
import GanttTimeline from '../components/GanttTimeline.tsx'
import OverrideHistory from '../components/OverrideHistory.tsx'
import WorkflowPanel from '../components/WorkflowPanel.tsx'
import WhatIfPanel from '../components/WhatIfPanel.tsx'
import EmergencyPanel from '../components/EmergencyPanel.tsx'
import PolicySliders from '../components/PolicySliders.tsx'
import { OVERRIDABLE_STATES } from '../lib/approval.ts'
import OverridePanel from '../components/OverridePanel.tsx'
import AskThePlanner from '../components/AskThePlanner.tsx'
import KnownLimitations from '../components/KnownLimitations.tsx'
import WeatherRiskPanel from '../components/WeatherRiskPanel.tsx'
import KpiStrip from '../components/KpiStrip.tsx'
import PriorityQueue from '../components/PriorityQueue.tsx'
import QueryState from '../components/QueryState.tsx'
import { blockKey } from '../lib/gantt.ts'
import { PageHeader } from '../components/Table.tsx'

/** The dataset's reference week, so a demo run is reproducible. */
const DEFAULT_HORIZON_START = '2026-08-24'

export function ControllerDashboard() {
  const schedule = useGetLatestScheduleQuery()
  const tasks = useGetTasksQuery({ limit: 200 })
  const [generate, generation] = useGenerateScheduleMutation()
  const [selected, setSelected] = useState<ScheduleBlock | null>(null)
  // T20: independent of the override selection above - a what-if works on a
  // deferred task too, which has no block on the Gantt to select at all.
  const [whatIfTaskId, setWhatIfTaskId] = useState<string | null>(null)
  // T27: independent of both selections above - an emergency picks its own
  // corridor and window rather than reusing the Gantt's click-to-select.
  const [emergencyOpen, setEmergencyOpen] = useState(false)
  // T28: tracked so a policy-slider regenerate stays on whatever horizon is
  // currently being viewed, rather than silently reverting to weekly.
  const [horizonDays, setHorizonDays] = useState<7 | 30>(7)

  const plan = schedule.data?.data
  // `blocks` is the solver's plan and what `decisionLog` explains; the
  // effective plan is that with manual overrides replayed on top (D-043).
  // The Controller is looking at the latter.
  const visibleBlocks = plan?.effectivePlan?.blocks ?? plan?.blocks ?? []
  // FR6.1: a published plan is frozen and a rejected one is discarded. Read
  // from the same set the server enforces, rather than restating the rule here.
  const overridable = OVERRIDABLE_STATES.has(plan?.workflowState ?? 'draft')
  // A 404 means "none generated yet", which is an empty state rather than an
  // error - the difference matters on first run.
  const noScheduleYet =
    schedule.error && (schedule.error as { status?: number }).status === 404

  async function onGenerate(
    policyWeights?: import('../lib/policyWeights.ts').PolicyWeightsInput,
    requestedHorizonDays?: 7 | 30,
  ) {
    const days = requestedHorizonDays ?? horizonDays
    try {
      await generate({
        horizonStart: DEFAULT_HORIZON_START,
        horizonDays: days,
        ...(policyWeights && Object.keys(policyWeights).length > 0 ? { policyWeights } : {}),
      }).unwrap()
      setHorizonDays(days)
    } catch {
      // Surfaced in the banner below; unwrap() would otherwise reject unhandled.
    }
  }

  return (
    <>
      <PageHeader
        title="Controller dashboard"
        subtitle="Generated block plan for the coming week, with the reasoning behind it."
        meta={
          <div className="flex items-center gap-3">
            {plan && (
              <span className="text-xs text-slate-500">
                {plan._id} · {new Date(plan.generatedAt).toLocaleString()}
              </span>
            )}
            {plan && visibleBlocks.length > 0 && (
              <button
                type="button"
                onClick={() => setEmergencyOpen((open) => !open)}
                className="rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50"
              >
                ⚠ Simulate emergency
              </button>
            )}
            <button
              type="button"
              onClick={() => onGenerate()}
              disabled={generation.isLoading}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {generation.isLoading ? 'Solving…' : 'Generate schedule'}
            </button>
          </div>
        }
      />

      {/* A CP-SAT run takes a second or two. Saying so beats looking frozen. */}
      {generation.isLoading && (
        <div className="mb-5 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          Running the constraint solver over the pending backlog. This usually takes a couple of
          seconds.
        </div>
      )}

      {/* D-037 made this message actionable - render it rather than a generic
          failure state, because "Could not reach the optimizer service" tells
          the operator exactly what to do. */}
      {generation.isError && (
        <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
          <p className="text-sm font-medium text-rose-900">Could not generate a schedule</p>
          <p className="mt-0.5 text-sm text-rose-700">{describeApiError(generation.error)}</p>
        </div>
      )}

      {noScheduleYet ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
          <h2 className="text-sm font-semibold text-slate-900">No plan generated yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Generate a schedule to allocate the pending maintenance backlog into the free windows
            the timetable leaves on each corridor.
          </p>
        </div>
      ) : (
        <QueryState isLoading={schedule.isLoading} error={noScheduleYet ? null : schedule.error}>
          {plan && (
            <div className="space-y-6">
              <KpiStrip
                metrics={plan.metrics}
                solveSeconds={plan.solveSeconds}
                status={plan.status}
              />

              {/* The comparison is computed in the same run as this plan, so a
                  Controller reviewing one will want the other close by. */}
              {plan.comparisonToBaseline && (
                <Link
                  to="/comparison"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-300 bg-slate-100 px-5 py-3 transition hover:border-slate-400"
                >
                  <span className="text-sm text-slate-700">
                    The same backlog run through the current departmental process double-books{' '}
                    <strong className="text-rose-700">
                      {plan.comparisonToBaseline.baseline.doubleBookings} corridors
                    </strong>{' '}
                    and shares{' '}
                    <strong>{plan.comparisonToBaseline.baseline.crossDepartmentBatches}</strong>{' '}
                    blocks across departments.
                  </span>
                  <span className="text-sm font-medium text-sky-700">Baseline vs AI →</span>
                </Link>
              )}

              <div className="grid gap-6 xl:grid-cols-4">
                <div className="space-y-6 xl:col-span-3">
                  <GanttTimeline
                    blocks={visibleBlocks}
                    horizonStart={plan.horizonStart}
                    horizonDays={plan.horizonDays}
                    horizon={plan.horizon}
                    // Withheld once the workflow closes the plan: a published
                    // plan is frozen and a rejected one is discarded, so the
                    // server would refuse the override this click starts.
                    onSelectBlock={overridable ? setSelected : undefined}
                    selectedBlockKey={selected ? blockKey(selected) : null}
                    onSelectHorizon={(days) => onGenerate(undefined, days)}
                    isGeneratingHorizon={generation.isLoading}
                  />

                  {overridable && selected && (
                    <OverridePanel
                      scheduleId={plan._id}
                      // Re-read from the current plan so the panel never acts on
                      // a placement a previous override has already changed.
                      block={
                        visibleBlocks.find((b) => blockKey(b) === blockKey(selected)) ?? selected
                      }
                      onClose={() => setSelected(null)}
                    />
                  )}

                  {/* Sits under the timeline, in the wide column: a Controller
                      asks about the plan they are looking at, and the grounding
                      list needs room to be readable rather than truncated. */}
                  {whatIfTaskId && (
                    <WhatIfPanel
                      scheduleId={plan._id}
                      taskId={whatIfTaskId}
                      onClose={() => setWhatIfTaskId(null)}
                    />
                  )}

                  {emergencyOpen && (
                    <EmergencyPanel
                      scheduleId={plan._id}
                      blocks={visibleBlocks}
                      onClose={() => setEmergencyOpen(false)}
                    />
                  )}

                  <AskThePlanner scheduleId={plan._id} />

                  <DeferredTasksPanel deferred={plan.deferredTasks} />
                </div>

                <div className="space-y-6">
                  {/* First in the sidebar: whether this plan has been issued
                      changes how everything below it should be read. */}
                  <WorkflowPanel
                    scheduleId={plan._id}
                    state={plan.workflowState ?? 'draft'}
                    allowedActions={plan.allowedActions ?? []}
                    version={null}
                  />
                  <PolicySliders onRegenerate={onGenerate} isLoading={generation.isLoading} />
                  <PriorityQueue
                    tasks={tasks.data?.data ?? []}
                    schedule={plan}
                    onWhatIf={setWhatIfTaskId}
                  />
                  <OverrideHistory overrides={plan.overrides ?? []} />
                  <WeatherRiskPanel weatherRisk={plan.knownGaps?.weatherRisk} />
                  <KnownLimitations
                    knownGaps={plan.knownGaps}
                    conflictReport={plan.conflictReport}
                    generationErrors={plan.generationErrors}
                  />
                </div>
              </div>
            </div>
          )}
        </QueryState>
      )}
    </>
  )
}

export default ControllerDashboard
