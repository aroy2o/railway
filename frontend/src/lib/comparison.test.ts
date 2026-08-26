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
  headlineRows,
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
