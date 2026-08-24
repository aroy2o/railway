/**
 * Wires one page's tour into the guided-walkthrough mechanism: auto-start on
 * a first-ever visit, or on-demand via "Replay walkthrough" (`AppHeader`),
 * whichever comes first. Extracted once the walkthrough grew from covering
 * just the Controller Dashboard to every route (see docs/DECISIONS.md D-072
 * addendum) - the same ~15 lines were about to be pasted into nine page
 * components, which is exactly the repetition CLAUDE.md's "don't add
 * abstractions beyond what's needed" stops applying to once it is real,
 * observed duplication rather than a hypothetical one.
 *
 * A page calls this once, with:
 *   - a stable tour id (also the localStorage key suffix, via `lib/tour.ts`)
 *   - its own step array (content lives in `src/tours/*.ts`, never here)
 *   - `ready`: true once the page's data has settled (loaded OR definitively
 *     empty) so `visibleSteps` filters against the FINAL DOM, not a
 *     half-loaded page. A page with no async data at all (a pure reference
 *     table with nothing to wait for) can simply pass `true`.
 */
import { useEffect, useRef } from 'react'

import { useAppDispatch, useAppSelector } from '../store/hooks.ts'
import { replayConsumed, tourStarted } from '../store/slices/tourSlice.ts'
import { hasSeenTour, markTourSeen, visibleSteps, type TourStep } from './tour.ts'

export function useAutoTour(tourId: string, steps: TourStep[], ready: boolean): void {
  const dispatch = useAppDispatch()
  const replayRequested = useAppSelector((state) => state.tour.replayRequested)
  const autoStartAttempted = useRef(false)

  useEffect(() => {
    if (!ready) return

    if (replayRequested) {
      dispatch(replayConsumed())
      markTourSeen(tourId)
      dispatch(tourStarted(visibleSteps(steps)))
      return
    }

    if (autoStartAttempted.current) return
    autoStartAttempted.current = true
    if (hasSeenTour(tourId)) return
    markTourSeen(tourId)
    dispatch(tourStarted(visibleSteps(steps)))
    // `steps` is a module-level constant array from `src/tours/*.ts` at every
    // real call site, so omitting it from the dependency list does not risk
    // staleness - including it would instead re-run this on every render,
    // since a fresh array literal is a new reference each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, replayRequested, dispatch, tourId])
}
