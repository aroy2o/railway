# `/backend` — Express API

Auth, CRUD and orchestration for the block planning system. This service owns
MongoDB and is the **only** client of the Python optimizer — it never runs
OR-Tools itself (PRD 10.3).

## Run

```bash
npm install
npm run dev     # watch mode
npm start       # once
npm run seed    # load data/processed/*.json into MongoDB (~20 s)
npm test        # node --test
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
    errorHandler.js notFound + terminal error handler (one error envelope)
    validate.js     Zod request-validation factory for body/query/params
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

Every list endpoint answers `{ data, pagination }` and is bounded — `limit`
defaults to 50 and is capped at 200, so no route can return all 10,149
corridors by accident.

These are read-only. Auth (FR10), task submission (FR1.1) and schedule
orchestration are the remaining T10 work.

## Conventions

- **One router file per resource**, mounted in `routes/index.js`.
- **Validate at the boundary.** Routes that accept input use
  `validate({ body, query, params })`; the parsed value replaces the raw one, so
  no handler ever sees unvalidated data.
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
