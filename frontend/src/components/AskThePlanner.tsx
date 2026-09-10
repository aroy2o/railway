/**
 * Ask the Planner - free-text questions about the plan (PRD 9.2, FR8.2).
 *
 * A text box and an answer, not a chat interface: PRD 9.2 describes a box on
 * the Controller Dashboard, and conversation history would imply the system
 * carries context between questions, which it does not.
 *
 * WHAT THIS SCREEN IS FOR
 * ----------------------
 * Showing the answer is the easy half. The half that matters is showing what
 * the answer was built from, because a Controller cannot tell a grounded
 * sentence from an invented one by reading it - and PRD Section 18 names an
 * invented figure as this feature's headline risk.
 *
 * So three states render differently, on purpose:
 *
 *   answered   - the answer, with its cited records listed underneath.
 *   declined   - the system saying it does not hold that data, with the reason
 *                and the task that would provide it. Presented as a normal
 *                outcome, not an error: an honest refusal is a correct answer.
 *   ungrounded - the optimizer's verifier found a number in the answer with no
 *                counterpart in any record. Rendered as a warning ABOVE the
 *                answer, with the offending figures named. Never styled like a
 *                clean answer.
 */
import { useState, type FormEvent } from 'react'

import { useAskThePlannerMutation } from '../api/apiSlice.ts'
import {
  answerState,
  explainErrorMessage,
  groupRecordIds,
  SUGGESTED_QUESTIONS,
} from '../lib/askPlanner.ts'

interface AskThePlannerProps {
  scheduleId?: string
}

export function AskThePlanner({ scheduleId }: AskThePlannerProps) {
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState<string | null>(null)
  const [ask, { data, error, isLoading, reset }] = useAskThePlannerMutation()

  const response = data?.data
  const state = response ? answerState(response) : null

  function submit(value: string) {
    const trimmed = value.trim()
    if (trimmed.length < 3 || isLoading) return
    setAsked(trimmed)
    void ask({ scheduleId, question: trimmed })
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    submit(question)
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-900">Ask the Planner</h2>
      <p className="mt-0.5 mb-3 text-xs text-slate-500">
        Answers come only from this plan's own decision log, conflicts and overrides. Every
        number is checked against those records before it reaches you, and anything the system
        does not hold, it says so rather than guessing.
      </p>

      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="e.g. why wasn't TSK-00009 done this week?"
          aria-label="Ask a question about this plan"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={isLoading || question.trim().length < 3}
          className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {isLoading ? 'Asking…' : 'Ask'}
        </button>
      </form>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {SUGGESTED_QUESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => {
              setQuestion(suggestion)
              submit(suggestion)
            }}
            disabled={isLoading}
            className="rounded-full border border-slate-200 px-2.5 py-1 text-[11px] text-slate-600 hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
        {(response || error) && (
          <button
            type="button"
            onClick={() => {
              reset()
              setAsked(null)
              setQuestion('')
            }}
            className="ml-auto text-[11px] text-slate-400 hover:text-slate-600"
          >
            Clear
          </button>
        )}
      </div>

      {asked && (response || error || isLoading) && (
        <p className="mt-4 text-xs text-slate-400">
          <span className="font-medium text-slate-500">Asked:</span> {asked}
        </p>
      )}

      {error && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-900">
            The explanation layer is unavailable
          </p>
          <p className="mt-1 text-[11px] text-amber-800">{explainErrorMessage(error)}</p>
        </div>
      )}

      {response && (
        <div className="mt-2 space-y-3">
          {state === 'ungrounded' && (
            <div className="rounded-lg border border-rose-300 bg-rose-50 p-3">
              <p className="text-xs font-semibold text-rose-900">
                This answer contains figures that are not in the records
              </p>
              <p className="mt-1 text-[11px] text-rose-800">
                {response.verification.ungroundedNumbers.length > 0 && (
                  <>
                    Not found in any record:{' '}
                    <span className="font-mono font-semibold">
                      {response.verification.ungroundedNumbers.join(', ')}
                    </span>
                    .{' '}
                  </>
                )}
                {response.verification.unknownRecordIds.length > 0 && (
                  <>
                    Cited records that do not exist:{' '}
                    <span className="font-mono">
                      {response.verification.unknownRecordIds.join(', ')}
                    </span>
                    .{' '}
                  </>
                )}
                Treat the sentence containing them as unverified.
              </p>
            </div>
          )}

          <div
            className={
              state === 'ungrounded'
                ? 'rounded-lg border border-rose-200 bg-white p-3'
                : state === 'declined'
                  ? 'rounded-lg border border-slate-200 bg-slate-50 p-3'
                  : 'rounded-lg border border-sky-200 bg-sky-50/60 p-3'
            }
          >
            <p className="text-sm whitespace-pre-line text-slate-800">{response.answer}</p>
          </div>

          {state === 'declined' && (response.context.unavailableTopics?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <p className="text-[11px] font-medium text-slate-700">
                Why this system cannot answer that
              </p>
              <ul className="mt-1 space-y-1.5">
                {response.context.unavailableTopics?.map((topic) => (
                  <li key={topic.topic} className="text-[11px] text-slate-600">
                    <span className="font-medium text-slate-700">{topic.topic}</span> —{' '}
                    {topic.reason}
                    <span className="block text-slate-400">Would come from {topic.blockedOn}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(response.context.modelFramings?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3">
              {response.context.modelFramings?.map((entry) => (
                <p key={entry.factId} className="text-[11px] text-violet-900">
                  {entry.framing}
                </p>
              ))}
            </div>
          )}

          <details className="rounded-lg border border-slate-200 bg-white p-3">
            <summary className="cursor-pointer text-[11px] font-medium text-slate-700">
              Grounded in {response.groundedIn.length} cited record
              {response.groundedIn.length === 1 ? '' : 's'} · {response.context.factCount} available
            </summary>
            <div className="mt-2 space-y-2">
              {groupRecordIds(response.groundedIn).map((group) => (
                <div key={group.kind}>
                  <p className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
                    {group.label}
                  </p>
                  <p className="font-mono text-[11px] break-words text-slate-600">
                    {group.ids.join(', ')}
                  </p>
                </div>
              ))}
              {response.groundedIn.length === 0 && (
                <p className="text-[11px] text-slate-500">
                  The answer cited no specific record.
                </p>
              )}
              {(response.context.unknownReferences?.length ?? 0) > 0 && (
                <p className="text-[11px] text-slate-500">
                  Named in the question but not in this plan:{' '}
                  <span className="font-mono">
                    {response.context.unknownReferences?.join(', ')}
                  </span>
                </p>
              )}
            </div>
          </details>
        </div>
      )}
    </section>
  )
}

export default AskThePlanner
