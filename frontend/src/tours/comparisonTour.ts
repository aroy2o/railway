/**
 * Baseline vs AI walkthrough - PRD FR9.3, `ComparisonPage.tsx`.
 *
 * Every step's copy is drawn from D-031's own three rules, which this page's
 * layout already enforces structurally (its own module doc comment names
 * them) - the tour explains the SAME three rules, in the same order the page
 * presents them, rather than inventing a different framing.
 */
import type { TourStep } from '../lib/tour.ts'

export const COMPARISON_TOUR_ID = 'comparison'

export const COMPARISON_TOUR_STEPS: TourStep[] = [
  {
    id: 'scope-band',
    // Source: ScopeBand's own heading and body text.
    selector: '[data-tour="comparison-scope-band"]',
    title: 'What this comparison covers',
    body:
      'Stated before any number, on purpose: a chunk of the backlog fits no window on its ' +
      'corridor at all, for EITHER engine — that is a fact about the timetable, not something ' +
      'either process failed at. Every figure below is drawn only from the tasks both engines ' +
      'could actually place, so neither one is credited for work nothing could have scheduled.',
  },
  {
    id: 'headline',
    // Source: the page's own "What coordination actually changes" caption.
    selector: '[data-tour="comparison-headline"]',
    title: 'What coordination actually changes',
    body:
      "The optimizer's real advantage: conflicts and cross-department batching. It does not " +
      'schedule more work than the old process — on this backlog it schedules the same tasks. ' +
      'What changes is whether the resulting plan can actually be executed without two ' +
      'departments turning up for the same corridor at once.',
  },
  {
    id: 'supporting',
    selector: '[data-tour="comparison-supporting"]',
    title: 'Numbers that need their context',
    body:
      'A badge names what a number actually means: "reads backwards" flags a metric where the ' +
      'baseline looks better but is not (like utilisation inflated by over-booking a window past ' +
      'capacity) — its true partner metric is shown in the SAME card, never alone, so a bigger ' +
      'number is never mistaken for a better plan.',
  },
  {
    id: 'conflict-evidence',
    // Source: the page's own ConflictEvidence doc comment.
    selector: '[data-tour="comparison-conflict-evidence"]',
    title: 'The conflicts themselves',
    body:
      'The specific double-bookings and over-subscribed windows the CURRENT departmental process ' +
      'produces on this exact backlog — real corridor, date and department names, not an abstract ' +
      'count. These are the baseline\'s conflicts only; the optimized plan\'s own (usually zero, ' +
      'see the Dashboard) are never added to this number.',
  },
  {
    id: 'caveats',
    // Source: Caveats' own heading and sub-text.
    selector: '[data-tour="comparison-caveats"]',
    title: 'How to read this comparison',
    body:
      'Stored with the comparison by the system that computed it, not written by this page — the ' +
      'exact rules that shaped the layout above, spelled out so they can be checked rather than ' +
      'taken on faith.',
  },
]
