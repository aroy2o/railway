# Architecture Decision Log

Short entries, newest last. Each records **what** was decided, **why**, and the
**alternative** that was considered, so a design choice can be defended in demo
Q&A without re-deriving the reasoning.

Decisions that were already fixed by the PRD or `CLAUDE.md` (MERN core, a
separate Python CP-SAT service, MongoDB over PostgreSQL) are not repeated here —
see PRD Sections 10 and 15.

---

## D-001 — TypeScript on the frontend, JavaScript on the backend

**Date:** 2026-08-22 · **Task:** T1

**Decision.** `/frontend` is TypeScript (`.ts`/`.tsx`, strict-ish template
settings). `/backend` stays plain JavaScript ESM. `/optimizer` uses Python type
hints with Pydantic doing runtime validation.

**Why.** The frontend was scaffolded as `react-ts`, and the dashboard is where
type safety pays off most: the Gantt, KPI and comparison screens all consume
nested solver output, and a typed API contract catches shape mismatches at
build time rather than mid-demo. The backend is mostly thin routing and
orchestration where Zod already validates every boundary at runtime, so a
compile step would add friction without adding much safety.

**Alternative considered.** TypeScript everywhere. Rejected for the backend on
timeline grounds — adding a build step and type definitions for Mongoose models
costs hours that are better spent on the solver, and Zod schemas already give
runtime guarantees at the API edge, which is where the real risk is.

---

## D-002 — One `.env` at the repo root, shared by all three services

**Date:** 2026-08-22 · **Task:** T1

**Decision.** A single `.env` at the repo root configures the Node API, the
Python service and the Vite build. Each service resolves it explicitly:

| Service | Mechanism |
|---|---|
| backend | `dotenv` loads `backend/.env` then `<root>/.env` |
| optimizer | `pydantic-settings` `env_file=(root/.env, optimizer/.env)` |
| frontend | Vite `envDir` points at the repo root |

Each service may still keep its own `.env` as an override, and the real process
environment (what `docker-compose` injects) always wins.

**Why.** Values are genuinely shared — the backend's `OPTIMIZER_URL` has to
agree with the optimizer's `OPTIMIZER_PORT`, and `docker-compose` wants one
`env_file`. Three copies of overlapping config is how a demo breaks: one file
gets edited and the other two silently disagree.

**Alternative considered.** A `.env` per service. Rejected for the drift risk
above. The cost of this choice is that each service must be told where the root
is, which is three short, commented lines.

---

## D-003 — Redux Toolkit + RTK Query for state management

**Date:** 2026-08-22 · **Task:** T1

**Decision.** State is split along a deliberate line:

- **Server state** — health, tasks, corridors, schedules, comparison output —
  is owned by a single RTK Query `api` slice (`src/api/apiSlice.ts`). Every
  backend call is an endpoint there; no component calls `fetch` directly.
- **Client state** — auth session, policy-slider positions, current selection,
  what-if panel state — lives in hand-written slices under `src/store/slices/`.

**Why.** Requested by the project owner. RTK Query also happens to fit the
`CLAUDE.md` rule that API calls stay in one client module, and it removes the
per-component loading/error/caching boilerplate that would otherwise be
rewritten on every screen. The Controller Dashboard genuinely needs shared
client state — policy sliders (PRD 13.1) drive a regenerate that several
components read — which is the case plain prop-drilling handles worst.

**Alternative considered.** React Query for server state plus `useContext` for
the small amount of client state. Comparable on merit and lighter, but the
owner asked for Redux, and one library covering both halves is simpler than two.

**Consequence to watch.** Do not mirror server data into hand-written slices.
If solver output ends up copied into a slice, the cache and the copy will
diverge. Derive from the RTK Query cache instead.

---

## D-004 — Fail fast on config, never fail silently at runtime

**Date:** 2026-08-22 · **Task:** T1

**Decision.** Both services validate their entire configuration at import time
and refuse to start on invalid input (Zod in `backend/src/config/env.js`,
Pydantic in `optimizer/app/config.py`). At runtime the inverse applies: every
error is logged with context and returned in one envelope,
`{ error: { code, message, details? } }`, identical across both services. The
optimizer being unreachable surfaces as a `502`, never a generic `500`.

Health endpoints are the one deliberate exception: `/health/dependencies`
*reports* that a dependency is down rather than failing with it, because a
health check that dies with its dependency tells you nothing.

**Why.** PRD Section 7 requires every scheduling decision to be traceable, and
NFR practice is that a misconfiguration should break at deploy time, not as a
confusing 500 during a live demo. A short `JWT_SECRET` or an unreachable
optimizer are the two most likely misconfigurations, and both are now loud.

**Alternative considered.** Defaults for everything and log-a-warning on bad
config. Rejected: a service that boots with a placeholder JWT secret looks
healthy while being broken, which is the worst possible failure mode to
discover on stage.

---

## D-005 — Local-first development, Docker Compose reserved for the demo

**Date:** 2026-08-22 · **Task:** T1

**Decision.** The documented primary workflow runs the three services directly
on the host against a local `mongod`. `docker-compose.yml` exists and is
committed, but is treated as demo packaging (finished under task TX1).

**Why.** `docker compose` is not installed on the current dev machine, while
Node 20, Python 3.12 and MongoDB 8 all are. Making Docker the primary path
would mean every code change waits on an image rebuild — including rebuilding
the large OR-Tools layer — for no benefit during the build phase.

**Alternative considered.** Docker-first from day one. Better environment
parity, but it trades away iteration speed at exactly the point in the timeline
where iteration speed matters most. The compose file exists so parity is one
task away rather than a rewrite.

**Known gap.** The compose file has not been verified end to end, because
compose is not installed here. That verification is explicitly part of TX1 and
must happen before the demo, not on the day.
