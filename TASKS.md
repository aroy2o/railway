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
- [ ] `todo` — **T4**: Synthetic maintenance/asset data generator (PRD 5.2) — assets, tasks, resources, dependencies, anchored to T2's corridor list
      <br>_Now has both real anchors: **which** sections exist (`corridors.json`) and **when** each is actually free (`corridor_calendar.json`). Anchor generation to sections with `lowConfidence == false`. The four saturated sections above are the most compelling demo corridors — that is where maintenance genuinely competes with traffic._
      <br>_`trainsAffectedCount` for asset criticality (PRD FR2.1) is already real: use `trainsObserved` from the calendar, don't synthesise it._
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