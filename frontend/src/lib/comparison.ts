/**
 * Turns `comparisonToBaseline` into ordered, verdict-tagged metric rows.
 *
 * This module exists so D-031's framing rules are *executable* rather than
 * prose a layout can quietly drift away from. Three rules, all enforced here:
 *
 *   1. The comparison is drawn from the structurally contestable subset. The
 *      denominator travels with the numbers (`contestableTaskCount`).
 *   2. Scheduled-task count must never lead, because on this dataset both
 *      engines schedule the same work. It is ordered last and tagged
 *      `no-difference`, so a layout that renders rows in order cannot
 *      accidentally headline it.
 *   3. Utilisation must never appear without its conflict count. It is not a
 *      row of its own - it is carried *inside* the utilisation row as
 *      `pairedWith`, so the two cannot be separated by any renderer.
 */

export interface ComparisonSide {
  contestableScheduled: number;
  /**
   * T29 Phase 1 (D-084). Always 0 for the baseline - it has no splitting
   * concept at all. Optional because a schedule generated before this field
   * existed genuinely lacks it in storage - never assume 0 means "checked
   * and found none" for such a schedule; it means "not computed".
   */
  splitOnlyScheduled?: number;
  crossDepartmentBatches: number;
  doubleBookings: number;
  doubleBookedMinutes: number;
  overSubscribedWindows: number;
  blockMinutesUsed: number;
  blockUtilisationPct: number;
  /**
   * D-093. The ν objective term's own proxy (fewer, fuller possessions).
   * Optional for the same storage-compatibility reason as
   * `splitOnlyScheduled` - absent on a schedule generated before this field
   * existed.
   */
  blocksUsed?: number;
  /** D-093. Of the contestable tasks THIS engine scheduled, how many landed on or before their real slaDueDate. */
  contestableWithinSla?: number;
  /** D-093. Of `ComparisonToBaseline.criticalContestableCount`, how many did this engine schedule. */
  criticalScheduled?: number;
  /** D-093. Of `ComparisonToBaseline.highRiskContestableCount`, how many did this engine schedule. */
  highRiskScheduled?: number;
}

export interface ComparisonToBaseline {
  contestableTaskCount: number;
  /**
   * T29 Phase 1 (D-084). Tasks that fit no single window but that the
   * optimizer can place by splitting work across non-contiguous sessions -
   * a capability the baseline structurally does not have. Never folded into
   * `contestableTaskCount`: that would imply the baseline could also do
   * this work, which it cannot, at any horizon length. Optional for the
   * same storage-compatibility reason as `ComparisonSide.splitOnlyScheduled`.
   */
  splitOnlyTaskCount?: number;
  structurallyImpossibleCount: number;
  /**
   * D-093. Priority coverage's fixed denominator - "high severity" (>= 4)
   * contestable tasks. See scheduleOrchestrator.ts's `buildComparison` for
   * why this is >= 4, not the PRD 5.2 top band (5): the real corpus this
   * ships against contains zero severity-5 defects.
   */
  criticalContestableCount?: number;
  /**
   * D-093. Risk reduction's fixed denominator - the top quartile by
   * `failureRiskScore` among contestable tasks the model actually scored.
   * 0 whenever `riskFraming` is null.
   */
  highRiskContestableCount?: number;
  /**
   * D-093. `risk.py`'s PRD 9.1 FRAMING, verbatim. Null whenever no task this
   * generation carries a real risk score - the risk-reduction card must not
   * render at all without this (never a number without its caveat).
   */
  riskFraming?: string | null;
  optimized: ComparisonSide;
  baseline: ComparisonSide;
  caveats: string[];
}

/**
 * What a metric pair actually means, rather than which number is bigger.
 *
 * `baseline-higher-but-worse` is the one that matters: the baseline's block
 * utilisation beats the optimizer's, and rendered as a bare pair of numbers it
 * reads as the baseline winning. It is higher *because* it over-subscribes
 * windows it cannot physically honour.
 *
 * `optimizer-fewer-by-design` is T24's addition, and the mirror case: the
 * optimizer's contestable-scheduled count can now be genuinely LOWER than the
 * baseline's, because it (unlike the baseline) refuses to place a task before
 * its PRD 9.7 prerequisite. Tagging that `optimizer-better` (the old default
 * for "the numbers differ") would render a green "improvement" badge over a
 * smaller number - exactly the kind of bare-number trap this module exists to
 * prevent, just in the opposite direction from `baseline-higher-but-worse`.
 */
export type Verdict =
  | 'optimizer-better'
  | 'no-difference'
  | 'baseline-higher-but-worse'
  | 'optimizer-fewer-by-design';

export interface MetricRow {
  key: string;
  label: string;
  baseline: string;
  optimized: string;
  verdict: Verdict;
  /** Why this row reads the way it does. Rendered, never optional in the UI. */
  note: string;
  /** Emphasis tier - `headline` rows are the ones the screen leads with. */
  emphasis: 'headline' | 'supporting';
  /**
   * A second metric that must be rendered in the SAME card as this one.
   * Utilisation carries its conflict count here so no layout can show one
   * without the other (D-031, caveat 3).
   */
  pairedWith?: { label: string; baseline: string; optimized: string; note: string };
  /**
   * D-093. A disclaimer that must render at EQUAL visual weight to this
   * row's number, not a footnote - unlike `caveats[]` (collapsed, low-key,
   * click-to-expand), this renders inline, always visible, same box style
   * as `pairedWith`. For a caveat about the MODEL behind the number (e.g.
   * risk.py's PRD 9.1 FRAMING), not a second metric - so no baseline/
   * optimized values, just the disclaimer itself.
   */
  caveatBox?: { label: string; note: string };
}

const fmt = (value: number): string => value.toLocaleString();

/** Shared by every rate computation in this module - one rounding rule, one divide-by-zero guard. */
const pct = (numerator: number, denominator: number): number =>
  denominator > 0 ? Math.round((100 * numerator) / denominator) : 0;

/**
 * Build the metric rows in the order the screen must present them.
 *
 * Conflicts and batching first - those are the real, defensible differences.
 * Throughput last and explicitly neutral.
 */
export function buildMetricRows(comparison: ComparisonToBaseline): MetricRow[] {
  const { baseline, optimized, contestableTaskCount } = comparison;
  const splitOnlyTaskCount = comparison.splitOnlyTaskCount ?? 0;
  const baselineSplitOnly = baseline.splitOnlyScheduled ?? 0;
  const optimizedSplitOnly = optimized.splitOnlyScheduled ?? 0;

  // T29 Phase 1 (D-084): a real, load-bearing capability difference, not a
  // footnote - the baseline cannot place ANY of these tasks, at any horizon
  // length, because it has no concept of splitting work across
  // non-contiguous sessions. Omitted (not shown as a hollow "0 / 0") on a
  // schedule generated before this field existed, or on a corpus that
  // happens to have no split-only-eligible tasks at all.
  const splitOnlyRow: MetricRow[] =
    splitOnlyTaskCount > 0
      ? [
          {
            key: 'splitOnly',
            label: 'Tasks placeable only by splitting',
            baseline: `${fmt(baselineSplitOnly)} / ${fmt(splitOnlyTaskCount)}`,
            optimized: `${fmt(optimizedSplitOnly)} / ${fmt(splitOnlyTaskCount)}`,
            verdict: 'optimizer-better',
            note:
              `${fmt(splitOnlyTaskCount)} task(s) fit no single window on their corridor, so ` +
              `this baseline process can never place them - not a lower success rate, a ` +
              `capability it structurally does not have, at any horizon length. The optimizer ` +
              `places ${fmt(optimizedSplitOnly)} of them by splitting the work across ` +
              `non-contiguous sessions (T29 Phase 1). Counted separately from the contestable ` +
              `comparison below - never folded in, since that would credit the baseline with a ` +
              `capability it does not have.`,
            emphasis: 'headline',
          },
        ]
      : [];

  // D-093: fragmentation (the ν objective term's own proxy - fewer, fuller
  // possessions). Omitted on a schedule generated before this field existed
  // (same storage-compatibility reason as `splitOnlyRow` above).
  //
  // NOT presented as a clean, independent win: on the real corpus this ships
  // against, the drop in possessions used tracks almost exactly with the
  // drop in contestable tasks scheduled (see the `scheduled` row below) -
  // the optimizer is not obviously packing tighter, mostly it is placing
  // less work. Both percentages are computed from data already on this
  // comparison, not hardcoded, so the note stays honest as the real numbers
  // shift across runs.
  const fragmentationRow: MetricRow[] =
    baseline.blocksUsed !== undefined && optimized.blocksUsed !== undefined
      ? [
          (() => {
            const scheduledDeltaPct = pct(
              baseline.contestableScheduled - optimized.contestableScheduled,
              baseline.contestableScheduled,
            );
            const blocksDeltaPct = pct(baseline.blocksUsed! - optimized.blocksUsed!, baseline.blocksUsed!);
            // Computed, never asserted - the same same/fewer/more shape the
            // `scheduled` row below uses, so a corpus where the optimizer
            // ever uses MORE possessions (or exactly as many) reports that
            // honestly instead of a hardcoded win.
            //
            // NOTE on the "more" branch: unlike `scheduled` (where a bigger
            // optimized number is genuinely better), fewer possessions is
            // this metric's OWN definition of better - the ν objective term
            // directly rewards fewer, fuller ones. So `optimizer-better` here
            // is reused purely for its "render no badge" effect (this page's
            // badge vocabulary has no 4th tag for "the optimizer's own
            // number is a plain, honest regression on this one axis"), not
            // because more possessions would actually be a win. Unreachable
            // against every real corpus this has shipped against so far
            // (the optimizer has never used more possessions than the
            // baseline) - if it ever is reached, `note` below is what tells
            // the truth, not the verdict tag.
            const same = optimized.blocksUsed === baseline.blocksUsed;
            const fewer = optimized.blocksUsed! < baseline.blocksUsed!;
            return {
              key: 'fragmentation',
              label: 'Possessions used',
              baseline: fmt(baseline.blocksUsed!),
              optimized: fmt(optimized.blocksUsed!),
              verdict: same ? 'no-difference' : fewer ? 'optimizer-fewer-by-design' : 'optimizer-better',
              note: same
                ? 'No difference in possessions used on this dataset.'
                : fewer
                  ? `Most of this gap tracks the ${scheduledDeltaPct}% fewer contestable tasks ` +
                    `scheduled here (see below), not additional packing efficiency on top of it - ` +
                    `${blocksDeltaPct}% fewer possessions for ${scheduledDeltaPct}% less work is ` +
                    `close to proportional, not a clean fragmentation win.`
                  : 'The optimizer uses more possessions than the baseline for this work - a ' +
                    'genuine regression on this axis, not a rounding artifact.',
              // D-093 -> this redesign: moved out of the "structural" tier -
              // unlike double-booking/batching, this number is confounded by
              // the scheduled-task-count gap, so it belongs with the other
              // "the AI's number looks smaller, and that's not a defect"
              // rows, not beside the two unambiguous wins.
              emphasis: 'supporting',
            } satisfies MetricRow;
          })(),
        ]
      : [];

  return [
    ...splitOnlyRow,
    {
      key: 'doubleBookings',
      label: 'Double-booked corridors',
      baseline: fmt(baseline.doubleBookings),
      optimized: fmt(optimized.doubleBookings),
      verdict: 'optimizer-better',
      note:
        `Two departments holding the same corridor at the same time. The baseline produces ` +
        `${fmt(baseline.doubleBookedMinutes)} minutes of overlap it cannot physically honour; ` +
        `both crews arrive and one is turned away.`,
      emphasis: 'headline',
    },
    {
      key: 'batches',
      label: 'Cross-department shared blocks',
      baseline: fmt(baseline.crossDepartmentBatches),
      optimized: fmt(optimized.crossDepartmentBatches),
      verdict: 'optimizer-better',
      note:
        'One possession serving two departments, so the corridor is taken out of traffic once ' +
        'instead of twice. Structurally unreachable for the baseline: departments book ' +
        'independently and cannot see each other.',
      emphasis: 'headline',
    },
    {
      key: 'utilisation',
      label: 'Block utilisation',
      baseline: `${baseline.blockUtilisationPct}%`,
      optimized: `${optimized.blockUtilisationPct}%`,
      // The trap, named rather than hidden.
      verdict: 'baseline-higher-but-worse',
      note:
        'The baseline scores HIGHER here, and that is the defect showing rather than an ' +
        'advantage. Both plans place the same work; the baseline fits it into fewer windows by ' +
        'over-subscribing some beyond their capacity.',
      emphasis: 'supporting',
      pairedWith: {
        label: 'Over-subscribed windows',
        baseline: fmt(baseline.overSubscribedWindows),
        optimized: fmt(optimized.overSubscribedWindows),
        note: 'Windows claimed for more work than they can hold — the cause of the number above.',
      },
    },
    (() => {
      const same = baseline.contestableScheduled === optimized.contestableScheduled;
      const fewer = optimized.contestableScheduled < baseline.contestableScheduled;
      return {
        key: 'scheduled',
        label: 'Contestable tasks scheduled',
        baseline: `${fmt(baseline.contestableScheduled)} / ${fmt(contestableTaskCount)}`,
        optimized: `${fmt(optimized.contestableScheduled)} / ${fmt(contestableTaskCount)}`,
        verdict: same
          ? 'no-difference'
          : fewer
            ? 'optimizer-fewer-by-design'
            : 'optimizer-better',
        note: same
          ? 'No throughput advantage on this dataset — both engines place the same work. The ' +
            'optimizer’s advantage is that its plan is executable, not that it does more.'
          : fewer
            ? `The optimizer schedules ${fmt(baseline.contestableScheduled - optimized.contestableScheduled)} ` +
              `fewer contestable task(s) than the baseline. It refuses to place a task before its ` +
              `PRD 9.7 prerequisite completes - a rule the baseline, with no dependency awareness, ` +
              `silently breaks. Every "fewer, by design" row below traces back to this same gap.`
            : 'The optimizer schedules more of the contestable backlog than the baseline.',
        emphasis: 'supporting',
      } satisfies MetricRow;
    })(),
    ...fragmentationRow,
    ...slaComplianceRow(comparison),
    ...priorityCoverageRow(comparison),
    ...riskReductionRow(comparison),
  ];
}

/**
 * D-093 (ε, SLA Compliance). Of the contestable tasks THIS engine scheduled,
 * how many landed on or before their real `slaDueDate` - a split task's LAST
 * segment decides it, exactly matching the optimizer's own `within_sla`
 * CP-SAT variable. Denominator is the fixed `contestableTaskCount`, same as
 * every other row here, so the two sides are directly comparable.
 *
 * On the real corpus this ships against, the baseline's raw count reads
 * higher for the SAME reason `scheduled` above reads higher - it schedules
 * more of the backlog overall, including via double-booking. The fairer
 * "quality of what was scheduled" reading (on-time as a fraction of each
 * engine's OWN scheduled count) usually favours the optimizer instead, so
 * the note carries that reading rather than letting the raw pair stand
 * alone as if a bigger number here were simply better (D-031's own utilisation
 * trap, in a new place).
 */
function slaComplianceRow(comparison: ComparisonToBaseline): MetricRow[] {
  const { baseline, optimized, contestableTaskCount } = comparison;
  if (baseline.contestableWithinSla === undefined || optimized.contestableWithinSla === undefined) {
    return [];
  }
  const baselineRatePct = pct(baseline.contestableWithinSla, baseline.contestableScheduled);
  const optimizedRatePct = pct(optimized.contestableWithinSla, optimized.contestableScheduled);
  const fewer = optimized.contestableWithinSla < baseline.contestableWithinSla;

  return [
    {
      key: 'slaCompliance',
      label: 'Contestable tasks scheduled on time',
      baseline: `${fmt(baseline.contestableWithinSla)} / ${fmt(contestableTaskCount)}`,
      optimized: `${fmt(optimized.contestableWithinSla)} / ${fmt(contestableTaskCount)}`,
      verdict: fewer ? 'optimizer-fewer-by-design' : 'optimizer-better',
      note: fewer
        ? `Scored as a share of what each engine actually scheduled - the fairer reading, since ` +
          `it isn't rewarded for over-committing - the optimizer is on time ${optimizedRatePct}% ` +
          `of the time against the baseline's ${baselineRatePct}%.`
        : `The optimizer both schedules on-time work at a higher rate (${optimizedRatePct}% vs ` +
          `${baselineRatePct}% of what each engine actually scheduled) and delivers more of it ` +
          `in absolute terms.`,
      emphasis: 'supporting',
    },
  ];
}

/**
 * D-093 (α, Maintenance Priority / "priority coverage"). Of the fixed
 * "high-severity" (>= 4) contestable bucket - see scheduleOrchestrator.ts's
 * `buildComparison` for why this is not PRD 5.2's literal severity-5 band -
 * how many did each engine schedule. Hidden entirely when the bucket is
 * empty (`criticalContestableCount` 0 or absent): a "0 / 0" card asserts
 * nothing and would just be noise.
 */
function priorityCoverageRow(comparison: ComparisonToBaseline): MetricRow[] {
  const { baseline, optimized, criticalContestableCount } = comparison;
  if (
    !criticalContestableCount ||
    baseline.criticalScheduled === undefined ||
    optimized.criticalScheduled === undefined
  ) {
    return [];
  }
  const fewer = optimized.criticalScheduled < baseline.criticalScheduled;

  return [
    {
      key: 'priorityCoverage',
      label: 'High-severity tasks scheduled',
      baseline: `${fmt(baseline.criticalScheduled)} / ${fmt(criticalContestableCount)}`,
      optimized: `${fmt(optimized.criticalScheduled)} / ${fmt(criticalContestableCount)}`,
      verdict: fewer ? 'optimizer-fewer-by-design' : 'optimizer-better',
      note: fewer
        ? `The baseline has no concept of severity at all - it is purely first-come-first-served, ` +
          `so its full coverage here is coincidence, not favouritism toward severe defects. The ` +
          `gap (${fmt(baseline.criticalScheduled - optimized.criticalScheduled)} task(s)) is small ` +
          `enough that the same constraints above account for all of it.`
        : `The optimizer schedules more of the high-severity backlog than the baseline.`,
      emphasis: 'supporting',
    },
  ];
}

/**
 * D-093 (β, Asset Risk Reduction). Of the fixed "flagged high-risk"
 * contestable bucket (top quartile by `failureRiskScore` among contestable
 * tasks the model actually scored), how many did each engine schedule.
 * Framed as coverage of a flagged backlog, never as "risk reduced" - neither
 * engine reduces risk, they only choose what to schedule.
 *
 * Hidden entirely when `riskFraming` is null (no risk model ran this
 * generation) - this row must never render a risk number without it, per
 * PRD 9.1. When it does render, `caveatBox` carries `risk.py`'s FRAMING
 * verbatim at the SAME visual weight as the number (D-093), not a footnote.
 */
function riskReductionRow(comparison: ComparisonToBaseline): MetricRow[] {
  const { baseline, optimized, highRiskContestableCount, riskFraming } = comparison;
  if (
    !riskFraming ||
    !highRiskContestableCount ||
    baseline.highRiskScheduled === undefined ||
    optimized.highRiskScheduled === undefined
  ) {
    return [];
  }
  const fewer = optimized.highRiskScheduled < baseline.highRiskScheduled;
  const optimizedRatePct = pct(optimized.highRiskScheduled, highRiskContestableCount);
  const optimizedOverallPct = pct(optimized.contestableScheduled, comparison.contestableTaskCount);

  return [
    {
      key: 'riskReduction',
      label: 'Flagged high-risk backlog scheduled',
      baseline: `${fmt(baseline.highRiskScheduled)} / ${fmt(highRiskContestableCount)}`,
      optimized: `${fmt(optimized.highRiskScheduled)} / ${fmt(highRiskContestableCount)}`,
      verdict: fewer ? 'optimizer-fewer-by-design' : 'optimizer-better',
      note: fewer
        ? `The baseline has no concept of risk at all, so its full coverage here is a side effect ` +
          `of over-scheduling, not prioritisation. The telling number is the RATE: the optimizer ` +
          `covers ${optimizedRatePct}% of the flagged high-risk backlog while scheduling only ` +
          `${optimizedOverallPct}% of the contestable backlog overall - it schedules flagged ` +
          `tasks preferentially, not merely as a side effect of doing more work.`
        : `The optimizer schedules more of the flagged high-risk backlog than the baseline.`,
      emphasis: 'supporting',
      caveatBox: {
        label: 'What "flagged high-risk" is built on',
        note: riskFraming,
      },
    },
  ];
}

/** Rows the screen leads with. Ordering is defined by `buildMetricRows`. */
export function headlineRows(rows: MetricRow[]): MetricRow[] {
  return rows.filter((row) => row.emphasis === 'headline');
}

export function supportingRows(rows: MetricRow[]): MetricRow[] {
  return rows.filter((row) => row.emphasis === 'supporting');
}

export interface RateComparisonRow {
  key: string;
  label: string;
  baselinePct: number;
  optimizedPct: number;
}

/**
 * The subset of Tier 3 that is genuinely a rate against a shared denominator -
 * what the Comparison page's dumbbell chart plots, so the pattern across all
 * of them ("the AI is at or ahead on every axis that matters") is visible at
 * a glance instead of requiring four separate rows of mental arithmetic.
 *
 * Deliberately NOT every Tier 3 row: `fragmentation` ("Possessions used") is
 * a raw count pair, not a fraction of anything, so there is no percentage to
 * plot without inventing one - it stays a table-only row.
 *
 * `slaCompliance` uses each side's OWN scheduled count as its denominator,
 * not the shared `contestableTaskCount` its table row displays - the same
 * "fairer reading" `slaComplianceRow`'s own note already argues for (it
 * isn't rewarded for over-committing). Charting the fixed-denominator
 * version instead would make the optimizer look WORSE here than the row's
 * own stated verdict - exactly the kind of misleading chart this page exists
 * to refuse to draw.
 *
 * Presence mirrors `buildMetricRows`' own guards exactly, row for row - a
 * row absent from the table (no risk model this run, no high-severity
 * backlog, a pre-T29 schedule missing a field) is absent here too, never a
 * hollow 0%.
 */
export function buildRateComparisonRows(comparison: ComparisonToBaseline): RateComparisonRow[] {
  const {
    baseline,
    optimized,
    contestableTaskCount,
    criticalContestableCount,
    highRiskContestableCount,
    riskFraming,
  } = comparison;

  const rows: RateComparisonRow[] = [
    {
      key: 'scheduled',
      label: 'Contestable tasks scheduled',
      baselinePct: pct(baseline.contestableScheduled, contestableTaskCount),
      optimizedPct: pct(optimized.contestableScheduled, contestableTaskCount),
    },
  ];

  if (baseline.contestableWithinSla !== undefined && optimized.contestableWithinSla !== undefined) {
    rows.push({
      key: 'slaCompliance',
      label: 'Scheduled work delivered on time',
      baselinePct: pct(baseline.contestableWithinSla, baseline.contestableScheduled),
      optimizedPct: pct(optimized.contestableWithinSla, optimized.contestableScheduled),
    });
  }

  if (
    criticalContestableCount &&
    baseline.criticalScheduled !== undefined &&
    optimized.criticalScheduled !== undefined
  ) {
    rows.push({
      key: 'priorityCoverage',
      label: 'High-severity tasks scheduled',
      baselinePct: pct(baseline.criticalScheduled, criticalContestableCount),
      optimizedPct: pct(optimized.criticalScheduled, criticalContestableCount),
    });
  }

  if (
    riskFraming &&
    highRiskContestableCount &&
    baseline.highRiskScheduled !== undefined &&
    optimized.highRiskScheduled !== undefined
  ) {
    rows.push({
      key: 'riskReduction',
      label: 'Flagged high-risk backlog scheduled',
      baselinePct: pct(baseline.highRiskScheduled, highRiskContestableCount),
      optimizedPct: pct(optimized.highRiskScheduled, highRiskContestableCount),
    });
  }

  return rows;
}
