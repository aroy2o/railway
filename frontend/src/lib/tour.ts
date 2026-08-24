/**
 * Guided-walkthrough mechanism: first-visit detection, and the pure geometry
 * behind a hand-built spotlight + tooltip.
 *
 * BUILD, NOT A LIBRARY - decided before writing any of this. A guided tour
 * that highlights one element and shows a positioned tooltip with
 * next/back/skip is a few dozen lines of rect maths; `registry.npmjs.org` is
 * reachable, so a package (`react-joyride`, `driver.js`, `shepherd.js`) was a
 * real option, not ruled out on principle. It was rejected because none of
 * this project's existing UI (plain Tailwind, no component library) needed
 * reconciling with a third-party tour library's own CSS/theming, and every
 * one of them is materially heavier than the ~10 steps this session needs on
 * one page. See docs/DECISIONS.md D-072.
 *
 * Step CONTENT lives per-page under `src/tours/*.ts` (e.g. `dashboardTour.ts`)
 * - this file is only the mechanism, so adding a walkthrough for another page
 * later is "write a new step array", never a change here.
 */

export interface TourStep {
  /** Stable id for logging/keys - not shown to the user. */
  id: string
  /**
   * CSS selector for the element this step highlights, or `null` for a
   * centred, un-spotlit step (used for the welcome/closing screens, which
   * describe the tour itself rather than one element on the page).
   */
  selector: string | null
  title: string
  body: string
}

const STORAGE_PREFIX = 'bp.walkthrough.'

/**
 * The slice of the `Storage` interface this module needs. `storage` is
 * injectable (defaulting to the real `window.localStorage`) so the
 * first-visit logic is unit-testable without a DOM environment - this
 * project runs its vitest suite under plain Node (see `gantt.ts`,
 * `conflicts.ts`), not jsdom, and this is a deployed app, not a sandboxed
 * artifact, so `window.localStorage` itself is the right default.
 */
export interface TourStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Has this browser ever started (not necessarily finished) the named tour? */
export function hasSeenTour(tourId: string, storage: TourStorage = window.localStorage): boolean {
  try {
    return storage.getItem(STORAGE_PREFIX + tourId) === '1'
  } catch {
    // Storage blocked (private mode, disabled cookies/site-data) - degrade to
    // "always offer the tour" rather than throwing and breaking the page.
    return false
  }
}

export function markTourSeen(tourId: string, storage: TourStorage = window.localStorage): void {
  try {
    storage.setItem(STORAGE_PREFIX + tourId, '1')
  } catch {
    // Nothing to persist to - the tour will simply auto-offer itself again
    // next visit, which is a safe direction to fail in.
  }
}

/**
 * Only the steps whose target actually exists right now.
 *
 * A first-time visitor with no schedule generated yet cannot see the Gantt,
 * the priority queue or any of the panels that read `plan` - they do not
 * exist in the DOM. Filtering here means the tour that runs is honestly
 * short (welcome + "click Generate schedule") rather than one that walks
 * through elements that are not on the page.
 */
export function visibleSteps(steps: TourStep[], root: ParentNode = document): TourStep[] {
  return steps.filter((step) => step.selector === null || root.querySelector(step.selector) !== null)
}

export interface Rect {
  top: number
  left: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

export interface EdgeRect {
  top: number
  left: number
  width: number
  height: number
}

/**
 * The four backdrop rectangles that dim and block clicks on everything
 * EXCEPT `target` (padded), rather than drawing one full-screen backdrop and
 * trying to punch a hole in it. Plain divs, no `clip-path` or SVG mask - so
 * the highlighted element is never painted over (nothing draws on top of
 * it), it is simply the one rectangle none of the four backdrop pieces cover.
 * A rect with a non-positive dimension is omitted rather than rendered as a
 * degenerate box, which happens for a target flush against a viewport edge.
 */
export function computeEdgeRects(target: Rect, viewport: Viewport, padding = 6): EdgeRect[] {
  const top = Math.max(0, target.top - padding)
  const left = Math.max(0, target.left - padding)
  const right = Math.min(viewport.width, target.left + target.width + padding)
  const bottom = Math.min(viewport.height, target.top + target.height + padding)

  const candidates: EdgeRect[] = [
    { top: 0, left: 0, width: viewport.width, height: top }, // above
    { top: bottom, left: 0, width: viewport.width, height: viewport.height - bottom }, // below
    { top, left: 0, width: left, height: bottom - top }, // left of target
    { top, left: right, width: viewport.width - right, height: bottom - top }, // right of target
  ]
  return candidates.filter((rect) => rect.width > 0 && rect.height > 0)
}

/** The highlight ring drawn exactly around the padded target. */
export function computeSpotlightRect(target: Rect, padding = 6): EdgeRect {
  return {
    top: target.top - padding,
    left: target.left - padding,
    width: target.width + padding * 2,
    height: target.height + padding * 2,
  }
}

export interface TooltipPosition {
  top: number
  left: number
  placement: 'above' | 'below'
}

/**
 * Below the target if the tooltip fits there, above it otherwise - never
 * anything more elaborate than that, since every step on this project's
 * tours targets a wide section on an otherwise single-column-ish layout, not
 * a small control needing a left/right placement to avoid overlap.
 * Horizontally clamped so the card never runs off either edge of the screen.
 */
export function computeTooltipPosition(
  target: Rect,
  viewport: Viewport,
  tooltip: { width: number; height: number },
  gap = 14,
): TooltipPosition {
  const fitsBelow = target.top + target.height + gap + tooltip.height <= viewport.height
  const placement: 'above' | 'below' = fitsBelow ? 'below' : 'above'
  const top = fitsBelow
    ? target.top + target.height + gap
    : Math.max(8, target.top - gap - tooltip.height)

  const idealLeft = target.left
  const left = Math.min(Math.max(8, idealLeft), viewport.width - tooltip.width - 8)

  return { top, left, placement }
}
