# `/data` — dataset ingestion and synthetic generation

Two clearly separated concerns, matching PRD Section 5:

| Folder | Contents | Data origin |
|---|---|---|
| `ingestion/` | Scripts that fetch and parse **real, public** railway data | `datameet/railways`, `data.gov.in` |
| `generators/` | Scripts that produce **synthetic** maintenance data anchored to that real data | generated locally |
| `raw/` | Downloaded source files, untouched (git-ignored) | — |
| `processed/` | Normalised JSON ready for MongoDB seeding (git-ignored) | — |

`raw/` and `processed/` are git-ignored because everything in them is
reproducible by re-running the scripts.

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

## Status

Both folders are scaffolding only right now. Scripts land with their tasks:

- **T2** — `ingestion/` corridor extraction from `datameet/railways` (consecutive
  station pairs on real routes)
- **T3** — `ingestion/` timetable parsing into a per-corridor occupied-window
  calendar
- **T4** — `generators/` synthetic assets, tasks, resources and dependencies,
  using the skewed distributions specified in PRD 5.2 (severity is Beta-
  distributed, not uniform — realistic skew is part of what makes the dataset
  credible)
