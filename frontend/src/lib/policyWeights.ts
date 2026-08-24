/**
 * Display logic for the T23 policy sliders (PRD Section 8, 13.1).
 *
 * WHY THE FIVE SLIDERS ARE THE RAW D-023 WEIGHTS, NOT PRD'S FOUR NAMED ONES
 * ---------------------------------------------------------------------
 * PRD Section 8 names four sliders: "Maintenance urgency," "Train punctuality,"
 * "Block utilization," "Risk avoidance." Two of those reference objective terms
 * that do not exist yet - risk-avoidance needs beta (asset risk in the
 * objective, not just the priority score) and train punctuality needs lambda
 * (T22 Phase B) - both explicitly deferred by D-023 itself. Labelling a slider
 * "Risk avoidance" would claim control over something this build cannot do,
 * which is exactly the kind of overclaim this project has refused everywhere
 * else (D-016, D-031, D-051...). So the five sliders here are the five REAL
 * D-023 terms, under honest labels - what each one actually does, not what a
 * four-slider demo narrative would prefer it did.
 *
 * WHY THE COPY SAYS "CHANGES WHEN, NOT WHAT"
 * -------------------------------------------
 * D-061 ran the real corpus against every weight at five multipliers each and
 * found the scheduled/deferred SET never changes - every deferral on this
 * 7-day corpus is structural (D-024), so there is nothing for these weights to
 * arbitrate. What DOES move, for every one of the five, is which DAY a
 * scheduled task lands on: 7 to 25 of the 36 scheduled tasks shift days at
 * every multiplier tested. A slider panel that implied "move this to schedule
 * more work" would be false on this dataset; what it genuinely demonstrates is
 * real, and this module states it as what it is.
 */

export interface WeightSpec {
  key: 'coverage' | 'slaCompliance' | 'batching' | 'unusedMinute' | 'fragmentation'
  label: string
  /** What this term actually rewards or penalises - not a restatement of the label. */
  description: string
  default: number
  /** D-061: the widest range verified safe, individually and in combination. */
  min: number
  max: number
  step: number
}

export const WEIGHT_SPECS: WeightSpec[] = [
  {
    key: 'coverage',
    label: 'Coverage priority',
    description: 'Reward for scheduling a task, scaled by its FR2.3 priority score.',
    default: 10_000,
    min: 1_000,
    max: 100_000,
    step: 1_000,
  },
  {
    key: 'slaCompliance',
    label: 'SLA compliance',
    description: 'Reward for landing a task on or before its SLA due date.',
    default: 2_000,
    min: 200,
    max: 20_000,
    step: 200,
  },
  {
    key: 'batching',
    label: 'Cross-department batching',
    description: 'Reward for a window carrying work from two or more departments at once.',
    default: 3_000,
    min: 300,
    max: 30_000,
    step: 300,
  },
  {
    key: 'unusedMinute',
    label: 'Packing tightness',
    description: 'Penalty per idle minute inside a window that was opened.',
    default: 1,
    min: 1,
    max: 10,
    step: 1,
  },
  {
    key: 'fragmentation',
    label: 'Fewer, larger possessions',
    description: 'Penalty for opening a window at all - favours consolidating work.',
    default: 500,
    min: 50,
    max: 5_000,
    step: 50,
  },
]

export type PolicyWeightsInput = Partial<Record<WeightSpec['key'], number>>

/**
 * Only the terms that differ from their D-023 default.
 *
 * Sent to `POST /schedules/generate` rather than the full set, so a plan
 * generated with every slider left at default is indistinguishable from one
 * generated before T23 existed - `policyWeights` on the response still names
 * every term (the optimizer fills in what was omitted), but the REQUEST stays
 * minimal, which is what makes "did the Controller touch this" answerable.
 */
export function toOverride(values: Record<WeightSpec['key'], number>): PolicyWeightsInput {
  const override: PolicyWeightsInput = {}
  for (const spec of WEIGHT_SPECS) {
    if (values[spec.key] !== spec.default) override[spec.key] = values[spec.key]
  }
  return override
}

export function defaultValues(): Record<WeightSpec['key'], number> {
  return Object.fromEntries(WEIGHT_SPECS.map((spec) => [spec.key, spec.default])) as Record<
    WeightSpec['key'],
    number
  >
}

/** Whether any slider has been moved off its D-023 default. */
export function hasOverride(values: Record<WeightSpec['key'], number>): boolean {
  return WEIGHT_SPECS.some((spec) => values[spec.key] !== spec.default)
}
