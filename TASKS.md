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
- [x] `done` — **T10**: Express API — auth (JWT), CRUD for tasks/corridors/assets, orchestration calls to FastAPI service
      <br>_Read-only routes exist and are tested: `/api/corridors`, `/api/corridors/:id`, `/api/assets`, `/api/assets/:id`, `/api/tasks`, `/api/tasks/:id`, `/api/resources`, `/api/provenance` — all validated, paginated (limit capped at 200) and using the shared `ApiError` envelope._
      <br>_**Orchestration slice done (2026-08-22).** `POST /api/schedules/generate` closes the loop: MongoDB → gather → optimizer HTTP → MongoDB. Also `GET /api/schedules`, `/latest`, `/:id`, and `POST /api/tasks/reprioritize`. New `schedules` collection (append-only per FR6.3, D-034); FR2.3 priority scores now persist onto tasks, so `/api/tasks` no longer returns null and the UI no longer shows "unscored". 16 new tests (34 in `/backend`)._
      <br>_**Real corpus reproduces through the full loop:** 89 tasks → OPTIMAL 36/53 in 0.65 s, 2 batches, baseline 6 double-bookings / 605 min / 3 over-subscribed, knownGaps 11/5, priorityScore range 25.04–87.31 on all 89 tasks. Asserted in a test, not just observed._
      <br>_**Bug fixed, found only by integration:** the error handler masked ALL 5xx messages, so an unreachable optimizer reported "Internal server error" instead of "Could not reach the optimizer service". `ApiError` messages are author-written and safe by construction; only unexpected errors are masked now (D-037)._
      <br>_**Auth completed (2026-08-25).** JWT auth (FR10.2) + role gating (FR10.1), plus `POST /api/tasks` — the FR1.1 write/CRUD task-submission endpoint that was the last real gap. Every write route now carries an explicit `requireRole`; every read route requires at least `requireAuth`. `super_admin` is a demo/dev-convenience role beyond FR10.1, satisfied by one explicit bypass check. See D-073. CSV/JSON bulk import (FR1.3) remains out of scope — not requested this session._
      <br>_20 new backend tests (`auth.test.ts`, 154 total); the 4 pre-existing suites updated to carry a bearer token now that their routes are gated (not a business-logic change)._
- [x] `done` — **T11**: React app shell — routing, auth flow, API client module
      <br>_`react-router-dom` installed and wired; routes for the reference/browsing pages, all reading through the RTK Query `apiSlice` — no bare `fetch` anywhere. `SyntheticBadge` renders the PRD Section 5 honesty framing from the data itself._
      <br>_**Auth flow completed (2026-08-25).** Login screen (`LoginPage.tsx`, no manual role selector — real JWT auth means the role comes from which account logs in), `RequireRole.tsx` route guards (unauthenticated → `/login`; wrong role → that role's own landing route, never a bare 403), role-scoped nav in `AppHeader.tsx`, and the net-new Dept Engineer Portal (`DeptEngineerPortal.tsx` at `/engineer`: FR1.1 submission form with cascading corridor→asset→resource pickers, "my submitted requests," and a read-only view of the published plan's blocks for their department). `authSlice.ts` persists to `sessionStorage` (survives a refresh, never outlives the tab) — a deliberate change from the original in-memory-only note, which had explicitly left that call to this task. See D-073._
      <br>_**A real bug found only by driving all four accounts through a real browser in sequence:** `location.state`-based "return to where you were" on the login page could send a freshly-logged-in user to a STALE previous session's page across a full reload. Removed — every login now lands on that role's own default route, no exceptions._
      <br>_6 new frontend tests (`authSlice.test.ts`, 111 total); 20/20 checks verified live driving a real headless Chromium (all 4 roles + unauthenticated, nav scoping, cross-role redirects, the DRM read-only `/audit` view, logout, the `super_admin` bypass, and the full engineer submission flow), zero console errors._
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
  - **Honest refusal**: `UNAVAILABLE_TOPICS`, each with a reason and the task
    that would supply it (D-051). Started at six; **three have since been
    removed because the gap was filled** — failure risk (T16), train impact
    (T22), approval/audit (T19). Three remain: what-if → T20, policy → T23,
    weather. Each removal is paired with a *framing* fact naming what an answer
    can now get wrong instead (D-055, D-056, D-060).
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
- [x] `done` — **T19**: Human-in-the-loop approval workflow (FR6.1) + audit trail view (FR6.2) + versioned publishing (FR6.3)
  - **The workflow state is not stored on the schedule** — it is a fold over a
    new append-only `schedule_approvals` collection (D-057). D-043's guarantee
    ("the schedule document is never written after generation") therefore stays
    whole rather than gaining an exception, and **no migration was needed**: a
    plan with no rows is a draft, which every pre-T19 plan genuinely is.
  - Four transitions, and **only** four: `draft→under_review→approved→published`
    plus `under_review→reject`. Refusals name the state and the legal actions.
    Asserted by ENUMERATING all 20 (state, action) pairs and requiring the other
    16 to be refused — the only way to know the illegal set is complete.
  - **PRD Section 15's single `audit_logs` is stored as two collections and
    merged on read** (D-057). An override is keyed (scheduleId, taskId) and is a
    delta on a placement; an approval is keyed (scheduleId) and is a verdict on
    the whole plan. One table would leave four fields structurally null on every
    approve/reject row. `GET /:id/audit` is the PRD's view.
  - **Publishing freezes by refusing writes, not by snapshotting** (D-058) —
    additive to D-043, not a workaround. A `publishedPlanDigest` makes the freeze
    *checkable*: `/audit` re-derives it and reports whether it still holds.
    Mutation-tested by writing an override past the API that refuses it.
  - `approve` is guarded by **whole-plan re-validation** — the plan a Controller
    is about to sign, not the one the solver produced. Six checks, all passing on
    the real corpus; the sign-off records **11 resource + 5 dependency**
    conflicts as `knownUnresolved` rather than blocking on gaps every plan has.
  - T15 is untouched. One gate was added *in front of* `recordOverride`; nothing
    below it changed. A rejected plan's overrides are kept, not deleted.
  - **Ask the Planner now answers approval questions**, verified live in both
    states across five phrasings: draft → *"has not been reviewed or approved by
    any role"* (answered, not declined); published → *"approved by the role
    controller… published at 2026-08-24T02:59:09.017Z"*. Attribution is by ROLE —
    this build has no user accounts, and the framing fact forbids naming a
    person (D-060).
  - **Three verifier bugs found by live runs** (D-059), all false accusations:
    a cited record id read as a 17-digit quantity, an ISO instant's clock read as
    `9`, and `float` mangling integers above 2^53. Plus one false *clearance* —
    stored clock components were whitelisting small integers.
  - `/api/schedules/published` is a different query from `/latest`: the newest
    plan is not the one crews are working to (PRD Section 8's engineer view).
  - **Tests:** 5 mutations caught (illegal transition made legal, freeze removed,
    capacity check blinded, digest ignoring dates, reconciliation disabled).
    Backend 98, optimizer 260, frontend 55.
- [x] `done` — **T20**: What-if simulation endpoint + UI panel (FR5, 9.4)
  - **Solver extended, not stood-in for.** `solve_schedule` gained a `Pin`
    parameter (force one task's placement, or exclusion) - a hard constraint
    added to the SAME model T6-T23 already build; batching, capacity and the
    real T23 objective run unchanged. A what-if answer is exactly as
    trustworthy as a real generation, never a simplified estimate.
  - **Two real findings from the real corpus, checked before any UI code
    existed.** (1) D-024 generalises to exclusion, not only to weights:
    excluding any of 15 sampled scheduled tasks never rescued a single
    deferred one - deferral here is never a capacity contest, so freeing
    capacity never helps a task that fits no window at all. (2) ANY
    perturbation - move OR exclude - reshuffles a large, variable number of
    OTHER already-scheduled tasks' days as a side effect (0 to 25 of 35
    sampled), the same under-determined-day volatility T23/D-061 found from a
    weight nudge alone. The diff design follows directly: the candidate task's
    own outcome in full, everything else as a COUNT plus a small sample -
    never a wall of rows - with the framing stating this plainly.
  - **A structurally deferred task gets exactly one option, reused, not
    recomputed.** No alternate window exists to re-solve into (D-024's
    ceiling, reached directly), so the one honest option is T22's own
    traffic-block cost, taken verbatim from the baseline solve's own deferral
    entry - zero extra solve time, and no second implementation of a cost T22
    already computes correctly.
  - **A second real timing issue found only by testing at real-corpus scale.**
    An extreme-but-T23-legal weight combination (fragmentation at its 10x
    ceiling) made a single solve take 8-9s to PROVE optimal - four of those in
    one what-if request risked the interactive call itself timing out (27.7s
    observed against a 30s default). Fixed with a dedicated, shorter
    `whatif_solver_max_seconds` (4s) and a matching `WHATIF_TIMEOUT_MS` on
    Node; a cut-short solve now reports its real CP-SAT `status` (`FEASIBLE`,
    not falsely `OPTIMAL`) and the UI shows that honestly rather than
    presenting every option as equally proven.
  - **No persistence, of any kind** (D-064) - not a field, not a fold. A
    what-if is a pure function of the backlog, the referenced schedule's own
    `policyWeights`, and the candidate task id; proven, not assumed, by a test
    that calls the real endpoint twice and asserts an identical plan.
  - **Applying an option reuses T15's override endpoint unchanged** (D-065) -
    no new write path, no shortcut around FR6.2. Confirmed LIVE, not just
    reasoned through: applying a heavily-reshuffled option was correctly
    REFUSED by T15's own re-validation (the window is only free in the
    hypothetical fully-re-solved world, not the current one), while a
    zero-side-effect option succeeded with all six checks passing and
    `schedule.blocks` staying byte-identical.
  - **Tests:** optimizer 288 (14 new, including a mutation test whose first
    version had a blind spot - both fixture options shared `reshuffled_count`,
    so the mutation was invisible until the fixture was fixed to actually
    differentiate on both ranking axes), backend 107 (5 new), frontend 70
    (8 new). Verified live end to end in a real browser: a scheduled task's
    "What if?" opened 3 real options side by side with a recommendation, a
    deferred task's opened the single traffic-block option, and the apply
    flow was driven to both outcomes above.
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
- [x] `done` — **T23**: Policy sliders on Controller Dashboard, wired to objective function weights (13.1)
  - **Audited before building anything, on the real corpus.** All five D-023
    weights were run at five multipliers each (0.1x-10x) directly against
    `solve_schedule`. Result, contrary to the initial guess: the SCHEDULED SET
    never changed at any multiplier, for any weight - confirming D-024/D-028
    generalises completely - but every one of the five visibly moved WHICH DAY
    7-25 of the 36 scheduled tasks land on. Batching and fragmentation were not
    uniquely special; the whole objective is a tie-breaker on this corpus, not
    a contest-decider. See D-061.
  - **A real safety issue found and closed.** Pushed further out (coverage down
    to 1, penalties up), the scheduled set genuinely collapsed - 36 to 3.
    D-023's "coverage is never traded for tidiness" is a property of the
    CHOSEN magnitudes, not a structural guarantee. The exposed slider range is
    bounded to [0.1x, 10x] of each default, verified safe not just per-weight
    but in worst-case combination, with a 10x margin to the nearest known-broken
    point.
  - `PolicyWeightsIn` (optimizer) validates and REFUSES an out-of-range weight
    with the specific bound - never clamps. Node's `policyWeightsSchema`
    duplicates the same simple numeric range for an immediate 400 rather than
    a round trip; `.strict()` also refused a typo'd field name after a test
    caught it silently being dropped instead.
  - The weights ACTUALLY used (every term present, defaults filled in for
    whatever was omitted) are returned by `/optimize` and persisted onto
    `schedule.policyWeights` - never the request's raw partial input, never
    faked when the request sent nothing.
  - **D-057's "derive, do not store" rule does not apply here** - checked
    explicitly, not assumed by analogy (D-062). Workflow state changes after
    the document exists; `policyWeights` is decided once, before the solve
    runs, same category as `blocks` and `decisionLog`.
  - **UI decision:** the five raw D-023 weights, not PRD's four named sliders
    ("Risk avoidance" and "Train punctuality" reference terms - beta, lambda -
    that D-023 itself defers and do not exist in the objective yet; labelling a
    slider after them would overclaim). Caption states D-061's finding plainly:
    "changes when work happens... no combination changes which tasks get
    scheduled."
  - Verified live end to end, not just over HTTP: a slider dragged to its
    ceiling in a real browser, Regenerate clicked, a new schedule persisted,
    Monday's block count visibly changed (10 -> 14), coverage held at 36/53
    exactly as predicted, and the slider's own value survived the resulting
    re-render.
  - **Tests:** optimizer 273 (13 new, including a mutation test that
    demonstrates the safety boundary is real - not vacuous - on the real
    corpus), backend 102 (4 new; two caught real bugs: a shared-DB test-count
    assumption, and a typo'd weight field silently passing before `.strict()`
    was added), frontend 62 (7 new).

## 🟡 Stretch (only if time remains after 🟠 is done)

- [x] `done` — **T24**: Task dependency constraints in CP-SAT (9.7)
  - **Semantics settled by evidence already in the codebase, not guessed.**
    PRD 9.7 says "before its prerequisite COMPLETES", and T6's own
    `detect_known_gaps` had been comparing exactly that (day, then minute)
    for reporting since T21. The hard constraint matches it exactly, so a
    genuine same-day case (TSK-00053 finishes 429, TSK-00054 starts 1143,
    same day) sequences correctly instead of being pushed to a wasted extra
    day by a coarser day-only rule.
  - **Mechanism:** a pre-solve fixed-point pass defers a task whose
    prerequisite is itself structurally unschedulable
    (`PREREQUISITE_UNSCHEDULABLE`, cascades through a 3-stage chain), plus a
    hard CP-SAT constraint on the rest - scheduled-at-all implies the
    prerequisite is too, and every window pair that would violate ordering
    is forbidden outright. `solve_schedule` now asserts zero violations on
    every OPTIMAL/FEASIBLE solve (mirrors the existing FR3.3 invariant).
  - **The real corpus was already violating this rule, not narrowly.**
    Audited before writing any code: 5 live violations, including
    TSK-00001/TSK-00002 scheduled in the EXACT SAME window on the same day
    (physically simultaneous, not just out of order) and TSK-00025 scheduled
    despite its prerequisite TSK-00024 never getting a window at all.
  - **Fixing it moved real numbers.** 36→35 scheduled, 74.33%→48.53%
    utilisation. The utilisation drop is real and traced: the ABEO-ABU chain
    now needs 3 SEPARATE ~1394-min windows instead of packing into one, which
    accounts for essentially the entire capacity jump. 74.33% was flattered
    by a physically impossible co-location; 48.53% is the honest figure.
  - **A sharper finding: the baseline commits this exact violation for
    real.** FR9.1's FCFS baseline has never read `dependsOnTaskId` and
    schedules TSK-00025 regardless of TSK-00024's fate. D-031's "no
    throughput advantage, identical 36" is no longer exactly true - the
    optimizer schedules 35, one fewer than the baseline's 36, and that gap
    is the honest cost of not making the mistake the baseline still makes.
  - **Every place that claimed "identical throughput" now computes the
    claim dynamically instead of asserting a stale constant:** the backend
    comparison caveat, a new `optimizer-fewer-by-design` verdict on the
    comparison screen (distinct from a misleading green "improvement" badge),
    and a `KnownLimitations.tsx` gap from T22 that had never rendered
    `checkedAndClear` at all - now closed, so both `TRAIN_IMPACT_CONFLICT`
    and `DEPENDENCY_ORDER_VIOLATION` show under "Checked, and none found."
  - **Tests:** optimizer 294 (7 new: enforced exclusion, valid same-day and
    cross-day sequencing, single- and 3-stage cascade, an isolated detector
    test, and a mutation-style A/B proof the constraint changes the real
    plan), backend 107 (real-corpus numbers updated with reasoning inline),
    frontend 71 (1 new, asserting the lower count never reads as a win).
    Verified live end to end in a real browser against a freshly regenerated
    schedule: Known Limitations panel and the comparison screen both match
    every number found by the audit.
- [x] `done` — **T25**: Resource-conflict constraints in CP-SAT (9.8)
  - **Simpler mechanism than T24's** since resource sharing is symmetric (no
    prerequisite): a pairwise `assign[a]+assign[b]<=1` for every same-day,
    overlapping window pair between two tasks sharing a crew, machine or
    permission - matched to the same test T21's detector already used, so a
    real solve can never disagree with the post-solve check. `solve_schedule`
    asserts zero resource conflicts, mirroring T24's invariant.
  - **Audited a real worry before building anything.** T4 gives Engineering
    and S&T exactly ONE permission per depot, so any two same-department
    tasks share it by construction - 3 of the real corpus's 10 conflicts were
    attributable ONLY to that single permission, not real crew/machine
    contention. Measured (not guessed) whether enforcing it uniformly would
    cause an unrealistic depot-wide bottleneck: solving with permission-type
    ids stripped changed the plan by exactly 1 block (32 vs 33) and scheduled
    the IDENTICAL 35 tasks either way - crew/machine scarcity (2-3 per
    department) was already the binding constraint, so uniform enforcement
    (matching PRD 9.8's own type-agnostic wording) was kept as written.
  - **Unlike T24, this cost ZERO coverage** - same 35-task scheduled set
    before and after, only the packing changed (28→33 blocks, 48.53%→45.42%
    utilisation). That the two T24/T25 findings differ in kind (one lost a
    task, one lost nothing) is itself better evidence for D-024/D-028's
    "structural, not contested" thesis than either alone.
  - **A sharper baseline finding than T24's.** Reusing the SAME detector
    against the baseline's own placements (no new baseline code) found **27**
    real resource conflicts in FR9.1's own output - whole departments
    double-booking their own crew and machine, e.g. three tasks all claiming
    the same P.Way gang and traffic-block permission in one window. Far more
    severe than T24's single dependency violation. Captured in DECISIONS.md
    per this task's scope, not built into new production UI.
  - **A real bug found two layers deep.** Resource conflicts reaching zero
    for the first time made `conflictReport.byPlan` an empty object, and
    Mongoose's default `minimize: true` was silently stripping it before it
    ever reached MongoDB - reproduced in isolation, proven to be Mongoose
    (not BSON: the native driver stores `{}` fine), fixed with
    `minimize: false` on the schema. Same failure class as D-015/D-033, a
    third layer, only reachable now that "zero conflicts" became real.
  - **A second bug, on the frontend, found by driving the browser.**
    `KnownLimitations.tsx` used "zero groups" to mean "this schedule predates
    T21" and showed a hardcoded "not enforced" label - which a MODERN,
    fully-enforced schedule also has zero groups for, and would have shown
    the same now-false label forever. Fixed to key off whether a typed report
    exists at all, with an honest empty-state line for the modern case.
  - **Tests:** optimizer 299 (+5 net; several T21-era fixtures rewritten
    because a real solve can no longer produce a resource conflict to
    exercise the reporting path against, same reason T24 needed it), backend
    107 (the shared 2-task fixture had `requiredResourceIds` removed - it was
    accidentally both a batching demo and a resource-conflict demo, which
    T25 makes mutually exclusive), frontend 71 (no new file; the fallback bug
    was caught and fixed via live browser verification, which is how it was
    found in the first place). Verified live end to end against a freshly
    regenerated schedule.
- [x] `done` — **T26**: Weather/monsoon risk flagging (9.9)
  - **Audited before writing anything.** PRD 5.1 names two REAL sources for
    this field (IMD rainfall, publicly known flood-prone rail sections) -
    not synthetic. Real, section-specific flood data exists (Konkan
    Railway's own named vulnerable locations) but touches ZERO of this
    project's 26 real corridors. Real state-level flood-risk data
    (Ministry of Jal Shakti) exists and IS usable, but only 8 of 26
    corridors have any station `state` metadata at all - a real gap in the
    underlying `datameet/railways` data, not something this task could fill.
  - **Built narrow and honest rather than not built or faked wider.** Three-
    way real classification: `"monsoon-risk"` (2 of 26 corridors - DGU-PNB/
    Assam, HGJ-SUNM/Uttar Pradesh, both named on the Jal Shakti list),
    `"none"` (6 of 26, known state, genuinely not flagged), `null` (18 of
    26, no state data - never guessed safe, T16's honesty pattern exactly).
    `"flood-prone"` (PRD's third enum value) is never emitted - no
    section-specific data exists for this corpus, and a test pins that.
  - **Architecture follows D-009 exactly, for the same reason.** A separate
    ingestion stage (`build_seasonal_risk.py`) producing a separate file,
    joined onto `Corridor.seasonalRiskFlag` at seed time like T3's
    `occupancySummary` (D-016) - never a rewrite of T2's own corridors.json.
  - **Reporting only - the same call T22 made for train-impact.** PRD 9.9's
    own wording is ambiguous between a soft objective term and a hard rule;
    given the real signal covers only 2 of 26 corridors, wiring it into the
    objective would let a thin, coarse flag silently steer the solver.
    `app/core/weather.py` only ever reports after the solve. A mutation-
    style test proves it: the identical scenario, solved with and without
    the flag, produces the IDENTICAL plan either way.
  - **Real corpus result: 7 live blocks, on the actual demo horizon.** All 7
    tasks on the two flagged corridors are scheduled, and this project's own
    reference date (2026-08-24) genuinely falls inside IMD's real Southwest
    Monsoon window (~June 1 - ~October 15) - not a contrived date. Confirmed
    live: 35/54 scheduled/deferred and 45.42% utilisation are UNCHANGED from
    before this feature existed, proving "advisory only" by observation.
  - **Baseline checked the same way T24/T25 checked it, softer finding.**
    Reusing the same detector against the baseline's own output (no new
    baseline code) finds it schedules essentially the same monsoon-risk work
    - not a "violation" (weather isn't a rule), just something only the
    optimizer can tell anyone about. Documented, not built into new UI, the
    same restraint T24/T25 applied where there was no existing false claim
    to correct.
  - **UI:** a small dedicated `WeatherRiskPanel.tsx`, mirroring T16's
    `RISK_FRAMING` pattern rather than T21's conflict-taxonomy machinery -
    PRD 9.9 is a different section from PRD 9.5 and forcing them together
    would blur a distinction this codebase otherwise keeps carefully
    separate (D-045). Verified live: 7 real blocks with corridor/date/task
    detail and the honest caveat, above Known Limitations on the sidebar.
  - **Tests:** data layer 11 new (105 total), optimizer 9 new (308 total),
    backend 1 new + real-corpus assertions extended (108 total), frontend
    unchanged (71 total; verified live instead, matching CLAUDE.md's
    frontend-coverage guidance for a component this small).
- [x] `done` — **T27**: Emergency rolling re-optimization (9.10)
  - **"Emergency" was audited before it was assumed.** PRD 9.10's own text
    ("re-solve only the affected corridor/window, holding already-executed
    blocks fixed") settles two things unambiguously: this re-solve is
    scope-narrowed to one corridor, and it commits (unlike T20's
    deliberately non-committing what-if sandbox). What "emergency" itself
    means was NOT unambiguous, so the more T20-like reading - "an existing
    deferred task gets forced in right now" - was tried FIRST, directly
    against the real corpus, before any code existed. It failed to produce
    anything new: D-024 held exactly as it holds under T20's exclusion and
    T23's weight sliders (TSK-00073, needs 174 min, stays deferred no matter
    how much of MQX-RMF's remaining capacity opens around it). The reading
    actually built - an unplanned event CONSUMES part of the corridor's
    remaining calendar - was checked the same way and produced a real,
    positive finding: blocking MQX-RMF's real window 9 on 2026-08-27
    (holding real TSK-00076) displaced it to 2026-08-28, cascading
    TSK-00077 to 2026-08-29, every other corridor and deferred task
    byte-identical. This reading also needs no new task-creation write path
    at all - FR1.1 stays T10's, untouched. See D-069.
  - **Mechanism reused, not reinvented.** `Pin` (T20) generalised from one
    task to `pins: list[Pin]`, plus a genuinely new primitive,
    `blocked_window_keys`, for "no task may use this window at all" -
    different from a pin, which only ever constrains ONE task. Every task
    off the affected corridor is pinned to its exact current placement (or
    excluded, if deferred); every window on the affected corridor before the
    earliest disrupted date is blocked outright, plus the disrupted
    window(s) themselves. A pin exemption had to be added explicitly so an
    already-executed task's own pin (which necessarily names a window inside
    the blocked range) still works - found by the audit script, not guessed.
  - **A second real bug the same audit found:** a task with genuinely ZERO
    remaining candidate windows was reported via the pre-T27 NO_CAPACITY
    message as having LOST a priority contest - it never got to enter one.
    Fixed with a new, honest code, `WINDOW_UNAVAILABLE`, used exactly when
    the candidate count is zero (D-025's "a rewarded indicator must be free
    to be zero" rule, reached from a new angle).
  - **A new commit path, but only because T15's override genuinely does not
    fit** - checked explicitly rather than assumed. T15 replays a DELTA on
    the existing plan without re-solving, so it cannot express "the
    corridor's remaining tasks reshuffle around a capacity change." So
    `POST /api/schedules/:id/emergency` persists a genuinely new `Schedule`
    document (additive to D-034, not an exception), carrying a new
    `emergencyContext` field. `currentPlacements` comes from the EFFECTIVE
    plan (T15 overrides included), never a fresh re-solve - deliberately
    different from T20's own choice (D-064), because a fresh re-solve here
    would silently discard a manual move the moment an emergency hit
    (D-044's rule, reached in a new layer). No new workflow gate either:
    T19's `assertOverridable` already points to "generate a new plan" as the
    correct response to a frozen plan, which is exactly what this is.
  - **A cross-task finding, not a new one:** the same under-determined-day
    volatility T20/T23 already documented (D-028/D-061) reproduces here too,
    now in a COMMITTING context - one disrupted window on BBPR-SYU moved all
    three of the corridor's remaining blocks to different days, confirmed
    live in a real browser AND independently via direct `curl` calls on the
    exact same disruption.
  - **A live-testing bug in the frontend panel itself**, caught only by
    driving a real browser: the first version diffed "before" vs "after" by
    reading `blocks` reactively from the dashboard's own live query - which
    the emergency mutation's own `invalidatesTags` had already refetched to
    the JUST-CREATED plan by the time the diff rendered, so everything
    silently read as "unchanged." Fixed by freezing a snapshot in component
    state at submit time; re-verified live and against the same `curl`
    ground-truth check.
  - **Tests:** optimizer 323 (15 new: off-corridor tasks held exactly fixed,
    a disrupted window genuinely displacing its occupant, an empty
    already-executed window staying unusable, honest deferral for a
    structurally-oversized task, `WINDOW_UNAVAILABLE`, a mutation-style
    proof the block - not the pin set - causes the displacement, pin
    uniqueness, HTTP contract validation, and two real-corpus regression
    tests pinning the audit's own findings). Backend 120 (6 new: a full
    commit-and-persist round trip on a deterministic fixture, source-schedule
    immutability, boundary validation). Frontend: no new test file
    (consistent with T26's practice for a panel this size); verified live
    end to end, including the stale-snapshot bug found and fixed above.
- [x] `done` — **T28**: Monthly planning polish + DRM oversight view KPI hierarchy (Section 14)
  - **Monthly is the SAME real CP-SAT solve at a longer horizon, displayed
    coarser - not PRD 13's literal two-stage reserve-then-refine hierarchy,**
    a deliberate, flagged scope decision. Audited on the real corpus first:
    a 30-day solve schedules the identical 35/54 split as weekly (D-024
    holds at any horizon, as T20/T23/T27 already found), but genuinely
    surfaces 6 real blocks that fall entirely beyond the 7-day window
    (spread to 2026-09-22) - real, new visibility for a DRM planning a month
    out, not a relabelled weekly plan. `monthlyReservationRows`
    (`lib/gantt.ts`) rolls the real blocks up to corridor-day resolution
    (PRD 13's own "reservation-level"); `scheduler.py`'s `horizon` label now
    recognises 28-31 days as `"monthly"`, matching PRD Section 15's stored
    enum. See D-070.
  - **The Weekly/Monthly toggle triggers a real re-solve, never a client-side
    view switch** - D-040's "faking one would be inventing a plan the solver
    never produced" still holds. The monthly grid is deliberately read-only:
    a reservation cell can represent several blocks in one day, so it has no
    single placement to hand T15's override endpoint.
  - **DRM oversight (`/oversight`): all 16 PRD Section 14 KPIs audited
    against what this data model actually supports before writing anything.**
    Eleven computed for real (train delay/affected trains via T22's
    displacement costing - `0 min from this plan`, an earned zero, with the
    hypothetical traffic-block cost stated separately; blocked/unused hours;
    overdue tasks; utilisation; batching ratio; conflict count; schedule
    stability and high-criticality-at-risk, both new). Two of PRD's own
    names ("tasks/critical tasks completed") assume execution tracking this
    prototype does not have - `Task.status` is written once at seed time and
    never updated (D-043) - relabelled honestly to "scheduled" rather than
    silently claiming completion. Three marked unavailable with the specific
    reason: predicted risk REDUCED (T16 has no before/after model, the same
    boundary T16 itself states), asset availability %, and downtime (no
    runtime asset-state model exists at all).
  - **Two real bugs found and fixed before shipping, neither guessed -
    found by checking a real API response.** (1) The high-criticality
    threshold first read `priorityBreakdown.components.asset_criticality`,
    which is FR2.3's NORMALISED 0-1 contribution weight (`0.827`), not the
    real 0-100 criticality score - confirmed against a live task, then fixed
    to join through the real `Asset.criticalityScore` via `assetId`. (2) The
    conflict-count KPI initially reported a real, checked zero as "not
    available", because `byPlan.optimized` is entirely ABSENT once T24/T25's
    hard constraints hold (D-046) rather than kept at `{total: 0}` - the
    exact "zero read as no data" failure class T21's `checkedAndClear`
    exists to prevent, reintroduced in a third layer. Fixed with a dedicated
    reader that treats report-absent as unavailable and key-absent as a real
    zero, pinned by three tests.
  - **Schedule stability, built for real:** a new `getSchedule`-by-id query
    (the list endpoint omits `blocks`), restricted to the most recent OTHER
    plan on the SAME horizon (comparing weekly against monthly placements
    would be a meaningless ratio). Verified live: two consecutive weekly
    regenerations with unchanged inputs measured **100%** - D-022's
    determinism made visible, not assumed.
  - **Tests:** optimizer 328 (+5, horizon label), frontend 85 (+11:
    `monthlyReservationRows`, all eleven real KPIs plus both relabelled and
    all three unavailable ones, both bugs above each pinned). Backend/data
    untouched - both pieces are real solver output already covered, or
    frontend display logic. Verified live end to end: Monthly toggle
    triggering a real 0.65s OPTIMAL 30-day solve and rendering the
    reservation grid; all 16 DRM KPI cards, before and after the
    conflict-count fix; schedule stability's 100% result.
  - **This closes the T-numbered backlog. T1-T28 are now all `done`.**
    Remaining: TX1-4 (cross-cutting - Docker Compose is still unverified end
    to end, D-005) and, per the standing plan noted since T20, authentication
    (the rest of T10/T11) now that every feature task is real.

## New scope beyond T1-T28 (owner-directed, not PRD-tiered)

- [x] `done` — **T29 Phase 1**: Task splitting across non-contiguous windows in the CP-SAT model, addressing the 53/89 "impossible for both engines" tasks on the Comparison view
      <br>_New scope, not a PRD-numbered task - added because 53 of 89 real tasks were structurally impossible (D-024) not because the solver was under-performing, on the theory that some of them may not actually need one continuous block. `optimizer/app/core/splitting.py`: a task's defect type (PRD 5.2's real vocabulary) decides splittability - 6 of 12 types are splittable (Engineering: track geometry defect, ballast deficiency, joint wear; S&T: cable fault; TRD: OHE snag, insulator damage), reasoned per type and **explicitly flagged as a documented judgement call, not a PRD fact**. Minimum segment floor: 30 min, reused from T3's own D-010 floor rather than invented. Real modelling change in `solve_schedule`: `covered`/`segment_minutes` per task, `assign` keeps its old boolean meaning everywhere unaffected by splitting (dependency, resource, batching, pins)._
      <br>_**Real corpus result, verified through the actual product (Node -> optimizer -> MongoDB), not just the solver in isolation:** of the 53 previously-impossible tasks, **29 are now placed**. `tasksScheduled` 35 -> **64**, `tasksDeferred` 54 -> **25**, `tasksSplit`: **29**, `crossDepartmentBatches` 2 -> **5**. GZB-SBB - this project's worst-case corridor (281 trains/day, one 54-minute window) - gets real coverage for the first time (a 185-min "ballast deficiency" task split across 4 days of that same 54-min window) with zero traffic block needed. A new, more precise deferral category appears: 3 tasks now have enough TOTAL capacity to split but lose a real, fair fight for space (`NO_CAPACITY`, previously impossible outright); 21 remain genuinely impossible even split (`EXCEEDS_TOTAL_CAPACITY_EVEN_SPLIT`, a new distinct reason from `EXCEEDS_LONGEST_WINDOW`)._
      <br>_**Two real costs found by testing at full strength, not hidden:** (1) the model is genuinely harder - the real solve no longer proves OPTIMAL within the existing 10s budget, settling for a reproducible **FEASIBLE** (~2% gap to the solver's own best bound); fixed the worst of an initial regression (indiscriminate candidate widening pushed this to non-reproducible even at 90s) by only widening a task's candidates when it actually needs to split (32 of 89, not all 50 splittable-by-type). (2) two previously-exact-equality safety/stability tests (D-028's priority-engine-doesn't-change-outcome finding, D-061's policy-slider-never-trades-coverage boundary) now hold only within a small (1-3 task), explained tolerance rather than as a mathematical certainty, because a time-boxed non-optimal search can land in different local optima - flagged explicitly in both tests' docstrings, not silently loosened._
      <br>_**A real bug found and fixed, caused by this same change:** T27's emergency re-optimization pinned only ONE segment of a split task (via a plain `{task_id: placement}` dict that silently kept the last one), leaving every other segment of a split task completely free for a commit-shaped re-solve to move or drop - a real risk since T27 writes to the database, unlike T20's sandboxed what-if. Fixed with `Pin.window_keys` (hold every segment of a split task simultaneously) and by grouping `current_placements` by task id instead of overwriting. Verified: the exact real-corpus emergency scenario this project already tests is byte-identical off the affected corridor again._
      <br>_**A methodology bug found in THIS session, not the product:** a live-HTTP spot check briefly reported 47 scheduled instead of 64, because the running `uvicorn` optimizer process was never restarted after three subsequent performance fixes landed in source - `pytest`/`python -c` always re-import fresh code and were never affected, but `curl`/Node calls against the already-running server were. Diagnosed by capturing and diffing the exact JSON payload Node sends against the test script's payload (byte-identical for all 89 tasks, confirming `defectType` is wired correctly end to end); a clean restart reproduced 64/25/29/5 three times over. See `docs/DECISIONS.md` D-083 for the full diagnostic and the generalisable lesson (a live server does not hot-reload Python; health-check-green is not proof it is running current code)._
      <br>_**Known limitation, explicitly not built:** the frontend does not yet render `splitTasks` or the decision log's new `isSplit`/`segments` fields visually - met at the data layer only (additive, backward-compatible, dedicated tests), real separate frontend work for a later session._
      <br>_9 new hand-built tests (basic split coverage, non-splittable regression guard, unset-defect-type default, adversarial floor enforcement, total-capacity structural defer, cross-department batching across a segment, dependency precedence across a full split prerequisite, resource no-overlap across segments, decision-log marking). Real-corpus tests updated with the new real numbers, reasoning inline. See `docs/DECISIONS.md` D-082, D-083._
      <br>_**Stopped here per the owner's explicit instruction.** Phases 2/3 (caution-order/alternate-route logic) not started - real numbers reported back first so Phase 2/3 can be a deliberate decision, not a default continuation._
- [x] `done` — **T29 Phase 2**: Caution-order-eligible work — investigated and stopped before writing any code, because the honest rule finds zero eligible tasks
      <br>_Regenerated the real 21-task genuinely-impossible pool live (not reused from D-084's session) - all 21 fall into exactly the six defect types `splitting.py` already excludes from splitting: relay fault (9), rail fracture (7), isolator fault (2), interlocking snag (1), feeder fault (1), point failure (1). Proposed a caution-order-eligibility rule as its OWN question, not a copy of splittability ("can a train share the section during the work" vs splitting's "can the work be left in a safe intermediate state") - reasoned per defect type: relay fault/interlocking snag fail on interlocking-integrity grounds (a caution order fixes speed risk, not "the signal may not reflect real track state"); point failure fails on mis-routing/derailment risk (a slow train through a broken point is still a wrong-track train); isolator/feeder fault fail on electrical-isolation grounds (orthogonal to train speed entirely); rail fracture fails not on principle - real IR practice does use interim caution orders and brief look-out-protected fishplating - but on fit: these 7 real tasks run 174-234 continuous minutes, full weld/clamp-out duration, not a between-trains quick patch, and a rail cannot be mid-cut while any train passes over it._
      <br>_**Net result: 0 of 21 tasks are caution-order-eligible.** Flagged back to the owner before writing any CP-SAT code, per the brief's own stop-gate - a 0-yield rule makes the entire proposed placement mechanism (new placement path, pin interaction rules, decision-log wording, a fourth Comparison category) unexercised code for zero benefit. Owner reviewed the reasoning, including the rail-fracture nuance specifically, and chose to accept the 0 finding over adding a duration-based sub-rule. No changes made to `scheduler.py`, `splitting.py`, the decision log, or the Comparison view - the 36/32/21 split from D-084 remains accurate. Phase 3 (alternate-route diversion) also not started - its premise (Phase 2 leaving a smaller residual pool) doesn't hold, since the pool is unchanged at 21. See `docs/DECISIONS.md` D-085._

## Cross-cutting (interleave as needed, not a strict phase)

- [x] `done` — **TX1**: Docker Compose wiring for full-stack demo run, scope-expanded to include path-scoped CI
      <br>_**Neither `docker` nor `docker-compose` was actually runnable on this dev machine** — the Docker daemon isn't running, starting it needs `sudo` this session doesn't have, and the invoking user isn't in the `docker` group. Rootless Podman 5.4.2 was already present and worked standalone (smoke-tested with `hello-world`); `podman-compose` (installed via `pip install --user`, fully reversible, no sudo) was used as a drop-in substitute to genuinely execute this verification rather than only reading the file. Flagged here rather than silently substituted: the compose YAML itself is unmodified engine-specific syntax, but this was NOT verified against real `docker compose` — worth a quick real-Docker confirmation before demo day if the demo machine has it working._
      <br>_**All four services build clean and reach `healthy` together** (`mongosh ping`, optimizer `/health`, and two new checks added below) in ~24s from a cold `up -d`. Confirmed via the same commands README documents: `/health/ready` (optimizer, solver available), `/api/health/dependencies` (backend, database connected + optimizer reachable), frontend serving 200._
      <br>_**Two real, pre-existing frontend bugs found by actually running the build** (neither Docker-specific — `npm run build` was already broken on `main`, `npm test`/`vitest` never type-checks so nothing had caught it): (1) `oversight.test.ts` accessed `.value` directly on the `Kpi` discriminated union in 9 places without narrowing — the file already had the correct `as { value: string }` cast pattern in 3 other places, just applied inconsistently; fixed all 9 to match. (2) `GanttTimeline.tsx`'s `HorizonToggle` defined an `Option` component INSIDE its own render function (`react-hooks/static-components` — resets state every render); hoisted `Option` → `HorizonOption` to module scope with `canSelect`/`onSelect` passed explicitly instead of closure-captured. Both fixes verified: `tsc -b` clean, `eslint .` clean, all 145 frontend tests still pass._
      <br>_**Real gap found: the demo flow (seed → login → generate) could not work in the container flow at all**, for a reason unrelated to automation policy — `backend`'s runtime image never gets `data/processed/*.json` (not copied at build time, and no volume declared), so `DATA_PROCESSED_DIR` (which resolves to `/data/processed` inside the container, `config/env.ts`) always pointed at nothing. Fixed with a read-only bind mount, `./data/processed:/data/processed:ro,Z` — the `:Z` SELinux relabel is required on this (Fedora, enforcing) host under Podman and is a no-op/portable under Docker on a non-SELinux host. **Decision: seeding stays manual**, not automatic on `up`, matching local dev's own `npm run seed` step exactly (D-019's replace-not-upsert semantics make re-seeding on every restart wasteful and surprising mid-demo). Documented as `docker compose exec backend node dist/scripts/seed.js` — not `npm run seed`, because the runtime image deliberately drops `tsx`/`src/` after `tsc` builds it (only `dist/` ships); this direct `node` invocation is the one that actually works in the built image._
      <br>_**Full demo flow verified for real, over the compose network, not simulated:** seeded 10,149 corridors / 89 tasks / 4 demo accounts in ~15s, logged in as `controller`, `POST /schedules/generate` returned a real solved plan (cross-department batch on BBPR-SYU visible in the raw response). The frontend's built JS bundle was independently checked to bake in the correct backend URL from `VITE_API_BASE_URL` (confirms the build-arg wiring, not just that a plausible-looking file exists)._
      <br>_**Backend and frontend had no healthcheck at all before this session** — only mongo/optimizer did, so `frontend: depends_on: - backend` only waited for the container to start, never for it to actually be ready. Added both, matching the existing pattern (mongo/optimizer's own `test:`/`interval`/`retries` shape) and switched `frontend`'s `depends_on` to `backend: condition: service_healthy`. **The frontend healthcheck as first written was itself wrong and caught only by testing it in isolation**: `wget http://localhost:80/` failed with ECONNREFUSED even though nginx was genuinely up, because this image's `nginx.conf` is customized so the base image's entrypoint skips its usual IPv6-listen patch (logged, not silent) — nginx binds only `0.0.0.0:80`, `localhost` resolves to `::1` first inside the container, and busybox `wget` (unlike Node/Python's HTTP clients, which fall back across address families) does not retry the other family. Fixed by hardcoding `127.0.0.1` in the healthcheck command; verified passing standalone before trusting it in the full stack._
      <br>_**Scope expanded to add CI, since it touches the same build/test surface** (owner-directed this session, not a unilateral tier jump — flagged per CLAUDE.md before proceeding). Four independent path-scoped workflows under `.github/workflows/` (`backend.yml`, `optimizer.yml`, `frontend.yml`, `data.yml`), each triggered only by `paths:` on its own folder — confirmed with `git remote -v` that `origin` is a real GitHub remote (`github.com/aroy2o/railway`), so these will actually run once pushed, not just sit inert. `backend.yml` provisions a real `mongo:8` GitHub Actions service container (not skipped) so the tests that self-skip locally without Mongo (`api.test.ts`, `auth.test.ts`, `approvals.test.ts`, `overrides.test.ts`, `schedules.test.ts`) genuinely run in CI. `optimizer.yml` runs `pytest -m "not live"` with **no backend/Mongo provisioned** — deliberately flagged, not silently decided: the real-corpus tests (`test_optimizer_api_real_data.py`, `test_scheduler_real_data.py`) already catch `BackendUnavailable` and `pytest.skip()` cleanly, so they skip rather than fail; running them for real would need backend+Mongo+the data pipeline's output present in CI too, more infrastructure than this hackathon CI needs (see `docs/DECISIONS.md` D-087). `frontend.yml` runs `npm ci && npm run build && npm run lint && npx vitest run` — the exact commands whose bugs this session just found and fixed. `data.yml` runs the real `python -m pytest` (105 tests) documented in `data/README.md`; it deliberately does NOT run `ingestion.download` (fetches ~98MB from external hosts on every `data/**` change), since every corpus-dependent test already self-skips via the same `skipif`-on-file-existence pattern the other two suites use — verified this pattern holds across all four `data/tests/*.py` files before relying on it._
      <br>_All four workflow files verified with `actionlint` (downloaded the v1.7.12 release binary fresh, none was installed) — zero findings across all four._
- [x] `done` — **TX2**: `docs/DECISIONS.md` — architecture decision log (created on first use per `LOOP_PROMPT.md`)
      <br>_Created with D-001 (TS frontend / JS backend), D-002 (single repo-root `.env`), D-003 (Redux Toolkit + RTK Query, server-vs-client state split), D-004 (fail-fast config, one error envelope), D-005 (local-first dev, Compose for demo). Append to it as decisions are made, not after._
- [x] `done` — **TX3**: Seed script to reset demo data to a known-good state before the actual pitch
      <br>_`npm run demo:reset` (`backend/src/scripts/demoReset.ts`) — reuses `seed.ts`'s `seed()`/`seedUsers()` unchanged, then explicitly empties `schedules`/`schedule_overrides`/`schedule_approvals`, the three collections `npm run seed` intentionally skips. Verified live: wiped 130/5/15 accumulated documents down to zero, idempotent on a second run, all four demo logins return 200, `GET /api/schedules` confirms an empty history. See `docs/DECISIONS.md` D-074._
- [x] `done` — **TX4**: Final pitch-deck numbers pulled from a real run, not placeholders
      <br>_`PITCH_NUMBERS.md` — every figure sourced from one live `POST /api/schedules/generate` call today (schedule `SCH-20260826121521565`), immediately after a real `npm run demo:reset`, not hand-assembled from memory or old session logs. The 36/32/21 structural breakdown (D-084), the baseline-vs-optimizer table with the utilisation-reads-backwards caveat quoted verbatim from the product's own `caveats[]` array, solve status (**FEASIBLE**, ~2% gap to proven bound per D-082) and time (10.005s against the 10s budget), and the D-086 batching-ceiling finding (5 = proven OPTIMAL, not observed) are all in one document, each annotated with its exact source field or decision entry._
      <br>_**Reproducibility verified live, not assumed from D-082's older claim:** generated the schedule twice in a row against the same reset database — `objectiveValue`, `metrics`, `comparisonToBaseline`, and every block were byte-identical across both runs._
      <br>_**One real drift found and flagged, per this task's own instruction to cross-check against source decisions:** `TASKS.md`'s own T25 entry states 45.42% utilisation; today's live figure is 59.92%. Not a bug — T29 Phase 1 (built after T25) legitimately changed how many tasks get scheduled. `PITCH_NUMBERS.md` says explicitly which figure to use and why the old one is stale._
      <br>_All four test layers re-run fresh today, not recalled from the last session: backend 135, optimizer 343 (+9 deselected `live` tests, by design), frontend 145 (+clean `tsc -b`/`eslint`), data 105 - 728 passing, 0 failing._
      <br>_**CI status reported honestly as not-yet-applicable**: TX1's four workflows are `actionlint`-clean but still uncommitted (`.github/` untracked), so `gh run list` is empty - nothing has run yet. `PITCH_NUMBERS.md` says so explicitly rather than claiming a green CI badge that doesn't exist yet._
      <br>_**TX7 re-confirmed accurate, not re-investigated**: `overrideEngine.ts` still has no optimistic-concurrency mechanism, exactly as documented - checked per this task's explicit instruction to confirm rather than assume, not touched._
      <br>_Demo database reset back to clean (zero schedule history) after the two verification generations, per this project's own reset-before-handoff discipline._
- [x] `done` — **TX5**: PRD Section 8 screen 7 — Task/Block Detail Drill-down
      <br>_Found untracked in the 2026-08-25 audit session, built the same day. `BlockDetailPanel.tsx`, opened by clicking any Gantt block — always, not just when overridable, which fixed a real usability gap: published plans and every DRM session (permanently read-only) previously had NO way to click a block at all. Shows department mix, a templated plain-English reasoning sentence (from the decision log's `contributingFactors`, not a fresh LLM call), asset criticality, predicted risk (PRD 9.1 framing intact), resolved resource assignment, and the full transitive dependency chain. Overriding moved to a button inside the drill-down, gated on workflow state, rather than being the block's own click target. A live-verification pass caught a real bug before it shipped — the dependency chain showed each prerequisite's raw `Task.status`, which reads `'pending'` for every task in the corpus regardless of real scheduling (seed-time only, never updated), producing a contradictory-looking "pending ... has its own block in this plan." Fixed by dropping the field and reporting only the real, current `scheduledInThisPlan` signal. Verified live end to end (Playwright): a shared block's full breakdown, the override handoff, a real 3-stage dependency chain, and a published plan's read-only-but-clickable behaviour. Frontend suite 128/128 (+14). See `docs/DECISIONS.md` D-080._
- [x] `done` — **TX6**: PRD Section 8 screen 6 — DRM oversight monthly trends + exportable report
      <br>_Found untracked in the 2026-08-25 audit session, built the same day. KPI hierarchy rollups were already done (T28) — confirmed before treating this as new work. Trend history: four real `ScheduleMetrics` fields (block utilisation, batching ratio, tasks scheduled, unused block hours) plotted per real plan generation on the current horizon type, hand-rolled SVG (`TrendChart.tsx`, first `<svg>` in this codebase, no new dependency). **Honesty tradeoff flagged rather than silently resolved:** PRD says "monthly" trend charts, but this prototype's real operating history never spans a month — the section plots exactly the real history that exists (oldest first), refuses to draw a line from fewer than 3 real points, and its own subtitle says plainly it is not monthly. Exportable report: a CSV download (no PDF library existed anywhere in the project, checked first) built from the exact same KPI data already rendered on screen, so the file can never drift from what's displayed. Verified live end to end: the honest "not enough history" state with 2 real generations, the real chart with 3, and an actual browser download event captured and read back — every value matches the screen. Frontend suite 142/142 (+14). See `docs/DECISIONS.md` D-081._
- [ ] `todo` — **TX7** (risk, not yet fixed): concurrent overrides on the same task race, and the loser is told it won
      <br>_Found by the 2026-08-25 audit session's adversarial state-machine testing (real HTTP, not read from code). Two `POST /override` requests for the same `taskId` fired ~3ms apart both return `201` with a fully-passed re-validation - neither knows about the other, since re-validation checks the plan as of when each request's window was fetched, not "has this task moved since." The audit trail is honest (both events appear, in order, per D-034), but the effective plan applies only the later-timestamped one - so the earlier caller receives a "success" response, watches all 6 constraint checks pass, and sees the exact confirmation UI a real success gets, for a change that silently does not survive. No data corruption results (the losing window is simply left unused, nothing double-books), so this reads as a **Risk** rather than a **Bug**: low-probability in a solo-demo context where one person drives the UI, but a real gap against FR6.2's "every override is logged" promise, since "logged" currently doesn't mean "the actor is told when their logged override didn't take effect." A real fix needs optimistic concurrency (the client passes the placement it saw when the override panel opened; the server refuses with a clear conflict if the task has moved since) - both backend (`overrideEngine.ts` re-validation) and frontend (`OverridePanel.tsx` would need to surface the new refusal reason) change, which is why this was reported rather than fixed in-session. The same mechanism underlies "apply this what-if option" (D-065 reuses the override endpoint unchanged), so it is not a separate risk to track._

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

- **2026-08-26** — TX4 complete: `PITCH_NUMBERS.md` compiled from one real
  `demo:reset` → `generate` run today (verified reproducible with a second
  live run, byte-identical), not from memory or old session logs. Every
  figure traces to a live response field or a specific `docs/DECISIONS.md`
  entry (D-082/D-084/D-086). Found and flagged one real drift (T25's
  45.42% utilisation is stale; live figure is 59.92%, T29 Phase 1 changed
  it). All four test suites re-run fresh: 728 passing, 0 failing. CI
  reported honestly as not-yet-run (workflows uncommitted). TX7 confirmed
  still accurate, not touched. Demo DB left clean. **This closes the
  T/TX-numbered board except TX7**, deliberately left as a documented,
  unfixed risk per its own entry.
- **2026-08-26** — TX1 complete, scope-expanded to include path-scoped CI
  (owner-directed). Docker daemon unreachable in this environment (no sudo);
  verified genuinely end-to-end via rootless Podman instead, flagged as a
  substitution rather than silently swapped. Found and fixed two pre-existing
  frontend bugs (`oversight.test.ts` type narrowing, a `GanttTimeline.tsx`
  React anti-pattern) neither of which is Docker-specific — `npm run build`
  was already broken on `main`. Found and fixed a real container-packaging
  gap: the backend image never got `data/processed/*.json`, so seeding could
  not work at all regardless of automation policy; fixed with a read-only
  SELinux-labelled bind mount, seeding kept manual to match local dev. Full
  demo flow (seed → login → generate) verified for real over the compose
  network. Added missing backend/frontend healthchecks; the frontend one as
  first written was itself broken (IPv6/wget) and caught only by testing it
  standalone before trusting it. Four `actionlint`-clean workflows added
  under `.github/workflows/`. See `docs/DECISIONS.md` D-087. Next: **TX4**
  (final pitch-deck numbers) or **TX7** (the concurrent-override race).
- **2026-08-26** — Batching-headroom investigation (owner-directed, before
  TX4): asked whether the default `weights.batching` (3,000,
  `crossDepartmentBatches: 5` on the real corpus) is near-optimal or leaving
  real headroom within D-061's verified-safe `[0.1x, 10x]` range. A
  standalone CP-SAT model that keeps every real hard constraint
  (splitting's segment/covered machinery, dependency precedence, resource
  no-overlap, window capacity) but maximizes only "count of window
  instances with 2+ departments" gives a policy-weight-independent ceiling
  - first attempt (whole-task only) wrongly returned 2, contradicted by the
  real corpus's own achieved 5, because a single split task spans several
  window instances and each is a fresh batching chance; corrected version
  (splitting-aware) solves to OPTIMAL at exactly **5**. A real sweep of
  `weights.batching` across the full safe range (1x/3x/5x/7.5x/10x),
  holding every other weight at default, stays flat at 5 the entire way -
  empirically confirming the combinatorial ceiling, not just asserting it.
  **Conclusion: 5 is the true ceiling, not an estimate near it - no
  headroom exists at any safe weight, no default change recommended.**
  Read-only investigation: no production code touched, no weights outside
  the safe range ever run against the product. See `docs/DECISIONS.md`
  D-086.
- **2026-08-26** — T29 Phase 2 (caution-order-eligible work): investigated
  and stopped before writing any code. Regenerated the real 21-task
  genuinely-impossible pool live; proposed an eligibility rule as its own
  question, not a copy of splittability, and applied it per defect type
  (interlocking-integrity, mis-routing risk, electrical isolation, and a
  duration-fit argument for rail fracture specifically). Net result: 0 of 21
  tasks qualify. Flagged to the owner before the rule became load-bearing,
  per the brief's own stop-gate; owner accepted the 0-yield finding rather
  than add a duration sub-rule. No production code touched - the D-084
  36/32/21 split stands unchanged. Phase 3 also not started, since its own
  premise (a smaller residual pool) doesn't hold. See `docs/DECISIONS.md`
  D-085.
- **2026-08-25** — Comparison-view fix session (owner-directed follow-up to
  T29 Phase 1, before TX4): the Comparison view was showing
  `tasksScheduled: 64` next to `structurallyImpossibleCount: 53` - a
  visibly contradictory response, since `structurallyImpossibleCount` was
  still computed as `89 - contestableTaskCount`, silently counting every
  split-only-placeable task as "impossible for both engines." Fixed with a
  genuine third category rather than a folded-in patch: a new
  `classify_structural_feasibility()` (the single source of truth,
  refactored into both `solve_schedule`'s own pre-check and a new
  `split_only_contestable()` reporting function, so the two can never
  disagree again) splits the old binary into contestable (36, unchanged -
  fits one window, the baseline's real ceiling), split-only (32 - fits no
  single window but placeable by the optimizer via splitting, structurally
  unreachable for the baseline at any horizon), and genuinely impossible
  (21, corrected from 53). A second real bug found in the same audit: the
  baseline's own deferral message claimed "impossible for any algorithm"
  even for split-only tasks the optimizer can place - fixed to say "this
  non-splitting process cannot" instead. Propagated additively through
  every layer (optimizer response, Node's `buildComparison`, `/explain`
  grounding, and a new frontend headline row + three-way scope band) and
  verified live end to end through a real Chromium session against a
  freshly generated schedule - not just at the API layer. Caught and fixed
  the exact D-083 stale-process mistake once more mid-session (recognised
  immediately this time, not re-diagnosed from scratch). See
  `docs/DECISIONS.md` D-084.
- **2026-08-25** — T29 Phase 1 complete: task splitting across
  non-contiguous windows in the CP-SAT model, new scope beyond T1-T28
  addressing the 53/89 structurally-impossible tasks on the Comparison
  view. Splittability keyed on defect type, a documented judgement call
  flagged back explicitly rather than presented as derived; 30-min minimum
  segment floor reused from T3's own D-010 floor. Real corpus: 29 of the 53
  previously-impossible tasks now placed (`tasksScheduled` 35 -> 64,
  `tasksSplit`: 29), including GZB-SBB - this project's worst-case
  corridor - getting real coverage for the first time via a task split
  across 4 days of its one 54-minute window. Two real costs surfaced by
  testing at full strength rather than a small sample: the solve no longer
  proves OPTIMAL within the 10s budget (fixed the worst of an initial
  regression, then accepted and reported the remaining FEASIBLE result
  honestly, matching T20's own precedent), and two previously-exact
  safety/stability guarantees (D-028, D-061) now hold only within a small,
  explained tolerance. A real bug this same change caused was found and
  fixed: T27's emergency re-optimization was silently pinning only one
  segment of a split task, a real risk since T27 commits to the database.
  9 new hand-built tests plus updated real-corpus regression tests. See
  `docs/DECISIONS.md` D-082. Stopped after this phase per the owner's own
  instruction - Phase 2/3 (caution-order/alternate-route logic) not
  started, real numbers reported back first.
- **2026-08-25** — T29 diagnostic session (owner-directed, follow-up to T29
  Phase 1): a live-HTTP spot check briefly showed 47 tasks scheduled instead
  of the real 64, which mattered enough to chase down before any Phase 2/3
  decision or TX4 pitch numbers. Root cause verified, not guessed: captured
  and diffed the exact JSON payload Node's real orchestration sends against
  the test script's payload - byte-identical for all 89 tasks (confirming
  `defectType` is wired correctly end to end, no wire-contract bug) - which
  meant the discrepancy had to be a stale process, not a payload issue. The
  live `uvicorn` optimizer had been restarted once early in the Phase 1
  session but never again after three subsequent performance fixes landed
  in source, so it silently kept serving the older, unoptimized model to
  every `curl`/Node call for the rest of that session while `pytest`/
  `python -c` (which always re-import fresh) correctly reflected every fix.
  A clean restart reproduced the real number three times over: **64
  scheduled / 25 deferred / 29 split / 5 cross-department batches**,
  matching direct `solve_schedule()` exactly. No model or product code
  changed this session - diagnosis only, per the owner's explicit
  guardrail. See `docs/DECISIONS.md` D-083 for the full trace and the
  generalisable lesson about live-server hot-reload assumptions.
- **2026-08-25** — Authentication session: T10/T11's remainder, the last gap
  before the whole board was `done`. FR10.1's three named roles (Dept
  Engineer / Controller / DRM) plus `super_admin`, a demo/dev-convenience
  bypass role explicitly beyond PRD scope, flagged as such and never to be
  presented as a PRD feature in the pitch deck. Backend: `User` model, JWT
  (`jsonwebtoken`) + bcrypt (`bcryptjs`), `requireAuth`/`requireRole`
  middleware with one explicit `super_admin` bypass check, every route in
  `corridors/assets/tasks/resources/provenance/schedules` audited and gated
  by hand rather than guessed (write routes to the specific role that owns
  the action, reads broadened where the PRD never actually role-scoped them
  — flagged, not assumed), and the net-new `POST /api/tasks` (FR1.1's
  request-submission write path, the one piece of T10 that had never been
  built at all). Four fixed demo accounts seeded by `npm run seed`,
  credentials in `DEMO_ACCOUNTS.md` at the repo root. Frontend: login screen
  with no manual role selector (the role comes from which real account logs
  in), `RequireRole` route guards, role-scoped nav, and the net-new Dept
  Engineer Portal (`/engineer`) with a cascading corridor→asset→resource
  submission form, "my submitted requests," and a read-only published-plan
  view. One real design decision made where the PRD was silent: DRM's access
  to Approval & Audit was never specified — asked the owner directly rather
  than guessing, resolved to read-only. One real bug found only by driving
  all four accounts through a real browser in sequence: a `location.state`
  "return to where you were" feature on the login page could send a
  freshly-logged-in user to a STALE previous session's page across a full
  page reload — removed rather than patched, since it was unrequested polish
  in the first place. 154 backend / 111 frontend tests, all green; 20/20
  checks verified live against a real headless Chromium (all four roles,
  cross-role redirect enforcement, the DRM read-only audit view, logout, the
  super_admin bypass, and the full engineer submission flow end to end),
  zero console errors. See docs/DECISIONS.md D-073. **This closes T10/T11 —
  every task on the board (T1–T28, T10/T11's auth remainder) is now `done`.**
  What remains is TX1, TX3, TX4 (Docker Compose verification, demo reset
  script, final pitch-deck numbers) — cross-cutting demo prep, not features.

- **2026-08-25** — Guided-walkthrough session (not T-numbered): a first-time
  guided tour plus a persistent "Replay walkthrough" control in
  `AppHeader.tsx`. Started scoped to the Controller Dashboard only (per the
  prompt's own audit-first discipline); widened mid-session to every route
  at the owner's explicit request. Audited every page and panel before
  writing a step (same discipline as a T-numbered task), then built one
  generic mechanism - `lib/tour.ts` (first-visit localStorage persistence +
  hand-built spotlight/tooltip geometry), `store/slices/tourSlice.ts`
  (cross-cutting client state, since the header button and whichever page
  owns the tour are siblings under `<App>`, not parent/child),
  `TourOverlay.tsx`, and `lib/useAutoTour.ts` (extracted once the same
  auto-start effect was about to be pasted into nine page components) - and
  nine step-array files, one per route, each reusing that page's OWN
  existing explanatory text (`RISK_FRAMING`, the weather panel's `FRAMING`,
  D-061's policy-slider caption, D-031's comparison rules, D-046's
  oversight `CATEGORY_NOTE`s) rather than restating features in new words.
  Decided hand-built over a library (`react-joyride`/`driver.js` considered,
  `registry.npmjs.org` confirmed reachable) since the actual requirement -
  highlight one element, positioned tooltip, next/back/skip - is plain rect
  arithmetic with no CSS-reconciliation cost against this project's
  library-free Tailwind UI. Verified live end to end: fresh localStorage
  auto-starts the Dashboard tour and does not re-trigger after completion;
  every one of the other eight routes auto-starts its OWN tour on its OWN
  first visit, independently, proven without ever re-clearing storage
  between them; Replay restarts whichever page is currently open without
  navigating away; zero console errors across the full run; a real
  bounding-box comparison confirmed the spotlight ring aligns to sub-pixel
  precision with the actual highlighted element on both a dense page
  (Dashboard) and a plain table (Corridors). Two bugs were found in the
  verification SCRIPT itself (wrong step index, a smart-quote mismatch),
  not the app - both traced and confirmed before being ruled out.
  Coverage: Controller Dashboard, Comparison, Approvals & audit, DRM
  oversight, and all five read-only reference pages - every route now has
  a walkthrough. Frontend tests: 105 (up from 85; 21 new, covering
  `lib/tour.ts`'s persistence and geometry and `tourSlice`'s reducer logic
  - step content and rendering verified live, matching this project's
  standing frontend-coverage practice). Noted, not fixed (pre-existing,
  unrelated to this session): `oversight.test.ts` has a real type-checking
  gap (`Kpi` union narrowing) that predates this session and was confirmed
  present before any of today's changes. See docs/DECISIONS.md D-072.

- **2026-08-25** — TX5 + TX6 complete (not T-numbered): both PRD Section 8
  gaps the prior audit session found untracked, built in one follow-up
  session as two independent pieces of work per the owner's own framing.
  **TX5, Task/Block Detail Drill-down:** clicking a Gantt block now always
  opens a read-only panel (department mix, templated plain-English
  reasoning from the decision log, asset criticality, predicted risk,
  resolved resource assignment, full dependency chain) - always, not only
  when overridable, which fixed a real usability gap along the way: a
  published plan's blocks, and every block a DRM ever looks at, were
  previously unclickable outright. Overriding moved to a button inside the
  drill-down. Live verification caught a real bug before it shipped - the
  dependency chain's first version showed each prerequisite's raw
  `Task.status`, which reads `'pending'` for every task in the corpus
  regardless of real scheduling (seed-time only, confirmed against the
  live database), producing a contradictory-looking "pending ... has its
  own block in this plan"; fixed by reporting only the real
  `scheduledInThisPlan` signal, with a regression test. **TX6, DRM
  oversight:** a trend section (four real `ScheduleMetrics` fields, hand-
  rolled SVG, no new dependency) and a CSV "Download report" button (no PDF
  library existed anywhere in the project, checked first; built from the
  exact KPI data already on screen, so it cannot drift from it). Flagged
  the honesty tradeoff explicitly rather than resolving it silently: PRD
  says "monthly" trend charts, but a hackathon prototype's real history
  never spans a month, so the section plots exactly the real generations
  that exist and refuses to draw a line from fewer than three real points -
  stated as such in its own subtitle. Both parts verified live end to end
  (Playwright against the real running stack): the full drill-down
  including the override handoff and a real 3-stage dependency chain, a
  published plan's read-only-but-clickable behaviour, the trend section's
  honest "not enough history" state, the real chart once three generations
  existed, and an actual captured browser download read back byte-for-byte
  against the on-screen KPIs. Frontend suite: 142/142 (was 114 before the
  audit session; +28 across both sessions). No git commit made - owner's
  explicit no-commit-without-confirmation standing continues. See
  `docs/DECISIONS.md` D-080, D-081.

- **2026-08-25** — Full audit session (not T-numbered): systematic pass for
  bugs/gaps/honesty regressions before TX1/TX3/TX4 close the project out, per
  the seven-area brief (time handling, role-gating, state-machine edge cases,
  honesty framing, empty/error states, PRD Section 8 scope, test-suite
  honesty). Everything verified live (Playwright over the real dev stack,
  real HTTP for backend adversarial tests) rather than from a code read.
  **Five real bugs found and fixed, each with a `docs/DECISIONS.md` entry
  (D-075–D-079):** the Gantt's day-tab defaulted to the first
  cross-department-batch day instead of today when today was inside the
  horizon (D-075); "Generate schedule" pinned `horizonStart` to a hardcoded
  literal date instead of the real clock, already one day stale at audit
  time (D-076); the Audit Trail page's empty state was unreachable dead
  code — `QueryState` showed a raw 404 plus a developer debugging hint
  ("has `npm run seed` been run?") to anyone opening it before the first
  schedule existed (D-077); the CP-SAT scheduler's own module docstring
  called five PRD 13.1 terms "deferred" to tasks that have all been `done`
  for days (D-078); and a terminal-state refusal built past tense as
  `${action}d`, which only works for "approve" — "submitd"/"rejectd"/
  "publishd" all shipped as typos until an adversarial state-machine test
  found them (D-079, with a new regression test tightened to catch the
  exact gap the old test's loose assertion missed).
  **Two known findings from the session brief, both resolved:** the Gantt
  bug above was real and is now D-075; the override-visibility chain
  (Gantt block, Override History panel, Audit Trail) was tested with a real
  end-to-end override and found already correct on all three surfaces — no
  fix needed.
  **Two PRD-scoped gaps found, tracked rather than left silent:** Section
  8's Task/Block Detail Drill-down screen (TX5) and DRM oversight's monthly
  trend charts + exportable report (TX6) were never built and never
  mentioned anywhere in this file or the decision log before today — both
  larger than an in-session fix.
  **One risk found and documented, not fixed (TX7):** two concurrent
  overrides on the same task both return a fully-passed `201`, but only the
  later one survives in the effective plan — the earlier caller is told
  "success" for a change that silently doesn't take effect. No data
  corruption (nothing double-books), so a Risk rather than a Bug; the real
  fix needs optimistic concurrency across two layers, out of scope for this
  session.
  **Everything else checked came back clean:** the 502-from-optimizer path
  (D-004) works exactly as documented; role-gating showed no drift since
  the auth session (`requireAuth` still mounted once per resource router,
  no route added since without it); the approval state machine correctly
  refused every out-of-order transition and every action on a published
  plan tried during adversarial testing; empty states on Comparison,
  Oversight, and the Dept Engineer Portal were already correct; the
  Baseline-vs-AI and DRM Oversight screens both still hold up exactly as
  D-031/D-042/D-068 documented, verified against a fresh real run.
  Backend suite: 135/135 (+1 for the grammar regression). Frontend suite:
  114/114 (+3 for the Gantt fix's `defaultSelectedDay`). No git commit made
  — owner's explicit no-commit-without-confirmation standing for this
  session.

- **2026-08-25** — TX3 complete (demo reset script, cross-cutting, not
  T-numbered): `npm run demo:reset` (`backend/src/scripts/demoReset.ts`).
  Reuses `seed.ts`'s `seed()`/`seedUsers()` unchanged — `npm run seed` still
  behaves exactly as before, per the task's own guardrail — then explicitly
  empties `schedules`/`schedule_overrides`/`schedule_approvals`, the three
  collections the pipeline seed intentionally never touches. The candidate
  collection list was verified rather than trusted: cross-checked against the
  model registry (ten models, ten collections) and a live
  `db.getCollectionNames()` on the dev database, which turned up nothing
  beyond those ten — no separate decision-log or cached-comparison collection
  exists. Verified live end to end against the real dev database: wiped 130
  accumulated `schedules` / 5 `schedule_overrides` / 15 `schedule_approvals`
  down to zero, a second consecutive run reported `0 -> 0` across all three
  (idempotent), all four demo logins returned HTTP 200, and a real
  `GET /api/schedules` call with a controller token confirmed
  `{"total":0}`. See docs/DECISIONS.md D-074. Remaining cross-cutting work:
  TX1 (Docker Compose verification) and TX4 (final pitch-deck numbers).

- **2026-08-24** — Audit-and-fix session (not T-numbered): the
  "checked-and-zero vs never-computed" bug pattern that D-046 (T25) and
  D-070 (T28) each independently found and patched two/three layers away
  from its source. Grepped and classified every read site of `knownGaps`,
  `conflictReport`, `byPlan` across all three layers before touching
  anything (14 sites total). Found exactly one root cause -
  `optimizer/app/core/conflicts.py::summarise()`'s `byPlan` dict only ever
  gets a key for a plan it saw a live conflict for, so a real, checked zero
  (the normal case since T24/T25) is indistinguishable from "never
  computed" - and one more instance of the SAME bug hiding in a "shared
  helper" that was never actually shared: `frontend/src/lib/conflicts.ts`'s
  `planTotal`, unused in production, whose own unit test pinned the buggy
  behaviour as intended. Fixed both at the source: `summarise()` gained
  `known_plans` so the router can say which plan a report is FOR;
  `planTotal` now correctly returns null only when there is no report at
  all. `oversight.ts` routed through the fixed helper instead of
  duplicating the fix inline (T28's version stays correct, now for the
  right reason). Searched specifically for the same bug shape outside the
  conflict/gaps system - none found; every other dict built the same way in
  this codebase is consumed as an internal index, never as a presence
  signal, and T12's `summariseDays` already applies the correct opposite
  pattern. Verified against the live optimizer + backend + Mongo, not just
  unit tests: restarted the optimizer to pick up the fix and regenerated
  the real 89-task corpus schedule through the full HTTP loop, confirming
  `conflictReport.byPlan` now reads `{ optimized: { total: 0, byType: {} } }`
  rather than `{}`. 331 optimizer / 114 backend / 85 frontend tests, all
  green. See `docs/DECISIONS.md` D-071. Next: TX1-4 or authentication, per
  the standing plan - unchanged by this session.

- **2026-08-24** — T28 complete. Monthly planning polish + DRM oversight KPI
  hierarchy (PRD Section 14) - **the T-numbered backlog is now closed, T1-T28
  all `done`.** Monthly is built as the SAME real CP-SAT solve run at a
  longer horizon and displayed at corridor-day resolution, not PRD 13's
  literal two-stage reserve-then-refine model - a deliberate, flagged scope
  call, made only after confirming on the real corpus that a 30-day solve
  genuinely surfaces 6 blocks a weekly-only view would never show, not just
  a relabelled weekly plan. The Weekly/Monthly toggle (disabled since T12's
  D-040) now triggers a real re-solve, never a cached view switch. The DRM
  oversight page audits all 16 PRD Section 14 KPIs against what this data
  model actually supports: 11 real, 2 honestly relabelled from "completed"
  to "scheduled" (this prototype has no execution tracking), 3 marked
  unavailable with the specific reason (no before/after risk model, no
  runtime asset-state model). Two real bugs caught before shipping by
  checking actual API responses rather than assuming shapes: a criticality
  threshold that was reading a normalised 0-1 weight instead of the real
  0-100 score, and a conflict-count KPI that reported a real, checked zero
  as "not available" because T25/D-046's `byPlan` key-dropping behaviour
  reappeared in a third layer. 328 optimizer / 114 backend / 85 frontend /
  105 data tests, all four layers green as a whole-system check. See
  docs/DECISIONS.md D-070. Next: TX1-4 (Docker Compose still unverified end
  to end, D-005) or authentication (T10/T11's remainder), per the standing
  plan.

- **2026-08-24** — T27 complete. Emergency rolling re-optimization (PRD
  FR3.5, 9.10), the last 🟡 task with real solver work. PRD 9.10's own text
  settled two things about scope and commitment (narrowed to one corridor,
  and unlike T20's what-if it COMMITS) but left "what does emergency mean"
  open - audited before assuming "T20 but committing": the more T20-like
  reading (force an existing deferred task in now) was tried first and
  reproduced D-024's already-known ceiling with nothing new to show; the
  reading actually built - an unplanned event consumes part of the
  corridor's remaining calendar - was checked the same way and found a real,
  positive result on the real corpus (TSK-00076 displaced 8/27→8/28,
  cascading TSK-00077 to 8/29, everything else byte-identical). Reused T20's
  `Pin` (generalised from one task to a list) plus a genuinely new
  `blocked_window_keys` primitive, and the audit itself surfaced two real
  bugs before they could ship: a pin/block ordering conflict, and a
  NO_CAPACITY message that would have misreported a task with zero
  remaining windows as having lost a priority contest it never got to enter
  (fixed with a new `WINDOW_UNAVAILABLE` code). A new commit path was built
  only after confirming T15's override genuinely can't express a multi-task
  reshuffle; `currentPlacements` reads the EFFECTIVE plan, not a fresh
  re-solve, so a manual override never gets silently discarded by an
  emergency. Live browser verification caught and fixed a real frontend bug
  (a stale "before" snapshot that made every block read as "unchanged"),
  independently confirmed via direct `curl` ground-truth comparison. 323
  optimizer / 120 backend tests, all green. See docs/DECISIONS.md D-069.
  Next: **T28** (monthly polish + DRM oversight view), the last task on the
  board, or TX1-4 (cross-cutting / demo prep - Docker Compose is still
  unverified end to end, flagged since T1/D-005).

- **2026-08-24** — T26 complete. Weather/monsoon risk flagging (PRD 9.9),
  built only after auditing whether real data even applies to this corpus -
  it does, but narrowly: real, section-specific flood data (Konkan Railway's
  own named vulnerable locations) touches zero of the 26 real corridors this
  project uses, while real Ministry of Jal Shakti state-level flood-risk
  data usably flags exactly 2 of 26 (DGU-PNB/Assam, HGJ-SUNM/Uttar Pradesh) -
  the rest genuinely lack station-state metadata, a real gap in the
  underlying data, not something to paper over. Built honest and narrow
  rather than skipped or faked wider: three-way real classification
  (flagged / checked-clear / genuinely unknown), architecture following
  D-009's separate-stage reasoning exactly, and reporting-only (never wired
  into the CP-SAT objective) - the same call T22 made for train-impact,
  proven this time by a mutation test showing the identical plan comes out
  whether the flag is set or not. Real corpus result: 7 live blocks, and the
  project's own reference date genuinely falls inside India's real monsoon
  season, so this isn't a hypothetical that only fires on a contrived date.
  105 data / 308 optimizer / 108 backend / 71 frontend tests, verified live
  end to end. Next: **T27** (emergency rolling re-optimization) or **T28**
  (monthly polish), the last two 🟡 stretch tasks.

- **2026-08-24** — T25 complete. Resource no-overlap (PRD 9.8) is now a hard
  CP-SAT constraint, same discipline as T24: audited the real corpus first
  (3 of 10 conflicts traced to a single per-depot permission every
  same-department task shares by construction) and measured, rather than
  guessed, whether uniform enforcement would over-restrict the plan - it
  barely mattered (32 vs 33 blocks, identical scheduled set), because
  crew/machine scarcity was already the binding constraint. Unlike T24, this
  cost zero coverage - the scheduled set is unchanged, only packing shifted
  (utilisation 48.53%→45.42%). The baseline finding this time is sharper:
  27 real resource conflicts in FR9.1's own output (vs T24's single
  dependency one), reusing the same detector with no new baseline code.
  Found and fixed two real bugs along the way, both only reachable once
  "zero conflicts" became a genuine outcome rather than a hypothetical one:
  Mongoose's `minimize: true` was silently dropping the now-possible empty
  `conflictReport.byPlan` before it reached MongoDB (fixed at the schema),
  and `KnownLimitations.tsx` was about to show a permanently-false "not
  enforced" label on every future schedule (fixed by keying off whether a
  typed report exists, not whether it happens to be empty). 299 optimizer /
  107 backend / 71 frontend tests, verified live end to end. **T24 and T25
  are both done**, so PRD 9.5's taxonomy now has ZERO live-conflict-reporting
  gaps left on the optimized plan; everything it names is either enforced
  (dependency, resource) or checked-and-clear (train impact) - none remain
  genuinely undetectable. Next: **T26** (weather/monsoon risk flagging) or
  **T27/T28**, the remaining 🟡 stretch tasks, or - per the standing plan -
  auth once every T-numbered task is verified complete.

- **2026-08-24** — T24 complete, first of the 🟡 stretch tier. Task
  dependency precedence (PRD 9.7) is now a hard CP-SAT constraint, semantics
  matched exactly to the "completes before starts" wording T6's own violation
  detector had already been using since T21 - a same-day case sequences
  correctly rather than being pushed to a wasted extra day by a coarser rule.
  Audited before writing the constraint: the real corpus was ALREADY
  violating this rule 5 times, including two workflow stages scheduled into
  the exact same window at the exact same time. Fixing it moved real numbers
  - 36→35 scheduled, 74.33%→48.53% utilisation, both traced to their exact
  cause rather than asserted. A sharper finding along the way: the FR9.1
  baseline commits this same violation for real in its own output (it has
  never read `dependsOnTaskId`), which means D-031's "identical throughput"
  claim needed to become dynamic rather than a stale constant - now true in
  three places (backend caveat, a new comparison-screen verdict, and a
  `KnownLimitations` gap from T22 that had never rendered `checkedAndClear`
  at all, closed as part of the same pass). 294 optimizer / 107 backend / 71
  frontend tests, verified live end to end. Next: **T25** (resource-conflict
  constraints, PRD 9.8) is the natural continuation - same taxonomy, same
  "detected but not enforced" gap this task just closed for dependencies.

- **2026-08-24** — T20 complete. What-if simulation, built as a real re-solve
  of the same CP-SAT model (a `Pin` constraint forcing one task's placement),
  never a simplified estimate. Two findings checked against the real corpus
  before any UI existed: D-024's structural-impossibility finding generalises
  to exclusion (freeing a scheduled task's window never rescues a deferred
  one), and any perturbation reshuffles a large, variable number of unrelated
  tasks' days as a side effect - so the diff design collapses that into a
  count, never a wall of rows. A second real timing bug was found only by
  testing at real-corpus scale: an extreme-but-T23-legal weight combination
  made whatif's four solves risk the interactive request's own timeout: fixed
  with a shorter dedicated solver budget and an honestly-surfaced `FEASIBLE`
  (not falsely `OPTIMAL`) status. No persistence, of any kind (D-064) -
  proven by a test that calls the endpoint twice and gets an identical plan.
  Applying an option reuses T15's override endpoint unchanged (D-065),
  confirmed live: a heavily-reshuffled option was correctly REFUSED by T15's
  own re-validation, a clean one succeeded with `blocks` staying
  byte-identical. **The 🟠 tier is now exhausted.** Remaining work is T24-28
  (🟡 stretch), or - per the standing plan - moving to auth once every
  T-numbered task is verified complete.

- **2026-08-24** — T23 complete. Policy sliders wired to the real D-023 objective
  weights, built only after auditing what a slider could honestly claim on the
  real corpus: every deferral is structural (D-024/D-028), so no weight changes
  WHICH tasks get done - all five instead move WHICH DAY, contrary to the guess
  that only batching/fragmentation would matter. A real safety issue was found
  (coverage collapses 36->3 outside a verified range) and closed with validated,
  refused-not-clamped bounds in both layers. `schedule.policyWeights` finally
  populated - real values, never faked - after nine tasks of `null`. Verified
  live end to end in a real browser: drag, regenerate, watch the Gantt change.
  T20 (what-if simulation) is the only 🟠 differentiator still `todo` -
  explicitly out of scope for both T19 and T23 per their prompts, not
  overlooked. Once T20 lands, the 🟠 tier is exhausted and remaining work is
  T24-28 (🟡 stretch) or TX1-4 (cross-cutting / demo prep).

- **2026-08-24** — T19 complete. The FR6.1 approval workflow, FR6.2 audit trail and
  FR6.3 versioned publishing, built so that **D-043's immutability guarantee gained
  no exception**: the state is derived from an append-only log and the schedule
  document is still never written after generation. Publishing freezes by refusing
  writes, and a digest makes that checkable rather than assumed. Three live-run
  verifier false-accusations found and fixed, plus a phrasing-dependent decline
  that would have contradicted itself in front of a judge. Next: **T20 (what-if)**
  or **T23 (policy sliders)**.
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