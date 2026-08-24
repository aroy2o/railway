/**
 * What-if simulation panel - PRD FR5, 9.4, task T20.
 *
 * Opened for one task at a time (from the priority queue, T20 works for a
 * deferred task exactly as well as a scheduled one - unlike the override
 * panel, which needs a block on the Gantt to click). Running it triggers a
 * REAL re-solve on the optimizer (up to a few seconds - see the loading
 * state), and nothing about the live schedule changes until "Apply this
 * option" is pressed, which reuses the exact FR6.2 override path T15 built
 * and T19 gates (D-065) - never a new, unreviewed write.
 */
import { useEffect, useState } from 'react'

import {
  describeApiError,
  useApplyOverrideMutation,
  useRunWhatIfMutation,
} from '../api/apiSlice.ts'
import {
  isUnproven,
  optionBadgeTone,
  summariseConsequence,
  type WhatIfOption as ApiWhatIfOption,
} from '../lib/whatif.ts'

const BADGE_TONE: Record<'good' | 'warn' | 'neutral', string> = {
  good: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
}

function OptionCard({
  option,
  recommended,
  scheduleId,
  taskId,
}: {
  option: ApiWhatIfOption
  recommended: boolean
  scheduleId: string
  taskId: string
}) {
  const [applying, setApplying] = useState(false)
  const [reason, setReason] = useState('')
  const [apply, result] = useApplyOverrideMutation()
  const tone = optionBadgeTone(option)

  async function onApply() {
    if (reason.trim().length < 8) return
    const body =
      option.kind === 'defer'
        ? { scheduleId, taskId, action: 'defer' as const, reason: reason.trim() }
        : option.kind === 'move' && option.taskOutcome.date && option.taskOutcome.windowIndex !== null
          ? {
              scheduleId,
              taskId,
              action: 'move' as const,
              targetDate: option.taskOutcome.date,
              targetWindowIndex: option.taskOutcome.windowIndex,
              reason: reason.trim(),
            }
          : null
    if (!body) return
    try {
      await apply(body).unwrap()
      setApplying(false)
    } catch {
      // Rendered from `result.error` below.
    }
  }

  return (
    <div
      className={`rounded-lg border p-3 ${
        recommended ? 'border-sky-300 bg-sky-50/40' : 'border-slate-200'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-slate-900">
            {option.label}
            {recommended && (
              <span className="ml-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800">
                recommended
              </span>
            )}
          </p>
          <span
            className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${BADGE_TONE[tone]}`}
          >
            {summariseConsequence(option)}
          </span>
          {isUnproven(option) && (
            <span
              className="ml-1.5 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500"
              title="The solver found this within its time budget but did not prove it is the single best possible placement."
            >
              not proven optimal ({option.status})
            </span>
          )}
        </div>
      </div>

      <p className="mt-1.5 text-[11px] text-slate-600">{option.reason}</p>

      {option.kind === 'traffic-block' ? (
        <p className="mt-1.5 text-[11px] text-slate-400">
          Not applicable from here — see the Deferred Work panel's traffic-block costing.
        </p>
      ) : applying ? (
        <div className="mt-2 space-y-1.5">
          <textarea
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why apply this option? (required — recorded in the audit trail)"
            className="w-full rounded border border-slate-200 px-2 py-1.5 text-[11px] focus:border-slate-400 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={reason.trim().length < 8 || result.isLoading}
              onClick={() => void onApply()}
              className="rounded bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {result.isLoading ? 'Applying…' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => setApplying(false)}
              className="text-[11px] text-slate-500 hover:text-slate-800"
            >
              Cancel
            </button>
          </div>
          {result.isSuccess && (
            <p className="text-[11px] text-emerald-700">
              ✓ Applied as a manual override — re-validated, same as any override (FR6.2).
            </p>
          )}
          {result.error && (
            <p className="text-[11px] text-rose-700">{describeApiError(result.error)}</p>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setApplying(true)}
          className="mt-2 rounded border border-slate-300 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
        >
          Apply this option…
        </button>
      )}
    </div>
  )
}

export function WhatIfPanel({
  scheduleId,
  taskId,
  onClose,
}: {
  scheduleId: string
  taskId: string
  onClose: () => void
}) {
  const [run, result] = useRunWhatIfMutation()

  // Runs once per (scheduleId, taskId) pair - re-running on every render
  // would fire a new CP-SAT solve on every keystroke elsewhere on the page.
  useEffect(() => {
    void run({ scheduleId, taskId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleId, taskId])

  const data = result.data?.data

  return (
    <section className="rounded-xl border-2 border-violet-300 bg-white shadow-sm">
      <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            What if — <span className="font-mono">{taskId}</span>
          </h3>
          <p className="text-xs text-slate-500">
            A real re-solve of the same CP-SAT model, with this task's placement forced (FR5).
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
        >
          ✕
        </button>
      </header>

      {result.isLoading && (
        <p className="px-5 py-8 text-sm text-slate-500">
          Running up to {data?.options.length ?? 'a few'} real solves against the current
          backlog — this can take several seconds.
        </p>
      )}

      {result.error && (
        <p className="px-5 py-6 text-sm text-rose-700">{describeApiError(result.error)}</p>
      )}

      {data && (
        <div className="space-y-3 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.options.map((option, index) => (
              <OptionCard
                key={option.label}
                option={option}
                recommended={data.recommendedIndex === index}
                scheduleId={scheduleId}
                taskId={taskId}
              />
            ))}
          </div>
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
            {data.framing}
          </p>
        </div>
      )}
    </section>
  )
}

export default WhatIfPanel
