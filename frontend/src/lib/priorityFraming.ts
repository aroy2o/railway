/**
 * Shared display strings for FR2.3/FR2.4 priority factors and PRD 9.1's
 * risk-model honesty framing.
 *
 * Pulled out of `PriorityQueue.tsx` (TX5, audit session 2026-08-25) once
 * `BlockDetailPanel.tsx` needed the identical labels and the identical
 * disclaimer. This project's own anti-drift rule (D-046, D-057: "a second
 * implementation in a second place is a second thing to drift") applies just
 * as much to a label map as to solver logic - two components independently
 * deciding what `failure_risk` is called would eventually say two different
 * things.
 */

/** Human labels for FR2.3/FR2.4's dominant-factor names. */
export const FACTOR_LABEL: Record<string, string> = {
  severity: 'severity',
  asset_criticality: 'asset criticality',
  failure_risk: 'predicted risk',
  sla_urgency: 'SLA urgency',
  sla_breach: 'overdue',
}

/**
 * PRD 9.1 / NG4, shown wherever the FR2.2 score is.
 *
 * Not optional decoration: the score is a model output over SIMULATED
 * degradation data, and PRD Section 6 lists presenting it as a real failure
 * forecast as an explicit non-goal. A test asserts this string renders
 * wherever a risk figure does.
 */
export const RISK_FRAMING =
  'Predicted risk is a prototype model trained on simulated asset degradation patterns, ' +
  'designed to be retrained on real railway asset-health data when available. It does not ' +
  'predict real Indian Railways asset failures.'
