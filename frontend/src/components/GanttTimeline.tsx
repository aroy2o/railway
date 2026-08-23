/**
 * Corridor possession timeline - the Gantt (PRD Section 8, task T12).
 *
 * Rows are corridors, the x-axis is one 24-hour day, and each bar is a block
 * the solver allocated. That is the shape a real possession chart takes, and it
 * is the only one that makes the question "when is this corridor free?"
 * answerable at a glance.
 *
 * A day selector rather than seven stacked axes: the week's work is very
 * unevenly spread (13 blocks on the first day, 1-4 on the others), so stacking
 * would be mostly empty space. The strip along the top keeps the whole horizon
 * visible - including the empty days, which are a real fact about corridor
 * availability rather than something to collapse away.
 */
import { useMemo, useState } from 'react'
import type { Department, ScheduleBlock } from '../api/apiSlice.ts'
import { HOUR_TICKS, blockKey, blockPosition, corridorRowsForDay, summariseDays } from '../lib/gantt.ts'

/** Reuses the DepartmentPill palette so colour means the same thing everywhere. */
const DEPARTMENT_BAR: Record<Department, string> = {
  Engineering: 'bg-sky-500',
  'S&T': 'bg-teal-500',
  TRD: 'bg-orange-500',
}
const DEPARTMENT_TEXT: Record<Department, string> = {
  Engineering: 'text-sky-700',
  'S&T': 'text-teal-700',
  TRD: 'text-orange-700',
}

interface GanttTimelineProps {
  blocks: ScheduleBlock[]
  horizonStart: string
  horizonDays: number
  /** When given, blocks become clickable to start a manual override (FR6.2). */
  onSelectBlock?: (block: ScheduleBlock) => void
  selectedBlockKey?: string | null
}

export function GanttTimeline({
  blocks,
  horizonStart,
  horizonDays,
  onSelectBlock,
  selectedBlockKey,
}: GanttTimelineProps) {
  const days = useMemo(
    () => summariseDays(blocks, horizonStart, horizonDays),
    [blocks, horizonStart, horizonDays],
  )
  // Open on the first day carrying a cross-department batch, falling back to
  // the busiest day.
  //
  // Not merely a demo convenience: a shared possession is the thing the
  // optimizer *did* that a human planner could not, so it is the most
  // informative day to review first. Defaulting to the busiest day instead
  // opened on a Monday with thirteen blocks and no batch at all - dense, but
  // showing none of the coordination the plan exists to produce.
  const defaultDay =
    days.find((day) => day.batchCount > 0) ??
    days.reduce((best, day) => (day.blockCount > best.blockCount ? day : best), days[0])
  const [selected, setSelected] = useState(defaultDay?.date ?? horizonStart)

  const rows = useMemo(() => corridorRowsForDay(blocks, selected), [blocks, selected])

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Corridor possession timeline</h2>
          <p className="text-xs text-slate-500">
            Blocks the optimizer allocated into real free windows, by corridor and time of day.
          </p>
        </div>
        <HorizonToggle />
      </header>

      {/* Whole-week strip: every day, including the empty ones. */}
      <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-5 py-3">
        {days.map((day) => {
          const isSelected = day.date === selected
          const label = new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, {
            weekday: 'short',
            day: 'numeric',
            timeZone: 'UTC',
          })
          return (
            <button
              key={day.date}
              type="button"
              onClick={() => setSelected(day.date)}
              className={`rounded-lg border px-2.5 py-1.5 text-left transition ${
                isSelected
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              } ${day.blockCount === 0 ? 'opacity-55' : ''}`}
            >
              <span className="block text-xs font-medium">{label}</span>
              <span className="block text-[11px] tabular-nums opacity-80">
                {day.blockCount === 0 ? 'no blocks' : `${day.blockCount} block${day.blockCount > 1 ? 's' : ''}`}
                {day.batchCount > 0 && ' · batch'}
              </span>
            </button>
          )
        })}
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-slate-500">
          No blocks scheduled on this day. Corridor time was either fully occupied by traffic or
          the work did not fit the windows available.
        </p>
      ) : (
        <div className="overflow-x-auto px-5 py-4">
          <div className="min-w-[720px]">
            {/* Hour axis */}
            <div className="mb-1 flex pl-[112px]">
              <div className="relative h-4 flex-1">
                {HOUR_TICKS.map((hour) => (
                  <span
                    key={hour}
                    className="absolute -translate-x-1/2 text-[10px] tabular-nums text-slate-400"
                    style={{ left: `${(hour / 24) * 100}%` }}
                  >
                    {String(hour).padStart(2, '0')}
                  </span>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              {rows.map((row) => (
                <div key={row.corridorId} className="flex items-center gap-2">
                  <span className="w-[104px] shrink-0 truncate font-mono text-[11px] text-slate-600">
                    {row.corridorId}
                  </span>
                  <div className="relative h-9 flex-1 rounded-md bg-slate-100">
                    {/* Gridlines every 3 hours, so a bar can be read against the clock. */}
                    {HOUR_TICKS.slice(1, -1).map((hour) => (
                      <span
                        key={hour}
                        className="absolute top-0 h-full w-px bg-white/70"
                        style={{ left: `${(hour / 24) * 100}%` }}
                      />
                    ))}
                    {row.blocks.map((block) => (
                      <BlockBar
                        key={`${block.windowIndex}-${block.startMinute}`}
                        block={block}
                        onSelect={onSelectBlock}
                        isSelected={selectedBlockKey === blockKey(block)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <Legend />
    </section>
  )
}

/**
 * One allocated block.
 *
 * A cross-department batch is drawn deliberately differently, not just tinted:
 * the bar is split into a segment per department and ringed in violet with an
 * explicit label. This is the single most important thing on the screen - one
 * possession serving two departments is the capability the whole system exists
 * to demonstrate - so it has to be legible to someone who has never seen the
 * project, not merely encoded in a colour they would have to decode.
 */
function BlockBar({
  block,
  onSelect,
  isSelected,
}: {
  block: ScheduleBlock
  onSelect?: (block: ScheduleBlock) => void
  isSelected?: boolean
}) {
  const position = blockPosition(block)
  const clickable = Boolean(onSelect)
  const interaction = clickable ? 'cursor-pointer hover:brightness-110' : ''
  const selectedRing = isSelected ? ' ring-2 ring-slate-900 ring-offset-1' : ''
  const departments = [...new Set(block.departments)] as Department[]
  const title =
    `${block.corridorId} · ${block.start}-${block.end} (${block.usedMinutes}/${block.capacityMinutes} min)\n` +
    `${departments.join(' + ')}\n${block.taskIds.join(', ')}`

  if (!block.isCrossDepartmentBatch) {
    return (
      <div
        title={clickable ? `${title}\n\nClick to override` : title}
        style={position}
        onClick={() => onSelect?.(block)}
        className={`absolute top-1 flex h-7 items-center overflow-hidden rounded px-1.5 ${
          DEPARTMENT_BAR[departments[0]] ?? 'bg-slate-500'
        } ${interaction}${selectedRing}`}
      >
        <span className="truncate text-[10px] font-medium text-white">
          {block.taskIds.length} task{block.taskIds.length > 1 ? 's' : ''}
        </span>
      </div>
    )
  }

  // Segment widths track each department's share of the work in the block, so
  // the split is proportional rather than decorative.
  const perDepartment = departments.map((department) => ({
    department,
    share: block.departments.filter((entry) => entry === department).length,
  }))
  const total = perDepartment.reduce((sum, entry) => sum + entry.share, 0)

  return (
    <div
      title={clickable ? `SHARED BLOCK — ${title}\n\nClick to override` : `SHARED BLOCK — ${title}`}
      style={position}
      onClick={() => onSelect?.(block)}
      className={`absolute -top-0.5 flex h-10 overflow-hidden rounded-md ring-2 ring-violet-600 ring-offset-1 ${interaction}`}
    >
      {perDepartment.map(({ department, share }) => (
        <div
          key={department}
          className={`flex items-center justify-center ${DEPARTMENT_BAR[department]}`}
          style={{ width: `${(share / total) * 100}%` }}
        >
          <span className="truncate px-1 text-[9px] font-semibold text-white">{department}</span>
        </div>
      ))}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-violet-600 text-center text-[8px] font-bold tracking-wide text-white uppercase">
        shared block
      </span>
    </div>
  )
}

/**
 * Weekly is real; monthly is not built.
 *
 * PRD FR3.2 promises both horizons, but a monthly plan needs the coarser
 * corridor-day reservation model of PRD Section 13, which is task T28. Faking
 * one by stretching weekly data would be inventing a plan the solver never
 * produced, so the control is visibly disabled and says why.
 */
function HorizonToggle() {
  return (
    <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
      <span className="rounded bg-white px-2.5 py-1 text-xs font-medium text-slate-900 shadow-sm">
        Weekly
      </span>
      <span
        title="Monthly planning needs the coarser corridor-day reservation model (PRD Section 13, task T28). Not yet built — showing a stretched weekly plan would be inventing one."
        className="cursor-not-allowed rounded px-2.5 py-1 text-xs font-medium text-slate-400"
      >
        Monthly · pending
      </span>
    </div>
  )
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 px-5 py-3 text-[11px] text-slate-500">
      {(Object.keys(DEPARTMENT_BAR) as Department[]).map((department) => (
        <span key={department} className="flex items-center gap-1.5">
          <span className={`h-2.5 w-4 rounded-sm ${DEPARTMENT_BAR[department]}`} />
          <span className={DEPARTMENT_TEXT[department]}>{department}</span>
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="flex h-3 w-8 overflow-hidden rounded-sm ring-2 ring-violet-600">
          <span className="h-full w-1/2 bg-teal-500" />
          <span className="h-full w-1/2 bg-orange-500" />
        </span>
        <span className="font-medium text-violet-700">
          Shared block — one possession, two departments
        </span>
      </span>
      <span className="ml-auto text-slate-400">Click a block to override its placement</span>
    </div>
  )
}

export default GanttTimeline
