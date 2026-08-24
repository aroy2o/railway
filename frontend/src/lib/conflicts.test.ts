/**
 * The PRD 9.5 taxonomy's display logic.
 *
 * Grouping is arithmetic, and the plan separation is the whole point of the
 * `plan` discriminator, so both are worth testing even under CLAUDE.md's
 * "frontend coverage last" rule. `groupConflicts never mixes plans` is the
 * load-bearing one - it is written to fail if the filter is ever relaxed.
 */
import { describe, expect, it } from 'vitest'
import {
  conflictTypeLabel,
  groupConflicts,
  planTotal,
  type ConflictReport,
  type TypedConflict,
} from './conflicts.ts'

function conflict(
  type: string,
  plan: 'optimized' | 'baseline',
  overrides: Partial<TypedConflict> = {},
): TypedConflict {
  return {
    type,
    plan,
    corridorId: 'AAA-BBB',
    date: '2026-08-24',
    taskIds: ['TSK-A', 'TSK-B'],
    departments: ['Engineering'],
    detail: 'detail line',
    resolution: { strategy: 'Stagger within the department', explanation: 'x', enforcedBy: 'T25' },
    ...overrides,
  }
}

function report(conflicts: TypedConflict[]): ConflictReport {
  const byPlan: ConflictReport['byPlan'] = {}
  for (const c of conflicts) {
    const bucket = (byPlan[c.plan] ??= { total: 0, byType: {} })
    bucket.total += 1
    bucket.byType[c.type] = (bucket.byType[c.type] ?? 0) + 1
  }
  return { byPlan, conflicts, notYetDetectable: [], checkedAndClear: [], note: '' }
}

describe('groupConflicts', () => {
  it('never mixes plans', () => {
    const mixed = report([
      conflict('RESOURCE_CONTENTION', 'optimized'),
      conflict('CORRIDOR_DOUBLE_BOOKING', 'baseline'),
      conflict('CORRIDOR_DOUBLE_BOOKING', 'baseline'),
    ])

    const optimized = groupConflicts(mixed, 'optimized')
    const baseline = groupConflicts(mixed, 'baseline')

    expect(optimized.map((g) => g.type)).toEqual(['RESOURCE_CONTENTION'])
    expect(optimized[0].count).toBe(1)
    expect(baseline.map((g) => g.type)).toEqual(['CORRIDOR_DOUBLE_BOOKING'])
    expect(baseline[0].count).toBe(2)
    // Neither view may ever see the other plan's three-conflict total.
    expect(optimized.reduce((sum, g) => sum + g.count, 0)).toBe(1)
    expect(baseline.reduce((sum, g) => sum + g.count, 0)).toBe(2)
  })

  it('orders blocking conflicts before mis-sequenced ones', () => {
    const groups = groupConflicts(
      report([
        conflict('DEPENDENCY_ORDER_VIOLATION', 'optimized'),
        conflict('RESOURCE_CONTENTION', 'optimized'),
      ]),
      'optimized',
    )

    expect(groups.map((g) => g.type)).toEqual([
      'RESOURCE_CONTENTION',
      'DEPENDENCY_ORDER_VIOLATION',
    ])
  })

  it('renders an unknown type rather than dropping it', () => {
    const groups = groupConflicts(report([conflict('SOMETHING_NEW', 'optimized')]), 'optimized')

    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('SOMETHING_NEW')
  })

  it('caps listed instances but never the count', () => {
    const many = report(
      Array.from({ length: 11 }, (_, i) =>
        conflict('RESOURCE_CONTENTION', 'optimized', { taskIds: [`TSK-${i}`] }),
      ),
    )

    const [group] = groupConflicts(many, 'optimized', { limit: 3 })

    expect(group.count).toBe(11)
    expect(group.conflicts).toHaveLength(3)
  })

  it('carries both resolution strategies when a type has more than one', () => {
    const groups = groupConflicts(
      report([
        conflict('RESOURCE_CONTENTION', 'optimized'),
        conflict('RESOURCE_CONTENTION', 'optimized', {
          resolution: { strategy: 'Only one proceeds', explanation: 'y', enforcedBy: 'T25' },
        }),
      ]),
      'optimized',
    )

    expect(groups[0].strategies).toEqual([
      'Stagger within the department',
      'Only one proceeds',
    ])
    expect(groups[0].enforcedBy).toEqual(['T25'])
  })

  it('returns nothing for an absent or empty report', () => {
    expect(groupConflicts(null, 'optimized')).toEqual([])
    expect(groupConflicts(report([]), 'optimized')).toEqual([])
  })
})

describe('planTotal', () => {
  it('reports only the plan asked for', () => {
    const mixed = report([
      conflict('RESOURCE_CONTENTION', 'optimized'),
      conflict('CORRIDOR_DOUBLE_BOOKING', 'baseline'),
    ])

    expect(planTotal(mixed, 'optimized')).toBe(1)
    expect(planTotal(mixed, 'baseline')).toBe(1)
  })

  it('is null rather than zero when the plan is absent', () => {
    // Zero would read as "checked, none found". Absent means not computed.
    expect(planTotal(report([]), 'optimized')).toBeNull()
    expect(planTotal(null, 'baseline')).toBeNull()
  })
})

describe('conflictTypeLabel', () => {
  it('translates the machine constants', () => {
    expect(conflictTypeLabel('CORRIDOR_DOUBLE_BOOKING')).toBe('Corridor double-booking')
    expect(conflictTypeLabel('TRAIN_IMPACT_CONFLICT')).toBe('Train impact')
  })
})
