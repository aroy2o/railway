# Pitch numbers — pulled from a real run

**Every number below came from one live run today, not from memory or old
session logs.** Source: `POST /api/schedules/generate` (schedule
`SCH-20260826121521565`, generated `2026-08-26T12:15:21.565Z`, weekly
horizon), immediately after `npm run demo:reset` — a genuine first-generation
run against a clean database, not accumulated test history. Full raw
response captured; every figure below is either read directly from it or
computed the same way the product itself already computes it (never a new
ratio invented for this document — see the note at the bottom).

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
D-084.*

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
| Block utilisation | **77.01%** | 59.92% | `.blockUtilisationPct` |

**Read the utilisation row backwards on purpose.** The baseline's 77.01% is
*higher* than the optimizer's 59.92% because it over-subscribes windows —
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
response.*

## 3. Solve status and time

| | Value |
|---|---|
| Status | **FEASIBLE** (not OPTIMAL) |
| Solve time | **10.005s** against a configured `SOLVER_MAX_SECONDS=10` ceiling |
| Objective value | 32,270,889 |

**Say this plainly if asked, don't dodge it:** the solver does not prove
this is the mathematically best possible plan within its time budget — it
proves the plan is feasible (every hard constraint genuinely holds:
0 resource conflicts, 0 dependency violations, 0 double-bookings, 0
train-impact conflicts — see the response's own `knownGaps`) and reports
honestly that it ran out of time before proving optimality, roughly a **2%
gap** to the solver's own best proven bound (`docs/DECISIONS.md` D-082's
measured figure, not re-derived today).

**Reproducibility verified live today, not assumed from an old session:**
generated the schedule twice in a row against the same reset database.
`objectiveValue` (32,270,889), `status` (FEASIBLE), `metrics`,
`comparisonToBaseline`, and every block in `blocks` were **byte-identical**
across both runs (`solveSeconds` 10.005 vs 10.001 — the only difference,
pure wall-clock noise). If a judge asks to see it run twice, it will show
the same plan both times.

*Source: `status`, `solveSeconds`, `objectiveValue` in today's live
response, cross-checked against a second live generation run in this same
session; the ~2% optimality-gap figure is D-082's own measured finding.*

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

*Source: `docs/DECISIONS.md` D-086 (2026-08-26, same day as this
consolidation) — a read-only investigation, not re-run today since it
touches no live-varying state (a combinatorial fact about the fixed 89-task
corpus, not something a fresh schedule generation could change).*

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
| Backend | **135** | 0 | 0 | `cd backend && npm test` (real MongoDB + real optimizer both up — no test silently skipped) |
| Optimizer | **343** | 0 | 9 deselected (`-m live`: real Claude API calls, excluded by design — costs money, needs `ANTHROPIC_API_KEY`) | `cd optimizer && .venv/bin/python -m pytest` |
| Frontend | **145** | 0 | 0 | `cd frontend && npx vitest run` — plus a fresh `tsc -b` and `eslint .`, both clean |
| Data | **105** | 0 | 0 | `cd data && .venv/bin/python -m pytest` |
| **Total** | **728** | **0** | 9 (by design) | |

**One real drift found and corrected here, not silently carried forward:**
`TASKS.md`'s T25 entry states block utilisation as 45.42%; today's live
figure is 59.92% (§2 above). This is not a discrepancy to worry about — T29
Phase 1 (task splitting, built after T25) legitimately changed how many
tasks get scheduled and how much block time they consume. The historical
number was accurate *as of T25*; it was never updated afterward because
nothing asked it to be until this session. **Use 59.92%, not 45.42%, if
quoting utilisation** — the fresher, live-verified figure, not the one
sitting in an old session log.

## 7. CI status

**Pushed to `origin/main` and confirmed registered — but every real
execution attempt has failed with `startup_failure`, not a test
failure.** All 7 feature commits plus 2 follow-ups (9 total) pushed on
2026-08-26. GitHub Actions is enabled on the repo and all four workflows
registered as `state: "active"`; their content, re-fetched directly from
GitHub, is byte-identical to the locally `actionlint`-validated files —
this is not a YAML/schema defect in the workflow files.

**What actually happened, across six real attempts spanning both trigger
types:** `optimizer` (push, then `workflow_dispatch`), `backend`
(`workflow_dispatch`), and `data` (push) each completed with
`startup_failure` and **zero jobs ever created** - no logs, no
annotations, nothing ran. `repos/.../actions/cache/usage` shows 0 bytes
cached and 0 caches, confirming this repository has never had a single
Actions job actually execute, on any workflow, ever. That consistency
across three different workflow files and two different trigger
mechanisms (`push` and manual `workflow_dispatch`) rules out a per-file
bug or a one-off fluke - it points to an **account- or repository-level
gate that blocks job execution before a runner is even assigned**, most
consistent with a GitHub Actions billing/spending-limit setting on this
private repository (the classic real-world cause of exactly this
signature). One more run got stuck indefinitely in a pre-queued limbo
state; attempting to cancel it returned "Cannot cancel a workflow run
that has not been queued yet" (HTTP 409) - the run record exists but
GitHub's scheduler never actually admitted it to the real queue, which is
consistent with a gate rejecting it before scheduling rather than any
runner-availability or code issue. This cannot be diagnosed or changed
via the API access
available in this session (`gh auth status` lacks the `user` scope
billing needs) - **check
[github.com/settings/billing](https://github.com/settings/billing) and
this repo's Settings → Actions → General page directly.** If a spending
limit is set to $0 or free private-repo minutes are exhausted for this
billing cycle, that is almost certainly it.

**Do not claim "CI is green" in front of judges.** The accurate claim is:
"CI is written, `actionlint`-clean, and registered on GitHub; execution
is currently blocked by an account-level setting, not a code or test
failure - the actual test suites all pass locally (§6)." If asked to
demonstrate, show the local test runs (§6, real and fresh) rather than
the Actions tab, and be upfront that CI itself hasn't executed yet if
asked directly - do not claim a passing run that didn't happen.

## 8. Known, deliberately unfixed risk

**TX7 — concurrent overrides on the same task race, and the loser is told
it won.** Confirmed still accurate today: `overrideEngine.ts` has no
optimistic-concurrency check (no version field, no conflict detection)
since it was documented. Two `POST /override` calls for the same task
firing milliseconds apart both return `201` with all 6 checks passed: the
audit trail is honest (both events logged in order), but only the later one
survives in the effective plan, and the earlier caller is never told theirs
didn't stick. Low-probability in a solo-demo context (one person drives the
UI), but a real gap against FR6.2's "every override is logged" promise. Not
attempted in this session, per this task's own instruction — reported here
only to confirm the description in `TASKS.md` still matches the code as it
stands today.

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
