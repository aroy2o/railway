# `/data` — dataset ingestion and synthetic generation

Two clearly separated concerns, matching PRD Section 5:

| Folder | Contents | Data origin |
|---|---|---|
| `ingestion/` | Scripts that fetch and parse **real, public** railway data | `datameet/railways`, `data.gov.in` |
| `generators/` | Scripts that produce **synthetic** maintenance data anchored to that real data | generated locally |
| `raw/` | Downloaded source files, untouched (git-ignored except `MANIFEST.json`) | — |
| `processed/` | Normalised JSON ready for MongoDB seeding (git-ignored except `INGESTION_REPORT.json`) | — |

Bulk data is git-ignored because it is reproducible by re-running the scripts.
`raw/MANIFEST.json` and `processed/INGESTION_REPORT.json` **are** committed —
they are the provenance record of which bytes produced which output.

## Why the split matters

PRD Section 5 draws a hard line between real and simulated data, and the app
carries a visible banner saying so. Keeping ingestion and generation in separate
folders makes that line auditable: anything under `generators/` is synthetic,
anything under `ingestion/` came from a published dataset.

**Real** (do not invent): station codes, zones, corridor sections, train
timetable windows, train type/priority.
**Synthetic** (does not exist publicly): maintenance tasks, defects, asset
criticality attributes, degradation history, resources, task dependencies.

## Setup

```bash
cd data
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Running the ingestion

```bash
cd data
.venv/bin/python -m ingestion.download          # T2: ~98 MB, skips files already present
.venv/bin/python -m ingestion.build_corridors   # T2: corridors.json          (~2 s)
.venv/bin/python -m ingestion.build_timetable   # T3: calendar + trains.json  (~5 s)
.venv/bin/python -m pytest                      # 69 tests
```

Stages are ordered but independent: `build_timetable` reads `corridors.json`
and never writes to it, so either stage can be re-run on its own without
disturbing the other (`docs/DECISIONS.md` D-009).

`download` writes `raw/MANIFEST.json` with each file's URL, byte size, SHA-256
and fetch time. Both build steps read only from `raw/` and are **deterministic**
— identical inputs produce byte-identical outputs, which is why no wall-clock
timestamp is written into them. Re-running is always safe.

### Processed outputs

| File | Task | Contents |
|---|---|---|
| `stations.json` | T2 | 8,990 stations: code, name, zone, state, lat/lon |
| `corridors.json` | T2 | 10,149 corridor sections + structural facts |
| `corridor_calendar.json` | T3 | Per-section occupied and free windows |
| `trains.json` | T3 | 5,208 trains: real class code and accommodation flags |
| `INGESTION_REPORT.json` / `TIMETABLE_REPORT.json` | T2 / T3 | Coverage and validation stats (committed) |

---

## What was actually downloaded

All four files were fetched over the network and verified on disk. Exact sizes
and hashes are in `raw/MANIFEST.json`.

| File | Bytes | Source | Licence |
|---|---:|---|---|
| `stations.json` | 1,864,683 | datameet/railways | CC0 |
| `trains.json` | 14,768,598 | datameet/railways | CC0 |
| `schedules.json` | 82,174,280 | datameet/railways | CC0 |
| `indian_railways_time_table_kaggle.zip` | 1,109,599 | Kaggle mirror of data.gov.in | GODL–India |
| ↳ `isl_wise_train_detail_03082015_v1.csv` | 8,050,200 | extracted from the zip | GODL–India |

`trains.json` is downloaded but **not yet used** — it carries train type/class,
which is needed for train-priority scoring (PRD 9.6) in task T3.

### The data.gov.in fetch — exactly what happened

The PRD names data.gov.in as the timetable source. Here is the literal outcome
of each attempt, so nothing about this is vague:

| Attempt | Result |
|---|---|
| `GET https://www.data.gov.in/catalog/indian-railways-train-time-table` | **HTTP 200**, 1,019,638 bytes of HTML. The page renders download links through the UI; no direct resource URL is exposed in the markup. |
| `GET https://api.data.gov.in/resource/...?format=json` | **HTTP 400** — `{"error": "Authorization field missing"}` |
| `GET https://api.data.gov.in/catalog/...?format=json` | **HTTP 400** — `{"error": "Authorization field missing"}` |
| `GET https://www.kaggle.com/api/v1/datasets/download/harsh16/indian-railways-time-table-for-trains-available` | **HTTP 200** — redirects to a signed Google Cloud Storage URL and serves a valid 1.1 MB zip **without credentials**. |

So: data.gov.in's own API requires an API key, which this project does not have.
The **Kaggle mirror named in PRD 5.1 works**, and it serves the same dataset —
`isl_wise_train_detail_03082015_v1.csv`, 69,006 rows, the ISL-wise train detail
published 03-08-2015. No synthetic substitute was used at any point.

---

## What is real, what is derived

### `processed/stations.json` — 8,990 stations

Every field is copied directly from `stations.json`, with codes upper-cased and
stripped (the schedules file pads some codes, and without normalising, the join
silently loses rows):

`code`, `name`, `zone`, `state`, `address`, `lat`, `lon`

Two honest gaps in the source data, neither filled in:

- **293 stations have no coordinates.** `lat`/`lon` are `null` for those.
- **4,532 of 8,990 stations have a blank `zone`.** Left as `null` — a zone is
  never guessed from geography.

### `processed/corridors.json` — 10,149 corridor sections

**Corridor sections are derived, not a field in any source.** PRD 5.1 defines
them as *"any two consecutive stations on a real route"*, and that is exactly
what is computed — from the 417,080 stop records in `schedules.json`.

The derivation rests on two properties of the source that were **verified
against the downloaded file**, not assumed:

1. **Stop records are not grouped by train.** They are interleaved throughout
   the array, so records are grouped by `train_number` first.
2. **`id` is the stop sequence.** There is no stop-number field; within a train,
   ids run consecutively in travel order. 5,022 of 5,208 trains form a single
   unbroken id block.

A train's stops are split into separate runs wherever ids are **not**
consecutive. This matters more than it sounds:

- Some train numbers carry a **full duplicate copy** of their stop list under a
  separate id block — train `04857` appears twice (ids 11615–11621 and
  11813–11819). Chaining straight through would have invented a `JU–PPR`
  section joining the end of one copy to the start of the next: a corridor that
  does not exist on the ground. There is a dedicated unit test for this case.
- A smaller id gap means an intermediate stop is missing from the dataset, so
  the stations either side are *not* adjacent and must not be joined.

Splitting is conservative in both cases: it can omit a real section, never
fabricate one.

Sections are **undirected** — a stretch of track is the same physical asset in
both directions — and keyed on the sorted station-code pair (`GZB-SBB`).
Per-direction traversal counts are kept separately as real observations.

#### Field-by-field origin

| Field | Origin |
|---|---|
| `_id`, `section` | Derived: sorted station-code pair |
| `name` | Real: both station names, joined |
| `zone` | Real, resolved: both agree → that zone; one blank → the known one; genuinely different → `null` |
| `stationA` / `stationB` | Real: copied from `stations.json` |
| `zones`, `states` | Real: distinct non-blank values across the two endpoints |
| `trainTraversals`, `distinctTrains`, `directionalTraversals` | Real: counted observations from `schedules.json` |
| `publishedDistanceKm` | **Real**: published km between the pair, from the ISL timetable's cumulative `Distance` column. `null` unless every observation agreed — a conflicting value is dropped, never averaged into a figure no source published. Available for 1,890 sections. |
| `straightLineKm` | Derived: great-circle distance from coordinates. A **lower bound** on track length, never a substitute for it. |
| `derivedFlags.longHop` | Derived quality signal — see below |
| `sources` | Which downloaded file(s) the section was observed in |
| `maxDailyBlockWindows` | **Empty — populated by T3** from real timetable occupancy gaps |
| `seasonalRiskFlag` | **`null` — populated by T26** from IMD / flood-prone section data |

#### Extension beyond the PRD schema

PRD Section 15's `corridors` shape has `{_id, name, zone, section,
maxDailyBlockWindows, seasonalRiskFlag}`. All six are emitted. The real data
carries more than that shape models, and rather than discard it, the extra
fields above are added — so downstream tasks don't have to re-parse 82 MB of
raw JSON to recover them. The two PRD fields this task cannot honestly fill are
emitted empty rather than guessed.

---

## Validation — how we know the parse is real

Numbers below are from an actual run; `processed/INGESTION_REPORT.json` is
regenerated on every build.

- **100% station-code join.** All 8,539 distinct station codes in
  `schedules.json` resolve against `stations.json`. Zero unmatched, zero pairs
  dropped for an unknown endpoint.
- **Section lengths look like real station gaps.** Median straight-line distance
  between the derived pairs is **6.6 km**, with 99.2% under 25 km. A scrambled
  stop order would scatter pairs across the network instead.
- **Published distance agrees with geometry.** For the 1,881 sections with both
  a published distance and coordinates, the median ratio of published to
  straight-line distance is **1.034** (p10 0.90, p90 1.34). Track curves and a
  great-circle line does not, so slightly above 1.0 is the physically correct
  answer — and not a distribution a mis-parse would produce.
- **Known adjacencies survive.** Kalyan – Thakurli – Dombivli – Kopar on the
  Mumbai Central line all appear as sections; asserted in the test suite.
- **Byte-identical rebuilds.** Deleting `processed/` and rebuilding reproduces
  the same SHA-256.

### Cross-source corroboration, and why the overlap is partial

3,295 of 10,149 sections are independently observed in the data.gov.in ISL
timetable. That is not a defect, and the reason is worth stating plainly:

**The ISL timetable lists each train's HALTS, not every station it passes.** Its
consecutive pairs have a median straight-line gap of **16.9 km** and a maximum
of **2,513 km** — an express hopping most of the country between stops — against
6.6 km for datameet's stop sequences. The two files describe different things.

So the ISL file is used **only** to corroborate sections and supply published
distances. It is never allowed to define a section. Corridor sections come from
datameet, exactly as PRD 5.1 specifies.

### Known limitation — the `longHop` flag

Because sections are consecutive *stops*, a fast train that skips intermediate
halts produces a pair that is consecutive-for-that-train but not physically
adjacent. `derivedFlags.longHop` marks sections whose straight-line distance
exceeds 25 km — the threshold taken from the measured distribution of the
sections themselves, 99.2% of which fall below it.

**81 of 10,149 sections (0.8%) are flagged.** They are kept, not deleted — the
observation is real — but downstream tasks selecting corridors for scheduling
should prefer `longHop == false` and a high `distinctTrains` count. The tell is
clear in the data: the longest flagged section, `PSA-VZM` (Palasa – Vizianagram,
129.9 km), is observed by exactly **one** train.

---

---

# T3 — the occupancy calendar

## What "occupied" means (a modelling choice, not a published fact)

**A train occupies a corridor section from its departure at one endpoint to its
arrival at the next.** That transit window is what the calendar records.

This has to be stated plainly because it is a *model*, not something read out of
the data:

- Real signalling occupies a **block**, which is not the same unit as a
  station-to-station section. The published data has no block granularity, so
  transit time is the closest defensible approximation available.
- The alternative — treating a stop as an instantaneous point — would report
  nearly every section as free nearly all day. Wrong, and useless to the solver.

Three further choices, all declared in the output file's own `model` block and
configurable at the top of `ingestion/timetable.py`:

| Choice | Value | Status |
|---|---|---|
| Horizon | one representative 24-hour day | forced by the data — see below |
| Clearance margin around each occupancy | 5 min each side | planning policy |
| Shortest reportable free window | 30 min | planning policy |
| Maximum plausible transit | 180 min | data-derived (p99 = 32 min) |

### Why a single 24-hour day, not a week

**Neither `schedules.json` nor `trains.json` has a day-of-week or running-days
field.** A weekly calendar cannot be derived from this data, so every train is
projected onto one representative day.

This deliberately **over**-estimates occupancy — a weekly special is counted as
if it ran daily — which means free windows are conservative. For maintenance
planning that is the safe direction: the system should never promise a window
that is not really there. PRD NG2 already scopes occupancy to daily/weekly
granularity, so this is within the stated non-goals.

## The `day` field — a trap that dissolved

T2 flagged 22,561 stop records with a null `day`, and it looked like it would
need a judgement call. It did not, and the reason is worth recording.

Those 22,561 records are **exactly** the records that have no `arrival` and no
`departure` either. The co-occurrence is exact:

| arrival null | departure null | day null | records |
|---|---|---|---|
| no | no | no | 384,107 (92.1%) — complete |
| **yes** | **yes** | **yes** | **22,561 (5.4%)** — no time information at all |
| yes | no | no | 5,146 — run origins (a train does not arrive at its start) |
| no | yes | no | 5,138 — run termini |
| yes | yes | no | 128 — small residue |

So there was never an independent day-handling policy to decide. Those records
are **route-sequence-only**: they legitimately define stop order for T2's
adjacency derivation, and they cannot define occupancy. They are skipped here
and counted, never silently dropped. The origin/terminus nulls are semantically
correct, not defects.

### And `day` is not the best signal anyway

Transit duration is computed as `arrival - departure`, adding 24 hours when the
result is negative (a midnight crossing). Measured across all 376,704 usable
stop pairs, that agrees with day-delta arithmetic on 99.86% of them — and on the
disagreements, **day-delta yields 308 negative durations and 196 longer than 24
hours**, both impossible between adjacent stations, while clock-wrap yields
neither. `day` is therefore consulted only as a fallback when the wrapped value
is already implausible. (`docs/DECISIONS.md` D-011.)

## Nothing is dropped silently

The pipeline asserts that every one of the 411,680 stop pairs is accounted for,
and `TIMETABLE_REPORT.json` carries the breakdown:

| Outcome | Pairs |
|---|---:|
| Used to build occupancy | 376,385 |
| Skipped — no time information | 34,976 |
| Skipped — implausible transit (>180 min) | 318 |
| Skipped — self-loop | 1 |
| **Total seen** | **411,680** |
| Windows emitted (midnight crossings split in two) | 378,297 |
| — of which midnight splits | 1,912 |

A transit crossing midnight is split into two windows on the representative day
(23:50 + 20 min becomes `23:50–24:00` and `00:00–00:10`), never left as an
interval running backwards.

## Honouring T2's findings

T3 reuses `datameet.split_train_runs`, so the duplicate-stop-list and
missing-stop rules from T2 apply unchanged — **a phantom adjacency must not
become a phantom occupancy.** There is a dedicated test for train 04857.

Sections are marked `lowConfidence` with a stated reason, rather than deleted:

| Reason | Sections |
|---|---:|
| `longHop` — derived from a skip-halt pair, so not a single maintainable unit | 81 |
| `no timed traffic` — every stop record for the pair lacks times | 1,695 |
| **Total flagged** | **1,775** |

## What came out

Computed from an actual run; regenerated into `TIMETABLE_REPORT.json` each time.

- **8,454 of 10,149 sections** have timed traffic.
- **Median utilisation 13.8%**, median 199 occupied minutes and 942 free minutes
  per section per day.
- **66 sections have no usable block window at all** — fully saturated.

The saturated sections are the ones that genuinely are saturated on Indian
Railways, which is the strongest available check that the model is sane:

| Section | Utilisation | Trains | Usable windows | |
|---|---:|---:|---:|---|
| `BKA-BNI` Barkhera – Budni | 87.2% | 163 | **0** | Itarsi ghat |
| `BDI-BSL` Bhadli – Bhusaval Jn | 82.7% | 214 | **0** | Mumbai–Howrah trunk |
| `GZB-SBB` Ghaziabad – Sahibabad | 82.2% | 281 | 1 (54 min, 01:08–02:02) | Delhi approach |
| `KAD-PDI` Khandala – Palasdari | 77.4% | 81 | 2 | Bhor Ghat incline |

That scarcity *is* the problem statement — a corridor carrying 281 trains a day
with one 54-minute maintenance window is exactly the conflict this system exists
to schedule around.

## `trains.json` — real class codes, no invented priority

5,208 trains, 100% field coverage, joining exactly to the 5,208 train numbers in
`schedules.json`. The `type` field is the real Indian Railways class code:

| Code | Count | Code | Count | Code | Count |
|---|---:|---|---:|---|---:|
| `Pass` | 2,459 | `Hyd` | 121 | `Shtb` | 31 |
| `Exp` | 1,288 | `GR` | 52 | `Mail` | 19 |
| `SF` | 719 | `Raj` | 48 | `Toy` | 14 |
| `MEMU` | 297 | `Drnt` | 48 | `Del` | 8 |
| | | `SKr` | 42 | `DEMU` | 4 |
| | | `JShtb` | 40 | `Klkt` | 3 |

15 trains have no `type` value.

**No priority score is assigned in T3, deliberately.** Mapping a class code to
an objective-function weight is a policy decision that belongs to the optimizer
(task T22), and doing it once in the place that owns it is better than
scattering an interpretation through the data layer. The codes are emitted
verbatim, alongside the published accommodation flags (`first_ac`, `second_ac`,
`third_ac`, `sleeper`, `chair_car`, `first_class`) which give T22 a second,
independent signal for what counts as a premium service.

Codes are left unexpanded in the data for the same reason. For reference,
`Raj`/`Shtb`/`JShtb`/`Drnt`/`SF`/`Exp`/`Pass`/`Mail` are Rajdhani, Shatabdi, Jan
Shatabdi, Duronto, Superfast, Express, Passenger and Mail; `MEMU`/`DEMU` are
electric and diesel multiple units. `GR`, `SKr`, `Hyd`, `Del` and `Klkt` are
less certain and are **not** guessed at anywhere in the code.

---

## Status

- **T2 — done.** Stations and corridor sections from real route data.
- **T3 — done.** Occupancy calendar, free block windows, and train class metadata.
- **T4 — next.** `generators/` produces synthetic assets, tasks, resources and
  dependencies against these real corridors, using the skewed distributions in
  PRD 5.2 (severity is Beta-distributed, not uniform — realistic skew is part of
  what makes the dataset credible).

  T4 now has both real anchors it needs: **which** sections exist, and **when**
  each is actually free. Prefer sections with `lowConfidence == false` and a
  healthy `distinctTrains` count; the saturated four above make the most
  compelling demo corridors, since they are where maintenance genuinely competes
  with traffic.
