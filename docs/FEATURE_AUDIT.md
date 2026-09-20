# Feature Audit — AI-Assisted Railway Maintenance Block Planning (SIH 26027)

**Purpose of this document.** A full, honest inventory of every feature in this
codebase, for turning into pitch-deck content and a live demo script. No code
was changed to produce it. Every number below is either freshly re-run this
session or cited to a specific `docs/DECISIONS.md` (D-NNN) or `TASKS.md`
(T-NNN) entry — nothing is estimated or remembered from an old session log.

**Audit date:** 2026-09-02. **Status at audit time:** T1–T28 (the full PRD
milestone board) and T29 Phase 1 are `done`. T29 Phase 2 was investigated and
explicitly stopped (0-yield finding, not built). TX1–TX6 are `done`; TX7 is a
documented, deliberately unfixed risk.

---

## 1. System summary

This is a prototype decision-support system for planning railway maintenance
"blocks" — the time windows during which a corridor is closed to trains so
Engineering, Signal & Telecom (S&T), or Traction Distribution (TRD) crews can
do repair work. Today, Indian Railways' three departments request these
windows independently through a manual system (BDMS), with no shared view of
who else wants the same corridor, which defects are actually most urgent, or
how much a given closure will disrupt trains. This system centralizes that
demand into one queue, scores each maintenance task by asset criticality and a
predicted-failure-risk model, and hands the ranked backlog to a real
constraint solver (Google OR-Tools CP-SAT) that produces a single
conflict-free, cross-department, train-impact-aware schedule — instead of
three departments silently colliding on the same track. Every scheduling
decision carries a machine-generated, LLM-explained justification grounded in
the solver's own reasoning; a human Controller reviews, can override with a
logged reason, and formally approves/publishes the plan through an audited
workflow. A real (not mocked) baseline algorithm reproducing today's
uncoordinated process is run side by side with the optimizer, so the system's
value is demonstrated by an actual before/after comparison rather than
asserted. The corridor list, station codes, and train timetable are real,
public Indian Railways data; the maintenance/defect backlog itself is
synthetic (no public dataset exists), generated to be structurally realistic
and clearly labelled as such throughout the UI, per the PRD's own honesty
requirement.

---

## 2. Architecture overview

Four independently-runnable pieces, wired together at demo time by
`docker-compose.yml` (verified via Podman as a Docker-Compose-spec-compliant
substitute — see §6):

```
data pipeline (Python)  →  MongoDB  ←→  backend (Node/Express, TS)  ←→  optimizer (Python/FastAPI)
                                              ↑
                                      frontend (React/Vite, TS)
```

| Service | Role | Why it's separate |
|---|---|---|
| **`/data`** | One-shot ingestion + synthetic generation. Fetches `datameet/railways` (stations, routes) and the data.gov.in/Kaggle timetable, derives corridor sections and an occupancy calendar, then generates the synthetic maintenance backlog anchored to real corridors. Writes deterministic JSON to `data/processed/`. | Runs offline, not part of the request path; its outputs are files the backend seeds from, not a live dependency (D-008, D-009). |
| **`/optimizer`** | Python + FastAPI. Owns the CP-SAT scheduler, the priority/risk models, the naive baseline, conflict/train-impact/weather detection, and the LLM explanation layer. Never touches MongoDB directly — it is a pure function of the JSON payload it is sent (D-032). | Google OR-Tools (CP-SAT) and the survival-style risk model need purpose-built Python libraries with no JavaScript equivalent — a standard microservice split, not a stack inconsistency (PRD §10.3). |
| **`/backend`** | Node.js + Express, **TypeScript** (migrated from JS mid-project — D-041). Auth (JWT), CRUD, MongoDB persistence, and orchestration: gathers state from Mongo, calls the optimizer over internal REST, stores the result. | Keeps the database and the solver decoupled — a Mongoose schema change can't silently break the optimizer's contract, and vice versa (D-032). Node never calls OR-Tools directly (per `CLAUDE.md`'s stack rule). |
| **`/frontend`** | React + Vite + TypeScript, Redux Toolkit/RTK Query for all server state (D-003). Seven role-scoped screens plus five read-only reference pages. | — |

**Why MongoDB, not Postgres.** The domain is genuinely relational, but the
PRD explicitly green-lights Mongo for a hackathon timeline (PRD §10.2); no
project decision revisits this.

**Communication.** Backend → optimizer is plain internal REST/JSON
(`POST /optimize`, `/baseline`, `/prioritize`, `/whatif`, `/explain`, `/risk`),
never MongoDB documents passed through — the optimizer's request/response
contract is a deliberately narrow, `extra="forbid"`-validated shape decoupled
from the Mongoose schema (D-032). A failed optimizer call surfaces to the
Controller as an actionable message ("Could not reach the optimizer service"),
never a bare 500 (D-004, D-037).

---

## 3. Feature inventory

### 3.1 Real corridor & timetable data ingestion (T2, T3)
- **What it does.** Loads real Indian Railways station codes, zones, and
  corridor sections, plus a per-corridor daily occupancy/free-window
  calendar, from public data.
- **Why it exists.** PRD §5.1 — the system must anchor to real infrastructure
  and timetable data rather than inventing stations or corridors; PRD NG1/NG2
  state real-time integration is out of scope, but the *static* real data is
  required.
- **How it works.** `datameet/railways` stop records are grouped by train,
  ordered by row `id`, and split into consecutive-station pairs wherever the
  `id` sequence gaps — deliberately biased to omit a real section rather than
  fabricate one (D-006). The data.gov.in/Kaggle ISL timetable corroborates
  sections and supplies real published distances but never defines sections
  itself, because its stop list is halts-only and would invent multi-hundred-km
  "corridors" if used directly (D-007). Occupancy is the real
  departure→arrival transit window per train, projected onto one
  representative 24-hour day (no day-of-week field exists in the source),
  with a 5-minute clearance margin and a 30-minute minimum free-window floor
  (D-010); midnight-crossing durations use clock-wrap, not the source's `day`
  field, because day-delta arithmetic produces physically impossible negative
  or >24h durations on 504 real records (D-011).
- **What real data backs it.** 417,080 real stop records → **8,990 stations**,
  **10,149 corridor sections**; 376,385 of 411,680 real stop pairs used to
  build occupied/free windows over **8,454 of 10,149 sections** (T3).
  Validated: median section length 6.6 km, median published/straight-line
  distance ratio 1.034 (physically correct track-curvature signature, not a
  parsing artefact).
- **Known limitations.** 66 sections have zero usable free window at all
  (genuinely saturated real corridors — Ghaziabad–Sahibabad, 281 trains/day,
  one 54-minute window). Only 3,295 of 10,149 sections are corroborated by
  the second source — expected, not a data-quality problem (D-007). Every
  train is treated as running daily (no weekly-pattern data exists), which
  deliberately *understates* free time rather than overstates it (D-010).

### 3.2 Synthetic maintenance/asset data generator (T4)
- **What it does.** Generates the maintenance backlog (assets, defects,
  resources, dependencies) that does not exist in any public dataset, anchored
  to the real corridors from 3.1.
- **Why it exists.** PRD §5.2 — TMS/SMMS/TDMS-equivalent data is internal to
  Indian Railways and inaccessible; the PRD requires it be generated to
  realistic, non-uniform distributions rather than invented flat.
- **How it works.** 30 real corridors are selected by stratifying on
  utilisation band *and* traffic percentile (not just picking the busiest per
  band, which the first attempt did and which compressed the criticality
  range — D-013). Each corridor gets 1–3 assets; each asset 0–3 tasks.
  Department mix is an exact largest-remainder quota (Engineering/S&T/TRD
  50/30/20 per PRD, realised 52.8/27.0/20.2), not independent sampling, which
  the first attempt tried and missed the target mix by 12 points (D-014).
  Severity is Beta(2, 3.5) — chosen by comparing four parameter sets against
  the PRD's "skewed, not uniform" requirement (D-014). Every synthetic record
  carries `"synthetic": true` plus a field-level real/synthetic/
  computed-downstream provenance map, not just a file-level flag, because a
  single record genuinely mixes real (`trainsAffectedCount`,
  `passengerDependency`) and synthetic (`safetyImportance`,
  `historicalFailureFreq`) fields (D-015).
- **What real data backs it.** 30 real corridors, **55 assets, 89 tasks, 102
  resources**. `trainsAffectedCount` and `passengerDependency` are real
  measurements (from T3's timetable), not synthesised — a test asserts every
  asset's train count matches the observed one.
- **Known limitations.** This is the one layer the PRD itself calls
  synthetic; the `SyntheticBadge` and the PRD §5 prototype banner surface
  this everywhere the data is shown. The severity distribution's parameters
  were partly chosen so the critical tier is populated enough to exercise
  prioritisation — stated explicitly as a modelling goal, not claimed as a
  measured Indian Railways figure (D-014).

### 3.3 Asset criticality + priority engine (T7, FR2.1/FR2.3/FR2.4)
- **What it does.** Scores every asset's consequence-of-failure (0–100) and
  every task's overall priority (0–100), with a visible per-factor breakdown
  and a named dominant factor.
- **Why it exists.** PRD FR2.1/FR2.3/FR2.4 — tasks must be ranked by more
  than a manually-entered severity number.
- **How it works.** Asset criticality is a weighted average (safety
  importance 0.30, real trains-affected 0.25, no-alternate-route 0.20, real
  passenger dependency 0.15, historical failure frequency 0.10 — weighted so
  *consequence* outranks *likelihood*, D-012). Priority is an additive
  weighted sum (severity 0.35, asset criticality 0.30, SLA urgency 0.20, SLA
  breach 0.15) — additive rather than multiplicative specifically so FR2.4's
  "which factor dominated" has an honest, decomposable answer (D-026).
- **What real data backs it.** Weights were measured, not asserted: against
  four alternative formulas on the real 89-task corpus, the chosen weights
  cut tied pairs from 1,057 (severity-only) to 11 while preserving ρ=+0.706
  correlation with severity (D-026).
- **Known limitations.** `sla_breach` is capped so it can never become the
  dominant factor by design (D-027) — a deliberate, stated property, not a
  bug. Swapping this whole engine for the earlier severity placeholder left
  the *scheduled set* unchanged (D-028) — priority reorders the queue, it did
  not, on this corpus, change which 36 tasks got scheduled, because every
  deferral here is structural (see 3.6).

### 3.4 Predictive asset-risk model (T16, FR2.2/PRD §9.1)
- **What it does.** Estimates each asset's "time to intervention threshold"
  from its simulated degradation history, feeding into the priority score.
- **Why it exists.** PRD §9.1 — but with an explicit honesty correction: the
  model must never claim to predict *real* railway failures.
- **How it works.** Linear-trend (OLS) extrapolation to a fixed 0.30 health
  threshold, chosen specifically because it *matches* T4's generative process
  (constant decline + noise) rather than approximates it — a classifier was
  deliberately rejected because there are no real failure labels to train on,
  and any accuracy figure from labels derived from the same series would be
  circular (D-055). Weighted 0.20 in the priority score, capped below asset
  criticality's 0.25 on purpose: criticality is anchored in real train
  counts, risk comes from simulated data, and a synthetic input must not
  outweigh a measured one (D-055).
- **What real data backs it.** None directly — this is explicitly a
  simulated-data model. The disclaimer ("prototype predictive risk model
  trained on simulated asset degradation patterns... designed to be
  retrained on real historical asset-health data") is stored on the asset,
  the schedule, returned by `/risk`, rendered under the priority queue, and
  returned by `/explain`'s `context.modelFramings` — independently of
  whether the LLM repeats it (D-055).
- **Known limitations.** Fewer than 3 observations → `null` with a reason,
  never a guessed default. On this synthetic corpus, current health and
  decline rate correlate +0.867 (the generator starts every asset in a
  narrow band), so the risk score is closer to "inverted current health"
  than it would be on real data with varied asset ages — stated explicitly
  as a limitation of the *synthetic data*, not the model (D-055). Adding this
  model did not change the scheduled set either (same 36/53 split) — same
  structural-impossibility reason as 3.3.

### 3.5 CP-SAT optimization engine — core (T6, FR3.1)
- **What it does.** Solves for a conflict-free assignment of tasks to
  corridor time windows, maximizing priority-weighted coverage while
  minimizing waste and fragmentation.
- **Why it exists.** PRD FR3.1 — the central optimizer.
- **How it works.** Google OR-Tools CP-SAT, decision variable
  `assign[task][window]` per PRD §13's conceptual spec. Objective weights
  encode a strict priority order, not a tuning: covering even the
  lowest-priority task (10,000/unit) always outweighs the largest possible
  waste penalty (~1,940 for a fully-wasted window), so coverage can never be
  traded for tidiness on this corpus — verified by hand-computing the
  hand-built test scenario's objective and matching the solver's output
  exactly (D-023). Runs single-worker with a fixed seed specifically because
  multi-worker CP-SAT was measured to return *different* optimal plans for
  identical input — a plan that changes when nothing changed cannot be
  demoed or diffed against a baseline (D-022).
- **What real data backs it.** Real 89-task corpus: **OPTIMAL in 0.65s**
  pre-splitting (T6); with T29 splitting enabled, **FEASIBLE (~2% gap) in
  ~10s** at the 10s budget (see 3.16).
- **Known limitations.** Weekly-horizon-only pre-splitting, **53 of 89 tasks
  structurally cannot fit any single window their corridor offers** — this
  was checked for artefact (removing the clearance margin/floor rescues
  exactly 1 task) before being reported as a real finding (D-024). This
  "structural vs. contested" distinction (`EXCEEDS_LONGEST_WINDOW` vs.
  `NO_CAPACITY`) is load-bearing for every honest comparison this project
  makes — it is why the baseline-vs-AI screen must never lead with a raw
  task count (3.7).

### 3.6 Hard constraints layered onto the solver: dependency (T24) and resource (T25)
- **What it does.** Enforces that a task never starts before its prerequisite
  completes, and that two tasks needing the same crew/machine/permission
  never overlap.
- **Why it exists.** PRD §9.7 (task dependency) and §9.8 (resource
  constraints) — 🟡 stretch items, built after all 🔴/🟠 tiers.
- **How it works.** Dependency: a pre-solve fixed-point pass defers a task
  whose prerequisite is itself structurally unschedulable (cascading through
  multi-stage chains), plus a hard CP-SAT constraint matching the exact
  "completes before starts" semantics T6's own conflict detector already
  used (D-066). Resource: a pairwise `assign[a]+assign[b]≤1` for every
  same-day overlapping window pair sharing a resource, matched to the same
  detector T21 uses so the hard constraint and the post-solve check can
  never disagree (D-067).
- **What real data backs it.** Both were audited against the real corpus
  *before* being enforced: the corpus was already violating dependency
  order 5 times (two tasks scheduled in the literal same window on the same
  day); resource sharing had 10 real conflicts, 3 attributable entirely to a
  single per-depot permission every same-department task shares by
  construction (checked and found not to cause an unrealistic depot-wide
  bottleneck — D-067).
- **Known limitations.** Enforcing dependency order **cost one scheduled
  task** (36→35) — a real, traced coverage cost, not a regression to
  minimize (D-066). Enforcing resource no-overlap cost **zero** coverage,
  only repacking (D-067) — the two constraints differ in kind, which is
  itself evidence for the "structural, not contested" thesis (D-024/D-028).
  Both constraints, once real, made a prior "identical throughput" framing
  in the comparison screen literally false — fixed with a dynamic
  `optimizer-fewer-by-design` verdict rather than a stale claim (D-066).

### 3.7 Naive baseline algorithm (T8, FR9.1)
- **What it does.** A real, actually-executed simulation of today's
  uncoordinated process: each department schedules its own tasks
  independently, first-come-first-served, with zero visibility into the
  other departments' requests.
- **Why it exists.** PRD FR9.1 / §12 — the comparison must be against a real
  computed baseline, not a mocked "before" number.
- **How it works.** Each department runs its own clean FCFS pass by
  `date_raised` ascending (deliberately not `slaDueDate`, which would make
  the "naive" baseline secretly smart — a test explicitly guards against
  this creeping back in, D-029). Departments are blind to *each other*, not
  to themselves (no real planner double-books their own crew) — a
  deliberate asymmetry so the resulting conflicts are a property of the
  *process* being critiqued, not of sloppy code (D-030).
- **What real data backs it.** Real 89-task corpus, contestable subset (36):
  36/36 scheduled, **6 double-bookings, 605 double-booked minutes, 3
  over-subscribed windows, 0 cross-department batches** (T8). Reused (not
  duplicated) against dependency and resource constraints: found the
  baseline commits a real dependency violation and **27** real resource
  conflicts in its own output (D-066/D-067).
- **Known limitations.** The baseline's *utilisation figure is higher* than
  the optimizer's — stated as the defect, not an advantage, because it
  over-subscribes 3 windows to get there (D-031). The optimizer schedules no
  more contestable tasks than the baseline at any tested horizon — the
  honest claim is coordination and feasibility, never volume.

### 3.8 Task splitting across non-contiguous windows (T29 Phase 1, new scope beyond the PRD board)
- **What it does.** Lets certain defect types be worked across 2+
  non-contiguous sessions instead of requiring one continuous block.
- **Why it exists.** Not a PRD-numbered requirement — added because 53 of 89
  real tasks were structurally impossible for *either* engine (3.5), and the
  hypothesis (later confirmed) was that some don't actually need one
  continuous window.
- **How it works.** Splittability is keyed on `defectType`, a **documented
  judgement call flagged explicitly, not a PRD fact**: 6 of 12 real defect
  types are splittable (e.g. track geometry defect, ballast deficiency,
  cable fault) and 6 are not (e.g. rail fracture — cannot be left mid-cut; a
  relay fault — cannot be left mid-swap). Minimum segment floor 30 minutes,
  reused from T3's own free-window floor rather than invented (D-082).
- **What real data backs it.** Of the 53 previously-impossible tasks, **29
  are now placed**. `tasksScheduled` 35→**64**, `tasksDeferred` 54→**25**,
  `tasksSplit`: **29**, `crossDepartmentBatches` 2→**5**. GZB-SBB — this
  project's cited worst-case corridor (281 trains/day, one 54-minute window)
  — gets real coverage for the first time via a 185-minute task split across
  4 days of that window (D-082).
- **Known limitations.** The solve **no longer proves OPTIMAL within the
  10s budget** — settles for a reproducible FEASIBLE result with ~2% gap to
  the solver's own proven bound (D-082). Two previously-*exact* safety
  guarantees (D-028's priority-swap invariance, D-061's slider-safety bound)
  now hold only within a small, explicitly-tolerated (1–3 task) margin
  rather than as a mathematical certainty (D-082). **The frontend does not
  yet visually distinguish a split block** from a normal one — met at the
  data layer only, explicitly flagged as future work (D-082). Phase 2
  (caution-order-eligible work) was investigated and found to yield **zero**
  eligible tasks on the real corpus, and was deliberately not built (D-085,
  see §4). Phase 3 was never started, since its premise (a smaller residual
  pool) doesn't hold.

### 3.9 Baseline vs. AI comparison screen (T14, FR9.3, PRD §12)
- **What it does.** Shows the real, computed baseline-vs-optimizer metrics
  side by side — the project's designated strongest judging screen.
- **Why it exists.** PRD FR9.3/§12 — implemented for real, never a mockup.
- **How it works.** D-031's three framing rules are enforced by page
  *structure*, not a disclaimer: a scope band renders the 36/32/21
  contestable/split-only/impossible breakdown before any metric; ordering
  logic (`buildMetricRows` in `lib/comparison.ts`) makes conflicts and
  batching headline rows and tags equal throughput `no-difference`
  structurally, so a future edit cannot silently promote a misleading
  headline without failing a test; utilisation's over-subscription figure is
  carried *inside* the same card as a `pairedWith` field, not a sibling row
  that could be separated (D-042). A real conflict table (which two
  departments, which corridor, which minutes) is shown, not just a count
  (D-042).
- **What real data backs it.** Same real corpus as 3.7/3.8. Current live
  figures: contestable 36 (baseline 36, optimizer 35 — the honest cost of
  enforcing dependency order, 3.6), split-only 32 (baseline 0, optimizer
  29), impossible 21, 0 double-bookings/3 conflicts vs. baseline's 6+3, 5
  vs. 0 cross-department batches.
- **Known limitations.** Deliberately reports **no single "% improvement"
  figure** anywhere — the codebase does not compute one, specifically to
  avoid a misleading green badge on numbers (like utilisation) that don't
  support that framing (PITCH_NUMBERS.md's own closing note).

### 3.10 Gantt / corridor timeline dashboard (T12, T13, PRD §8.3)
- **What it does.** The primary demo screen: corridor rows on a 24-hour axis,
  department-colour-coded, with a KPI strip, priority queue sidebar, and the
  "Generate schedule" trigger.
- **Why it exists.** PRD §8 names this the primary demo screen; build order
  puts it first.
- **How it works.** Cross-department batches are drawn **structurally
  differently**, not just tinted — split into a proportional per-department
  segment with a violet ring and an explicit "shared block" label, so the
  headline capability reads without decoding a legend (D-040). The timeline
  opens on **today** if today falls inside the plan's horizon, else falls
  back to the first day carrying a batch (D-075, fixing an earlier
  always-first-batch-day default that misread as "today" — D-040/D-075).
  The Monthly toggle triggers a **real re-solve** at a 30-day horizon
  (never a client-side view stretch of the weekly plan — D-040/D-070).
- **What real data backs it.** Real solved plans on the seeded 89-task
  corpus, generated live via `POST /api/schedules/generate`.
- **Known limitations.** `GanttTimeline` has no plan-id `key`, so its
  selected-day state can go stale if a new plan loads into an already-mounted
  component without a full remount — a known, unfixed, low-severity risk
  (D-075). Split blocks are not yet visually distinguished (3.8).

### 3.11 Manual override + constraint re-validation (T15, FR6.2/FR3)
- **What it does.** Lets a Controller move or defer a task, with a mandatory
  reason, and automatically re-validates the whole plan against six named
  constraint checks.
- **Why it exists.** PRD FR6.2 — every override must be logged and
  re-validated; the system must never silently allow an invalid published
  plan.
- **How it works.** Overrides are an append-only `schedule_overrides` log;
  **the schedule document itself is never mutated**, so the decision log
  (which explains the *solver's* reasoning) never contradicts the current
  plan — the Controller-facing plan is `effectivePlan` = solver blocks +
  every override replayed in order (D-043). Capacity is checked against the
  *effective* plan, never the solver's original blocks — the adversarial
  test for this was mutation-checked (injecting the exact bug it guards
  against makes it fail, D-044). Cross-corridor moves are refused outright:
  the defect is on that corridor's asset, and moving the paperwork doesn't
  move the cracked rail (D-043).
- **What real data backs it.** Verified live: an accepted move (6 checks
  green) and a genuinely staged race where `duration-fits-window` passes but
  `window-capacity` fails — a single "does it fit" check would have wrongly
  accepted it (D-044).
- **Known limitations. TX7 — a documented, unfixed concurrency risk:** two
  overrides on the same task fired milliseconds apart both return `201`
  with all checks passing; only the later one survives in the effective
  plan, and the earlier caller is never told theirs silently didn't stick.
  No data corruption results, but it is a real gap against FR6.2's "every
  override is logged" promise (a Risk, not a Bug — `overrideEngine.ts` still
  has no optimistic-concurrency check as of this audit, confirmed by
  inspection).

### 3.12 Typed conflict detection & classification (T21, FR4, PRD §9.5)
- **What it does.** Names and classifies conflicts into corridor
  double-booking, window over-subscription, resource contention, and
  dependency-order violation, each with a stated resolution strategy.
- **Why it exists.** PRD §9.5 — naming conflict types is more convincing to
  judges than a black-box "optimized" label.
- **How it works.** Computed once in the optimizer (Python), stored
  verbatim, never recomputed per consumer — so no layer can classify the
  same conflict two different ways (D-046). Resolutions are **classified,
  not applied**: nothing in this feature changes a plan; the actual
  enforcement is 3.6's hard constraints (D-046). `TRAIN_IMPACT_CONFLICT`
  graduated cleanly from "not yet detectable" into "checked and clear" once
  T22 shipped — never reported as a bare zero before the check existed
  (D-056).
- **What real data backs it.** On the current (post-T24/T25/T29) real
  corpus: dependency and resource conflicts are **hard-enforced, checked,
  and zero** on the optimized plan; the baseline carries 6 corridor
  double-bookings + 3 over-subscriptions (its own, uncorrected, real
  output).
- **Known limitations.** Conflict counts are **never totalled across plans**
  — an optimized-plan count and a baseline count mean structurally different
  things (a gap this system hasn't closed yet, vs. the evidence the baseline
  fails), and summing them would let the thing being argued against inflate
  the count attributed to the argument (D-045). See §4 for the real
  "checked-zero vs. never-computed" bug this taxonomy exposed and fixed
  (D-071).

### 3.13 Decision log (T17, FR8.1)
- **What it does.** Records, per task, the full structured reasoning behind
  every scheduled/deferred/batched decision — priority breakdown, dominant
  factor, department, eligible-window count, cross-department batching,
  cross-referenced typed conflicts.
- **Why it exists.** PRD FR8.1 — the substrate the explanation layer (3.14)
  is grounded in, and the source of the plain-English reasoning shown in the
  block detail drill-down (3.19).
- **How it works.** Audited live before building anything: deferral reasons
  were already complete (53/53), but the priority score, breakdown, batching
  flags and conflict cross-references were all being **computed and then
  discarded** by `/optimize` before this task — a genuine gap closed
  additively (D-048).
- **What real data backs it.** Real corpus, before → after this task: 0/89
  → 89/89 entries carrying `priorityScore`, breakdown, department, eligible
  windows; 0 → 5 tasks/2 blocks recording cross-department batching; 0 →
  18/89 typed-conflict cross-references (D-048).
- **Known limitations.** Deliberately **excludes overrides** — the log
  explains what the *solver* decided, never what an override later changed
  (a test asserts the string "override" never appears in it), keeping the
  D-043 separation intact; the join happens at explanation-grounding time
  instead (D-048/D-049).

### 3.14 "Ask the Planner" — grounded LLM explanation (T18, FR8.2, PRD §9.2)
- **What it does.** Free-text question box; a Controller can ask "why wasn't
  the relay fault fixed this week?" and get a grounded natural-language
  answer.
- **Why it exists.** PRD §9.2 — directly answers the question every judge
  asks of an optimization demo: "how do I trust what the AI decided?"
- **How it works.** A strict two-stage pipeline: `assemble_context` (Python,
  pure function) selects only the real records bearing on the question into
  a flat list of `Fact`s, each carrying its source record's id — the LLM
  **never sees the schedule itself**, only these facts (D-049). Every number
  in the model's reply is then checked at runtime against the values the
  context actually held; anything ungrounded is surfaced beside the answer
  as a warning, never styled as clean (D-050) — mutation-tested five ways.
  Six known gaps (`UNAVAILABLE_TOPICS`) are declared rather than silently
  guessed at; three have since been removed as the gaps they named were
  closed (failure risk, train impact, approval history), each replaced by a
  *framing* fact stating what can still go wrong (D-051, D-060).
- **What real data backs it.** Live-tested against the real API: 12 calls,
  4 questions × 3 repetitions, model correct in all 12 — the run itself
  exposed and fixed **three false-accusation bugs in this project's own
  verifier** (an ISO date's month, a thousands separator, a non-breaking
  hyphen — D-054), plus later ones for record-id digits and 17-digit
  timestamps (D-059, D-063).
- **What real data backs it (provider).** Default LLM provider is **Groq's
  `openai/gpt-oss-120b`**, not Claude — an explicitly asked-and-approved
  deviation from PRD §10.3 because no Anthropic key was available for this
  project; the Anthropic path is intact behind `LLM_PROVIDER=anthropic`
  (D-052). Internet-capable "compound" Groq models are deliberately avoided
  (search suppressed on every call) because a model that can read the
  internet mid-answer can ground a sentence in something no Controller can
  audit (D-052).
- **Known limitations.** Live tests (`-m live`) are excluded from the
  standard suite (cost money, need a real API key) and **skip cleanly
  without one rather than silently pass** — an absent key can never be
  mistaken for a verified explanation layer (D-050). `verify_answer` is "a
  net, not a proof" — a fabricated number that happens to coincidentally
  equal a real value elsewhere in context would pass; this is a stated,
  tested limit, not a silent gap (D-050).

### 3.15 Human-in-the-loop approval workflow + audit trail (T19, FR6.1/FR6.2/FR6.3)
- **What it does.** `draft → under_review → approved → published` (plus
  `under_review → rejected`), with a merged audit trail of every override
  and approval action.
- **Why it exists.** PRD §9.3/FR6.1 — turns the system from "a scheduling
  algorithm" into a decision-support tool a real officer could actually be
  allowed to use.
- **How it works.** Workflow state is **not a stored field** — it's derived
  by folding an append-only `schedule_approvals` log, specifically so
  D-043's "the schedule document is never written after generation"
  guarantee gains no exception (D-057). Only exactly four transitions are
  legal, asserted by enumerating all 20 (state, action) pairs and requiring
  the other 16 to be refused (D-057). Publishing freezes the plan by
  **refusing writes**, not by snapshotting — a `publishedPlanDigest` makes
  the freeze checkable; re-derivable and mutation-tested by writing an
  override past the API that refuses it (D-058). Approval is guarded by
  whole-plan re-validation and records known-unresolved conflicts (e.g. 11
  resource + 5 dependency, pre-T24/T25) rather than blocking on gaps every
  plan carries (D-057).
- **What real data backs it.** Verified live across five phrasings: a draft
  plan answers "has not been reviewed or approved by any role"; a published
  one answers "approved by the role controller… published at [timestamp]" —
  attribution is by role only, since this build has no user accounts naming
  individuals (D-057/D-060).
- **Known limitations.** DRM's read-only access to this screen was a genuine
  PRD gap the owner had to resolve directly (PRD §8 never specifies it) —
  resolved to read-only (D-073). Overrides are still governed by 3.11's
  TX7 concurrency risk.

### 3.16 What-if simulation (T20, FR5, PRD §9.4)
- **What it does.** For a selected task, shows 2+ concrete scheduling
  options with impact metrics side by side, plus a stated recommendation.
- **Why it exists.** PRD §9.4 — one of the strongest live-demo features
  because it's interactive.
- **How it works.** A **real re-solve** of the same CP-SAT model with a
  `Pin` constraint forcing the candidate task's placement or exclusion —
  never a simplified estimate, so a what-if answer is exactly as
  trustworthy as a real generation (D-064). Two real findings checked
  against the real corpus *before* any UI existed: excluding a scheduled
  task never rescues a deferred one (D-024 generalises to exclusion), and
  any perturbation reshuffles a large, variable number of *other*
  already-scheduled tasks' days as a side effect — so the diff design
  reports that as a count, never a wall of rows. **No persistence of any
  kind** — proven by calling the real endpoint twice and diffing identical
  results (D-064). "Apply this option" reuses T15's override endpoint
  **unchanged**, scoped to only the candidate task, never the side-effect
  reshuffles shown alongside it (D-065).
- **What real data backs it.** Verified live: applying a heavily-reshuffled
  option was correctly **refused** by T15's own re-validation (the window
  is only free in the hypothetical fully-re-solved world), while a
  zero-side-effect option succeeded with `schedule.blocks` staying
  byte-identical (D-065).
- **Known limitations.** A dedicated shorter solver timeout
  (`whatif_solver_max_seconds`, 4s) was needed after a real timing bug: an
  extreme-but-legal weight combination made four what-if solves risk the
  interactive request's own 30s timeout (27.7s observed) — fixed and now
  surfaces an honest `FEASIBLE` (not falsely `OPTIMAL`) status when
  cut short (T20).

### 3.17 Train-impact scoring (T22 Phase A, PRD §9.6)
- **What it does.** For every deferred task, reports how many real trains a
  traffic block would displace and an estimated weighted delay cost; checks
  every scheduled block against real occupancy for a train-impact conflict.
- **Why it exists.** PRD §9.6 — trades maintenance urgency against
  operational disruption, not just "is the corridor free."
- **How it works. Phase A (reporting) only — Phase B (an objective-function
  term) was deliberately scoped out**, on measured grounds, not budget: T3's
  real timetable carries occupied-window *times* but not per-service class
  beside them, so a displacement's class split must be *apportioned* from
  the corridor's overall mix, not measured. Reporting an apportioned
  estimate is fine; letting it drive the solver's actual placement choices
  is not — an estimate you can see is very different from one baked into a
  decision (D-056). Class weighting (4/2/1/0.7 for
  premium/express/passenger/goods, roughly) was itself measured against
  flat weighting, which produced zero information (identical score on every
  corridor) — the failure mode this measurement exists to catch (D-056).
- **What real data backs it.** All 53 (pre-splitting) deferred tasks are
  rescuable by displacing 1–16 real trains (median 3) — costed against the
  real occupancy calendar. `TRAIN_IMPACT_CONFLICT` is a real, **earned**
  zero: every scheduled block is checked against observed occupancy, not
  assumed clear (D-056).
- **Known limitations.** Explicitly **not wired into the CP-SAT objective**
  — reporting only, proven by the plan being byte-identical whether the
  feature exists or not (D-056). One real finding worth repeating in a
  pitch: TSK-00073 needs zero trains displaced at all — 22 minutes of
  clearance margin covers it; reporting "0 trains" without also stating
  clearance minutes would have made that read as free capacity rather than
  a margin (D-056).

### 3.18 Policy sliders (T23, FR3.4, PRD §13.1)
- **What it does.** Five sliders (the raw D-023 objective weights, not PRD's
  four named ones — see limitations) that a Controller can drag and
  regenerate the plan against, live.
- **Why it exists.** PRD FR3.4/§13.1 — an interactive demo moment: move a
  slider, watch the schedule visibly change.
- **How it works.** Audited on the real corpus *before* building any UI: at
  every tested multiplier (0.1x–10x) of every one of the five weights, the
  **scheduled set never changed** — only *which day* 7–25 of the 36
  scheduled tasks land on (D-061). This is broader than the original guess
  (that only batching/fragmentation would be tie-breakers) — on this
  corpus, every term is a tie-breaker, because the objective is flat across
  days whenever a task's SLA is satisfied on any day in the horizon
  (D-028/D-061). A real safety issue was found and closed: pushed far
  enough (10x+ outside the shipped range), the scheduled set genuinely
  collapses (36→3) — the exposed slider range is bounded to `[0.1x, 10x]`
  of each default, verified safe in worst-case *combination*, with a 10x
  margin to the nearest known-broken point (D-061). `PolicyWeightsIn`
  **refuses** an out-of-range weight with the specific bound — never clamps
  silently (D-061).
- **What real data backs it.** Verified live: a slider dragged to its
  ceiling, regenerated, Monday's block count visibly changed (10→14),
  coverage held at 36/53 exactly as predicted (T23).
- **Known limitations.** The UI copy states D-061's finding plainly: "changes
  when work happens... no combination changes which tasks get scheduled" —
  a deliberate honesty choice over letting a Controller assume otherwise.
  Batching's default weight was separately proven (not just observed) to
  already sit exactly on the true combinatorial ceiling for this corpus (5
  batches, out of 147 structurally eligible window instances) — no headroom
  exists at any safe weight (D-086, see §4).

### 3.19 Task/Block Detail Drill-down (TX5, PRD §8 screen 7)
- **What it does.** Clicking any Gantt block opens a read-only panel:
  department mix, plain-English reasoning, asset criticality, predicted
  risk, resource assignment, and the full dependency chain — always, not
  only when the block is overridable.
- **Why it exists.** A real PRD-named screen that had been built untracked
  and undocumented until a 2026-08-25 audit session found the gap (D-080).
- **How it works.** The reasoning text is **templated from the decision
  log's `contributingFactors`**, not a fresh LLM call — a Claude/Groq
  round-trip per block click would be the wrong latency/cost shape for
  something that should render instantly (D-080).
- **What real data backs it.** All fields already existed in Mongo/the
  decision log — no new backend logic, assembly only (D-080).
- **Known limitations.** A real bug was caught by live verification before
  shipping: an early version showed each dependency link's raw
  `Task.status` (always `'pending'` — written once at seed time, never
  updated), producing a contradictory-looking "pending ... has its own
  block in this plan"; fixed to report only the honest
  `scheduledInThisPlan` signal (D-080). Split-task segments (3.8) are not
  yet visually called out here either.

### 3.20 DRM Oversight — KPI hierarchy, monthly trends, CSV export (T28, TX6, PRD §14, §8 screen 6)
- **What it does.** Rolls up 16 named KPIs across Operations/Maintenance/
  Planning/Asset categories, plots real trend history across plan
  generations, and exports the same numbers as CSV.
- **Why it exists.** PRD §14 — makes the DRM/oversight view a genuine
  hierarchy rather than one flat list.
- **How it works.** All 16 PRD-named KPIs were audited against what the real
  data model actually supports **before** anything was built: **11 are real
  and computed for real**, **2 are honestly relabelled** ("tasks completed"
  → "tasks scheduled" — this prototype has no execution tracking;
  `Task.status` is written once at seed time and never updated), and **3
  are marked explicitly unavailable with the specific reason** (predicted
  risk *reduced* — no before/after model exists; asset availability % and
  downtime — no runtime asset-state model exists at all) (D-070). Schedule
  stability compares only same-horizon plans (a weekly-vs-monthly
  comparison would be meaningless), verified at **100%** across two
  identical consecutive regenerations — an expected, deterministic result,
  not luck (D-070/D-022). Trend charts plot **exactly the real history that
  exists**, oldest first, and refuse to draw a line from fewer than 3 real
  points — the section's own subtitle states plainly that this is not
  literally "monthly," per PRD §8's wording, because this prototype's real
  history will never span a month (D-081). CSV export is built from the
  exact same `KpiCategory[]` object already rendered on screen, so the file
  can never drift from the display (D-081).
- **What real data backs it.** Two real bugs found and fixed before
  shipping by checking a live API response, not assumed shapes: a
  high-criticality threshold was reading FR2.3's *normalised 0–1
  contribution weight* instead of the real 0–100 criticality score (D-070);
  a conflict-count KPI reported a real, checked zero as "not available"
  because the underlying report structure omits the key entirely once
  conflicts are zero — the same "checked-zero vs. never-computed" bug class
  described in §4 (D-070).
- **Known limitations.** As stated above — 3 KPIs are honestly unavailable,
  2 are relabelled from what the PRD's literal wording implies.

### 3.21 Emergency rolling re-optimization (T27, FR3.5, PRD §9.10)
- **What it does.** Simulates a disruption (an unplanned event consuming
  part of a corridor's remaining calendar) and commits a real, narrowly
  re-solved plan around it.
- **Why it exists.** PRD §9.10 — shows the system working in the messy real
  world, not just on a clean static input.
- **How it works.** "What emergency means" was audited before assuming
  anything: the more what-if-like reading (force an existing deferred task
  in) was tried first and reproduced D-024's known ceiling with nothing new
  to show; the reading actually built — a disruption **consumes** part of
  the calendar — was checked the same way and found a real, positive
  result (a real train movement/closure displaces a real task, cascading
  to the next) (D-069). Unlike the what-if sandbox, this **commits** — a
  genuinely new `Schedule` document is persisted, reusing T20's `Pin`
  mechanism generalised to many tasks plus a new "block this window
  outright for everyone" primitive (D-069). Current placements are read
  from the **effective** plan (including any manual overrides), never a
  fresh re-solve — a fresh re-solve would silently discard a Controller's
  prior override the moment an emergency hit (D-069).
- **What real data backs it.** Verified live: blocking a real window on
  MQX-RMF displaced its real occupant to the next day, cascading a second
  task one more day, with every *other* corridor byte-identical — confirmed
  independently via raw `curl` calls, not just the browser (D-069).
- **Known limitations.** The same under-determined-day volatility documented
  elsewhere (D-028/D-061) shows up here too, now in a *committing* context —
  one blocked window can move several of a corridor's other blocks to
  different days as CP-SAT's own tie-breaking redistributes them; the UI
  states this honestly rather than claiming only the disrupted task moved
  (D-069).

### 3.22 Weather/monsoon risk flagging (T26, PRD §9.9)
- **What it does.** Flags corridors as monsoon-risk from real Ministry of
  Jal Shakti flood data, displayed as a small advisory panel.
- **Why it exists.** PRD §9.9 — domain-grounded, low-effort differentiator.
- **How it works.** Audited before building: real *section-specific* flood
  data (Konkan Railway's own named vulnerable locations) exists but touches
  **zero** of this project's 26 real operative corridors. Real
  *state-level* Jal Shakti data is usable, but the join key itself has a
  real gap in the underlying `datameet/railways` data — only 8 of 26
  corridors have station-state metadata at all. Built narrow and honest
  rather than skipped or faked wider: a three-way real classification
  (D-068). **Reporting only** — never wired into the objective — proven by
  a mutation test showing an identical plan whether the flag exists or not
  (D-068), the same restraint applied to train-impact (3.17).
- **What real data backs it.** Exactly **2 of 26** real corridors flagged
  `"monsoon-risk"` (DGU-PNB/Assam, HGJ-SUNM/Uttar Pradesh, both on the real
  Jal Shakti list), 6 checked and genuinely `"none"`, **18 of 26 left
  `null`** — never guessed as safe (D-068). PRD's third enum value,
  `"flood-prone"`, is **never emitted** by this build — no section-specific
  data exists for this corpus, and a test pins that (D-068). 7 real blocks
  on the two flagged corridors are demoed on this project's own reference
  date, which genuinely falls inside India's real monsoon window — not a
  contrived date (D-068).
- **Known limitations.** Coverage gap stated above (18/26 corridors have no
  usable state data — a real gap in the source data, not something this
  task could fill).

### 3.23 Auth & role-based access control (T10/T11 remainder, FR10.1/FR10.2)
- **What it does.** JWT auth, four fixed demo accounts, role-scoped routes
  and navigation for Dept Engineer / Controller / DRM, plus a `super_admin`
  demo-convenience bypass.
- **Why it exists.** PRD FR10.1/FR10.2.
- **How it works.** Every write route carries an explicit `requireRole`,
  audited file-by-file rather than guessed; `requireAuth` is mounted per
  resource sub-router, not once for the whole API prefix (a blanket mount
  was found to shadow a genuinely-nonexistent path's 404 behind a 401 —
  caught by an existing test, D-073). The JWT payload carries role/
  department directly (no per-request Mongo round-trip), defensible
  specifically because there are exactly four fixed, seed-owned accounts
  with no self-registration (D-073).
- **What real data backs it.** Verified live across all four roles via
  headless Chromium: correct nav scoping, correct cross-role redirects
  (never a bare 403 — always that role's own landing route), the
  `super_admin` bypass reaching every route, zero console errors (D-073).
- **Known limitations. `super_admin` is explicitly not a PRD-specified
  role** — must never be presented as one in the pitch (D-073). Sessions
  persist to `sessionStorage` (not `localStorage`) — survives an accidental
  refresh mid-demo but never outlives the tab, a deliberate middle ground
  found only after a real bug (a stale `location.state` redirect sending a
  freshly-logged-in user to a previous session's page) was found and the
  feature that caused it removed entirely rather than patched (D-073).

### 3.24 Dept Engineer Portal (T11, PRD §8 screen 2, FR1.1)
- **What it does.** A cascading corridor→asset→resource submission form for
  logging a new maintenance/defect request, plus "my submitted requests"
  and a read-only view of the published plan's own-department blocks.
- **Why it exists.** PRD §8 screen 2 / FR1.1.
- **How it works.** `POST /api/tasks` derives `department` and
  `raisedByUserId` from the JWT, never trusts the request body — an
  engineer can only ever file into their own department, as themselves
  (D-073).
- **What real data backs it.** Verified live: a real submission through the
  cascading dropdowns appears immediately in "my submitted requests"
  (D-073).
- **Known limitations.** CSV/JSON bulk import (FR1.3) is explicitly **out of
  scope**, not built (T10's own note).

### 3.25 Guided walkthrough (not T-numbered — owner-directed housekeeping)
- **What it does.** A first-time, per-route interactive tour (spotlight +
  tooltip) across all nine app routes, plus a persistent "Replay
  walkthrough" control.
- **Why it exists.** Owner-directed, widened mid-session from
  Dashboard-only to every route.
- **How it works.** Hand-built (~250 lines), not a component library — the
  actual requirement (highlight one element, positioned tooltip, next/back/
  skip) is plain rectangle arithmetic, and every UI component this project
  already has is plain Tailwind with no component library to reconcile
  against (D-072). Every step's copy reuses the app's own existing framing
  text (e.g. the risk model's disclaimer, the comparison screen's D-031
  rules) rather than restating features in new words, so a step and the
  panel it describes can never say two different things (D-072).
- **What real data backs it.** Verified live: fresh `localStorage`
  auto-starts each route's own tour on its own first visit independently;
  a bounding-box comparison confirmed the spotlight ring aligns to
  sub-pixel precision with the actual highlighted element (D-072).
- **Known limitations.** None material; two bugs found during verification
  were in the *verification script* itself (wrong step index, a
  smart-quote mismatch), not the app (D-072).

### 3.26 Demo reset script (TX3)
- **What it does.** `npm run demo:reset` — reseeds the pipeline data and
  explicitly wipes accumulated `schedules`/`schedule_overrides`/
  `schedule_approvals` before a pitch.
- **Why it exists.** `npm run seed` deliberately never touches runtime
  state (by design, D-019); a separate script prevents the two operations
  from ever being conflated under demo-day pressure (D-074).
- **How it works.** Reuses `seed()`/`seedUsers()` unchanged; the three
  wiped collections were cross-checked against the model registry and a
  live `db.getCollectionNames()`, not assumed from memory (D-074).
- **What real data backs it.** Verified live: wiped 130/5/15 accumulated
  documents to zero; a second consecutive run reported `0→0` (idempotent)
  (D-074).
- **Known limitations.** None material.

### 3.27 Docker Compose + CI (TX1, D-087)
- **What it does.** Full four-service demo packaging, plus four
  independent, path-scoped GitHub Actions workflows.
- **Why it exists.** Demo packaging (D-005) and continuous verification.
- **How it works.** Verified end-to-end via **Podman**, not real Docker —
  Docker itself is unreachable in the dev sandbox (no daemon access, no
  `sudo`); flagged explicitly as a substitution against a
  Docker-Compose-spec-compliant engine, not the literal `docker compose`
  binary (D-087). CI provisions a real `mongo:8` service container for
  backend tests (so tests that self-skip locally without Mongo genuinely
  run in CI); the optimizer workflow deliberately runs with **no
  backend/Mongo provisioned**, so its two real-corpus tests skip cleanly by
  design rather than fail (D-087).
- **What real data backs it.** Full demo flow (seed → login → generate)
  verified for real over the compose network inside containers: a
  cross-department batch visible in the raw response (D-087). All four
  GitHub Actions workflows are currently **green** on `origin/main` (see §5).
- **Known limitations.** Explicitly **not verified against real Docker
  itself** on this machine — a real-Docker confirmation before demo day is
  named as outstanding, not assumed safe (D-005/D-087).

### 3.28 Controller Dashboard sidebar restructure — **UNCOMMITTED, undocumented** (see §7)
- **What it appears to do.** Reorganizes the dashboard sidebar into three
  tabs ("Plan actions" / "Priorities" / "Context & flags"), makes
  `KnownLimitations` collapsible (collapsed by default), and applies minor
  spacing tweaks to `PriorityQueue` and `ComparisonPage`.
- **Status.** This is present only as an **uncommitted working-tree diff**
  at audit time — not referenced anywhere in `TASKS.md`, `docs/DECISIONS.md`,
  or `PITCH_NUMBERS.md`. No new tests were added for it (frontend suite is
  still 145/145, unchanged count). See §7 for the full discrepancy note —
  **do not treat this as a demo-ready, verified feature** until it is
  finished, tested, and logged per this project's own discipline.

---

## 4. Honesty/rigor highlights

Concrete, checkable examples of this system reporting "zero," "unmeasurable,"
or "insufficient data" honestly instead of faking a number — a genuine
differentiator for judges who probe deeply:

- **The checked-zero vs. never-computed bug, found and fixed at its root
  (D-071).** Two independent tasks (T25, T28) each found, two and three
  layers away from the source, that a real "checked, and found zero"
  conflict count was indistinguishable from "never computed" once the
  conflict-summary dict simply had no key for a plan with zero conflicts.
  Rather than patch the third symptom, a full audit classified all 14 read
  sites of this shape across all three layers, found the one root cause
  (`summarise()` only seeding a key when it *saw* a conflict), and fixed it
  once — with two regression tests proving a real, checked zero is now
  distinguishable from a plan that was never summarised at all.
- **T29 Phase 2 stopped before writing any code because the honest rule
  finds zero eligible tasks (D-085).** Investigated whether any of the 21
  genuinely-impossible tasks could be placed via a real Indian Railways
  "caution order" mechanism. Reasoned per defect type (interlocking
  integrity, mis-routing risk, electrical isolation, and a duration-fit
  argument specifically for rail fracture, where the real-world mechanism
  exists but doesn't fit these particular 174–234-minute tasks). Net
  result: **0 of 21 qualify.** Flagged to the owner before the rule became
  load-bearing rather than building an entire new placement mechanism for
  zero benefit.
- **Flood-risk coverage stated as 2 of 26 corridors, not padded (D-068).**
  Real, section-specific Konkan Railway flood data was checked and found to
  touch zero of this project's corridors; state-level data usably flags
  exactly 2 of 26, with 18 of 26 left `null` (no state metadata exists) —
  never guessed safe.
- **The batching ceiling is a proven maximum, not an educated guess
  (D-086).** A dedicated combinatorial CP-SAT model (same hard constraints,
  objective replaced with "maximize batched-window count only") solves to
  OPTIMAL at exactly 5 — matching the real corpus's own achieved 5 exactly,
  and confirmed empirically flat across the entire safe policy-weight range.
- **The grounding verifier's own false accusations were treated as bugs of
  the same severity as a missed fabrication (D-054, D-059, D-063).** Six
  separate live-testing sessions found the "Ask the Planner" answer verifier
  wrongly flagging *correct* answers as fabricated (an ISO date split into
  digits, a thousands separator, a non-breaking hyphen, a cited record id, a
  17-digit timestamp, a task id's own digits). Every one was fixed with a
  regression test and the explicit reasoning: "a verifier that cries wolf is
  worse than no verifier."
- **Utilisation is never shown without its conflict count, because the
  higher number is the defect (D-031, D-042).** The baseline's 77.01%
  utilisation beats the optimizer's — because it over-subscribes 3 windows
  to get there. The comparison screen's layout structurally prevents
  separating the two.
- **A genuine third category, not a folded-in patch, when task splitting
  made a binary "possible/impossible" count stale (D-084).** Rather than
  quietly widen "contestable" to include split-only tasks (which would
  imply the baseline could place them too, which it categorically cannot),
  a new `splitOnly` category was introduced end-to-end, verified 36+32+21=89
  against a real solve before any reporting code was written.
- **The predictive risk model's own limitation is stated as a fact about the
  synthetic data, not hedged away (D-055).** Current health and decline rate
  correlate +0.867 on this corpus specifically because the generator starts
  every asset in a narrow band — stated plainly as a limitation of the
  *data*, not left for a judge to discover.
- **A concurrency risk (TX7) is documented and left deliberately unfixed**
  rather than silently shipped or silently ignored — reported with its exact
  mechanism, blast radius (no data corruption, a Risk not a Bug), and the
  two-layer fix it would need.

---

## 5. Test/quality snapshot — fresh this session

All four suites re-run today (2026-09-02) against the currently running dev
stack (MongoDB, optimizer on :8000, backend on :5000):

| Layer | Passed | Failed | Skipped/deselected | Command |
|---|---:|---:|---:|---|
| Backend | **135** | 0 | 0 | `cd backend && npm test` |
| Frontend | **145** | 0 | 0 | `cd frontend && npx vitest run` |
| Data | **105** | 0 | 0 | `cd data && .venv/bin/python -m pytest` |
| Optimizer | **343** | 0 | 9 (`-m live`: real Claude/Groq API calls, excluded by design) | `cd optimizer && .venv/bin/python -m pytest` |
| **Total** | **728** | **0** | 9 (by design) | |

All four counts above are **identical** to the last logged figures in
`PITCH_NUMBERS.md` (135/145/105/343, 728 total) — **no drift** since that
document was written. The optimizer run took several minutes real time (it
includes multiple real-corpus CP-SAT solves, one alone taking ~10s at the
solver's own timeout) but produced no dots other than passes (`.`) — no `F`
(fail), `E` (error), or `s` (skip) characters anywhere in its progress
output, confirmed by direct inspection of the raw run, not assumed from the
exit code alone.

**CI status (live-checked via `gh run list`):** the four most recent
per-workflow runs on `origin/main` are all **success** (backend, optimizer,
frontend, data), confirming `PITCH_NUMBERS.md` §7's "all four workflows are
green" claim still holds at audit time.

**Uncommitted working-tree state at audit time:** 4 modified frontend files
(§3.28, §7) — not reflected in any test count above beyond the unchanged
145/145 (no new tests were added for this in-progress change).

---

## 6. Demo-readiness notes

| Feature | Status |
|---|---|
| Corridor/timetable data (3.1) | Demo-safe. Static, deterministic, already seeded. |
| Synthetic data generator (3.2) | Demo-safe; don't re-run the generator live (reseeds from committed output, not a live regeneration step). |
| Priority engine (3.3) | Demo-safe. |
| Predictive risk model (3.4) | Demo-safe, but **state the simulated-data framing out loud** if a judge asks about the risk score — it's shown automatically under the priority queue, but the pitch script should say it, not just rely on the UI catching it. |
| CP-SAT core + splitting (3.5, 3.8) | Demo-safe. Solve is **FEASIBLE, not OPTIMAL**, at the default 10s budget — say this plainly if asked (per `PITCH_NUMBERS.md`'s own script), don't dodge it. |
| Dependency/resource constraints (3.6) | Demo-safe; these are invisible unless you open Known Limitations or the comparison screen's conflict evidence — worth clicking into during the demo, not just trusting a judge to ask. |
| Naive baseline (3.7) | Demo-safe; runs automatically alongside every generate. |
| Comparison screen (3.9) | **Strongest screen — lead the demo here.** Do not read the utilisation row out of order; the layout already prevents this, but narrate it in the same order the screen renders. |
| Gantt dashboard (3.10) | Demo-safe. Rough edge: if you regenerate a plan while the Gantt is already open without a full page reload, the selected-day tab may not re-resolve (D-075's known, unfixed limitation) — reload the page after a fresh generate if the day tab looks stale. |
| Manual override (3.11) | Demo-safe for a single-operator demo. **Do not** click override twice in rapid succession on the same task live — TX7's race is real, even if low-probability. |
| Conflict taxonomy (3.12) | Demo-safe; best shown via Known Limitations panel + Comparison screen's conflict evidence table together. |
| Decision log (3.13) | Not a standalone screen — shown through Block Detail Drill-down (3.19) and Ask the Planner (3.14). |
| Ask the Planner (3.14) | Demo-safe **if `GROQ_API_KEY`/`ANTHROPIC_API_KEY` is configured** — confirm the key is live before the pitch; a missing key surfaces a clean 503, not a crash, but it removes a differentiator from the live demo. |
| Approval workflow (3.15) | Demo-safe; walk it end to end (submit → approve → publish) to show the audit trail growing in real time. |
| What-if simulation (3.16) | Demo-safe; pick a task with a genuinely low side-effect count for the cleanest visual (a heavily-reshuffled option will correctly get refused if applied — that's a feature, but plan which task you demo it on). |
| Train-impact scoring (3.17) | Demo-safe; best shown on a deferred task (traffic-block cost) rather than a scheduled one (checked-and-clear reads as less visually interesting). |
| Policy sliders (3.18) | Demo-safe; the described "when, not how much" framing should be stated explicitly during the demo — don't let the slider imply it controls coverage. |
| Block detail drill-down (3.19) | Demo-safe; works on both draft and published plans. |
| DRM oversight + trends + CSV (3.20) | Demo-safe **if 3+ real schedule generations exist** for the trend chart to render — reset-then-generate three times before the pitch if you want the chart, not just the KPI cards. |
| Emergency re-optimization (3.21) | Demo-safe; pick a corridor/window with a real downstream task to displace for the clearest visual cascade. |
| Weather risk panel (3.22) | Demo-safe; only shows blocks on the 2 flagged corridors — confirm the seeded plan includes at least one before relying on it live. |
| Auth/RBAC (3.23) | Demo-safe; log in as each of the four roles ahead of time to confirm credentials still work post-reset. |
| Dept Engineer Portal (3.24) | Demo-safe. |
| Guided walkthrough (3.25) | Demo-safe; note it only auto-starts on a genuinely fresh browser profile / cleared localStorage — use "Replay walkthrough" for a repeat demo. |
| Demo reset script (3.26) | **Run this before the pitch, always** — per this project's own standing memory note, `npm run seed` alone does NOT clear schedule history. |
| Docker Compose + CI (3.27) | Verified via Podman, not real Docker — if the demo machine has real Docker, do a quick confirmation run before relying on it as the demo's actual launch mechanism; local `npm run dev`-style startup is the more battle-tested path. |
| Sidebar restructure (3.28) | **Not demo-safe as-is** — uncommitted, untested, not documented. Either finish and verify it before the pitch, or revert to the committed sidebar for the actual demo. |

---

## 7. Discrepancy found this session

**The working tree has uncommitted, undocumented frontend changes.**
`git status` shows 4 modified files
(`frontend/src/components/KnownLimitations.tsx`,
`frontend/src/components/PriorityQueue.tsx`,
`frontend/src/pages/ComparisonPage.tsx`,
`frontend/src/pages/ControllerDashboard.tsx`, 282 insertions / 142 deletions)
that are **not mentioned anywhere** in `TASKS.md`, `docs/DECISIONS.md`, or
`PITCH_NUMBERS.md` — all three of which currently describe the project as
fully closed out (T1–T28 + T29 Phase 1 done, TX1–TX6 done, only TX7 open) and
`PITCH_NUMBERS.md` explicitly claims "every number above came from one live
run today" with the codebase in a committed state.

Inspected directly (not assumed from the diff summary alone): the changes are
a **Controller Dashboard sidebar restructure** — the previously flat,
6-panel sidebar column is now split into three tabs ("Plan actions" /
"Priorities" / "Context & flags"), `KnownLimitations` gained a
collapsed-by-default expand/collapse state with a summary flag count, and
`PriorityQueue`/`ComparisonPage` received minor spacing adjustments. The
guided-tour step-to-tab mapping (`TAB_FOR_TOUR_STEP`) was updated to keep
D-072's walkthrough working across the new tabs — a sign this is a genuine,
careful in-progress change following this project's own conventions, not
stray experimentation.

**This is flagged, not silently reconciled, per this audit's own
instructions.** It appears to be mid-session work-in-progress: no
`TASKS.md` entry, no `docs/DECISIONS.md` entry explaining the tab-grouping
rationale (the code comments explain *what* and a little of *why*, but this
project's own convention is that a structural UI decision like this gets a
D-number), and the frontend test count is unchanged at 145/145 — meaning
**no new tests cover the tab logic, the collapse state, or the
tour-step-to-tab mapping**, which is itself inconsistent with this project's
otherwise-consistent practice of either adding tests or explicitly stating
"verified live instead, per CLAUDE.md's frontend-coverage guidance" (as
every comparable prior UI change in `docs/DECISIONS.md` does, e.g. D-072,
D-080, D-081). Recommend: finish this change, verify it live, log it with a
D-number (or explicitly revert it), and re-run `PITCH_NUMBERS.md`'s live
generation before treating the sidebar as demo-ready — per §6's note, it is
not currently demo-safe as an unfinished, undocumented change.

No other discrepancies were found between what `DECISIONS.md`/`TASKS.md`
claim and what the running code and fresh test runs actually show — backend,
frontend, and data test counts all matched `PITCH_NUMBERS.md` exactly, CI is
confirmed green via `gh run list`, and the architecture (service boundaries,
route gating, model list) matches the documented design in every location
checked.

---

## 8. Traceability — every D-number and T-number referenced

**Decisions (D-NNN):** D-001, D-003, D-004, D-005, D-006, D-007, D-008,
D-009, D-010, D-011, D-012, D-013, D-014, D-015, D-019, D-022, D-023, D-024,
D-026, D-027, D-028, D-029, D-030, D-031, D-032, D-037, D-040, D-041, D-042,
D-043, D-044, D-045, D-046, D-048, D-049, D-050, D-051, D-052, D-054, D-055,
D-056, D-057, D-058, D-059, D-060, D-061, D-063, D-064, D-065, D-066, D-067,
D-068, D-069, D-070, D-071, D-072, D-073, D-074, D-075, D-080, D-081, D-082,
D-084, D-085, D-086, D-087.

**Tasks (T-NNN / TX-N):** T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13,
T14, T15, T16, T17, T18, T19, T20, T21, T22, T23, T24, T25, T26, T27, T28,
T29 (Phase 1 and Phase 2), TX1, TX3, TX4, TX5, TX6, TX7.

**PRD sections referenced:** §5.1, §5.2, §6 (FR1–FR10), §8, §9.1–§9.11, §10,
§12, §13, §13.1, §14, §15, NG1–NG4.
