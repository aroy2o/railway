/**
 * Layout maths for the corridor timeline.
 *
 * Pure functions, separated from rendering so the grouping and positioning can
 * be unit-tested without a DOM - the only part of this screen with logic worth
 * testing (CLAUDE.md puts frontend coverage last, deliberately).
 */
import type { ScheduleBlock } from '../api/apiSlice.ts'

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

/** Hour ticks for the axis. Every 3 hours keeps the labels legible at width. */
export const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24]
