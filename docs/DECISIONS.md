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

---

## D-034 — Schedules are appended, never replaced

**Date:** 2026-08-22 · **Task:** T10

**Decision.** Each generation writes a new `schedules` document, keyed
`SCH-<compact ISO timestamp>`. Nothing is overwritten.

**Why.** FR6.3 requires published plans to be versioned with prior versions
viewable for audit. A plan is an *event* — it records what the solver decided at
a moment, against the data as it stood. Overwriting would destroy exactly the
history the approval workflow (T19) and the audit trail need.

This is deliberately the opposite of the seed script's strategy (D-019), and the
contrast is the point: the seed *mirrors* deterministic source files, so the
database should match them exactly and stale rows are a defect. A schedule
mirrors nothing; it happened.

**Shape.** PRD Section 15's fields are all present, and the optimizer's richer
output is stored rather than trimmed — `decisionLog` (which T17 builds
explanations from), `knownGaps`, `metrics`, and the full baseline result. Same
reasoning as T2–T4: discarding a field that already exists only forces a later
task to recompute or re-request it. `blocks[].trainImpact` is present but null,
because train-impact scoring is T22 — null means "not computed", never "no
impact".

**Known limitation.** The id encodes millisecond precision, so two generations
in the same millisecond would collide. Acceptable for a single-controller
prototype; a counter or ObjectId would be needed under real concurrency.

---

## D-035 — Every generation refreshes priority scores; a lighter re-rank path also exists

**Date:** 2026-08-22 · **Task:** T10

**Decision.** `POST /api/schedules/generate` writes FR2.3 scores back onto every
task document. `POST /api/tasks/reprioritize` recomputes the ranking without
running a solve.

**Why generation always refreshes them.** A priority score is not a static
property of a task. It folds in SLA urgency and overdue breach (D-027), both
measured against the date the plan starts from — so a score is only meaningful
relative to a horizon. Leaving last week's number sitting on a task while
showing this week's plan beside it would be quietly wrong in the direction that
matters: a task's urgency grows every day it waits.

**Why the second path exists anyway.** The Controller's priority queue (PRD
Section 8) is useful on its own, and re-ranking is far cheaper than a CP-SAT
run. Making someone wait for a solve to see an updated queue after new defects
are logged would be a poor trade for no benefit.

**What is stored.** `priorityScore` plus the FR2.4 `priorityBreakdown` —
per-factor contributions, days-to-due, overdue flag — and
`dominantPriorityFactor`, mirroring how T4 stored `criticalityBreakdown` on
assets. FR2.4 asks *which factor dominated*, and recomputing that on every read
would be wasteful and could drift from the score it explains.

`failureRiskScore` stays null. T16 owns it, and nothing in this pass invents it.

---

## D-036 — Three optimizer calls in parallel; only the plan is allowed to fail the request

**Date:** 2026-08-22 · **Task:** T10

**Decision.** `/optimize`, `/baseline` and `/prioritize` are called
concurrently with `Promise.allSettled`. A failed `/optimize` fails the request;
a failed `/baseline` or `/prioritize` is recorded on the schedule in
`generationErrors` and generation continues.

**Why not `Promise.all`.** It rejects on the first failure and discards the
others' results — so a baseline timeout would throw away a perfectly good plan
that had already been computed. The plan is the product; the comparison and the
ranking are valuable additions to it.

**Why recorded rather than swallowed.** A schedule with
`comparisonToBaseline: null` and a `generationErrors` entry is honestly
different from one whose comparison genuinely came out zero. T14 can tell them
apart; a silent null could not.

**The comparison is computed once, here, with its caveats attached.** D-031
records two traps a comparison screen would otherwise fall into — drawing the
denominator from all 89 tasks instead of the 36 contestable ones, and rendering
utilisation without the conflict count, which reads as the baseline winning.
Both are structural rather than advisory, so `comparisonToBaseline` carries
`contestableTaskCount`, `structurallyImpossibleCount` and three explicit
`caveats` strings. A screen that renders the numbers without them is making a
claim the data does not support.

---

## D-037 — An `ApiError` message is safe at any status; only unexpected errors are masked

**Date:** 2026-08-22 · **Task:** T10

**Decision.** The Express error handler now passes through `err.message` for any
`ApiError`, and masks to "Internal server error" only for errors it did not
construct.

**Why — a real defect, surfaced by integration rather than by either component.**
The original rule was "never leak an internal exception message", implemented as
`status >= 500 ? 'Internal server error' : err.message`. That is right for an
unexpected throw, whose message may carry a stack detail or a connection string.

But `ApiError` messages are author-written and safe by construction — that is
the class's stated contract. Masking them by status meant the single most likely
operational failure in this architecture, an unreachable optimizer, reported:

```
502  { "code": "BAD_GATEWAY", "message": "Internal server error" }
```

The code was right and the message was actively unhelpful. It now reads
"Could not reach the optimizer service". A genuine unexpected 500 is still
masked, and still logged in full internally — verified by test.

**Worth noting how it was found.** Both the error handler (T1) and the optimizer
client (T1/T9) were tested and correct in isolation. The defect lived in the
interaction: no test had ever asserted what a 5xx *ApiError* looks like to a
client, because until T10 nothing routinely produced one.

---

## D-038 — The priority queue reads task documents, not the schedule's decision log

**Date:** 2026-08-23 · **Task:** T13

**Decision.** The Controller Dashboard's priority queue is built from
`GET /api/tasks`, using the `priorityScore`, `dominantPriorityFactor` and
`priorityBreakdown` fields T10 persists — not from the schedule's `decisionLog`.

**Why.** The decision log carries a task's priority *value* but not the
per-factor breakdown or which factor dominated. FR2.4 asks specifically for "a
visible breakdown of why (which factor dominated)", so the log simply cannot
answer the question the requirement poses.

There is a second reason that matters as much: the decision log only covers
tasks that were part of a solve. A priority queue is for the whole backlog —
including work that has never made it into a plan, which is precisely the work a
Controller most needs to see.

**Follow-up noted, not taken.** `/api/tasks` sorts by severity and SLA date, and
its own source comment says that ordering "will replace this ordering once
scores exist". Scores exist now, so the ranking should move server-side. The
queue sorts client-side for the moment — 89 tasks, trivially cheap — because
this task's scope is explicitly frontend-only and reaching into T10's routes
without flagging it first would be the wrong habit. Worth doing in the next
backend pass.

---

## D-039 — The Controller Dashboard is the landing route

**Date:** 2026-08-23 · **Task:** T13

**Decision.** `/` now redirects to `/dashboard` rather than `/corridors`.

**Why.** PRD Section 8 names the Controller Dashboard "the primary demo screen"
and its build order puts it and the comparison view first, ahead of everything
else. Until this task there was no schedule to show, so `/corridors` was the
only landing page that made sense. Now there is one, and the first thing a judge
sees should be the plan and its reasoning rather than a table of source data.

The read-only data views (`/corridors`, `/assets`, `/tasks`, `/resources`,
`/status`) stay exactly where they were and remain in the nav — they are how you
answer "where did this number come from", which is a question this project
expects to be asked.

---

## D-040 — Unbuilt controls are visibly disabled, and the timeline opens on the day that shows the most

**Date:** 2026-08-23 · **Task:** T12

**Two related decisions about not overstating what exists.**

**The monthly toggle is disabled and says why.** PRD FR3.2 promises weekly and
monthly horizons, and only weekly is real: a monthly plan needs the coarser
corridor-day reservation model of PRD Section 13, which is task T28. The control
is rendered greyed with a tooltip naming the task. Stretching weekly data across
a month would be presenting a plan the solver never produced — the same class of
dishonesty as a fabricated metric, just wearing a UI.

Policy sliders get the same treatment by omission: `policyWeights` is null on
every schedule, so no slider is drawn at all rather than a decorative one that
controls nothing (T23).

**The timeline opens on the first day carrying a cross-department batch**,
falling back to the busiest day. The first implementation opened on the busiest
day, which on the real corpus is a Monday with thirteen blocks and **no batch at
all** — dense, but showing none of the coordination the plan exists to produce.

That is not merely a demo convenience. A shared possession is the thing the
optimizer did that an uncoordinated process could not, so it is the most
informative day to review first. The day strip marks every batch day, so
navigating to the others is one click.

**Cross-department batches are drawn structurally differently**, not just
tinted: the bar splits into a segment per department, sized by each one's share
of the work, ringed in violet with an explicit "shared block" label. A colour
alone would require the viewer to decode a legend; this reads without one, which
is the bar it has to clear given it is the single most important visual moment in
the demo.

---

## D-041 — The backend moves to TypeScript, superseding half of D-001

**Date:** 2026-08-23 · **Task:** maintenance

**Decision.** `/backend` is now TypeScript. This reverses the backend half of
D-001, which chose plain JavaScript. D-001's frontend reasoning stands
unchanged; its backend reasoning is superseded by this entry rather than edited,
so the record shows what was thought at the time and why it changed.

**Why D-001 said JavaScript.** The backend was "mostly thin routing and
orchestration where Zod already validates every boundary at runtime, so a
compile step would add friction without adding much safety". That was true when
it was written — T1's backend was a health endpoint and an error handler.

**Why that no longer holds.** Requested by the project owner, and the codebase
has moved a long way from what D-001 described:

- Seven Mongoose models with nested shapes, and a `schedules` document that
  stores the optimizer's full output.
- An orchestration layer that gathers from MongoDB, maps onto a wire contract
  the optimizer enforces with `extra="forbid"`, and persists the response.
- Exactly the seams D-032 and T10 identified as the risky part — `startMin` →
  `startMinute`, `_id` → `taskId` — which are field-name mappings, precisely
  what a type checker is good at and Zod is not, because Zod validates what
  arrives at runtime rather than what this code sends.

**What the migration actually caught**, none of which was failing at runtime but
all of which was latent:

1. `Schedule.generationErrors` was typed `Mixed` despite having a known shape.
   It now has a real sub-schema.
2. `OptimizedSchedule.blocks` was loosely typed where the persisted block is
   stored verbatim — so the wire type and the stored type are now one type,
   removing somewhere for them to drift apart.
3. An unused `Schedule` import in the seed script, kept honest by
   `noUnusedLocals`.
4. In the tests, `Task.findById().lean()` returning `null` was never handled.
   Correct in practice, unchecked in principle.

**Toolchain.** Node 20 has no native type stripping (that arrives in 22.6+), so
`tsx` runs the dev server, the seed and the tests directly from source, while
`tsc` emits `dist/` for production. The Dockerfile builds then prunes dev
dependencies, so tsc and tsx never reach the runtime image.

`strict` is on, including `noUnusedLocals` and `noUnusedParameters`. Most of the
value of this migration is lost the moment implicit `any` is allowed back in.

**One deliberate looseness.** `validate()` replaces `req.body`/`query`/`params`
with the parsed value, which Express's own types cannot express. Rather than
scatter bare `as` expressions through the routes, there is a single named helper
— `validated<T>(req.query)` — so the assumption is visible at every call site
instead of hidden.

**Cost.** ~3,200 lines across 32 files, no behaviour change. The full real-corpus
loop reproduces exactly: 36/53, 2 batches, 6 baseline double-bookings across 605
minutes, knownGaps 11/5, and the 502 path still reports "Could not reach the
optimizer service".

**Post-conversion audit (2026-08-23).** Re-verified before building T14 on top,
since a rename-only migration would have undermined the entire point:

| Check | Result |
|---|---|
| Source files | 32 `.ts`, **0 `.js`** remaining |
| `: any` / `as any` / `@ts-ignore` | **0 / 0 / 0** |
| Exported interfaces and types | 65 |
| `strict`, `noUnusedLocals`, `noUnusedParameters` | all on, and proven — an implicit-`any` probe file is rejected with TS7006 |
| `tsc --noEmit` including tests | clean |
| Test suites | backend 34, optimizer 120, data 94, frontend 7 + build + lint |

This is a genuine conversion, not a rename. `CLAUDE.md` was the one document
still describing the backend as plain Node/Express and has been corrected.

---

## D-042 — On the comparison screen, the layout *is* the honesty mechanism

**Date:** 2026-08-23 · **Task:** T14

**Decision.** D-031's three framing rules are enforced by the structure of the
comparison screen and by unit-tested logic, not by a disclaimer at the bottom.

**Why this needed deciding at all.** D-031 exists because an earlier session
nearly shipped a false "the AI schedules more work" claim. The natural instinct
when building a product comparison page is to lead with the biggest favourable
number — so the same mistake was available again, now at the pixel level rather
than the data level. Small print at the foot of a page does not prevent it; the
reader has already formed an impression from the largest number they saw.

**How each rule became structure:**

| D-031 rule | How the screen enforces it |
|---|---|
| Draw from the contestable subset, not the full backlog | A scope band renders **before any metric**, stating that 53 of 89 tasks are impossible for both engines, with a proportional bar. The denominator is read before any number. |
| Do not lead with a scheduled-task count | Ordering comes from `buildMetricRows()`, which places conflicts and batching first and tags throughput `no-difference`. The screen renders `headlineRows()` and `supportingRows()` — it cannot promote throughput without changing the tested module. |
| Never show utilisation without its conflict count | Over-subscription is not a sibling row. It is carried **inside** the utilisation row as `pairedWith` and rendered in the same card, so no layout change can separate them. |

The throughput card shows `36 / 36` with an `=` rather than an arrow and a
"no difference" tag, because on this dataset there is genuinely no advantage to
claim. The utilisation card is tagged **"reads backwards"** and says plainly
that the baseline's higher number is the defect showing.

**The rules are executable.** `src/lib/comparison.ts` holds the ordering, the
verdict classification and the pairing, with tests asserting that throughput is
never a headline row, that equal throughput is tagged `no-difference`, and that
utilisation always carries its conflict count. A future edit that headlines
throughput fails a test rather than a dry run.

**Conflicts are shown, not just counted.** The baseline's real conflict report
is rendered as a table: corridor, date, which two departments, the overlapping
window and the minutes. "S&T vs TRD both booked BBPR-SYU from 04:14 to 06:14 on
the 24th" is evidence in a way that "6 conflicts" is not.

**Alternative considered.** A single side-by-side metrics table with the
caveats beneath it, which is what FR9.3 literally describes. Rejected: a table
sorts the eye toward the largest difference, which here is utilisation — the one
number that reads backwards. Grouping by *what the number means* rather than by
metric type is what keeps the reading honest.

---

## D-043 — Overrides are a separate append-only log; the schedule is never mutated

**Date:** 2026-08-23 · **Task:** T15

**Decision.** A manual override (FR6.2) is stored in its own
`schedule_overrides` collection. The schedule document is never edited. The plan
a Controller sees is `effectivePlan` = the solver's blocks with every override
replayed in creation order.

**Why not mutate the schedule.** Two reasons; the second decided it.

1. D-034 treats a schedule as an event — what the solver decided at a moment.
   An override is also an event, so it gets the same treatment.
2. **`schedule.decisionLog` explains the SOLVER's decisions**, and T17 will
   build grounded explanations from it under a hard rule that the LLM never
   invents numbers (PRD Section 18). Mutating `blocks` would leave the log
   saying a task runs at 01:00 while the blocks say 14:00 — the explanation
   layer would then be grounded in something no longer true. Keeping the two
   separate means "what the AI decided" and "what the plan is now" are both
   answerable, which is exactly what an audit needs.

The cost is replaying overrides on read. That is a pure function over plain
data, unit-tested, and the plans are small.

**Scope of a move.** Same corridor, different free window — or defer. A
**cross-corridor move is refused outright**, not treated as a capacity
question: the defect is on that corridor's asset, and moving the paperwork does
not move the cracked rail. That check runs first and says so.

**Repeated overrides.** A task can be overridden any number of times; each acts
on the placement the previous one produced. FR6.2 asks for the "original AI
assignment", which after the second override is no longer the previous
placement — so both are recorded: `fromAssignment` (immediately before) and
`originalAiAssignment` (what the solver decided), preserved indefinitely.

**Regeneration.** Overrides are keyed to a schedule id, and a regeneration
produces a new schedule. Amendments therefore belong to the plan they amended
and do not silently follow the Controller onto a different one — correct, since
a new solve may have placed the task somewhere the override no longer makes
sense.

**`task.status` is deliberately left alone.** It is currently `pending` on all
89 tasks and is written by nothing except the seed — generation does not set it
either. Making it partially accurate here (updating it on override while
scheduling leaves it stale) would be worse than uniformly wrong. Noted as a
follow-up for whichever task takes on the full FR6.1 workflow.

---

## D-044 — Re-validation is written against the failure that is silent

**Date:** 2026-08-23 · **Task:** T15

**Decision.** Every override runs six named checks, each reported pass or fail,
and capacity is measured against the **effective plan** — never the solver's
original blocks.

**The asymmetry that shaped this.** A validator that wrongly *rejects* fails
loudly: a Controller sees an error and complains. A validator that wrongly
*accepts* fails silently, producing a plan that looks valid and cannot be
executed, discovered when a crew is standing on a corridor. The whole design is
aimed at the second.

**The specific trap, and the test for it.** If capacity were measured against
the solver's original blocks, work that an earlier override moved into the
target window would be invisible, and an over-filling move would be accepted.
`ADVERSARIAL: an over-fill hidden behind a prior override is still caught`
stages exactly that: a window the solver left empty, filled by a first override
to 150 of 200 minutes, then a second override attempting to add 100 more.

That test was mutation-checked rather than trusted. Injecting the exact bug it
guards against — measuring capacity against a base-only view — makes it fail,
along with six others. A test that cannot fail is not evidence.

**Why `duration-fits-window` and `window-capacity` are separate checks.** They
answer different questions and the live rejection shows why: a 140-minute task
into a 152-minute window *fits the window* (that check passes) but the window
already held 118 minutes of another department's work, leaving 34 (that check
fails). A single "does it fit" check would have accepted it.

**The UI cannot offer an option the API would refuse.**
`GET /override-targets/:taskId` runs the same validator as the write path, so
the window list a Controller picks from is exactly the set that would be
accepted. The refusal path is still fully implemented, because validity can
change between opening the panel and confirming — demonstrated live by staging
that race.

---

## D-045

**Typed conflicts are grouped by the plan they occur in, and never totalled
across plans.**

T21 gives every conflict a `plan` discriminator — `optimized` or `baseline` —
and `summarise()` nests counts under it. There is deliberately no flat total,
in Python, in the stored document, or in the frontend helper.

The reason is arithmetic that would be true and misleading at the same time.
On the real corpus the optimized plan carries 16 conflicts (11 resource
contention, 5 dependency order) and the baseline carries 9 (6 corridor
double-bookings, 3 over-subscribed windows). A single "25 conflicts" figure
describes no plan that exists. Worse, the two halves mean opposite things:
baseline conflicts are the FR9.1 *finding* — the evidence that the current
uncoordinated process fails — while optimized-plan conflicts are gaps this
system's own solver does not yet close (T24, T25). Summing them would let the
thing being argued against inflate the count attributed to the thing doing the
arguing.

This is the same class of trap as D-031's utilisation figure: a number that is
correct as arithmetic and wrong as a claim. It is handled the same way — by
making the misleading shape unavailable rather than by remembering not to use
it. `groupConflicts()` in `frontend/src/lib/conflicts.ts` takes the plan as a
**required** argument and drops non-matching records; `planTotal()` reports one
plan and has no cross-plan counterpart. Both the Python and the frontend test
suites assert a 1-and-1 mix never surfaces as 2.

**Alternative considered:** a single conflict list with a filter defaulting to
"all". Rejected — the default view would have been the misleading one, and a
screenshot of a default view is what ends up in a pitch deck.

**Also decided here:** `TRAIN_IMPACT_CONFLICT` is named by PRD 9.5 but nothing
in this build detects it (that is T22). It is reported in a `notYetDetectable`
list with a reason, *not* as a count of zero. Zero asserts "we checked and found
none"; the truth is that no check exists. Same distinction as D-015's
`priorityIsPlaceholder`, applied to a conflict type instead of a field.

---

## D-046

**The taxonomy is computed once in the optimizer and stored, not recomputed per
consumer.**

`optimizer/app/core/conflicts.py` converts what the solver and the baseline
already detect into typed records with a resolution strategy each. Both
`/optimize` and `/baseline` attach the result as `conflictReport`; Node stores
it verbatim (`Schedule.conflictReport`, and the baseline's inside the
already-verbatim `baseline` field); React reads it.

Classification could equally have lived in Node or in the frontend, since it is
a pure function of data those layers already hold. It lives in Python because
that is where the detection lives — putting the naming next to the detecting
means a new conflict type is added in one file, and no layer can drift into
classifying the same conflict differently. The frontend's `lib/conflicts.ts`
holds display logic only: labels, ordering, grouping. It never re-derives a
type or a resolution.

**Consequence accepted:** schedules generated before T21 have
`conflictReport: null`. `KnownLimitations` keeps its pre-T21 count-only
rendering as a fallback rather than crashing or showing an empty panel on an
older document.

**A resolution strategy is a label, not an action.** Nothing in T21 changes a
plan. Resource no-overlap is still T25 and dependency precedence is still T24,
and every layer says so: `enforced_by` on each `Resolution`, "classified, not
applied" in the payload note, and "labelled, not applied" in the UI copy.

---

## D-047

**`detect_known_gaps` was returning less than it computed, and this was found by
checking rather than by assuming.**

T21's plan assumed the work was mostly surfacing what already existed. Checking
against the running services showed that was half right. Detection was complete
and the counts were correct (11 resource conflicts, 5 dependency violations,
matching T6). But the per-conflict records carried three fields
(`taskIds`, `sharedResourceIds`, `date`) against the baseline report's seven —
no corridor, no time window, no departments, no overlap. Not enough to render a
row a Controller could act on.

`first_task`, `second_task`, `first_window` and `second_window` were all already
in scope in the detection loop, so enriching the return was additive: no new
detection logic, no change to the model, no change to any count. The fields were
simply never returned.

**Guarded by:** `test_real_conflicts_all_carry_corridor_and_date` in
`optimizer/tests/test_conflicts.py`, which was mutation-tested — reverting the
corridor field to `None` makes it fail — so a future regression to the thin
shape cannot pass silently.


---

## D-048

**The decision log now carries the FR2.3 score and its FR2.4 breakdown, because
`/optimize` was computing them and throwing them away.**

T17's audit measured the log against what an explanation layer would need. Real
numbers, on the 89-task corpus:

| | before | after |
|---|---|---|
| entries carrying the FR2.3 `priorityScore` | 0/89 | 89/89 |
| entries carrying the T7 breakdown + dominant factor | 0/89 | 89/89 |
| entries carrying `department` | 0/89 | 89/89 |
| entries carrying eligible-window count | 0/89 | 89/89 |
| entries recording cross-department batching | 0 | 5 tasks / 2 blocks |
| entries cross-referencing a typed conflict | 0/89 | 18/89 |
| deferred entries with a real reason + detail | 53/53 | 53/53 |

The deferral reasons were already complete. Everything else was not, and the
priority case was the same shape as D-047: `/optimize` calls `score_task`,
which returns the whole breakdown, and the router reduced it to
`.solver_priority` — one rounded integer — before handing it to the model. The
reasoning was computed and discarded on every solve.

**Why the rounding matters.** The log's `priority` is `round(score)`. The
priority queue on screen shows the unrounded score. For a task scoring 39.75 the
log said 40. An explanation sourced from the log would then quote a number one
higher than the number beside it on the same screen — not invented, but wrong,
and wrong in a way that survives review because it looks right. Both are now
reported, labelled, so neither has to be inferred.

**What was deliberately NOT added.** Overrides. D-043 keeps the schedule
immutable so that "what the AI decided" and "what the plan is now" stay
separately answerable, and putting override state into the solver's log would
collapse that distinction. A test asserts the string "override" never appears in
the log. Joining the two is the grounding layer's job (D-049).

Also not added: defect type, asset id and workflow stage. Those are MongoDB
fields the solver never sees, and pushing them through the optimizer to get them
into its log would make the solver carry data it has no use for. They are joined
at grounding time instead.

---

## D-049

**The grounding contract is a pure function, and it is the only thing the LLM is
allowed to see.**

PRD Section 18 requires that the explanation layer never invent numbers. That is
a property of a system, not an instruction to a model, so it is built as one:

```
Node (owns MongoDB)  ->  gathers schedule + tasks + overrides, interprets nothing
Python grounding.py  ->  assemble_context(question, records) -> GroundingContext
Python explainer.py  ->  prompt built ONLY from that context -> Claude
```

`assemble_context` is pure. Same question and records, same context, every time —
asserted directly by `test_assembly_is_deterministic`. The model never receives
the schedule; it receives a flat list of `Fact` records, each carrying the id of
the record it was copied from. That is what makes an answer auditable rather
than merely plausible: every figure it was permitted to use traces to a record a
Controller can open, and the response returns those ids.

The split matters because of what can be tested. What the model is *allowed* to
say is deterministic and fully asserted before any API call. How it phrases what
it says is not, and no amount of testing makes it so. Putting the guarantee in
the deterministic half is the only version of this that can be honestly claimed.

**Overrides are in the context** for the reason D-043 anticipated: the decision
log records where the solver put a task, not where it is now. An explanation
built from the log alone would confidently give a Controller the time their own
override replaced.

**The baseline comparison travels with its caveats** in a single fact. D-031
found the baseline's utilisation reads *higher* than the optimized plan's;
handing a model those two percentages without the caveats is an invitation to
say "utilisation improved", which is false.

**Alternative considered:** assembling the context in Node. Rejected — the
taxonomy, the decision log and the deferral reasons are all authored in Python,
and a second interpretation of them in TypeScript is exactly the drift D-046
avoided for conflicts.

---

## D-050

**The model's output is verified at runtime, not trusted because the prompt was
strict.**

Every other guarantee in this project is a pure function with a test that fails
when it breaks. An LLM is the first component where "it worked once" is weak
evidence: the same prompt can produce different words on different calls.

So the prompt is not the guarantee. `verify_answer` is. It extracts every number
from the model's reply and checks each against the set of values the grounding
context actually contained, plus any the Controller used in their own question.
Anything left over is reported as `ungroundedNumbers`, the API returns it beside
the answer, and the UI renders that answer under a warning instead of styled
like a clean one. Mutation-tested five ways.

**This is a net, not a proof, and the limit is written down as a test.** A
fabricated number that happens to equal some real value elsewhere in the context
passes — `test_the_verifier_is_a_net_not_a_proof` asserts exactly that, so the
blind spot cannot quietly rot into an assumed guarantee. The verifier reliably
catches distinctive invented quantities, which is the failure that actually
occurs ("about 12 trains", "roughly 300 delay-minutes").

**One real bug it forced out.** ISO dates were being split into year/month/day,
so a task due in September put `9` into the allowed set and "9 express trains" —
pure fabrication — verified clean. Months are always 1–12, so this whitelisted a
small integer on essentially every schedule. Dates now contribute their year and
day but not their month.

**Live behaviour is tested separately and never faked.** `test_explain_live.py`
asks each behaviour across several phrasings and several repetitions, and
asserts on the whole set — a model that is grounded four times in five fails.
Those tests **skip** without `ANTHROPIC_API_KEY` rather than passing, so an
absent key can never be mistaken for a verified explanation layer.

---

## D-051

**An honest refusal is a first-class answer, and what cannot be answered is
declared rather than inferred.**

A Controller will ask about train impact, failure risk and approval history,
because a real planning system has them. This one does not: those are T22, T16
and T19. `UNAVAILABLE_TOPICS` names six such gaps with a reason and the task that
would supply each, deterministic keyword detection attaches the relevant ones to
the context, and the prompt instructs the model to decline and say why.

The detection only ever *adds* a caveat; it never suppresses an answer on its
own. Forcing a refusal on a keyword match would decline questions the data can
answer.

**A false caveat is not free**, which a bug proved: substring matching read
"express **t-rain**" as a weather question. Matching is now on a leading word
boundary — which also fixed the opposite failure, where `\bapprove\b` missed
"approved" and "approval", the phrasings a Controller actually types.

**`trainImpact: null` is stated outright** in every context as "not computed",
because a model shown only a block with a missing field could reasonably read it
as "no trains affected". Same distinction as T21's `notYetDetectable`.

**Upstream failure messages now reach the Controller.** `requestOptimizer`
flattened every non-2xx into `Optimizer responded 503`, burying "no
ANTHROPIC_API_KEY is set on the optimizer service" in a details blob. It now
surfaces a string `detail` as the message, and maps the optimizer's 503 to a 503
rather than a 502 — the optimizer is up, one dependency is not, and a Controller
acts on those differently. This is D-037's standard applied one layer out. Only
a string `detail` passes through; a 422's detail is a list of validation
objects, which is debugging output, not a message.


---

## D-052

**The explanation layer's LLM provider is pluggable, and the default is Groq's
`openai/gpt-oss-120b` rather than Claude.**

PRD Section 10 names the Claude API for this layer and CLAUDE.md forbids stack
deviation without asking. This was asked and approved: no Anthropic key is
available for this project, and a differentiator that cannot be demonstrated is
worth less than one running on a free tier. **The Anthropic path is intact and
selected by `LLM_PROVIDER=anthropic`** — switching back is one environment
variable.

Nothing this project claims depends on the vendor. The grounding contract fixes
what the model may say before either provider is called (D-049), and
`verify_answer` checks what it did say afterwards (D-050). The provider decides
only who writes the sentence, and `Explanation.model` records which one did.

### Two findings from actually testing the alternatives

**`groq/compound-mini`'s advertised 70,000 tokens/minute is not real for this
key.** It looks like the obvious pick against `gpt-oss-120b`'s 8,000 — until its
429 arrives reading *"Rate limit reached for model `openai/gpt-oss-120b`"*. The
compound models are agentic systems built **on** gpt-oss and bill against its
budget, so the higher headline figure buys nothing.

**The compound models can reach the internet, which disqualifies them here.**
Asked about the weather, compound-mini attempted a web search and failed the
request with HTTP 413; the same question with `search_settings.exclude_domains:
["*"]` returned a correct refusal and `executed_tools: None`. For a feature
whose entire claim is "every number came from these records", a model that can
read the internet mid-answer can ground a sentence in something no Controller
can audit. At identical effective rate limits, a plain LLM with no tool path is
strictly the better choice.

Search is still suppressed on every compound call rather than left as an option,
and a reply reporting `executed_tools` is **refused rather than displayed** —
belt and braces, because the failure it prevents is invisible in the output.

**`response_format: {"type": "json_object"}` is not used.** It looks like the
right way to protect the citation list, and `gpt-oss-120b` rejects the request
outright under it (`Failed to validate JSON`). The tolerant parser handles the
wrappings that occur in practice, and a lost citation list degrades an answer
rather than failing it.

---

## D-053

**The grounding context has a hard size budget, facts are ranked for survival,
and what is dropped is reported.**

A question naming no task assembled a ~45,000-character prompt from the real
corpus — about 11,000 tokens, which exceeds the per-minute allowance of every
model this service can reach. Not a tidiness problem: those requests simply
fail.

Three things had to be right, and the first two were wrong on the first attempt.

**Sizing must be measured, not estimated.** The char/4 rule of thumb put a real
prompt at ~1,400 tokens; the API's own accounting said 4,241. Dense JSON full of
ids, quotes and hyphens tokenises at roughly 1.3 characters per token. Every
figure in the budget now comes from `usage.prompt_tokens`, not arithmetic.

**Survival must be ranked, not positional.** Dropping facts from the end of the
list discarded the named task's own block and conflicts while keeping generic
plan context — it threw away the evidence and kept the perspective. Facts now
carry a tier: essentials, then evidence about what the question actually named,
then the FR9.3 comparison, then the bounded slice. A second pass was needed
after that, because conflicts involving a *slice* task were inheriting the
"named" tier and outranking the comparison on a question that was purely about
the baseline.

**Dropping must be reported.** `omittedFactCount` travels in the context and the
prompt says outright that further records exist and were not examined, with an
instruction not to claim the plan lacks something. A context that quietly lost
the record holding the answer would produce a confident *"the plan does not show
that"* — a wrong answer wearing the costume of an honest one, which is worse
than either an error or a guess.

**Also trimmed, on the same principle** (keep every figure, drop restatement):
`priorityBreakdown.components` are the pre-weighting normalised values that
`contributions` already expresses in score units; a conflict's
`resolution.explanation` is a paragraph written for the conflicts screen and
contains no number. The bounded slice interleaves batched and deferred entries
rather than concatenating them, because concatenation meant "which tasks share a
block across departments" was answered from a context holding no batched task.


---

## D-054

**The first live run found three defects, and all three were in this project's
own checking, not in the model.**

Twelve real calls against `openai/gpt-oss-120b`, four questions asked three
times each. Ten replies verified clean. The two that did not, plus one outright
test failure, were every one of them a false accusation:

| Reported as | Actually |
|---|---|
| `9` invented in *"…SLA due date (2026-09-18, 25 days to due)"* | The date is real. `numbers()` withholds the MONTH of a stored date on purpose (months are 1–12 and would whitelist a small integer on every schedule) — but the *answer* scanner still split `2026-09-18` into 2026/9/18. Dates are now checked whole, on both sides. |
| `880` invented in *"the same total block minutes (4,880)"* | The figure is real. The number pattern read `4,880` as `4` and `880`. Thousands separators are now folded before scanning. |
| Decline "did not name what is missing" | It did: *"The system does not have train‑impact data…"* — with U+2011, a non-breaking hyphen, which no ASCII comparison matches. Typographic dashes are now normalised before any literal match. |

**The model was correct in all twelve calls.** Every failure was the guard
misfiring.

That direction matters. A verifier that cries wolf on true statements is not
merely noisy — it trains whoever reads the warning to ignore it, and the one
time it fires on a real fabrication it will be dismissed too. A false alarm here
costs more than the check is worth, so all three are treated as bugs of the same
severity as a missed fabrication and each has a regression test.

**None of this was reachable without running the thing.** The deterministic
suite passed throughout: every one of these bugs lived in the gap between what a
stored record looks like (`"2026-09-18"`, `4880`) and what a model writes about
it (`2026-09-18` in prose, `4,880`, `train‑impact`). Hand-built fixtures were
written by the same person who wrote the parser, and they agreed with it. This
is the argument for `-m live` existing at all, and for it being run rather than
merely available.


---

## D-055

**FR2.2 predictive risk: linear trend extrapolation to an intervention
threshold, weighted 0.20, and reweighting the other four to make room.**

### The model, and why not the ones PRD 9.1 also offers

T4 generates each asset as a **constant per-asset decline plus N(0, 0.015)
observation noise** (`data/generators/generate.py::_degradation_history`). Read
before choosing, and it settles the choice: a linear fit is not an approximation
of that process, it is the right functional form, and its two parameters are
exactly the two the generator used.

* **Gradient-boosted classifier / logistic regression** — rejected on a fact
  about the data, not taste: **there are no failure labels.** T4 generated
  health series, not failure events. A classifier would need labels derived from
  the same series it learns from, which is circular, and any accuracy figure
  from it would measure nothing. The user's brief forbids reporting such a
  figure; the cleaner answer is not to build the thing that produces it.
* **Probability of crossing within a horizon** — built, measured, rejected.
  Noise is small relative to the decline, so the predictive interval barely
  straddles the threshold: at six months, 30 of 55 assets scored under 5 and 23
  over 50, with almost nothing between. A near-binary flag is a poor priority
  input.
* **Latest observed health alone** — simpler, and correlates −0.95 with the
  chosen score on this corpus. Rejected because it discards the decline rate,
  and two assets at 0.50 losing 0.04 and 0.01 a month are not equally urgent.

**Chosen:** fit OLS over the 12 monthly points, extrapolate to a threshold of
0.30, and express time-to-threshold as `100 × (1 − t/24)`, clipped.

Both constants are modelling choices and are stated as such. **0.30** sits just
below the lowest current fitted health in the corpus (0.317), which matters: a
higher threshold would report assets as *already* past intervention, which is a
statement about the present dressed up as a prediction. **24 months** — median
time-to-threshold is 8.4 and only 3 of 55 exceed 24, so the cap expresses "not
soon" without flattening the distribution that carries the signal.

**An honest caveat about how much this adds.** On this corpus, current health
and decline rate correlate +0.867, because the generator starts every asset in a
narrow band and declines it at a constant rate. So the risk score is closer to
"inverted current health" here than it would be on real data with varied asset
ages. The model is right; the *synthetic data* under-exercises it. Stated rather
than left for someone to discover.

### Why it earns a weight, and why exactly 0.20

D-026 justified criticality's 0.30 by showing it was uncorrelated with severity
and therefore genuinely reordered tasks. The same test, run on the same corpus:

| | ρ |
|---|---:|
| risk vs severity | **−0.084** |
| risk vs asset criticality | **+0.141** |
| *(D-026's reference)* severity vs criticality | −0.109 |

Near-orthogonal to both, and it reorders inside every severity band (full
0–98 range within bands 2, 3 and 4). It earns its place on exactly the evidence
criticality did.

**Criticality and risk are not the same thing and both stay.** Criticality is
consequence-if-it-fails; risk is likelihood-of-failing — the two axes of a risk
matrix. Collapsing them would lose the distinction a maintenance planner works
in.

**New weights**, replacing D-026's four:

| Factor | D-026 | T16 | |
|---|---:|---:|---|
| severity | 0.35 | **0.30** | still leads: the observed defect |
| asset_criticality | 0.30 | **0.25** | consequence, anchored in real train counts |
| failure_risk | — | **0.20** | likelihood, from simulated data |
| sla_urgency | 0.20 | **0.15** | compliance, still below every physical term |
| sla_breach | 0.15 | **0.10** | smallest and capped, as before |

**Risk is capped below criticality on purpose, and the reason is framing as much
as arithmetic:** criticality is anchored in real measured train counts (T3),
while this score comes from simulated degradation. A synthetic input must not
outweigh a measured one. That single sentence is what fixes 0.20 rather than the
0.25 that scored marginally better on tie count.

**Measured on the 89-task corpus:**

| | ties | range | ρ vs current | physical-first guard |
|---|---:|---|---:|---|
| D-026 (4 factors) | 12 | 25.0–87.3 | 1.000 | **fails** a tight case |
| **chosen 30/25/20/15/10** | 12 | 24.0–84.8 | +0.873 | passes |
| 30/25/15/18/12 | 12 | 23.9–85.9 | +0.926 | passes |
| 28/22/25/15/10 | 11 | 22.6–84.6 | +0.800 | passes |
| risk-from-severity 20/30/15/20/15 | 11 | 24.9–86.9 | +0.899 | **fails** |

The "physical-first guard" is D-026's own correctness test, run on a *tighter*
case than D-026 used (severity 4 vs 1, criticality 80 vs 40, 60 days overdue,
rather than severity 5 vs 1 and criticality 90.75 vs 27.92). D-026's own case
still passes on the old weights — but this nearby one does not: the old formula
scores the overdue trivial defect 54.0 against the fresh critical one at 52.0.
Trimming the SLA terms to make room for risk fixes that as a side effect.

### What changed, and what did not

Ranking moved substantially: ρ = +0.873, median rank move 8 places, max 28, only
3 of 89 unchanged. `failure_risk` is now the dominant factor for 15 tasks.

**The plan did not change at all** — same 36 scheduled, same 53 deferred, same
25 blocks, same 2 cross-department batches, same 74.33% utilisation, identical
task sets. Per D-024, 53 of 89 tasks fit no window on their corridor and the
remaining 36 all fit, so there is no capacity contest for priority to arbitrate.
Same finding T7 reported, and it is stated plainly rather than left for someone
to notice that a headline number was unmoved.

### Honest handling of what it cannot score

* Fewer than 3 observations → `score: null` with a reason. Never a default.
* No declining trend → `0.0` **with** a reason. That is an inference, not a gap,
  and the two are reported differently.
* Already below threshold → `100.0`, and the reason says this reflects the
  current trend rather than a forecast.
* A task whose asset has no score → the priority engine **renormalises the other
  four weights** rather than contributing zero. Contributing zero would push a
  task down the queue for having a data gap — a missing measurement scored as a
  favourable finding, which is the error this project avoids everywhere else
  (D-015, D-045).

### Framing is enforced, not intended

PRD Section 6 lists NG4: claiming this forecasts real failures. So the
disclaimer is stored with the score (`Asset.failureRiskFraming`,
`Schedule.riskModel.framing`), returned by `/risk` both per-assessment and at
the envelope, rendered under the priority queue whenever a risk figure is shown,
and returned by `/explain` as `context.modelFramings` — **independently of
whether the model repeated it**. That last one matters: the prompt asks for the
caveat, and a prompt is not a guarantee (D-050). A test drives the endpoint with
a reply that deliberately omits the framing and asserts it reaches the response
anyway.

### One bug this found in its own reporting

`Schedule.riskModel.applied` first meant "the /risk call returned". On the test
fixture — whose assets have no degradation history — that was `true` while every
task still ranked on four factors, i.e. the field claimed the model had been
applied to a plan it had not touched. It now means "a risk score actually
reached a task".


---

## D-056

**T22 Phase A only: train impact is costed and reported, not made schedulable.**

PRD 9.6 describes train-impact as a term in the objective function. That is
Phase B — letting the solver treat "displace scheduled trains" as a second class
of candidate window, penalised by λ and traded against task priority. It was
scoped out, deliberately, and the reasons are measured rather than budgetary.

### What Phase B would have bought

Every one of the 53 structurally-deferred tasks is rescuable by a traffic block.
Costed on the real corpus: **1 to 16 trains displaced, median 3; 0 to 88 minutes
of displacement, median 22.** So the prize is not marginal — it is the entire
deferred backlog.

### Why not, anyway

**1. The data cannot support a penalty term honestly.** T3's `occupiedWindows`
carry times only; the per-service class was not retained beside them. So the
class split of a displacement is *apportioned* from the corridor's overall mix,
not measured. Reporting an apportioned estimate as information is fine. Putting
it inside the objective function is not: the solver's **choices** — not merely
its reporting — would then be driven by a number the data cannot justify, and
every resulting schedule would inherit that. An estimate you can see is very
different from an estimate you have baked into a decision.

**2. The ripple is total, not local.** D-031's entire comparison framing rests
on a contestable subset of 36 tasks that both engines schedule 36/36. If some of
the 53 become schedulable, "contestable" stops being well-defined, and T7's,
T14's, T16's and the checkpoint's before/after comparisons all need re-deriving
rather than re-running. That is four prior tasks' findings, in a task whose own
scope is already large.

**3. The honest version of Phase B needs T3 extended first** — tagging each
occupied window with its service's class. Then λ multiplies something measured.
That is the sequencing this project has used everywhere else: get the data right,
then let it drive a decision.

Phase A closes what is actually broken today: T21's `TRAIN_IMPACT_CONFLICT` sat
in `notYetDetectable`, `/explain` declined every train question, and D-024's 53
deferrals said "this needs a traffic block" without ever saying what one costs.

### The impact score

Displacing one train costs its tier's weight, times the minutes displaced.
Weights measured against alternatives across the 26 demand-carrying corridors:

| weighting | spread | ties | ρ vs utilisation |
|---|---:|---:|---:|
| flat 1/1/1/1 | **0.00** | **325** | +0.131 |
| binary 2/2/1/1 | 1.00 | 16 | +0.597 |
| moderate 3/2/1/0.7 | 1.44 | 8 | +0.584 |
| **chosen 4/2/1/0.7** | **1.63** | **5** | +0.590 |

Flat weighting is the failure this measurement exists to catch: it produces a
single value on every corridor, so the "score" would carry no information while
looking like it did. The chosen set separates corridors best and ties fewest,
and ρ +0.59 against utilisation shows it is related to how busy a corridor is
without merely restating it. `unknown` sits at 1.0 — neutral, not free, so the
2.8% of services T3 could not classify are not silently costless to displace.

### The measured / estimated boundary, kept structural

`impact.measured` holds trains displaced, minutes displaced and clearance
minutes — all from T3's real timetable. `impact.estimated` holds the weighted
cost and the tier split — apportioned. They are separate objects rather than
separate sentences, so a consumer cannot merge them by accident, and a test
asserts the split.

Delay minutes are **displacement time, not modelled propagation**. This build
has no delay-propagation model, and calling displacement "delay to passengers"
would be the same overreach PRD 9.1 warns about for the risk score.

### Three bugs this found

**The sweep jumped undefined gaps.** Building a block from runs of adjacent
windows first proposed blocks spanning hours the timetable says nothing about;
requiring strict adjacency then made almost every corridor look infeasible,
because T3 deliberately leaves a **clearance margin** so free and occupied
windows never touch. Both were wrong. A traffic block is simply an interval on
the day, and only its overlap with trains costs anything — so the span is placed
freely and boundary-aligned, which a brute-force test over every start minute
confirms is exhaustive rather than heuristic.

**"0 trains" was being reported for corridors whose occupancy was never sent.**
The first end-to-end run said *"a traffic block would displace 0 train(s) for
0 min"* on all 53 tasks — because Node was not sending `occupiedWindows` at all.
Zero and unknown are not the same claim, and the reassuring one was false. The
message now says the cost was not computed when the data is absent, and no
`displacementOption` is attached.

**Mongoose silently stripped the costing.** `deferredSchema` declared only
`taskId/reason/detail`, so `displacementOption` was dropped on write with no
error — D-033's failure mode in a different layer. A regression test now
asserts it survives persistence.

### The conflict type graduated cleanly

`TRAIN_IMPACT_CONFLICT` moved **out** of `notYetDetectable` and **into** a new
`checkedAndClear` list, not into both. On the real corpus the count is **0** —
and that is now an earned zero: every scheduled block is checked against the
corridor's observed occupancy. The solver only ever assigns into free windows,
so a non-zero count would mean the free-window data and the occupancy data
disagree, which is worth detecting rather than assuming. A test asserts that a
real occurrence moves it out of `checkedAndClear` and into the counts.

### One finding worth keeping

**One of the 53 needs no train displaced at all.** TSK-00073 on MQX-RMF needs
174 minutes against a longest free window of 167 — it fits by taking 22 minutes
of clearance margin and crossing no service. Reporting "0 trains" alone would
have called that free. `clearanceMinutes` now travels with every costing, and
placements tie-break on it.


---

## D-057 — The workflow state is a fold over an append-only log, and the two audit logs stay separate

**Date:** 2026-08-24 · **Task:** T19

**Decision.** A schedule's FR6.1 state is **not stored on the schedule
document**. It is derived, on every read, by folding the rows in a new
append-only `schedule_approvals` collection. `schedule_overrides` (T15) is left
exactly as it is. The two are merged into one time-ordered trail at read time by
`getAuditTrail`.

### Why the state is derived rather than stored

The obvious implementation is a `workflowState` field updated in place. It was
rejected because of what D-043 is for.

D-043 exists so `blocks` and `decisionLog` cannot shift underneath T17's
explanations. That guarantee currently has a strong form — *the schedule
document is never written after generation* — which is easy to state, easy to
test, and easy for a later task to keep. Adding one mutable field turns it into
*the schedule document is never written after generation, except for one field*,
and a rule with an exception is a rule people stop checking. The second
exception is always easier to argue for than the first.

Deriving instead keeps the original guarantee intact and costs almost nothing:
the fold is the last row's `toState`, the list route gets every plan's state in
one query, and **no migration is needed** — a schedule with no rows is a draft,
which every schedule generated before T19 genuinely is.

It also makes the state machine auditable by construction. The state *is* the
history, so "how did this plan get here" cannot disagree with "where is it now".

### Why the override log and the approval log are separate collections

PRD Section 15 sketches one `audit_logs` with
`action: "override"|"approve"|"reject"`. This build stores two and joins them.

**They have different arity.** An override is keyed `(scheduleId, taskId)` and
is a delta on one *placement*: it needs `fromAssignment`, `newAssignment`,
`originalAiAssignment`, and a six-check re-validation of that move. An approval
is keyed `(scheduleId)` alone and is a verdict on the *whole plan*: no task, no
assignment, and a re-validation of a different kind. In one table, four fields
would be structurally null on every approve/reject row — a union pretending to
be a table.

**Each collection keeps one writer.** `scheduleOverrides.ts` is the only writer
of overrides and `scheduleApprovals.ts` the only writer of approvals, so the
append-only invariant is enforced in one place per collection rather than in one
place for two different invariants.

**And merging would mean rewriting T15.** Its collection is tested and governed
by D-043; changing its shape to fit a sketch *is* rebuilding it.

The PRD's `audit_logs` is honoured as what it is actually for — the merged view
at `GET /api/schedules/:id/audit`. Storage and presentation are allowed to
differ, and this is the same split D-043 already made when it computed
`effectivePlan` on read instead of storing it.

### The transitions, and why exactly these

```
draft        --submit-->  under_review
under_review --approve--> approved      (guarded by whole-plan re-validation)
under_review --reject-->  rejected      (terminal)
approved     --publish--> published     (terminal)
```

**Re-validation is not a state.** FR6.1 draws it between Accept and Final
Approval. A state a plan can only be in for the duration of one request is a
state nobody can observe, so it is the *guard* on `approve` instead.

**`rejected` does not return to `draft`.** Rejection is not a dead end for the
*process*, because the way forward is to regenerate — and by D-034 that is a new
document anyway. Allowing revise-and-resubmit on the same id would buy nothing
and would mean "who approved SCH-X" had different answers at different times.

**Approving does not check the solver's known gaps.** Every plan on this corpus
carries T24/T25 conflicts (11 resource, 5 dependency on the real run), so
blocking on them would make every plan unapprovable. They are recorded on the
approval row as `knownUnresolved` instead: an approval is a human accepting known
risk, and a signature has to state what was known-unresolved when it was given.

### What happens to overrides

**Nothing.** D-043 already keyed them to a schedule id, so a regeneration
produces a new plan and amendments stay with the plan they amended. T19 adds one
gate in front of `recordOverride` — the plan must still be open — and changes
nothing below it.

**A rejected plan's overrides are kept, not deleted.** Deleting audit records
because a plan was discarded is the opposite of an audit trail.

---

## D-058 — Publishing freezes a plan by refusing writes, not by snapshotting it

**Date:** 2026-08-24 · **Task:** T19

**Decision.** `published` is terminal, and no override is accepted on a
published plan. The freeze is enforced entirely by that refusal. Nothing is
copied, and the schedule document is still not written to.

**Why not snapshot.** Storing the effective plan at publication would create a
second source of truth for what the plan is, and the two could disagree — the
exact problem D-043 avoided by never mutating `blocks`. It is also unnecessary:
immutable base blocks plus a closed override log reproduce the published plan
deterministically, forever.

This is the sense in which the freeze is **additive to D-043 rather than a
workaround of it**: it adds a rule about what may be *written next*, and takes
nothing away from what is already immutable.

**The one input the freeze does not cover, and what is done about it.**
`applyOverrides` reads task durations from the `tasks` collection, which the
freeze says nothing about. This build never edits them — nothing but the seed
writes `estBlockDurationMins` — so the risk is latent, not active. Latent is not
absent, so publication records a `publishedPlanDigest`: a hash over corridor,
date, window, times, task ids and the deferred set. `GET /:id/audit` re-derives
it and reports `digestMatchesPublished`, and the plan-level re-validation
includes a `booked-minutes-match-task-durations` check aimed at the same drift.

The digest was mutation-tested by writing an override straight into the
collection, past the API that refuses it: the check goes false, and true again
when it is removed. A verification that cannot fail is decoration.

**Why the version number is assigned at publish, not at generation.** FR6.3's
versions are dense (1, 2, 3…) and count *published* plans. Ten discarded drafts
should not make the second issued plan "version 11".

**`/api/schedules/published` is deliberately a different query from `/latest`.**
Generating a new plan does not retract the published one. `/latest` is the newest
plan; `/published` is what crews are working to. Conflating them would show a
department a possession nobody has approved — and PRD Section 8 gives engineers
a read-only view of exactly the published one.

---

## D-059 — Ids and instants are checked as what they are, not as the integers they contain

**Date:** 2026-08-24 · **Task:** T19

**Decision.** Before the grounding verifier scans an answer for numbers, it
removes whole ISO instants, whole ISO dates, cited record ids, and anything
matching this system's generated-id shape (`APR-20260824025855658-approve`).
Instants and dates are then checked as *strings* against the values the context
actually held.

**Why.** Three live runs during T19 produced three false accusations, all of the
same shape and all of them the checker's fault:

| the model wrote | flagged as invented | why it was wrong |
|---|---|---|
| `APR-20260824025855658-approve` | `20260824025855658` | a citation, and the prompt asks for citations |
| `2026-08-24T02:59:09.017Z` | `9` | a date-only strip left `T02:59:09Z` to be read as quantities |
| the same, both rows | `55`, `9` | as above |

This is the third, fourth and fifth instance of the pattern D-054 recorded, and
the reason it keeps mattering is asymmetric: **a verifier that cries wolf is
worse than no verifier**, because a Controller who sees it flag correct answers
learns to ignore the one flag that is real. The whole value of PRD Section 18's
check is that it is believed.

**Nothing is lost.** Whether a cited id exists is already checked separately and
exactly, as `unknownRecordIds`. A fabricated instant is still caught — as an
instant. A distinctive invented quantity (`987654`) is still caught. Short ids
like `TSK-00042` are deliberately left in the scan.

**Two related fixes, both surfaced by the same runs.**

`_normalise_number` routed every value through `float`. Above 2^53 that cannot
hold an integer exactly, so the 17-digit id timestamps this system generates came
back off by one or two — and the *same* value could normalise differently
depending on which side of the check it arrived from. Whole-number strings now
bypass `float` entirely.

`numbers()` used to strip a date and then feed the leftover clock into the
allowed set, so `02`, `59` and `09` from a sign-off time became quotable
integers. That is a false *clearance*, the mirror of a false accusation: a
fabricated "9 trains" would have passed on any plan approved at nine minutes
past. Instants now contribute their year and day only — the same withholding
rule the month already had.

---

## D-060 — The approval framing is not a model framing, and approval facts are never keyword-gated

**Date:** 2026-08-24 · **Task:** T19

**Two decisions from the same source: T19 removing `approval and audit history`
from `UNAVAILABLE_TOPICS`.** That claim became false the moment the workflow
existed, and the precedent is now established three times — T16 removed its own
"risk model not built" line, T22 removed "no train-impact data", T19 removes
this. A system that keeps asserting a limitation it has since fixed is as wrong
as one that overclaims, just in the flattering direction.

**What replaces it is attribution, not silence.** What an approval answer can
now get wrong is *who*: this build has roles, not user accounts, so a sign-off
is attributable to `controller` or `drm` and to a timestamp, and to nothing
finer. Naming an individual would be inventing the most quotable detail in an
audit trail.

**Why it is `workflow_framing` and not `model_framing`.** The prompt attaches a
"this came from a model trained on simulated data" disclaimer to every
`model_framing` fact. An approval record is the opposite of a model output — it
is a stored fact about what a human role did. Filing it under the same kind
would have made the system disclaim its own audit trail as simulated: false, in
the humble direction, which is still false. It still renders beside the answer,
because `model_framings()` collects both kinds.

**Why approval rows are never keyword-gated.** They were, at first — promoted
only when the question matched an approval trigger. A live run broke it
immediately: *"Who signed this off?"* matches neither `sign off` nor
`signed off`, the rows were dropped by the size budget, and the answer came back
as a **decline** claiming the role was not in the data — one second after the
same plan answered *"Who approved this plan?"* correctly. **A system that
declines depending on phrasing is worse than one that declines consistently**,
because a Controller cannot tell which of the two answers to believe.

The gate was also unnecessary. The state machine bounds the list structurally:
the longest legal path is `submit → approve → publish`, so a plan can never
carry more than three rows, and each already drops its six pass/fail check
lines. Verified across five phrasings against the live model, plus the draft
case on a second plan.

**One thing the size budget did force.** The attribution framing fact *is* gated
— attached when the question raises approvals or the plan has been through the
workflow. Attaching it unconditionally pushed a named task's own override past
`MAX_CONTEXT_CHARS`, which is D-053's failure exactly: a caveat displacing the
evidence the question asked for.

---

## D-061 — Every objective weight reshapes placement, none change coverage; the slider range is the widest verified safe

**Date:** 2026-08-24 · **Task:** T23

**The question, asked before any slider was built.** D-024 found that on the
real 7-day corpus, every deferral is `EXCEEDS_LONGEST_WINDOW` — structural,
not a contest loss — and zero tasks are ever deferred for `NO_CAPACITY`.
D-028 found that swapping the entire priority engine left the scheduled set
identical, because there was nothing to arbitrate. Before building sliders for
five weights, the honest question was whether that finding holds for **all**
of them, or whether some were about to be built as decoration.

**Method.** `solve_schedule` already took `weights` as a parameter (T6), so no
code was written to answer this — the real corpus was run directly against it,
once per weight, at five multipliers of its D-023 default (0.1x, 0.5x, 2x, 5x,
10x), diffing the resulting `scheduled_task_ids` and per-task placement
(corridor, day, window) against the default run.

**Finding.** At every multiplier tested, for all five weights:

| Weight | Scheduled set changed | Placements moved (of 36) |
|---|:---:|---:|
| coverage (α) | never | 13–24 |
| sla_compliance (ε) | never | 13–23 |
| batching (δ) | never | 7–11 |
| unused_minute (μ) | never | 0 at ≤0.5x (rounds to no-op), 17–20 above |
| fragmentation (ν) | never | 19–25 |

Every placement change moved a task to a **different day**, not just a
different window on the same day — genuinely visible on the Gantt, not a
same-day reshuffle.

**This is the opposite of the guess going in.** D-024/D-028 predicted batching
and fragmentation as the plausible candidates, on the theory that they affect
tie-breaking rather than contests. What the run showed is broader: on this
corpus **every** term is a tie-breaker, because D-028 already noted the reason
— "the objective is flat across days for a task whose SLA any day satisfies,"
so the day dimension is under-determined for most of the 36 scheduled tasks,
and any weight nudge resolves those ties differently. Coverage moved as much
placement as anything else; it just never changed *which* 36.

**The honest framing this forces.** A slider UI cannot claim to control "how
much gets done" on this dataset — nothing does, structurally, until T22 Phase
B or a shorter horizon changes the character of the problem. What sliders
honestly demo is **when and how work is arranged**: which day, how tightly
packed, how much cross-department batching. The UI copy says this explicitly
rather than let a Controller assume otherwise.

**The safety bound.** Pushed further out (coverage down to 100, fragmentation
and unused_minute up to their probed ceiling), the scheduled set **did**
collapse — 36 down to 27, then to 3 at coverage=1 — confirming D-023's "coverage
is never traded for tidiness" is a property of the *chosen magnitudes*, not a
structural guarantee that survives arbitrary weights. The range exposed to a
Controller is therefore bounded to **[0.1x, 10x] of each D-023 default**, and
that range was verified safe not just per-weight but in worst-case
**combination** — coverage at its floor together with fragmentation and
unused_minute simultaneously at their ceiling still schedules all 36. The
nearest known-broken point (coverage at 0.01x with the same ceiling, 27
scheduled) sits a further 10x outside the allowed range, so the bound has a
wide margin rather than sitting on the edge of the failure.

A fixed multiplier range was chosen over deriving a formula from the corpus's
minimum priority score (24, empirically) because a formula tied to today's
data would need re-deriving the moment the corpus changes; a margin this wide
does not need to be re-verified for every new dataset.

**Enforcement.** `PolicyWeightsIn` (optimizer) validates the bound and rejects
outside it — never clamps, per PRD Section 6's stance that an invalid input is
refused and explained, not silently reinterpreted. Node's `policyWeightsSchema`
duplicates the same simple numeric range so the rejection is immediate rather
than round-tripping to the optimizer for the same answer; this is the same
kind of duplication as the override reason's `min(8)` already living in both
layers (FR6.2), not a second state machine of the kind D-057/D-060 warn
against — a numeric bound cannot drift the way a transition table can.

---

## D-062 — `policyWeights` stays a plain stored field; D-057's "derive, do not store" rule does not apply to it

**Date:** 2026-08-24 · **Task:** T23

**The question.** D-057 made the FR6.1 workflow state a *fold* over an
append-only log rather than a field on the schedule document, specifically so
D-043's immutability guarantee could gain no exception. `policyWeights` is
about to become a real, populated field on the same document for the first
time. Does it need the same treatment?

**Decision: no.** `policyWeights` is stored as a plain field, written once at
`Schedule.create()` and never updated afterwards.

**Why the two are different in kind, not just in degree.**

Workflow state needed deriving because it **changes after the document
exists** — a plan is `draft` when generated and may become `under_review`,
`approved`, `published` or `rejected` hours or days later, through actions a
Controller takes against a document that has already been persisted. Storing
it as a field would have meant writing to the schedule document after
generation, which is exactly the second mutable surface D-043 exists to
prevent (see D-057's reasoning in full).

`policyWeights` **never changes after the document exists.** It is not a state
the plan moves through; it is an input the solve was run with, fully decided
before `solve_schedule` is ever called, and unaffected by anything that
happens to the plan afterwards — an override, an approval, a publication. A
plan cannot get a *different* `policyWeights` any more than it can get a
different `horizonStart`. It is written once at generation, alongside
`objectiveValue` and `solveSeconds` — themselves plain fields, for the same
reason.

**The general rule this confirms, not overturns.** D-057's principle is "derive
what changes after creation; store what does not" — not "derive everything on
a schedule document, in general." `blocks` and `decisionLog` are also plain
stored fields, because they too are decided once, at generation, and D-043
never asked them to be folds. `policyWeights` belongs in that category, and
checking it against D-057 explicitly (rather than assuming by analogy) is what
confirms it, rather than merely asserting it.

**What would have changed the answer.** If a future task let a Controller
re-weight and re-solve *the same* schedule document in place — rather than
D-034's existing rule that any new solve is a new document — `policyWeights`
would need the fold treatment too, for exactly D-057's reason. That is not
this system's model: T20's what-if simulation and a slider move both produce a
**new** schedule (D-034), so the question never arises.

---

## D-063 — The task-id false accusation was invisible in every prior live run for one reason, and that reason is why it needed a deliberate audit

**Date:** 2026-08-24 · **Task:** T23

**Found by design, not by a live failure.** T19's report promised a specific
follow-up: before touching T23, spend the time asking what other
structured-looking strings this system's data generates could collide with the
grounding verifier's number scanner, rather than waiting for a sixth live
accusation. This is what that audit found on its first check.

**The bug.** `verify_answer` strips known-safe id shapes (dates, timestamps,
cited record ids, the `SCH-`/`OVR-`/`APR-` generated-id pattern) before
scanning an answer's remaining text for numbers. Task ids - `TSK-00042` - were
never added to that list. `TSK-00042`'s digits parse as the number 42, and
unless 42 happens to coincide with some other real value in the context, the
verifier reports it as invented.

**Why five prior live runs never surfaced it.** `verify_answer` also
whitelists every number that appears in the CONTROLLER'S OWN QUESTION - "echo
the asker is not fabricating" (test 
`test_numbers_the_controller_supplied_are_not_treated_as_invented`, T18). Every
one of D-054's and D-059's live catches happened to be a question that named
the same task or record the answer then discussed, so the task id's digits
were coincidentally whitelisted by the echo path before the missing strip
could ever matter. The bug was real from T18 onward and load-bearing on the
single most common sentence shape this endpoint produces - "TSK-00042 was
deferred because..." - and stayed invisible because nobody had asked a
question shaped like "what got batched today?", which answers by naming tasks
the question never mentioned.

**Reproduced directly, then confirmed live.** `verify_answer("TSK-00099 and
TSK-00013 share a window today.", ...)` on a context that never mentioned
either id returned `ungrounded_numbers: ['99', '13']` before the fix. Over the
real HTTP path, asking the live schedule "Which tasks were batched together?"
- a question that cannot echo the task ids its own answer would need to name -
returned `TSK-00004, TSK-00006 and TSK-00007` with `grounded: true` after it.

**The fix.** `TASK_ID_PATTERN` (already defined in `grounding.py` for
reference extraction) is stripped from the answer text before the number scan,
alongside the existing timestamp/date/id strips. `CORRIDOR_ID_PATTERN` is
stripped too, though corridor ids contain no digits and were never actually at
risk - added for symmetry, so a future corridor-naming convention with digits
in it cannot reintroduce this silently.

**What the audit did NOT find a live-reproducible case for, and left as a
named residual risk rather than a fix.** Asset ids (`AST-<corridor>-<index>`)
and resource ids (`RES-<depot>-<slug>`) were checked. Resource ids contain no
digits. Asset ids end in a small index (1-3 digits, no leading-zero padding),
which is lower-risk than a task id for two reasons: assets are named in an
Ask-the-Planner answer far less often than tasks (the decision log's subject
is always a task), and an unpadded 1-3 digit index is far more likely to
coincidentally coincide with a real small number already in context (a
severity score, a count) than a task id's zero-padded 5-digit run is. Not
fixed pre-emptively, because a strip added without a reproducing case is a
guess, and this project's standard - PRD 9.1's own framing rule - is to state a
residual risk plainly rather than paper over it with an untested fix.

**The standing practice this confirms.** D-059 named the general shape -
"the verifier flagged a correct answer as fabricated" - as a pattern worth a
deliberate audit rather than only reactive fixes. This is that audit's first
result, and it found the single highest-frequency instance of the pattern
across all six now-fixed cases. The audit is not closed permanently: any new
id-shaped field this system starts surfacing in an answer (a future
`resourceId`, an asset id used more heavily once T16's per-asset framing grows)
should get the same fifteen-minute check before it ships, not after it fails
live in front of a judge.

---

## D-064 — A what-if result needs no persistence at all, not even a derived one

**Date:** 2026-08-24 · **Task:** T20

**The question, framed by D-057's own checklist rather than answered by
analogy.** D-057 decided FR6.1's workflow state needed a *fold* over an
append-only log because it changes after the schedule document exists.
D-062 decided `policyWeights` needed no fold, only a plain field, because it
is decided once and never changes afterwards. T20's what-if result is a third
case, and the honest way to place it is to ask the same question D-057 first
asked: does anything here change after it is computed?

**Decision: no persistence, of any kind.** Not a field, not a fold, not a
side collection. `POST /whatif` (optimizer) and `POST
/api/schedules/:id/whatif` (Node) are pure request/response computations.
Nothing is written to MongoDB. A what-if result exists for the duration of one
HTTP response and then is gone, by design.

**Why this is the correct generalisation, not a shortcut.** A what-if answer
is a pure function of five inputs: the task backlog, the corridor calendar,
the horizon, the objective weights, and the candidate task id. Given the same
five, `generate_whatif` returns the same answer, proven directly by
`test_whatif_never_mutates_the_scenario_it_was_given` running the real
endpoint twice and diffing the results (D-022's fixed-seed determinism is
what makes this a provable equality, not merely a likely one). There is
nothing for a later read to need that a fresh computation cannot reproduce
exactly - which is the one condition under which D-057's "derive, don't
store" principle collapses all the way to "don't store at all, not even
derived."

**This also settles PRD FR5's own framing.** The PRD calls this feature
*simulation* deliberately - a Controller is asking a hypothetical, not
recording an event. D-034 made a schedule an append-only record of something
that happened; D-043 made an override the same for an amendment that
happened; D-057 made an approval the same for a decision that happened. A
what-if never happens to anything - it is asked and answered, and the
schedule this scenario describes is exactly as it was before the question,
which is the property FR5 needs in order to be safe to explore freely.

**What this means for the route.** `POST /api/schedules/:id/whatif` still
takes a schedule id - not because anything is read from or written to that
document, but because it is where the CURRENT tasks, corridors and (critically)
the ORIGINAL `policyWeights` come from, so the what-if's baseline solve
reproduces the same plan the schedule already records, and the comparison is
against something real rather than a freshly-guessed baseline.

---

## D-065 — Applying a what-if option reuses T15's override unchanged, scoped to only the task asked about

**Date:** 2026-08-24 · **Task:** T20

**The question.** A Controller who likes a what-if option should be able to
keep it. FR5.3 lets them pick *any* option, not only the recommended one. How
does "keep it" reach the live schedule, given the task's own scope boundary:
*"no shortcut around FR6.2 just because this feature is new"*?

**Decision.** There is no new commit path. "Apply this option" on the
frontend calls the SAME `POST /api/schedules/:id/override` T15 already built
and T19 already gates - unchanged, not extended, not bypassed. A what-if
"move" option becomes exactly the override request T15's panel already sends
(`taskId`, `targetDate`, `targetWindowIndex`, a reason); a "defer" option
becomes exactly T15's defer request. Every re-validation check T15 runs,
every workflow-state gate T19 added in front of it, runs identically, because
it is the identical code path.

**Why applying is scoped to ONLY the candidate task, never the side effects
shown alongside it.** A what-if's diff can show OTHER tasks reshuffling days
as a side effect of the re-solve (T23/D-061's volatility, confirmed to apply
here too - see the `whatif.py` module docstring). Those are shown for
information: "here is what re-optimising around this change would also move."
They are never applied automatically. Two reasons.

First, consent: a Controller asked about ONE task and should not have several
others silently moved as a rider on that answer - FR6.2's mandatory reason
field exists precisely so every change is deliberate and attributable, and an
auto-applied side effect would have no reason of its own.

Second, honesty about what "applying" even means here: the side-effect tasks'
NEW placements are only optimal in the hypothetical world where the candidate
task was ALSO moved via a full re-solve. T15's override mechanism does not
re-solve anything - it replays a delta on top of the existing plan (D-043). If
the side-effect moves were applied as a batch of separate overrides, the
result would not be the coherent re-optimized plan the what-if showed; it
would be an approximation of it, achieved by a mechanism that was never
designed to produce it. The one action that DOES produce the real re-optimized
plan is Generate schedule (T10, extended by T23) - already built, and already
the correct tool for "I want the whole plan re-solved," which is a different
request from "I want to override one task."

**What this rules out, on purpose.** No new `apply-whatif` endpoint, no new
persisted "pending what-if" state, no batch-override mechanism. The feature's
entire write surface is the override endpoint that already existed before
this task began.

**Confirmed live, not just reasoned through.** Driving the real UI end to
end: applying TSK-00058's recommended move (which the diff had already
flagged as reshuffling 14 other tasks' days) was correctly REFUSED by T15's
own re-validation - *"Window 11:02-13:02 on 2026-08-24 already holds 95 min
of work, leaving 25 min. Task needs 100 min."* That window is only free in
the hypothetical world where the other 14 tasks also moved; T15's override
replays a delta on the CURRENT plan, where it is not. This is the reasoning
above ceasing to be theoretical: a Controller applying a heavily-reshuffled
option hits a real, correctly-explained rejection, not a silent corruption of
the plan.

The clean path was confirmed too, on a different task whose two move options
both showed zero reshuffle: the override succeeded, all six T15 checks
passed, `originalAiAssignment` correctly preserved the solver's own
placement, `schedule.blocks` stayed byte-identical (D-043 held), and
`effectivePlan` reflected the new placement through the replay - exactly the
D-043 mechanism already in production, doing exactly what it has always
done, now reached from a second entry point.

---

## D-066 — Dependency precedence means "completes before starts", enforced as a hard constraint, and it was already being violated on the real corpus

**Date:** 2026-08-24 · **Task:** T24

**The semantics question, settled by evidence already in the codebase rather
than guessed.** PRD 9.7's own wording is exact: *"a task cannot be scheduled
before its prerequisite completes"* (PRD line 438) - not "on a later day."
T6's `detect_known_gaps` had already been comparing
`(prerequisite.day, prerequisite.end_minute) > (dependent.day,
dependent.start_minute)` to flag a violation, for reporting only, since T21.
Rather than invent a coarser day-only rule, T24 makes the CP-SAT constraint
match that exact comparison exactly - so the hard constraint and the
post-solve check can never disagree about what counts as a violation. This
also turned out to matter concretely: the real corpus has a genuine same-day
case (TSK-00053 finishes at minute 429, TSK-00054 starts at minute 1143, same
day) that a day-only rule would have needlessly pushed to a second day.

**Mechanism.** Two additions to `solve_schedule`, both gated on
`depends_on_task_id`:
1. A pre-solve fixed-point pass: if a task's prerequisite is itself
   structurally deferred (`EXCEEDS_LONGEST_WINDOW` / `NO_WINDOW_ON_CORRIDOR`),
   the dependent is deferred too, with a new code,
   `PREREQUISITE_UNSCHEDULABLE`, naming the blocking ancestor. Looped to a
   fixed point so a 3-stage chain (T4's `inspection -> repair -> testing`)
   cascades fully, not just one hop.
2. A hard CP-SAT constraint on every remaining dependent: `sum(assign[dep]) <=
   sum(assign[prereq])` (scheduled at all implies the prerequisite is too),
   plus a pairwise `assign[dep, w_dep] + assign[prereq, w_pre] <= 1` for every
   window pair that would violate "completes before starts."

**`solve_schedule` now asserts its own invariant.** Mirroring the existing
FR3.3 "no task may vanish" check, `_build_result` raises `AssertionError` if
`detect_known_gaps` ever finds a violation on an OPTIMAL/FEASIBLE solve - a
non-empty result would mean the constraint above has a bug, not that a real
conflict exists. `DEPENDENCY_ORDER_VIOLATION` also moved from a live
`optimized`-plan conflict type into `CHECKED_AND_CLEAR` (T22's
"checked-and-found-none" pattern, joining `TRAIN_IMPACT_CONFLICT`) - the same
"checked, not merely absent" distinction this project draws everywhere else.

**The real corpus was already violating this rule, and not narrowly.**
Auditing before writing the constraint (same discipline as T20/T23) found 5
live violations on the committed 89-task corpus, T21's own detector having
reported them since its own task without anyone reading the number as
alarming. Two were not near-misses: TSK-00001/002/003 (an
inspection-repair-testing chain on ABEO-ABU) were scheduled with
TSK-00001 and TSK-00002 in the **exact same window, same day**
(`2026-08-26`, `00:46-24:00`) - not merely out of order, but literally
simultaneous, which is physically nonsensical for one defect's own repair
sequence. The same pattern held for TSK-00053/054. A fifth violation was
different in kind: TSK-00025 was scheduled even though its immediate
prerequisite, TSK-00024, was never scheduled at all (independently
`EXCEEDS_LONGEST_WINDOW`) - the solver had no way to know it should care.

**Fixing it changed real numbers, not just added a check.** Before -> after,
same corpus, same weights:

| Metric | Before (T6-T23) | After (T24) |
|---|---:|---:|
| Tasks scheduled | 36 | 35 |
| Tasks deferred | 53 | 54 |
| Blocks used | 25 | 28 |
| Block utilisation | 74.33% | 48.53% |
| `dependencyViolations.count` | 5 | 0 |
| `resourceConflicts.count` | 11 | 10 |

TSK-00025 now correctly cascades to `PREREQUISITE_UNSCHEDULABLE`, one fewer
scheduled task. The utilisation drop is real and traced, not a regression to
paper over: the three ABEO-ABU chain tasks now each require their OWN
~1394-minute window on a SEPARATE day, instead of two of them sharing one
window as before - 3 newly opened, very long windows account for essentially
the entire +3,142 minutes of new capacity, most of it now genuinely unused.
**74.33% was flattered by a physically impossible co-location.** 48.53% is
the honest number for the same corpus under the same weights. Confirmed by
diffing the exact block sets before and after (not assumed from the topline
change alone). Resource contention shifted 11 -> 10 net: the reflow removed
one contention and, on a different corridor, created a genuinely NEW
cross-corridor one (TSK-00003, now on 2026-08-30, contends for a
department-D01 resource with TSK-00015/16/17 on an unrelated corridor -
resources are depot-scoped across corridors per T21, so this is a legitimate
occurrence the taxonomy already had a slot for, just one that had never
actually happened on this corpus before).

**A second, sharper finding: the baseline was already committing this exact
violation, for real, in its own output.** TSK-00025 is structurally
contestable (`structurally_contestable` is a pure window-length check,
unaware of dependencies) and the FR9.1 baseline - which has never read
`dependsOnTaskId` - schedules it in its FCFS pass regardless of whether
TSK-00024 ever gets a window. It does not. This is not hypothetical: it is
sitting inside `run_baseline`'s real output on the real corpus, a genuine,
demonstrable dependency-order violation the baseline commits silently every
time it runs. D-031's "no throughput advantage, both engines schedule the
same 36" is therefore no longer exactly true - the optimizer schedules 35 of
36, one fewer than the baseline's 36, and the gap is not a shortfall to
explain away. It is the honest cost of the optimizer refusing to make the
mistake the baseline still makes.

**Where this surfaces, and why each was worth changing rather than leaving
stale.** A hardcoded "both engines schedule the same work" claim, now false,
would have been a worse failure mode than the topline number changing -
D-033's whole point about response shapes applies just as much to prose.
Three places carried it and now compute it dynamically from the real counts
instead:
- `scheduleOrchestrator.ts`'s `buildComparison` caveat (backend, feeds every
  consumer of `comparisonToBaseline`).
- `frontend/src/lib/comparison.ts`'s `scheduled` row: a new `Verdict` value,
  `optimizer-fewer-by-design`, distinct from both `optimizer-better`
  (would have rendered a misleading green "improvement" badge over a SMALLER
  optimizer number) and `baseline-higher-but-worse` (this is not a trap - the
  lower number is genuinely correct, not a defect wearing a disguise). Its own
  sky-blue "fewer, by design" badge on the comparison screen, confirmed live.
- `KnownLimitations.tsx`, which had never rendered `checkedAndClear` at all
  since T22 introduced it - a pre-existing, adjacent gap this task's own
  `CHECKED_AND_CLEAR` addition made worth closing rather than leaving a
  second earned-zero silently unsurfaced. Confirmed live: both
  `TRAIN_IMPACT_CONFLICT` and `DEPENDENCY_ORDER_VIOLATION` now render under
  "Checked, and none found."

**Tests.** Optimizer 294 (7 new hand-built scenarios: enforced exclusion with
no room to sequence, valid same-day sequencing, valid cross-day sequencing,
single-stage and 3-stage `PREREQUISITE_UNSCHEDULABLE` cascades, a
`detect_known_gaps` isolation test, and a mutation-style A/B proof that
solving the same scenario with and without the dependency link produces
genuinely different plans - one window shared, two windows forced). Backend
107 (real-corpus numbers updated with the reasoning inline, not just the
figures). Frontend 71 (1 new: the fewer-by-design verdict, asserted never to
collapse to `optimizer-better`). Verified live end to end: KnownLimitations
panel and the comparison screen both re-checked in a real browser against a
freshly regenerated schedule, matching every number in the table above.

---

## D-067 — Resource no-overlap is a hard constraint too; unlike T24 it cost zero coverage, and it found a real bug two layers deep

**Date:** 2026-08-24 · **Task:** T25

**Mechanism, deliberately simpler than T24's.** Two tasks sharing any
`required_resource_ids` entry (crew, machine or permission) may not occupy
overlapping windows, on any corridor - resources are depot-scoped, not
corridor-scoped (T21). Unlike dependency precedence this is symmetric: there
is no "prerequisite," so no linking (`sum <= sum`) constraint is needed, only
a pairwise `assign[a,wa] + assign[b,wb] <= 1` for every task pair sharing a
resource and every same-day, overlapping window pair between them - matched
exactly to the same-day-and-overlap test `detect_known_gaps`'s resource
detector already used since T21, so the hard constraint and the post-solve
check can never disagree. `solve_schedule` asserts zero resource conflicts on
every OPTIMAL/FEASIBLE solve, the same invariant D-066 added for dependencies.

**The audit's real question: how much of the real corpus's resource
contention is genuine scarcity versus a synthetic-data artefact?** T4's
resource catalogue gives Engineering and S&T exactly ONE permission per depot
(`Traffic Block`, `Signal Disconnection`) - meaning any two same-department
tasks in that depot's 5-corridor scope share it by construction, not by
chance. Before writing the constraint, all 10 real conflicts (post-T24) were
classified by resource type: **7 were genuine crew/machine contention, 3 were
attributable ENTIRELY to the single per-depot permission** (no crew or
machine shared between that pair at all). This raised a real worry: would
enforcing the near-universal permission impose an unrealistic
one-task-at-a-time bottleneck across an entire depot's 5 corridors?

**Measured, not guessed: it does not.** Solving the same corpus with
permission-type resource ids stripped (crew/machine enforcement only) versus
the full uniform enforcement produced almost the same plan: 32 blocks vs 33,
47.43% vs 45.42% utilisation, and the **identical 35-task scheduled set**
either way. Crew/machine scarcity (2-3 resources per department per depot)
was already the binding constraint; the single permission adds one more block
of separation, not a depot-wide freeze. This justified keeping enforcement
uniform across all three resource types - matching PRD line 437's formal,
type-agnostic "no overlap on the same required resource" wording and T21's
existing detector exactly, rather than inventing a permission carve-out the
data did not actually need.

**The real corpus finding, and how it differs from T24's:** T24 cost one
scheduled task (36 → 35). T25 cost **zero** - the scheduled set is identical
before and after (35 tasks, same set). Only the PACKING changed: blocks used
28 → 33, utilisation 48.53% → 45.42%. The mechanism was the same kind of
"illegal co-location, corrected" story as T24 - e.g. TSK-00015/TSK-00016 had
been sharing a rail-grinding machine in the same window - but on this corpus,
every resource-conflicting pair happened to have enough spare capacity
elsewhere to be separated without displacing any other task. That this
DIFFERS from T24's coverage cost is itself informative: not every enforced
constraint costs coverage on this corpus, and the two findings together are
better evidence for D-024/D-028's "structural, not contested" thesis than
either alone.

**A second, sharper finding: the FR9.1 baseline commits this violation far
more severely than it did the dependency one.** Reusing `detect_known_gaps`
against the baseline's own placements (no baseline-specific code needed - the
detector is a pure function of any placements dict) found **27 real resource
conflicts** in the baseline's own output - a full department of Engineering
work routinely double-booked onto the same crew and machine, e.g.
TSK-00001/002/003 all claiming `RES-D01-pway-gang` and
`RES-D01-traffic-block` in the exact same 2026-08-24 window. This is far
larger than the single dependency violation T24 found in the baseline, and a
much stronger, more visceral piece of evidence for the FR9.1 comparison's
whole thesis. Per this task's explicit scope, this is captured here rather
than built into a new baseline-side detector or UI surface - the instruction
was to document the finding, not add scope beyond what T25 asked for.

**A real bug found two layers deep, unrelated to the CP-SAT model itself.**
Once resource conflicts could genuinely reach zero, `conflictReport.byPlan`
became `{}` for the first time ever - and Mongoose's default `minimize: true`
schema option **silently strips an empty nested object before it reaches
MongoDB**, confirmed by reproducing the exact behaviour in isolation and
proving the native MongoDB driver stores `{}` correctly (so this is Mongoose
casting, not BSON). The same failure class D-015 (database layer) and D-033
(response layer) already guarded against, found for a third time in a third
layer - and only reachable now that "zero live conflicts" became a real
outcome rather than a hypothetical one. Fixed with `minimize: false` on
`scheduleSchema`, not a workaround at the call site, since ANY current or
future empty-object-valued field on this document was equally exposed.

**A second bug in the same neighbourhood, on the frontend.**
`KnownLimitations.tsx`'s fallback logic read `groups.length > 0` to decide
between the typed T21 view and a "Pre-T21 fallback: counts only" view labelled
"Resource conflicts not enforced" / "Dependency ordering not enforced" -
correct when those labels meant a schedule generated before T21 existed, but
now WRONG: a *modern*, fully-enforced schedule also has `groups.length === 0`
(there is nothing to group), and would have silently shown the same
now-false "not enforced" labels forever, on every schedule, from here on.
Fixed by keying the branch on whether `conflictReport` exists at all
(genuinely pre-T21) rather than on whether it happens to contain any live
conflicts (now the ordinary case) - with a plain, honest empty-state line for
the modern case, confirmed live.

**Tests.** Optimizer 299 (5 net new: enforced exclusion, valid scheduling with
room, cross-corridor enforcement, a `detect_known_gaps` isolation test, and a
mutation-style A/B proof; several existing fixtures across `test_conflicts.py`,
`test_decision_log.py` and `test_optimizer_api*.py` rewritten the same way
T24 required, since a real solve can no longer produce a resource conflict to
exercise the reporting/cross-reference path against). Backend 107 (the small
2-task fixture had `requiredResourceIds` removed - it was accidentally both
the cross-department-batching demo AND a resource-conflict demo, which T25
makes mutually exclusive; the real-corpus assertions updated with the true
numbers, `byPlan` now correctly asserted empty). Frontend 71 (no new file,
since this component has never had one, per CLAUDE.md's frontend-coverage
guidance - the fallback-logic bug was caught and fixed by live browser
verification instead, which found it in the first place). Verified live end
to end: Known Limitations panel shows the empty-state line plus all three
`checkedAndClear` types with correct reasons, and the comparison screen shows
45.42% utilisation and the unchanged 35/36 figure, both freshly regenerated.

---

## D-068 — Seasonal risk is a real, narrow flag from real data - reporting only, and honest about how little of the corpus it can speak to

**Date:** 2026-08-24 · **Task:** T26

**The question, settled before any code was written.** PRD Section 5.1 names
two real sources for `seasonalRiskFlag`: "IMD open rainfall data" and
"publicly known flood-prone rail sections" - not synthetic data, unlike
T4's demand generation. Two things had to be checked before deciding
whether this feature could honestly be built at all: does real, citable data
exist, and does it actually touch this project's real 26-corridor operative
corpus?

**Real section-specific flood data exists, and does not touch this corpus at
all.** Konkan Railway publishes named, real, monsoon-vulnerable locations
(Chiplun, Ratnagiri, Karwar, Udupi, Mangaon) with river-bridge flood-warning
stations - genuinely real, citable, and precise. Checked directly: zero of
this project's 26 real operative corridors sit on the Konkan Railway zone or
near any of these named locations. Real data that cannot honestly be joined
to this corpus is not usable data for it, however well-sourced.

**Real state-level data exists, but the join key itself has a real gap.**
The Ministry of Jal Shakti's national flood-affected-area estimate names
five states explicitly - Assam, Bihar, Odisha, Uttar Pradesh, West Bengal -
as "largely affected" (cited via the Assam State Disaster Management
Authority's own page, quoting the Rashtriya Barh Ayog assessment, and a 2015
Lok Sabha reply from the Ministry of Home Affairs summarising the same
estimate). This is real, government-sourced, and directly usable - IF a
corridor's real station data carries a `state` at all. It often does not:
roughly half of all 8,990 real stations in the underlying `datameet/railways`
data lack a `state` field, and only 8 of this project's 26 real operative
corridors have it on both ends. This is a genuine gap in the source data
T2 already ingested, not something this task's own code could fill in.

**Decision: build it, narrow and honestly labelled, rather than not build
it or fake it wider.** `data/ingestion/build_seasonal_risk.py` classifies
each corridor into exactly the three cases D-024/T16's honesty pattern
would predict:
- **`"monsoon-risk"`** - at least one station's real state is on the Jal
  Shakti list. Real on this corpus for exactly 2 of 26 corridors: DGU-PNB
  (Assam) and HGJ-SUNM (Uttar Pradesh).
- **`"none"`** - state is known, and genuinely not on the list (6 of 26:
  Madhya Pradesh, Maharashtra ×2, Rajasthan, Andhra Pradesh, Jharkhand).
  Checked, not merely absent - the same "checked and found none" distinction
  T22/T24/T25 already draw for conflict types.
- **`null`** - no state metadata at all (18 of 26). Never guessed as safe,
  mirroring T16's `failureRiskScore: null` pattern exactly: absence of
  information is never scored as a favourable finding.

PRD Section 15's third enum value, `"flood-prone"`, is **never emitted** by
this build - it would need genuine section-specific data (like the Konkan
example), which this corpus's real corridors do not have. A test pins this
so a future edit cannot accidentally start claiming a precision this project
does not have evidence for.

**Architecture follows D-009's reasoning exactly, for the same reason.**
`seasonalRiskFlag` needs data T2's own sources (`datameet/railways`) do not
carry - the same situation D-009 identified for T3's occupancy data. So this
is a separate stage (`build_seasonal_risk.py`), producing a separate file
(`corridor_seasonal_risk.json`), joined onto `Corridor.seasonalRiskFlag` at
seed time exactly like T3's `occupancySummary` (D-016) - never a rewrite of
T2's own corridors.json, which would couple the stages and put T2's
rebuild-determinism test at risk for no reason.

**Reporting only, and the ξ objective term (PRD 13.1) is deliberately
untouched - the same question T22 asked of λ, answered the same way.** PRD
9.9's own prose offers two readings ("avoids long blocks... OR prioritizes
pre-monsoon inspection") and the formal constraint list uses
"penalize/restrict" - genuinely ambiguous between a soft objective term and
a hard rule. Given the real data supporting this feature covers only 2 of 26
corridors, wiring EITHER into the objective would let a coarse, two-corridor
signal start silently steering the solver's choices - exactly what T22
declined to do with a much richer λ signal, for the same reason: an estimate
this thin belongs in a report, not inside a function the solver optimises
against. `app/core/weather.py` only ever reports - `detect_weather_risk`
runs after the solve, on `result.blocks`, and cannot change them. A
mutation-style test proves this directly: the exact same scenario, solved
once with the flag set and once without, produces an **identical plan**
either way - only the report differs.

**Real corpus result: 7 real blocks, and the reference horizon itself sits
inside the real monsoon window.** All 7 tasks on the two flagged corridors
get scheduled (unrelated to this feature - a coincidence of what T25's
resource-conflict fix already settled), and this project's own reference
date, 2026-08-24, falls inside IMD's real Southwest Monsoon season (~June 1
- ~October 15) - so the finding is live on the actual demo horizon, not a
hypothetical that only fires on a contrived date. Confirmed live: `35/54`
scheduled/deferred and `45.42%` utilisation are exactly what they were
before this feature existed - proving "advisory only" by observation, not
just by design.

**The baseline was checked the same way T24/T25 checked it, with a softer
finding.** Reusing `detect_weather_risk` against the baseline's own
placements (no baseline-specific code needed - same technique as D-067)
finds the baseline schedules essentially the same monsoon-risk work as the
optimizer (6 blocks / 7 tasks). This is NOT a "violation" the way T24/T25's
findings were - weather risk is advisory, not a rule, so there is nothing
for the baseline to have broken. The honest framing is narrower: the
baseline has no mechanism to know or report this at all, while the
optimizer does. Documented here per this task's scope; no new baseline
production code was built for it, the same restraint T24/T25 applied to
findings that did not correct an existing false claim.

**UI: a small, dedicated panel, not folded into `KnownLimitations`.**
`WeatherRiskPanel.tsx` mirrors T16's `RISK_FRAMING` pattern - a real count,
real examples, and an honest caveat stated plainly - rather than T21's
conflict-taxonomy machinery, because PRD 9.9 is a different section from
PRD 9.5 and forcing this into the same component would blur a distinction
this codebase otherwise keeps carefully separate (D-045). Confirmed live: 7
real blocks render with real corridor/date/task detail and the caveat text,
directly above Known Limitations on the dashboard sidebar.

**Tests.** Data layer 11 new (`classify()`'s three-way honesty split,
`"flood-prone"` never emitted, the two real flagged corridors and three real
checked-and-clear ones pinned by name, rebuild determinism). Optimizer 9 new
(`is_monsoon_window`'s real calendar boundaries including that the reference
horizon sits inside it, the detector's shape, a mutation-style proof the
flag never changes the plan, decision-log threading). Backend 1 new
(`gatherScenario` threads the field with no extra join, since it is
denormalised at seed time) plus the real-corpus assertion extended (7 real
blocks, both flagged corridors named). Frontend: no new test file, consistent
with CLAUDE.md's frontend-coverage guidance and this session's established
practice of live-browser verification for a component this small. Verified
live end to end against a freshly regenerated schedule.

---

## D-069 — Emergency re-optimization means a disruption consumes corridor time, not a new task arriving; it commits, and reuses T20's Pin generalised to many

**Date:** 2026-08-24 · **Task:** T27

**The question, settled by re-reading PRD 9.10 before assuming "T20 but
committing."** PRD 9.10's own text: *"'Simulate an emergency block request'
button triggers incremental re-optimization of the remaining week's schedule
(re-solve only the affected corridor/window, holding already-executed blocks
fixed)."* Two things follow directly, neither optional: this re-solve is
**scope-narrowed** to one corridor's remaining time (unlike T20, which
re-solves the whole model), and - because FR3.5 calls it "support... when an
emergency... arrives," not "simulate," and 13.1 lists it beside the real
objective, not beside FR5's what-if - it is meant to **commit**, unlike T20
(D-064's "no persistence, of any kind" does not apply here; this is closer to
D-034's "a schedule is an event that happened").

**What "emergency" means was audited, not assumed, and the audit ruled out
the more obvious reading.** The candidate reading closest to T20 - "an
existing deferred task gets elevated and forced into the schedule right now"
- was tried FIRST, directly against the real corpus, before any module code
existed: pin everything off one corridor and everything already-elapsed on
it, leave the rest of that corridor free, and see whether a real deferred
task (TSK-00073, needs 174 min) could be rescued. It could not - D-024 holds
under this scope exactly as it held under T20's exclusion and T23's weight
sliders: a task longer than every window on its corridor stays deferred no
matter how much of the corridor's remaining capacity opens up around it.
That reading would make T27 demonstrate nothing T20 had not already shown,
on this data.

The reading actually built - **an unplanned event CONSUMES part of the
corridor's remaining calendar** (an emergency train movement, a safety
closure, another authority's urgent possession) - was checked the same way,
before any endpoint existed: block MQX-RMF's real window 9 on 2026-08-27
(holding the real TSK-00076) and re-solve. TSK-00076 relocated to 2026-08-28,
displacing TSK-00077 to 2026-08-29 in turn - a real, positive,
demonstrable re-optimization, with every OTHER corridor and every other
deferred task byte-identical to the baseline. This reading is also closer to
the words themselves - a "block REQUEST" is a request that a block of
corridor time be granted, i.e. taken OUT of availability - and needs no new
task-creation write surface at all: FR1.1 (task submission, still T10's to
finish) stays untouched, and the "emergency" is a capacity change, not a
data-model change. Both audits are pinned as regression tests
(`test_real_corpus_displaces_the_real_task_the_disruption_hits`,
`test_real_corpus_still_defers_a_structurally_oversized_emergency_honestly`
in `optimizer/tests/test_emergency.py`) rather than left as one-off findings.

**Mechanism: `Pin` (T20) generalised from one to many, plus a second,
new primitive - blocking a window outright.** `solve_schedule` gained
`pins: list[Pin]` (a superset of the existing singular `pin`, merged
internally) and `blocked_window_keys: frozenset[str]`. The distinction
matters and is not cosmetic: a pin forces or excludes ONE task; a block
removes a window from the model for EVERY task, which is what "already
executed" has to mean for a window nothing happened to be scheduled into -
it must stay unusable, not look freshly available to whichever task is
still unpinned. `app/core/emergency.py` builds both lists per re-solve:
every task off the affected corridor is pinned to its exact current
placement (or excluded, if currently deferred) so nothing outside the
affected corridor can drift even from CP-SAT's own tie-breaking; every
window on the affected corridor before the earliest disrupted date is
blocked outright, plus the disrupted window(s) themselves. Only the
disruption's own window and whatever remains on that one corridor from the
earliest disrupted date onward are left free.

**A pin naming a window inside the blocked range must still work - so the
block/pin interaction had to be resolved explicitly, not left to filter
order.** `candidates_for_task` is now built with `blocked - pinned_window_keys`
subtracted, computed BEFORE the candidate list, not after: an already-executed
task's own pin references a window that literally falls inside "everything
before the disruption" and has to be exempt from the block that would
otherwise remove its own variable from the model entirely, causing the pin's
own validation to fail with "not a real, fitting, same-corridor candidate."
Found by the audit script itself, not guessed in advance.

**A second real bug the audit found: a task with genuinely ZERO remaining
candidates was reported as having LOST a priority contest it was never
allowed to enter.** Before T27, a task in `schedulable` was structurally
guaranteed at least one candidate window (the physical-fit pre-check already
requires `duration <= longest window`, and nothing before T27 ever filtered
that list further). `blocked_window_keys` breaks that guarantee - a task
whose only window is blocked has `candidates_for_task[task_id] == []` - and
the existing NO_CAPACITY message ("N window(s)... better used by
higher-priority work") would report `N=0` while still claiming a contest
happened. There was no contest; there was nothing left to contest. Fixed
with a new code, `WINDOW_UNAVAILABLE`, used exactly when the candidate count
is zero - not a new category invented for T27's convenience, but the same
"a rewarded indicator must be free to be zero" honesty rule D-025 already
established, reached from a new angle.

**No new commit path beyond what D-034 already establishes - but a new one
was still needed, because T15's override genuinely does not fit.** Checked
explicitly, per the task's own scope boundary: T15's override (D-043)
replays a DELTA on the existing plan without re-solving anything, so it can
move or defer exactly one task but cannot express "the corridor's remaining
tasks reshuffle around a capacity change," which is what an emergency
displacement usually needs (see TSK-00076/TSK-00077's cascade above). So
`POST /api/schedules/:id/emergency` persists a genuinely NEW `Schedule`
document (`emergencyService.ts`), the same `SCH-<timestamp>` shape
`generateSchedule` already produces, carrying a new `emergencyContext` field
(source schedule id, corridor, disrupted windows, asOf, reason, and the
pinned/blocked counts) - additive to D-034, not an exception to it: this is
still "a schedule is an event that happened," the event just being a
disruption rather than a scheduled generation.

**Current placements come from the EFFECTIVE plan, never a fresh re-solve -
a deliberate divergence from T20's own choice, checked explicitly rather
than copied by analogy.** `runWhatIf` (T20) recomputes a fresh baseline via
`solve_schedule` because a hypothetical need not reflect every manual
tweak (D-064). Doing the same here would be a real bug: the plan being
amended may already carry T15 overrides, and pinning against a freshly
re-solved baseline instead of `getEffectivePlan`'s replayed result would
silently discard them the moment an emergency hit - D-044's "measure
against the effective plan, never the base blocks" rule, in a new layer.
`emergencyService.ts` reads `getEffectivePlan` and threads
`effectivePlan.blocks` through as `currentPlacements`.

**No new workflow gate, checked rather than assumed by analogy to T15's
`assertOverridable`.** T19's gate refuses a WRITE onto a published or
rejected schedule's own history, and its refusal message already names the
correct alternative: *"Generate a new plan - it becomes the next version."*
An emergency re-solve never writes onto the source schedule - it creates an
independent new document, exactly the "generate a new plan" T19 already
points to, just triggered by a disruption instead of a manual click. So
`runEmergencyReoptimization` deliberately does not call `assertOverridable`:
there is nothing here for it to gate. The resulting schedule is a plain new
draft, reachable through T19's existing FR6.1 workflow if a Controller wants
to formally approve or publish it - no new state machine needed.

**A cross-task finding, not a new one: the same under-determined-day
volatility T20/T23 already documented (D-028/D-061) shows up here too, now
in a COMMITTING context.** Live-verified against the real seeded corpus: with
only ONE window on BBPR-SYU disrupted, all THREE of the corridor's remaining
blocks moved to different days - not because the model needed to, but
because CP-SAT's own tie-breaking, once perturbed by even one blocked
window, is free to redistribute the rest. Confirmed independently outside
the browser via direct `curl` calls comparing the exact before/after block
placements. This is not a defect - D-028 already established coverage never
changes from this kind of reshuffle - but it is a real thing the UI has to
report honestly rather than pretend "only the disrupted task moved."

**A live-testing bug in the frontend panel itself, caught only by driving a
real browser.** `EmergencyPanel.tsx`'s first version diffed the "before" and
"after" plan by reading `blocks` reactively from the dashboard's own
`useGetLatestScheduleQuery` prop. The emergency mutation is tagged
`invalidatesTags: ['Schedule', 'Task']` - correctly, since its result
becomes the new `latest` - but that means by the time the mutation's
response rendered, RTK Query had ALREADY refetched `blocks` to the just-created
plan, so the diff silently compared the new plan against itself and labelled
every block "unchanged." Fixed by freezing a `beforeBlocks` snapshot in
component state at the moment of submission, before the mutation fires.
Re-verified live after the fix, and independently against raw API output
(the `curl` comparison above) - both agree exactly.

**Tests.** Optimizer 323 (15 new in `test_emergency.py`: off-corridor tasks
held exactly fixed, a disrupted window genuinely displacing its occupant, an
empty already-executed window staying unusable, a structurally-oversized
task staying honestly deferred, the new `WINDOW_UNAVAILABLE` reason, a
mutation-style proof the block - not the pin set - causes the displacement,
pin-uniqueness, HTTP contract validation, and the two real-corpus tests
above), plus `test_scheduler.py`/`test_whatif.py` re-verified green after the
`Pin` generalisation. Backend 120 (6 new: a full commit-and-persist round
trip on a deterministic one-window fixture proving the honest
`WINDOW_UNAVAILABLE` outcome, source-schedule immutability, and boundary
validation for an unknown corridor / empty disruption list / short reason /
unknown schedule id). Frontend: no new test file (consistent with T26's
practice for a panel this size); verified live end to end in a real browser,
including finding and fixing the stale-snapshot bug above, plus an
independent `curl`-based ground-truth check of the exact same disruption.
