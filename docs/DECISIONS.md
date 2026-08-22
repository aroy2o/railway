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

---

## D-012 — Asset criticality weights: consequence outranks likelihood

**Date:** 2026-08-22 · **Task:** T4

**Decision.** PRD FR2.1 names five criticality inputs but not how to combine
them. The formula is a weighted average on a 0-100 scale:

| Component | Weight |
|---|---:|
| `safety_importance` | 0.30 |
| `trains_affected` (real) | 0.25 |
| `no_alternate_route` | 0.20 |
| `passenger_dependency` (real) | 0.15 |
| `historical_failure_freq` | 0.10 |

**Why, in one principle: criticality is the consequence of failure.** That is
what orders the weights. Safety consequence leads because a signalling
interlocking failure is a different class of event from a ballast deficiency.
Trains affected follows as real operational exposure. Losing the diversion
option raises criticality, because there is nowhere to send the traffic.

Historical failure frequency is weighted **lowest, deliberately**: frequency is
a *likelihood* signal, and FR2.2 scores predicted failure risk separately.
Weighting it heavily here would double-count probability into a score that is
supposed to measure impact.

`trains_affected` is normalised on a **log1p curve, and that choice is
measured, not stylistic.** Train counts span two orders of magnitude (median 24,
max 281). On a linear scale 70.3% of sections fall below 0.2 and the component
stops discriminating between the ordinary majority; on log1p only 10.7% do, and
the middle 80% of sections spread across 0.65 of the range instead of 0.42. The
reference maximum is a fixed constant rather than the maximum of whatever set is
being scored, so an asset's score does not shift when the corridor selection
changes.

**Alternative considered.** Equal weights across all five. Rejected: it implies
a signal failure and a slightly elevated failure count matter equally, which no
asset-management framework would accept.

**Consequence.** The score is a genuine weighted average - the weights are
asserted to sum to 1.0 at import time - so a component can be added later
without silently rescaling every historical score.

---

## D-013 — Corridor selection stratified on two axes, not one

**Date:** 2026-08-22 · **Task:** T4

**Decision.** The 30 corridors carrying synthetic demand are chosen by:
excluding every section T3 flagged `lowConfidence`, splitting the rest into four
utilisation bands (saturated / busy / moderate / quiet), and taking sections at
**evenly spaced percentiles of observed traffic within each band**.

**Why.** Utilisation alone was not enough. The first implementation took the
busiest section of each band, which produced 30 corridors whose train counts all
sat between 134 and 281 - so `trainsAffectedCount`, a real FR2.1 input, barely
varied and criticality scores compressed into 54.7-90.3. Spanning traffic
percentiles as well restored the range to 1-281 and criticality to 27.9-90.8,
and changed the dominant criticality factor from a near-constant to a genuine
mix.

Excluding `lowConfidence` sections matters for a subtler reason: anchoring a
synthetic backlog to a corridor the pipeline itself does not trust would launder
a data-quality caveat into apparently-solid demand.

**Alternative considered.** Seeded random sampling within each band. Unbiased
and simpler, but it gives no guarantee the range is covered at this sample size,
and it drops the recognisable heavily-used sections that make the demo concrete.

**Result.** The dataset has real scheduling tension: 20 of the 26 corridors that
carry tasks cannot fit their whole backlog into a single free window.
Ghaziabad-Sahibabad needs 580 minutes of work against 54 minutes of daily
availability.

---

## D-014 — Distribution fidelity by construction, not by sampling luck

**Date:** 2026-08-22 · **Task:** T4

**Decision.** The department mix is allocated by **exact quota** at the asset
level (largest-remainder), not drawn independently. Severity uses
**Beta(2, 3.5)** mapped onto 1-5.

**Why the quota.** PRD 5.2 states the department mix as a property of the
dataset (Engineering 50 / S&T 30 / TRD 20). At roughly 60 assets, independent
draws miss it badly: the first run produced a 34/42/24 task split, with S&T
over-represented by 12 percentage points through sampling noise alone. A quota
fixes the mix by construction while the shuffle keeps *which* corridor gets
*which* asset type random. The realised task split is 52.8/27.0/20.2 - the
residual comes from tasks-per-asset varying, which is a PRD-specified
distribution and correctly left alone.

**Why Beta(2, 3.5).** Measured over 500k draws against the alternatives:

| Parameters | severity ≥4 | severity 5 |
|---|---:|---:|
| Beta(2, 5) | 4.1% | 0.2% |
| Beta(2, 4) | 8.7% | 0.7% |
| **Beta(2, 3.5)** | **12.6%** | **1.4%** |
| Beta(2, 3) | 17.9% | 2.7% |

Beta(2,4) was tried first and produced a backlog containing zero severity-5
defects. Beta(2,3) was rejected in the other direction — 18% of defects being
severity 4 or above is not "few critical". Beta(2,3.5) keeps 60% of the backlog
routine while giving the critical tier real weight.

**Being straight about this:** the parameter was chosen partly so the critical
tier is populated enough to exercise prioritisation and deferral. That is a
defensible modelling goal - a backlog with no urgent work would not represent
the problem this system exists to solve, and a real block-demand queue does hold
urgent items competing for scarce windows. It is *not* a claim that 12.6% is a
measured Indian Railways figure. No such public figure was available.

**What was not done.** The seed was never re-rolled to fish for a nicer sample.
The realised distribution is reported as it came out, including the fact that
this 89-task backlog happens to contain no severity-5 item (1.2 expected).

---

## D-015 — Honesty framing lives in the data, not only in the docs

**Date:** 2026-08-22 · **Task:** T4

**Decision.** Every synthetic output file carries `"synthetic": true`, a
disclaimer naming the degradation series as simulated and designed for
retraining on real data, the seed, the reference date, and a **field-level
provenance map** splitting `real` / `synthetic` / `computedDownstream`. Every
individual asset and task record also carries `"synthetic": true`.

**Why.** PRD 9.1 requires the predictive-risk framing to be honest, and PRD
Section 5 requires the real/simulated boundary to be visible. A disclaimer that
lives only in a README does not travel with the data - once these files are
seeded into MongoDB and surfaced on a dashboard, the caveat is gone. Putting it
in the payload means the API, the UI and any judge inspecting the database all
see the same statement.

The provenance map exists because the boundary is genuinely mixed within a
single record: an asset's `trainsAffectedCount` and `passengerDependency` are
real measurements, while `safetyImportance` and `historicalFailureFreq` beside
them are simulated. "This file is synthetic" would be too coarse to be honest.

**Alternative considered.** A single top-level flag per file. Rejected as
misleading in both directions - it would hide the real anchoring and overstate
the synthetic content.

---

## D-016 — Calendar stays its own collection; the corridor carries a scalar summary

**Date:** 2026-08-22 · **Task:** T5

**Decision.** `corridor_calendar` is a separate MongoDB collection, as D-009
established for the files. Two things bridge it to `corridors`:

- a **scalar `occupancySummary`** (trains observed, occupied/free minutes,
  utilisation, window count, lowConfidence) denormalised onto the corridor
  document at seed time;
- a **read-time join** on the detail endpoint only, which is where
  `maxDailyBlockWindows` is attached so the API still presents the shape PRD
  Section 15 describes.

**Why.** Embedding was tempting and wrong. A busy section carries hundreds of
merged occupancy windows — the calendar file is 47 MB against the corridors'
10 MB — so embedding would make every corridor *list* query drag window arrays
it never renders. But a list view genuinely needs to sort and filter on
utilisation, and a per-row join for that would be worse. Copying six scalars
solves the list case; the join solves the detail case.

**Alternative considered.** Embedding the whole calendar in the corridor
document. Rejected on the size argument above, and it would have re-coupled the
two pipeline stages that D-009 deliberately separated.

**Staleness note.** The denormalised summary is a copy, so it can drift if the
calendar is rebuilt without re-seeding. That is acceptable because seeding is
all-or-nothing (D-019) — there is no path that updates one collection alone.

---

## D-017 — Human-readable string `_id`s instead of ObjectIds

**Date:** 2026-08-22 · **Task:** T5

**Decision.** Every seeded collection keys on the string id the pipeline
already produced: `GZB-SBB` for a corridor, `AST-GZB-SBB-1` for an asset,
`TSK-00042` for a task.

**Why.** The corridor id is the sorted station-code pair, which is derived from
real data and already unique. Keeping it as the primary key means the same
identifier appears in the JSON file, the database, the API path, the URL bar and
a judge's question — with no translation layer. Generating ObjectIds would have
required a lookup table to answer "show me GZB-SBB".

**Alternative considered.** ObjectId `_id` with the readable id in a unique
secondary field. More conventional, and pointless here: the natural key is
stable, short, and produced deterministically upstream.

**Trade-off accepted.** String keys index slightly larger than ObjectIds. At
10,149 corridors that is irrelevant.

---

## D-018 — `hasSyntheticDemand` is denormalised and indexed, and indexes are built explicitly

**Date:** 2026-08-22 · **Task:** T5

**Decision.** The seed computes which corridors carry generated maintenance
demand and writes a `hasSyntheticDemand` boolean onto each corridor, indexed.
The seed also calls `syncIndexes()` on every model and **awaits it**.

**Why the flag.** Only ~30 of 10,149 real sections carry demand. Without the
flag, finding them means either scanning the corridors collection or querying
assets and then fetching corridors by a 30-element `$in` — two round trips for
something the dashboard does on every page load.

**Why the explicit index build — this was a real bug, not a precaution.**
Mongoose's `autoIndex` starts index creation in the background when a model is
first used, and the seed script closes its connection as soon as the inserts
finish. The builds were being abandoned mid-flight, and the collections ended up
with nothing but the default `_id` index. The filter still returned the correct
30 corridors, so it *looked* fine — `explain()` showed `docsExamined: 10149`,
`keysExamined: 0`: a full collection scan. After the explicit sync it is
`docsExamined: 30, keysExamined: 30`.

The lesson generalises: a correct result is not evidence of a correct query
plan, and index creation must be awaited rather than assumed.

`syncIndexes` rather than `createIndexes` because it also drops indexes no
longer declared, which keeps a re-seed after a schema change honest.

---

## D-019 — The seed replaces collections rather than upserting

**Date:** 2026-08-22 · **Task:** T5

**Decision.** `npm run seed` empties each of the six source-of-truth collections
and reloads them, rather than upserting document by document. It is safe to
re-run and requires no manual database wipe.

**Why.** The source files are themselves deterministic and fully regenerable
(D-008, D-014), so the database is a mirror of them and should match exactly.
Upserting would leave orphans behind whenever the generator's seed or
`CORRIDOR_COUNT` changes and the new dataset is smaller — stale tasks pointing
at assets that no longer exist is a much worse failure than a slower reload.
The full load takes about 20 seconds.

The reload is scoped to the six pipeline collections. It does not touch
schedules, decision logs or audit logs, which the running system produces rather
than the pipeline.

**Verification is part of the script, not just a test.** After loading, the seed
reads back a sample asset, task and provenance record and asserts that
`synthetic`, `fieldProvenance` and the real-anchored `trainsAffectedCount`
survived the round trip, and that `priorityScore` is still null. The failure it
guards against — provenance quietly dropped by a schema change — would otherwise
only surface as a missing badge on a dashboard nobody is checking.

---

## D-020 — SLA compliance is an objective reward, not a hard deadline

**Date:** 2026-08-22 · **Task:** T6

**Decision.** A task may be scheduled into a window after its `slaDueDate`.
Landing on or before the deadline earns an objective bonus (`epsilon`) instead.

**Why.** The data settles it: **17 of the 89 tasks are already past their SLA
date at the horizon start**, and only 9 fall due inside the 7-day window. A hard
deadline constraint would make those 17 permanently unschedulable — which is
exactly backwards. Overdue maintenance is *more* urgent, not ineligible.

PRD 13.1 agrees: it lists SLA compliance under MAXIMIZE as `ε × SLA Compliance`,
an objective term. Section 13's constraint list says "task assigned before
`slaDueDate` **where feasible**", and "where feasible" is the language of a soft
preference.

**Alternative considered.** A hard constraint with overdue tasks exempted.
Rejected as the worst of both: it still blocks a task that is one day late while
waving through one that is sixty days late, and the exemption threshold would be
arbitrary.

**Consequence for T7.** Overdue-ness should be folded into the *priority score*,
where urgency belongs, rather than into feasibility. The decision log already
reports `withinSla` per scheduled task so the shortfall stays visible.

---

## D-021 — A weekly horizon is the daily window pattern replayed per day

**Date:** 2026-08-22 · **Task:** T6

**Decision.** Candidate slots are `(corridor free window) × (day in horizon)`.
A 7-day plan over a corridor with 3 daily windows offers 21 assignable slots.

**Why.** T3's calendar is a single representative 24-hour pattern, because
neither source carries a day-of-week or running-days field (D-010). Replaying it
is the only expansion the data supports. It also inherits D-010's conservatism:
every train counted as daily means the free windows are, if anything,
understated.

**What this does not do.** It cannot lengthen a window. A task needing 173
minutes on a corridor whose longest gap is 54 minutes stays unschedulable no
matter how many days are added — which is precisely what the real corpus shows.

**Alternative considered.** Treating the week as one 10,080-minute timeline.
Rejected: it would let a task straddle midnight into a period the timetable says
is occupied, since the occupancy pattern repeats daily.

---

## D-022 — One search worker and a fixed seed, bought with measured evidence

**Date:** 2026-08-22 · **Task:** T6

**Decision.** `num_workers=1`, `random_seed=20260822` by default.

**Why.** CP-SAT's parallel portfolio returns whichever optimal solution a worker
finds first, so identical input can produce different — equally optimal —
schedules. Measured on the real corpus, three runs each:

| Workers | Solve time | Identical plan across 3 runs |
|---|---|---|
| **1** | **0.64–0.71 s** | **yes** |
| 4 | 0.078–0.097 s | **no** |
| 8 | 0.074–0.080 s | yes (this time — not a guarantee) |

So the risk is real, not theoretical: four workers genuinely returned different
plans for the same input.

Determinism costs about 0.57 s against PRD Section 7's 10-second budget, which
makes it nearly free. A plan that changes when nothing changed cannot be
demoed with confidence, cannot be diffed against a baseline (T8), and cannot be
tested. `num_workers` stays a parameter for anyone who later needs the speed.

---

## D-023 — Objective weights encode a priority order, not a tuning

**Date:** 2026-08-22 · **Task:** T6

**Decision.** Simplified PRD 13.1 objective with these magnitudes:

| Term | Weight | PRD 13.1 |
|---|---:|---|
| Priority-weighted coverage | 10,000 / priority unit | α Maintenance Priority |
| SLA compliance | 2,000 / task | ε SLA Compliance |
| Cross-department batching | 3,000 / window | δ Cross-Department Batching |
| Unused minutes in opened windows | −1 / minute | μ Unused Block Time |
| Windows opened | −500 / window | ν Schedule Fragmentation |

**Why these magnitudes.** They are a rank order, not a fit. Covering even the
lowest-priority task earns 10,000, while the worst possible waste penalty on a
single window is about 1,440 (a full day) plus 500 to open it. So coverage can
never be traded away for tidiness — the correct railway answer, since deferred
maintenance is a safety and reliability cost rather than an inconvenience. The
remaining terms only break ties between plans that cover the same work.

Verified rather than assumed: the hand-built scenario's objective was computed by
hand as `10000×(5+2) + 2000×2 + 3000 − 0 − 500 = 76,500`, and the solver returns
exactly 76,500.

**Deferred terms**, all named in PRD 13.1 and left out here on purpose:
`β` asset risk reduction (needs T16's failureRiskScore), `λ` train delay impact
(T22), `ξ` weather risk (T26), `ρ` resource conflicts (T25). `γ` block
utilisation is covered indirectly by the μ waste penalty rather than as its own
term. Exposing all of them as policy sliders is T23.

---

## D-024 — Structural impossibility is separated from losing a capacity contest

**Date:** 2026-08-22 · **Task:** T6

**Decision.** Before the solver runs, tasks are checked against the longest
window their corridor offers. Those that cannot fit are deferred with
`EXCEEDS_LONGEST_WINDOW` and never enter the model; the rest compete, and any
that lose are deferred with `NO_CAPACITY`. FR3.3 requires a reason, and these
two are different problems needing different remedies.

**Why it matters more than it sounds.** On the real corpus **53 of 89 tasks are
structurally unfittable**, and the pattern tracks utilisation exactly: every
corridor above ~30% utilisation has all or most of its backlog unfittable, every
corridor below ~20% fits everything.

This was checked for artefact before being accepted as a finding. Recomputing
T3's free windows with the clearance margin and the 30-minute floor both removed
rescues **exactly one** task — so the shortfall is real occupancy, not a
modelling choice.

**What it means.** On busy corridors the natural gaps between trains are simply
too short for maintenance. Real railways answer that with a *traffic block* that
displaces trains, accepting delay as the price. That is PRD 9.6's
train-impact-aware planning — task T22 — so the deferral message names it
explicitly rather than just reporting failure.

**A second finding from the same run:** zero tasks were deferred for
`NO_CAPACITY`. Over a 7-day horizon every task that physically fits gets placed,
so the binding constraint on this dataset is window *length*, not block-hours. A
test pins that, and will fail loudly if the character of the problem changes.

---

## D-025 — A reward variable must be free to take the value zero

**Date:** 2026-08-22 · **Task:** T6

**Decision.** The cross-department batching flag is constrained as
`sum(departments_used) >= 2` **enforced only if the flag is true**, rather than
the unconditional `flag <= sum(departments_used) - 1`.

**Why.** The unconditional form is subtly fatal. For a batching-eligible window
that ends up empty, `sum(departments_used)` is 0, so the constraint reads
`flag <= -1` — which a boolean cannot satisfy, making the **entire model
infeasible**.

The hand-built test scenarios all happened to fill their eligible windows, so
21 tests passed against it. The real corpus, where most eligible windows go
unused, returned `INFEASIBLE` on the first run. There is now a regression test
that leaves an eligible window deliberately empty.

**The general rule, worth carrying into T22–T25:** when adding a rewarded
indicator to a CP-SAT model, check it can still be zero in the null solution.
An indicator that is only bounded *above* by a quantity that can go negative
turns an optimisation into an infeasibility.

**Alternative considered.** Adding a lower bound linking the flag to window
occupancy. Equivalent in effect, more variables, and less obvious to read.

---

## D-026 — Priority is an additive weighted score, ordered physical-state-first

**Date:** 2026-08-22 · **Task:** T7

**Decision.** FR2.3 priority is a 0–100 weighted sum:

| Factor | Weight | Why it sits there |
|---|---:|---|
| `severity` | 0.35 | The defect's own observed condition. A rail fracture outranks joint wear wherever it sits, so it leads. |
| `asset_criticality` | 0.30 | The same defect matters more on a high-consequence asset. Real, measured-anchored (FR2.1). |
| `sla_urgency` | 0.20 | Deadline pressure is a compliance signal, not a physical one — it must not let a trivial defect leapfrog a critical one because a date is nearer. |
| `sla_breach` | 0.15 | Escalation for a commitment already broken. Smallest and capped, on purpose. |

**Why additive rather than multiplicative.** Two reasons, the first decisive:
FR2.4 asks *which factor dominated*, and a product has no honest answer — it
cannot be decomposed. Second, a product lets one near-zero factor annihilate the
score, so a critical defect on an asset with little recorded criticality would
rank at nothing. Same reasoning D-012 used for asset criticality itself.

**Measured against the alternatives** on the real 89-task corpus:

| Formula | Tied pairs | Range | Spearman ρ vs severity-only |
|---|---:|---|---:|
| severity only (T6 placeholder) | **1,057** | 1–4 | 1.000 |
| **additive 35/30/20/15 (chosen)** | **11** | 25.0–87.3 | +0.706 |
| severity × criticality | 25 | 8.0–68.8 | +0.773 |
| criticality-dominant 20/50/20/10 | 11 | 24.6–87.0 | +0.461 |
| SLA-dominant 20/20/35/25 | 11 | 18.3–91.7 | +0.596 |

The placeholder left **1,057 tied pairs among 89 tasks** — about a quarter of
all pairs indistinguishable. The chosen formula reduces that to 11 while keeping
ρ = +0.706, so it preserves severity's broad ordering rather than overturning it.

**Criticality earns its 0.30 because it is uncorrelated with severity.** Median
asset criticality is 59–65 across *every* severity band, with heavily
overlapping ranges — so it genuinely reorders tasks within a band instead of
restating what severity already said.

**Alternative rejected on a correctness test, not taste.** The SLA-dominant
weighting inverts the ordering check below: a 60-day-overdue trivial defect
scores 69.58 against a fresh critical one at 39.71. That is not a preference,
it is wrong, and it is what fixes the ceiling on the SLA weights.

---

## D-027 — Overdue urgency lives in the priority score, capped

**Date:** 2026-08-22 · **Task:** T7

**Decision.** Two separate SLA terms. `sla_urgency` ramps 0→1 over 90 days and
holds at 1 once due. `sla_breach` starts at zero and ramps 0→1 over 60 days
*past* due, then saturates.

**Why this was T7's job.** D-020 made SLA soft in the solver, because 18 of the
89 real tasks are already past due and a hard deadline would make them
permanently unschedulable. That deliberately left the urgency of lateness
unmodelled, to be picked up here — which is where it belongs: an overdue task
is not ineligible, it is more important.

**Why two terms rather than one.** They measure different things. Urgency is
"the deadline is pressing"; breach is "the commitment is already broken and by
how much". Collapsing them would either lose the escalation or double-count it.

**Why the cap.** Without saturation, an ancient low-severity task would climb
the queue purely by ageing until it outranked genuinely critical work. Capped at
60 days — the worst case in the real corpus is 58 days overdue — being
three months late ranks the same as two.

**Constants are data-grounded, not round numbers.** The 90-day urgency ramp is
exactly PRD 5.2's longest SLA tier, so it spans one full SLA window.

**A known property, stated rather than hidden.** For any overdue task
`sla_urgency` is pinned at 1.0 (contributing 20) while `sla_breach` contributes
at most 15, so **breach can never be the dominant factor**. That is correct
behaviour — deadline pressure is the headline, lateness is the escalation on top
— but it does mean `sla_breach` will never appear in a FR2.4 "dominant factor"
readout. Observed spread on the real corpus: asset_criticality 48, severity 38,
sla_urgency 3.

---

## D-028 — The priority engine changed the ranking, not the plan — and why that is expected

**Date:** 2026-08-22 · **Task:** T7

**Finding, from a real second solve rather than a remembered one.** Swapping the
severity placeholder for the FR2.3 score leaves the outcome identical:

| Metric | Severity placeholder | FR2.3 priority |
|---|---:|---:|
| Tasks scheduled | 36 | 36 |
| Tasks deferred | 53 | 53 |
| Cross-department batches | 2 | 2 |
| Block utilisation | 74.33% | 74.33% |
| Objective value | 865,815 | 15,525,815 |
| Scheduled task set | — | **identical** |

Twenty-one of the 36 scheduled tasks moved to a different day, but no task
changed from scheduled to deferred or back.

**Why, precisely.** It follows from D-024. Every deferral on this corpus is
structural (`EXCEEDS_LONGEST_WINDOW`), and over a 7-day horizon there are zero
`NO_CAPACITY` deferrals — so priority has nothing to arbitrate. Shortening the
horizon to force contention (1 day → 4 `NO_CAPACITY` deferrals) *still* produces
an identical set, because the contests that exist are ones both orderings agree
on: on BRMD-NIM and DGU-PNB only a single window is long enough for the
competing tasks, and the highest-severity task is also the highest-priority one.

**A correction to an intermediate check.** Aggregate window capacity is not
usable capacity. BRMD-NIM offers 914 minutes across 13 windows, but a ~160-minute
task needs one contiguous gap, and only one window (176 min) qualifies — so
those 914 minutes hold exactly one such job. Any capacity reasoning on this
project must be per-window, never summed.

**Why the engine is still load-bearing.** It reduces tied pairs from 1,057 to
11, so FR2.4's ranked queue is meaningful for the first time, and it decides
contests *on merit* rather than by an arbitrary solver tie-break — on DGU-PNB,
TSK-00032 and TSK-00033 are both severity 2 and indistinguishable to the
placeholder, while FR2.3 separates them 32 vs 41. The moment contention rises —
a shorter horizon, more demand, or T22 opening the saturated corridors — it will
change outcomes too. A test pins the current equality so that shift is noticed
rather than missed.

**One refinement deliberately not made.** The 21 day-shifts happen because the
objective is flat across days for a task whose SLA any day satisfies — the day
dimension is under-determined. Adding an earliness preference would stabilise it
and get work done sooner, but that is an objective change and belongs with T23's
policy weights, not here.

---

## D-029 — The baseline orders by arrival date, deliberately not by deadline

**Date:** 2026-08-22 · **Task:** T8

**Decision.** Within a department, the FR9.1 baseline works its queue by
`date_raised` ascending, breaking ties on task id.

**Why.** PRD Section 12 specifies first-come-first-served, and FCFS means
arrival order. There is no submission timestamp in the data; the date the defect
was raised is the closest honest analogue, and a real block-demand queue is
genuinely worked in the order requests arrive. `dateRaised` has 50 distinct
values across the 89 tasks, so it orders the queue meaningfully rather than
collapsing into a tie-break.

**The alternative was rejected because it would have been too good.** Ordering by
`slaDueDate` is earliest-deadline-first — a genuinely effective scheduling
heuristic. Using it would quietly make the "naive" baseline smarter than the
process it represents, and any comparison drawn against it would understate the
optimizer's advantage while looking rigorous. There is a test
(`test_ordering_is_not_earliest_deadline_first`) specifically to stop that
creeping back in.

**Consequence.** `MaintenanceTask` gained an optional `date_raised` field. It is
additive, defaulted, and untouched by the CP-SAT model — no constraint or
objective logic changed.

---

## D-030 — Departments are blind to each other, not to themselves

**Date:** 2026-08-22 · **Task:** T8

**Decision.** Each department's scheduling pass tracks its own window
consumption but starts from a completely clean view of what other departments
have claimed. Collisions are detected and reported afterwards; they are never
prevented.

**Why the asymmetry matters.** Modelling a department as globally blind would be
a strawman — no planner double-books their own crew, and a baseline that did so
would be beatable by trivially better bookkeeping rather than by coordination.
The complaint in the problem statement is specifically about *cross-department*
visibility, so that is precisely and only what this algorithm lacks. That makes
the resulting conflicts a property of the process rather than of sloppy code.

**Conflicts are the output, not a defect.** PRD Section 12 wants the failure
demonstrated. Two kinds are reported:

* **Double-booking** — two departments holding the same corridor at overlapping
  clock times. Both crews arrive; one is turned away.
* **Over-subscription** — a window claimed for more work than it can hold.

**Blocks are never merged across departments**, even when two departments take
the same window. They did not agree a shared possession; they each requested one,
unaware of the other. Merging them would hide the conflict *and* invent a batch
the algorithm cannot produce.

---

## D-031 — The comparison is drawn from the contestable subset, and the honest headline is not throughput

**Date:** 2026-08-22 · **Task:** T8

**Decision.** T14's comparison must be computed over the **36 structurally
contestable tasks**, not all 89, and must not lead with a task-count claim.

**Why the subset.** 53 of 89 tasks are longer than any window their corridor
offers (D-024). That is a fact about the timetable, identical for both
algorithms. Comparing over the full backlog would credit the optimizer for 53
tasks nothing could have placed. `structurally_contestable()` computes the set
so both engines and T14 use one definition.

**Why not throughput — the finding that matters most here.** Measured on the
real corpus at four horizons:

| Horizon | Baseline scheduled | Optimizer scheduled |
|---|---:|---:|
| 1 day | 32/36 | 32/36 |
| 2 days | 34/36 | 34/36 |
| 3 days | 36/36 | 36/36 |
| 7 days | 36/36 | 36/36 |

**The optimizer never schedules more tasks than the baseline on this dataset.**
Any "the AI schedules N% more work" headline would be false. The real difference
is that the baseline's plan is **not executable**:

| Metric | Baseline | AI-optimised |
|---|---:|---:|
| Contestable tasks scheduled | 36/36 | 36/36 |
| Cross-department batches | **0** | **2** |
| Double-booking conflicts | **6** | **0** |
| Double-booked minutes | **605** | **0** |
| Over-subscribed windows | **3** | **0** |

**And a trap inside the trap: the baseline's utilisation looks better.** It
reports 77.01% against the optimizer's 74.33%. That is not an advantage — it is
the defect showing through. Both place the same 4,880 minutes of work, but the
baseline fits them into 24 windows instead of 25 by stacking 605 minutes into 3
windows that cannot physically hold them. Utilisation must never be shown
without the conflict count beside it, or the screen will read as the baseline
outperforming the optimizer.

**So the honest claim is about coordination and feasibility, not volume:** the
baseline produces a schedule that double-books three corridors and batches
nothing; the optimizer produces one that is conflict-free and shares two
possessions across departments. That is a narrower claim than "the AI does more
work" and it is the one the data supports.

---

## D-032 — The API contract is a clean intermediate shape, not MongoDB documents

**Date:** 2026-08-22 · **Task:** T9

**Decision.** `/optimize`, `/baseline` and `/prioritize` take a narrow payload
describing only what a solve needs — corridors with their free windows, and
tasks with the asset-criticality join already resolved. They do not accept the
documents Node happens to hold, and the Python service still never touches
MongoDB.

**Why.** Two reasons, both about coupling. A schema change in T5's collections
must not break the optimizer; and the contract then documents exactly what a
solve depends on, which is far less than a corridor or task document carries.
It also puts the joins where they belong: only Node can reach the `assets`
collection, so `assetCriticalityScore` arrives already resolved onto the task —
the data flow PRD Section 11 describes.

**`extra="forbid"` on every request model.** An unknown field is a 422, not a
silent drop. This is not pedantry: a typo'd `dateRaisd` would otherwise be
ignored, and the baseline's first-come-first-served ordering would quietly
degrade to "everything sorts last" with no error anywhere (D-029). There is a
test for exactly that typo.

**Validation that Pydantic cannot express** lives in model validators: a task
referencing a corridor absent from the payload, duplicate ids, a dangling
`dependsOnTaskId`, overlapping windows on one corridor. Each returns a 422
naming the offending ids, rather than surfacing as a `KeyError` three frames
inside the solver.

**Alternative considered.** Accepting raw documents and letting the service pick
what it needs. Rejected: it makes the optimizer depend on the database schema,
and it hides which fields actually matter.

---

## D-033 — Responses are returned unfiltered, and pinned by tests instead of a schema

**Date:** 2026-08-22 · **Task:** T9

**Decision.** The scheduling endpoints declare **no** `response_model`. Each
returns the dataclass's own `as_dict()` verbatim.

**Why — this is an honesty risk, not a style preference.** FastAPI's
`response_model` silently *drops* any field the model does not declare. Every
honesty-critical field this project has built would be one schema drift away
from vanishing: `priorityIsPlaceholder`, `usesFailureRisk`, the solver's
`knownGaps` naming the constraints T24 and T25 have not yet implemented, and the
baseline's double-booking report. A plan that quietly stopped reporting its own
gaps would look *better* than the one that reports them — the worst possible
direction for a failure.

That is the same category of risk as D-015 (provenance surviving the database)
and D-018 (indexes actually being built), appearing in a new layer.

So the dataclasses' `as_dict()` stays the single source of truth for the
response shape, and a test asserts each honesty field survives the round trip.
The shape is pinned by something that fails loudly, rather than by a schema that
can quietly subtract from it.

**What this costs.** The OpenAPI document describes request bodies precisely but
responses only loosely, so Node codes against the documented JSON shape and the
tests rather than against a generated response schema. Given the alternative is
a class of silent data loss, that is a good trade.

**Also from this task:** `/baseline` returns `contestableTaskIds` alongside its
result, so T14 cannot accidentally draw the comparison from all 89 tasks
(D-031), and warns explicitly when `dateRaised` is missing rather than letting
FCFS ordering degrade unnoticed.
