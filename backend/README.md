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
