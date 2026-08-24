/**
 * Approval & audit trail walkthrough - PRD FR6.1-FR6.3, `AuditPage.tsx`.
 */
import type { TourStep } from '../lib/tour.ts'

export const AUDIT_TOUR_ID = 'audit'

export const AUDIT_TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    selector: null,
    title: 'Approval & audit trail',
    body:
      'Every plan the system has produced, what was changed on it, and who signed it off ' +
      '(PRD FR6.1–FR6.3). Nothing here is a summary written after the fact — each row is a real ' +
      'record appended at the moment something happened.',
  },
  {
    id: 'versions',
    // Source: the page's own "Plan versions" panel copy.
    selector: '[data-tour="audit-versions"]',
    title: 'Plan versions',
    body:
      'Each generation is its own document — nothing is ever overwritten. That is what makes ' +
      "this list FR6.3's version history: it is not a separate log kept alongside the plans, it " +
      'is the plans themselves, in order. Click one to inspect its own workflow state and trail.',
  },
  {
    id: 'workflow',
    // Source: WorkflowPanel's own doc comment.
    selector: '[data-tour="audit-workflow"]',
    title: 'Workflow state',
    body:
      'Draft → under review → approved → published, with reject available from under review — ' +
      'four legal transitions, no others. Every button shown here comes from what the SERVER ' +
      'currently allows for this exact plan, never from a rule guessed in the browser, so a ' +
      'button is never offered only to be refused.',
  },
  {
    id: 'trail',
    // Source: AuditTrail's own header copy.
    selector: '[data-tour="audit-trail"]',
    title: 'Audit trail',
    body:
      'One narrative in time order across three kinds of event: the original generation, every ' +
      'manual override with its stated reason, and every workflow sign-off. Records are ' +
      'appended, never edited — a mistake gets a new corrective entry, not a rewritten one.',
  },
]
