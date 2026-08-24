/**
 * Controller Dashboard walkthrough - PRD Section 8's primary demo screen
 * (D-039), and the only page this session's guided tour covers.
 *
 * Every step's copy is drawn from - or paraphrases as closely as the tour
 * format allows - text this project ALREADY shows next to the element it
 * describes, rather than restating each feature in new, possibly looser
 * words. Sources, per step, are named in the comment above it. Where a step
 * needs new copy (none did - every targeted element already carries its own
 * framing), the rule would be the same honest, non-oversold tone: what the
 * data really is, never "AI-powered magic".
 *
 * Adding a walkthrough for another page is exactly this: a new file here
 * (`comparisonTour.ts`, etc.) plus a `data-tour` attribute on what it should
 * highlight. Nothing in `lib/tour.ts`, `tourSlice.ts` or `TourOverlay.tsx`
 * needs to change to add one - see docs/DECISIONS.md D-072.
 *
 * COVERAGE, audited before writing a single step (same discipline T28 used
 * for the 16 PRD Section 14 KPIs) - originally scoped to this page alone,
 * widened mid-session to every route at the owner's explicit request (the
 * D-072 addendum records why the mechanism did not need to change to do
 * that - "add a step array" was the plan from the start):
 *   Covered: every route - this page, Comparison (`comparisonTour.ts`),
 *     Approvals & audit (`auditTour.ts`), DRM oversight (`oversightTour.ts`),
 *     and the five read-only reference pages (`referenceTours.ts`).
 *   Within the Controller Dashboard specifically, NOT given a dedicated step
 *     (present on the page, but not part of this tour): the baseline-vs-AI
 *     teaser link (it exists to lead to the Comparison page's OWN tour, not
 *     to be explained twice), Ask the Planner, Deferred work,
 *     Workflow/approval panel, Override history. These are real panels a
 *     user will find on their own; the eight named in this task's original
 *     scope plus three orienting steps (welcome, Generate, KPI strip) are
 *     what this tour covers.
 */
import type { TourStep } from '../lib/tour.ts'

export const DASHBOARD_TOUR_ID = 'dashboard'

export const DASHBOARD_TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    selector: null,
    title: 'Welcome to the Controller Dashboard',
    body:
      'This is the primary screen for planning maintenance blocks. Everything on it comes from ' +
      'one schedule document produced by a real constraint solver run — nothing is invented in ' +
      'the browser. This short tour points out what each panel is and, just as importantly, what ' +
      'it is honestly NOT claiming. You can replay it any time from "Replay walkthrough" in the header.',
  },
  {
    id: 'generate',
    // Source: the loading-state copy shown directly beneath this button.
    selector: '[data-tour="dashboard-generate"]',
    title: 'Generate schedule',
    body:
      'Runs the constraint solver (CP-SAT) over the pending maintenance backlog — a real solve, ' +
      'usually a couple of seconds, not a canned demo response. Every screen below updates from ' +
      'whatever plan comes back.',
  },
  {
    id: 'kpi-strip',
    // Source: KpiStrip.tsx's own doc comment - "optimizer-only figures".
    selector: '[data-tour="dashboard-kpis"]',
    title: 'Plan summary',
    body:
      'Tasks scheduled and deferred, blocks used, shared possessions across departments, and ' +
      'block utilisation — all from THIS plan alone. It deliberately does not compare against the ' +
      'old departmental process here; that comparison, and its own caveats, live on the ' +
      'Baseline vs AI page so a half-shown comparison never appears by accident.',
  },
  {
    id: 'gantt',
    // Source: GanttTimeline.tsx's own doc comment and header subtitle.
    selector: '[data-tour="dashboard-gantt"]',
    title: 'Corridor possession timeline',
    body:
      'Rows are corridors, the axis is one day, and each bar is a block the solver placed into a ' +
      'real free window in the timetable — not a guess at when a corridor might be free. A block ' +
      'ringed in violet is a shared possession serving two departments in one closure: the ' +
      'coordination a manual process cannot do on its own. Empty days are shown too, on purpose — ' +
      'a quiet day is a real fact about corridor availability, not something to hide.',
  },
  {
    id: 'horizon-toggle',
    // Source: HorizonToggle's own title tooltip and D-070's framing.
    selector: '[data-tour="dashboard-horizon-toggle"]',
    title: 'Weekly / Monthly',
    body:
      'Both options trigger a genuine re-solve at that horizon — Monthly is not the weekly plan ' +
      'stretched out, it is a real 30-day CP-SAT run, shown at coarser corridor-per-day ' +
      'resolution. Switching horizons costs a few seconds of real solving, the same as Generate.',
  },
  {
    id: 'priority-queue',
    // Source: PriorityQueue.tsx's own header subtitle and RISK_FRAMING.
    selector: '[data-tour="dashboard-priority-queue"]',
    title: 'Priority queue',
    body:
      'The whole backlog, ranked by a real weighted score — severity, asset criticality, ' +
      'predicted risk and SLA pressure — with the dominant factor named per task, not just a ' +
      'number. The violet "risk" badge is a prototype model trained on SIMULATED asset ' +
      'degradation data, designed to be retrained on real asset-health data when available — it ' +
      'does not predict real Indian Railways asset failures. Each row also opens "What if?", ' +
      'covered next.',
  },
  {
    id: 'what-if',
    // Source: WhatIfPanel.tsx's own doc comment.
    selector: '[data-tour="dashboard-whatif-trigger"]',
    title: 'What if?',
    body:
      'Opens a real re-solve for one task — up to a few seconds, exactly as trustworthy as ' +
      'Generate itself, never a simplified estimate. Nothing about the live schedule changes ' +
      'until you explicitly apply an option, which goes through the same reviewed override path ' +
      'as a manual change on the timeline.',
  },
  {
    id: 'policy-sliders',
    // Source: PolicySliders.tsx's own header caption (D-061's finding).
    selector: '[data-tour="dashboard-policy-sliders"]',
    title: 'Policy weights',
    body:
      "These change WHEN work happens and how it's grouped — batching, fragmentation, how " +
      'strictly SLA dates are chased. On this backlog every deferral is structural (see Deferred ' +
      'work further down), so no combination of these sliders changes WHICH tasks get scheduled, ' +
      'only when and how tidily. "Regenerate" runs a real solve with the new weights.',
  },
  {
    id: 'emergency',
    // Source: EmergencyPanel.tsx's own doc comment.
    selector: '[data-tour="dashboard-emergency-trigger"]',
    title: 'Simulate emergency',
    body:
      "For an unplanned disruption — say a signal failure eats one of a corridor's windows. Pick " +
      'the corridor and the window it consumed, and the solver re-optimizes ONLY that corridor\'s ' +
      'remaining time around it, holding every other corridor and everything already executed ' +
      'exactly fixed. Unlike "What if?", this commits — submitting creates a real new schedule, ' +
      'not a disposable hypothetical.',
  },
  {
    id: 'weather-risk',
    // Source: WeatherRiskPanel.tsx's own FRAMING constant.
    selector: '[data-tour="dashboard-weather-risk"]',
    title: 'Seasonal risk',
    body:
      "Real government flood-risk data (Ministry of Jal Shakti, by state) checked against real " +
      "IMD monsoon dates. It's coarse on purpose — state-level, not section-specific, and only " +
      "where a corridor's real station data even carries a state. Advisory only: the solver does " +
      'not avoid or move these blocks on its own; nothing here changes the plan automatically.',
  },
  {
    id: 'known-limitations',
    // Source: KnownLimitations.tsx's own header copy.
    selector: '[data-tour="dashboard-known-limitations"]',
    title: 'Known limitations of this plan',
    body:
      'Reported by the solver itself, so the plan is never presented as more constrained than it ' +
      'actually is. A conflict type shown here is checked on every solve — "0 found" means ' +
      'exactly that, checked and clear, never "nothing looked". Each type also names the strategy ' +
      'that would resolve it, labelled, not silently applied.',
  },
  {
    id: 'closing',
    selector: null,
    title: "That's the Controller Dashboard",
    body:
      'Every other screen — Baseline vs AI, Approvals & audit, DRM oversight, and the read-only ' +
      'reference pages — has its own short walkthrough too, shown automatically the first time ' +
      'you open it. Come back to "Replay walkthrough" in the header any time — it always replays ' +
      'whichever page you are currently looking at.',
  },
]
