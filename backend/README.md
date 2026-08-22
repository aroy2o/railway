# `/backend` — Express API

Auth, CRUD and orchestration for the block planning system. This service owns
MongoDB and is the **only** client of the Python optimizer — it never runs
OR-Tools itself (PRD 10.3).

## Run

```bash
npm install
npm run dev     # watch mode
npm start       # once
npm test        # node --test
```

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

Auth, tasks, corridors, assets and schedule orchestration land with task T10.

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
