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
  crossDepartmentBatches: number;
  doubleBookings: number;
  doubleBookedMinutes: number;
  overSubscribedWindows: number;
  blockMinutesUsed: number;
  blockUtilisationPct: number;
}

export interface ComparisonToBaseline {
  contestableTaskCount: number;
  structurallyImpossibleCount: number;
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
 */
export type Verdict = 'optimizer-better' | 'no-difference' | 'baseline-higher-but-worse';

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
}

const fmt = (value: number): string => value.toLocaleString();

/**
 * Build the metric rows in the order the screen must present them.
 *
 * Conflicts and batching first - those are the real, defensible differences.
 * Throughput last and explicitly neutral.
 */
export function buildMetricRows(comparison: ComparisonToBaseline): MetricRow[] {
  const { baseline, optimized, contestableTaskCount } = comparison;

  return [
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
    {
      key: 'scheduled',
      label: 'Contestable tasks scheduled',
      baseline: `${fmt(baseline.contestableScheduled)} / ${fmt(contestableTaskCount)}`,
      optimized: `${fmt(optimized.contestableScheduled)} / ${fmt(contestableTaskCount)}`,
      verdict:
        baseline.contestableScheduled === optimized.contestableScheduled
          ? 'no-difference'
          : 'optimizer-better',
      note:
        'No throughput advantage on this dataset — both engines place the same work. The ' +
        'optimizer’s advantage is that its plan is executable, not that it does more.',
      emphasis: 'supporting',
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
