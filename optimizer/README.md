# `/optimizer` — Python FastAPI service

CP-SAT scheduling, asset-risk scoring and the LLM explanation layer — the three
jobs with no good equivalent in the Node ecosystem (PRD 10.3). The Express API
is its only client.

## Run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

.venv/bin/python -m app.main            # http://localhost:8000
# or, with reload:
.venv/bin/uvicorn app.main:app --reload

.venv/bin/python -m pytest
```

> **Always call the binaries through `.venv/bin/`, even with the venv activated.**
> A bare `uvicorn app.main:app` can pick up a user-level install from
> `~/.local/bin` that shadows the venv, launches under system Python and fails
> with `ModuleNotFoundError: No module named 'pydantic_settings'`. The traceback
> gives it away - the frames come from `~/.local/lib/...` rather than
> `optimizer/.venv/lib64/...`. `.venv/bin/uvicorn` or
> `.venv/bin/python -m uvicorn` avoids it entirely.

Interactive API docs at <http://localhost:8000/docs>.

Configuration comes from the repo-root `.env` (see `../.env.example`);
`optimizer/.env` may override it. Invalid values raise at import time rather
than producing surprising behaviour later — a zero `SOLVER_MAX_SECONDS`, for
instance, would make CP-SAT return nothing at all.

## Layout

```
app/
  config.py         pydantic-settings — the only source of tunables
  logging_config.py LOG_LEVEL-driven logging setup
  main.py           FastAPI app factory, lifespan, unhandled-error handler
  models/           Pydantic request/response models — the validated boundary
  routers/          thin HTTP handlers; they validate and delegate
  core/             domain logic, importable without FastAPI
tests/              pytest
```

**`app/core` must never import from `app/routers` or from `fastapi`.** That
one-way dependency is what lets the CP-SAT model be unit-tested standalone
without starting a server (`CLAUDE.md` Python convention).

`core/` modules:

| Module | Task | Implements | Status |
|---|---|---|---|
| `scheduler.py` | T6 | CP-SAT model + solve (PRD Section 13) | **done** |
| `priority.py` | T7 | Priority scoring + ranked queue (FR2.3/FR2.4) | **done** |
| `baseline.py` | T8 | Naive per-department scheduler (FR9.1) | **done** |
| `conflicts.py` | T21 | Typed conflict taxonomy + resolutions (PRD 9.5) | **done** |
| `risk.py` | T16 | Predictive asset-risk model (FR2.2, PRD 9.1) | **done** |
| `trains.py` | T22 | Train-impact scoring + traffic-block costing (PRD 9.6) | **Phase A** |
| `grounding.py` | T18 | The grounding contract for Ask the Planner (PRD 9.2) | **done** |
| `explainer.py` | T18 | Claude call + runtime verification of its output | **done** |

---

## The CP-SAT scheduler (`app/core/scheduler.py`)

Implements PRD Section 13 / FR3. Pure: dataclasses in, a result object out. No
FastAPI, no database, no network — so it is unit-testable standalone, which
CLAUDE.md names as testing priority #1.

### What is implemented from PRD Section 13

| PRD Section 13 item | Status |
|---|---|
| `assign[i][j]` per task and candidate free window on its corridor | implemented |
| Each task in at most one window; zero means deferred | implemented |
| Sum of assigned durations ≤ window length | implemented |
| No overlap between windows on one corridor | holds structurally (T3 emits a merged complement); asserted, not re-encoded |
| Cross-department batching, rewarded | implemented and exercised on real data |
| Deadline respected where feasible | implemented as a soft objective term — see D-020 |
| Resource no-overlap (9.8) | **deferred to T25** — violations detected and reported |
| Dependency precedence (9.7) | **deferred to T24** — violations detected and reported |
| Weather/seasonal risk (9.9) | **deferred to T26** |

### Objective (simplified PRD 13.1)

```
MAXIMIZE  10000 x priority-weighted coverage
        +  2000 x tasks landing within SLA
        +  3000 x windows carrying two or more departments
        -     1 x unused minutes inside opened windows
        -   500 x windows opened
```

The magnitudes are a **priority order, not a tuning**: covering the lowest
priority task (10,000) always beats the worst possible waste penalty on one
window (~1,440 + 500), so coverage is never traded for tidiness. Everything else
breaks ties. Full multi-term objective with policy sliders is T23 (D-023).

`MaintenanceTask.priority` now carries the real FR2.3 score from
`app/core/priority.py` (0–100), and the decision log reports
`priorityIsPlaceholder: false`. Set `use_priority_engine=False` in
`load_scenario` to reproduce T6's severity-only behaviour for comparison.

---

## The priority engine (`app/core/priority.py`)

Implements FR2.3 (one score) and FR2.4 (ranked queue with a visible breakdown).

```
priority = 100 x ( 0.35 x severity/5
                 + 0.30 x assetCriticalityScore/100     <- real (FR2.1)
                 + 0.20 x sla_urgency                    <- 0..1 over 90 days
                 + 0.15 x sla_breach )                   <- 0..1 over 60 days past due
```

Ordered on one principle: **the physical state of the asset outranks the
paperwork clock.** Additive rather than multiplicative because FR2.4 asks which
factor dominated, and a product cannot be decomposed (D-026).

Overdue urgency lives here rather than in the solver, because D-020 keeps SLA
soft — 18 of 89 real tasks are already past due, and a hard deadline would make
them permanently unschedulable (D-027).

**FR2.2 `failureRiskScore` is accepted and deliberately unused** until T16.
`PriorityBreakdown.uses_failure_risk` reports `False` so nobody mistakes this for
a risk-aware score.

### Effect on the real corpus

Tied pairs among the 89 tasks drop from **1,057 to 11**. The scheduled set is
unchanged (36/53) because every deferral on this corpus is structural and there
are no capacity contests for priority to arbitrate — see D-028 for the full
before/after and why that is the expected result rather than a failure.

### Running it against real data

```bash
# needs the backend API, MongoDB, `npm run seed`, and this service running
.venv/bin/python -m scripts.run_comparison
```

`scripts/real_data.py` builds a request payload from the seeded corpus and
`scripts/run_comparison.py` POSTs it to the live endpoints — they stand in for
Node's gathering step so the endpoints can be exercised end to end without an
orchestration layer. Neither is on the request path.
(`scripts/run_real_solve.py` was removed when `/optimize` landed.)

### Result on the real corpus (89 tasks, 30 corridors, weekly horizon)

```
status OPTIMAL | objective 865,815 | solve 0.65 s
36 scheduled · 53 deferred · 25 blocks · 2 cross-department batches
block utilisation 74.3%
deferrals: EXCEEDS_LONGEST_WINDOW 53, NO_CAPACITY 0
```

All 53 deferrals are structural: the task is longer than any gap its corridor
offers. **Zero** tasks lose a capacity contest, so on this dataset the binding
constraint is window *length*, not block-hours (D-024).

### Performance

PRD Section 7 requires a weekly solve under 10 seconds for 50–100 tasks.
Measured: **0.65 s** with one worker, comfortably inside budget. A 30-day
horizon hits the 10-second limit and returns `FEASIBLE` rather than `OPTIMAL` —
monthly planning (T28) should use the coarser corridor-day reservation model
PRD Section 13 describes rather than this fine-grained one.

Single-worker is the default for reproducibility, not by accident: four workers
solve in 0.08 s but returned **different plans for identical input** across three
runs (D-022).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness. |
| `GET` | `/health/ready` | `503` unless OR-Tools CP-SAT is genuinely usable. |
| `POST` | `/prioritize` | FR2.4 ranked queue with per-factor breakdowns. |
| `POST` | `/optimize` | FR3 CP-SAT block schedule (PRD Section 13). |
| `POST` | `/baseline` | FR9.1 naive per-department schedule (PRD Section 12). |
| `GET` | `/docs`, `/openapi.json` | Generated API contract. |

`/whatif` lands with T20 and `/explain` with T18.

### The scheduling endpoints

Node gathers inputs from MongoDB and POSTs them here; **this service never
touches the database**. The payload is a clean intermediate shape rather than
raw documents, with the asset-criticality join already resolved by Node — see
D-032.

```jsonc
POST /optimize        // and /baseline, same body
{
  "horizonStart": "2026-08-24",
  "horizonDays": 7,
  "corridors": [
    { "corridorId": "GZB-SBB",
      "dailyWindows": [{ "startMinute": 68, "endMinute": 122 }],
      "lowConfidence": false }
  ],
  "tasks": [
    { "taskId": "TSK-00042", "corridorId": "GZB-SBB", "department": "S&T",
      "estBlockDurationMins": 120, "slaDueDate": "2026-10-18", "severity": 1,
      "assetCriticalityScore": 90.75,   // REAL, joined by Node
      "dateRaised": "2026-07-20",       // load-bearing for /baseline's FCFS
      "dependsOnTaskId": null, "requiredResourceIds": ["RES-D04-signal-test-van"] }
  ]
}
```

`/prioritize` takes `{ tasks, asOf }` and requires `assetCriticalityScore` —
scoring without it would silently produce a weaker ranking that still looked
authoritative.

Responses are the solver dataclasses' `as_dict()`, returned **unfiltered on
purpose**: a `response_model` would silently drop any undeclared field, and the
honesty fields (`priorityIsPlaceholder`, `usesFailureRisk`, `knownGaps`, the
baseline's conflict report) are exactly what would go missing. See D-033.

`/baseline` additionally returns `contestableTaskIds` so T14 cannot draw the
comparison from the full backlog (D-031), and warns when `dateRaised` is absent.

Validation is strict at the boundary: unknown fields, a task referencing an
absent corridor, duplicate ids, overlapping windows, a `lowConfidence` corridor,
an oversized body or a horizon past the configured ceiling all return a clean
422/413 rather than failing inside the solver.

### Why readiness builds a model

`/health/ready` does not just `import ortools` — it constructs a `CpModel` and
declares a variable. The OR-Tools wheel ships native libraries that can import
successfully and then fail at first use, and CP-SAT is the highest-risk
dependency in the project (PRD Section 18). Failing here is far cheaper than
failing on demo day.

## Dependencies

Deliberately lean; libraries are added by the task that needs them.
`scikit-learn`/`lifelines` arrive with the risk model (T16) and `anthropic` with
`/explain` (T18). OR-Tools is installed from the start so an install failure
surfaces now rather than on the day the solver is written.


---

## The naive baseline (`app/core/baseline.py`)

Implements PRD FR9.1 / Section 12 — the current BDMS process, where each
department books blocks for its own work with no visibility of the others. It
exists so T14's comparison shows a **real computed** "before", never a
hand-typed one.

```bash
.venv/bin/python -m scripts.run_comparison
```

### How it is worse, structurally

Not by being badly written. Two failure modes, both unreachable-by-design for
the optimizer:

1. **No cross-department batching.** Blocks are built per department per window,
   so a possession never serves two departments. Asserted as an invariant.
2. **Double-booking.** Each department's pass starts from a clean view of the
   calendar, so two departments take the same window at the same clock time.

A department's own pass *is* coordinated — the same office knows what it already
requested. Only cross-department visibility is missing, which is exactly the
problem statement's complaint (D-030).

Ordering is first-come-first-served by `dateRaised`, **not** by `slaDueDate` —
that would be earliest-deadline-first, a genuinely good heuristic that would
flatter the baseline (D-029).

### Result on the real corpus (contestable subset, weekly horizon)

| Metric | Baseline | AI-optimised |
|---|---:|---:|
| Contestable tasks scheduled | 36/36 | 36/36 |
| Cross-department batches | 0 | 2 |
| Double-booking conflicts | 6 | 0 |
| Double-booked minutes | 605 | 0 |
| Over-subscribed windows | 3 | 0 |
| Block utilisation | 77.01% | 74.33% |

**Read that table carefully.** The optimizer schedules no more work than the
baseline, and the baseline's utilisation is *higher* — because it crams the same
4,880 minutes into 24 windows instead of 25 by over-subscribing three of them.
The advantage is feasibility and coordination, not throughput. See D-031 before
building any comparison screen.

---

## Typed conflicts (`app/core/conflicts.py`) — PRD 9.5

Both scheduling endpoints attach a `conflictReport` alongside their existing
output. It classifies what `scheduler.py` and `baseline.py` already detect; it
adds no detection and changes no count.

| Type | Detected in | Resolution strategy | Enforced by |
|---|---|---|---|
| `CORRIDOR_DOUBLE_BOOKING` | baseline | Merge into one shared possession | the optimizer already does this |
| `WINDOW_OVER_SUBSCRIPTION` | baseline | Defer the excess work | the optimizer already does this |
| `RESOURCE_CONTENTION` | optimized | Stagger within the department / Only one proceeds | **T25** |
| `DEPENDENCY_ORDER_VIOLATION` | optimized | Reorder to respect precedence | **T24** |
| `TRAIN_IMPACT_CONFLICT` | **nothing detects this** | — | **T22** |

### Three things this deliberately does not do

**It does not resolve anything.** A strategy is a label. Resource no-overlap is
T25 and dependency precedence is T24; both are still unmodelled constraints, and
`enforced_by` on every record says which task would close it.

**It does not report train impact as zero.** PRD 9.5 names the type, so it is in
the taxonomy — but it appears in `notYetDetectable` with a reason, not as a count
of `0`. Zero would claim a check that does not exist.

**It does not total across plans.** Counts nest under `byPlan`. On the real
corpus the optimized plan carries 16 (11 + 5) and the baseline carries 9 (6 + 3);
"25 conflicts" describes no plan that exists, and the two halves mean opposite
things. See D-045.

### On the real corpus

```
byPlan.optimized.byType = {RESOURCE_CONTENTION: 11, DEPENDENCY_ORDER_VIOLATION: 5}
byPlan.baseline.byType  = {CORRIDOR_DOUBLE_BOOKING: 6, WINDOW_OVER_SUBSCRIPTION: 3}
```

Same numbers T6 and T8 produced — the taxonomy names them, it does not re-derive
them, and `test_conflicts.py` asserts exactly that.

**All 11 resource conflicts are same-department.** T4's resource catalogue is
keyed by department, so a machine belongs to one department and cross-department
contention cannot occur by construction. The `Only one proceeds` branch (PRD
9.5's own wording, which describes rival departments) is therefore unreachable on
the current data; within one department the honest fix is to stagger, not to drop
a task. A test asserts this, so changing the resource model surfaces rather than
silently altering the advice shown on screen.

### `knownGaps` detail (T21, D-047)

`detect_known_gaps` was returning three fields per conflict where the baseline's
report returned seven. It now returns nine — corridor, date, departments, window
times and overlap minutes — all of which the detection loop already had in scope.
Additive: no new logic, no changed count.

---

## Ask the Planner (`/explain`) — PRD 9.2, FR8.2

A Controller asks a free-text question; the answer comes back with the records
it was grounded in and a verdict on every number in it.

```
Node (owns MongoDB)  ->  schedule + tasks + overrides, interpreted not at all
grounding.py         ->  assemble_context(question, records)  [pure]
explainer.py         ->  prompt built ONLY from that context  ->  Claude
explainer.py         ->  verify_answer(reply, context)        [pure]
```

### The contract

The model never receives the schedule. It receives a flat list of `Fact`s, each
carrying the id of the stored record it was copied from. `assemble_context` is
pure — same question and records, same context, every time — so a test can state
exactly what the model was permitted to see *before* any API call. That is the
whole guarantee, and it lives in the deterministic half on purpose.

Selection: tasks and corridors named in the question pull their decision entry,
stored record, block, conflicts and overrides. A question naming nothing gets a
bounded slice — the highest-priority deferrals and the cross-department batches.
Every context also carries the plan summary, the baseline comparison **with its
D-031 caveats**, the synthetic-data provenance note, and the train-impact gap.

### Verification, not trust

`verify_answer` extracts every number from the reply and checks it against the
values the context contained (plus any the Controller used in their own
question). Leftovers come back as `ungroundedNumbers`, and the UI renders that
answer under a warning rather than styled as a clean one.

It is a **net, not a proof**: a fabricated figure that coincides with some real
value elsewhere in the context passes, and a test asserts that limit so it
cannot rot into an assumed guarantee. It reliably catches distinctive invented
quantities, which is the failure that actually happens.

### What it refuses to answer

Six topics this build genuinely has no data for, each with a reason and the task
that would supply it: train impact (T22), predictive failure risk (T16),
approval/audit history (T19), what-if simulation (T20), policy weighting (T23),
weather (PRD 9.9). Detection only ever *adds* a caveat — the model decides
whether the question actually depends on the missing data.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | `anthropic` or `groq`. Neither the grounding contract nor the output verification depends on this (D-052). |
| `ANTHROPIC_API_KEY` | *(empty)* | Empty is valid. `/explain` returns **503** naming the missing key; every other endpoint is unaffected. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | |
| `GROQ_API_KEY` | *(empty)* | |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | A plain LLM. **Do not** switch to a `groq/compound-*` model — see below. |
| `EXPLAIN_MAX_TOKENS` | `700` | Answers are 2–5 sentences by design. |

#### Why not a `groq/compound` model

Two reasons, both found by testing rather than reading the docs:

* Its advertised **70,000 tokens/minute is not real** — its 429 names
  `openai/gpt-oss-120b`, because the compound models are agentic systems built
  on gpt-oss and bill against *its* 8,000/minute budget.
* It can **reach the internet**. Asked about the weather it attempted a web
  search and failed with HTTP 413; with search excluded it answered correctly
  from the data. For a feature claiming every number came from the records, a
  model that can browse mid-answer is disqualifying. Search is suppressed on
  every compound call anyway, and a reply reporting `executed_tools` is refused
  rather than shown.

#### Rate limits shape the prompt

A question naming no task once assembled ~11,000 tokens — more than the
per-minute allowance, so those requests simply failed. The context now carries a
**hard size budget with ranked survival** (D-053): ~1,750 tokens per prompt,
evidence about what was actually asked outranks plan-level perspective, and
anything dropped is reported to the model as *"further records exist and were
not examined"* so it cannot claim the plan lacks something it was never shown.

Sizing is measured from `usage.prompt_tokens`, never estimated — the char/4 rule
undercounted this JSON by 3x.

### Tests

```
pytest                    # 192 tests, offline, no API key needed
pytest -m live            # 9 tests against the real Claude API
```

The live tests ask each behaviour across several **phrasings** and several
**repetitions** and assert on the whole set, because one good answer from a
non-deterministic system is not evidence. **They skip without an API key — they
never pass without running.**

---

## Predictive asset risk (`/risk`) — FR2.2, PRD 9.1

**Read this first: the model is trained on SIMULATED degradation data.** It does
not predict real Indian Railways asset failures, and PRD Section 6 lists that
claim as an explicit non-goal (NG4). Every response carries the disclaimer, per
assessment and at the envelope.

### The model

Fit OLS over each asset's 12 monthly `healthMetric` observations, extrapolate to
an intervention threshold of 0.30, and express time-to-threshold as
`100 x (1 - t/24)`, clipped to 0-100.

Chosen because it **matches T4's generating process** — a constant per-asset
decline plus N(0, 0.015) noise — so a linear fit is the right functional form
rather than an approximation of one. Alternatives, and why not:

| Alternative | Why not |
|---|---|
| GBM / logistic classifier | **No failure labels exist.** T4 generated health series, not failure events. Labels derived from the same series would be circular and any accuracy figure would measure nothing. |
| P(crossing within a horizon) | Built and measured. Noise is small relative to the decline, so it collapsed to near-binary: 30 of 55 assets under 5, 23 over 50. A poor priority input. |
| Latest health alone | Discards the decline rate. Two assets at 0.50 losing 0.04 and 0.01 a month are not equally urgent. |

Both constants are modelling choices, stated as such: **0.30** sits just below
the corpus's lowest current health (0.317), so every score is a forecast rather
than a statement about the present; **24 months** caps "not soon" without
flattening the distribution (median time-to-threshold is 8.4 months).

### Explainable, not a black box

`breakdown` carries current fitted health, decline per month, months-to-threshold
with a 95% band, observation count and volatility — so "why is this asset high
risk" has a real answer: *"it is at 0.34 and losing 0.041 a month, so it reaches
the threshold in about one month."*

### What it refuses to score

| Case | Result |
|---|---|
| Fewer than 3 observations | `null` + a reason. Never a default. |
| No declining trend | `0.0` **with** a reason — an inference, not a gap. |
| Already below threshold | `100.0`, and the reason says this reflects the current trend, not a forecast. |

A task whose asset has no score does **not** get a zero contribution — the
priority engine renormalises its other four weights (D-055), so a data gap is
never scored as a favourable finding.

### Effect on FR2.3 priority

Weights moved from D-026's four to five: severity 0.30, asset criticality 0.25,
**failure risk 0.20**, SLA urgency 0.15, SLA breach 0.10. Risk is capped below
criticality on purpose — criticality is anchored in real train counts (T3),
this score is not, and a synthetic input must not outweigh a measured one.

On the real corpus: ranking moved (rho +0.873, median rank move 8 places, risk
dominant for 15 of 89 tasks) but **the plan is unchanged** — same 36 scheduled,
53 deferred, 25 blocks, 2 batches, 74.33% utilisation. Per D-024 there is no
capacity contest for priority to arbitrate.

### An honest caveat about this corpus

Current health and decline rate correlate **+0.867** in T4's data, because the
generator starts every asset in a narrow band and declines it at a constant
rate. So here the risk score behaves close to "inverted current health". The
model is right; the synthetic data under-exercises it. Real asset-health data
with varied ages would separate the two.

---

## Train impact (`trains.py`) — PRD 9.6, T22 **Phase A**

Answers *"if a block took this corridor for these minutes, what would it cost?"*
It does **not** change what the solver schedules.

### Phase A, not Phase B — and why

Phase B is PRD 13.1's λ: letting the solver treat displacement as a schedulable
option penalised in the objective. Measured first: **all 53 structurally-deferred
tasks are rescuable by displacing 1-16 trains (median 3)**, so the prize is the
whole deferred backlog. Scoped out anyway, for reasons that are about data and
blast radius rather than time (D-056):

* **T3 kept train times but not per-service classes.** The class split of a
  displacement is apportioned from the corridor mix. Reporting an estimate is
  fine; putting one in the objective would let it drive the solver's *choices*.
* **The ripple is total.** D-031's comparison rests on a contestable subset of
  36 that both engines schedule 36/36. Making some of the 53 schedulable
  un-defines that, and four prior tasks' comparisons would need re-deriving.
* The honest Phase B needs T3 extended to tag each occupied window with its
  service's class first. Then λ multiplies something measured.

### The score

Cost of displacing one train = its tier weight × minutes displaced.

| tier | weight | classes |
|---|---:|---|
| flagship | 4.0 | Raj, Shtb, JShtb, Drnt |
| express | 2.0 | SF, Mail, Exp, GR, SKr, … |
| passenger | 1.0 | Pass |
| suburban | 0.7 | MEMU, DEMU, Toy |
| unknown | 1.0 | anything T3 could not classify — neutral, **not free** |

Measured against alternatives across the 26 demand-carrying corridors:

| weighting | spread | ties | ρ vs utilisation |
|---|---:|---:|---:|
| flat 1/1/1/1 | **0.00** | **325** | +0.131 |
| binary 2/2/1/1 | 1.00 | 16 | +0.597 |
| **chosen 4/2/1/0.7** | **1.63** | **5** | +0.590 |

Flat weighting is the failure this measurement exists to catch — it produces a
constant, so the score would look informative and carry nothing.

### Measured vs estimated, kept structural

`impact.measured` — trains displaced, minutes displaced, **clearance minutes** —
all from T3's real timetable. `impact.estimated` — weighted cost and tier split —
apportioned from the corridor mix. Separate objects, not separate sentences, so
they cannot be merged by accident.

Displaced minutes are **displacement time, not modelled delay propagation**.
This build has no such model.

### On the real corpus

All 53 deferrals are costed: **1-16 trains, 0-88 minutes, weighted 0-191**. The
cheapest (TSK-00073, MQX-RMF) displaces **no train at all** — it needs 7 minutes
more than the longest free window and takes 22 minutes of clearance margin.
Reporting "0 trains" alone would have called that free, which is why
`clearanceMinutes` travels with every costing.

`TRAIN_IMPACT_CONFLICT` is now **checked, not undetectable** — count 0, earned by
checking every block against observed occupancy rather than assumed.
