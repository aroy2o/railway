/**
 * Manual override flow - PRD FR6.2.
 *
 * Click a block, pick a task, pick a different window, give a reason, confirm.
 * Deliberately click-driven rather than drag-and-drop: a drag target on a
 * 24-hour axis is imprecise, and the Controller needs to choose from windows
 * the timetable actually leaves free, not from arbitrary pixels.
 *
 * The window list comes from `/override-targets`, which runs the same validator
 * as the write path - so nothing offered here can be refused on submit. The
 * refusal path still renders properly, because validity can change between
 * opening the panel and confirming.
 */
import { useState } from 'react'

import {
  useApplyOverrideMutation,
  useGetOverrideTargetsQuery,
  describeApiError,
  type ScheduleBlock,
} from '../api/apiSlice.ts'
import { DepartmentPill } from './Table.tsx'

interface OverridePanelProps {
  scheduleId: string
  block: ScheduleBlock
  onClose: () => void
}

export function OverridePanel({ scheduleId, block, onClose }: OverridePanelProps) {
  const [taskId, setTaskId] = useState<string | null>(
    block.taskIds.length === 1 ? block.taskIds[0]! : null,
  )
  const [choice, setChoice] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [apply, result] = useApplyOverrideMutation()

  const targets = useGetOverrideTargetsQuery(
    { scheduleId, taskId: taskId ?? '' },
    { skip: !taskId },
  )

  const reasonTooShort = reason.trim().length < 8

  async function onConfirm() {
    if (!taskId || !choice || reasonTooShort) return
    const body =
      choice === 'defer'
        ? { scheduleId, taskId, action: 'defer' as const, reason: reason.trim() }
        : {
            scheduleId,
            taskId,
            action: 'move' as const,
            targetDate: choice.split('|')[0]!,
            targetWindowIndex: Number(choice.split('|')[1]),
            reason: reason.trim(),
          }
    try {
      await apply(body).unwrap()
    } catch {
      // Rendered below; unwrap() would otherwise reject unhandled.
    }
  }

  const accepted = result.isSuccess ? result.data.data : null

  return (
    <section className="rounded-xl border-2 border-sky-300 bg-white shadow-sm">
      <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Override this block</h3>
          <p className="text-xs text-slate-500">
            <span className="font-mono">{block.corridorId}</span> · {block.date} · {block.start}–
            {block.end} · {block.usedMinutes}/{block.capacityMinutes} min used
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
        >
          Close
        </button>
      </header>

      {accepted ? (
        <AcceptedResult override={accepted} onClose={onClose} />
      ) : (
        <div className="space-y-4 px-5 py-4">
          {/* 1. which task */}
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-700">1. Task to move</p>
            <div className="flex flex-wrap gap-2">
              {block.taskIds.map((id, index) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setTaskId(id)
                    setChoice(null)
                  }}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition ${
                    taskId === id
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <span className="font-mono">{id}</span>
                  {taskId !== id && <DepartmentPill department={block.departments[index]!} />}
                </button>
              ))}
            </div>
          </div>

          {/* 2. where to */}
          {taskId && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-700">
                2. New window{' '}
                <span className="font-normal text-slate-500">
                  — only windows this task genuinely fits are listed
                </span>
              </p>
              {targets.isLoading ? (
                <p className="text-xs text-slate-500">Checking which windows have room…</p>
              ) : (
                <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                  {(targets.data?.data ?? []).map((target) => {
                    const key = `${target.date}|${target.windowIndex}`
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setChoice(key)}
                        className={`rounded-lg border px-2.5 py-1.5 text-left text-xs transition ${
                          choice === key
                            ? 'border-sky-600 bg-sky-50'
                            : 'border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <span className="block font-medium text-slate-800">
                          {target.date.slice(5)} · {target.start}–{target.end}
                        </span>
                        <span className="block text-[11px] text-slate-500">
                          {target.freeMinutes} min free
                        </span>
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    onClick={() => setChoice('defer')}
                    className={`rounded-lg border px-2.5 py-1.5 text-left text-xs transition ${
                      choice === 'defer'
                        ? 'border-amber-500 bg-amber-50'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <span className="block font-medium text-amber-800">Defer instead</span>
                    <span className="block text-[11px] text-slate-500">remove from the plan</span>
                  </button>
                </div>
              )}
              {targets.data?.data.length === 0 && (
                <p className="text-xs text-amber-800">
                  No other window on this corridor has room for this task. Deferring is the only
                  option.
                </p>
              )}
            </div>
          )}

          {/* 3. why - FR6.2 makes this mandatory */}
          {choice && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-700">
                3. Reason <span className="font-normal text-slate-500">— required, and logged</span>
              </p>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                placeholder="e.g. Tamping machine unavailable on the original night shift"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
              />
            </div>
          )}

          {result.isError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
              <p className="text-xs font-semibold text-rose-900">Override refused</p>
              <p className="mt-0.5 text-xs text-rose-800">{describeApiError(result.error)}</p>
              <RejectedChecks error={result.error} />
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onConfirm}
              disabled={!taskId || !choice || reasonTooShort || result.isLoading}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {result.isLoading ? 'Re-validating…' : 'Confirm override'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

/** The constraint checks that ran, so a refusal is explicable rather than flat. */
function RejectedChecks({ error }: { error: unknown }) {
  const details = (error as { data?: { error?: { details?: { revalidation?: { checks?: Array<{ check: string; passed: boolean; detail: string }> } } } } })
    ?.data?.error?.details?.revalidation?.checks
  if (!details?.length) return null

  return (
    <ul className="mt-2 space-y-0.5">
      {details.map((check) => (
        <li key={check.check} className="flex gap-1.5 text-[11px] text-slate-600">
          <span className={check.passed ? 'text-emerald-600' : 'text-rose-600'}>
            {check.passed ? '✓' : '✕'}
          </span>
          <span>
            <span className="font-mono">{check.check}</span> — {check.detail}
          </span>
        </li>
      ))}
    </ul>
  )
}

function AcceptedResult({
  override,
  onClose,
}: {
  override: import('../api/apiSlice.ts').ScheduleOverride
  onClose: () => void
}) {
  return (
    <div className="px-5 py-4">
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
        <p className="text-sm font-semibold text-emerald-900">
          Override accepted — constraints re-validated
        </p>
        <p className="mt-0.5 text-xs text-emerald-800">
          <span className="font-mono">{override.taskId}</span>{' '}
          {override.action === 'defer' ? (
            <>deferred from {override.fromAssignment?.date}</>
          ) : (
            <>
              moved from {override.fromAssignment?.date} {override.fromAssignment?.start} to{' '}
              {override.newAssignment?.date} {override.newAssignment?.start}
            </>
          )}
        </p>
        <ul className="mt-2 space-y-0.5">
          {override.revalidation.checks.map((check) => (
            <li key={check.check} className="flex gap-1.5 text-[11px] text-emerald-900">
              <span>✓</span>
              <span>
                <span className="font-mono">{check.check}</span> — {check.detail}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Done
      </button>
    </div>
  )
}

export default OverridePanel
