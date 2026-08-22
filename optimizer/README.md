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
| `baseline.py` | T8 | Naive per-department scheduler (FR9.1) | pending |

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
# needs the backend API up and `npm run seed` done
.venv/bin/python -m scripts.run_real_solve
```

`scripts/real_data.py` is a **dev harness, not the production path**. PRD
Section 11 puts Node in front of MongoDB: the Controller triggers a schedule,
Node gathers the inputs and POSTs them to `/optimize` (task T9). The Python
service never talks to MongoDB itself. The harness reads through the T5
read-only API so T6 could be validated against the real corpus before that
endpoint exists.

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
| `GET` | `/docs`, `/openapi.json` | Generated API contract. |

`/prioritize`, `/optimize` and `/baseline` land with task T9; `/whatif` with
T20 and `/explain` with T18.

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
