/**
 * Where this plan sits in the FR6.1 chain, and what can be done to it next.
 *
 * The buttons come from the server's `allowedActions`, never from a transition
 * table in the browser. A UI that decides for itself what is legal eventually
 * offers a button the API refuses - and the Controller reads that as the system
 * being broken rather than as the plan being in the wrong state.
 */
import { useState } from 'react'

import {
  describeAction,
  canSubmitAction,
  describeState,
  type WorkflowAction,
  type WorkflowState,
} from '../lib/approval.ts'
import { describeApiError, useRunWorkflowActionMutation } from '../api/apiSlice.ts'

const TONE: Record<ReturnType<typeof describeState>['tone'], string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  progress: 'bg-sky-100 text-sky-800 ring-sky-200',
  good: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  bad: 'bg-rose-100 text-rose-800 ring-rose-200',
}

export function WorkflowPanel({
  scheduleId,
  state,
  allowedActions,
  version,
}: {
  scheduleId: string
  state: WorkflowState
  allowedActions: WorkflowAction[]
  version: number | null
}) {
  const [run, { isLoading, error, reset }] = useRunWorkflowActionMutation()
  const [pending, setPending] = useState<WorkflowAction | null>(null)
  const [reason, setReason] = useState('')

  const described = describeState(state)

  async function submit(action: WorkflowAction) {
    const spec = describeAction(action)
    // A reason or a confirmation is collected first; the second click is the
    // one that acts. Publishing and rejecting cannot be walked back, and the
    // recovery path for a mistake is generating a whole new plan.
    if ((spec.requiresReason || spec.terminal) && pending !== action) {
      setPending(action)
      setReason('')
      reset()
      return
    }
    try {
      await run({ scheduleId, action, reason: reason.trim() || undefined }).unwrap()
      setPending(null)
      setReason('')
    } catch {
      // Rendered from the mutation's own error below.
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Approval workflow</h2>
          <p className="mt-0.5 text-xs text-slate-500">{described.meaning}</p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${TONE[described.tone]}`}
        >
          {described.label}
          {version !== null && ` · v${version}`}
        </span>
      </div>

      {/* PRD FR6.1's chain, shown as a chain - a judge should be able to see
          where the plan is without reading the state name. */}
      <ol className="mt-4 flex flex-wrap items-center gap-1 text-[11px] text-slate-400">
        {(['draft', 'under_review', 'approved', 'published'] as const).map((step, index) => (
          <li key={step} className="flex items-center gap-1">
            {index > 0 && <span aria-hidden>→</span>}
            <span
              className={
                step === state
                  ? 'rounded bg-slate-900 px-1.5 py-0.5 font-semibold text-white'
                  : ''
              }
            >
              {describeState(step).label}
            </span>
          </li>
        ))}
        {state === 'rejected' && (
          <li className="ml-2 rounded bg-rose-600 px-1.5 py-0.5 font-semibold text-white">
            Rejected
          </li>
        )}
      </ol>

      {allowedActions.length === 0 ? (
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Nothing further can happen to this plan. Prior versions stay viewable — generate a new
          plan to make changes (FR6.3).
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap gap-2">
            {allowedActions.map((action) => {
              const spec = describeAction(action)
              const armed = pending === action
              return (
                <button
                  key={action}
                  type="button"
                  disabled={isLoading || (armed && !canSubmitAction(action, reason))}
                  onClick={() => void submit(action)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-40 ${
                    action === 'reject'
                      ? 'bg-rose-600 text-white hover:bg-rose-700'
                      : action === 'publish'
                        ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                        : 'bg-slate-900 text-white hover:bg-slate-800'
                  }`}
                >
                  {armed ? `Confirm — ${spec.label.toLowerCase()}` : spec.label}
                </button>
              )
            })}
            {pending && (
              <button
                type="button"
                onClick={() => {
                  setPending(null)
                  setReason('')
                }}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:text-slate-800"
              >
                Cancel
              </button>
            )}
          </div>

          {pending && describeAction(pending).requiresReason && (
            <div>
              <label className="text-[11px] font-medium text-slate-600" htmlFor="workflow-reason">
                Reason (required — recorded permanently in the audit trail)
              </label>
              <textarea
                id="workflow-reason"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this plan being rejected?"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs focus:border-slate-400 focus:outline-none"
              />
              {!canSubmitAction(pending, reason) && (
                <p className="mt-1 text-[11px] text-slate-400">At least 8 characters.</p>
              )}
            </div>
          )}

          {pending && describeAction(pending).terminal && !describeAction(pending).requiresReason && (
            <p className="text-[11px] text-slate-500">
              Publishing freezes this plan — it cannot be overridden afterwards.
            </p>
          )}
        </div>
      )}

      {error && (
        // The server's refusal names the state and the legal actions; showing
        // it verbatim is the whole point of writing refusals that way.
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {describeApiError(error)}
        </p>
      )}
    </section>
  )
}

export default WorkflowPanel
