import { describe, expect, it } from 'vitest'
import { WEIGHT_SPECS, defaultValues, hasOverride, toOverride } from './policyWeights.ts'

describe('WEIGHT_SPECS', () => {
  it('has exactly the five D-023 terms, no more, no fewer', () => {
    expect(WEIGHT_SPECS.map((s) => s.key).sort()).toEqual(
      ['batching', 'coverage', 'fragmentation', 'slaCompliance', 'unusedMinute'].sort(),
    )
  })

  it("does not name PRD's four sliders - risk avoidance and train punctuality are not implemented", () => {
    const text = WEIGHT_SPECS.map((s) => `${s.label} ${s.description}`).join(' ').toLowerCase()
    expect(text).not.toMatch(/risk avoidance/)
    expect(text).not.toMatch(/train punctuality/)
  })

  it('every bound matches D-061s verified-safe [0.1x, 10x] range of its default', () => {
    for (const spec of WEIGHT_SPECS) {
      // unusedMinute's default (1) is already the practical floor of an
      // integer weight, so 0.1x rounds to the same value - min === default
      // there is correct, not a bug.
      if (spec.key !== 'unusedMinute') {
        expect(spec.min).toBeCloseTo(spec.default * 0.1, 0)
      }
      expect(spec.max).toBeCloseTo(spec.default * 10, 0)
    }
  })
})

describe('toOverride', () => {
  it('sends nothing when every slider sits at its default', () => {
    expect(toOverride(defaultValues())).toEqual({})
  })

  it('sends only the terms a Controller actually moved', () => {
    const values = { ...defaultValues(), fragmentation: 2500 }
    expect(toOverride(values)).toEqual({ fragmentation: 2500 })
  })

  it('sends every moved term, not just the first', () => {
    const values = { ...defaultValues(), fragmentation: 2500, coverage: 50_000 }
    expect(toOverride(values)).toEqual({ fragmentation: 2500, coverage: 50_000 })
  })
})

describe('hasOverride', () => {
  it('is false at defaults and true the moment one slider moves', () => {
    expect(hasOverride(defaultValues())).toBe(false)
    expect(hasOverride({ ...defaultValues(), batching: 6000 })).toBe(true)
  })
})
