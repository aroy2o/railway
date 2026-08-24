/**
 * Layout logic for the corridor timeline.
 *
 * The only part of this screen with logic worth testing. CLAUDE.md puts
 * frontend coverage last deliberately, and pure rendering is verified visually
 * by screenshot - but grouping and positioning are arithmetic, and arithmetic
 * is cheap to get subtly wrong.
 */
import { describe, expect, it } from 'vitest'
import type { ScheduleBlock } from '../api/apiSlice.ts'
import {
  blockKey,
  blockPosition,
  corridorRowsForDay,
  monthlyReservationRows,
  summariseDays,
} from './gantt.ts'

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
    usedMinutes: 180,
    unusedMinutes: 0,
    taskIds: ['T1'],
    departments: ['Engineering'],
    isCrossDepartmentBatch: false,
    trainImpact: null,
    ...overrides,
  }
}

describe('summariseDays', () => {
  it('covers every day of the horizon, including empty ones', () => {
    const days = summariseDays([block()], '2026-08-24', 7)

    expect(days).toHaveLength(7)
    expect(days[0]).toMatchObject({ date: '2026-08-24', blockCount: 1, taskCount: 1 })
    // An untouched day is a real fact about corridor availability, not
    // something to collapse away.
    expect(days[1]).toMatchObject({ date: '2026-08-25', blockCount: 0, taskCount: 0 })
  })

  it('counts cross-department batches per day', () => {
    const days = summariseDays(
      [
        block({ isCrossDepartmentBatch: true, departments: ['S&T', 'TRD'], taskIds: ['A', 'B'] }),
        block({ date: '2026-08-25' }),
      ],
      '2026-08-24',
      2,
    )

    expect(days[0].batchCount).toBe(1)
    expect(days[0].taskCount).toBe(2)
    expect(days[1].batchCount).toBe(0)
  })
})

describe('corridorRowsForDay', () => {
  it('groups by corridor and keeps only the selected day', () => {
    const rows = corridorRowsForDay(
      [
        block({ corridorId: 'A-B' }),
        block({ corridorId: 'C-D' }),
        block({ corridorId: 'E-F', date: '2026-08-25' }),
      ],
      '2026-08-24',
    )

    expect(rows.map((row) => row.corridorId)).toEqual(['A-B', 'C-D'])
  })

  it('orders busiest corridor first, then by id', () => {
    const rows = corridorRowsForDay(
      [
        block({ corridorId: 'QUIET', usedMinutes: 30 }),
        block({ corridorId: 'BUSY', usedMinutes: 300 }),
      ],
      '2026-08-24',
    )

    expect(rows.map((row) => row.corridorId)).toEqual(['BUSY', 'QUIET'])
  })

  it('orders blocks within a corridor by start time', () => {
    const rows = corridorRowsForDay(
      [
        block({ startMinute: 600, endMinute: 700 }),
        block({ startMinute: 60, endMinute: 120 }),
      ],
      '2026-08-24',
    )

    expect(rows[0].blocks.map((b) => b.startMinute)).toEqual([60, 600])
  })
})

describe('blockPosition', () => {
  it('positions a block as a percentage of the 24-hour day', () => {
    // 06:00-12:00 -> starts a quarter through, spans a quarter.
    const position = blockPosition(block({ startMinute: 360, endMinute: 720 }))

    expect(position.left).toBe('25%')
    expect(position.width).toBe('25%')
  })

  it('floors the width so a very short possession stays visible', () => {
    // A 1-minute block is 0.07% of a day - a hairline nobody could see or hover.
    const position = blockPosition(block({ startMinute: 0, endMinute: 1 }))

    expect(position.width).toBe('1.2%')
  })
})

describe('monthlyReservationRows', () => {
  it('collapses a day\'s blocks to which department(s) hold the corridor, not exact times', () => {
    const rows = monthlyReservationRows(
      [
        block({ corridorId: 'A-B', startMinute: 60, endMinute: 120, departments: ['Engineering'] }),
        block({ corridorId: 'A-B', startMinute: 600, endMinute: 660, departments: ['S&T'] }),
      ],
      '2026-08-24',
      2,
    )

    expect(rows).toHaveLength(1)
    const day1 = rows[0]!.days[0]!
    expect(day1.blockCount).toBe(2)
    expect(day1.departments.sort()).toEqual(['Engineering', 'S&T'])
    // The second day of the horizon carries nothing - kept explicit, not
    // dropped, the same "empty days are a real fact" rule summariseDays uses.
    expect(rows[0]!.days[1]).toMatchObject({ departments: [], blockCount: 0 })
  })

  it('marks a cross-department batch day distinctly', () => {
    const rows = monthlyReservationRows(
      [block({ isCrossDepartmentBatch: true, departments: ['S&T', 'TRD'] })],
      '2026-08-24',
      1,
    )

    expect(rows[0]!.days[0]!.isCrossDepartmentBatch).toBe(true)
  })

  it('orders corridors by how many days of the horizon they reserve, then by id', () => {
    const rows = monthlyReservationRows(
      [
        block({ corridorId: 'QUIET', date: '2026-08-24' }),
        block({ corridorId: 'BUSY', date: '2026-08-24' }),
        block({ corridorId: 'BUSY', date: '2026-08-25' }),
      ],
      '2026-08-24',
      2,
    )

    expect(rows.map((row) => row.corridorId)).toEqual(['BUSY', 'QUIET'])
    expect(rows[0]!.reservedDayCount).toBe(2)
    expect(rows[1]!.reservedDayCount).toBe(1)
  })
})

describe('blockKey', () => {
  it('identifies a block by where and when, not by array position', () => {
    expect(blockKey(block())).toBe('A-B|2026-08-24|0')
  })

  it('distinguishes the same window on different days', () => {
    expect(blockKey(block({ date: '2026-08-25' }))).not.toBe(blockKey(block()))
  })

  it('distinguishes different windows on the same day', () => {
    expect(blockKey(block({ windowIndex: 3 }))).not.toBe(blockKey(block()))
  })
})
