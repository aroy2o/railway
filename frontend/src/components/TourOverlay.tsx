/**
 * Renders the active guided-walkthrough step, if any - spotlight + tooltip,
 * hand-built (see docs/DECISIONS.md D-072 for why not a library).
 *
 * Mounted once, at the app root (`App.tsx`), not per-page: `tourSlice` is
 * global client state, and rendering the overlay outside any one route's
 * subtree is what lets it survive - or rather, deliberately NOT survive - a
 * navigation while a tour is running (see the route-change effect below).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { useAppDispatch, useAppSelector } from '../store/hooks.ts'
import { tourAdvanced, tourEnded, tourStepBack } from '../store/slices/tourSlice.ts'
import {
  computeEdgeRects,
  computeSpotlightRect,
  computeTooltipPosition,
  type Rect,
} from '../lib/tour.ts'

const TOOLTIP_SIZE = { width: 336, height: 220 }

function rectFromElement(element: Element): Rect {
  const box = element.getBoundingClientRect()
  return { top: box.top, left: box.left, width: box.width, height: box.height }
}

export function TourOverlay() {
  const dispatch = useAppDispatch()
  const location = useLocation()
  const steps = useAppSelector((state) => state.tour.steps)
  const stepIndex = useAppSelector((state) => state.tour.stepIndex)
  const step = steps[stepIndex] ?? null
  const [rect, setRect] = useState<Rect | null>(null)
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))

  const active = step !== null

  // A tour is scoped to the page it started on (dashboardTour targets only
  // elements on /dashboard). Navigating away mid-tour leaves it pointing at
  // elements that no longer exist, so it ends rather than floating over a
  // different page. Guarded to skip the very first firing: this effect's
  // dependency is `location.pathname`, which also "changes" (from nothing to
  // its initial value) on the app's first mount - reacting to that would end
  // a tour a page's own mount effect just started in the same pass, before a
  // user ever navigated anywhere.
  const isFirstPath = useRef(true)
  useEffect(() => {
    if (isFirstPath.current) {
      isFirstPath.current = false
      return
    }
    if (active) dispatch(tourEnded())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  useLayoutEffect(() => {
    // A null-selector step (welcome/closing) never reads `rect` at render
    // time - `spotlighted` below short-circuits on `step.selector !== null`
    // first - so a stale value from a previous step is harmless to leave in
    // place rather than clearing it here just to satisfy the effect.
    if (!step?.selector) return
    function measure() {
      const el = document.querySelector(step!.selector!)
      if (!el) {
        // The element this step wanted vanished mid-tour (e.g. a live update
        // removed it) - end rather than spotlight nothing.
        dispatch(tourEnded())
        return
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setRect(rectFromElement(el))
    }
    measure()
    // Re-measure shortly after, once `scrollIntoView`'s smooth scroll has
    // actually settled, so the spotlight lands on the final position rather
    // than where the element was before scrolling.
    const settle = window.setTimeout(measure, 260)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.clearTimeout(settle)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id])

  useEffect(() => {
    function onResize() {
      setViewport({ width: window.innerWidth, height: window.innerHeight })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!active) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') dispatch(tourEnded())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, dispatch])

  if (!step) return null

  const isLast = stepIndex === steps.length - 1
  const isFirst = stepIndex === 0
  const spotlighted = step.selector !== null && rect !== null

  const tooltipPos = rect
    ? computeTooltipPosition(rect, viewport, TOOLTIP_SIZE)
    : { top: viewport.height / 2 - TOOLTIP_SIZE.height / 2, left: viewport.width / 2 - TOOLTIP_SIZE.width / 2, placement: 'below' as const }

  return (
    <div className="fixed inset-0 z-100" role="dialog" aria-modal="true" aria-label={step.title}>
      {spotlighted && rect ? (
        <>
          {computeEdgeRects(rect, viewport).map((edge, index) => (
            <div
              key={index}
              className="fixed bg-slate-950/60"
              style={{ top: edge.top, left: edge.left, width: edge.width, height: edge.height }}
            />
          ))}
          <div
            className="fixed rounded-lg ring-2 ring-sky-400 ring-offset-2 ring-offset-transparent"
            style={(() => {
              const spot = computeSpotlightRect(rect)
              return { top: spot.top, left: spot.left, width: spot.width, height: spot.height, pointerEvents: 'none' }
            })()}
          />
        </>
      ) : (
        <div className="fixed inset-0 bg-slate-950/60" />
      )}

      <div
        className="fixed w-84 rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
        style={{ top: tooltipPos.top, left: tooltipPos.left }}
      >
        <p className="text-[11px] font-medium tracking-wide text-slate-400 uppercase">
          Step {stepIndex + 1} of {steps.length}
        </p>
        <h3 className="mt-0.5 text-sm font-semibold text-slate-900">{step.title}</h3>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-600">{step.body}</p>

        <div className="mt-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => dispatch(tourEnded())}
            className="text-xs text-slate-400 hover:text-slate-700"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {!isFirst && (
              <button
                type="button"
                onClick={() => dispatch(tourStepBack())}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={() => dispatch(isLast ? tourEnded() : tourAdvanced())}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
            >
              {isLast ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default TourOverlay
