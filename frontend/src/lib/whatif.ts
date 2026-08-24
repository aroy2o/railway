/**
 * Display logic for T20's what-if simulation (PRD FR5, 9.4).
 *
 * Types mirror the optimizer's response exactly (`app/core/whatif.py`,
 * `WhatIfResult.as_dict()`) - this module adds no shape of its own, only the
 * small amount of formatting worth testing separately from JSX.
 */

export interface WhatIfTaskOutcome {
  placed: boolean
  corridorId: string | null
  date: string | null
  windowIndex: number | null
}

export interface WhatIfDiff {
  newlyScheduled: string[]
  newlyDeferred: string[]
  reshuffledCount: number
  reshuffledSample: string[]
}

export interface WhatIfOption {
  label: string
  kind: 'move' | 'defer' | 'traffic-block'
  taskOutcome: WhatIfTaskOutcome
  diff: WhatIfDiff | null
  metrics: Record<string, unknown>
  reason: string
  solveSeconds: number | null
  status: string | null
}

export interface WhatIfResult {
  taskId: string
  currentlyScheduled: boolean
  baselineMetrics: Record<string, number>
  options: WhatIfOption[]
  recommendedIndex: number | null
  framing: string
}

/**
 * One line summarising an option's consequence, for the collapsed "everything
 * else" row. Never a task-by-task list in the UI - `whatif.py`'s own
 * docstring found that ANY perturbation on the real corpus reshuffles a large
 * and variable number of unrelated tasks' days (0 to 25 of 35, in testing),
 * so a full list would bury the one thing the Controller actually asked
 * about under noise nobody asked for.
 */
export function summariseConsequence(option: WhatIfOption): string {
  const parts: string[] = []
  if (option.diff?.newlyDeferred.length) {
    parts.push(
      `displaces ${option.diff.newlyDeferred.length} task${option.diff.newlyDeferred.length === 1 ? '' : 's'}`,
    )
  }
  if (option.diff && option.diff.reshuffledCount > 0) {
    parts.push(`reshuffles ${option.diff.reshuffledCount} other task day${option.diff.reshuffledCount === 1 ? '' : 's'}`)
  }
  if (parts.length === 0) {
    return option.kind === 'traffic-block'
      ? 'not a re-solve — see reason below'
      : 'nothing else changes'
  }
  return parts.join(', ')
}

/**
 * Whether this option's status was honestly cut short of proven-optimal.
 *
 * `whatif_solver_max_seconds` (T20) is deliberately shorter than a normal
 * solve's budget - found necessary directly against the real corpus, where an
 * extreme (but T23-legal) weight combination took 8-9s to prove optimal per
 * solve. A Controller should be told when an option is FEASIBLE rather than
 * proven best, not have it presented identically to one that was.
 */
export function isUnproven(option: WhatIfOption): boolean {
  return option.status !== null && option.status !== 'OPTIMAL'
}

export function optionBadgeTone(option: WhatIfOption): 'good' | 'warn' | 'neutral' {
  if (option.kind === 'traffic-block') return 'neutral'
  if (option.diff?.newlyDeferred.length) return 'warn'
  return 'good'
}
