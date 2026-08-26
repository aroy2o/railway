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
import {
  HOUR_TICKS,
  blockKey,
  blockPosition,
  corridorRowsForDay,
  defaultSelectedDay,
  monthlyReservationRows,
  summariseDays,
  type ReservationRow,
} from '../lib/gantt.ts'

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
  /** PRD Section 15's own enum (`"weekly"|"monthly"`) - which real solve this
   * plan came from, not a view mode chosen in the browser (T28). */
  horizon: string
  /**
   * When given, blocks become clickable to open the Task/Block Detail
   * Drill-down (PRD Section 8 screen 7, TX5) - a read-only inspection, not
   * an override. Deliberately NOT gated on override permission: a published
   * plan or a DRM's read-only session should still be able to inspect a
   * block, even though neither can act on it. Overriding is reached FROM
   * the drill-down (a button inside it, shown only when legal), not from
   * this click directly - see `docs/DECISIONS.md` D-080.
   */
  onSelectBlock?: (block: ScheduleBlock) => void
  selectedBlockKey?: string | null
  /** Purely for the legend hint below - whether the drill-down this click
   * opens will itself offer an override button. Never gates the click. */
  overridable?: boolean
  /** T28: re-solve at the other horizon. Omitted keeps the toggle a plain
   * (real, not faked) indicator rather than a control - e.g. inside a
   * what-if or emergency panel, where triggering a full regenerate makes no
   * sense. */
  onSelectHorizon?: (horizonDays: 7 | 30) => void
  isGeneratingHorizon?: boolean
}

export function GanttTimeline({
  blocks,
  horizonStart,
  horizonDays,
  horizon,
  onSelectBlock,
  selectedBlockKey,
  overridable = false,
  onSelectHorizon,
  isGeneratingHorizon,
}: GanttTimelineProps) {
  const isMonthly = horizon === 'monthly'

  const days = useMemo(
    () => summariseDays(blocks, horizonStart, horizonDays),
    [blocks, horizonStart, horizonDays],
  )
  // D-075: open on today when it falls inside the horizon, else fall back to
  // D-040's heuristic (first cross-department batch, else the busiest day).
  const [selected, setSelected] = useState(() =>
    defaultSelectedDay(days, new Date().toISOString().slice(0, 10)),
  )

  const rows = useMemo(() => corridorRowsForDay(blocks, selected), [blocks, selected])

  return (
    <section
      data-tour="dashboard-gantt"
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Corridor possession timeline
          </h2>
          <p className="text-xs text-slate-500">
            {isMonthly
              ? 'The same real solve as Weekly, at corridor-day resolution (PRD 13’s reservation level) - which department(s) hold each corridor each day, not the exact time.'
              : 'Blocks the optimizer allocated into real free windows, by corridor and time of day.'}
          </p>
        </div>
        <HorizonToggle
          horizon={horizon}
          onSelect={onSelectHorizon}
          isGenerating={isGeneratingHorizon}
        />
      </header>

      {isMonthly ? (
        <MonthlyReservationGrid blocks={blocks} horizonStart={horizonStart} horizonDays={horizonDays} />
      ) : (
        <>
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
                    {day.blockCount === 0
                      ? 'no blocks'
                      : `${day.blockCount} block${day.blockCount > 1 ? 's' : ''}`}
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
        </>
      )}

      <Legend
        clickable={!isMonthly && onSelectBlock !== undefined}
        overridable={!isMonthly && overridable}
      />
    </section>
  )
}

/**
 * Corridor-day reservation heatmap (T28, PRD Section 13).
 *
 * Deliberately read-only: a reservation cell can represent SEVERAL blocks in
 * one day, so it has no single (corridor, date, windowIndex) to hand T15's
 * override endpoint. Overriding a specific placement still happens on the
 * Weekly view, which is exact-slot by construction.
 */
function MonthlyReservationGrid({
  blocks,
  horizonStart,
  horizonDays,
}: {
  blocks: ScheduleBlock[]
  horizonStart: string
  horizonDays: number
}) {
  const rows = useMemo(
    () => monthlyReservationRows(blocks, horizonStart, horizonDays),
    [blocks, horizonStart, horizonDays],
  )

  if (rows.length === 0) {
    return (
      <p className="px-5 py-10 text-center text-sm text-slate-500">
        No corridor carries a reservation anywhere in this month.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto px-5 py-4">
      <div className="min-w-[720px]">
        <div className="mb-1 flex pl-[112px]">
          {rows[0]!.days.map((day) => (
            <span
              key={day.date}
              className="flex-1 text-center text-[9px] tabular-nums text-slate-400"
            >
              {new Date(`${day.date}T00:00:00Z`).getUTCDate()}
            </span>
          ))}
        </div>
        <div className="space-y-1">
          {rows.map((row) => (
            <div key={row.corridorId} className="flex items-center gap-2">
              <span className="w-[104px] shrink-0 truncate font-mono text-[11px] text-slate-600">
                {row.corridorId}
              </span>
              <div className="flex flex-1 gap-[2px]">
                {row.days.map((day) => (
                  <ReservationCell key={day.date} day={day} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ReservationCell({ day }: { day: ReservationRow['days'][number] }) {
  if (day.departments.length === 0) {
    return <span className="h-5 flex-1 rounded-sm bg-slate-100" title={`${day.date} — no reservation`} />
  }
  const title =
    `${day.date} — ${day.departments.join(' + ')}` +
    (day.isCrossDepartmentBatch ? ' (shared block)' : '') +
    ` — ${day.blockCount} block${day.blockCount > 1 ? 's' : ''}`

  if (day.departments.length === 1) {
    return (
      <span
        title={title}
        className={`h-5 flex-1 rounded-sm ${DEPARTMENT_BAR[day.departments[0]!]}`}
      />
    )
  }
  // More than one department on the same day - split the cell, and ring it
  // the same violet the hourly view uses for a shared block, so the same
  // colour means the same thing on both screens.
  return (
    <span
      title={title}
      className={`flex h-5 flex-1 overflow-hidden rounded-sm ${
        day.isCrossDepartmentBatch ? 'ring-1 ring-violet-600' : ''
      }`}
    >
      {day.departments.map((department) => (
        <span key={department} className={`flex-1 ${DEPARTMENT_BAR[department]}`} />
      ))}
    </span>
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
        title={clickable ? `${title}\n\nClick for details` : title}
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
      title={clickable ? `SHARED BLOCK — ${title}\n\nClick for details` : `SHARED BLOCK — ${title}`}
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
/**
 * T28: both horizons are real now, each a genuine re-solve at that many
 * days (docs/DECISIONS.md D-070) - never a cached view switch over the same
 * data, because the two ARE different real solves.
 */
function HorizonOption({
  label,
  active,
  horizonDays,
  canSelect,
  onSelect,
}: {
  label: string
  active: boolean
  horizonDays: 7 | 30
  canSelect: boolean
  onSelect?: (horizonDays: 7 | 30) => void
}) {
  if (active) {
    return (
      <span className="rounded bg-white px-2.5 py-1 text-xs font-medium text-slate-900 shadow-sm">
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      disabled={!canSelect}
      onClick={() => onSelect?.(horizonDays)}
      title={
        onSelect
          ? `Re-solve for real at this horizon (a genuine ${horizonDays}-day CP-SAT run)`
          : undefined
      }
      className="rounded px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:bg-white hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  )
}

function HorizonToggle({
  horizon,
  onSelect,
  isGenerating,
}: {
  horizon: string
  onSelect?: (horizonDays: 7 | 30) => void
  isGenerating?: boolean
}) {
  const isMonthly = horizon === 'monthly'
  const canSelect = Boolean(onSelect) && !isGenerating

  return (
    <div
      data-tour="dashboard-horizon-toggle"
      className="flex items-center gap-1 rounded-lg bg-slate-100 p-1"
    >
      <HorizonOption label="Weekly" active={!isMonthly} horizonDays={7} canSelect={canSelect} onSelect={onSelect} />
      <HorizonOption label="Monthly" active={isMonthly} horizonDays={30} canSelect={canSelect} onSelect={onSelect} />
      {isGenerating && <span className="px-1.5 text-[11px] text-slate-400">solving…</span>}
    </div>
  )
}

function Legend({
  clickable,
  overridable,
}: {
  clickable: boolean
  overridable: boolean
}) {
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
      {/* Only offered when the caller actually accepts a selection (never on
          the read-only monthly grid, which has no single block to select -
          see MonthlyReservationGrid's own comment). Inspecting a block is
          always available once clickable; overriding is a further action
          reached from inside the drill-down, so the hint says so only when
          that door is actually open (D-080) - a published plan is frozen
          (T19), and promising an action the server would then refuse reads
          as the system being broken rather than as the plan being closed. */}
      {clickable && (
        <span className="ml-auto text-slate-400">
          Click a block for details{overridable ? ' · override from there' : ''}
        </span>
      )}
    </div>
  )
}

export default GanttTimeline
