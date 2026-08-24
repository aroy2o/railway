import { describe, expect, it } from 'vitest'
import { isUnproven, optionBadgeTone, summariseConsequence, type WhatIfOption } from './whatif.ts'

function option(overrides: Partial<WhatIfOption> = {}): WhatIfOption {
  return {
    label: 'Move to 2026-08-25 window 0',
    kind: 'move',
    taskOutcome: { placed: true, corridorId: 'A-B', date: '2026-08-25', windowIndex: 0 },
    diff: { newlyScheduled: [], newlyDeferred: [], reshuffledCount: 0, reshuffledSample: [] },
    metrics: {},
    reason: '',
    solveSeconds: 0.5,
    status: 'OPTIMAL',
    ...overrides,
  }
}

describe('summariseConsequence', () => {
  it('says plainly when nothing else changes, rather than an empty line', () => {
    expect(summariseConsequence(option())).toBe('nothing else changes')
  })

  it('collapses a reshuffle into a COUNT, never a task-by-task list', () => {
    const withReshuffle = option({
      diff: { newlyScheduled: [], newlyDeferred: [], reshuffledCount: 17, reshuffledSample: ['TSK-1'] },
    })
    const summary = summariseConsequence(withReshuffle)
    expect(summary).toMatch(/17/)
    expect(summary).not.toMatch(/TSK-1/)
  })

  it('names a real displacement as the headline consequence', () => {
    const displaces = option({
      diff: { newlyScheduled: [], newlyDeferred: ['TSK-9'], reshuffledCount: 0, reshuffledSample: [] },
    })
    expect(summariseConsequence(displaces)).toMatch(/displaces 1 task/)
  })

  it('does not claim a re-solve happened for the traffic-block option', () => {
    const trafficBlock = option({ kind: 'traffic-block', diff: null })
    expect(summariseConsequence(trafficBlock)).toMatch(/not a re-solve/)
  })
})

describe('isUnproven', () => {
  it('is false for a proven-optimal option and for the non-solved traffic-block option', () => {
    expect(isUnproven(option({ status: 'OPTIMAL' }))).toBe(false)
    expect(isUnproven(option({ status: null }))).toBe(false)
  })

  it('flags an option the solver could not prove optimal in its shorter budget', () => {
    expect(isUnproven(option({ status: 'FEASIBLE' }))).toBe(true)
  })
})

describe('optionBadgeTone', () => {
  it('is good when nothing is displaced, warn when something is', () => {
    expect(optionBadgeTone(option())).toBe('good')
    expect(
      optionBadgeTone(
        option({ diff: { newlyScheduled: [], newlyDeferred: ['TSK-1'], reshuffledCount: 0, reshuffledSample: [] } }),
      ),
    ).toBe('warn')
  })

  it('is neutral for the traffic-block option - it is not a trade-off, it is the only option', () => {
    expect(optionBadgeTone(option({ kind: 'traffic-block', diff: null }))).toBe('neutral')
  })
})
