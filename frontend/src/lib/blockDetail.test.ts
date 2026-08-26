/**
 * Data assembly for the Task/Block Detail Drill-down (TX5).
 */
import { describe, expect, it } from 'vitest'
import type { DecisionLogEntry, Task } from '../api/apiSlice.ts'
import { departmentMix, dependencyChain, describeReasoning, resolveResources } from './blockDetail.ts'

function task(overrides: Partial<Task> = {}): Task {
  return {
    _id: 'TSK-00001',
    department: 'Engineering',
    corridorId: 'A-B',
    assetId: 'AST-1',
    defectType: 'rail fracture',
    severity: 3,
    dateRaised: '2026-06-01',
    slaDueDate: '2026-09-01',
    estBlockDurationMins: 120,
    requiredResourceId: null,
    requiredResourceIds: [],
    dependsOnTaskId: null,
    workflowStage: null,
    priorityScore: 50,
    dominantPriorityFactor: 'severity',
    priorityBreakdown: null,
    failureRiskScore: null,
    status: 'scheduled',
    synthetic: true,
    ...overrides,
  }
}

describe('departmentMix', () => {
  it('groups tasks by department, preserving first-seen order', () => {
    const groups = departmentMix({
      taskIds: ['T1', 'T2', 'T3'],
      departments: ['S&T', 'Engineering', 'S&T'],
    })
    expect(groups).toEqual([
      { department: 'S&T', taskIds: ['T1', 'T3'] },
      { department: 'Engineering', taskIds: ['T2'] },
    ])
  })

  it('returns one group for a single-department block', () => {
    const groups = departmentMix({ taskIds: ['T1'], departments: ['TRD'] })
    expect(groups).toEqual([{ department: 'TRD', taskIds: ['T1'] }])
  })
})

describe('dependencyChain', () => {
  it('walks a multi-stage chain, resolving each prerequisite', () => {
    const t3 = task({ _id: 'TSK-3', dependsOnTaskId: null, status: 'pending', defectType: 'inspection' })
    const t2 = task({ _id: 'TSK-2', dependsOnTaskId: 'TSK-3', status: 'scheduled', defectType: 'repair' })
    const t1 = task({ _id: 'TSK-1', dependsOnTaskId: 'TSK-2', status: 'scheduled', defectType: 'testing' })
    const byId = new Map([t1, t2, t3].map((t) => [t._id, t]))

    const chain = dependencyChain(t1, byId, new Set(['TSK-2']))

    expect(chain).toEqual([
      { taskId: 'TSK-2', defectType: 'repair', scheduledInThisPlan: true },
      { taskId: 'TSK-3', defectType: 'inspection', scheduledInThisPlan: false },
    ])
  })

  it('returns an empty chain for a task with no dependency', () => {
    expect(dependencyChain(task({ dependsOnTaskId: null }), new Map(), new Set())).toEqual([])
  })

  it('flags an unresolvable prerequisite id rather than dropping it silently', () => {
    const t1 = task({ _id: 'TSK-1', dependsOnTaskId: 'TSK-GHOST' })
    const chain = dependencyChain(t1, new Map([[t1._id, t1]]), new Set())
    expect(chain).toEqual([{ taskId: 'TSK-GHOST', defectType: null, scheduledInThisPlan: false }])
  })

  it('never reports Task.status - that field is written once at seed time and never updated, so it cannot answer "is this scheduled"', () => {
    // Regression guard for the bug this feature shipped with and a live
    // screenshot caught: a prerequisite that genuinely HAS a block in the
    // current plan still carries `status: 'pending'` (seed-time only), so
    // rendering it would show "pending ... has its own block in this plan" -
    // two true facts that read as a contradiction.
    const prereq = task({ _id: 'TSK-2', status: 'pending' })
    const dependent = task({ _id: 'TSK-1', dependsOnTaskId: 'TSK-2' })
    const chain = dependencyChain(dependent, new Map([[prereq._id, prereq]]), new Set(['TSK-2']))
    expect(chain[0]).not.toHaveProperty('status')
    expect(chain[0]!.scheduledInThisPlan).toBe(true)
  })

  it('stops on a cycle instead of looping forever', () => {
    const a = task({ _id: 'TSK-A', dependsOnTaskId: 'TSK-B' })
    const b = task({ _id: 'TSK-B', dependsOnTaskId: 'TSK-A' })
    const byId = new Map([
      [a._id, a],
      [b._id, b],
    ])
    const chain = dependencyChain(a, byId, new Set())
    // TSK-B resolves once; the second hop back to TSK-A (already seen) stops it.
    expect(chain).toHaveLength(1)
    expect(chain[0]!.taskId).toBe('TSK-B')
  })
})

describe('resolveResources', () => {
  it('resolves known ids to their real resource record', () => {
    const byId = new Map([
      ['RES-1', { _id: 'RES-1', name: 'Tower wagon 3', type: 'machine' as const }],
    ])
    expect(resolveResources(['RES-1'], byId)).toEqual([
      { _id: 'RES-1', name: 'Tower wagon 3', type: 'machine', resolved: true },
    ])
  })

  it('flags an id that does not resolve, rather than silently omitting it', () => {
    expect(resolveResources(['RES-MISSING'], new Map())).toEqual([
      { _id: 'RES-MISSING', name: 'RES-MISSING', type: 'crew', resolved: false },
    ])
  })
})

describe('describeReasoning', () => {
  function entry(overrides: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
    return {
      taskId: 'TSK-1',
      decision: 'scheduled',
      corridorId: 'A-B',
      contributingFactors: {},
      ...overrides,
    }
  }

  it('names the priority score and the dominant factor in plain English', () => {
    const text = describeReasoning(
      entry({ contributingFactors: { priorityScore: 42.3, dominantPriorityFactor: 'failure_risk' } }),
    )
    expect(text).toContain('42.3')
    expect(text).toContain('predicted risk')
  })

  it('mentions batching only when the entry says it batched', () => {
    const batched = describeReasoning(
      entry({
        contributingFactors: {
          priorityScore: 10,
          isCrossDepartmentBatch: true,
          sharedWithDepartments: ['TRD'],
        },
      }),
    )
    expect(batched).toContain('TRD')

    const notBatched = describeReasoning(entry({ contributingFactors: { priorityScore: 10 } }))
    expect(notBatched).not.toContain('Batched')
  })

  it('states SLA standing only when the entry actually carries it', () => {
    const late = describeReasoning(entry({ contributingFactors: { withinSla: false } }))
    expect(late).toMatch(/after the task's SLA due date/)

    const onTime = describeReasoning(entry({ contributingFactors: { withinSla: true } }))
    expect(onTime).toMatch(/within the task's SLA due date/)
  })

  it('says so plainly when there is no decision-log entry for this task', () => {
    expect(describeReasoning(undefined)).toMatch(/No decision-log entry/)
  })

  it('never claims a reason for a task the log marks as deferred', () => {
    // Defensive: this panel only ever renders SCHEDULED tasks (it is built
    // from a block, which only exists for placed work), but the function
    // itself must not fabricate scheduling language if handed a deferred row.
    expect(describeReasoning(entry({ decision: 'deferred' }))).toMatch(/No decision-log entry/)
  })
})
