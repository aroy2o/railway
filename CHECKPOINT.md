# Integration checkpoint — before T10

**Date:** 2026-08-22 · **Verified at commit:** `8bac58b` · **Verdict: PASS — ready for T10**

A verification-only pass. No new logic, no new endpoints, no new UI. Its purpose
was to confirm that five sessions of rapid change (T5→T9) still hold together
when exercised in a single run, before T10 adds Node orchestration on top.

**Nothing required a code fix.** Every documented claim reproduced exactly.

---

## 1. Repo hygiene — PASS

Three stray dev processes were running and were killed: a Vite dev server, a
`node src/server.js`, and a `uvicorn app.main:app --reload`. Any of these could
have masked a stale-state "works" result.

- Working tree **clean**, `HEAD` == `origin/main` == `8bac58b`
- Ports 5000 / 8000 / 5173 all free before verification began
- `mongod` active (required, left running)

> **Operator note, recorded because it was a mistake:** the cleanup loop
> initially iterated *every* listening PID rather than filtering to dev servers,
> and killed two VS Code helper processes (a utility node process and the Python
> extension host). VS Code recovered. A process sweep on a developer machine
> must filter by command, not by "holds a socket".

## 2. Pipeline rebuild determinism — PASS

Deleted and rebuilt every processed artefact, then compared SHA-256 against the
pre-existing files.

| Output | Result |
|---|---|
| `stations.json`, `corridors.json` (T2) | byte-identical |
| `corridor_calendar.json`, `trains.json` (T3) | byte-identical |
| `assets.json`, `tasks.json`, `resources.json` (T4) | byte-identical |

Confirms D-008 (no timestamps in processed output) and D-014 (seeded generation)
still hold.

**Seed idempotency (D-019):** run twice; second run reported
`removedFirst` equal to `inserted` on every collection. Counts verified
independently through `mongosh`, not from the script's own output:

```
corridors 10149 · corridor_calendar 10149 · assets 55 · tasks 89
resources 102 · dataset_provenance 5 · hasSyntheticDemand:true → 30
```

**D-018 index check — the one most at risk of silent regression:**

```
db.corridors.find({hasSyntheticDemand:true})...explain()
  collection size : 10149
  docsExamined    : 30      ← index hit, not a collection scan
  keysExamined    : 30
  millis          : 0
```

All four corridor indexes present, and every query path added in T6–T9 is
index-backed (`tasks` by corridor/department/status, `assets` by corridor,
`resources` by `corridorScope`, `corridor_calendar` by `corridorId`).

## 3. Full test suite, all four layers — PASS, no drift

| Layer | TASKS.md claims | Actual |
|---|---|---|
| data | 94 | **94 passed** |
| optimizer | 120 | **120 passed** (0 skipped, backend up) |
| backend | 18 | **18 passed** |
| frontend | build + lint clean | **build ✓, lint clean** |

No count has drifted from what the documentation claims.

## 4. Real-corpus proof over live HTTP — PASS

All three services up (Mongo + backend:5000 + optimizer:8000),
`scripts/run_comparison.py` POSTing to the real endpoints:

```
corpus: 89 tasks / 30 corridors (all via HTTP)
  structurally impossible for ANY algorithm : 53
  structurally contestable                  : 36

  metric                                BASELINE    AI-OPTIMISED
  Contestable tasks scheduled              36/36           36/36
  Cross-department batches                     0               2
  Double-booking conflicts                     6               0
  Double-booked minutes                      605               0
  Over-subscribed windows                      3               0
  Block utilisation %                      77.01           74.33

  optimizer: OPTIMAL in 0.92s, knownGaps resource=11 dependency=5
  priority placeholder in decision log: {False}
  /prioritize top of queue: TSK-00082 score 87.31 dominant=severity
```

Every figure matches the T9 session exactly. The only difference is wall-clock
solve time — 0.92 s here against 0.68 s in T9 — which is machine variance, not
plan variance: the plan itself is deterministic and a test asserts identical
output across runs. Both are far inside PRD Section 7's 10-second budget.

## 5. Frontend against the live backend — PASS

`/corridors`, `/tasks` and `/status` all render real data correctly. The T5 API
contract is unchanged by T6–T9; all five read routes answer 200.

- `/corridors` — 30 with demand of 10,149 in network; GZB-SBB at 281 trains,
  82.2%, 54 free minutes, 1 window, 4 tasks
- `/tasks` — 89 of 89, real defect vocabulary, SYNTHETIC badges intact
- `/status` — all three services Online, provenance rendering from MongoDB with
  the REAL / SIMULATED / COMPUTED LATER field maps

## 6. Known gap, deliberately not fixed

`/api/tasks` returns `priorityScore: null` and the UI shows **"unscored"**.

This is **correct and expected**, not a regression. T7's priority engine computes
scores inside the optimizer service at solve time; nothing has yet written them
back to MongoDB. Persisting them is exactly what T10's orchestration does. The
UI already renders null as "unscored" rather than 0, which was a deliberate T5
choice — a zero would read as "lowest priority".

No other gap between documentation and reality was found.

---

## Ready for T10

The repo is in a known-good state. Everything TASKS.md and docs/DECISIONS.md
claim is true as of `8bac58b`:

- the data pipeline is reproducible end to end
- the seed is idempotent and its indexes are real
- 232 tests pass across four layers with no drift
- the full optimizer + baseline result reproduces over HTTP with every
  honesty field intact

T10's orchestration can begin: gather from Mongo → POST to `/optimize` and
`/baseline` → persist the returned schedule. The payload shape to mirror is
`optimizer/scripts/real_data.py:build_payload`, and `requestOptimizer()` in
`backend/src/services/optimizerClient.js` is already in place for the HTTP call.
