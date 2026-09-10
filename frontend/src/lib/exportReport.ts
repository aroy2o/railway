/**
 * Exportable report - DRM oversight, PRD Section 8 screen 6, TX6.
 *
 * CSV, not PDF: no PDF library exists anywhere in this project (checked
 * before writing this - `package.json` in both `/backend` and `/frontend`),
 * and a KPI rollup is tabular data a DRM would paste into a spreadsheet
 * regardless of what format it arrives in. Adding a PDF-rendering dependency
 * for a hackathon prototype's one export button is the kind of scope this
 * project's own tech-stack section explicitly leaves to judgement, and CSV
 * needs none.
 *
 * Built from the SAME `KpiCategory[]` the page already renders
 * (`buildKpiHierarchy`'s output), not a second computation - what a DRM
 * downloads is guaranteed to match what they were just looking at on
 * screen, because it is not a separate code path that could drift from it.
 */
import type { KpiCategory } from './oversight.ts'
import type { TrendSeries } from './trends.ts'

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(',')
}

export interface ReportMeta {
  scheduleId: string
  generatedAt: string
  horizon: string
}

/**
 * Two sections in one file: the current KPI snapshot (always present), and
 * the trend history (only when `hasEnoughHistory` judged there was enough of
 * it - see `trends.ts`). A CSV with a "not enough history yet" text row
 * instead of a trend table is still honest; a CSV with two real data points
 * padded into a "trend" would not be.
 */
export function buildKpiReportCsv(
  meta: ReportMeta,
  categories: KpiCategory[],
  trend: { series: TrendSeries[]; hasEnoughHistory: boolean } | null,
): string {
  const lines: string[] = [
    csvRow(['Rex Planner - DRM oversight report']),
    csvRow(['Schedule', meta.scheduleId]),
    csvRow(['Generated at', meta.generatedAt]),
    csvRow(['Horizon', meta.horizon]),
    csvRow([
      'Note',
      'Prototype uses synthetic maintenance data anchored to real railway infrastructure and timetable data.',
    ]),
    '',
    csvRow(['Category', 'KPI', 'Value', 'Detail / reason']),
  ]

  for (const { category, kpis } of categories) {
    for (const kpi of kpis) {
      lines.push(
        kpi.available
          ? csvRow([category, kpi.label, kpi.value, kpi.detail])
          : csvRow([category, kpi.label, 'not tracked', kpi.reason]),
      )
    }
  }

  lines.push('', csvRow(['Trend history']))
  if (!trend || !trend.hasEnoughHistory) {
    lines.push(
      csvRow([
        `Not enough plan history yet to show a trend (fewer than the minimum real generations needed).`,
      ]),
    )
  } else {
    for (const series of trend.series) {
      lines.push('', csvRow([series.label, series.detail]))
      lines.push(csvRow(['Schedule', 'Generated at', `Value (${series.unit})`]))
      for (const point of series.points) {
        lines.push(csvRow([point.scheduleId, point.generatedAt, point.value.toFixed(2)]))
      }
    }
  }

  return lines.join('\n')
}

/** File name: stable and sortable, no characters a filesystem would reject. */
export function reportFileName(scheduleId: string): string {
  return `drm-oversight-${scheduleId}.csv`
}
