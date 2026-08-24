/**
 * T23's policy sliders (PRD Section 8, 13.1).
 *
 * Adjusting a slider does not solve anything by itself - "Regenerate with
 * these weights" runs a new solve, following T12/T13's Generate-schedule
 * pattern (a new schedule document, per D-034, not an edit to this one).
 *
 * The caption states D-061's finding plainly: on this week's real backlog,
 * every deferral is structural, so no slider changes WHICH tasks are done -
 * only WHEN, and how tightly packed. Letting a Controller believe otherwise
 * would be the exact overclaim this project has refused at every other layer.
 */
import { useState } from 'react'

import {
  WEIGHT_SPECS,
  defaultValues,
  hasOverride,
  toOverride,
  type PolicyWeightsInput,
} from '../lib/policyWeights.ts'

export function PolicySliders({
  onRegenerate,
  isLoading,
}: {
  onRegenerate: (weights: PolicyWeightsInput) => void
  isLoading: boolean
}) {
  const [values, setValues] = useState(defaultValues())
  const moved = hasOverride(values)

  return (
    <section
      data-tour="dashboard-policy-sliders"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 className="text-sm font-semibold text-slate-900">Policy weights</h2>
      <p className="mt-1 text-xs text-slate-500">
        These change <span className="font-medium text-slate-700">when</span> work happens and
        how it is grouped. On this week&apos;s backlog every deferral is structural (see Deferred
        work below) — no combination of these changes <span className="font-medium">which</span>{' '}
        tasks get scheduled.
      </p>

      <div className="mt-4 space-y-4">
        {WEIGHT_SPECS.map((spec) => (
          <div key={spec.key}>
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={`weight-${spec.key}`} className="text-xs font-medium text-slate-700">
                {spec.label}
              </label>
              <span className="font-mono text-[11px] text-slate-500">
                {values[spec.key].toLocaleString()}
                {values[spec.key] !== spec.default && (
                  <span className="ml-1 text-sky-600">
                    ({values[spec.key] > spec.default ? '+' : ''}
                    {Math.round(((values[spec.key] - spec.default) / spec.default) * 100)}%)
                  </span>
                )}
              </span>
            </div>
            <input
              id={`weight-${spec.key}`}
              type="range"
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={values[spec.key]}
              onChange={(event) =>
                setValues((prev) => ({ ...prev, [spec.key]: Number(event.target.value) }))
              }
              className="mt-1 w-full accent-slate-900"
            />
            <p className="mt-0.5 text-[11px] text-slate-400">{spec.description}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={isLoading}
          onClick={() => onRegenerate(toOverride(values))}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? 'Solving…' : moved ? 'Regenerate with these weights' : 'Regenerate'}
        </button>
        {moved && (
          <button
            type="button"
            disabled={isLoading}
            onClick={() => setValues(defaultValues())}
            className="text-xs text-slate-500 hover:text-slate-800"
          >
            Reset to defaults
          </button>
        )}
      </div>
    </section>
  )
}

export default PolicySliders
