/**
 * Seasonal / monsoon risk flag - PRD 9.9, T26.
 *
 * Reads `schedule.knownGaps.weatherRisk`, computed by `app.core.weather`
 * from a REAL corridor flag (Ministry of Jal Shakti flood-risk state data,
 * joined at seed time - T26's ingestion) crossed against India's real IMD
 * monsoon window. Same honesty pattern T16's `RISK_FRAMING` established for
 * predicted asset risk: real data, stated plainly, never silently baked
 * into a score or a schedule change. Advisory only - this panel does not
 * offer to move anything, because the solver never did either (D-068).
 */
import type { WeatherRiskBlock } from '../api/apiSlice.ts'

const FRAMING =
  'Real government flood-risk data (Ministry of Jal Shakti, by state) joined against real ' +
  "IMD monsoon dates (~June 1 – ~October 15). Coarse on purpose: state-level, not " +
  "section-specific, and only where a corridor's real station data carries a state at all. " +
  'Advisory only — the solver does not avoid or move these blocks; nothing here changes the plan.'

interface WeatherRiskPanelProps {
  weatherRisk?: { count: number; note: string; blocks: WeatherRiskBlock[] } | null
}

export function WeatherRiskPanel({ weatherRisk }: WeatherRiskPanelProps) {
  if (!weatherRisk) return null

  return (
    <section className="rounded-xl border border-sky-200 bg-sky-50/40 px-5 py-4">
      <h2 className="text-sm font-semibold text-slate-900">Seasonal risk (PRD 9.9)</h2>
      <p className="mt-1 text-xs text-slate-600">
        <span className="rounded bg-white px-1.5 py-0.5 font-semibold tabular-nums text-sky-800 ring-1 ring-sky-200 ring-inset">
          {weatherRisk.count}
        </span>{' '}
        scheduled block{weatherRisk.count === 1 ? '' : 's'} on a real monsoon-risk corridor,
        inside India's real monsoon window.
      </p>

      {weatherRisk.count > 0 && (
        <ul className="mt-2 space-y-1 border-t border-sky-100 pt-2">
          {weatherRisk.blocks.slice(0, 5).map((block, index) => (
            <li
              key={`${block.corridorId}-${block.date}-${index}`}
              className="text-[11px] text-slate-600"
            >
              <span className="font-mono text-slate-400">
                {block.corridorId} · {block.date}
              </span>{' '}
              {block.taskIds.join(', ')} ({block.departments.join(', ')})
            </li>
          ))}
          {weatherRisk.count > 5 && (
            <li className="text-[11px] text-slate-400">
              + {weatherRisk.count - 5} more block{weatherRisk.count - 5 === 1 ? '' : 's'}
            </li>
          )}
        </ul>
      )}

      <p className="mt-2 text-[11px] text-slate-500">{FRAMING}</p>
    </section>
  )
}

export default WeatherRiskPanel
