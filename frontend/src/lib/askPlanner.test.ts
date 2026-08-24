/**
 * Ask the Planner's display logic.
 *
 * Small surface, but one case here is load-bearing: an answer the optimizer
 * flagged as containing an invented number must never be classified the same
 * as a clean one. If `answerState` ever returns 'answered' for an ungrounded
 * response, the UI shows a fabrication with no warning attached - the exact
 * failure PRD Section 18 names.
 */
import { describe, expect, it } from 'vitest'
import {
  answerState,
  explainErrorMessage,
  groupRecordIds,
  SUGGESTED_QUESTIONS,
  type ExplainResponse,
} from './askPlanner.ts'

function response(overrides: Partial<ExplainResponse> = {}): ExplainResponse {
  return {
    answer: 'It was scheduled on the 28th.',
    answered: true,
    groundedIn: ['decision:TSK-00004'],
    verification: { grounded: true, ungroundedNumbers: [], unknownRecordIds: [] },
    context: { factCount: 8, recordIds: ['decision:TSK-00004'] },
    ...overrides,
  }
}

describe('answerState', () => {
  it('marks a clean answer as answered', () => {
    expect(answerState(response())).toBe('answered')
  })

  it('marks an honest refusal as declined, not as a failure', () => {
    expect(answerState(response({ answered: false }))).toBe('declined')
  })

  it('marks an answer carrying an invented number as ungrounded', () => {
    const flagged = response({
      verification: { grounded: false, ungroundedNumbers: ['47'], unknownRecordIds: [] },
    })

    expect(answerState(flagged)).toBe('ungrounded')
  })

  it('lets ungrounded outrank declined', () => {
    /* A reply that both declined AND stated a figure is the worst case: it
       reads as cautious while still asserting something invented. */
    const flagged = response({
      answered: false,
      verification: { grounded: false, ungroundedNumbers: ['312'], unknownRecordIds: [] },
    })

    expect(answerState(flagged)).toBe('ungrounded')
  })

  it('treats a fabricated citation as ungrounded too', () => {
    const flagged = response({
      verification: {
        grounded: false, ungroundedNumbers: [], unknownRecordIds: ['decision:TSK-99999'],
      },
    })

    expect(answerState(flagged)).toBe('ungrounded')
  })
})

describe('model framings (PRD 9.1 / NG4)', () => {
  it('carries the risk framing independently of what the model said', () => {
    /* The response type must be able to hold the caveat even when the answer
       omits it - that separation is the point, since the model may forget. */
    const flagged = response({
      answer: 'The failure risk score is 65.17.',
      context: {
        factCount: 6,
        recordIds: ['task:TSK-00001', 'framing:riskModel'],
        modelFramings: [
          {
            factId: 'framing:riskModel',
            framing:
              'Prototype predictive risk model trained on simulated asset degradation ' +
              'patterns... It does not predict real Indian Railways asset failures.',
          },
        ],
      },
    })

    expect(flagged.context.modelFramings).toHaveLength(1)
    expect(flagged.context.modelFramings?.[0].framing).toContain('simulated')
    expect(flagged.context.modelFramings?.[0].framing).toContain('does not predict real')
    expect(flagged.answer).not.toContain('simulated')
  })
})

describe('groupRecordIds', () => {
  it('groups by namespace with per-task evidence first', () => {
    const groups = groupRecordIds([
      'plan:summary', 'gap:trainImpact', 'decision:TSK-1', 'task:TSK-1', 'decision:TSK-2',
    ])

    expect(groups.map((g) => g.kind)).toEqual(['decision', 'task', 'plan', 'gap'])
    expect(groups[0].ids).toEqual(['decision:TSK-1', 'decision:TSK-2'])
    expect(groups[0].label).toBe('Decision log')
  })

  it('renders an unrecognised namespace rather than dropping it', () => {
    const groups = groupRecordIds(['somethingnew:X'])

    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('somethingnew')
  })

  it('handles an empty list', () => {
    expect(groupRecordIds([])).toEqual([])
  })
})

describe('explainErrorMessage', () => {
  it('surfaces the actionable message the API sent', () => {
    const message = explainErrorMessage({
      status: 503,
      data: { error: { message: 'no ANTHROPIC_API_KEY is set on the optimizer service' } },
    })

    expect(message).toContain('ANTHROPIC_API_KEY')
  })

  it('falls back without inventing a cause', () => {
    expect(explainErrorMessage({ status: 500 })).toContain('500')
    expect(explainErrorMessage({ status: 'FETCH_ERROR' })).toBe('Could not reach the API.')
  })
})

describe('SUGGESTED_QUESTIONS', () => {
  it('includes one the system cannot answer', () => {
    /* The refusal is the behaviour most worth demonstrating, so it must be
       reachable without the Controller having to think of it. */
    expect(SUGGESTED_QUESTIONS.some((q) => /train/i.test(q))).toBe(true)
  })
})
