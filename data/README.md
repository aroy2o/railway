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

## Running the ingestion (task T2)

```bash
cd data
.venv/bin/python -m ingestion.download          # ~98 MB, skips files already present
.venv/bin/python -m ingestion.build_corridors   # ~2 s
.venv/bin/python -m pytest                      # 28 tests
```

`download` writes `raw/MANIFEST.json` with each file's URL, byte size, SHA-256
and fetch time. `build_corridors` reads only from `raw/` and is **deterministic**
— identical inputs produce byte-identical outputs, which is why no wall-clock
timestamp is written into them. Re-running is always safe.

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

## Status

- **T2 — done.** `ingestion/` extracts stations and derives corridor sections.
- **T3 — next.** Build the per-corridor occupied-window calendar from the real
  arrival/departure times in `schedules.json` and the ISL CSV, and populate
  `maxDailyBlockWindows`. `trains.json` supplies train type for priority
  weighting (PRD 9.6).
- **T4 — after that.** `generators/` produces synthetic assets, tasks, resources
  and dependencies against these real corridors, using the skewed distributions
  in PRD 5.2 (severity is Beta-distributed, not uniform — realistic skew is part
  of what makes the dataset credible).
