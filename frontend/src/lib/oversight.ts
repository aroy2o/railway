/**
 * DRM oversight KPI hierarchy - PRD Section 14, task T28.
 *
 * PRD Section 14 names 16 KPIs across four categories. This module computes
 * each one for real from data this project already has, or - where the data
 * model genuinely does not support the KPI as PRD phrases it - marks it
 * unavailable with the specific reason, the same honesty discipline T16's
 * risk model and T26's seasonal flag already apply (a KPI with no real
 * grounding must say so, not be quietly rounded to a plausible-looking
 * number). See docs/DECISIONS.md D-070.
 *
 * TWO REAL GAPS THIS DATA MODEL HAS, NOT SOMETHING THIS MODULE CAN FIX
 * ----------------------------------------------------------------------
 * 1. No execution tracking. `Task.status` is written once at seed time and
 *    never updated after generation (D-043 leaves it untouched deliberately -
 *    it is not what "scheduled" means in this system). So "tasks completed"
 *    and "critical tasks completed" (PRD's own words) are relabelled to what
 *    is actually true - tasks the CURRENT PLAN places into a block - because
 *    nothing in this prototype ever marks a task as executed.
 * 2. No runtime asset state. Assets carry a criticality score and a
 *    simulated degradation history (T16), not a live up/down status, so
 *    "asset availability %" and "downtime" have no honest value to report.
 */
import type { Asset, ConflictReport, Schedule, Task } from '../api/apiSlice.ts'
import { planTotal } from './conflicts.ts'

export interface KpiAvailable {
  label: string
  available: true
  value: string
  detail: string
}

export interface KpiUnavailable {
  label: string
  available: false
  reason: string
}

export type Kpi = KpiAvailable | KpiUnavailable

export interface KpiCategory {
  category: 'Operations' | 'Maintenance' | 'Planning' | 'Asset'
  kpis: Kpi[]
}

function available(label: string, value: string, detail: string): KpiAvailable {
  return { label, available: true, value, detail }
}
function unavailable(label: string, reason: string): KpiUnavailable {
  return { label, available: false, reason }
}

function scheduledTaskIds(plan: Schedule): Set<string> {
  return new Set((plan.effectivePlan?.blocks ?? plan.blocks).flatMap((b) => b.taskIds))
}

/** Operations: PRD names estimated delay, affected trains, blocked/unused corridor hours. */
export function operationsKpis(plan: Schedule): Kpi[] {
  const deferred = plan.deferredTasks
  let displacedMinutes = 0
  let trainsAffected = 0
  let costedCount = 0
  for (const task of deferred) {
    const measured = task.displacementOption?.impact?.measured
    if (task.displacementOption?.feasible && measured) {
      displacedMinutes += measured.displacedMinutes
      trainsAffected += measured.trainsAffected
      costedCount += 1
    }
  }

  return [
    available(
      'Estimated train delay',
      '0 min from this plan',
      'Checked, not assumed: every scheduled block sits in already-free capacity, so the ' +
        `committed plan causes zero train delay (T22, earned zero). Forcing the ${costedCount} ` +
        `costed deferral(s) through via a traffic block instead would displace an estimated ` +
        `${displacedMinutes} min - see Deferred work for the per-task breakdown.`,
    ),
    available(
      'Affected trains',
      '0 from this plan',
      `Same reasoning as train delay above. Forcing the ${costedCount} costed deferral(s) ` +
        `through would affect an estimated ${trainsAffected} train(s), real counts from T3's ` +
        `timetable, apportioned per T22's Phase A costing.`,
    ),
    available(
      'Blocked corridor hours',
      `${(plan.metrics.blockMinutesUsed / 60).toFixed(1)} h`,
      `${plan.metrics.blockMinutesUsed} min of real possession time across ${plan.metrics.blocksUsed} block(s).`,
    ),
    available(
      'Unused block hours',
      `${(plan.metrics.unusedBlockMinutes / 60).toFixed(1)} h`,
      'Free time inside an opened window that no task claimed - never negative, since a window ' +
        'is only opened when something is placed into it.',
    ),
  ]
}

/** Maintenance: two of PRD's four names assume execution tracking this prototype does not have. */
export function maintenanceKpis(plan: Schedule, tasks: Task[], assets: Asset[]): Kpi[] {
  const scheduled = scheduledTaskIds(plan)
  const criticalityByAsset = new Map(assets.map((a) => [a._id, a.criticalityScore]))
  const threshold = topQuartileCriticality(assets)
  const overdue = tasks.filter((t) => t.priorityBreakdown?.isOverdue).length
  const criticalScheduled = tasks.filter(
    (t) => scheduled.has(t._id) && (criticalityByAsset.get(t.assetId) ?? -Infinity) >= threshold,
  ).length

  return [
    available(
      'Tasks scheduled',
      String(plan.metrics.tasksScheduled),
      'Labelled "scheduled", not "completed": this prototype has no execution-tracking layer - ' +
        'no task is ever marked done. This counts tasks the CURRENT plan places into a block.',
    ),
    available(
      'Overdue tasks',
      String(overdue),
      `Past their real SLA due date (FR2.3), out of ${tasks.length} in the backlog - regardless ` +
        'of whether this plan could schedule them.',
    ),
    available(
      'Critical tasks scheduled',
      String(criticalScheduled),
      `Currently-scheduled tasks whose asset sits in the top quartile of this corpus's real ` +
        `criticality scores (>= ${threshold.toFixed(1)}). "Scheduled", not "completed" - same gap as above.`,
    ),
    unavailable(
      'Predicted failure risk reduced',
      'T16\'s risk model extrapolates time-to-threshold from a simulated degradation trend - it ' +
        'does not simulate what maintenance would do to that trend, so there is no before/after ' +
        'figure to report (the same PRD 9.1 honesty boundary T16 itself states).',
    ),
  ]
}

/** Planning: all four are real and already computed elsewhere in this system. */
export function planningKpis(
  plan: Schedule,
  conflictReport: ConflictReport | null | undefined,
  previousPlan: Schedule | null,
): Kpi[] {
  const batchingRatio =
    plan.metrics.blocksUsed > 0
      ? (100 * plan.metrics.crossDepartmentBatches) / plan.metrics.blocksUsed
      : 0

  return [
    available(
      'Block utilisation',
      `${plan.metrics.blockUtilisationPct.toFixed(1)}%`,
      `${plan.metrics.blockMinutesUsed} of ${plan.metrics.blockMinutesCapacity} min. Never read ` +
        'alone: a higher figure can mean over-subscription rather than efficiency (D-031).',
    ),
    available(
      'Batching ratio',
      `${batchingRatio.toFixed(1)}%`,
      `${plan.metrics.crossDepartmentBatches} of ${plan.metrics.blocksUsed} block(s) serve two or ` +
        'more departments in one possession.',
    ),
    conflictCountKpi(conflictReport),
    scheduleStability(plan, previousPlan),
  ]
}

/**
 * Routed through `planTotal` (`lib/conflicts.ts`) rather than reading
 * `byPlan.optimized` here directly, so this distinction is made in exactly one
 * place. T25 found that `byPlan` drops the 'optimized' key entirely once
 * dependency precedence and resource no-overlap became hard constraints,
 * rather than keeping it at `{ total: 0 }` (D-046) - a naive read would
 * relabel that real, checked zero as "unavailable", the exact class of
 * mistake T21/T24/T25 built `checkedAndClear` to prevent. `planTotal` itself
 * carried the same bug until D-071 fixed it at the source; this KPI is why it
 * had to be right, not just here.
 */
function conflictCountKpi(conflictReport: ConflictReport | null | undefined): Kpi {
  const count = planTotal(conflictReport, 'optimized')
  if (count === null) {
    return unavailable(
      'Conflict count',
      'This plan predates the PRD 9.5 typed conflict taxonomy (T21) or the report failed to generate.',
    )
  }
  return available(
    'Conflict count',
    String(count),
    count === 0
      ? 'Checked, not merely absent - dependency precedence and resource no-overlap are hard ' +
        'CP-SAT constraints (T24, T25); zero here is asserted on every solve.'
      : 'PRD 9.5 typed conflicts on the committed plan - see Known Limitations for the breakdown by type.',
  )
}

function scheduleStability(plan: Schedule, previousPlan: Schedule | null): Kpi {
  if (!previousPlan) {
    return unavailable(
      'Schedule stability',
      'No earlier plan on this horizon exists yet to compare against - generate a second plan to see it.',
    )
  }
  const currentBlocks = plan.effectivePlan?.blocks ?? plan.blocks
  const previousPlacement = new Map<string, string>()
  for (const block of previousPlan.effectivePlan?.blocks ?? previousPlan.blocks) {
    for (const taskId of block.taskIds) previousPlacement.set(taskId, `${block.corridorId}|${block.date}`)
  }
  const scheduledNow = currentBlocks.flatMap((b) => b.taskIds.map((taskId) => ({ taskId, block: b })))
  if (scheduledNow.length === 0) {
    return unavailable('Schedule stability', 'Nothing is scheduled in the current plan to compare.')
  }
  const unchanged = scheduledNow.filter(
    ({ taskId, block }) => previousPlacement.get(taskId) === `${block.corridorId}|${block.date}`,
  ).length
  const pct = (100 * unchanged) / scheduledNow.length

  return available(
    'Schedule stability',
    `${pct.toFixed(0)}%`,
    `${unchanged} of ${scheduledNow.length} currently-scheduled task(s) sit on the same corridor ` +
      `and day as they did in the previous plan (${previousPlan._id}). A real re-solve can ` +
      'reshuffle unrelated tasks\' days even when coverage does not change (D-028/D-061) - this ' +
      'is what makes that visible rather than assumed away.',
  )
}

/** Asset: PRD names two KPIs this prototype has no runtime model for. */
export function assetKpis(plan: Schedule, tasks: Task[], assets: Asset[]): Kpi[] {
  const scheduled = scheduledTaskIds(plan)
  const threshold = topQuartileCriticality(assets)

  const tasksByAsset = new Map<string, Task[]>()
  for (const task of tasks) {
    const bucket = tasksByAsset.get(task.assetId) ?? []
    bucket.push(task)
    tasksByAsset.set(task.assetId, bucket)
  }
  // An asset "still at risk" means at least one of its own real tasks is not
  // addressed by the CURRENT plan - counted per ASSET (PRD's own wording),
  // not per task, so an asset with three unscheduled defects counts once.
  const criticalAtRisk = assets.filter(
    (asset) =>
      asset.criticalityScore >= threshold &&
      (tasksByAsset.get(asset._id) ?? []).some((t) => !scheduled.has(t._id)),
  ).length

  return [
    unavailable(
      'Asset availability %',
      'This prototype has no runtime asset-state model - assets carry a criticality score and a ' +
        'simulated degradation history (T16), not a live up/down status to compute availability from.',
    ),
    unavailable(
      'Downtime',
      'Same gap as availability above: nothing here tracks when an asset was actually out of service.',
    ),
    available(
      'High-criticality assets still at risk',
      String(criticalAtRisk),
      `Real assets whose criticality sits in this corpus's top quartile (>= ${threshold.toFixed(1)}) ` +
        'and that have at least one task NOT scheduled in the current plan.',
    ),
  ]
}

/**
 * The real top-quartile criticality score across this corpus's real assets -
 * measured from the live corpus each time, never a remembered constant, so
 * this tracks the data rather than going stale if the corpus
 * changes (the same discipline T7/T16 applied to their own weights).
 */
function topQuartileCriticality(assets: Asset[]): number {
  const scores = assets.map((a) => a.criticalityScore).sort((a, b) => a - b)
  if (scores.length === 0) return Infinity
  return scores[Math.floor(scores.length * 0.75)]!
}

export function buildKpiHierarchy(
  plan: Schedule,
  tasks: Task[],
  assets: Asset[],
  conflictReport: ConflictReport | null | undefined,
  previousPlan: Schedule | null,
): KpiCategory[] {
  return [
    { category: 'Operations', kpis: operationsKpis(plan) },
    { category: 'Maintenance', kpis: maintenanceKpis(plan, tasks, assets) },
    { category: 'Planning', kpis: planningKpis(plan, conflictReport, previousPlan) },
    { category: 'Asset', kpis: assetKpis(plan, tasks, assets) },
  ]
}
