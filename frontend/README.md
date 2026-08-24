# `/frontend` — React dashboard

React 19 + TypeScript on Vite, styled with Tailwind CSS v4, state managed with
Redux Toolkit. This is where the demo lives: the Controller Dashboard and the
Baseline-vs-AI comparison screen are the two views judges actually see
(PRD Section 8).

## Run

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # tsc -b && vite build
npm run lint
npm run preview   # serve the production build
```

`VITE_*` variables are read from the **repo-root** `.env` via `envDir` in
`vite.config.ts` — there is no separate `.env` in this folder
(`docs/DECISIONS.md` D-002). They are inlined at build time, so nothing secret
belongs in them.

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Base URL of the Express API |
| `VITE_PROTOTYPE_BANNER` | Wording of the PRD Section 5 disclaimer |

## Layout

```
src/
  api/
    apiSlice.ts     RTK Query — the single HTTP client for the backend
  store/
    store.ts        configureStore; server vs client state split
    hooks.ts        typed useAppDispatch / useAppSelector
    slices/
      authSlice.ts  session + role (FR10.1)
  components/       presentational + composed UI
  pages/            route-level screens (task T11)
  hooks/            shared custom hooks
  config.ts         typed access to VITE_* variables
  App.tsx           application shell
```

## State management

State is split on a deliberate line (`docs/DECISIONS.md` D-003):

- **Server state** — health, tasks, corridors, schedules, comparison output —
  belongs to the RTK Query `api` slice. Every backend call is declared as an
  endpoint there. **No component calls `fetch` directly.**
- **Client state** — auth session, policy-slider positions, current selection,
  what-if panel state — belongs in a slice under `src/store/slices/`.

Do not copy server data into a hand-written slice; derive it from the RTK Query
cache instead, or the two will drift.

Components use `useAppSelector` / `useAppDispatch` from `src/store/hooks.ts`
rather than the raw react-redux hooks, so state is fully typed at every call
site.

## Styling

Tailwind v4 via the `@tailwindcss/vite` plugin — configuration is
`@import "tailwindcss"` in `src/index.css`, with no `tailwind.config.js`.

Two conventions worth keeping as the dashboard grows:

- **Colour is never the only signal.** Status is shown with a coloured pill
  *and* a text label — the demo runs on a projector, and department colour-
  coding on the Gantt has to stay readable to a colour-blind viewer.
- **No fabricated numbers in the UI.** Every metric rendered must come from a
  real API response. Any placeholder gets a `PLACEHOLDER` comment so it cannot
  reach the pitch deck by accident.

## Routes

Routing uses `react-router-dom`. All five views are reachable from the header
nav; `/` redirects to `/corridors`.

| Route | Shows |
|---|---|
| `/dashboard` | **Controller Dashboard** (default) — KPI strip, corridor possession timeline, priority queue, deferred work, known limitations, and the Generate schedule trigger |
| `/corridors` | The ~30 real sections carrying maintenance demand — traffic, utilisation, free minutes, block windows, task count |
| `/corridors/:id` | One section: real infrastructure and occupancy, its free block windows, and the assets, backlog and resources on it |
| `/assets` | Assets ranked by FR2.1 criticality score, with the dominant factor |
| `/tasks` | The maintenance backlog, filterable by department |
| `/resources` | Crews, machines and permissions with their depot corridor scope |
| `/comparison` | **Baseline vs AI** (FR9.3) — what coordination changes, with D-031's framing built into the layout |
| `/audit` | **Approval & audit trail** (FR6.1–FR6.3) — plan version history, the workflow panel, and the merged FR6.2 trail |
| `/status` | Live service wiring **and** the data provenance record |

`/` redirects to `/dashboard`: PRD Section 8 calls it the primary demo screen
(D-039). The read-only views remain in the nav — they answer "where did this
number come from".

No routes still to come — T20 was the last 🟠 differentiator (see below).

## The comparison screen

Reads `comparisonToBaseline` from the persisted plan — it never re-runs a solve.
Both plans came from the same backlog in the same run, which is what makes them
comparable.

**The layout is the honesty mechanism** (D-042). D-031 records how easily this
screen misleads, so its rules are structural rather than small print:

- a scope band states the contestable denominator **before any metric**;
- conflicts and batching are the headline, throughput is a supporting metric,
  never headlined;
- utilisation renders **inside the same card** as the over-subscription count
  that causes it, tagged "reads backwards".

Throughput's verdict is derived from the real numbers, not assumed equal:
`no difference` (`=`) when the two engines schedule the same count — true on
this corpus before T24 — or `fewer, by design` (sky-blue, its own badge) when
the optimizer schedules fewer, which T24 made real: it refuses to place
TSK-00025 without its PRD 9.7 prerequisite, while the baseline's FCFS pass,
with no dependency awareness, schedules it anyway. `fewer, by design` is
deliberately its own tone — not "reads backwards" (amber; that badge means the
bigger number is the trap) and not "improvement" (emerald; that would claim
the smaller number is a win it is not) — because a lower optimizer count here
is neither of those; it is simply correct. See docs/DECISIONS.md D-066.

Ordering, verdicts and the pairing live in `src/lib/comparison.ts` and are unit
tested, so an edit that headlines throughput, or mislabels a lower count as an
improvement, fails a test rather than a dry run.

## The Controller Dashboard

Everything on it comes from one schedule document; nothing is computed in the
browser. `POST /api/schedules/generate` runs the solver and RTK Query
invalidates both `Schedule` and `Task`, because generation also rewrites
priority scores (D-035).

**Corridor possession timeline.** Rows are corridors, the x-axis is one 24-hour
day, bars are allocated blocks. A day selector rather than seven stacked axes —
the week's work is very unevenly spread. It opens on the first day carrying a
cross-department batch, and those blocks are drawn structurally differently:
split into a segment per department, ringed, and labelled (D-040).

**Unbuilt controls are visibly disabled.** The monthly toggle is greyed with a
tooltip naming task T28. Faking a control that does nothing would be presenting
a plan the solver never produced.

## Policy weights (PRD Section 8, 13.1, T23)

`PolicySliders` exposes the five REAL D-023 objective terms, not PRD's four
named ones. Two of PRD's names - "Risk avoidance" and "Train punctuality" -
reference objective terms (`beta`, `lambda`) that D-023 itself defers and do
not exist in the objective yet; labelling a slider after them would claim
control this build does not have. `src/lib/policyWeights.ts` documents this
choice and every bound.

**The caption states D-061's finding, not a guess.** On the real 7-day corpus,
every deferral is structural (D-024) - there is no capacity contest for any
weight to arbitrate, so none of the five sliders changes WHICH tasks get
scheduled. What they demonstrably do change, verified for all five at every
multiplier from 0.1x to 10x, is WHICH DAY a scheduled task lands on and how it
is grouped. The panel says exactly that, next to the Deferred Work panel that
substantiates it, rather than let a Controller assume a slider does something
it does not on this dataset.

**Regenerating** runs `generateSchedule` with only the sliders a Controller
actually moved (`toOverride` in `policyWeights.ts` diffs against the D-023
defaults) - a plan generated with every slider left alone posts an empty
override, so it is indistinguishable from a pre-T23 generation. `Reset to
defaults` reappears only once something has moved.

**Bounds are enforced server-side, not just clamped by the `<input
type="range">`.** A value outside [0.1x, 10x] of a default cannot be reached by
dragging the slider at all - the HTML `min`/`max` already prevent it - but the
request is still validated on arrival (D-061), because the slider is not the
only way to reach the endpoint.

**Deferred work is a full panel, not a footnote.** FR3.3 makes deferred-with-
reason a first-class outcome, and on the real corpus it is the larger half of
the answer — 53 of 89 tasks. The solver's own `detail` text is rendered verbatim;
it already names the remedy.

**Manual override (FR6.2).** Clicking a block on the timeline opens an override
panel: pick a task, pick a different window, give a reason, confirm. Click-driven
rather than drag-and-drop — a drag target on a 24-hour axis is imprecise, and the
Controller needs to choose from windows the timetable actually leaves free.

The window list comes from `/override-targets`, which runs the same validator as
the write path, so nothing offered can be refused. The refusal path is still
fully built, because validity can change between opening the panel and
confirming. Both outcomes render the full six-check re-validation, not a bare
verdict.

**Withheld once the plan is closed (T19).** The timeline stops inviting a click
— `onSelectBlock` is `undefined` — and the legend's "click a block to override"
hint disappears, once the plan's workflow state leaves
`{draft, under_review, approved}`. Offering an action the server would then
refuse reads as the system being broken rather than as the plan being frozen or
discarded, so the affordance and the guard agree by construction:
`OVERRIDABLE_STATES` in `lib/approval.ts` mirrors the server's set exactly, and
is the one thing this module deliberately duplicates rather than re-deriving.

## Approval workflow and audit trail (FR6.1–FR6.3)

`AuditPage` (`/audit`) lists every plan version in the left rail — each
generation is its own document (D-034), so the version list *is* the history
FR6.3 asks for — and shows the selected plan's `WorkflowPanel` and `AuditTrail`
beside it. `ControllerDashboard` shows the same `WorkflowPanel` for the latest
plan, so the state is visible without a second screen.

**The buttons are never a second state machine.** `WorkflowPanel` renders
exactly the `allowedActions` the API returned for this plan and nothing else —
it does not recompute what is legal. A transition table duplicated in the
browser is a transition table that will eventually disagree with the one the
server enforces, and the one that drifts is always the one offering a button
that gets refused.

`reject` requires a reason (same FR6.2 rule the override panel already
enforces); `reject` and `publish` are one click to arm, a second to confirm —
both are terminal, and the recovery path for a mistake is generating a new plan,
not undoing this one.

`describeSignOff` in `lib/approval.ts` is the one function worth reading before
touching this screen: a plan nobody has approved must say so as a *state*
("Not approved yet — no sign-off recorded"), never render a blank panel. A blank
reads as "nothing to show" and lets a Controller mistake an unreviewed plan for
an approved one — the same failure the grounding contract's own workflow fact
exists to prevent on the Ask-the-Planner side. Attribution throughout is by
**role**, never a name: this prototype has no user accounts.

`OverrideHistory` shows every amendment with the solver's original
placement kept alongside it.

The Gantt renders `effectivePlan.blocks` where present — the plan as amended —
while `blocks` stays untouched as what the solver produced (D-043).

**Known limitations** renders `knownGaps` — the constraint the solver does not
enforce (T25) — plus any `generationErrors`. That report has now survived four
hops: dataclass, HTTP, MongoDB, and screen. It also renders `checkedAndClear`
(T22's addition, joined by dependency precedence at T24) — types that ARE
checked, on every solve, and genuinely found clear, under its own "Checked,
and none found" heading so an earned zero is never confused with "nothing
checks this."

## What-if simulation (PRD FR5, 9.4, T20)

`WhatIfPanel` opens from a "What if?" button on each `PriorityQueue` row —
not a new page, since PRD Section 8 places this as a panel on the existing
Controller Dashboard. Deliberately triggered from the priority queue rather
than the Gantt: a deferred task has no block to click, and T20 works
identically for both.

Running it fires a REAL re-solve on the optimizer (several real CP-SAT
solves — the loading state says so rather than looking frozen). The result
renders 2+ real options side by side (FR5.1), each showing its consequence as
a short badge — `summariseConsequence` in `lib/whatif.ts` collapses a
reshuffle into a count, never every affected task's row, because the
optimizer found that ANY perturbation on the real corpus reshuffles a large
and variable number of unrelated tasks (0 to 25 of 35, in testing) — a full
list would bury the one thing the Controller actually asked about. An option
the solver could not prove optimal within its (deliberately short) time
budget is labelled `not proven optimal (FEASIBLE)` rather than shown
identically to one that was.

**"Apply this option" reuses the exact FR6.2 override flow T15 already
built** — the same mutation `OverridePanel` uses, with the same mandatory
reason field. No new write path exists (D-065). Confirmed live: applying an
option whose diff showed 14 reshuffled tasks was correctly REFUSED by that
same re-validation — the window it targets is only free in the hypothetical
fully-re-solved world, not the current one — and a zero-side-effect option
succeeded cleanly.

Nothing about the panel persists anything itself (D-064); it is a thin
presentation over one `POST /:id/whatif` call.

## Traffic-block cost (PRD 9.6, T22)

`DeferredTasksPanel` shows, per deferred task, what forcing it through would
cost: trains displaced, minutes displaced, and clearance margin consumed. The
caveat above the list renders only when at least one costing exists.

The caveat says three things on purpose: displaced counts and minutes are
**measured**, the class split behind the weighting is **apportioned**, and this
system **costs the option without scheduling it**. All three are load-bearing —
the last one is what stops the panel reading as a recommendation.

## Predicted risk (FR2.2, PRD 9.1, T16)

Surfaced inside the existing priority displays, not on a page of its own: a
`risk NN` badge on each queue row that has a score, and the PRD 9.1 disclaimer
as a footer under the queue.

The footer renders **only when a risk figure is on screen**. A disclaimer shown
on a screen with no risk scores is noise, and noise is what teaches people to
skip disclaimers.

In Ask the Planner, `context.modelFramings` is rendered beside the answer
whenever the grounding context carried a risk framing — **regardless of whether
the model repeated it**. The prompt does ask for it; a prompt is not a guarantee
(D-050), and a risk figure shown without its "trained on simulated data" caveat
is precisely the claim PRD Section 6 NG4 forbids.

## Ask the Planner (PRD 9.2, T18)

`lib/askPlanner.ts` + `components/AskThePlanner.tsx`, on the Controller Dashboard
under the timeline. A text box and an answer — not a chat interface; conversation
history would imply the system carries context between questions, which it does
not.

Showing the answer is the easy half. `answerState()` distinguishes three
outcomes, and they must never render alike:

| State | Meaning | Rendered as |
|---|---|---|
| `answered` | Grounded, and the question was answerable | Normal answer + cited records |
| `declined` | The system said it does not hold that data | Normal outcome, with the reason and the task that would supply it |
| `ungrounded` | The optimizer's verifier found a figure with no counterpart in any record | **Warning above the answer**, naming the offending numbers |

`ungrounded` outranks `declined`: a reply that both hedges *and* states an
invented figure is the worst case, because it reads as cautious. A test asserts
that ordering.

The suggested-question chips deliberately include one the system **cannot**
answer ("How many trains will be delayed by this plan?"). The honest refusal is
the behaviour most worth demonstrating, and a Controller should not have to think
of it themselves.

## Typed conflicts (PRD 9.5, T21)

`lib/conflicts.ts` holds **display logic only** — labels, ordering, grouping. It
never re-derives a conflict type or a resolution; both come from the optimizer
(D-046).

`groupConflicts(report, plan)` takes the plan as a **required** argument and
drops anything that does not match, and `planTotal()` has no cross-plan
counterpart. That is not an oversight. On the real corpus the optimized plan
carries 10 conflicts (all `RESOURCE_CONTENTION` — `DEPENDENCY_ORDER_VIOLATION`
moved to `checkedAndClear` at T24) and the baseline carries 9; a combined "19"
would describe no plan that exists, and would let the process being argued
against inflate the count attributed to this system. Same class of trap as
D-031's utilisation figure, handled the same way — the misleading shape is
unavailable rather than merely discouraged. See D-045.

Two surfaces render it:

- **`KnownLimitations`** (dashboard) — the optimized layer. Each type shows its
  count, its resolution strategy, the task that would enforce it (T25), and up
  to three real instances with corridor and date. Below them, a **"Not checked
  for at all"** block lists types PRD 9.5 names that nothing detects (none, on
  the current corpus — both train impact and dependency order have graduated to
  checked), and a **"Checked, and none found"** block lists types that ARE
  checked on every solve and genuinely found clear (train impact since T22,
  dependency order since T24). Neither is a bare zero, because a bare zero
  cannot say which of those two very different claims it is making.
- **`ConflictEvidence`** (comparison screen) — the baseline layer, with a type
  badge and resolution above each table. The count is labelled "on the baseline
  plan" so a screenshot cannot be read as this system's conflicts.

The UI copy says "labelled, not applied" and "classified, not applied" because
that is literally true: T21 changes no plan.


## Tests

```bash
npm test        # vitest, pure logic only
npm run build   # tsc -b && vite build
npm run lint
```

Frontend coverage is deliberately minimal (CLAUDE.md testing priorities).
`src/lib/gantt.ts` holds the timeline's arithmetic and `src/lib/comparison.ts`
holds D-031's framing rules; both are unit-tested. Rendering is verified by
screenshot.

## Showing what is real and what is simulated

`SyntheticBadge` renders from the `synthetic` flag carried on each record, and
`/status` renders the field-level provenance map — both served from MongoDB,
neither written by the UI. This is PRD Section 5's honesty requirement reaching
the screen rather than stopping at a JSON file (`docs/DECISIONS.md` D-015).

The badge distinguishes three cases, which matters because the boundary runs
*through* a record: an asset is `SYNTHETIC`, but its `trainsAffectedCount`
column is badged `REAL` because that number is the train count observed in the
published timetable.

Unscored values render as "unscored", never as 0 — `priorityScore` is null
until the priority engine (T7) exists, and a zero would read as "lowest
priority".

Testing here is manual/visual by design — a hackathon budget is better spent on
solver correctness than on component coverage (`CLAUDE.md` testing priorities).
`npm run build` type-checks the whole app, and `npm run lint` runs ESLint.