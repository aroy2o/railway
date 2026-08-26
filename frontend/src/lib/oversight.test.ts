/**
 * DRM oversight KPI hierarchy - PRD Section 14, task T28.
 *
 * Each KPI is checked against a small hand-built scenario where the right
 * answer can be verified by hand - the same discipline the optimizer's own
 * tests use, applied here because these numbers are real arithmetic over
 * real fields, not decoration.
 */
import { describe, expect, it } from 'vitest'
import type { Asset, DeferredTask, Schedule, ScheduleBlock, Task } from '../api/apiSlice.ts'
import { assetKpis, maintenanceKpis, operationsKpis, planningKpis } from './oversight.ts'

function block(overrides: Partial<ScheduleBlock> = {}): ScheduleBlock {
  return {
    corridorId: 'A-B',
    date: '2026-08-24',
    windowIndex: 0,
    start: '01:00',
    end: '04:00',
    startMinute: 60,
    endMinute: 240,
    capacityMinutes: 180,
    usedMinutes: 100,
    unusedMinutes: 80,
    taskIds: ['T1'],
    departments: ['Engineering'],
    isCrossDepartmentBatch: false,
    trainImpact: null,
    ...overrides,
  }
}

function deferred(overrides: Partial<DeferredTask> = {}): DeferredTask {
  return {
    taskId: 'T2',
    reason: 'EXCEEDS_LONGEST_WINDOW',
    detail: 'too long',
    ...overrides,
  }
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    _id: 'SCH-1',
    horizon: 'weekly',
    horizonStart: '2026-08-24',
    horizonDays: 7,
    generatedAt: '2026-08-24T00:00:00Z',
    status: 'OPTIMAL',
    objectiveValue: 0,
    solveSeconds: 0.1,
    policyWeights: null,
    metrics: {
      tasksScheduled: 1,
      tasksDeferred: 1,
      blocksUsed: 1,
      crossDepartmentBatches: 0,
      blockMinutesUsed: 100,
      blockMinutesCapacity: 180,
      blockUtilisationPct: 55.6,
      unusedBlockMinutes: 80,
    },
    blocks: [block()],
    deferredTasks: [],
    decisionLog: [],
    knownGaps: {} as Schedule['knownGaps'],
    conflictReport: null,
    contestableTaskIds: [],
    comparisonToBaseline: null,
    baseline: null,
    inputSummary: { taskCount: 2, corridorCount: 1, prioritySource: 'fr2.3-priority-engine' },
    generationErrors: [],
    ...overrides,
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    _id: 'T1',
    department: 'Engineering',
    corridorId: 'A-B',
    assetId: 'AST-1',
    defectType: 'rail fracture',
    severity: 3,
    dateRaised: '2026-07-01',
    slaDueDate: '2026-12-01',
    estBlockDurationMins: 100,
    requiredResourceId: null,
    requiredResourceIds: [],
    dependsOnTaskId: null,
    workflowStage: null,
    priorityScore: 50,
    dominantPriorityFactor: 'severity',
    priorityBreakdown: {
      components: {},
      contributions: {},
      daysToDue: 30,
      isOverdue: false,
      usesFailureRisk: false,
    },
    failureRiskScore: null,
    status: 'pending',
    synthetic: true,
    ...overrides,
  }
}

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    _id: 'AST-1',
    corridorId: 'A-B',
    assetType: 'track',
    department: 'Engineering',
    criticality: {
      passengerDependency: 0.5,
      alternateRouteAvailable: false,
      safetyImportance: 0.5,
      historicalFailureFreq: 0.5,
      trainsAffectedCount: 10,
    },
    criticalityScore: 50,
    criticalityBreakdown: {},
    dominantCriticalityFactor: null,
    synthetic: true,
    ...overrides,
  }
}

describe('operationsKpis', () => {
  it('reports zero delay from the committed plan and sums the hypothetical traffic-block cost separately', () => {
    const plan = schedule({
      deferredTasks: [
        deferred({
          taskId: 'D1',
          displacementOption: {
            corridorId: 'A-B',
            requiredMinutes: 100,
            feasible: true,
            reason: null,
            window: null,
            note: '',
            framing: '',
            impact: {
              corridorId: 'A-B',
              window: '10:00-12:00',
              measured: { trainsAffected: 2, displacedMinutes: 40, clearanceMinutes: 5 },
              estimated: { weightedImpact: 8, tierSplit: {} },
              framing: '',
            },
          },
        }),
        // Not feasible - must not be counted.
        deferred({
          taskId: 'D2',
          displacementOption: {
            corridorId: 'A-B',
            requiredMinutes: 100,
            feasible: false,
            reason: 'no window',
            window: null,
            note: '',
            framing: '',
            impact: null,
          },
        }),
      ],
    })

    const kpis = operationsKpis(plan)
    const delay = kpis.find((k) => k.label === 'Estimated train delay')!
    expect(delay.available).toBe(true)
    expect((delay as { value: string }).value).toBe('0 min from this plan')
    expect((delay as { detail: string }).detail).toContain('40 min')

    const trains = kpis.find((k) => k.label === 'Affected trains')!
    expect((trains as { detail: string }).detail).toContain('2 train(s)')
  })

  it('converts block minutes to hours for the corridor-hour KPIs', () => {
    const plan = schedule({
      metrics: {
        tasksScheduled: 1,
        tasksDeferred: 0,
        blocksUsed: 1,
        crossDepartmentBatches: 0,
        blockMinutesUsed: 120,
        blockMinutesCapacity: 180,
        blockUtilisationPct: 66.7,
        unusedBlockMinutes: 60,
      },
    })
    const kpis = operationsKpis(plan)
    expect((kpis.find((k) => k.label === 'Blocked corridor hours') as { value: string }).value).toBe('2.0 h')
    expect((kpis.find((k) => k.label === 'Unused block hours') as { value: string }).value).toBe('1.0 h')
  })
})

describe('maintenanceKpis', () => {
  it('labels "scheduled" not "completed", and marks risk-reduction unavailable', () => {
    const plan = schedule({ blocks: [block({ taskIds: ['T1'] })] })
    const tasks = [task({ _id: 'T1', assetId: 'AST-1' })]
    const assets = [asset({ _id: 'AST-1', criticalityScore: 90 })]

    const kpis = maintenanceKpis(plan, tasks, assets)
    expect((kpis.find((k) => k.label === 'Tasks scheduled') as { value: string }).value).toBe('1')
    expect(kpis.find((k) => k.label === 'Predicted failure risk reduced')!.available).toBe(false)
  })

  it('counts overdue tasks across the whole backlog, not just what is scheduled', () => {
    const plan = schedule({ blocks: [] })
    const tasks = [
      task({ _id: 'T1', priorityBreakdown: { components: {}, contributions: {}, daysToDue: -5, isOverdue: true, usesFailureRisk: false } }),
      task({ _id: 'T2', priorityBreakdown: { components: {}, contributions: {}, daysToDue: 10, isOverdue: false, usesFailureRisk: false } }),
    ]
    const kpis = maintenanceKpis(plan, tasks, [])
    expect((kpis.find((k) => k.label === 'Overdue tasks') as { value: string }).value).toBe('1')
  })

  it('only counts a critical task as "scheduled" when its real asset criticality is top-quartile', () => {
    const plan = schedule({ blocks: [block({ taskIds: ['T1', 'T2'] })] })
    const tasks = [
      task({ _id: 'T1', assetId: 'AST-HIGH' }),
      task({ _id: 'T2', assetId: 'AST-LOW' }),
    ]
    // Four assets so the 75th percentile is unambiguous: [10, 20, 30, 90].
    const assets = [
      asset({ _id: 'AST-HIGH', criticalityScore: 90 }),
      asset({ _id: 'AST-LOW', criticalityScore: 10 }),
      asset({ _id: 'AST-MID1', criticalityScore: 20 }),
      asset({ _id: 'AST-MID2', criticalityScore: 30 }),
    ]
    const kpis = maintenanceKpis(plan, tasks, assets)
    expect((kpis.find((k) => k.label === 'Critical tasks scheduled') as { value: string }).value).toBe('1')
  })
})

describe('planningKpis', () => {
  it('reports schedule stability as unavailable with no prior plan, then computes it for real once one exists', () => {
    const plan = schedule({ blocks: [block({ corridorId: 'A-B', date: '2026-08-25', taskIds: ['T1'] })] })

    const noPrevious = planningKpis(plan, null, null)
    expect(noPrevious.find((k) => k.label === 'Schedule stability')!.available).toBe(false)

    const samePlacement = planningKpis(
      plan,
      null,
      schedule({ _id: 'SCH-0', blocks: [block({ corridorId: 'A-B', date: '2026-08-25', taskIds: ['T1'] })] }),
    )
    const stability = samePlacement.find((k) => k.label === 'Schedule stability')!
    expect(stability.available).toBe(true)
    expect((stability as { value: string }).value).toBe('100%')

    const movedPlacement = planningKpis(
      plan,
      null,
      schedule({ _id: 'SCH-0', blocks: [block({ corridorId: 'A-B', date: '2026-08-24', taskIds: ['T1'] })] }),
    )
    expect((movedPlacement.find((k) => k.label === 'Schedule stability') as { value: string }).value).toBe('0%')
  })

  it('computes batching ratio as a real percentage of blocks', () => {
    const plan = schedule({
      metrics: {
        tasksScheduled: 4,
        tasksDeferred: 0,
        blocksUsed: 4,
        crossDepartmentBatches: 1,
        blockMinutesUsed: 400,
        blockMinutesCapacity: 800,
        blockUtilisationPct: 50,
        unusedBlockMinutes: 400,
      },
    })
    const kpis = planningKpis(plan, null, null)
    expect((kpis.find((k) => k.label === 'Batching ratio') as { value: string }).value).toBe('25.0%')
  })

  it('reports a real, checked zero conflict count when byPlan carries no "optimized" key - not "unavailable"', () => {
    // T25/D-046: `byPlan` drops the 'optimized' key entirely once dependency
    // precedence and resource no-overlap became hard constraints, rather
    // than keeping `{ total: 0 }`. A naive `planTotal` read would misreport
    // this as "no data" instead of the real, checked zero it actually is.
    const plan = schedule()
    const zeroConflictReport = {
      byPlan: {},
      conflicts: [],
      notYetDetectable: [],
      checkedAndClear: [],
      note: '',
    }
    const kpis = planningKpis(plan, zeroConflictReport, null)
    const conflictKpi = kpis.find((k) => k.label === 'Conflict count')!
    expect(conflictKpi.available).toBe(true)
    expect((conflictKpi as { value: string }).value).toBe('0')
    expect((conflictKpi as { detail: string }).detail).toContain('Checked, not merely absent')
  })

  it('reports conflict count as genuinely unavailable only when there is no report at all', () => {
    const kpis = planningKpis(schedule(), null, null)
    expect(kpis.find((k) => k.label === 'Conflict count')!.available).toBe(false)
  })

  it('reads a real non-zero conflict count from byPlan when one exists', () => {
    const report = {
      byPlan: { optimized: { total: 3, byType: { RESOURCE_CONTENTION: 3 } } },
      conflicts: [],
      notYetDetectable: [],
      checkedAndClear: [],
      note: '',
    }
    const kpis = planningKpis(schedule(), report, null)
    expect((kpis.find((k) => k.label === 'Conflict count') as { value: string }).value).toBe('3')
  })
})

describe('assetKpis', () => {
  it('marks availability and downtime unavailable, and counts at-risk assets per-asset not per-task', () => {
    const plan = schedule({ blocks: [block({ taskIds: ['T1'] })] })
    // AST-HIGH has two tasks; only one is scheduled, so it still counts once
    // as "at risk" - never twice for its two unaddressed-vs-addressed tasks.
    const tasks = [
      task({ _id: 'T1', assetId: 'AST-HIGH' }),
      task({ _id: 'T2', assetId: 'AST-HIGH' }),
      task({ _id: 'T3', assetId: 'AST-LOW' }),
    ]
    const assets = [
      asset({ _id: 'AST-HIGH', criticalityScore: 90 }),
      asset({ _id: 'AST-LOW', criticalityScore: 10 }),
      asset({ _id: 'AST-MID1', criticalityScore: 20 }),
      asset({ _id: 'AST-MID2', criticalityScore: 30 }),
    ]
    const kpis = assetKpis(plan, tasks, assets)
    expect(kpis.find((k) => k.label === 'Asset availability %')!.available).toBe(false)
    expect(kpis.find((k) => k.label === 'Downtime')!.available).toBe(false)
    expect((kpis.find((k) => k.label === 'High-criticality assets still at risk') as { value: string }).value).toBe('1')
  })
})
