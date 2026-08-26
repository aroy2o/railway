import { describe, expect, it } from 'vitest'
import { buildKpiReportCsv, reportFileName } from './exportReport.ts'
import type { KpiCategory } from './oversight.ts'
import type { TrendSeries } from './trends.ts'

const meta = { scheduleId: 'SCH-1', generatedAt: '2026-08-25T09:00:00Z', horizon: 'weekly' }

const categories: KpiCategory[] = [
  {
    category: 'Planning',
    kpis: [
      { label: 'Block utilisation', available: true, value: '46.0%', detail: '4711 of 10240 min.' },
      { label: 'Predicted failure risk reduced', available: false, reason: 'No before/after figure to report.' },
    ],
  },
]

describe('buildKpiReportCsv', () => {
  it('includes every KPI, available and unavailable alike, with the same words shown on screen', () => {
    const csv = buildKpiReportCsv(meta, categories, null)
    expect(csv).toContain('Block utilisation')
    expect(csv).toContain('46.0%')
    expect(csv).toContain('Predicted failure risk reduced')
    expect(csv).toContain('not tracked')
    expect(csv).toContain('No before/after figure to report.')
  })

  it('states honestly when there is not enough history for a trend, rather than omitting the section', () => {
    const csv = buildKpiReportCsv(meta, categories, { series: [], hasEnoughHistory: false })
    expect(csv).toContain('Not enough plan history yet')
  })

  it('writes real trend rows when there is enough history, one row per real point', () => {
    const series: TrendSeries[] = [
      {
        key: 'utilisation',
        label: 'Block utilisation',
        unit: '%',
        detail: 'test detail',
        points: [
          { scheduleId: 'SCH-1', generatedAt: '2026-08-24T00:00:00Z', value: 40 },
          { scheduleId: 'SCH-2', generatedAt: '2026-08-25T00:00:00Z', value: 46 },
          { scheduleId: 'SCH-3', generatedAt: '2026-08-26T00:00:00Z', value: 51 },
        ],
      },
    ]
    const csv = buildKpiReportCsv(meta, categories, { series, hasEnoughHistory: true })
    expect(csv).toContain('SCH-1')
    expect(csv).toContain('40.00')
    expect(csv).toContain('SCH-3')
    expect(csv).toContain('51.00')
    expect(csv).not.toContain('Not enough plan history')
  })

  it('escapes a comma or quote inside a detail string so the CSV stays parseable', () => {
    const withComma: KpiCategory[] = [
      {
        category: 'Planning',
        kpis: [
          { label: 'Test', available: true, value: '1', detail: 'a, b, and "c"' },
        ],
      },
    ]
    const csv = buildKpiReportCsv(meta, withComma, null)
    expect(csv).toContain('"a, b, and ""c"""')
  })

  it('carries the honesty banner and schedule identity so the file is self-describing offline', () => {
    const csv = buildKpiReportCsv(meta, categories, null)
    expect(csv).toContain('Prototype uses synthetic maintenance data')
    expect(csv).toContain('SCH-1')
  })
})

describe('reportFileName', () => {
  it('is stable and includes the schedule id', () => {
    expect(reportFileName('SCH-20260825090000')).toBe('drm-oversight-SCH-20260825090000.csv')
  })
})
