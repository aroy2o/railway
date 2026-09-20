# Math reference — every formula, hand-checkable

**Purpose.** Every worked example below uses real numbers pulled live from
the running app tonight (2026-09-02), via the real API and direct MongoDB
queries — nothing invented, nothing reconstructed from memory. Every
example was independently recomputed (by script, at full float precision,
not by hand-rounding) and checked against what the app itself reports. Where
a check is marked ✅, the two numbers matched exactly. **No mismatch was
found anywhere in this document** — if one had been, it would be flagged
here in bold, not smoothed over.

**Source schedule for most worked examples:** `SCH-20260902150309766`
(weekly horizon, generated 2026-09-02T15:03:09Z, 64 tasks scheduled / 25
deferred / 29 split / 5 cross-department batches — the standard shape this
project's own `PITCH_NUMBERS.md` documents). This schedule will not exist
after tonight's closing `npm run demo:reset` (per this task's own rules) —
that is expected. **The formulas below do not change** between runs; only
the specific numbers plugged into them will, since a fresh generation
against the same 89-task corpus can place things on different days. If you
regenerate before the pitch, the task IDs (`TSK-00001`, `TSK-00010`, etc.)
and asset IDs stay the same — only the corridor+date they land on may move.

---

## 1. Asset criticality score

**Formula:**

```
criticality = 100 × ( 0.30×safetyImportance + 0.25×trainsAffected_norm
                     + 0.20×noAlternateRoute + 0.15×passengerDependency
                     + 0.10×historicalFailureFreq_norm )
```

where `trainsAffected_norm = min(1, ln(1+trainsAffectedCount) / ln(1+281))`
(log-scaled, capped at the network-wide observed maximum of 281 trains/day)
and `historicalFailureFreq_norm = min(1, failuresPerYear / 3.0)`.
`noAlternateRoute` is 1 if no alternate route exists, else 0 — inverted
because the ABSENCE of an alternative is what raises risk.

**Where it lives:** `data/generators/criticality.py` — `criticality_score()`,
`criticality_components()`, `normalise_trains_affected()`,
`normalise_failure_frequency()`. Weights in `data/generators/config.py`,
`CRITICALITY_WEIGHTS`. Computed once at data-generation time (not
per-request) and stored on the asset document.

**Worked example — asset `AST-ABEO-ABU-1` (corridor ABEO–ABU):**

Real stored inputs (`db.assets.findOne({_id:"AST-ABEO-ABU-1"}).criticality`):

| Input | Value | Real or synthetic? |
|---|---:|---|
| `safetyImportance` | 0.7542 | SYNTHETIC |
| `trainsAffectedCount` | 1 | **REAL** (T3, real observed traffic) |
| `alternateRouteAvailable` | true | SYNTHETIC |
| `passengerDependency` | 0 | SYNTHETIC |
| `historicalFailureFreq` | 0.667 (failures/year) | SYNTHETIC |

Step by step:

1. `trainsAffected_norm = ln(1+1) / ln(1+281) = ln(2) / ln(282) = 0.693147 / 5.641907 = 0.12286`
2. `noAlternateRoute = 0` (a route IS available)
3. `historicalFailureFreq_norm = 0.667 / 3.0 = 0.22233`
4. Weighted terms:
   - `0.30 × 0.7542 = 0.22626`
   - `0.25 × 0.12286 = 0.030715`
   - `0.20 × 0 = 0`
   - `0.15 × 0 = 0`
   - `0.10 × 0.22233 = 0.022233`
5. Sum = `0.22626 + 0.030715 + 0 + 0 + 0.022233 = 0.279208`
6. `criticality = 100 × 0.279208 = 27.9208 → rounds to 27.92`

**Dominant factor:** the largest weighted term is `0.30×0.7542=0.22626`
(safety_importance) → `safety_importance`.

✅ **Matches what the API/DB shows:** `criticalityScore: 27.92`,
`dominantCriticalityFactor: "safety_importance"` — exact match.

**Real vs synthetic:** only `trainsAffectedCount` is real (from T3's real
train-traversal counts). The other four inputs (safety importance,
alternate-route flag, passenger dependency, historical failure frequency)
are synthetic, generated to PRD 5.2's specified skewed distributions — no
public dataset for these exists for Indian Railways' internal maintenance
backlog.

---

## 2. Task priority score

**Formula (when a failure-risk score is available for the task's asset):**

```
priority = 100 × ( 0.30×severity_norm + 0.25×criticality_norm
                  + 0.20×failureRisk_norm + 0.15×slaUrgency
                  + 0.10×slaBreach )
```

where `severity_norm = severity/5`, `criticality_norm =
assetCriticalityScore/100`, `failureRisk_norm = failureRiskScore/100`,
`slaUrgency = clamp((90 − daysToDue)/90, 0, 1)` (ramps from 0 a full
90-day SLA window out, to 1 on the due date), and `slaBreach =
clamp(daysOverdue/60, 0, 1)` (0 if not yet due; saturates at 60 days late).

If the task's asset has no failure-risk score (fewer than 3 degradation
observations), the same four other weights are used **renormalised** to
sum to 1.0 (0.30/0.25/0.15/0.10 ÷ 0.80 = 0.375/0.3125/0.1875/0.125) rather
than silently treating the missing risk as zero.

**Where it lives:** `optimizer/app/core/priority.py` — `score_task()`,
`sla_urgency()`, `sla_breach()`. Weights: `PRIORITY_WEIGHTS` /
`WEIGHTS_WITHOUT_RISK` in the same file.

**Worked example — task `TSK-00001`** (same corridor/asset as §1, so the
criticality figure above feeds directly in):

Real stored inputs:

| Input | Value | Real or synthetic? |
|---|---:|---|
| `severity` | 2 (of 5) | SYNTHETIC |
| asset `criticalityScore` | 27.92 (§1 above) | mixed — see §1 |
| `failureRiskScore` | 65.17 (§3 below) | ENTIRELY SIMULATED |
| `slaDueDate` | 2026-11-10 | SYNTHETIC |
| `daysToDue` (as of 2026-09-02) | 69 | derived from the above |

Step by step:

1. `severity_norm = 2/5 = 0.4`
2. `criticality_norm = 27.92/100 = 0.2792`
3. `failureRisk_norm = 65.17/100 = 0.6517`
4. `slaUrgency = (90 − 69)/90 = 21/90 = 0.23333`
5. `slaBreach = 0` (69 days still remain — not overdue)
6. Weighted contributions (×100 to land on the 0–100 scale):
   - severity: `100 × 0.30 × 0.4 = 12.0`
   - criticality: `100 × 0.25 × 0.2792 = 6.98`
   - failure risk: `100 × 0.20 × 0.6517 = 13.034 → 13.03`
   - SLA urgency: `100 × 0.15 × 0.23333 = 3.5`
   - SLA breach: `100 × 0.10 × 0 = 0`
7. `priority = 12.0 + 6.98 + 13.03 + 3.5 + 0 = 35.51`

**Dominant factor:** largest contribution is `13.03` (failure_risk).

✅ **Matches what the API/DB shows:** `priorityScore: 35.51`,
`dominantPriorityFactor: "failure_risk"`, and every individual
`contributions`/`components` value above matches the stored
`priorityBreakdown` field exactly.

**Real vs synthetic:** severity and SLA dates are synthetic (T4). Asset
criticality is the mixed real/synthetic figure from §1. Failure risk is
entirely simulated (§3) — this is the ONE component of the priority score
built on no real data whatsoever, and it happens to be the dominant factor
in this particular example, which is worth saying out loud if a judge
challenges "why is this task ranked where it is."

---

## 3. Predictive risk model

**Formula:** ordinary least squares (OLS) linear regression on an asset's
monthly `healthMetric` observations (oldest first, evenly spaced), fit as
`health(month_index) = intercept + slope × month_index`, extrapolated
forward to the point where fitted health crosses a 0.30 "intervention
threshold." The result is expressed as a 0–100 score:

```
monthsToThreshold = (currentFittedHealth − 0.30) / (−slope)
riskScore = 100 × clamp(1 − monthsToThreshold/24, 0, 1)
```

(24 months = the horizon beyond which an asset is "not soon" and scores 0.
If already at/below 0.30, the score is 100 outright — a fact about the
present, not a forecast.)

**Where it lives:** `optimizer/app/core/risk.py` — `assess_asset()`,
`_fit_line()`. `FAILURE_THRESHOLD=0.30`, `HORIZON_MONTHS=24.0`,
`MIN_POINTS=3` (fewer than 3 points → not scored, reported as `null` with a
reason, never guessed).

**Worked example — asset `AST-ABEO-ABU-1`, 12 real (simulated) monthly
observations** (`db.assets.findOne(...).degradationHistory`):

| Month index (x) | Date | healthMetric (y) |
|---:|---|---:|
| 0 | 2025-09-26 | 0.8382 |
| 1 | 2025-10-26 | 0.8299 |
| 2 | 2025-11-25 | 0.7935 |
| 3 | 2025-12-25 | 0.7740 |
| 4 | 2026-01-24 | 0.7440 |
| 5 | 2026-02-23 | 0.7215 |
| 6 | 2026-03-25 | 0.7045 |
| 7 | 2026-04-24 | 0.6489 |
| 8 | 2026-05-24 | 0.6255 |
| 9 | 2026-06-23 | 0.5964 |
| 10 | 2026-07-23 | 0.5523 |
| 11 | 2026-08-22 | 0.5402 |

Step by step (standard OLS, `n=12`):

1. `mean_x = (n−1)/2 = 5.5`
2. `mean_y = sum(y)/12 = 8.3689/12 = 0.697408`
3. `Sxx = Σ(x−mean_x)² = 143` (a fixed value for any 12 evenly-spaced
   points: `n(n²−1)/12 = 12×143/12`)
4. `Sxy = Σ(x−mean_x)(y−mean_y) = −4.10045` (sum each `(x−5.5)` times its
   `(y−0.697408)` — the biggest terms come from the first and last points,
   which are furthest from `mean_x`)
5. `slope = Sxy/Sxx = −4.10045/143 = −0.0286745` (health per month)
6. `intercept = mean_y − slope×mean_x = 0.697408 − (−0.0286745×5.5) = 0.855118`
7. `currentFittedHealth = intercept + slope×11 = 0.855118 − 0.315419 = 0.539699`
8. `monthsToThreshold = (0.539699 − 0.30) / 0.0286745 = 0.239699/0.0286745 = 8.3593`
9. `riskScore = 100 × (1 − 8.3593/24) = 100 × (1 − 0.34830) = 100 × 0.65170 = 65.17`

✅ **Matches what the API/DB shows:** `failureRiskScore: 65.17`,
`failureRiskBreakdown.currentHealth: 0.5397`,
`failureRiskBreakdown.declinePerMonth: -0.02867`,
`failureRiskBreakdown.monthsToThreshold: 8.4` — every figure matches
exactly (to the app's own stated rounding).

**A note on redoing this by hand:** steps 3–4 (`Sxx`, `Sxy`) are the only
tedious part — 12 multiply-and-sum terms each. A judge with a phone
calculator CAN redo this, but it is fair to warn them it takes a few
minutes, not seconds — offer the table above rather than expecting mental
arithmetic.

**Real vs synthetic — stated as plainly as the code itself states it:**
**100% of this section's inputs are simulated.** The `healthMetric` series
is generated by `data/generators/generate.py`'s degradation simulator
(constant per-asset decline + Gaussian noise), not measured from any real
asset. The model's own framing string, returned by every API response that
carries a risk score, says this outright: *"Prototype predictive risk
model trained on simulated asset degradation patterns... It does not
predict real Indian Railways asset failures."* If a judge asks whether
this predicts real failures, the honest answer is no, and this document's
job is to prove the *arithmetic* is real, not that the *inputs* are.

---

## 4. CP-SAT objective function

**Formula** (five weighted terms, summed and maximized by the solver):

```
Objective = Σ over every SCHEDULED task:      10000 × solverPriority
          + Σ over every ON-TIME task:         2000
          + Σ over every BATCHED window:       3000
          − Σ over every OPENED window:        1 × unusedMinutes
          − Σ over every OPENED window:        500
```

- `solverPriority = max(1, round(priorityScore))` — the §2 score, rounded
  to the nearest integer (CP-SAT needs integer coefficients).
- A task counts as "scheduled" once, in full, regardless of whether it was
  placed in one block or split across several (T29 Phase 1) — never
  rewarded per-segment.
- "On-time" means every window the task occupies falls on or before its
  SLA due date.
- "Batched" means a window hosts 2+ departments at once.
- "Opened" means the window has any task in it at all; `unusedMinutes =
  capacityMinutes − usedMinutes` for that window.

**Where it lives:** `optimizer/app/core/scheduler.py` — the
`ObjectiveWeights` dataclass (default values `coverage=10000,
sla_compliance=2000, batching=3000, unused_minute=1, fragmentation=500`)
and the `objective_terms` construction just before `model.maximize(...)`.

**Worked example — the full objective, reconstructed from real block data
and compared to the solver's own reported value.** This is not a small
hand example — it genuinely sums all 64 scheduled tasks and 137 opened
windows, so the arithmetic below is grouped into five subtotals rather
than one line per task (the same five terms the formula names), each of
which IS individually pure addition a judge could redo from the raw
`blocks`/`deferredTasks` JSON if they wanted to check one term in
isolation:

| Term | Count | Subtotal |
|---|---:|---:|
| Coverage: `10000 × Σ(solverPriority)` over 64 scheduled tasks (sum of priorities = 3,339) | 64 tasks | `10000 × 3339 = 33,390,000` |
| SLA compliance: `2000 ×` (count of tasks whose every placed window is on/before their SLA due date) | 40 of 64 on time | `2000 × 40 = 80,000` |
| Batching: `3000 ×` (count of windows with 2+ departments) | 5 windows | `3000 × 5 = 15,000` |
| Unused-minute penalty: `1 ×` (sum of `unusedMinutes` over all 137 opened windows) | 6,923 min total | `1 × 6923 = 6,923` |
| Fragmentation penalty: `500 ×` (count of opened windows) | 137 windows | `500 × 137 = 68,500` |

```
Objective = 33,390,000 + 80,000 + 15,000 − 6,923 − 68,500
          = 33,409,577
```

✅ **Matches what the API shows:** `schedule.objectiveValue: 33409577` —
exact match, to the integer.

**Real vs synthetic:** the objective is a pure function of the priority
scores (§2, mixed real/synthetic) and the real corridor-window structure
(§5) — no new synthetic input is introduced by the objective itself. The
weight VALUES (10000/2000/3000/1/500) are a design choice (D-023),
verified — not fitted from any dataset — to encode a strict priority order
(covering the single lowest-priority task always outweighs the largest
possible tidiness saving).

---

## 5. Block/window capacity check (the "does this fit" arithmetic)

**This is the section to lead with if challenged on any conflict number —
it needs no software, only addition.**

**The rule:** for a given corridor+date+window, sum every task's real
duration that a department has claimed into it. If that sum exceeds the
window's real capacity (a fact about the actual train timetable, not about
this app), the window is over-subscribed.

```
claimedMinutes = Σ(duration of every task placed in this window)
overSubscribed = claimedMinutes > capacityMinutes
excessMinutes  = claimedMinutes − capacityMinutes
```

**Where it lives:** `optimizer/app/core/baseline.py` — `_detect_conflicts()`
(the `claimed > window.duration_minutes` check). The window's capacity
itself comes from `corridor_calendar` (T3), derived from the real ISL
timetable's occupied windows for that corridor.

**Worked example — a real over-subscribed window in the current baseline
output.** Corridor `BBPR-SYU`, 2026-09-02, window 0.

**The window's capacity — real, from the timetable, not from this app's
own output:**

```
db.corridor_calendar.findOne({_id:"BBPR-SYU"}).maxDailyBlockWindows[0]
  = { start: "00:00", end: "04:01", durationMin: 241 }
```

241 minutes is a real fact: it is the gap between real scheduled trains on
this corridor, with T3's 5-minute clearance margin already applied on
each side — nothing this app invented.

**The three real tasks the baseline (uncoordinated, department-blind)
process placed into this same window**, from `db.tasks`:

| Task | Department | `estBlockDurationMins` (real field, synthetic value) |
|---|---|---:|
| TSK-00007 | S&T | 96 |
| TSK-00008 | S&T | 116 |
| TSK-00004 | TRD | 121 |

S&T (unaware of TRD) claims this window for its own two tasks:
`96 + 116 = 212` minutes. TRD (unaware of S&T) separately claims the SAME
window for its own one task: `121` minutes. Neither department sees the
other's claim — that is the entire point of the baseline simulating
today's process (D-030).

**Total claimed against this one window:**

```
212 + 121 = 333 minutes
```

**Compare to capacity:**

```
333 > 241
333 − 241 = 92 minutes over
```

✅ **Matches what the API/UI shows:** the baseline's own conflict record
for this exact window reads *"S&T + TRD claimed 333 min of a 241 min
window - 92 min more than it can hold"* — `claimedMinutes: 333`,
`capacityMinutes: 241`, `excessMinutes: 92`, all exact matches to the
addition above.

**Real vs synthetic:** the window's 241-minute capacity is 100% real
(timetable-derived). The three task durations summed against it are
synthetic (T4-generated), same as every task duration in the corpus. The
over-subscription finding itself — that uncoordinated departments
double-book real capacity — is the honest headline of this whole project,
and it rests on real capacity numbers.

---

## 6. Block utilisation percentage

**Formula:**

```
utilisationPct = 100 × (Σ usedMinutes across every block) / (Σ capacityMinutes across every block)
```

For the baseline specifically, `capacityMinutes` is summed over **distinct
windows** (a window claimed by two departments is not double-counted in
the denominator, only in the numerator via each department's own block) —
which is precisely why the baseline's utilisation can read as "high" while
also being the over-subscribed, defective plan.

**Where it lives:** the ratio itself is computed server-side
(`backend`'s schedule metrics assembly); the underlying `usedMinutes`/
`capacityMinutes` per block are the same fields shown in §5.

**Worked example — both plans, real block data from `SCH-20260902150309766`:**

**Optimizer (AI-optimized) plan:** summed over all 137 real blocks:

```
Σ usedMinutes     = 9,879
Σ capacityMinutes = 16,802
utilisationPct = 100 × 9879 / 16802 = 58.796... → 58.80
```

✅ Matches `metrics.blockUtilisationPct: 58.8`.

**Baseline plan:** summed over all real department-blocks (which DOES
double-count a window's capacity when 2 departments both hold it — this
is the source of the discrepancy between "77% utilisation" and "the
process is broken"):

```
Σ usedMinutes (all department claims, may double-book)     = 4,880
Σ capacityMinutes (distinct windows only, not double-counted) = 6,337
utilisationPct = 100 × 4880 / 6337 = 77.0080... → 77.01
```

✅ Matches `baseline.metrics.blockUtilisationPct: 77.01`.

**The honest reading, stated in the app's own words (`caveats[]`
field of the live API response):** *"Baseline block utilisation is HIGHER
than the optimizer's because it over-subscribes windows. Never render
utilisation without the double-booking count beside it."* The higher
number here is the defect, not an advantage — §5 shows exactly why.

---

## 7. Baseline vs AI comparison metrics — counting rules, verified by hand

Every metric on the Comparison screen, its exact rule, and a real
verification against `SCH-20260902150309766`'s raw data.

### Contestable / split-only / structurally-impossible classification

**Rule** (`optimizer/app/core/scheduler.py::classify_structural_feasibility`):
- **CONTESTABLE**: the task's duration fits inside the single LONGEST free
  window on its corridor, within the horizon. Placeable by either engine.
- **SPLIT_ONLY**: does not fit any single window, BUT the defect type is
  splittable (§7's defect list below) AND the SUM of every candidate
  window's capacity on that corridor, across the whole horizon, is at
  least the task's duration.
- **IMPOSSIBLE**: neither of the above.

**Worked example, CONTESTABLE — `TSK-00001`:** needs 200 minutes. Corridor
`ABEO-ABU`'s real windows: `34 min` and `1,394 min`. Longest = 1,394.
`200 ≤ 1394` → **CONTESTABLE**. ✅ Confirmed: this task was actually placed
by both the baseline and the optimizer.

**Worked example, SPLIT_ONLY — `TSK-00010`:** cable fault (a splittable
defect type — `optimizer/app/core/splitting.py`'s
`SPLITTABLE_DEFECT_TYPES`), needs 118 minutes. Corridor `BCA-TGA` has
exactly ONE real window pattern, repeating daily: **58 minutes**. `118 >
58` → does not fit a single window. But splittable, and the horizon is 7
days: total capacity across the horizon = `58 × 7 = 406 ≥ 118` →
**SPLIT_ONLY**. The optimizer actually placed it across 3 real segments:

```
2026-09-02: 58 min
2026-09-03: 30 min
2026-09-04: 30 min
58 + 30 + 30 = 118  ✅ exactly TSK-00010's estBlockDurationMins (118)
```

(The two smaller segments sit exactly at `MIN_SPLIT_SEGMENT_MINUTES=30` —
the floor below which a segment is not allowed to be worth opening a
possession for.)

**Totals:** 36 contestable + 32 split-only + 21 impossible = 89. ✅
Matches `comparisonToBaseline.{contestableTaskCount, splitOnlyTaskCount,
structurallyImpossibleCount}` and sums to the real 89-task corpus exactly.

### Cross-department batches

**Rule:** a scheduled window counts as a batch if it hosts tasks from 2+
distinct departments — `len(set(block.departments)) > 1`.

**Verified:** recounting directly over `SCH-20260902150309766`'s 137 real
optimizer blocks (not trusting the reported field), exactly **5** have
2+ distinct departments. ✅ Matches `metrics.crossDepartmentBatches: 5`.

### Double-bookings (baseline only)

**Rule:** for a window, for every PAIR of tasks placed there by two
DIFFERENT departments (each department packs its own tasks back-to-back
starting from the window's own start time, blind to any other
department — `optimizer/app/core/baseline.py::_build_blocks`), if their
resulting time spans genuinely overlap (`overlap_start < overlap_end`),
that pair counts as one double-booking.

**Worked example:** `TSK-00007` (S&T, 96 min) and `TSK-00004` (TRD, 121
min) both landed on `BBPR-SYU`, window 0, capacity-start `00:00`. Each
department places its FIRST task in this window at the window's own start
(minute 0 relative to the window), since neither sees the other:

```
TSK-00007 (S&T): [0, 96) minutes into the window
TSK-00004 (TRD): [0, 121) minutes into the window
overlap = min(96,121) − max(0,0) = 96 minutes
```

✅ Matches the real conflict record exactly: *"S&T and TRD both hold
BBPR-SYU from 00:00 to 01:36 - 96 minutes of overlap"* (96 minutes =
01:36 on a 24-hour clock).

**Total:** 6 double-bookings reported (`comparisonToBaseline.baseline.
doubleBookings: 6`), cross-checked against the independent tally in the
same response's `conflictReport.byPlan.baseline.byType.
CORRIDOR_DOUBLE_BOOKING: 6` — the two numbers, computed by different code
paths in this app, agree.

### Over-subscribed windows (baseline only)

Covered fully in §5 above — same rule, same real example (`BBPR-SYU`
window 0, 333 > 241).

---

## 8. Train-impact scoring

**Formula:**

```
weightedImpact = meanTierWeight × displacedMinutes

meanTierWeight = Σ(tierWeight[tier] × trainCount[tier]) / Σ(trainCount[tier])
```

Tier weights: `flagship=4.0, express=2.0, passenger=1.0, suburban=0.7,
unknown=1.0` (a class the timetable could not identify, ~2.8% of real
observations, is scored neutral rather than free). `trainCount[tier]` is
the corridor's REAL observed class mix, collapsed from its real per-code
train counts.

**Where it lives:** `optimizer/app/core/trains.py` — `assess_span()`,
`mean_tier_weight()`, `tier_mix()`. `TIER_WEIGHTS`, `TRAIN_TIERS`.

**Worked example — deferred task `TSK-00014`, corridor `BCA-TGA`, a real
traffic-block costing:**

Real class mix for `BCA-TGA` (`db.corridor_calendar.findOne(...).
trainClassMix`), 109 real observed trains total:

| Code | Count | Tier |
|---|---:|---|
| Exp | 69 | express |
| GR | 4 | express |
| Mail | 2 | express |
| SF | 8 | express |
| Pass | 24 | passenger |
| (unknown) | 2 | unknown |

Collapsed by tier: `express=83, passenger=24, unknown=2` (sums to 109 ✓).

Step by step:

1. `meanTierWeight = (2.0×83 + 1.0×24 + 1.0×2) / 109 = (166 + 24 + 2)/109 = 192/109 = 1.76147`
2. The real, measured overlap for this specific traffic block:
   **1 train, 6 minutes** (`measured.trainsAffected: 1`,
   `measured.displacedMinutes: 6` — real, from the actual occupied-window
   overlap, not estimated)
3. `weightedImpact = 1.76147 × 6 = 10.5688 → 10.57`
4. Tier split (estimated, apportioned from the corridor's mix, since the
   displaced service's individual class was not recorded alongside the
   occupied window): `1 × 83/109 = 0.7615 → 0.76` (express), `1 ×
   24/109 = 0.2202 → 0.22` (passenger), `1 × 2/109 = 0.0183 → 0.02`
   (unknown)

✅ **Matches what the API shows exactly:** `weightedImpact: 10.57`,
`tierSplit: {express: 0.76, passenger: 0.22, unknown: 0.02}`.

**Real vs synthetic:** the train count and displaced-minute figures are
100% real (T3's real ISL timetable). The class-weighted cost (which tier
each displaced train probably belongs to) is an ESTIMATE, apportioned from
the corridor's real class mix — not measured for this specific block,
because the per-service class was not retained alongside the timetable's
occupied-window times. The app's own `framing` field says this on every
response that carries the figure.

---

## 9. Policy slider mechanics

**How a slider plugs in:** each of the five §4 objective weights
(`coverage`, `slaCompliance`, `batching`, `unusedMinute`, `fragmentation`)
is directly the multiplier in front of its term in the objective sum.
Dragging a slider changes that one number and triggers a real re-solve
(never a client-side reinterpretation of the existing plan).

**The safe range:** every weight is bounded to `[0.1×, 10×]` of its D-023
default. This range was verified (not assumed) never to trade away
coverage, even at the worst-case combination (coverage at its floor
against every other weight at its ceiling simultaneously) — the real
corpus still schedules all 36 contestable tasks at that extreme. Pushed
further (0.01× coverage), scheduling drops to 27; at 0.0001×, to 3 — so
the shipped range sits with a wide safety margin, not on the edge of
breaking.

**Where it lives:** `optimizer/app/models/scheduling.py` —
`PolicyWeightsIn`, `WEIGHT_MIN_MULTIPLIER=0.1`, `WEIGHT_MAX_MULTIPLIER=10.0`.

**Worked example — the batching slider, numerically:**

| | Value |
|---|---:|
| Default (1×) | 3,000 |
| Floor (0.1×) | 300 |
| Ceiling (10×) | 30,000 |
| Validated bounds in code (`PolicyWeightsIn.batching`) | `ge=300, le=30_000` |

`3000 × 0.1 = 300` and `3000 × 10 = 30,000` — the code's declared bounds
match the stated multiplier range exactly. ✅ (This is a design-constant
check, not a live-data check — there is no "app output" to compare a
slider's own bound against, since the bound IS the constant.)

Every current live plan's `policyWeights` field
(`schedule.policyWeights`) confirms the default set is what actually ran
tonight: `{coverage:10000, slaCompliance:2000, batching:3000,
unusedMinute:1, fragmentation:500}` — matching §4's defaults exactly, i.e.
no slider was dragged for tonight's reference schedule.

**What the range means in plain terms, if asked:** the slider changes
*which day* the same set of tasks lands on and how tightly windows are
packed — not *how much* gets scheduled. D-061 verified this empirically
across the full range on the real corpus: the scheduled set never changed,
only the day-by-day distribution.

---

## 10. Corridor section extraction / distance validation

**Formula (straight-line distance, Haversine):**

```
a = sin²(Δlat/2) + cos(lat1)×cos(lat2)×sin²(Δlon/2)
straightLineKm = 2 × 6371.0088 × asin(√a)
```

`publishedDistanceKm` is NOT computed — it is read directly from the real
ISL (Indian Railways) timetable's own inter-station distance figure, when
that source lists the pair. `straightLineKm` is the only DERIVED number
here, and only ever used as a lower-bound sanity check against
`publishedDistanceKm`, never as a substitute for it.

**Where it lives:** `data/ingestion/datameet.py` — `great_circle_km()`
(the Haversine formula, `EARTH_RADIUS_KM=6371.0088`).
`data/ingestion/build_corridors.py` — where `publishedDistanceKm` is
pulled from the ISL CSV and `straightLineKm` is computed per corridor.

**Worked example — corridor `BCA-TGA`:**

Real station coordinates (`db.corridors.findOne({_id:"BCA-TGA"})`):

| Station | Lat | Lon |
|---|---:|---:|
| BCA (Bachwara Jn) | 25.5812576 | 85.9001424 |
| TGA (Teghra) | 25.5110200 | 85.9417740 |

Step by step (carrying enough decimal places to actually reproduce — this
is the one calculation in this document where truncating early changes
the answer, so a spreadsheet or scientific calculator, not mental math, is
the honest tool for a judge to use here). Every number below is copied
directly from a script evaluating the exact formula on the exact stored
coordinates — not re-derived by hand a second time, to avoid introducing a
transcription error of its own:

1. Convert both points to radians: `lat1=0.4464772, lon1=1.4992403,
   lat2=0.4452513, lon2=1.4999669`
2. `Δlat = lat2 − lat1 = −0.0012259`, `Δlon = lon2 − lon1 = 0.0007266`
3. `sin²(Δlat/2) = 3.75694×10⁻⁷`
4. `cos(lat1) = 0.9019738`, `cos(lat2) = 0.9025025`
5. `sin²(Δlon/2) = 1.31990×10⁻⁷`
6. `a = 3.75694×10⁻⁷ + (0.9019738 × 0.9025025 × 1.31990×10⁻⁷) = 4.83138×10⁻⁷`
7. `√a = 6.950813×10⁻⁴`
8. `asin(√a) = 6.950814×10⁻⁴` (at this scale, `asin(x) ≈ x` to 6 significant figures)
9. `straightLineKm = 2 × 6371.0088 × 6.950814×10⁻⁴ = 8.8567`

✅ **Matches:** `straightLineKm: 8.857`. Real published distance:
`publishedDistanceKm: 9`. Ratio = `9/8.857 = 1.0161`.

**A second, independently checkable corridor — `AAG-WKA`:**

| Station | Lat | Lon |
|---|---:|---:|
| AAG (Angar) | 17.954256 | 75.599875 |
| WKA (Vakav) | 17.988187 | 75.579724 |

Same formula → `straightLineKm = 4.333`. ✅ Matches. Real published
distance: `6`. Ratio = `6/4.333 = 1.3847` — a genuinely curvier section,
not an error (track rarely runs perfectly straight between two points).

**A small real sample, not just the aggregate:**

| Corridor | Published (km, real ISL) | Straight-line (km, derived) | Ratio |
|---|---:|---:|---:|
| AAG-WKA | 6 | 4.333 | 1.385 |
| AAM-CQA | 7 | 6.031 | 1.161 |
| AAS-JWL | 9 | 8.841 | 1.018 |
| AAS-KSW | 9 | 9.185 | 0.980 |
| AAY-NPK | 11 | 9.413 | 1.169 |
| BCA-TGA | 9 | 8.857 | 1.016 |

(One ratio below 1.0 — `AAS-KSW` — is expected, not an error: published
timetable distances round to whole kilometres and a nearly-straight short
section can round either side of its true straight-line length.)

The project-wide **median ratio of 1.034** cited in `FEATURE_AUDIT.md`
comes from the pipeline's own validation step
(`build_corridors.py::_distance_validation`, run over all 3,295 corridors
with both real figures available) — not recomputed here, since redoing a
3,295-corridor median by hand is not a "phone calculator" exercise. The
six-corridor sample above is offered instead as something a judge actually
can spot-check on the spot.

**Real vs synthetic:** this entire section is **100% real data** — station
coordinates, published ISL distances, and the derived straight-line
sanity check are all traceable to public Indian Railways datasets. This is
the one section of this whole document with zero synthetic input anywhere
in the chain.

---

## If challenged live

| Judge's question | Point them to | The exact real example to show |
|---|---|---|
| "Prove the 77% baseline utilisation number." | §6 | `4880/6337 × 100 = 77.01` — both real block sums, shown next to the reason the *higher* number is the defect (double-booked capacity), from §5. |
| "Prove this conflict is real, not invented." | §5 | `BBPR-SYU` window 0: `96 + 116 + 121 = 333` minutes claimed against a real 241-minute timetable-derived window — pure addition, no app logic involved. |
| "Prove the priority ranking isn't arbitrary." | §2 (with §1 and §3 as the chain behind it) | `TSK-00001`: `12.0 + 6.98 + 13.03 + 3.5 + 0 = 35.51`, every term traceable to a named, weighted, real-or-labelled-synthetic input — never a black-box number. |
| "Prove the solver actually optimizes something, not just runs." | §4 | The full 33,409,577 objective value, reconstructed term-by-term from real scheduled tasks and real window data, matching the solver's own reported figure exactly. |
| "Prove your corridor data is real, not made up." | §10 | Two independently checkable Haversine calculations (`BCA-TGA` → 8.857 km, `AAG-WKA` → 4.333 km) from real station coordinates, matching the stored `straightLineKm` to the millimetre. |

---

## Honest summary: what's real, what's mixed, what's simulated

**Entirely real, no synthetic input anywhere in the chain:** §5 (window
capacity, from the real timetable), §10 (corridor distances, from real
station data and the real ISL timetable) — and the *measured* half of §8
(train counts and displaced minutes). **Mixed real + synthetic, with the
real component always named explicitly per-field:** §1 (asset criticality
— only `trainsAffectedCount` is real), §2 (task priority — severity and
SLA dates are synthetic, criticality is mixed, failure risk is 100%
simulated), §6 and §7 (utilisation and comparison metrics — real
arithmetic performed over a mix of real window capacities and synthetic
task durations), the *estimated* half of §8 (a real class mix apportioned
onto an individual displacement, not measured for it). **Entirely
simulated, with no real-world grounding claimed anywhere:** §3, the
predictive risk model — trained on generator-simulated degradation curves,
explicitly never presented as a forecast of real Indian Railways asset
failures, and the one place in this whole system where "the arithmetic is
correct" and "the prediction is meaningful" are two separate claims — this
document proves the first, and was never asked to prove the second.
