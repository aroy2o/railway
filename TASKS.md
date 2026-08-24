# Task tracker

Status values: `todo` | `in-progress` | `done` | `blocked`
Update this file at the end of every Claude Code session per `LOOP_PROMPT.md`.

---

## 🔴 Must build (do not skip ahead of this tier)

- [x] `done` — **T1**: Repo skeleton — `/backend`, `/optimizer`, `/frontend`, `/data`, `/docs` folders, package manifests, root `docker-compose.yml` stub, `.env.example`
      <br>_Built more than an empty skeleton: all three services boot, validate their config at startup, and answer health checks. `GET /api/health/dependencies` probes React → Express → MongoDB + CP-SAT in one call and is rendered live on the landing screen, so the wiring is provably real. Includes the PRD Section 5 prototype banner, a Zod validation-middleware factory and shared `ApiError` envelope on Express, Pydantic settings + an OR-Tools readiness probe on Python, and Redux Toolkit + RTK Query on the frontend. 6 backend tests, 5 optimizer tests, all passing._
- [x] `done` — **T2**: Real data ingestion script — fetch/parse `datameet/railways` station+route data, extract corridor sections (consecutive station pairs)
      <br>_Downloaded 98 MB of real data (stations 1.86 MB, trains 14.8 MB, schedules 82.2 MB from datameet/railways; plus the data.gov.in ISL timetable via the Kaggle mirror, 8.05 MB CSV). Parsed 417,080 stop records into **8,990 stations** and **10,149 corridor sections**, with a 100% station-code join rate. Corridor derivation groups stops by train, orders by `id`, and splits on id gaps — which is what prevents a phantom `JU–PPR` section from train 04857's duplicated stop list (unit-tested). Validated: median section length 6.6 km, and median published/straight-line distance ratio **1.034**. 28 tests; rebuilds are byte-identical. Also pulled in the ISL CSV far enough to corroborate sections and supply 1,890 real published distances — the occupancy calendar itself stays T3._
      <br>_Ran: `cd data && .venv/bin/python -m ingestion.download && .venv/bin/python -m ingestion.build_corridors`_
- [x] `done` — **T3**: Real timetable ingestion — fetch/parse data.gov.in / Kaggle timetable dataset, convert to per-corridor occupied-window calendar
      <br>_No new downloads needed. Built the occupancy calendar from the real arrival/departure times in `schedules.json`: 376,385 of 411,680 stop pairs used, producing 378,297 transit windows (1,912 split across midnight) over **8,454 of 10,149 sections**. Emitted `processed/corridor_calendar.json` (47 MB) with `occupiedWindows` + `maxDailyBlockWindows` (the free complement), and `processed/trains.json` with all 5,208 trains' real IR class codes. Median utilisation 13.8%; **66 sections have no usable block window at all**. The saturated ones are genuinely IR's worst: Barkhera–Budni 87% (Itarsi ghat, 0 windows), Bhadli–Bhusaval 83%, Ghaziabad–Sahibabad 82% (281 trains, one 54-min window at 01:08), Khandala–Palasdari 77% (Bhor Ghat). 41 new tests (69 total in `/data`); all outputs rebuild byte-identically._
      <br>_Ran: `cd data && .venv/bin/python -m ingestion.build_timetable`_
      <br>_**Deviation, flagged:** `maxDailyBlockWindows` lives in `corridor_calendar.json`, NOT written into `corridors.json`. Mutating T2's output in place would couple the stages and break T2's rebuild-determinism test. The backend joins the two on `_id` at seed time — see `docs/DECISIONS.md` D-009._
      <br>_**The null-`day` trap dissolved:** those 22,561 records are exactly the records with no arrival AND no departure either (exact co-occurrence). They define route order for T2 but cannot define occupancy — skipped and counted. Clock-wrap also beats `day`-delta for transit duration (day-delta yields 308 negative and 196 >24h durations; clock-wrap yields neither). D-011._
- [x] `done` — **T4**: Synthetic maintenance/asset data generator (PRD 5.2) — assets, tasks, resources, dependencies, anchored to T2's corridor list
      <br>_Generated **55 assets, 89 tasks, 102 resources** across **30 real corridors**, selected by excluding every `lowConfidence` section then stratifying on utilisation band **and** traffic percentile. Implemented the FR2.1 criticality formula for real (weights sum to 1.0, asserted at import; scores span 27.92–90.75; each asset ships a `criticalityBreakdown` for FR2.4). Distributions measured, not assumed: department 52.8/27.0/20.2 vs 50/30/20, severity Beta(2,3.5) `{1:29, 2:20, 3:29, 4:11, 5:0}`, all durations inside the PRD ranges. 25 new tests (94 total in `/data`); reproducible from `RANDOM_SEED` + `REFERENCE_DATE`._
      <br>_Ran: `cd data && .venv/bin/python -m generators.build_synthetic`_
      <br>_**Two real values were NOT synthesised**: `trainsAffectedCount` (T3 `trainsObserved`) and `passengerDependency` (premium share of T3's real train class mix). A test asserts every asset's count equals the observed one._
      <br>_**Deviation, flagged:** T3's `corridor_calendar.json` was extended with a `trainClassMix` field (raw IR class-code counts per section, no interpretation applied) so `passengerDependency` could be derived from real data instead of invented. It also serves T22 directly. T3's tests and idempotency still hold._
      <br>_**Two corrections made mid-task, both documented:** (1) IID asset-type sampling produced a 34/42/24 department split — replaced with an exact largest-remainder quota. (2) Selecting the busiest section per band compressed `trainsAffectedCount` to 134–281 and criticality to 54.7–90.3 — replaced with traffic-percentile spread, restoring 1–281 and 27.9–90.8. See D-013, D-014._
- [x] `done` — **T5**: MongoDB schemas (Mongoose) for all PRD Section 15 collections
      <br>_Six models: `Corridor`, `CorridorCalendar`, `Asset`, `Task`, `Resource`, `DatasetProvenance`. PRD Section 15 shapes preserved, plus every real extension T2–T4 produced (station detail, traversal counts, criticality breakdown, class mix). String `_id`s throughout (D-017). Seed script `npm run seed` loads 10,149 corridors + 10,149 calendars + 55 assets + 89 tasks + 102 resources in ~20 s, is safe to re-run (replace, not upsert — D-019), and self-verifies the provenance round-trip._
      <br>_**Bug found and fixed:** Mongoose `autoIndex` builds indexes in the background, and the seed closed its connection before they finished — so the collections had only `_id` and the corridor filter was a full scan (`docsExamined: 10149, keysExamined: 0`) while still returning correct results. The seed now awaits `syncIndexes()`; the same query is `docsExamined: 30`. See D-018._
- [x] `done` — **T6**: Standalone CP-SAT scheduler script (Python, no API yet) — hand-built small test scenario first, verify constraints hold (no double-booking, no resource overlap, deadlines respected)
      <br>_`optimizer/app/core/scheduler.py` — pure CP-SAT model, no FastAPI/DB/network. Hand-built 4-task scenario verified first (objective hand-computed as 76,500; solver returns exactly 76,500), then the real corpus: **89 tasks / 30 corridors → OPTIMAL in 0.65 s**, 36 scheduled, 53 deferred, 2 cross-department batches, 74.3% block utilisation. PRD Section 7's <10 s budget met with 15x headroom. 37 new tests (42 in `/optimizer`)._
      <br>_Ran: `cd optimizer && .venv/bin/python -m scripts.run_real_solve` (needs backend + seed)_
      <br>_**Bug caught by the real data:** the batching reward was written `flag <= departments_used - 1`, which forces `flag <= -1` on an eligible-but-empty window and made the whole model **INFEASIBLE**. All 21 hand-built tests passed against it because they never left an eligible window empty. Now `>= 2` enforced-if, with a regression test. General rule for T22–T25: a rewarded indicator must be free to be zero (D-025)._
      <br>_**Finding:** 53 of 89 tasks cannot fit ANY window on their corridor, and it tracks utilisation exactly. Verified not to be an artefact — removing T3's clearance margin and 30-min floor rescues exactly 1 task. Busy corridors need a traffic block that displaces trains, which is T22's train-impact-aware planning. Deferral messages say so (D-024)._
- [x] `done` — **T7**: Asset criticality + priority scoring module (weighted formula version first)
      <br>_`optimizer/app/core/priority.py` — FR2.3 score (0–100) as an additive weighted sum: severity 0.35, asset criticality 0.30, SLA urgency 0.20, SLA breach 0.15. FR2.4 ranked queue with per-factor contributions that sum exactly to the score, plus a named dominant factor. Wired into the solver; `priorityIsPlaceholder` now reports `false`. 25 new tests (70 in `/optimizer`)._
      <br>_**Weights measured, not asserted.** Against four alternatives on the real corpus: tied pairs drop from **1,057 → 11**, ρ = +0.706 vs severity-only. An SLA-dominant weighting was rejected on a correctness test — it inverts the ordering so a 60-day-overdue trivial defect (69.58) outranks a fresh critical one (39.71). Criticality earns its weight because it is **uncorrelated** with severity (median 59–65 across every severity band)._
      <br>_**Overdue handling** (the gap D-020 left): two terms, `sla_urgency` (0→1 over 90 days, PRD 5.2's longest SLA tier) and `sla_breach` (0→1 over 60 days past due, then capped so ageing alone cannot dominate the queue). D-027._
      <br>_**Before/after solve is a real second run, not a claim:** scheduled set **identical** (36/53), 21 tasks moved day. Expected, and explained in D-028 — every deferral on this corpus is structural, so there is nothing for priority to arbitrate. A test pins the equality so the shift is noticed when contention rises._
      <br>_Still deferred: **T16** owns `failureRiskScore` (FR2.2) — accepted on the input and deliberately unused rather than faked._
- [x] `done` — **T8**: Naive baseline algorithm (independent per-department scheduling, FR9.1) — must be real, not mocked
      <br>_`optimizer/app/core/baseline.py` — each department runs an independent FCFS pass with a clean view of the calendar, so double-booking is structural rather than introduced. Reuses T6's input dataclasses and `ScheduledBlock`/`DeferredTask`, with a `BaselineResult` shaped for direct diffing. 15 new tests (85 in `/optimizer`)._
      <br>_Ran: `cd optimizer && .venv/bin/python -m scripts.run_comparison`_
      <br>_**Real result on the contestable 36:** baseline 36/36 scheduled, **6 double-bookings, 605 double-booked minutes, 3 over-subscribed windows, 0 batches**. Optimizer: 36/36, 0 conflicts, 2 batches._
      <br>_⚠️ **The optimizer schedules NO more tasks than the baseline** — identical at 1/2/3/7-day horizons. Any "AI schedules N% more" headline would be false. The advantage is executability and coordination (D-031)._
      <br>_⚠️ **The baseline's utilisation is HIGHER (77.01% vs 74.33%)** and that is the defect, not an advantage: same 4,880 minutes crammed into 24 windows instead of 25 by over-subscribing 3. Never show utilisation without the conflict count beside it._
      <br>_FCFS orders by `dateRaised`, deliberately not `slaDueDate` — that would be earliest-deadline-first and would flatter the baseline (D-029). Added an optional `date_raised` field to `MaintenanceTask`; additive only, no constraint or objective logic touched._
- [x] `done` — **T9**: FastAPI service wrapping T6/T7/T8 as `/prioritize`, `/optimize`, `/baseline` endpoints
      <br>_Three POST endpoints over the existing pure functions — no solver logic touched. Strict Pydantic request contract (`extra="forbid"`, referential-integrity validators, size/horizon ceilings); responses returned **unfiltered** because a `response_model` silently drops undeclared fields and the honesty fields are exactly what would vanish (D-033). 35 new tests (120 in `/optimizer`)._
      <br>_**Real corpus reproduced over HTTP:** 89 tasks → OPTIMAL 36/53 in 0.68 s, 2 batches, knownGaps resource=11 dependency=5, `priorityIsPlaceholder: false`; baseline 6 double-bookings / 605 minutes / 3 over-subscribed / 0 batches; `/prioritize` top TSK-00082 at 87.31. Identical to the numbers T6/T7/T8 produced by direct calls._
      <br>_`/baseline` returns `contestableTaskIds` (36) so T14 cannot draw the comparison from all 89 (D-031), and warns when `dateRaised` is missing rather than letting FCFS degrade to "sorts last" silently._
      <br>_Dev harnesses retired: `run_real_solve.py` deleted, `run_comparison.py` rewritten to POST to the live endpoints, `real_data.py` demoted to a payload builder for tests._
- [ ] `todo` — **T10**: Express API — auth (JWT), CRUD for tasks/corridors/assets, orchestration calls to FastAPI service
      <br>_**Partially done.** Read-only routes exist and are tested: `/api/corridors`, `/api/corridors/:id`, `/api/assets`, `/api/assets/:id`, `/api/tasks`, `/api/tasks/:id`, `/api/resources`, `/api/provenance` — all validated, paginated (limit capped at 200) and using the shared `ApiError` envelope._
      <br>_**Orchestration slice done (2026-08-22).** `POST /api/schedules/generate` closes the loop: MongoDB → gather → optimizer HTTP → MongoDB. Also `GET /api/schedules`, `/latest`, `/:id`, and `POST /api/tasks/reprioritize`. New `schedules` collection (append-only per FR6.3, D-034); FR2.3 priority scores now persist onto tasks, so `/api/tasks` no longer returns null and the UI no longer shows "unscored". 16 new tests (34 in `/backend`)._
      <br>_**Real corpus reproduces through the full loop:** 89 tasks → OPTIMAL 36/53 in 0.65 s, 2 batches, baseline 6 double-bookings / 605 min / 3 over-subscribed, knownGaps 11/5, priorityScore range 25.04–87.31 on all 89 tasks. Asserted in a test, not just observed._
      <br>_**Bug fixed, found only by integration:** the error handler masked ALL 5xx messages, so an unreachable optimizer reported "Internal server error" instead of "Could not reach the optimizer service". `ApiError` messages are author-written and safe by construction; only unexpected errors are masked now (D-037)._
      <br>_**Still pending in T10:** JWT auth + role gating (FR10), write/CRUD for task submission (FR1.1), CSV/JSON bulk import (FR1.3)._
- [ ] `todo` — **T11**: React app shell — routing, auth flow, API client module
      <br>_**Partially done.** `react-router-dom` installed and wired; six routes live (`/corridors`, `/corridors/:id`, `/assets`, `/tasks`, `/resources`, `/status`) with header nav, all reading through the RTK Query `apiSlice` — no bare `fetch` anywhere. `SyntheticBadge` renders the PRD Section 5 honesty framing from the data itself._
      <br>_**Still pending:** the login screen and role-based routing (Dept Engineer / Controller / DRM, PRD Section 8), which need T10's auth._
- [x] `done` — **T12**: Gantt/corridor timeline component (weekly/monthly toggle, department color-coding)
      <br>_`GanttTimeline.tsx` — corridor rows, 24-hour x-axis, day selector across the horizon (empty days kept visible). Department colours reuse the `DepartmentPill` palette. **Cross-department batches are drawn structurally differently** — split into a proportional segment per department, violet ring, "shared block" label — so the headline capability reads without decoding a legend (D-040)._
      <br>_Monthly toggle is **visibly disabled** with a tooltip naming T28 rather than faked from weekly data. Timeline opens on the first day carrying a batch, not the busiest day: the busiest day on the real corpus has 13 blocks and no batch at all._
      <br>_Layout arithmetic extracted to `src/lib/gantt.ts` with 7 vitest unit tests; rendering verified by screenshot._
- [x] `done` — **T13**: Controller Dashboard — KPI strip, priority queue, "Generate schedule" trigger
      <br>_`/dashboard`, now the landing route (D-039). KPI strip from `metrics`; priority queue from the persisted `priorityScore`/`dominantPriorityFactor`/`priorityBreakdown` rather than the decision log, because FR2.4 needs the breakdown the log does not carry (D-038); deferred-work panel rendering the solver's own reasons verbatim (FR3.3); known-limitations panel carrying `knownGaps` and `generationErrors` through to screen._
      <br>_Generate trigger verified end to end by driving a real browser click over CDP — created `SCH-20260823052322649`. With the optimizer stopped, the same click renders **"Could not reach the optimizer service"**, D-037's actionable message, while keeping the existing plan on screen._
      <br>_**Not included, each scoped elsewhere:** Baseline vs AI comparison (T14 — `comparisonToBaseline` deliberately left untouched), manual override (T15), Ask the Planner (T18), what-if (T20), policy sliders (T23 — `policyWeights` stays null, no faked control)._
      <br>_⚠️ Follow-up: `/api/tasks` still sorts by severity, not `priorityScore`. Its own comment anticipated this. The queue sorts client-side for now; move it server-side in the next backend pass (D-038)._
- [ ] `todo` — **T14**: Baseline vs AI comparison screen (FR9.3) — real computed metrics table
      <br>_⚠️ **Read D-031 first.** Draw the comparison from `structurally_contestable()` (36 tasks), not all 89. Do not lead with task count — both engines schedule 36/36. Lead with conflicts (6 → 0) and batching (0 → 2)._
      <br>_⚠️ Utilisation must never appear without the conflict count: the baseline's 77.01% beats the AI's 74.33% purely by over-subscribing windows._
- [x] `done` — **T15**: Manual override UI + backend re-validation against constraints (FR6.2/FR3)
      <br>_`schedule_overrides` collection, append-only; **the schedule document is never mutated** because `decisionLog` explains the solver's plan and T17 must stay grounded in something true (D-043). Reads return `blocks` (solver), `overrides`, and `effectivePlan` (the two combined)._
      <br>_Six named re-validation checks, every one reported pass or fail. **Capacity is measured against the effective plan, never the base blocks** — a validator reading the solver's original blocks would not see work a prior override moved in and would silently accept an over-fill (D-044)._
      <br>_The adversarial test for that was **mutation-checked**: injecting the exact bug it guards against makes it fail (plus 6 others), so it demonstrably has teeth._
      <br>_Verified live in a real browser: an accepted move (TSK-00033, 6 checks green) and a refused one staged as a genuine race — `duration-fits-window` passes (140 min into a 152 min window) while `window-capacity` fails (only 34 min left). A single "does it fit" check would have accepted it._
      <br>_Cross-corridor moves refused outright — the defect is on that corridor's asset. `task.status` deliberately untouched (D-043)._
      <br>_**Not included:** the full FR6.1 Accept/Modify/Reject workflow with published-plan versioning (T19), and what-if simulation (T20)._

## 🟠 Strong differentiators (start only once all 🔴 above is `done`)

- [x] `done` — **T16**: Predictive asset-risk model (FR2.2, PRD 9.1), honestly framed
  - `optimizer/app/core/risk.py`: linear trend extrapolation to an intervention
    threshold. Chosen because it **matches T4's generative process** (constant
    per-asset decline + N(0, 0.015) noise), not as an approximation of it.
  - **No classifier**, and the reason is a fact about the data: there are no
    failure labels. Labels derived from the same series would be circular and any
    accuracy figure meaningless. PRD 9.1 offers the option; the data does not.
  - **Probability-of-crossing was built, measured and rejected** — noise is too
    small relative to the decline, so it collapsed to near-binary (30 of 55 under
    5, 23 over 50). Time-to-threshold keeps the information and stays continuous.
  - Weights reconsidered, not bolted on (D-055): **30/25/20/15/10**. Risk earns
    0.20 on the same evidence criticality earned 0.30 — near-orthogonal to both
    existing physical factors (rho -0.084 vs severity, +0.141 vs criticality) —
    and is capped *below* criticality because it comes from simulated data while
    criticality is anchored in real train counts.
  - Ranking moved: rho +0.873, median rank move 8 places, `failure_risk`
    dominant for 15 of 89 tasks. **The plan did not change** — same 36/53 split,
    same blocks, same batches, same utilisation (D-024: no capacity contest).
  - Honest gaps: <3 observations -> `null` + reason; no declining trend -> `0.0`
    + reason; missing score -> the other four weights **renormalise** rather than
    contributing zero, so a data gap is never scored as a favourable finding.
  - Framing enforced at every layer and tested to *appear*: stored on the asset
    and the schedule, returned by `/risk` twice over, rendered under the priority
    queue, and returned by `/explain` as `context.modelFramings`
    **independently of whether the model repeated it**.
  - Tests: 16 risk (4 mutation-verified), plus updated priority/API/decision-log
    and a backend round-trip asserting the disclaimer survives to MongoDB.
- [x] `done` — **T17**: Decision log generation in the optimizer (structured, per-task reasoning)
  - Audited live against real generated data before changing anything. Deferral
    reasons were already complete (53/53 with reason + detail); everything else
    was thinner than assumed.
  - `priorityScore` + FR2.4 breakdown + `dominantPriorityFactor`: **0/89 → 89/89**.
    `/optimize` was computing the whole breakdown and keeping only the rounded
    integer (D-048) — the same computed-then-discarded shape as D-047.
  - `department`, `eligibleWindowsConsidered`: **0/89 → 89/89**.
  - Cross-department batching (`sharedWith`, `isCrossDepartmentBatch`): **0 → 5
    tasks across 2 blocks**. The project's headline differentiator was not
    recorded in the log that explains it.
  - Typed-conflict cross-reference: **0 → 18/89** entries.
  - Overrides deliberately NOT added: D-043 keeps "what the AI decided" and
    "what the plan is now" separate. A test asserts "override" never appears in
    the log. The join happens at grounding time instead.
  - All additive — no constraint or objective change. 12 tests, 4
    mutation-verified.
- [x] `done` — **T18**: `/explain` endpoint (LLM call grounded in decision log) + "Ask the Planner" UI
  - **Grounding contract** (`optimizer/app/core/grounding.py`): `assemble_context`
    is a pure function selecting the real records that bear on a question. The
    model never sees the schedule — only a flat list of `Fact`s, each carrying
    the id of the record it came from, so an answer is auditable (D-049).
  - **Runtime verification** (`explainer.py`): every number in the model's reply
    is checked against the values the context actually contained. Ungrounded
    figures are returned beside the answer and rendered as a warning, never
    styled as a clean answer (D-050). Mutation-verified 5 ways.
  - **Honest refusal**: six `UNAVAILABLE_TOPICS` (train impact → T22, failure
    risk → T16, approval/audit → T19, what-if → T20, policy → T23, weather),
    each with a reason and the task that would supply it (D-051).
  - `POST /api/schedules/:id/explain` and `/latest/explain`; Node gathers, Python
    grounds and calls Claude. `EXPLAIN_TIMEOUT_MS` separate from the solver's.
  - No `ANTHROPIC_API_KEY` → **503 with an actionable message**, surfaced intact
    to the Controller (D-051 extends D-037 one layer out).
  - **Provider is pluggable** (D-052). Default `LLM_PROVIDER=groq` with
    `openai/gpt-oss-120b`; the Anthropic path is intact behind one env var.
    Do NOT switch to a `groq/compound-*` model — they can reach the internet and
    bill against gpt-oss's rate limit anyway.
  - **Context size budget** (D-053): an unreferenced question once built an
    ~11,000-token prompt, over the per-minute allowance. Now ~1,750 tokens with
    ranked survival, and anything dropped is reported to the model rather than
    silently lost.
  - **Live behaviour verified against the real API** — 12 calls, 4 questions × 3
    repetitions. The model was correct in all 12; the run exposed **three
    false-accusation bugs in this project's own verifier** (month of an ISO
    date, thousands separator, non-breaking hyphen), all fixed with regression
    tests (D-054).
- [ ] `todo` — **T19**: Human-in-the-loop approval workflow (FR6.1) + `audit_logs` collection + Audit Trail view
- [ ] `todo` — **T20**: What-if simulation endpoint + UI panel (FR5)
- [x] `done` — **T21**: Conflict detection + typed classification (corridor/train-impact/resource/dependency) + display (FR4)
  - `optimizer/app/core/conflicts.py`: the PRD 9.5 taxonomy. Four detectable types
    (`CORRIDOR_DOUBLE_BOOKING`, `WINDOW_OVER_SUBSCRIPTION`, `RESOURCE_CONTENTION`,
    `DEPENDENCY_ORDER_VIOLATION`), each with a named resolution strategy.
  - `TRAIN_IMPACT_CONFLICT` is named but **not detected** — reported in
    `notYetDetectable` with a reason, never as a count of zero. Needs T22.
  - Resolutions are **classified, not applied**. Nothing here changes a plan;
    resource no-overlap is still T25, dependency precedence still T24.
  - Real corpus: optimized plan 11 resource contention + 5 dependency order;
    baseline 6 corridor double-bookings + 3 over-subscribed windows. Counts
    unchanged from T6/T8 — the taxonomy names them, it does not re-detect them.
  - All 11 resource conflicts are same-department, because T4's resource
    catalogue is keyed by department, so cross-department contention cannot
    occur by construction. The strategy differs accordingly ("Stagger within the
    department" rather than PRD 9.5's cross-department "Only one proceeds"),
    and a test asserts this so a change to the resource model surfaces.
  - `detect_known_gaps` was returning 3 fields per conflict where the baseline
    returned 7. Enriched to 9 — additive, all data already in scope (D-047).
  - Never totalled across plans (D-045); stored once in Python, not recomputed
    per layer (D-046).
  - Tests: 12 optimizer (3 mutation-verified), 2 backend round-trip, 9 frontend.
  - UI: `KnownLimitations` on the dashboard, type badges + resolution on the
    comparison screen's conflict evidence. Both visually confirmed.
- [x] `done` — **T22 (Phase A)**: Train-impact scoring + traffic-block costing (PRD 9.6)
  - **Phase A only, decided on measurement not budget** (D-056). Phase B — a
    penalty term in the CP-SAT objective — was scoped out because T3 kept train
    times but not per-service classes, so the class split is *apportioned*.
    Reporting an estimate is fine; putting one inside the objective would let it
    drive the solver's choices, not just its reporting.
  - Phase B's prize measured first: **all 53 deferred tasks are rescuable** by
    displacing 1-16 trains (median 3). Not scoped out because it was small —
    scoped out because the ripple hits D-031's contestable-36 framing and four
    prior tasks' comparisons, and the data cannot justify λ yet.
  - Class weighting **4/2/1/0.7**, measured against alternatives: flat weighting
    produces a constant (spread 0.00, 325 ties) — the exact failure mode a
    "score" that carries no information looks like.
  - `TRAIN_IMPACT_CONFLICT` **graduated cleanly**: out of `notYetDetectable`,
    into a new `checkedAndClear`, never both. Real count 0 — an *earned* zero,
    since every block is checked against observed occupancy.
  - `/explain` grounding: `TRAIN_IMPACT_GAP_FACT` removed (the claim became
    false) and replaced with the measured/estimated boundary — the same
    stale-claim cleanup T16 did to its own "model not built" line.
  - **The plan is unchanged**: 36 scheduled / 53 deferred, 25 blocks, 2 batches,
    74.33% utilisation. Phase A is read-only by construction.
  - Three bugs found and fixed: the span sweep jumped undefined gaps (then
    over-corrected into strict adjacency, which T3's clearance margin breaks);
    "0 trains displaced" was reported for corridors whose occupancy was never
    sent; and Mongoose's `deferredSchema` silently stripped the costing (D-033's
    failure mode in a new layer).
  - One real finding: **TSK-00073 needs no train displaced at all** — 22 minutes
    of clearance margin. `clearanceMinutes` now travels with every costing, so a
    0-train block is never reported as free.
  - Tests: 31 on the impact model (4 mutation-verified, plus a brute-force check
    that boundary-aligned search is exhaustive), backend persistence regression.
- [ ] `todo` — **T23**: Policy sliders on Controller Dashboard, wired to objective function weights (13.1)

## 🟡 Stretch (only if time remains after 🟠 is done)

- [ ] `todo` — **T24**: Task dependency constraints in CP-SAT (9.7)
- [ ] `todo` — **T25**: Resource-conflict constraints in CP-SAT (9.8)
- [ ] `todo` — **T26**: Weather/monsoon risk flagging (9.9)
- [ ] `todo` — **T27**: Emergency rolling re-optimization (9.10)
- [ ] `todo` — **T28**: Monthly planning polish + DRM oversight view KPI hierarchy (Section 14)

## Cross-cutting (interleave as needed, not a strict phase)

- [ ] `todo` — **TX1**: Docker Compose wiring for full-stack demo run
      <br>_⚠️ `docker compose` is **not installed** on this dev machine, so `docker-compose.yml` and the three Dockerfiles written in T1 are **unverified end to end**. Must be run at least once well before demo day — see `docs/DECISIONS.md` D-005._
- [x] `done` — **TX2**: `docs/DECISIONS.md` — architecture decision log (created on first use per `LOOP_PROMPT.md`)
      <br>_Created with D-001 (TS frontend / JS backend), D-002 (single repo-root `.env`), D-003 (Redux Toolkit + RTK Query, server-vs-client state split), D-004 (fail-fast config, one error envelope), D-005 (local-first dev, Compose for demo). Append to it as decisions are made, not after._
- [ ] `todo` — **TX3**: Seed script to reset demo data to a known-good state before the actual pitch
- [ ] `todo` — **TX4**: Final pitch-deck numbers pulled from a real run, not placeholders

---

## Maintenance

- **2026-08-23** — `/backend` migrated from JavaScript to TypeScript at the owner's request,
  superseding the backend half of D-001 (see D-041). ~3,200 lines across 32 files, no behaviour
  change; all 34 backend tests pass and the real-corpus loop reproduces exactly. The migration
  surfaced four latent looseness bugs — a `Mixed`-typed field with a known shape, a loosely typed
  wire/stored block mismatch, a dead import, and unchecked `null` from `.lean()` in tests.

## Integration checkpoints

- **2026-08-22 @ `d4910eb`** — T10 orchestration slice landed on top of the checkpoint. The
  four-layer loop (MongoDB → Node → optimizer HTTP → MongoDB) runs end to end and reproduces
  every CHECKPOINT.md number.

- **2026-08-22 @ `8bac58b`** — [CHECKPOINT.md](CHECKPOINT.md): full T5→T9 regression pass before
  T10. Pipeline determinism, seed idempotency, D-018 indexes, 232 tests across four layers, and
  the real-corpus result over live HTTP all verified against documentation. **No fixes required.**

## Session log

_Append a dated one-line entry here each session — what was completed, what's next._

- **2026-08-23** — T15 complete. **All 🔴 must-build tasks are now done.** Manual override with real re-validation, stored as an append-only log rather than by mutating the plan. The adversarial capacity test was mutation-checked to prove it can fail. Next: 🟠 differentiators.
- **2026-08-23** — T14 complete. `/comparison` renders the FR9.3 metrics table with D-031's framing built into the layout rather than appended as small print, and the real conflict report as evidence. Backend TypeScript conversion re-verified clean beforehand (0 `any`, strict proven enforced, all four suites green) and `CLAUDE.md` corrected. Next: **T15 — manual override**, or T16–T23 differentiators.
- **2026-08-23** — T12 + T13 complete. First judge-facing screen: Controller Dashboard at `/dashboard`, now the landing route. Cross-department batch visualisation verified to read clearly. Generate trigger and the optimizer-down error state both verified by driving a real browser click. Next: **T14 — Baseline vs AI comparison**, the strongest judging screen, building on `comparisonToBaseline` which this task deliberately left alone.
- **2026-08-22** — T10 orchestration slice complete. The four-layer loop runs end to end for the first time; priority scores persist; schedules are stored append-only. One real bug found in the seam between two already-tested components (5xx message masking). Next: **T11 auth/routing or T13/T14 dashboard** — see the tradeoff note in the session report.
- **2026-08-22** — T9 (optimizer endpoints) complete. `/prioritize`, `/optimize`, `/baseline` live; the full T6/T7/T8 real-corpus result now reproduces over HTTP with every honesty field intact. This closes the optimizer-service half of the architecture. Next: **the Node orchestration half of T10**, then T11–T14 for the UI.
- **2026-08-22** — T8 (naive baseline) complete. Real FCFS per-department algorithm producing 6 genuine double-bookings and 605 double-booked minutes on the real corpus, against the optimizer's zero. Key framing finding: throughput is **identical** (36/36 both) at every horizon, so the honest claim is coordination and feasibility, not volume — and the baseline's higher utilisation is an over-subscription artefact (D-031). Next: **T9 — FastAPI endpoints** wrapping both solver cores.
- **2026-08-22** — T7 (priority engine) complete. FR2.3 score + FR2.4 ranked queue, weights measured against four alternatives (ties 1,057 → 11). Wired into the solver and re-run for real: scheduled set unchanged at 36/53, which D-028 explains rather than explains away. Next: **T8 — the naive baseline**.
- **2026-08-22** — T6 (CP-SAT scheduler) complete. Built and hand-verified in isolation first, then run on the real corpus: OPTIMAL in 0.65 s, 36/89 scheduled, all 53 deferrals structural. Found and fixed an INFEASIBLE-making batching constraint that the hand-built tests could not surface. Resource conflicts (11) and dependency violations (5) are detected and reported rather than silently shipped — quantified gaps for T25 and T24. Next: **T7 — priority engine**, which replaces T6's severity placeholder.
- **2026-08-22** — T5 complete, plus read-only slices of T10 and T11 so the pipeline output is browsable. Six Mongoose models, an idempotent seed script, eight read-only API routes and six frontend routes. Found and fixed a silent full-collection-scan caused by abandoned background index builds. All 🔴 tier — no Controller Dashboard or Gantt (T12/T13). Next: **T6 — the CP-SAT scheduler**, the first real optimizer milestone.
- **2026-08-22** — T4 (synthetic maintenance generator) complete. 55 assets / 89 tasks / 102 resources on 30 real corridors, with the FR2.1 criticality formula implemented and every PRD 5.2 distribution measured against spec. Two mid-task corrections (department quota, corridor selection) recorded rather than quietly fixed. Repo footprint checked: 164 MB on disk in `/data`, only ~114 KB tracked. Next: **T5 — Mongoose schemas + seed path**.
- **2026-08-22** — T3 (timetable occupancy calendar) complete. 8,454 sections given real occupied/free windows from 376,385 timed stop pairs; 5,208 trains parsed with real IR class codes. The null-`day` trap turned out to be the same records as the no-time records, so no policy call was needed. Verified the GitHub remote is private and holds nothing unexpected. Next: **T4 — synthetic maintenance/asset generator**.
- **2026-08-22** — T2 (real corridor ingestion) complete. 98 MB downloaded from datameet/railways + the data.gov.in Kaggle mirror; 8,990 stations and 10,149 corridor sections derived from 417,080 real stop records, cross-validated against a second source. Repo put under git and pushed to `github.com/aroy2o/railway`; `claude.md`/`todo.md` renamed to `CLAUDE.md`/`TASKS.md`. Next: **T3 — timetable occupancy calendar**.
- **2026-08-22** — T1 (repo skeleton) + TX2 (decision log) complete. All three services boot and are wired together, verified by a live `/api/health/dependencies` probe returning green for MongoDB and CP-SAT. Frontend adopted as TypeScript + Tailwind v4 + Redux Toolkit (owner's scaffold + owner's request). Next: **T2 — real corridor data ingestion** from `datameet/railways`.

---

## Notes carried forward

**Stack facts established in T1** (affects every later frontend task, T11–T15 and T18–T23):
- Frontend is **TypeScript**, not JavaScript. Backend stays JavaScript ESM.
- State management is **Redux Toolkit**. Server state lives in the RTK Query `api` slice
  (`frontend/src/api/apiSlice.ts`) — every backend call is an endpoint there, no bare `fetch`
  in components. Client state (auth, policy sliders, selection) goes in `src/store/slices/`.
- Styling is **Tailwind v4** via `@tailwindcss/vite` — no `tailwind.config.js`.
- All three services read **one `.env` at the repo root**. Add new variables to `.env.example`
  with a comment, or they will be missing from the other two services.
- Verified working on this machine: Node 20.19.1, Python 3.12.10, MongoDB 8.0.29,
  OR-Tools 9.15.6755 (CP-SAT constructs a model successfully — the highest-risk dependency
  is confirmed good).

**Housekeeping discovered during T1:**
- `LOOP_PROMPT.md` refers to `CLAUDE.md` and `TASKS.md`; the actual files are `CLAUDE.md`
  (lowercase) and `TASKS.md`. Renaming `CLAUDE.md` → `CLAUDE.md` would also make Claude Code
  auto-load it every session. Not renamed without approval.
- The repo is **not a git repository** yet. `.gitignore` is written and ready; `git init` is
  worth doing before the codebase grows, so mistakes are recoverable.