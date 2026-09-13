# Pitch numbers — pulled from a real run

**Every number below came from live runs executed today (2026-09-13), not
from memory or old session logs.** Source: `POST /api/schedules/generate`
(schedule `SCH-20260913091531561`, generated `2026-09-13T09:15:31.561Z`,
weekly horizon), immediately after `npm run demo:reset` — a genuine
first-generation run against a clean database, not accumulated test
history. Full raw response captured; every figure below is either read
directly from it or computed the same way the product itself already
computes it (never a new ratio invented for this document — see the note
at the bottom).

Reproduce it yourself in under a minute (backend + optimizer running):
```bash
cd backend && npm run demo:reset

TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"controller","password":"controller123"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")

curl -X POST http://localhost:5000/api/schedules/generate \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"horizonDays":7}'
```
**This command, run against a local dev stack, produces the LOCAL figures
below — not production's.** If you run this and then separately open the
live production link, expect the numbers to differ. See the standing note
immediately below for why, and §2/§3 for both sets of real figures side by
side.

> **Standing note: figures below move for two independent, confirmed
> reasons — read this before treating any single number as a fixed
> constant.** Neither the figures produced by the command above nor
> production's are "the real number" — both are genuine, both are
> reproducible within their own context, and a judge could see either
> depending on where they look.
>
> **Mechanism 1 — the calendar date.** The weekly horizon starts from
> "today," and the FR2.3 priority score (`app.core.priority.score_task`)
> computes SLA urgency/breach relative to that same `as_of` date. Every
> task's fixed `slaDueDate` was set once at seed time, so as real calendar
> days pass, `days_to_due` shrinks for the whole backlog, priority scores
> shift, and — on corridors where tasks genuinely compete for scarce
> capacity (`NO_CAPACITY` contests) — *which* tasks win that contest can
> change. Verified directly: forcing `horizonStart` back to `2026-08-26`
> (an earlier run's date) reproduces that run's exact figures byte-for-byte
> on the same machine; today's real date gives different ones. The baseline
> is unaffected (it orders strictly by fixed `dateRaised`, never by the
> date-relative priority score), which is why baseline figures below are
> stable regardless of which date a run used.
>
> **Mechanism 2 — which environment ran the solve.** The solver is time-boxed
> at a 10-second *wall-clock* ceiling (`SOLVER_MAX_SECONDS`), not a fixed
> amount of search work, and runs single-threaded by design for
> reproducibility (`num_workers=1`, D-022, fixed `random_seed=20260822`). A
> CPU-constrained machine completes less of the identical deterministic
> search in that same 10 real-world seconds than a full development machine
> does, and lands on a different — but equally FEASIBLE, equally valid —
> plan. Confirmed directly, not inferred: throttling a local optimizer to
> the same 0.5 vCPU the production Container App is provisioned with
> (`docs/deploy/azure-setup.sh`) reproduces production's exact figures,
> reversibly — remove the throttle and the same machine reproduces its own
> unthrottled figures again, on demand. See `docs/DECISIONS.md` D-092 for
> the full measurement (deterministic-time budget, branch/conflict counts,
> the rejected worker-count hypothesis, and why cross-machine determinism is
> deliberately not being fixed before this demo).
>
> **Both figures below are labelled by environment, not ranked.** Read the
> label before quoting a number:
>
> | | **Local** (dev machine, unthrottled) | **Production** (Azure Container App, 0.5 vCPU) |
> |---|---:|---:|
> | tasksScheduled / tasksSplit | 64 / 29 | 63 / 28 |
> | Block utilisation | 61.42% | 60.15% |
> | Objective value | 34,370,727 | 33,799,080 |
> | Reproducible within its own environment? | yes — 2 consecutive runs, byte-identical | yes — 3 consecutive runs, byte-identical |
>
> Two consecutive runs on the *same* machine on the *same* date remain
> byte-identical either way (§3) — the two mechanisms above are the only two
> confirmed sources of movement, and both have been directly reproduced on
> demand, not merely observed once.

---

## 1. The real corpus: 89 tasks, three honest categories

| Category | Count | What it means |
|---|---:|---|
| **Contestable** | 36 | Fits a single window — placeable by either algorithm |
| **Split-only** | 32 | Fits no single window, but the optimizer can place it by splitting work across non-contiguous sessions (T29 Phase 1) — a capability the baseline structurally does not have, at any horizon length |
| **Genuinely impossible** | 21 | Fits no combination of windows at all, even considering splitting — impossible for either engine |
| **Total** | **89** | 36 + 32 + 21 = 89 ✓ |

*Source: `comparisonToBaseline.{contestableTaskCount, splitOnlyTaskCount,
structurallyImpossibleCount}` in today's live response — the same
classification logic (`classify_structural_feasibility`) both the solver's
pre-solve check and the Comparison view read from, per `docs/DECISIONS.md`
D-084. This three-way split is a structural fact about the fixed corpus and
corridor windows, not the date-relative priority score, so it does not move
with the calendar the way §2/§3's numbers do.*

**If asked why 21 tasks are simply left out:** their total available
capacity across the entire horizon, summed across every window on their
corridor, is still less than their required duration. No scheduling
algorithm — this one or any other — can place them without more block time
existing on that corridor. This is a fact about the data, not a solver
limitation.

## 2. Baseline vs. optimizer — the real comparison

**Do not lead with a scheduled-task count.** Read the caveats below the
table before quoting any single cell — this is the exact framing the
product's own Comparison screen enforces, not extra caution added for this
document.

| Metric | Baseline (naive FCFS) | Optimizer | Source field |
|---|---:|---:|---|
| Contestable tasks scheduled (of 36) | 36 | 35 | `comparisonToBaseline.{baseline,optimized}.contestableScheduled` |
| Split-only tasks scheduled (of 32) | 0 | 29 | `.splitOnlyScheduled` |
| Cross-department batches | 0 | **5** | `.crossDepartmentBatches` |
| Double-bookings | **6** | 0 | `.doubleBookings` |
| Double-booked minutes | **605** | 0 | `.doubleBookedMinutes` |
| Over-subscribed windows | **3** | 0 | `.overSubscribedWindows` |
| Block utilisation | **77.01%** | 61.42% | `.blockUtilisationPct` |

**Read the utilisation row backwards on purpose.** The baseline's 77.01% is
*higher* than the optimizer's 61.42% because it over-subscribes windows —
cramming more minutes into the same corridor-hours by double-booking them.
**Never quote utilisation without the double-booking count next to it** —
this is the exact wording the product's own generated `caveats[]` array
carries on every response, word for word:

> "Baseline block utilisation is HIGHER than the optimizer's because it
> over-subscribes windows. Never render utilisation without the
> double-booking count beside it."

**Why the optimizer schedules one fewer contestable task (35, not 36).**
Not a shortfall — a real constraint the baseline silently ignores. The
optimizer enforces PRD 9.7 dependency precedence (a task cannot start before
its prerequisite finishes); the baseline has no dependency awareness at all
and schedules the dependent task regardless. The one task this costs is the
honest price of not making the mistake the baseline still makes on every
run.

**The headline capability, not a footnote.** The baseline places **0** of
the 32 split-only tasks — structurally 0, asserted by a test, not merely
observed — because it never splits work by design. The optimizer places
**29** of them today. This is the real differentiator: it is the same
reason `crossDepartmentBatches` is 5-vs-0, not a close comparison.

*Source: `comparisonToBaseline` object, full caveats array, today's live
response (`SCH-20260913091531561`). The 77.01% / 6 / 605 / 3 baseline
figures are identical to this document's previous (2026-08-26) run, by
design — see the standing note above; only the optimizer's
`blockUtilisationPct` moved (59.92% → 61.42%).*

## 3. Solve status and time

| | Value |
|---|---|
| Status | **FEASIBLE** (not OPTIMAL) |
| Solve time | **10.002s** against a configured `SOLVER_MAX_SECONDS=10` ceiling |
| Objective value | 34,370,727 |

**Say this plainly if asked, don't dodge it:** the solver does not prove
this is the mathematically best possible plan within its time budget — it
proves the plan is feasible (every hard constraint genuinely holds:
0 resource conflicts, 0 dependency violations, 0 double-bookings, 0
train-impact conflicts — see the response's own `knownGaps`) and reports
honestly that it ran out of time before proving optimality, roughly a **2%
gap** to the solver's own best proven bound (`docs/DECISIONS.md` D-082's
measured figure, not re-derived today).

**Reproducibility verified live today, not assumed from an old session:**
generated the schedule twice in a row against the same reset database
(`SCH-20260913091531561` then `SCH-20260913091541851`, ten seconds apart).
`objectiveValue` (34,370,727), `status` (FEASIBLE), `metrics`,
`comparisonToBaseline`, and every block in `blocks` were **byte-identical**
across both runs (`solveSeconds` 10.002 both times — no wall-clock noise at
all this time). If a judge asks to see it run twice, it will show the same
plan both times, on the same date.

**The objective value itself moved from this document's previous figure
(32,270,889 → 34,370,727), and that is expected, not a bug** — see the
standing note above; it moves for the same date-relative-priority reason
`blockUtilisationPct` did, and was directly confirmed by re-running with
`horizonStart=2026-08-26`, which reproduced 32,270,889 exactly.

*Source: `status`, `solveSeconds`, `objectiveValue` in today's live
response, cross-checked against a second live generation run in this same
session, and against a third run pinned to the previous document's horizon
date; the ~2% optimality-gap figure is D-082's own measured finding.*

## 4. The batching ceiling: 5 is proven optimal, not just observed

`crossDepartmentBatches: 5` in today's run is not "a decent result at the
default weight" — it is the **mathematically proven ceiling** for this
89-task corpus. A standalone CP-SAT model, built with every real hard
constraint (splitting, dependency precedence, resource no-overlap, window
capacity) but an objective that maximizes *only* batched-window count,
solves to **OPTIMAL at exactly 5**, out of 147 structurally eligible window
instances that could in principle host 2+ departments.

This was confirmed two ways, not just proven once: an empirical sweep of
the batching weight across its full verified-safe range (1x through 10x of
default) never produces more than 5, on the real corpus, via the actual
solver.

**If asked "why not raise the batching weight then":** there is nothing to
gain — the default already sits exactly on the ceiling. A higher weight
only reshuffles which day the same tasks land on.

*Source: `docs/DECISIONS.md` D-086 (2026-08-26) — a read-only investigation,
**not re-run this session**. Unlike §2/§3's figures, this one is safe to
carry forward unchanged: its objective ignores every policy weight and the
date-relative priority score entirely (it maximizes only batched-window
count against the fixed hard constraints — windows, splitting, dependency,
resource), so it is not exposed to the date-sensitivity this session found
elsewhere. `crossDepartmentBatches: 5` was independently reconfirmed by
today's actual solve (§2), which is consistent with, not a substitute for,
D-086's combinatorial proof of the ceiling.*

## 5. Real, honest bonus finding: monsoon risk flagging

7 blocks in today's live run fall on one of the two real corridors this
project's real Ministry of Jal Shakti flood-risk data flags as
monsoon-risk, and today's date genuinely falls inside India's real IMD
Southwest Monsoon window. This is **advisory only** — the solver does not
avoid or move these blocks, a Controller decides — and confirmed not to
change the plan (same 64/25 scheduled/deferred split with or without the
flag existing, per `docs/DECISIONS.md`'s T26 entry).

*Source: `knownGaps.weatherRisk.count` = 7, today's live response.*

## 6. Test counts — fresh run today, all four layers

| Layer | Passed | Failed | Skipped/deselected | Command |
|---|---:|---:|---:|---|
| Backend | **139** | 0 | 0 | `cd backend && npm test` (real MongoDB + real optimizer both up — no test silently skipped) |
| Optimizer | **346** | 0 | 9 deselected (`-m live`: real Claude API calls, excluded by design — costs money, needs `ANTHROPIC_API_KEY`) | `cd optimizer && .venv/bin/python -m pytest` |
| Frontend | **145** | 0 | 0 | `cd frontend && npx vitest run` — plus a fresh `tsc -b` and `eslint .`, both clean |
| Data | **105** | 0 | 0 | `cd data && .venv/bin/python -m pytest` |
| **Total** | **735** | **0** | 9 (by design) | |

Counts are higher than this document's previous figures (728 total) because
more tests have been added to the suites since — this is growth, not drift.

## 7. CI status

**Green, but only as of the last pushed commit — the working tree at the
time of this document has uncommitted changes CI has not seen.** `git
status` at the time of this run shows local modifications
(`backend/src/services/approvalEngine.ts`, `optimizer/app/core/trains.py`,
`docs/DECISIONS.md`, others) that have not been pushed, so CI's green state
below describes `origin/main` at commit `8ca54f6`, not the working
directory this document's other numbers were generated from.

| Workflow | Last run | Result | Commit |
|---|---|---|---|
| `backend` | 2026-08-26T17:22:30Z ([`32993745109`](https://github.com/aroy2o/railway/actions/runs/32993745109)) | ✅ success | pre-8ca54f6, no backend-affecting push since |
| `optimizer` | 2026-09-10T17:07:38Z ([`34506289915`](https://github.com/aroy2o/railway/actions/runs/34506289915)) | ✅ success | `8ca54f6` |
| `frontend` | 2026-09-10T17:07:38Z ([`34506289969`](https://github.com/aroy2o/railway/actions/runs/34506289969)) | ✅ success | `8ca54f6` |
| `data` | 2026-08-26T16:31:48Z ([`32988892557`](https://github.com/aroy2o/railway/actions/runs/32988892557)) | ✅ success | pre-8ca54f6, no data-affecting push since |

**Say this in front of judges, and it's true:** "CI runs on every push,
scoped per folder, and every workflow's last run is green." Be precise if
pressed further: the backend and data workflows simply haven't been
triggered since 2026-08-26 because nothing touching those folders has been
pushed since — that is not the same claim as "green on today's code,"
which the fresh local run in §6 covers instead.

## 8. Known, deliberately unfixed risk

**TX7 — concurrent overrides on the same task race, and the loser is told
it won.** Per `docs/DECISIONS.md` and `TASKS.md`: `overrideEngine.ts` has no
optimistic-concurrency check (no version field, no conflict detection). Two
`POST /override` calls for the same task firing milliseconds apart both
return `201` with all 6 checks passed: the audit trail is honest (both
events logged in order), but only the later one survives in the effective
plan, and the earlier caller is never told theirs didn't stick.
Low-probability in a solo-demo context (one person drives the UI), but a
real gap against FR6.2's "every override is logged" promise. **Not
re-verified this session** — carried forward from prior audit as a known,
documented gap, not re-checked against today's code.

---

## Note on what this document does NOT contain

No headline "% improvement" figure appears anywhere above. The codebase
itself never computes one — `frontend/src/lib/comparison.ts` deliberately
renders baseline and optimizer values side by side without a derived ratio,
specifically to avoid a misleading "green improvement badge" over numbers
that don't support that framing (utilisation being the clearest example:
higher is worse here). Inventing one for this document would be exactly the
kind of unsupported summary statistic this project's own honesty discipline
exists to prevent — so it isn't here. If a judge asks "so what's the
percentage improvement," the honest answer is that the project deliberately
doesn't report one, and §2 explains why with a live number that makes the
reason concrete.
