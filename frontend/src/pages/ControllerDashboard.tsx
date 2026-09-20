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
import { AlertCircle, AlertTriangle, GitCompare, Loader2, XCircle } from 'lucide-react'
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
import WorkflowPanel from '../components/WorkflowPanel.tsx'
import WhatIfPanel from '../components/WhatIfPanel.tsx'
import EmergencyPanel from '../components/EmergencyPanel.tsx'
import PolicySliders from '../components/PolicySliders.tsx'
import { OVERRIDABLE_STATES } from '../lib/approval.ts'
import OverridePanel from '../components/OverridePanel.tsx'
import BlockDetailPanel from '../components/BlockDetailPanel.tsx'
import Modal from '../components/Modal.tsx'
import AskThePlanner from '../components/AskThePlanner.tsx'
import KnownLimitations from '../components/KnownLimitations.tsx'
import WeatherRiskPanel from '../components/WeatherRiskPanel.tsx'
import { useSlowLoadHint } from '../lib/useSlowLoadHint.ts'
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
  // T28: tracked so a policy-slider regenerate stays on whatever horizon is
  // currently being viewed, rather than silently reverting to weekly.
  const [horizonDays, setHorizonDays] = useState<7 | 30>(7)
  // Dashboard UX fix: weekly and monthly are each their OWN "latest" now
  // (backend/src/services/scheduleOrchestrator.ts's findLatestSchedule), so
  // both stay subscribed the whole time rather than one shared query that a
  // horizon switch had to re-point and re-solve. `schedule` below picks
  // whichever matches the currently viewed horizon - the rest of this
  // component reads from that exactly as it did from the single query before.
  const weeklySchedule = useGetLatestScheduleQuery({ horizonDays: 7 })
  const monthlySchedule = useGetLatestScheduleQuery({ horizonDays: 30 })
  const schedule = horizonDays === 7 ? weeklySchedule : monthlySchedule
  // 1500, not 200: the fulldata-ktv-psa corpus runs to ~935 tasks, and a
  // schedule can place any of them into a block regardless of severity rank
  // (the old 200-task cap silently left most of the backlog unresolvable by
  // BlockDetailPanel - see its "not in the currently loaded backlog" notice).
  const tasks = useGetTasksQuery({ limit: 1500 })
  const [generate, generation] = useGenerateScheduleMutation()
  // Separate mutation instance for the background pre-solve below, so its
  // in-flight state never clobbers `generation`'s - that one drives the
  // "Solving..." banner the user is actually watching.
  const [prewarm] = useGenerateScheduleMutation()
  const [prewarmingHorizon, setPrewarmingHorizon] = useState<7 | 30 | null>(null)
  const [prewarmError, setPrewarmError] = useState<string | null>(null)
  const showSlowGenerateHint = useSlowLoadHint(generation.isLoading)
  // TX5: the block currently being INSPECTED (Task/Block Detail Drill-down).
  // Renamed in spirit from a pure "override selection" now that clicking a
  // block always opens the read-only drill-down first - `overriding` below
  // is what decides whether that same block is also showing the write flow.
  const [selected, setSelected] = useState<ScheduleBlock | null>(null)
  const [overriding, setOverriding] = useState(false)
  // Monthly's equivalent of `selected` above - a reservation cell has no
  // single block, so this holds which corridor-day was clicked and the
  // render below looks up every real block for it (see `GanttTimeline`'s
  // `onSelectCorridorDay` doc comment for why that lookup happens here
  // rather than inside the Gantt).
  const [selectedMonthlyCell, setSelectedMonthlyCell] = useState<{
    corridorId: string
    date: string
  } | null>(null)
  // T20: independent of the override selection above - a what-if works on a
  // deferred task too, which has no block on the Gantt to select at all.
  const [whatIfTaskId, setWhatIfTaskId] = useState<string | null>(null)
  // T27: independent of both selections above - an emergency picks its own
  // corridor and window rather than reusing the Gantt's click-to-select.
  const [emergencyOpen, setEmergencyOpen] = useState(false)
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
    const weights = policyWeights && Object.keys(policyWeights).length > 0 ? { policyWeights } : {}
    try {
      // No horizonStart: the backend's own default (D-076) is the real
      // current date, which is what "the coming week" should mean whenever
      // this button is actually clicked - not a date pinned to whichever day
      // the dashboard happened to be built on.
      await generate({ horizonDays: days, ...weights }).unwrap()
      setHorizonDays(days)
    } catch {
      // Surfaced in the banner below; unwrap() would otherwise reject unhandled.
      return
    }

    // Dashboard UX fix: pre-solve the OTHER horizon in the background right
    // away, so a Controller comparing Weekly against Monthly right after
    // generating gets an instant switch instead of a second full CP-SAT run.
    // Best-effort - a failure here just means the toggle falls back to a real
    // solve on click, same as it always has; nothing the user sees depends on
    // this succeeding.
    const otherDays = days === 7 ? 30 : 7
    setPrewarmingHorizon(otherDays)
    setPrewarmError(null)
    prewarm({ horizonDays: otherDays, ...weights })
      .unwrap()
      .catch(() => {
        setPrewarmError(
          `Could not pre-solve the ${otherDays === 30 ? 'monthly' : 'weekly'} plan in the background — it will solve when you switch to it.`,
        )
      })
      .finally(() => {
        setPrewarmingHorizon((current) => (current === otherDays ? null : current))
      })
  }

  /**
   * Weekly/Monthly toggle. Switches to whichever horizon already has a plan
   * (this session's generate, or its background pre-solve above, or simply a
   * plan some earlier session left as that horizon's "latest") with no
   * network call at all - `weeklySchedule`/`monthlySchedule` are always-on
   * subscriptions, so the data is already sitting in the RTK Query cache.
   * Only solves for real when nothing is there yet, or when nothing is
   * already in flight for it.
   */
  function onSelectHorizon(days: 7 | 30) {
    setHorizonDays(days)
    const targetSchedule = days === 7 ? weeklySchedule : monthlySchedule
    const alreadySolving = generation.isLoading || prewarmingHorizon === days
    if (!targetSchedule.data && !alreadySolving) {
      void onGenerate(undefined, days)
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
                className="flex items-center gap-1.5 rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50"
              >
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                Simulate emergency
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

      {/* A CP-SAT run takes a second or two. Saying so beats looking frozen.
          Past SLOW_LOAD_HINT_DELAY_MS, swap to the cold-start explanation
          instead - the deployed optimizer scales to zero when idle
          (docs/deploy/README.md), so "a couple of seconds" would read as
          broken rather than honest once a real cold start is under way. */}
      {generation.isLoading && (
        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          <span>
            {showSlowGenerateHint
              ? 'Starting up the solver service after a break — this can take up to 30s. It will speed back up once warm.'
              : 'Running the constraint solver over the pending backlog. This usually takes a couple of seconds.'}
          </span>
        </div>
      )}

      {/* D-037 made this message actionable - render it rather than a generic
          failure state, because "Could not reach the optimizer service" tells
          the operator exactly what to do. */}
      {generation.isError && (
        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
          <XCircle className="h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-rose-900">Could not generate a schedule</p>
            <p className="mt-0.5 text-sm text-rose-700">{describeApiError(generation.error)}</p>
          </div>
        </div>
      )}

      {/* Non-blocking: the background pre-solve is a best-effort optimization,
          not something the Controller asked for directly, so this stays a
          small note rather than the rose error banner above. */}
      {prewarmError && (
        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{prewarmError}</span>
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
                  assetAvailability={plan.assetAvailability}
                />
              </div>

              {/* The comparison is computed in the same run as this plan, so a
                  Controller reviewing one will want the other close by. */}
              {plan.comparisonToBaseline && (
                <Link
                  to="/comparison"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-300 bg-slate-100 px-5 py-3 transition-colors hover:border-slate-400"
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
                  <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-sky-700">
                    <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
                    Baseline vs AI →
                  </span>
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
                      setSelectedMonthlyCell(null)
                    }}
                    selectedBlockKey={selected ? blockKey(selected) : null}
                    onSelectCorridorDay={(corridorId, date) => {
                      setSelectedMonthlyCell({ corridorId, date })
                      setSelected(null)
                      setOverriding(false)
                    }}
                    overridable={overridable}
                    onSelectHorizon={onSelectHorizon}
                    isGeneratingHorizon={generation.isLoading || prewarmingHorizon !== null}
                  />

                  {selected &&
                    // Re-read from the current plan so a panel never acts on -
                    // or describes - a placement a previous override already
                    // changed underneath it.
                    (() => {
                      const currentBlock =
                        visibleBlocks.find((b) => blockKey(b) === blockKey(selected)) ?? selected
                      const closeDetail = () => setSelected(null)
                      const closeOverride = () => {
                        setSelected(null)
                        setOverriding(false)
                      }
                      // A centered overlay, not an inline panel below the
                      // Gantt: the inline version rendered past the fold on
                      // any plan long enough to need the pager above, so a
                      // first-time user clicking a block saw nothing appear
                      // to happen (session: "block detail as a popped-out
                      // card"). Escape/backdrop-click close it the same way
                      // each panel's own Close button does.
                      return overridable && overriding ? (
                        <Modal onClose={closeOverride}>
                          <OverridePanel
                            scheduleId={plan._id}
                            block={currentBlock}
                            onClose={closeOverride}
                          />
                        </Modal>
                      ) : (
                        <Modal onClose={closeDetail}>
                          <BlockDetailPanel
                            block={currentBlock}
                            tasks={tasks.data?.data ?? []}
                            decisionLog={plan.decisionLog}
                            scheduledTaskIds={scheduledTaskIds}
                            overridable={overridable}
                            onClose={closeDetail}
                            onOverride={() => setOverriding(true)}
                          />
                        </Modal>
                      )
                    })()}

                  {selectedMonthlyCell &&
                    // Every real block the solver put on this corridor this
                    // day, each shown through the SAME `BlockDetailPanel`
                    // Weekly uses - full task-level detail (dependency
                    // chain, resources, risk breakdown), not a shorter
                    // summary. Never overridable here: a reservation cell can
                    // cover more than one exact-slot window, so there is no
                    // single (corridor, date, windowIndex) to hand the
                    // override endpoint - see `GanttTimeline.tsx`'s
                    // `MonthlyReservationGrid` doc comment.
                    (() => {
                      const closeMonthlyCell = () => setSelectedMonthlyCell(null)
                      const cellBlocks = visibleBlocks.filter(
                        (b) =>
                          b.corridorId === selectedMonthlyCell.corridorId &&
                          b.date === selectedMonthlyCell.date,
                      )
                      return (
                        <Modal onClose={closeMonthlyCell}>
                          {cellBlocks.length === 0 ? (
                            <section className="rounded-xl border-2 border-slate-300 bg-white p-5 shadow-sm">
                              <p className="text-sm text-slate-600">
                                This corridor-day no longer carries a reservation in the current plan.
                              </p>
                              <button
                                type="button"
                                onClick={closeMonthlyCell}
                                className="mt-3 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                              >
                                Close
                              </button>
                            </section>
                          ) : (
                            <div className="space-y-4">
                              {cellBlocks.length > 1 && (
                                <p className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm">
                                  {selectedMonthlyCell.corridorId} · {selectedMonthlyCell.date} ·{' '}
                                  {cellBlocks.length} blocks this day
                                </p>
                              )}
                              {cellBlocks.map((block) => (
                                <BlockDetailPanel
                                  key={blockKey(block)}
                                  block={block}
                                  tasks={tasks.data?.data ?? []}
                                  decisionLog={plan.decisionLog}
                                  scheduledTaskIds={scheduledTaskIds}
                                  overridable={false}
                                  onClose={closeMonthlyCell}
                                  onOverride={() => {}}
                                />
                              ))}
                            </div>
                          )}
                        </Modal>
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

                  {/* No wrapping card here on purpose: both panels below
                      already carry their own full card (border/shadow/icon
                      header) since their own redesign - an outer border
                      around two already-bordered cards was a leftover from
                      before that, and doubled up as a second, redundant
                      "Ask the Planner & deferred work" label sitting right
                      on top of AskThePlanner's own heading. */}
                  <div className="space-y-6">
                    <AskThePlanner scheduleId={plan._id} />
                    <DeferredTasksPanel deferred={plan.deferredTasks} />
                  </div>
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
