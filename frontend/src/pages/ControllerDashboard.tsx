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
import { useAppSelector } from '../store/hooks.ts'
import { useAutoTour } from '../lib/useAutoTour.ts'
import { DASHBOARD_TOUR_ID, DASHBOARD_TOUR_STEPS } from '../tours/dashboardTour.ts'
import DeferredTasksPanel from '../components/DeferredTasksPanel.tsx'
import GanttTimeline from '../components/GanttTimeline.tsx'
import OverrideHistory from '../components/OverrideHistory.tsx'
import WorkflowPanel from '../components/WorkflowPanel.tsx'
import WhatIfPanel from '../components/WhatIfPanel.tsx'
import EmergencyPanel from '../components/EmergencyPanel.tsx'
import PolicySliders from '../components/PolicySliders.tsx'
import { OVERRIDABLE_STATES } from '../lib/approval.ts'
import OverridePanel from '../components/OverridePanel.tsx'
import BlockDetailPanel from '../components/BlockDetailPanel.tsx'
import AskThePlanner from '../components/AskThePlanner.tsx'
import KnownLimitations from '../components/KnownLimitations.tsx'
import WeatherRiskPanel from '../components/WeatherRiskPanel.tsx'
import KpiStrip from '../components/KpiStrip.tsx'
import PriorityQueue from '../components/PriorityQueue.tsx'
import QueryState from '../components/QueryState.tsx'
import { blockKey } from '../lib/gantt.ts'
import { PageHeader } from '../components/Table.tsx'

/**
 * Sidebar panels grouped by purpose rather than build order (session:
 * "Dashboard sidebar restructure") - things a Controller actively does, the
 * ranked backlog, and read-only context/flags, so six unrelated panel types
 * don't all carry equal visual weight in one stacked column.
 */
type SidebarTab = 'actions' | 'priorities' | 'context'

const SIDEBAR_TABS: { id: SidebarTab; label: string }[] = [
  { id: 'actions', label: 'Plan actions' },
  { id: 'priorities', label: 'Priorities' },
  { id: 'context', label: 'Context & flags' },
]

/**
 * Keeps `dashboardTour.ts`'s per-panel steps working now that panels are
 * tabbed: maps a step id to the tab that contains its target element, so the
 * dashboard can switch tabs to match as the tour advances. Steps not listed
 * here don't target a sidebar panel and never move the tab.
 */
const TAB_FOR_TOUR_STEP: Partial<Record<string, SidebarTab>> = {
  'priority-queue': 'priorities',
  'policy-sliders': 'actions',
  'weather-risk': 'context',
  'known-limitations': 'context',
}

export function ControllerDashboard() {
  const schedule = useGetLatestScheduleQuery()
  const tasks = useGetTasksQuery({ limit: 200 })
  const [generate, generation] = useGenerateScheduleMutation()
  // TX5: the block currently being INSPECTED (Task/Block Detail Drill-down).
  // Renamed in spirit from a pure "override selection" now that clicking a
  // block always opens the read-only drill-down first - `overriding` below
  // is what decides whether that same block is also showing the write flow.
  const [selected, setSelected] = useState<ScheduleBlock | null>(null)
  const [overriding, setOverriding] = useState(false)
  // T20: independent of the override selection above - a what-if works on a
  // deferred task too, which has no block on the Gantt to select at all.
  const [whatIfTaskId, setWhatIfTaskId] = useState<string | null>(null)
  // T27: independent of both selections above - an emergency picks its own
  // corridor and window rather than reusing the Gantt's click-to-select.
  const [emergencyOpen, setEmergencyOpen] = useState(false)
  // T28: tracked so a policy-slider regenerate stays on whatever horizon is
  // currently being viewed, rather than silently reverting to weekly.
  const [horizonDays, setHorizonDays] = useState<7 | 30>(7)
  // Sidebar restructure: which purpose-group is showing. Panels stay
  // mounted (CSS-hidden, not conditionally rendered) so every
  // dashboardTour.ts target is still findable by `document.querySelector`
  // regardless of the active tab - see `TAB_FOR_TOUR_STEP` above.
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('actions')

  // Keep the guided tour working across tabs: when it steps into a panel
  // that lives in a different tab, switch tabs to match. Done here, DURING
  // render (not in a useEffect) so the DOM is already correct before
  // TourOverlay's own layout effect measures the target on this same step
  // change - an effect-based sync would race it and sometimes measure the
  // still-hidden previous tab for one frame.
  const currentTourStep = useAppSelector((state) => state.tour.steps[state.tour.stepIndex] ?? null)
  const desiredSidebarTab = currentTourStep ? TAB_FOR_TOUR_STEP[currentTourStep.id] : undefined
  if (desiredSidebarTab && desiredSidebarTab !== sidebarTab) {
    setSidebarTab(desiredSidebarTab)
  }

  const plan = schedule.data?.data
  // `blocks` is the solver's plan and what `decisionLog` explains; the
  // effective plan is that with manual overrides replayed on top (D-043).
  // The Controller is looking at the latter.
  const visibleBlocks = plan?.effectivePlan?.blocks ?? plan?.blocks ?? []
  // FR6.1: a published plan is frozen and a rejected one is discarded. Read
  // from the same set the server enforces, rather than restating the rule here.
  const overridable = OVERRIDABLE_STATES.has(plan?.workflowState ?? 'draft')
  // TX5: which tasks the CURRENT (post-override) plan actually places -
  // what `BlockDetailPanel`'s dependency chain uses to say whether a
  // prerequisite has its own block here, not just what its stored `status`
  // claims (oversight.ts's own comment: task status is written once at seed
  // time and never updated after generation).
  const scheduledTaskIds = new Set(visibleBlocks.flatMap((b) => b.taskIds))
  // A 404 means "none generated yet", which is an empty state rather than an
  // error - the difference matters on first run.
  const noScheduleYet =
    schedule.error && (schedule.error as { status?: number }).status === 404

  // Guided walkthrough (housekeeping session, docs/DECISIONS.md D-072): a
  // first-time visitor gets it once, automatically; a returning one gets it
  // only via "Replay walkthrough" in the header. `!schedule.isLoading` is
  // "ready" so `visibleSteps` filters against the FINAL rendered DOM (plan
  // present or genuinely absent), not a half-loaded page.
  useAutoTour(DASHBOARD_TOUR_ID, DASHBOARD_TOUR_STEPS, !schedule.isLoading)

  async function onGenerate(
    policyWeights?: import('../lib/policyWeights.ts').PolicyWeightsInput,
    requestedHorizonDays?: 7 | 30,
  ) {
    const days = requestedHorizonDays ?? horizonDays
    try {
      // No horizonStart: the backend's own default (D-076) is the real
      // current date, which is what "the coming week" should mean whenever
      // this button is actually clicked - not a date pinned to whichever day
      // the dashboard happened to be built on.
      await generate({
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
                data-tour="dashboard-emergency-trigger"
                onClick={() => setEmergencyOpen((open) => !open)}
                className="rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50"
              >
                ⚠ Simulate emergency
              </button>
            )}
            <button
              type="button"
              data-tour="dashboard-generate"
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
              <div data-tour="dashboard-kpis">
                <KpiStrip
                  metrics={plan.metrics}
                  solveSeconds={plan.solveSeconds}
                  status={plan.status}
                />
              </div>

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
                    // TX5: always wired, regardless of override permission -
                    // this opens the read-only drill-down, which every role
                    // and every workflow state can use. Overriding is reached
                    // from inside it, gated there instead (D-080).
                    onSelectBlock={(block) => {
                      setSelected(block)
                      setOverriding(false)
                    }}
                    selectedBlockKey={selected ? blockKey(selected) : null}
                    overridable={overridable}
                    onSelectHorizon={(days) => onGenerate(undefined, days)}
                    isGeneratingHorizon={generation.isLoading}
                  />

                  {selected &&
                    // Re-read from the current plan so a panel never acts on -
                    // or describes - a placement a previous override already
                    // changed underneath it.
                    (() => {
                      const currentBlock =
                        visibleBlocks.find((b) => blockKey(b) === blockKey(selected)) ?? selected
                      return overridable && overriding ? (
                        <OverridePanel
                          scheduleId={plan._id}
                          block={currentBlock}
                          onClose={() => {
                            setSelected(null)
                            setOverriding(false)
                          }}
                        />
                      ) : (
                        <BlockDetailPanel
                          block={currentBlock}
                          tasks={tasks.data?.data ?? []}
                          decisionLog={plan.decisionLog}
                          scheduledTaskIds={scheduledTaskIds}
                          overridable={overridable}
                          onClose={() => setSelected(null)}
                          onOverride={() => setOverriding(true)}
                        />
                      )
                    })()}

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

                <div className="space-y-4">
                  <SidebarTabBar active={sidebarTab} onSelect={setSidebarTab} />

                  {/* Things a Controller actively does. */}
                  <div
                    className={sidebarTab === 'actions' ? 'space-y-6' : 'hidden'}
                    aria-hidden={sidebarTab !== 'actions'}
                  >
                    <WorkflowPanel
                      scheduleId={plan._id}
                      state={plan.workflowState ?? 'draft'}
                      allowedActions={plan.allowedActions ?? []}
                      version={null}
                    />
                    <PolicySliders onRegenerate={onGenerate} isLoading={generation.isLoading} />
                    <OverrideHistory overrides={plan.overrides ?? []} />
                  </div>

                  {/* The ranked backlog. */}
                  <div
                    className={sidebarTab === 'priorities' ? '' : 'hidden'}
                    aria-hidden={sidebarTab !== 'priorities'}
                  >
                    <PriorityQueue
                      tasks={tasks.data?.data ?? []}
                      schedule={plan}
                      onWhatIf={setWhatIfTaskId}
                    />
                  </div>

                  {/* Things a Controller reads, not acts on. */}
                  <div
                    className={sidebarTab === 'context' ? 'space-y-6' : 'hidden'}
                    aria-hidden={sidebarTab !== 'context'}
                  >
                    <WeatherRiskPanel weatherRisk={plan.knownGaps?.weatherRisk} />
                    <KnownLimitations
                      knownGaps={plan.knownGaps}
                      conflictReport={plan.conflictReport}
                      generationErrors={plan.generationErrors}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </QueryState>
      )}
    </>
  )
}

function SidebarTabBar({
  active,
  onSelect,
}: {
  active: SidebarTab
  onSelect: (tab: SidebarTab) => void
}) {
  return (
    <div
      className="flex items-center gap-1 rounded-lg bg-slate-100 p-1"
      role="tablist"
      aria-label="Sidebar sections"
    >
      {SIDEBAR_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onSelect(tab.id)}
          className={`flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
            active === tab.id
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

export default ControllerDashboard
