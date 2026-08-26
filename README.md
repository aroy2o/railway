# AI-Assisted Railway Maintenance Block Planning

**SIH Problem Statement 26027** · Ministry of Railways · Transportation & Logistics

A centralised, AI-assisted **block planning and decision support system** for
Indian Railways fixed-infrastructure maintenance. Instead of three departments
(Engineering, S&T, TRD) requesting corridor possessions independently through
BDMS, all maintenance demand is pooled, scored by asset criticality and
predicted risk, and scheduled by a constraint solver that batches departments
into shared windows while minimising train-delay impact.

> **Prototype uses synthetic maintenance data anchored to real railway
> infrastructure and timetable data.** Corridors, station codes and timetable
> windows come from published datasets; maintenance tasks, asset health and
> resources are generated, because that data is internal to Indian Railways.
> This disclaimer is shown in the running app (PRD Section 5).

See [`PRD_AI_Block_Planning_SIH_26027.md`](PRD_AI_Block_Planning_SIH_26027.md)
for full scope, [`TASKS.md`](TASKS.md) for build progress, and
[`docs/DECISIONS.md`](docs/DECISIONS.md) for architecture decisions.

---

## Architecture

```
React + Redux (Vite, TypeScript)          :5173
  │  REST/JSON over the RTK Query api slice, JWT auth
Node.js + Express                          :5000
  │  auth, CRUD, orchestration, audit + decision logs
  ├── MongoDB                              :27017
  └── Python + FastAPI                     :8000
        CP-SAT scheduling, asset-risk model, /explain
```

Node never calls OR-Tools directly — constraint solving lives behind an
internal REST call to the Python service, which is the one place a
purpose-built solver library exists (PRD 10.3).

| Layer | Job |
|---|---|
| Rules / constraints | Guarantee feasibility (corridor, resource, dependency, train-impact) |
| Optimization (CP-SAT) | Find the best feasible schedule |
| Machine learning | Predict asset failure risk |
| LLM | Explain the schedule in plain English, grounded in the solver's decision log |

## Repository layout

```
backend/      Node.js + Express API (auth, CRUD, orchestration)
optimizer/    Python FastAPI microservice (CP-SAT, risk model, /explain)
frontend/     React (Vite + TypeScript + Tailwind + Redux) dashboard
data/         real dataset ingestion + synthetic data generation scripts
docs/         architecture decision log
```

## Prerequisites

- Node.js **20+**
- Python **3.12+**
- MongoDB **8** running locally (or via the compose file)

## Quickstart

```bash
# 1. Configuration — one .env at the repo root serves all three services
cp .env.example .env
#    Set JWT_SECRET to a real value:  openssl rand -hex 32

# 2. Optimizer service (Python)
cd optimizer
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m app.main            # http://localhost:8000

# 3. Backend API (Node) — in a second terminal
cd backend
npm install
npm run dev                             # http://localhost:5000

# 4. Frontend (React) — in a third terminal
cd frontend
npm install
npm run dev                             # http://localhost:5173
```

Open <http://localhost:5173>. The landing screen probes the whole chain — if
MongoDB or the optimizer is down, it says which one.

### Verifying the stack from the shell

```bash
curl localhost:8000/health/ready              # CP-SAT usable?
curl localhost:5000/api/health/ready          # MongoDB connected?
curl localhost:5000/api/health/dependencies   # both, in one call
```

### Docker Compose (demo packaging)

```bash
docker compose up --build

# once, after the first `up` - the containers don't seed themselves:
docker compose exec backend node dist/scripts/seed.js
```

Local dev is the primary workflow; compose is demo packaging, verified end
to end under task TX1 (see `docs/DECISIONS.md` D-087). It binds host ports
27017/8000/5000/5173, same as local dev - stop `mongod` and any `npm run
dev` processes first, or run one path at a time, not both.

## Ports

| Service | Port | Configured by |
|---|---|---|
| Frontend (Vite) | 5173 | `frontend/vite.config.ts` |
| Backend API | 5000 | `BACKEND_PORT` |
| Optimizer | 8000 | `OPTIMIZER_PORT` |
| MongoDB | 27017 | `MONGODB_URI` |

## Tests

```bash
cd backend   && npm test                   # API shell, error envelope, validation
cd optimizer && .venv/bin/python -m pytest # config validation, CP-SAT availability
cd frontend  && npm run build && npm run lint
```

Testing effort is deliberately concentrated on the CP-SAT solver, the priority
engine and the baseline algorithm (`CLAUDE.md` testing priorities) rather than
on UI coverage.

## Data honesty rules

These are non-negotiable for this project:

- Utilisation %, delay-minutes and every other output metric must come from an
  actual run. Placeholders are marked `PLACEHOLDER - replace with real solver
  output` so they cannot reach a pitch deck by accident.
- The predictive risk model is trained on **simulated** degradation data and is
  described that way everywhere — it is designed to be retrained on real
  historical asset-health data (PRD 9.1).
- The baseline in the comparison screen is a real, executed algorithm, never a
  hand-typed "before" number (PRD FR9.1).
