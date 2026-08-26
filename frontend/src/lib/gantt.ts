/**
 * Layout maths for the corridor timeline.
 *
 * Pure functions, separated from rendering so the grouping and positioning can
 * be unit-tested without a DOM - the only part of this screen with logic worth
 * testing (CLAUDE.md puts frontend coverage last, deliberately).
 */
import type { Department, ScheduleBlock } from '../api/apiSlice.ts'

export const MINUTES_PER_DAY = 1440

export interface CorridorRow {
  corridorId: string
  blocks: ScheduleBlock[]
  usedMinutes: number
}

export interface DaySummary {
  date: string
  blockCount: number
  taskCount: number
  batchCount: number
}

/**
 * One entry per day of the horizon, including days with no work.
 *
 * Empty days are kept deliberately: a week where six days are untouched is a
 * fact about corridor availability worth seeing, and silently collapsing them
 * would make the plan look denser than it is.
 */
export function summariseDays(blocks: ScheduleBlock[], horizonStart: string, horizonDays: number): DaySummary[] {
  const byDate = new Map<string, ScheduleBlock[]>()
  for (const block of blocks) {
    const bucket = byDate.get(block.date) ?? []
    bucket.push(block)
    byDate.set(block.date, bucket)
  }

  const start = new Date(`${horizonStart}T00:00:00Z`)
  return Array.from({ length: horizonDays }, (_, offset) => {
    const day = new Date(start)
    day.setUTCDate(start.getUTCDate() + offset)
    const date = day.toISOString().slice(0, 10)
    const dayBlocks = byDate.get(date) ?? []
    return {
      date,
      blockCount: dayBlocks.length,
      taskCount: dayBlocks.reduce((total, block) => total + block.taskIds.length, 0),
      batchCount: dayBlocks.filter((block) => block.isCrossDepartmentBatch).length,
    }
  })
}

/**
 * Which day the timeline should open on.
 *
 * D-040 (T12) chose "first day with a cross-department batch, else the
 * busiest day" over the actual busiest day alone, because the busiest day
 * on the real corpus showed no coordination at all. That heuristic never
 * considered the real clock, so a Controller opening the dashboard mid-week
 * against an already-published plan would land on Monday even when today is
 * Wednesday - showing a day that has already passed instead of the
 * operationally relevant one (D-075).
 *
 * `today` takes priority whenever it falls inside the horizon; D-040's
 * heuristic is the fallback for everything else - a historical schedule
 * viewed after its horizon has fully elapsed, or one generated for a future
 * week that has not started yet.
 */
export function defaultSelectedDay(days: DaySummary[], todayIso: string): string {
  const today = days.find((day) => day.date === todayIso)
  if (today) return today.date

  const firstBatchDay = days.find((day) => day.batchCount > 0)
  if (firstBatchDay) return firstBatchDay.date

  const busiestDay = days.reduce((best, day) => (day.blockCount > best.blockCount ? day : best), days[0])
  return busiestDay?.date ?? todayIso
}

/**
 * Group one day's blocks into corridor rows.
 *
 * Rows are ordered by how much of the day each corridor is under possession,
 * so the busiest corridors sit at the top where they are read first. Within a
 * row blocks are ordered by start time, which is also the order the free
 * windows come out of T3.
 */
export function corridorRowsForDay(blocks: ScheduleBlock[], date: string): CorridorRow[] {
  const rows = new Map<string, ScheduleBlock[]>()
  for (const block of blocks) {
    if (block.date !== date) continue
    const bucket = rows.get(block.corridorId) ?? []
    bucket.push(block)
    rows.set(block.corridorId, bucket)
  }

  return [...rows.entries()]
    .map(([corridorId, corridorBlocks]) => ({
      corridorId,
      blocks: [...corridorBlocks].sort((a, b) => a.startMinute - b.startMinute),
      usedMinutes: corridorBlocks.reduce((total, block) => total + block.usedMinutes, 0),
    }))
    .sort((a, b) => b.usedMinutes - a.usedMinutes || a.corridorId.localeCompare(b.corridorId))
}

/** Position a block on a 24-hour track, as percentages. */
export function blockPosition(block: ScheduleBlock): { left: string; width: string } {
  const left = (block.startMinute / MINUTES_PER_DAY) * 100
  const width = ((block.endMinute - block.startMinute) / MINUTES_PER_DAY) * 100
  return {
    left: `${left}%`,
    // Floor the width so a very short possession is still visible and clickable
    // rather than collapsing to a hairline.
    width: `${Math.max(width, 1.2)}%`,
  }
}

/**
 * Stable identity for a block across renders.
 *
 * A block has no id of its own - it is defined by where and when it is - so
 * corridor + date + window index is the natural key. Used to keep an override
 * selection pointing at the right block after the plan changes underneath it.
 */
export function blockKey(block: Pick<ScheduleBlock, 'corridorId' | 'date' | 'windowIndex'>): string {
  return `${block.corridorId}|${block.date}|${block.windowIndex}`
}

/** Hour ticks for the axis. Every 3 hours keeps the labels legible at width. */
export const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24]

/**
 * T28 (PRD Section 13) - one day's reservation on one corridor, at the
 * granularity a monthly plan is FOR: which department(s) hold the corridor
 * that day, not the exact minute. `departments` is empty on a day with no
 * block, kept explicit for the same reason `summariseDays` keeps empty days -
 * a corridor untouched for three weeks is a real fact, not something to
 * collapse away.
 */
export interface ReservationDay {
  date: string
  departments: Department[]
  isCrossDepartmentBatch: boolean
  blockCount: number
}

export interface ReservationRow {
  corridorId: string
  days: ReservationDay[]
  /** Days of the horizon carrying at least one block - for sort order. */
  reservedDayCount: number
}

/**
 * Roll the SAME real CP-SAT output up to corridor-day resolution.
 *
 * This is display aggregation over a real solve, not a second model (see
 * docs/DECISIONS.md D-070): a monthly plan is generated by the identical
 * `solve_schedule` a weekly one is, run over more days. What changes here is
 * only how many blocks in one day get collapsed into a single reservation
 * cell - exact start/end times are deliberately dropped, matching PRD 13's
 * "allocate corridor-days per department cluster (reservation-level)".
 */
export function monthlyReservationRows(
  blocks: ScheduleBlock[],
  horizonStart: string,
  horizonDays: number,
): ReservationRow[] {
  const dayDates = summariseDays(blocks, horizonStart, horizonDays).map((day) => day.date)

  const byCorridor = new Map<string, ScheduleBlock[]>()
  for (const block of blocks) {
    const bucket = byCorridor.get(block.corridorId) ?? []
    bucket.push(block)
    byCorridor.set(block.corridorId, bucket)
  }

  return [...byCorridor.entries()]
    .map(([corridorId, corridorBlocks]) => {
      const byDate = new Map<string, ScheduleBlock[]>()
      for (const block of corridorBlocks) {
        const bucket = byDate.get(block.date) ?? []
        bucket.push(block)
        byDate.set(block.date, bucket)
      }
      const days: ReservationDay[] = dayDates.map((date) => {
        const dayBlocks = byDate.get(date) ?? []
        return {
          date,
          departments: [...new Set(dayBlocks.flatMap((b) => b.departments))],
          isCrossDepartmentBatch: dayBlocks.some((b) => b.isCrossDepartmentBatch),
          blockCount: dayBlocks.length,
        }
      })
      return {
        corridorId,
        days,
        reservedDayCount: days.filter((day) => day.blockCount > 0).length,
      }
    })
    .sort((a, b) => b.reservedDayCount - a.reservedDayCount || a.corridorId.localeCompare(b.corridorId))
}
