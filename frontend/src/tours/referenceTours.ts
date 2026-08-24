/**
 * Walkthroughs for the five read-only reference pages - Corridors, Assets,
 * Backlog (tasks), Resources, Status & provenance. Grouped in one file
 * because each is genuinely small (a page header plus one table), not
 * because the mechanism requires it - a future page's tour is exactly as
 * free to live in its own file (see `dashboardTour.ts`, `comparisonTour.ts`).
 *
 * Every step's copy is drawn from the page's own `PageHeader` subtitle or
 * module doc comment - the real/synthetic and real-vs-derived distinctions
 * this project's data honesty rests on (PRD Section 5).
 */
import type { TourStep } from '../lib/tour.ts'

export const CORRIDORS_TOUR_ID = 'corridors'
export const CORRIDORS_TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    selector: null,
    title: 'Corridors',
    body:
      'Real corridor sections derived from published route and timetable data — station codes, ' +
      'adjacency and free block windows are not invented. This table defaults to the roughly 30 ' +
      'of 10,149 real sections that carry generated maintenance demand; the rest of the real ' +
      'network exists in the database but is not shown here by default.',
  },
  {
    id: 'demand-badge',
    selector: '[data-tour="corridors-demand-badge"]',
    title: 'Real network, narrow demand',
    body:
      'The count on the left is what carries synthetic maintenance work; the count on the right ' +
      'is the true size of the real network this project ingested. The gap between them is real, ' +
      'not a display limit.',
  },
  {
    id: 'table',
    selector: '[data-tour="corridors-table"]',
    title: 'Utilisation and free minutes',
    body:
      'Trains/day, utilisation and free minutes come from real arrival/departure times in the ' +
      "published timetable, not an estimate. A corridor's band (quiet/moderate/busy/saturated) is " +
      'exactly what makes some corridors structurally unable to fit their maintenance backlog — ' +
      'see the Dashboard\'s Deferred work panel for what that produces.',
  },
]

export const ASSETS_TOUR_ID = 'assets'
export const ASSETS_TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    selector: null,
    title: 'Assets',
    body:
      'Physical assets, each with an FR2.1 criticality score — a weighted average of five ' +
      'factors. Two of those five (trains affected, passenger dependency) are real measurements ' +
      'from the published timetable; the other three are simulated, since this is a synthetic ' +
      'maintenance backlog anchored to real infrastructure (PRD Section 5).',
  },
  {
    id: 'table',
    selector: '[data-tour="assets-table"]',
    title: 'Criticality and data provenance',
    body:
      'The "Trains affected" column is badged Real for a reason — it is observed in the real ' +
      'timetable, not generated. The "Data" column marks the asset record itself as synthetic, so ' +
      'the real/simulated boundary is visible field by field, not just at the top of the page.',
  },
]

export const TASKS_TOUR_ID = 'tasks'
export const TASKS_TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    selector: null,
    title: 'Maintenance backlog',
    body:
      'Every pending defect and maintenance task awaiting a block allocation — the raw demand ' +
      'the Controller Dashboard\'s solver run works from.',
  },
  {
    id: 'department-filter',
    selector: '[data-tour="tasks-department-filter"]',
    title: 'Filter by department',
    body:
      'Engineering, S&T and TRD each see only their own backlog here — the same three ' +
      'departments the optimizer coordinates across on the Dashboard.',
  },
  {
    id: 'table',
    selector: '[data-tour="tasks-table"]',
    title: 'Priority is empty until a plan runs',
    body:
      'A blank "Priority" cell means unscored, deliberately never shown as zero — zero would read ' +
      'as "lowest priority", which is not the same claim as "not yet computed". Generate a ' +
      'schedule on the Dashboard to populate it for every task at once.',
  },
]

export const RESOURCES_TOUR_ID = 'resources'
export const RESOURCES_TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    selector: null,
    title: 'Resources',
    body:
      'Crews, machines and permissions — the shared assets that make resource conflict (PRD 9.8) ' +
      'a real constraint rather than a formality.',
  },
  {
    id: 'table',
    selector: '[data-tour="resources-table"]',
    title: 'Corridor scope',
    body:
      'Each resource is scoped to a depot covering SEVERAL corridors, not one. That is what lets ' +
      'two tasks on physically different corridors genuinely contend for the same crew or ' +
      'machine — the optimizer enforces this as a hard constraint (T25), never assumed away.',
  },
]

export const STATUS_TOUR_ID = 'status'
export const STATUS_TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    selector: null,
    title: 'System status & data provenance',
    body:
      "Two things on one page: whether the three-service architecture is actually wired up right " +
      "now, and where every collection's data really came from.",
  },
  {
    id: 'service-panel',
    // Source: ServiceStatusPanel's own doc comment.
    selector: '[data-tour="status-service-panel"]',
    title: 'Live service wiring',
    body:
      'Probes MongoDB and the Python optimizer for real, right now — so a broken link between ' +
      'React, Express and the two backing services is visible here instead of surfacing later as ' +
      'an unexplained failure mid-demo.',
  },
  {
    id: 'provenance',
    // Source: the page's own provenance section copy.
    selector: '[data-tour="status-provenance"]',
    title: 'Data provenance',
    body:
      "Written by the data pipeline at seed time, not by this page. The real/simulated boundary " +
      "runs through individual RECORDS - an asset's train count is measured while its degradation " +
      'history is simulated - so the split is recorded field by field, matching what the ' +
      'Corridors and Assets pages show inline.',
  },
]
