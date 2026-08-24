# `/backend` — Express API (TypeScript)

Auth, CRUD and orchestration for the block planning system. This service owns
MongoDB and is the **only** client of the Python optimizer — it never runs
OR-Tools itself (PRD 10.3).

TypeScript throughout, `strict` on. Node 20 has no native type stripping, so
`tsx` runs the dev server, the seed and the tests straight from source while
`tsc` emits `dist/` for production (D-041).

## Run

```bash
npm install
npm run dev        # tsx watch, straight from src/
npm run build      # tsc -> dist/
npm start          # node dist/server.js  (needs build first)
npm run typecheck  # tsc --noEmit, includes tests
npm run seed       # load data/processed/*.json into MongoDB (~20 s)
npm test           # node --test via tsx
```

### Seeding

`npm run seed` loads the data pipeline's output into MongoDB. Build that output
first (see `data/README.md`), then:

```bash
npm run seed
```

It is **safe to re-run**: each of the six pipeline collections is emptied and
reloaded rather than upserted, so a second run produces identical counts and no
duplicates. It does not touch schedules, decision logs or audit logs. The
rationale is in `docs/DECISIONS.md` D-019.

The script also builds every declared index (awaited — see D-018) and verifies
that `synthetic`, `fieldProvenance` and the real-anchored
`criticality.trainsAffectedCount` survived the round trip before reporting
success.

Seeded counts: 10,149 corridors · 10,149 calendar entries · 55 assets ·
89 tasks · 102 resources · 5 provenance records · **30 corridors flagged
`hasSyntheticDemand`**.

Configuration comes from the repo-root `.env` (see `../.env.example`).
`backend/.env` may exist as a local override. The process **refuses to start**
on invalid config and prints exactly which variables are wrong.

## Layout

```
src/
  config/
    env.js          Zod-validated config — the only source of tunables
    db.js           Mongo connection lifecycle + readiness status
  middleware/
    errorHandler.ts notFound + terminal error handler (one error envelope)
    validate.ts     Zod request-validation factory, plus `validated<T>()`
  models/           Mongoose schemas (task T5, PRD Section 15)
  routes/
    index.js        mounts the API at /api
    health.js       liveness, readiness, cross-service dependency probe
  services/
    optimizerClient.js  the single seam to the Python service
  utils/
    ApiError.js     HTTP-status-carrying error type
    logger.js       level-aware logger (JSON in production)
  app.js            Express wiring — no ports, no DB (so tests can mount it)
  server.js         entry point — DB connect, listen, graceful shutdown
tests/              node:test + supertest
```

`app.js` and `server.js` are separate on purpose: tests mount the app in-process
with supertest and never bind a socket.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness. No dependency checks. |
| `GET` | `/api/health/ready` | Readiness. `503` unless MongoDB is connected. |
| `GET` | `/api/health/dependencies` | Probes MongoDB **and** the optimizer in one call. Reports `degraded` rather than failing when something is down. |
| `GET` | `/api/corridors` | Real corridor sections. `?hasSyntheticDemand=true` narrows 10,149 to the ~30 that carry demand, via an index. Also `zone`, `search`, `limit`, `offset`. |
| `GET` | `/api/corridors/:id` | One section, with `maxDailyBlockWindows` and the occupancy detail joined from `corridor_calendar`. |
| `GET` | `/api/assets` | Filter by `corridorId`, `department`, `assetType`, `minCriticality`. Sorted by criticality. |
| `GET` | `/api/assets/:id` | One asset, including its degradation series. |
| `GET` | `/api/tasks` | Filter by `corridorId`, `assetId`, `department`, `status`, `minSeverity`. |
| `GET` | `/api/tasks/:id` | One task. |
| `GET` | `/api/resources` | Filter by `corridorId` (matches `corridorScope`), `department`, `type`, `depot`. |
| `GET` | `/api/provenance` | Per-collection disclaimer and field-level real/synthetic map (D-015). |
| `POST` | `/api/schedules/generate` | **Orchestration.** Gathers from MongoDB, calls the optimizer, persists the plan. Returns `201` with the stored schedule. |
| `GET` | `/api/schedules` | Generated plans, newest first (heavy fields excluded). |
| `GET` | `/api/schedules/latest` | The most recent plan, in full. |
| `GET` | `/api/schedules/:id` | One plan by id. |
| `POST` | `/api/tasks/reprioritize` | FR2.4 re-rank without running a solve. |
| `POST` | `/api/schedules/:id/override` | **FR6.2** — move a task to another free window on its corridor, or defer it. Re-validated; refused with the specific failing check. |
| `GET` | `/api/schedules/:id/overrides` | The FR6.2 audit trail for one plan. |
| `GET` | `/api/schedules/:id/override-targets/:taskId` | Windows a task can legally move into, from the same validator the write path uses. |

Every list endpoint answers `{ data, pagination }` and is bounded — `limit`
defaults to 50 and is capped at 200, so no route can return all 10,149
corridors by accident.

Auth (FR10), task submission write paths (FR1.1) and CSV/JSON bulk import
(FR1.3) are the remaining T10 work.

## Orchestration

`POST /api/schedules/generate` is the loop that ties all four layers together:

```
MongoDB ──gather──> Node ──HTTP──> optimizer ──> Node ──persist──> MongoDB
```

It gathers the 30 corridors carrying demand (indexed, D-018), their free windows
from `corridor_calendar`, the backlog, and the asset-criticality join; POSTs that
to `/optimize`, `/baseline` and `/prioritize` **in parallel**; then stores the
plan and writes FR2.3 priority scores back onto the task documents.

**Two field-name translations happen in `scheduleGathering.js`, deliberately.**
The two schemas were designed independently and each name is right in its own
context, so the mapping belongs at the boundary:

| Stored in MongoDB | Optimizer contract |
|---|---|
| `maxDailyBlockWindows[].startMin` / `.endMin` | `dailyWindows[].startMinute` / `.endMinute` |
| task `_id` | `taskId` |

The optimizer's request models are `extra="forbid"`, so an unmapped field is a
422 rather than a silent drop — which is why the mapping is written out
explicitly rather than spreading the document and hoping.

Only `/optimize` failing aborts the request. A failed `/baseline` or
`/prioritize` is recorded in `generationErrors` and the plan is still stored, so
a missing comparison is distinguishable from a comparison of zero (D-036).

Schedules are **appended, never replaced** — FR6.3 needs prior plans viewable
for audit (D-034).

### Train-impact costing (T22)

Gathering sends each corridor's `occupiedWindows` and `trainClassMix` alongside
its free windows. **The solver never schedules into occupied time** — these exist
only so a deferral can say what forcing it through as a traffic block would cost.

`Schedule.deferredTasks[].displacementOption` carries that costing. It is
declared in `deferredSchema`: Mongoose silently drops undeclared keys, which is
exactly how this field went missing on its first run — D-033's failure mode in a
different layer, now covered by a regression test.

Absent `occupiedWindows`, no costing is attached and the deferral says the cost
was not computed. "0 trains" and "we did not look" are different claims, and the
first one reads as reassuring while being false.

### Predictive asset risk (T16)

Generation now calls `/risk` **before** the three scheduling calls, not alongside
them: the FR2.2 score is an input to the FR2.3 priority score, so it must exist
before `/prioritize` and `/optimize` see the tasks.

A `/risk` failure is **not** fatal — it is recorded in `generationErrors`, scores
stay null, and the priority engine renormalises its remaining four weights. That
is D-036's rule applied to a fourth call.

The score is written to both layers, deliberately: the **asset** holds the model
output and its reasoning (`failureRiskBreakdown`, `failureRiskReason`,
`failureRiskFraming`), and the **task** holds the number it was actually
prioritised with — the same denormalisation T7 uses for `priorityScore`.

`Schedule.riskModel` records how FR2.2 was applied to *that* plan, framing
included, because a plan generated while `/risk` was down used the renormalised
four-factor weights and that has to stay knowable afterwards. `applied` means
"a risk score actually reached a task", not "the call returned".

### Ask the Planner (T18)

`POST /api/schedules/:id/explain` (and `/latest/explain`) take `{ question }`.

Node's role is gathering only: it loads the schedule, the projected task fields
the grounding contract reads, and the override log, then posts them to the
optimizer's `/explain`. It selects nothing and interprets nothing — the grounding
contract lives in `optimizer/app/core/grounding.py`, next to the scheduler whose
decisions it explains (D-049).

**Overrides are gathered too, and that is the point.** `decisionLog` records what
the *solver* decided; by D-043 the schedule is never mutated, so after a manual
override the log and the current plan disagree on purpose. An explanation that
saw only the log would confidently give a Controller the time their own override
replaced.

The response carries `answer`, `groundedIn` (record ids), and `verification`
(every number in the answer, checked against those records). `EXPLAIN_TIMEOUT_MS`
(default 60s) is separate from `OPTIMIZER_TIMEOUT_MS` — this call waits on an LLM,
not a solve.

With no `ANTHROPIC_API_KEY` on the optimizer, this returns **503** with the
reason intact ("no ANTHROPIC_API_KEY is set…"), not a flattened
"Optimizer responded 503" — see D-051.

### Typed conflicts (T21)

The stored schedule carries two conflict reports, on **separate layers that must
never be added together** (D-045):

| Field | Layer | What it is |
|---|---|---|
| `conflictReport` | `optimized` | Constraints this system's solver does not yet enforce (T24, T25) |
| `baseline.conflictReport` | `baseline` | The FR9.1 finding — what the uncoordinated process produces |

Both are computed once by the optimizer, which owns the taxonomy, and stored
verbatim (D-046). Node classifies nothing. Schedules generated before T21 have
`conflictReport: null`, and the dashboard falls back to count-only rendering.

## Manual override (FR6.2)

`GET /api/schedules/:id` and `/latest` return three things: `blocks` (the plan
exactly as the solver produced it, which `decisionLog` explains), `overrides`
(the amendments), and `effectivePlan` (the two combined). **The schedule
document is never mutated** — see D-043 for why that matters to T17's
explanation layer.

Re-validation runs six named checks and reports every one, passed or failed:

| Check | Refuses |
|---|---|
| `same-corridor` | A cross-corridor move — the defect is on that corridor's asset |
| `within-horizon` | A date outside the plan |
| `window-exists` | A window the timetable does not leave free |
| `different-placement` | A move to where the task already is |
| `duration-fits-window` | A task longer than the window |
| `window-capacity` | A task longer than what is *left* in the window |

The last two are separate on purpose: a 140-minute task fits a 152-minute
window but not one already holding 118 minutes of someone else's work.

**Capacity is measured against the effective plan, never the base blocks** — a
validator reading the solver's original blocks would not see work a prior
override moved in, and would silently accept an over-fill. `overrideEngine.ts`
is pure and carries an adversarial test for exactly that, which was
mutation-checked to confirm it can fail (D-044).

```bash
curl -X POST localhost:5000/api/schedules/generate \
  -H 'content-type: application/json' \
  -d '{"horizonStart":"2026-08-24","horizonDays":7}'

curl localhost:5000/api/schedules/latest
```

### Running the orchestration tests

`tests/schedules.test.js` needs MongoDB **and** the optimizer service running;
it skips cleanly without either. It uses its own database (`..._schedules`)
because `node --test` runs files in parallel and sharing one test database let
two files' fixtures wipe each other mid-run.

## Conventions

- **One router file per resource**, mounted in `routes/index.js`.
- **Validate at the boundary.** Routes that accept input use
  `validate({ body, query, params })`; the parsed value replaces the raw one, so
  no handler ever sees unvalidated data. Read it back with
  `validated<z.infer<typeof schema>>(req.query)` — a single named cast, because
  Express's types cannot express that the middleware replaced the value.
- **One error envelope.** Handlers throw `ApiError`; the terminal handler shapes
  every failure as `{ error: { code, message, details? } }` and logs 5xx with a
  stack. Nothing is swallowed. Internal exception text is never sent to a client.
- **Config only from `config/env.js`.** No hardcoded ports, URLs or timeouts.
- Comments reference the PRD requirement they implement (e.g. `FR3.1`) so a
  constraint can be traced to the spec during demo Q&A.

## Tests

`tests/health.test.js` covers the API shell: health endpoints, the 404 envelope,
the validation middleware contract, and the optimizer-down path.

`npm test` loads `tests/.env.test` via `node --env-file`, which points
`MONGODB_URI` at a database that is never connected to and `OPTIMIZER_URL` at a
dead port. That makes the suite self-contained — a fresh clone can run it
without copying `.env.example` — and makes the "dependency is down" assertions
deterministic instead of depending on whether the developer happens to have
MongoDB or the optimizer running locally.

Substantive test effort belongs to the solver and baseline algorithm, not to
this shell.
