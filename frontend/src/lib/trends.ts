/**
 * DRM oversight monthly trends - PRD Section 8 screen 6, TX6.
 *
 * "Monthly trend charts" is PRD's phrase for what this actually is: a
 * time-series of KPIs across every real plan this project has generated, not
 * literally month-over-month data - a hackathon prototype's real operating
 * history runs from hours to a few days, never months, and a chart that
 * implied otherwise would be exactly the kind of dishonest smoothing CLAUDE.md
 * forbids. So this module's job is stated as narrowly as the data allows: it
 * plots real `ScheduleMetrics` from real generations, oldest first, and it
 * refuses to call fewer than `MIN_POINTS_FOR_TREND` points a "trend" - see
 * `hasEnoughHistory`.
 *
 * Filtered to the CURRENT plan's horizon type only, for the same reason
 * `oversight.ts`'s `scheduleStability` KPI already is (docs/DECISIONS.md
 * D-070's note): a weekly plan's `tasksScheduled` and a 30-day monthly plan's
 * are not the same measurement, so mixing them into one line would read as a
 * quality swing that is really just a horizon-length artefact.
 */
import type { Schedule, ScheduleMetrics } from '../api/apiSlice.ts'

/** The light list shape `getSchedules` returns - no `blocks`, but `metrics`. */
export type ScheduleSummary = Pick<
  Schedule,
  '_id' | 'generatedAt' | 'horizonDays' | 'metrics'
>

export interface TrendPoint {
  scheduleId: string
  generatedAt: string
  value: number
}

export interface TrendSeries {
  key: string
  label: string
  unit: string
  detail: string
  points: TrendPoint[]
}

/**
 * Below this many real points, a line is two dots and a guess at what
 * happens between them - not a trend. Three is the minimum that can show a
 * DIRECTION (up, down, flat) rather than merely a before/after delta.
 */
export const MIN_POINTS_FOR_TREND = 3

/** Only plans on the same horizon as the one currently open (D-070's rule). */
export function sameHorizonHistory(
  schedules: ScheduleSummary[],
  horizonDays: number,
): ScheduleSummary[] {
  return schedules
    .filter((s) => s.horizonDays === horizonDays)
    .slice()
    .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))
}

export function hasEnoughHistory(schedules: ScheduleSummary[]): boolean {
  return schedules.length >= MIN_POINTS_FOR_TREND
}

function series(
  key: string,
  label: string,
  unit: string,
  detail: string,
  schedules: ScheduleSummary[],
  read: (metrics: ScheduleMetrics) => number,
): TrendSeries {
  return {
    key,
    label,
    unit,
    detail,
    points: schedules.map((s) => ({
      scheduleId: s._id,
      generatedAt: s.generatedAt,
      value: read(s.metrics),
    })),
  }
}

/**
 * The four series shown, chosen for being both PRD 14-named and genuinely
 * comparable across re-solves at the same horizon: two percentages, a count,
 * and an hours figure - one metric per line means no unit confusion in the
 * axis.
 */
export function buildTrendSeries(schedules: ScheduleSummary[]): TrendSeries[] {
  return [
    series(
      'utilisation',
      'Block utilisation',
      '%',
      'PRD 14 Planning. Never read alone elsewhere on this dashboard (D-031) - here it is read only against its own history, not against a baseline.',
      schedules,
      (m) => m.blockUtilisationPct,
    ),
    series(
      'batching',
      'Batching ratio',
      '%',
      'PRD 14 Planning. Share of used blocks serving two or more departments in one possession.',
      schedules,
      (m) => (m.blocksUsed > 0 ? (100 * m.crossDepartmentBatches) / m.blocksUsed : 0),
    ),
    series(
      'scheduled',
      'Tasks scheduled',
      'tasks',
      'PRD 14 Maintenance. Tasks the plan places into a block - not "completed" (no execution tracking, oversight.ts).',
      schedules,
      (m) => m.tasksScheduled,
    ),
    series(
      'unused',
      'Unused block hours',
      'h',
      'PRD 14 Operations. Free time inside an opened window that no task claimed.',
      schedules,
      (m) => m.unusedBlockMinutes / 60,
    ),
  ]
}

/** Bounds for the y-axis, with a floor of 1 so a flat-zero series still draws a line, not a divide-by-zero. */
export function seriesRange(points: TrendPoint[]): { min: number; max: number } {
  if (points.length === 0) return { min: 0, max: 1 }
  const values = points.map((p) => p.value)
  const min = Math.min(0, ...values)
  const max = Math.max(1, ...values)
  return { min, max }
}
