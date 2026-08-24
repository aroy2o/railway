/**
 * The guided-walkthrough mechanism's testable half: first-visit persistence
 * and the pure rect maths behind the hand-built spotlight. Step CONTENT and
 * the actual highlight are verified live in a real browser (this project's
 * standing frontend-coverage practice for anything this size), matching
 * `gantt.ts`/`conflicts.ts`'s split between unit-tested layout logic and
 * visually-confirmed rendering.
 */
import { describe, expect, it } from 'vitest'
import {
  computeEdgeRects,
  computeSpotlightRect,
  computeTooltipPosition,
  hasSeenTour,
  markTourSeen,
  visibleSteps,
  type TourStep,
  type TourStorage,
} from './tour.ts'

/** In-memory stand-in for `localStorage` - this suite runs under plain Node
 * (no jsdom, matching `gantt.ts`/`conflicts.ts`), so the real thing is not
 * available and the injectable `storage` parameter is exactly for this. */
function memoryStorage(): TourStorage {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

function throwingStorage(): TourStorage {
  return {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
  }
}

describe('hasSeenTour / markTourSeen', () => {
  it('is unseen until marked, and persists after', () => {
    const storage = memoryStorage()
    expect(hasSeenTour('dashboard', storage)).toBe(false)
    markTourSeen('dashboard', storage)
    expect(hasSeenTour('dashboard', storage)).toBe(true)
  })

  it('keeps separate tours independent', () => {
    const storage = memoryStorage()
    markTourSeen('dashboard', storage)
    expect(hasSeenTour('comparison', storage)).toBe(false)
  })

  it('degrades to "not seen" rather than throwing when storage is blocked', () => {
    expect(hasSeenTour('dashboard', throwingStorage())).toBe(false)
  })

  it('does not throw when storage is blocked on write', () => {
    expect(() => markTourSeen('dashboard', throwingStorage())).not.toThrow()
  })
})

describe('visibleSteps', () => {
  function step(id: string, selector: string | null): TourStep {
    return { id, selector, title: id, body: id }
  }

  function fakeRoot(present: string[]): ParentNode {
    return { querySelector: (selector: string) => (present.includes(selector) ? ({} as Element) : null) } as ParentNode
  }

  it('keeps a null-selector step unconditionally - it describes the tour, not one element', () => {
    const steps = [step('welcome', null)]
    expect(visibleSteps(steps, fakeRoot([]))).toEqual(steps)
  })

  it('drops a step whose target is not on the page', () => {
    const steps = [step('kpis', '[data-tour="dashboard-kpis"]'), step('gantt', '[data-tour="dashboard-gantt"]')]
    const result = visibleSteps(steps, fakeRoot(['[data-tour="dashboard-kpis"]']))
    expect(result.map((s) => s.id)).toEqual(['kpis'])
  })

  it('a fresh install with no schedule yet keeps only the welcome and generate steps', () => {
    // The real-world case this function exists for: `plan`-gated sections
    // (Gantt, priority queue, every sidebar panel) simply are not in the DOM
    // yet, so the tour that runs must be honestly short, not broken.
    const steps = [
      step('welcome', null),
      step('generate', '[data-tour="dashboard-generate"]'),
      step('gantt', '[data-tour="dashboard-gantt"]'),
      step('kpis', '[data-tour="dashboard-kpis"]'),
    ]
    const result = visibleSteps(steps, fakeRoot(['[data-tour="dashboard-generate"]']))
    expect(result.map((s) => s.id)).toEqual(['welcome', 'generate'])
  })
})

describe('computeEdgeRects', () => {
  const viewport = { width: 1000, height: 800 }

  it('surrounds a target in the middle of the viewport on all four sides', () => {
    const rects = computeEdgeRects({ top: 300, left: 400, width: 100, height: 50 }, viewport, 0)
    expect(rects).toHaveLength(4)
    // Together with the target rect itself, the four pieces must tile the
    // whole viewport exactly - checked by area rather than by exact
    // coordinates, so the test survives a padding-constant tweak.
    const target = 100 * 50
    const totalArea = rects.reduce((sum, r) => sum + r.width * r.height, 0)
    expect(totalArea + target).toBe(viewport.width * viewport.height)
  })

  it('omits a degenerate piece when the target sits flush against an edge', () => {
    const rects = computeEdgeRects({ top: 0, left: 0, width: 200, height: 100 }, viewport, 0)
    // Flush against the top-left corner: "above" and "left of" would both be
    // zero-area and must not appear as empty boxes.
    expect(rects.every((r) => r.width > 0 && r.height > 0)).toBe(true)
    expect(rects).toHaveLength(2)
  })

  it('clamps padding at the viewport boundary rather than producing a negative-origin rect', () => {
    const rects = computeEdgeRects({ top: 5, left: 5, width: 50, height: 50 }, viewport, 20)
    for (const rect of rects) {
      expect(rect.top).toBeGreaterThanOrEqual(0)
      expect(rect.left).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('computeSpotlightRect', () => {
  it('pads the target symmetrically', () => {
    const rect = computeSpotlightRect({ top: 100, left: 200, width: 50, height: 30 }, 6)
    expect(rect).toEqual({ top: 94, left: 194, width: 62, height: 42 })
  })
})

describe('computeTooltipPosition', () => {
  const viewport = { width: 1000, height: 800 }
  const tooltip = { width: 320, height: 160 }

  it('places the tooltip below the target when it fits', () => {
    const pos = computeTooltipPosition({ top: 100, left: 100, width: 200, height: 40 }, viewport, tooltip)
    expect(pos.placement).toBe('below')
    expect(pos.top).toBe(100 + 40 + 14)
  })

  it('flips above when there is no room below', () => {
    const pos = computeTooltipPosition({ top: 700, left: 100, width: 200, height: 40 }, viewport, tooltip)
    expect(pos.placement).toBe('above')
    expect(pos.top).toBe(700 - 14 - 160)
  })

  it('clamps horizontally so the card never runs off the right edge', () => {
    const pos = computeTooltipPosition({ top: 100, left: 950, width: 40, height: 40 }, viewport, tooltip)
    expect(pos.left).toBe(viewport.width - tooltip.width - 8)
  })

  it('clamps horizontally so the card never runs off the left edge', () => {
    const pos = computeTooltipPosition({ top: 100, left: -50, width: 40, height: 40 }, viewport, tooltip)
    expect(pos.left).toBe(8)
  })
})
