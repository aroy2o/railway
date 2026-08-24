import { describe, expect, it } from 'vitest'
import tourReducer, {
  replayConsumed,
  replayRequested,
  tourAdvanced,
  tourEnded,
  tourStarted,
  tourStepBack,
  type TourState,
} from './tourSlice.ts'
import type { TourStep } from '../../lib/tour.ts'

const steps: TourStep[] = [
  { id: 'a', selector: null, title: 'A', body: 'a' },
  { id: 'b', selector: null, title: 'B', body: 'b' },
  { id: 'c', selector: null, title: 'C', body: 'c' },
]

function initial(): TourState {
  return { steps: [], stepIndex: 0, replayRequested: false }
}

describe('tourSlice', () => {
  it('starts at step 0 with whatever steps it is given', () => {
    const state = tourReducer(initial(), tourStarted(steps))
    expect(state.steps).toEqual(steps)
    expect(state.stepIndex).toBe(0)
  })

  it('advances one step at a time and refuses to run past the last one', () => {
    let state = tourReducer(initial(), tourStarted(steps))
    state = tourReducer(state, tourAdvanced())
    expect(state.stepIndex).toBe(1)
    state = tourReducer(state, tourAdvanced())
    expect(state.stepIndex).toBe(2)
    state = tourReducer(state, tourAdvanced()) // already on the last step
    expect(state.stepIndex).toBe(2)
  })

  it('steps back one at a time and refuses to go below zero', () => {
    let state = tourReducer(initial(), tourStarted(steps))
    state = tourReducer(state, tourAdvanced())
    state = tourReducer(state, tourStepBack())
    expect(state.stepIndex).toBe(0)
    state = tourReducer(state, tourStepBack())
    expect(state.stepIndex).toBe(0)
  })

  it('ending the tour clears the step list, not just the index', () => {
    let state = tourReducer(initial(), tourStarted(steps))
    state = tourReducer(state, tourAdvanced())
    state = tourReducer(state, tourEnded())
    expect(state.steps).toEqual([])
    expect(state.stepIndex).toBe(0)
  })

  it('a replay request is a flag the target page consumes, not an auto-start', () => {
    let state = tourReducer(initial(), replayRequested())
    expect(state.replayRequested).toBe(true)
    // Requesting a replay must not, by itself, populate a step list - only
    // the page that owns the steps knows what they are.
    expect(state.steps).toEqual([])

    state = tourReducer(state, replayConsumed())
    expect(state.replayRequested).toBe(false)
  })
})
