/**
 * Guided-walkthrough state - the one piece of tour state that genuinely
 * crosses component boundaries.
 *
 * `AppHeader` (the "Replay walkthrough" button) and the page that owns the
 * steps (e.g. `ControllerDashboard`) are SIBLINGS under `<App>`, not
 * parent/child (`App.tsx` renders them side by side inside `<Routes>`), so
 * this cannot be local `useState` on either one - it is exactly the kind of
 * cross-cutting client state D-003 puts in a hand-written slice alongside
 * `authSlice`, not a parallel React Context invented for this one feature.
 *
 * Deliberately dumb: this slice does not know which elements exist on the
 * page or filter anything by DOM presence (`lib/tour.ts::visibleSteps` does
 * that, from inside the component, where `document` is available and a
 * pure-logic file staying environment-agnostic matters for its own tests).
 * The slice only ever holds whatever step list it was told to hold.
 */
import { createSlice } from '@reduxjs/toolkit'
import type { PayloadAction } from '@reduxjs/toolkit'
import type { TourStep } from '../../lib/tour.ts'

export interface TourState {
  /** The currently-active tour's steps, already filtered to what exists on
   * the page. Empty when no tour is running. */
  steps: TourStep[]
  stepIndex: number
  /** Set by "Replay walkthrough"; the target page consumes it (starts its
   * own tour, then clears this) rather than the header knowing tour content
   * for a page it did not render. */
  replayRequested: boolean
}

const initialState: TourState = {
  steps: [],
  stepIndex: 0,
  replayRequested: false,
}

const tourSlice = createSlice({
  name: 'tour',
  initialState,
  reducers: {
    tourStarted(state, action: PayloadAction<TourStep[]>) {
      state.steps = action.payload
      state.stepIndex = 0
    },
    tourAdvanced(state) {
      if (state.stepIndex < state.steps.length - 1) state.stepIndex += 1
    },
    tourStepBack(state) {
      if (state.stepIndex > 0) state.stepIndex -= 1
    },
    tourEnded(state) {
      state.steps = []
      state.stepIndex = 0
    },
    replayFlagSet(state) {
      state.replayRequested = true
    },
    replayConsumed(state) {
      state.replayRequested = false
    },
  },
})

export const {
  tourStarted,
  tourAdvanced,
  tourStepBack,
  tourEnded,
  replayFlagSet: replayRequested,
  replayConsumed,
} = tourSlice.actions
export default tourSlice.reducer
