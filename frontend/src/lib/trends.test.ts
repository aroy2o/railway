import { describe, expect, it } from 'vitest'
import {
  MIN_POINTS_FOR_TREND,
  buildTrendSeries,
  hasEnoughHistory,
  sameHorizonHistory,
  seriesRange,
  type ScheduleSummary,
} from './trends.ts'

function summary(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    _id: 'SCH-1',
    generatedAt: '2026-08-24T00:00:00Z',
    horizonDays: 7,
    metrics: {
      tasksScheduled: 35,
      tasksDeferred: 54,
      blocksUsed: 33,
      crossDepartmentBatches: 2,
      blockMinutesUsed: 4711,
      blockMinutesCapacity: 10240,
      blockUtilisationPct: 46.01,
      unusedBlockMinutes: 5529,
    },
    ...overrides,
  }
}

describe('sameHorizonHistory', () => {
  it('keeps only schedules on the given horizon, sorted oldest first', () => {
    const schedules = [
      summary({ _id: 'SCH-3', generatedAt: '2026-08-26T00:00:00Z', horizonDays: 7 }),
      summary({ _id: 'SCH-1', generatedAt: '2026-08-24T00:00:00Z', horizonDays: 7 }),
      summary({ _id: 'SCH-M', generatedAt: '2026-08-25T00:00:00Z', horizonDays: 30 }),
      summary({ _id: 'SCH-2', generatedAt: '2026-08-25T00:00:00Z', horizonDays: 7 }),
    ]
    const result = sameHorizonHistory(schedules, 7)
    expect(result.map((s) => s._id)).toEqual(['SCH-1', 'SCH-2', 'SCH-3'])
  })

  it('never mixes a monthly plan into a weekly trend, or vice versa', () => {
    const schedules = [summary({ horizonDays: 30 })]
    expect(sameHorizonHistory(schedules, 7)).toEqual([])
  })
})

describe('hasEnoughHistory', () => {
  it(`requires at least ${MIN_POINTS_FOR_TREND} points`, () => {
    expect(hasEnoughHistory([summary(), summary()])).toBe(false)
    expect(hasEnoughHistory([summary(), summary(), summary()])).toBe(true)
  })
})

describe('buildTrendSeries', () => {
  it('reads real metrics fields, not invented numbers', () => {
    const schedules = [
      summary({
        _id: 'SCH-1',
        metrics: {
          tasksScheduled: 10,
          tasksDeferred: 5,
          blocksUsed: 8,
          crossDepartmentBatches: 2,
          blockMinutesUsed: 400,
          blockMinutesCapacity: 800,
          blockUtilisationPct: 50,
          unusedBlockMinutes: 120,
        },
      }),
    ]
    const series = buildTrendSeries(schedules)

    const utilisation = series.find((s) => s.key === 'utilisation')!
    expect(utilisation.points[0]!.value).toBe(50)

    const batching = series.find((s) => s.key === 'batching')!
    expect(batching.points[0]!.value).toBe(25) // 2 of 8 blocks = 25%

    const scheduled = series.find((s) => s.key === 'scheduled')!
    expect(scheduled.points[0]!.value).toBe(10)

    const unused = series.find((s) => s.key === 'unused')!
    expect(unused.points[0]!.value).toBe(2) // 120 min = 2 h
  })

  it('never divides by zero when a schedule has no blocks', () => {
    const schedules = [
      summary({
        metrics: {
          tasksScheduled: 0,
          tasksDeferred: 89,
          blocksUsed: 0,
          crossDepartmentBatches: 0,
          blockMinutesUsed: 0,
          blockMinutesCapacity: 0,
          blockUtilisationPct: 0,
          unusedBlockMinutes: 0,
        },
      }),
    ]
    const batching = buildTrendSeries(schedules).find((s) => s.key === 'batching')!
    expect(batching.points[0]!.value).toBe(0)
    expect(Number.isFinite(batching.points[0]!.value)).toBe(true)
  })
})

describe('seriesRange', () => {
  it('floors max at 1 so an all-zero series still has a drawable range', () => {
    expect(seriesRange([{ scheduleId: 'A', generatedAt: '', value: 0 }])).toEqual({ min: 0, max: 1 })
  })

  it('spans the real min/max of the series, including negative headroom never going below zero unless a value does', () => {
    const points = [
      { scheduleId: 'A', generatedAt: '', value: 10 },
      { scheduleId: 'B', generatedAt: '', value: 80 },
    ]
    expect(seriesRange(points)).toEqual({ min: 0, max: 80 })
  })

  it('handles an empty series without throwing', () => {
    expect(seriesRange([])).toEqual({ min: 0, max: 1 })
  })
})
