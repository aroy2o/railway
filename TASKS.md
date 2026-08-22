# Task tracker

Status values: `todo` | `in-progress` | `done` | `blocked`
Update this file at the end of every Claude Code session per `LOOP_PROMPT.md`.

---

## 🔴 Must build (do not skip ahead of this tier)

- [x] `done` — **T1**: Repo skeleton — `/backend`, `/optimizer`, `/frontend`, `/data`, `/docs` folders, package manifests, root `docker-compose.yml` stub, `.env.example`
      <br>_Built more than an empty skeleton: all three services boot, validate their config at startup, and answer health checks. `GET /api/health/dependencies` probes React → Express → MongoDB + CP-SAT in one call and is rendered live on the landing screen, so the wiring is provably real. Includes the PRD Section 5 prototype banner, a Zod validation-middleware factory and shared `ApiError` envelope on Express, Pydantic settings + an OR-Tools readiness probe on Python, and Redux Toolkit + RTK Query on the frontend. 6 backend tests, 5 optimizer tests, all passing._
- [ ] `todo` — **T2**: Real data ingestion script — fetch/parse `datameet/railways` station+route data, extract corridor sections (consecutive station pairs)
- [ ] `todo` — **T3**: Real timetable ingestion — fetch/parse data.gov.in / Kaggle timetable dataset, convert to per-corridor occupied-window calendar
- [ ] `todo` — **T4**: Synthetic maintenance/asset data generator (PRD 5.2) — assets, tasks, resources, dependencies, anchored to T2's corridor list
- [ ] `todo` — **T5**: MongoDB schemas (Mongoose) for all PRD Section 15 collections
- [ ] `todo` — **T6**: Standalone CP-SAT scheduler script (Python, no API yet) — hand-built small test scenario first, verify constraints hold (no double-booking, no resource overlap, deadlines respected)
- [ ] `todo` — **T7**: Asset criticality + priority scoring module (weighted formula version first)
- [ ] `todo` — **T8**: Naive baseline algorithm (independent per-department scheduling, FR9.1) — must be real, not mocked
- [ ] `todo` — **T9**: FastAPI service wrapping T6/T7/T8 as `/prioritize`, `/optimize`, `/baseline` endpoints
- [ ] `todo` — **T10**: Express API — auth (JWT), CRUD for tasks/corridors/assets, orchestration calls to FastAPI service
- [ ] `todo` — **T11**: React app shell — routing, auth flow, API client module
- [ ] `todo` — **T12**: Gantt/corridor timeline component (weekly/monthly toggle, department color-coding)
- [ ] `todo` — **T13**: Controller Dashboard — KPI strip, priority queue, "Generate schedule" trigger
- [ ] `todo` — **T14**: Baseline vs AI comparison screen (FR9.3) — real computed metrics table
- [ ] `todo` — **T15**: Manual override UI + backend re-validation against constraints (FR6.2/FR3)

## 🟠 Strong differentiators (start only once all 🔴 above is `done`)

- [ ] `todo` — **T16**: Predictive risk model (9.1) — train on synthetic degradation history, honestly-labeled in UI/docs
- [ ] `todo` — **T17**: Decision log generation in the optimizer (structured, per-task reasoning)
- [ ] `todo` — **T18**: `/explain` endpoint (LLM call grounded in decision log) + "Ask the Planner" UI
- [ ] `todo` — **T19**: Human-in-the-loop approval workflow (FR6.1) + `audit_logs` collection + Audit Trail view
- [ ] `todo` — **T20**: What-if simulation endpoint + UI panel (FR5)
- [ ] `todo` — **T21**: Conflict detection + typed classification (corridor/train-impact/resource/dependency) + display (FR4)
- [ ] `todo` — **T22**: Train-impact scoring integrated into the CP-SAT objective function (9.6)
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

## Session log

_Append a dated one-line entry here each session — what was completed, what's next._

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