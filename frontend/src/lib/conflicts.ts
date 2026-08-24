/**
 * Display logic for the PRD 9.5 typed conflict taxonomy.
 *
 * The optimizer classifies conflicts and names a resolution strategy for each
 * (`optimizer/app/core/conflicts.py`). This module only groups them for the
 * screen - it does not reclassify, and it deliberately provides no way to count
 * across plans.
 *
 * WHY THE PLAN FILTER IS NOT OPTIONAL
 * -----------------------------------
 * Conflicts arrive from two different plans. Baseline conflicts are the FR9.1
 * finding - the thing this system is arguing against. Optimized-plan conflicts
 * are gaps the solver does not yet close (T25). A screen that summed them
 * would show "17 conflicts" against a system whose own plan carries 16 and
 * whose comparison target carries 9, which is true of neither. `groupConflicts`
 * therefore takes the plan as a required argument and drops anything that does
 * not match. See docs/DECISIONS.md D-045.
 */

export type ConflictPlan = 'optimized' | 'baseline'

export interface ConflictResolution {
  strategy: string
  explanation: string
  /** The task that would make this conflict impossible, where one exists. */
  enforcedBy: string | null
}

export interface TypedConflict {
  type: string
  plan: ConflictPlan
  corridorId: string | null
  date: string | null
  taskIds: string[]
  departments: string[]
  detail: string
  resolution: ConflictResolution
  /** Type-specific extras: shared resources, overlap minutes, and so on. */
  [extra: string]: unknown
}

export interface ConflictReport {
  byPlan: Record<string, { total: number; byType: Record<string, number> }>
  conflicts: TypedConflict[]
  /** Types PRD 9.5 names that nothing checks for yet - not counted as zero. */
  notYetDetectable: Array<{ type: string; reason: string }>
  /**
   * Types that ARE checked, on every solve, and found to have no occurrences -
   * "checked and found none" is a different claim from "nothing checks", and
   * this is the list that earns it. Dependency precedence (PRD 9.7) joined
   * train-impact here at T24 - see `checkedAndCleared` types in
   * `optimizer/app/core/conflicts.py`.
   */
  checkedAndClear: Array<{ type: string; reason: string }>
  note: string
}

/** Short labels. The raw constants are for machines, not for a Controller. */
export const CONFLICT_TYPE_LABELS: Record<string, string> = {
  CORRIDOR_DOUBLE_BOOKING: 'Corridor double-booking',
  WINDOW_OVER_SUBSCRIPTION: 'Window over-subscription',
  RESOURCE_CONTENTION: 'Resource contention',
  DEPENDENCY_ORDER_VIOLATION: 'Dependency out of order',
  TRAIN_IMPACT_CONFLICT: 'Train impact',
}

/**
 * Display order: the two conflicts that stop work outright come before the two
 * that mis-sequence it. Types absent from this list sort last, alphabetically,
 * so a type added on the Python side still renders rather than disappearing.
 */
export const CONFLICT_TYPE_ORDER = [
  'CORRIDOR_DOUBLE_BOOKING',
  'WINDOW_OVER_SUBSCRIPTION',
  'RESOURCE_CONTENTION',
  'DEPENDENCY_ORDER_VIOLATION',
  'TRAIN_IMPACT_CONFLICT',
]

export interface ConflictGroup {
  type: string
  label: string
  plan: ConflictPlan
  count: number
  /** Instances, capped by `limit`; `count` is always the true total. */
  conflicts: TypedConflict[]
  /** Distinct strategies in this group - resource contention has two. */
  strategies: string[]
  /** Distinct task numbers that would close this class of conflict. */
  enforcedBy: string[]
}

export function conflictTypeLabel(type: string): string {
  return CONFLICT_TYPE_LABELS[type] ?? type
}

function typeRank(type: string): number {
  const index = CONFLICT_TYPE_ORDER.indexOf(type)
  return index === -1 ? CONFLICT_TYPE_ORDER.length : index
}

/**
 * Group one plan's conflicts by type.
 *
 * `plan` is required on purpose - see the module note. Anything belonging to
 * another plan is dropped rather than counted.
 */
export function groupConflicts(
  report: ConflictReport | null | undefined,
  plan: ConflictPlan,
  options: { limit?: number } = {},
): ConflictGroup[] {
  const limit = options.limit ?? 3
  if (!report?.conflicts?.length) return []

  const buckets = new Map<string, TypedConflict[]>()
  for (const conflict of report.conflicts) {
    if (conflict.plan !== plan) continue
    const bucket = buckets.get(conflict.type)
    if (bucket) bucket.push(conflict)
    else buckets.set(conflict.type, [conflict])
  }

  return [...buckets.entries()]
    .map(([type, conflicts]) => ({
      type,
      label: conflictTypeLabel(type),
      plan,
      count: conflicts.length,
      conflicts: conflicts.slice(0, limit),
      strategies: [...new Set(conflicts.map((c) => c.resolution.strategy))],
      enforcedBy: [
        ...new Set(
          conflicts
            .map((c) => c.resolution.enforcedBy)
            .filter((task): task is string => Boolean(task)),
        ),
      ],
    }))
    .sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.type.localeCompare(b.type))
}

/**
 * That plan's conflict total, or null when the report has no such plan.
 *
 * There is deliberately no cross-plan equivalent of this function. If a screen
 * ever needs one, that is a design question to settle first, not a helper to
 * add quietly.
 */
export function planTotal(
  report: ConflictReport | null | undefined,
  plan: ConflictPlan,
): number | null {
  return report?.byPlan?.[plan]?.total ?? null
}
