/**
 * One KPI's real history as a line - DRM oversight, TX6.
 *
 * The first `<svg>` in this codebase (a repo-wide grep found none before
 * this). Everything else here is div/CSS positioned, including the Gantt,
 * but a connected line between points is what a polyline is for - forcing
 * that into absolutely-positioned divs would be more code for a worse
 * result. No charting library: `MIN_POINTS_FOR_TREND` caps this at a
 * handful of points and one series shape, well inside what a plain
 * `<polyline>` + a few `<circle>`s can draw, and this project has
 * consistently chosen a small hand-built component over a dependency for
 * exactly this kind of bounded need (the Gantt itself, D-072's guided tour).
 */
import type { TrendSeries } from '../lib/trends.ts'
import { seriesRange } from '../lib/trends.ts'

const WIDTH = 600
const HEIGHT = 140
const PAD = { top: 12, right: 16, bottom: 24, left: 40 }

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function TrendChart({ series }: { series: TrendSeries }) {
  const { points } = series
  const { min, max } = seriesRange(points)
  const plotWidth = WIDTH - PAD.left - PAD.right
  const plotHeight = HEIGHT - PAD.top - PAD.bottom

  const x = (index: number) =>
    points.length > 1 ? PAD.left + (index / (points.length - 1)) * plotWidth : PAD.left + plotWidth / 2
  const y = (value: number) => {
    const range = max - min || 1
    return PAD.top + plotHeight - ((value - min) / range) * plotHeight
  }

  const pathPoints = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')
  const latest = points[points.length - 1]

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3.5 py-3">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">
          {series.label}
        </p>
        {latest && (
          <p className="text-sm font-semibold text-slate-900 tabular-nums">
            {latest.value.toFixed(series.unit === '%' ? 1 : 0)}
            <span className="ml-0.5 text-xs font-normal text-slate-400">{series.unit}</span>
          </p>
        )}
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-1.5 w-full"
        role="img"
        aria-label={`${series.label} over ${points.length} real plan generations`}
      >
        {/* Two gridlines: the axis floor and the max, labelled - not a full grid, which would compete with the line for a chart this small. */}
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={y(min)}
          y2={y(min)}
          className="stroke-slate-200"
          strokeWidth={1}
        />
        <text x={4} y={y(min) + 3} className="fill-slate-400 text-[9px]">
          {min.toFixed(0)}
        </text>
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={y(max)}
          y2={y(max)}
          className="stroke-slate-100"
          strokeWidth={1}
        />
        <text x={4} y={y(max) + 3} className="fill-slate-400 text-[9px]">
          {max.toFixed(0)}
        </text>

        <polyline
          points={pathPoints}
          fill="none"
          className="stroke-sky-600"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p, i) => (
          <circle key={p.scheduleId} cx={x(i)} cy={y(p.value)} r={3} className="fill-sky-600">
            <title>
              {p.scheduleId} · {formatDate(p.generatedAt)} · {p.value.toFixed(1)}
              {series.unit}
            </title>
          </circle>
        ))}

        {/* X labels: every point if there are few, else just the ends - a
            label per point on ten real generations would overlap into
            noise. */}
        {(points.length <= 6 ? points.map((_, i) => i) : [0, points.length - 1]).map((i) => (
          <text
            key={i}
            x={x(i)}
            y={HEIGHT - 6}
            textAnchor="middle"
            className="fill-slate-400 text-[9px]"
          >
            {formatDate(points[i]!.generatedAt)}
          </text>
        ))}
      </svg>
      <p className="mt-1 text-[11px] text-slate-500">{series.detail}</p>
    </div>
  )
}

export default TrendChart
