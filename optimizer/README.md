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

Planned `core/` modules:

| Module | Task | Implements |
|---|---|---|
| `scheduler.py` | T6 | CP-SAT model + solve (PRD Section 13) |
| `priority.py` | T7 | Asset criticality + priority scoring (FR2) |
| `baseline.py` | T8 | Naive per-department scheduler (FR9.1) |

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
