/**
 * D-031's framing rules, as tests.
 *
 * The point of extracting this logic was to stop the honesty rules being prose
 * a layout could drift away from. These assert the rules directly, so a future
 * change that headlines throughput or splits utilisation from its conflict
 * count fails here rather than at a dry run.
 */
import { describe, expect, it } from 'vitest'
import {
  buildMetricRows,
  buildRateComparisonRows,
  headlineRows,
  supportingRows,
  type ComparisonToBaseline,
} from './comparison.ts'

const REAL: ComparisonToBaseline = {
  contestableTaskCount: 36,
  structurallyImpossibleCount: 53,
  optimized: {
    contestableScheduled: 36,
    crossDepartmentBatches: 2,
    doubleBookings: 0,
    doubleBookedMinutes: 0,
    overSubscribedWindows: 0,
    blockMinutesUsed: 4880,
    blockUtilisationPct: 74.33,
  },
  baseline: {
    contestableScheduled: 36,
    crossDepartmentBatches: 0,
    doubleBookings: 6,
    doubleBookedMinutes: 605,
    overSubscribedWindows: 3,
    blockMinutesUsed: 4880,
    blockUtilisationPct: 77.01,
  },
  caveats: ['a', 'b', 'c'],
}

/** D-093's three KPI rows, real values - shared by the row-builder tests below and `buildRateComparisonRows`'s. */
const WITH_KPIS: ComparisonToBaseline = {
  ...REAL,
  contestableTaskCount: 578,
  criticalContestableCount: 30,
  highRiskContestableCount: 145,
  riskFraming: 'Calibrated LightGBM failure-risk model... does not predict real asset failures.',
  optimized: {
    ...REAL.optimized,
    contestableScheduled: 513,
    contestableWithinSla: 488,
    criticalScheduled: 29,
    highRiskScheduled: 140,
  },
  baseline: {
    ...REAL.baseline,
    contestableScheduled: 577,
    contestableWithinSla: 545,
    criticalScheduled: 30,
    highRiskScheduled: 145,
  },
}

describe('D-031 rule: conflicts lead, throughput does not', () => {
  it('orders double-bookings and batching first', () => {
    const rows = buildMetricRows(REAL)

    expect(rows.map((row) => row.key).slice(0, 2)).toEqual(['doubleBookings', 'batches'])
  })

  it('never marks scheduled-task count as a headline metric', () => {
    const keys = headlineRows(buildMetricRows(REAL)).map((row) => row.key)

    expect(keys).not.toContain('scheduled')
  })

  it('tags equal throughput as no-difference, not a win', () => {
    const scheduled = buildMetricRows(REAL).find((row) => row.key === 'scheduled')!

    expect(scheduled.verdict).toBe('no-difference')
    expect(scheduled.note).toMatch(/no throughput advantage/i)
  })

  it('would report a real throughput difference if one ever appeared', () => {
    const diverged = {
      ...REAL,
      baseline: { ...REAL.baseline, contestableScheduled: 30 },
    }

    const scheduled = buildMetricRows(diverged).find((row) => row.key === 'scheduled')!
    expect(scheduled.verdict).toBe('optimizer-better')
  })

  it('tags a LOWER optimizer count as fewer-by-design, never as a win', () => {
    // T24's real, live case: the optimizer schedules one fewer contestable
    // task than the baseline (TSK-00025, correctly held back for its PRD 9.7
    // prerequisite). Tagging this `optimizer-better` would render a green
    // "improvement" badge over a SMALLER number for the optimizer - the
    // mirror of the utilisation trap this module already guards against.
    const diverged = {
      ...REAL,
      optimized: { ...REAL.optimized, contestableScheduled: 35 },
    }

    const scheduled = buildMetricRows(diverged).find((row) => row.key === 'scheduled')!
    expect(scheduled.verdict).toBe('optimizer-fewer-by-design')
    expect(scheduled.verdict).not.toBe('optimizer-better')
    expect(scheduled.note).toMatch(/prerequisite/i)
    expect(scheduled.note).not.toMatch(/no throughput advantage/i)
  })
})

describe('D-031 rule: utilisation cannot be shown alone', () => {
  it('carries its conflict count as a paired metric', () => {
    const utilisation = buildMetricRows(REAL).find((row) => row.key === 'utilisation')!

    expect(utilisation.pairedWith).toBeDefined()
    expect(utilisation.pairedWith?.label).toMatch(/over-subscribed/i)
    expect(utilisation.pairedWith?.baseline).toBe('3')
  })

  it('names the baseline’s higher number as a defect, not a win', () => {
    const utilisation = buildMetricRows(REAL).find((row) => row.key === 'utilisation')!

    expect(utilisation.verdict).toBe('baseline-higher-but-worse')
    expect(utilisation.note).toMatch(/defect/i)
  })
})

describe('T29 Phase 1 (D-084): the split-only capability row', () => {
  it('is absent when splitOnlyTaskCount is missing (a pre-T29 stored schedule)', () => {
    const keys = buildMetricRows(REAL).map((row) => row.key)

    expect(keys).not.toContain('splitOnly')
  })

  it('is absent when splitOnlyTaskCount is explicitly zero', () => {
    const withZero: ComparisonToBaseline = { ...REAL, splitOnlyTaskCount: 0 }
    const keys = buildMetricRows(withZero).map((row) => row.key)

    expect(keys).not.toContain('splitOnly')
  })

  it('appears as a headline row, never folded into the contestable count, when real', () => {
    const withSplitting: ComparisonToBaseline = {
      ...REAL,
      splitOnlyTaskCount: 32,
      optimized: { ...REAL.optimized, splitOnlyScheduled: 29 },
      baseline: { ...REAL.baseline, splitOnlyScheduled: 0 },
    }
    const rows = buildMetricRows(withSplitting)
    const splitOnly = rows.find((row) => row.key === 'splitOnly')

    expect(splitOnly).toBeDefined()
    expect(splitOnly?.baseline).toBe('0 / 32')
    expect(splitOnly?.optimized).toBe('29 / 32')
    expect(splitOnly?.verdict).toBe('optimizer-better')
    expect(headlineRows(rows).map((row) => row.key)).toContain('splitOnly')
    // The contestable denominator must stay exactly 36 - splitting must never
    // inflate it.
    const scheduled = rows.find((row) => row.key === 'scheduled')!
    expect(scheduled.baseline).toBe('36 / 36')
  })
})

describe('D-093: fragmentation is absent on a pre-D-093 stored schedule', () => {
  it('is absent when blocksUsed is missing on either side', () => {
    const keys = buildMetricRows(REAL).map((row) => row.key)

    expect(keys).not.toContain('fragmentation')
  })

  it('appears as a SUPPORTING row when real, never headline - it is confounded by volume, not a clean win', () => {
    const withFragmentation: ComparisonToBaseline = {
      ...REAL,
      optimized: { ...REAL.optimized, contestableScheduled: 513, blocksUsed: 438 },
      baseline: { ...REAL.baseline, contestableScheduled: 577, blocksUsed: 487 },
      contestableTaskCount: 578,
    }
    const rows = buildMetricRows(withFragmentation)
    const fragmentation = rows.find((row) => row.key === 'fragmentation')

    expect(fragmentation).toBeDefined()
    expect(fragmentation?.baseline).toBe('487')
    expect(fragmentation?.optimized).toBe('438')
    expect(fragmentation?.verdict).toBe('optimizer-fewer-by-design')
    // The real point of this row: it must not oversell the gap as pure
    // packing efficiency when it is mostly the volume difference showing
    // through - same discipline as the utilisation trap.
    expect(fragmentation?.note).toMatch(/close to proportional/i)
    expect(headlineRows(rows).map((row) => row.key)).not.toContain('fragmentation')
    expect(supportingRows(rows).map((row) => row.key)).toContain('fragmentation')
  })

  it('is computed, never asserted: equal possessions tags no-difference', () => {
    const equal: ComparisonToBaseline = {
      ...REAL,
      optimized: { ...REAL.optimized, blocksUsed: 100 },
      baseline: { ...REAL.baseline, blocksUsed: 100 },
    }
    const fragmentation = buildMetricRows(equal).find((row) => row.key === 'fragmentation')

    expect(fragmentation?.verdict).toBe('no-difference')
  })

  it('is computed, never asserted: MORE possessions for the optimizer is reported honestly, not hidden', () => {
    const more: ComparisonToBaseline = {
      ...REAL,
      optimized: { ...REAL.optimized, blocksUsed: 120 },
      baseline: { ...REAL.baseline, blocksUsed: 100 },
    }
    const fragmentation = buildMetricRows(more).find((row) => row.key === 'fragmentation')

    expect(fragmentation?.verdict).toBe('optimizer-better')
    expect(fragmentation?.note).toMatch(/more possessions/i)
  })
})

describe('D-093: SLA compliance, priority coverage and risk reduction', () => {

  it('is absent for all three when the new fields are missing (a pre-D-093 schedule)', () => {
    const keys = buildMetricRows(REAL).map((row) => row.key)

    expect(keys).not.toContain('slaCompliance')
    expect(keys).not.toContain('priorityCoverage')
    expect(keys).not.toContain('riskReduction')
  })

  it('renders SLA compliance against the fixed contestable denominator, never the baseline’s own', () => {
    const row = buildMetricRows(WITH_KPIS).find((r) => r.key === 'slaCompliance')!

    expect(row.baseline).toBe('545 / 578')
    expect(row.optimized).toBe('488 / 578')
    // Baseline's raw count is higher only because it schedules more overall -
    // must never render as an unqualified baseline win.
    expect(row.verdict).toBe('optimizer-fewer-by-design')
    expect(row.note).toMatch(/on time 95% .* baseline's 94%/i)
  })

  it('hides priority coverage when the high-severity bucket is empty (0, not "0 / 0")', () => {
    const empty: ComparisonToBaseline = { ...WITH_KPIS, criticalContestableCount: 0 }
    const keys = buildMetricRows(empty).map((row) => row.key)

    expect(keys).not.toContain('priorityCoverage')
  })

  it('renders priority coverage against the fixed high-severity denominator', () => {
    const row = buildMetricRows(WITH_KPIS).find((r) => r.key === 'priorityCoverage')!

    expect(row.baseline).toBe('30 / 30')
    expect(row.optimized).toBe('29 / 30')
    expect(row.verdict).toBe('optimizer-fewer-by-design')
  })

  it('hides risk reduction entirely when riskFraming is null - never a number without its caveat', () => {
    const noRisk: ComparisonToBaseline = { ...WITH_KPIS, riskFraming: null }
    const keys = buildMetricRows(noRisk).map((row) => row.key)

    expect(keys).not.toContain('riskReduction')
  })

  it('carries risk.py’s FRAMING verbatim in a caveatBox at equal weight to the number', () => {
    const row = buildMetricRows(WITH_KPIS).find((r) => r.key === 'riskReduction')!

    expect(row.baseline).toBe('145 / 145')
    expect(row.optimized).toBe('140 / 145')
    expect(row.caveatBox).toBeDefined()
    expect(row.caveatBox?.note).toBe(WITH_KPIS.riskFraming)
    // Never framed as "risk reduced" - neither engine reduces risk, only
    // chooses what to schedule.
    expect(row.label.toLowerCase()).not.toContain('risk reduced')
  })
})

describe('every row explains itself', () => {
  it('gives all rows a note and a verdict', () => {
    for (const row of buildMetricRows(REAL)) {
      expect(row.note.length).toBeGreaterThan(20)
      expect(row.verdict).toBeTruthy()
    }
  })

  it('keeps the contestable denominator attached to the count', () => {
    const scheduled = buildMetricRows(REAL).find((row) => row.key === 'scheduled')!

    expect(scheduled.baseline).toBe('36 / 36')
    expect(scheduled.optimized).toBe('36 / 36')
  })
})

describe('buildRateComparisonRows: the Comparison page dumbbell chart', () => {
  it('includes only `scheduled` when the D-093 KPI fields are absent (a pre-D-093 schedule)', () => {
    const keys = buildRateComparisonRows(REAL).map((row) => row.key)

    expect(keys).toEqual(['scheduled'])
  })

  it('never includes fragmentation - a raw count pair, not a rate', () => {
    const keys = buildRateComparisonRows(WITH_KPIS).map((row) => row.key)

    expect(keys).not.toContain('fragmentation')
  })

  it('rates `scheduled` against the fixed contestable denominator, matching its table row', () => {
    const row = buildRateComparisonRows(WITH_KPIS).find((r) => r.key === 'scheduled')!

    expect(row.baselinePct).toBe(100) // 577 / 578, rounded
    expect(row.optimizedPct).toBe(89) // 513 / 578, rounded
  })

  /**
   * The one row where the chart's denominator deliberately diverges from the
   * table's: each side's own scheduled count, not the shared
   * `contestableTaskCount` - the same "fairer reading" `slaComplianceRow`'s
   * own note argues for. Asserted against the exact percentages that note
   * already states (`on time 95% ... baseline's 94%`, tested above), so the
   * chart and the table can never silently disagree about which number is
   * "the" SLA rate.
   */
  it('rates SLA compliance against each side’s OWN scheduled count, not the shared denominator', () => {
    const row = buildRateComparisonRows(WITH_KPIS).find((r) => r.key === 'slaCompliance')!

    expect(row.baselinePct).toBe(94) // 545 / 577 (baseline's own scheduled), not 545 / 578
    expect(row.optimizedPct).toBe(95) // 488 / 513 (optimized's own scheduled), not 488 / 578
  })

  it('rates priority coverage and risk reduction against their fixed denominators', () => {
    const rows = buildRateComparisonRows(WITH_KPIS)
    const priorityCoverage = rows.find((r) => r.key === 'priorityCoverage')!
    const riskReduction = rows.find((r) => r.key === 'riskReduction')!

    expect(priorityCoverage.baselinePct).toBe(100) // 30 / 30
    expect(priorityCoverage.optimizedPct).toBe(97) // 29 / 30
    expect(riskReduction.baselinePct).toBe(100) // 145 / 145
    expect(riskReduction.optimizedPct).toBe(97) // 140 / 145
  })

  it('omits priority coverage and risk reduction under the same guards as buildMetricRows', () => {
    const noCriticalOrRisk: ComparisonToBaseline = {
      ...WITH_KPIS,
      criticalContestableCount: 0,
      riskFraming: null,
    }
    const keys = buildRateComparisonRows(noCriticalOrRisk).map((row) => row.key)

    expect(keys).not.toContain('priorityCoverage')
    expect(keys).not.toContain('riskReduction')
  })
})
