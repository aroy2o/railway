/**
 * DRM oversight walkthrough - PRD Section 14, `DrmOversightPage.tsx`.
 *
 * Each category step's copy is `DrmOversightPage.tsx`'s own `CATEGORY_NOTE`
 * text verbatim, plus the one honesty point T28 built this page around:
 * some of PRD's 16 named KPIs are real, some are relabelled from PRD's own
 * wording to what this prototype can actually back, and some are marked
 * unavailable with the specific reason - never a plausible invented number.
 */
import type { TourStep } from '../lib/tour.ts'

export const OVERSIGHT_TOUR_ID = 'oversight'

export const OVERSIGHT_TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    selector: null,
    title: 'DRM oversight',
    body:
      "All 16 KPIs PRD Section 14 names, grouped by category. Every card is one of three honest " +
      'states: a real number computed from this plan, a number relabelled from PRD\'s own wording ' +
      'to what this prototype can actually claim (dashed cards say "not tracked" and name why), ' +
      'or a genuine "not built" gap. None are invented to fill out the grid.',
  },
  {
    id: 'operations',
    selector: '[data-tour="oversight-category-Operations"]',
    title: 'Operations',
    body: 'Train-network impact of this plan and how much corridor time it actually used.',
  },
  {
    id: 'maintenance',
    selector: '[data-tour="oversight-category-Maintenance"]',
    title: 'Maintenance',
    body:
      'The real maintenance backlog this plan is working through. Cards here say "scheduled", ' +
      'not "completed" — this prototype has no execution-tracking layer, so nothing is ever ' +
      'marked as actually done.',
  },
  {
    id: 'planning',
    selector: '[data-tour="oversight-category-Planning"]',
    title: 'Planning',
    body:
      'How the plan itself was built, and how much it moves between re-solves. Conflict count is ' +
      'a real, checked figure — "0" here means checked and clear on every solve, not "nothing ' +
      'looked". Schedule stability compares two plans on the SAME horizon only, since a weekly ' +
      "and a monthly plan's placements are not on comparable terms.",
  },
  {
    id: 'asset',
    selector: '[data-tour="oversight-category-Asset"]',
    title: 'Asset',
    body:
      'What still needs attention once this plan is committed. Availability % and downtime are ' +
      'marked unavailable outright — this prototype has no runtime asset-state model, only a ' +
      'criticality score and a simulated degradation history, so there is no honest live status ' +
      'to report.',
  },
]
