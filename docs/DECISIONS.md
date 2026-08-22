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

---

## D-006 — Corridor sections derived from consecutive stops, split on `id` gaps

**Date:** 2026-08-22 · **Task:** T2

**Decision.** Corridor sections are derived from `schedules.json` by grouping
stop records by `train_number`, ordering them by `id`, and taking consecutive
pairs — **splitting the sequence wherever ids are not consecutive**. Sections
are undirected and keyed on the sorted station-code pair.

**Why.** The source has no stop-number field, so ordering had to be established
empirically: `id` runs consecutively in travel order, unbroken for 5,022 of
5,208 trains. Splitting on a gap handles two real defects found in the data:

- Some train numbers carry a **complete duplicate copy** of their stop list
  under a separate id block (train `04857`, ids 11615–11621 then 11813–11819).
  Chaining through would have invented a `JU–PPR` corridor that does not exist.
- A smaller gap means a dropped intermediate stop, so the neighbouring stations
  are not adjacent.

Splitting is asymmetric in its failure mode, which is why it was chosen: it can
omit a real section, but it cannot fabricate one. For a system whose output is a
maintenance plan, inventing a track section is far worse than missing one.

**Alternative considered.** Ordering by `(day, departure_time)` instead. Rejected
on evidence: 659 trains have a stop with no usable time and 22,561 records have a
null `day`, so time-ordering fails outright on ~13% of trains, while id-ordering
covers all of them.

**Validation.** Median section length is 6.6 km (99.2% under 25 km), and for
sections with an independently-published distance the median published /
straight-line ratio is 1.034 — track curving slightly more than a great-circle
line, which is the physically correct answer and not a shape a mis-parse
produces.

---

## D-007 — The data.gov.in ISL timetable corroborates sections but never defines them

**Date:** 2026-08-22 · **Task:** T2

**Decision.** Corridor sections come exclusively from datameet's stop sequences.
The data.gov.in ISL timetable is used only to (a) corroborate sections that
appear in both, and (b) supply real published inter-station distances.

**Why.** The two files look interchangeable and are not. **The ISL file lists
each train's halts, not every station it passes**: its consecutive pairs have a
median straight-line gap of 16.9 km and a maximum of 2,513 km, against 6.6 km
for datameet. Deriving sections from it would have produced "corridors"
spanning hundreds of kilometres and quietly corrupted every downstream
scheduling decision.

This is also why only 3,295 of 10,149 sections are corroborated — expected
behaviour given the two files describe different things, not a data-quality
problem.

**Alternative considered.** Merging both sources' pairs into one section set.
Rejected — it would have mixed true adjacencies with long express hops in a way
that could not be untangled downstream.

**Consequence.** The same limitation exists in weaker form within datameet
itself: a fast train skipping halts yields a consecutive-stop pair that is not
physically adjacent. These are flagged (`derivedFlags.longHop`, 81 of 10,149)
rather than deleted, since the observation is real — but corridor selection in
T4 should prefer unflagged sections with a high `distinctTrains` count.

---

## D-008 — Deterministic processed outputs, with provenance kept separately

**Date:** 2026-08-22 · **Task:** T2

**Decision.** Files in `data/processed/` contain **no wall-clock timestamp**, so
identical raw inputs produce byte-identical outputs. Fetch times, URLs, byte
sizes and SHA-256 hashes live in `data/raw/MANIFEST.json` instead. Both
provenance files are committed to git; the ~98 MB of bulk data is not.

**Why.** Later tasks (T3's calendar, T4's generator, TX3's demo seed) all
re-run ingestion. If every run rewrote the outputs, there would be no cheap way
to tell "the data changed" from "the clock moved" — and the idempotency test
that guards this would be impossible to write.

**Alternative considered.** Embedding `generatedAt` in each output file, which
is the conventional habit. Rejected: it makes every output differ on every run
for no informational gain, since the manifest already records fetch time against
the input hashes that actually determine the output.

---

## D-009 — The occupancy calendar is a separate file, not an edit to `corridors.json`

**Date:** 2026-08-22 · **Task:** T3

**Decision.** T3 writes `data/processed/corridor_calendar.json`, keyed on the
same `_id` as T2's corridors, and **does not modify `corridors.json`**.
`maxDailyBlockWindows` lives in the calendar file and is joined onto the
corridor at seed time (backend, T5/T10).

**Why.** Populating the field in place would have made the two stages
order-dependent in a way that silently breaks: re-running `build_corridors`
alone would blank the windows T3 had written, and T2's own idempotency test —
which hashes `corridors.json` before and after a rebuild — would start failing
the moment T3 had ever run. Each stage now owns exactly one output file and
each rebuilds byte-identically in isolation.

**Alternative considered.** Mutating `corridors.json` in place, which is what
the task description offered as the default. Rejected for the coupling above.
The cost is one join at seed time, on a key that already exists.

---

## D-010 — Occupancy is the transit window over one representative 24-hour day

**Date:** 2026-08-22 · **Task:** T3

**Decision.** A train occupies a corridor section from its **departure at one
endpoint to its arrival at the next**. All trains are projected onto a single
representative 24-hour clock. Free windows are the complement, widened by a
5-minute clearance margin either side, keeping only gaps of 30 minutes or more.

**Why — and what is a fact versus a choice.** The departure and arrival times
are published data. Everything else here is a model:

- Real signalling occupies a *block*, which is not the same thing as a
  station-to-station section, and the published data has no block granularity.
  Transit time is the closest defensible approximation available.
- The source has **no day-of-week or running-days field** in either
  `schedules.json` or `trains.json`, so a weekly calendar cannot be built from
  it. Treating every train as daily deliberately **over**-estimates occupancy —
  weekly specials get counted as daily — which errs towards reporting *less*
  free time. For maintenance planning that is the safe direction: the system
  should never promise a window that is not really there.
- The clearance margin and the 30-minute floor are planning policy, not
  measurements. Both are module constants, and both are echoed into the output
  file's `model` block so a reader of the data sees them without reading code.

The result is corroborated by domain reality: the sections that come out
saturated are the ones that genuinely are. Barkhera–Budni (87%, zero usable
windows) is on the Itarsi ghat, Khandala–Palasdari (77%) is the Bhor Ghat
incline, and Ghaziabad–Sahibabad carries 281 trains a day and yields a single
54-minute window at 01:08. That scarcity *is* the problem statement.

**Alternative considered.** Treating a stop as an instantaneous point
occupancy. Rejected — it would have reported almost every section as free
almost all day, which is both wrong and useless to the solver.

---

## D-011 — Clock-wrap beats the published `day` field for transit duration

**Date:** 2026-08-22 · **Task:** T3

**Decision.** Transit duration is `arrival - departure`, adding 24 hours when
the result is negative (a midnight crossing). The published `day` field is
consulted **only** when that value is already implausible.

**Why.** Measured across all 376,704 usable stop pairs, the two methods agree
on 99.86%. On the disagreements, day-delta arithmetic produces **308 negative
durations and 196 longer than 24 hours** — both physically impossible between
adjacent stations — while clock-wrap produces neither (min 0, max 1439).

**The `day`-null question resolved itself.** The 22,561 records with a null
`day` turn out to be *exactly* the 22,561 records that have no arrival and no
departure either — the co-occurrence is exact, not approximate. They are
route-sequence-only records: they legitimately define stop order for T2's
adjacency derivation, and they simply cannot define occupancy. So there was
never an independent day-handling policy to decide. Every record carrying a
usable time also carries a day.

**Alternative considered.** Trusting `day` as primary, since it is the field
that nominally exists for this purpose. Rejected on the evidence above.

**Guard rail.** Transits longer than 180 minutes are discarded rather than
clamped (99.92% of observed transits fall below it; median is 7 minutes). 318
pairs are dropped this way, and they are counted in
`TIMETABLE_REPORT.json.stopPairAccounting` — where the pipeline asserts that
every one of the 411,680 stop pairs is accounted for as either used or skipped
with a named reason.
