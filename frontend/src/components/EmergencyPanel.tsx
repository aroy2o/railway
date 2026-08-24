/**
 * Emergency rolling re-optimization panel - PRD FR3.5, 9.10, task T27.
 *
 * "Simulate an emergency block request": pick a corridor and one of its
 * currently-scheduled windows, name what consumed it, and the optimizer
 * re-solves ONLY that corridor's remaining time around the disruption -
 * holding every other corridor, and everything already executed on this one,
 * exactly fixed. Unlike the What-if panel (T20), this COMMITS: submitting
 * creates a real NEW schedule (D-034), not a disposable hypothetical.
 */
import { useMemo, useState } from 'react'

import { describeApiError, useRunEmergencyReoptimizeMutation } from '../api/apiSlice.ts'
import type { Schedule, ScheduleBlock } from '../api/apiSlice.ts'
import { blockKey } from '../lib/gantt.ts'

function windowLabel(block: ScheduleBlock): string {
  return `${block.date} · ${block.start}–${block.end} (${block.taskIds.join(', ')})`
}

export function EmergencyPanel({
  scheduleId,
  blocks,
  onClose,
}: {
  scheduleId: string
  blocks: ScheduleBlock[]
  onClose: () => void
}) {
  const corridors = useMemo(
    () => Array.from(new Set(blocks.map((b) => b.corridorId))).sort(),
    [blocks],
  )
  const [corridorId, setCorridorId] = useState(corridors[0] ?? '')
  const corridorBlocks = useMemo(
    () => blocks.filter((b) => b.corridorId === corridorId),
    [blocks, corridorId],
  )
  const [selectedKey, setSelectedKey] = useState(
    corridorBlocks[0] ? blockKey(corridorBlocks[0]) : '',
  )
  const [reason, setReason] = useState('')
  const [run, result] = useRunEmergencyReoptimizeMutation()
  // Frozen at submit time. `blocks` is a live prop from the dashboard's own
  // `useGetLatestScheduleQuery` - the mutation below invalidates that same
  // query (this result becomes the new `latest`), so by the time the
  // response arrives `blocks` has ALREADY been refetched to the plan just
  // created. Diffing against the live prop at render time would silently
  // compare the new plan against itself and call everything "unchanged" -
  // a real bug this panel's own live verification caught before it shipped.
  const [beforeBlocks, setBeforeBlocks] = useState<ScheduleBlock[]>([])

  function onCorridorChange(nextCorridorId: string) {
    setCorridorId(nextCorridorId)
    const first = blocks.find((b) => b.corridorId === nextCorridorId)
    setSelectedKey(first ? blockKey(first) : '')
  }

  const selectedBlock = corridorBlocks.find((b) => blockKey(b) === selectedKey)

  async function onSubmit() {
    if (!selectedBlock || reason.trim().length < 8) return
    setBeforeBlocks(blocks)
    try {
      await run({
        scheduleId,
        corridorId,
        disruptedWindows: [{ date: selectedBlock.date, windowIndex: selectedBlock.windowIndex }],
        reason: reason.trim(),
      }).unwrap()
    } catch {
      // Rendered from `result.error` below.
    }
  }

  const newSchedule: Schedule | undefined = result.data?.data
  // A real diff, not a blanket "relocated" label - most of the corridor's
  // remaining blocks are likely untouched by one disrupted window, and
  // saying otherwise would overclaim exactly what this feature's own
  // framing promises not to (see EmergencyPanel's header text).
  const beforeKeys = new Set(
    beforeBlocks
      .filter((b) => b.corridorId === corridorId)
      .map((b) => `${blockKey(b)}|${[...b.taskIds].sort().join(',')}`),
  )
  const affectedOutcome = newSchedule
    ? {
        blocks: newSchedule.blocks
          .filter((b) => b.corridorId === corridorId)
          .map((b) => ({
            block: b,
            moved: !beforeKeys.has(`${blockKey(b)}|${[...b.taskIds].sort().join(',')}`),
          })),
        deferred: newSchedule.deferredTasks.filter((d) =>
          selectedBlock?.taskIds.includes(d.taskId),
        ),
      }
    : null

  if (corridors.length === 0) {
    return null
  }

  return (
    <section className="rounded-xl border-2 border-rose-300 bg-white shadow-sm">
      <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Simulate an emergency</h3>
          <p className="text-xs text-slate-500">
            Re-solves ONE corridor&rsquo;s remaining time around a disruption, holding every other
            corridor and everything already executed fixed (FR3.5, PRD 9.10). This commits a new
            schedule — unlike What-if, it is not disposable.
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

      <div className="space-y-3 px-5 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-slate-700">
            Affected corridor
            <select
              value={corridorId}
              onChange={(event) => onCorridorChange(event.target.value)}
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
            >
              {corridors.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs font-medium text-slate-700">
            Window the disruption consumes
            <select
              value={selectedKey}
              onChange={(event) => setSelectedKey(event.target.value)}
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
            >
              {corridorBlocks.length === 0 && <option value="">No scheduled block here</option>}
              {corridorBlocks.map((block) => (
                <option key={blockKey(block)} value={blockKey(block)}>
                  {windowLabel(block)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <textarea
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="What consumed this window? (required — recorded on the resulting plan)"
          className="w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
        />

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!selectedBlock || reason.trim().length < 8 || result.isLoading}
            onClick={() => void onSubmit()}
            className="rounded bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {result.isLoading ? 'Re-solving…' : 'Simulate emergency'}
          </button>
        </div>

        {result.error && (
          <p className="text-xs text-rose-700">{describeApiError(result.error)}</p>
        )}

        {newSchedule && affectedOutcome && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5">
            <p className="text-xs font-semibold text-emerald-900">
              New plan {newSchedule._id} generated — {newSchedule.status}
            </p>
            {affectedOutcome.blocks.length > 0 ? (
              <ul className="mt-1.5 space-y-1 text-xs text-emerald-900">
                {affectedOutcome.blocks.map(({ block, moved }) => (
                  <li key={blockKey(block)}>
                    {moved ? 'Moved to' : 'Unchanged at'} {block.date} {block.start}–{block.end}:{' '}
                    {block.taskIds.join(', ')}
                  </li>
                ))}
              </ul>
            ) : null}
            {affectedOutcome.deferred.length > 0 && (
              <ul className="mt-1.5 space-y-1 text-xs text-amber-800">
                {affectedOutcome.deferred.map((d) => (
                  <li key={d.taskId}>
                    {d.taskId} could not be placed in the remaining time: {d.reason}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-[11px] text-emerald-800">
              Every other corridor, and everything already executed on this one, is unchanged
              ({newSchedule.emergencyContext?.pinnedTaskCount ?? 0} tasks held fixed).
            </p>
          </div>
        )}
      </div>
    </section>
  )
}

export default EmergencyPanel
