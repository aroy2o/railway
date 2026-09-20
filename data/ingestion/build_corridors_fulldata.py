"""Build data/processed/{stations,corridors}.json from full_data's real
KTV-PSA block-section registry, for the fulldata-ktv-psa branch.

This is the fulldata-branch analogue of `ingestion.build_corridors` (T2), but
reads `full_data/data/real/block_sections.csv` + `stations.csv` instead of
datameet/railways + data.gov.in. See `fulldata_sources.py` for the provenance
note on why this is a real-but-different data source from what PRD Section
5.1 names.

    python -m ingestion.build_corridors_fulldata

`block_sections.csv` is the authoritative real registry: 63 operational block
sections (one row's key is null and dropped - see full_data's own DEC-10),
each with a real physical line count (`MANNUMBLINES`). This is used instead of
`route_ktv_psa.csv` (which only names the 21 consecutive hops along one
specific route through the corridor, not the full 63-section registry
including branch/siding sections that full_data's own synthetic/cp_sat
layer references) - using the route file alone left 42 sections referenced by
real assets/tasks with no corridor to attach to, caught by running this
script against the downstream generator before writing it up as done.
`route_ktv_psa.csv`'s `DISTANCE` is still joined in where available, as a
best-effort real-distance enrichment.

ASSUMPTION (flagged, not hidden): a block section's `MANNUMBLINES` physical
lines are numbered 1..N here. That numbering does not exist in the source
data as an explicit per-line id - it is invented so each physical line gets
its own `Corridor` document, which is what lets the existing per-corridor
no-double-booking scheduler logic apply per line without any change to
scheduler.py. `line_number` values already present in full_data's own
synthetic/cp_sat CSVs (asset_days.csv, cp_sat_tasks_v2.csv) are assumed to
fall inside this same 1..N range; corridors are generated for
`max(MANNUMBLINES, highest line_number actually observed in that data)` per
section as a safety margin, so no asset/task ever references a corridor that
was not created.
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

from ingestion.fulldata_sources import (
    ASSET_DAYS_CSV,
    BLOCK_SECTIONS_CSV,
    CP_SAT_TASKS_CSV,
    PROCESSED_DIR,
    ROUTE_KTV_PSA_CSV,
    ROUTE_PSA_KTV_CSV,
    SOURCE_CITATION,
    STATIONS_CSV,
)

STATIONS_OUT = PROCESSED_DIR / "stations.json"
CORRIDORS_OUT = PROCESSED_DIR / "corridors.json"
REPORT_OUT = PROCESSED_DIR / "FULLDATA_CORRIDOR_REPORT.json"

#: Populated by build_calendar_fulldata.py / build_seasonal_risk_fulldata.py.
UNPOPULATED_NOTE = {
    "maxDailyBlockWindows": "populated by build_calendar_fulldata (NIGHT/LEAN fixed windows)",
    "seasonalRiskFlag": "not populated for this branch - full_data has no monsoon/flood "
    "dataset for the KTV-PSA corridor; left null rather than guessed (PRD 9.9 is a stretch item)",
}


def corridor_id(block_section: str, line_number: int) -> str:
    return f"{block_section}#L{line_number}"


def load_stations() -> dict[str, dict]:
    stations: dict[str, dict] = {}
    with STATIONS_CSV.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            code = (row.get("MAVSTTNCODE") or "").strip().upper()
            if not code:
                continue
            lat = _to_float(row.get("MANLATITUDE"))
            lon = _to_float(row.get("MANLONGITUDE"))
            stations[code] = {
                "code": code,
                "name": (row.get("MAVSTTNNAME") or code).strip(),
                "zone": (row.get("MANZONEIC") or None) or None,
                "state": (row.get("MAVSTATECODE") or None) or None,
                "address": None,
                "lat": lat,
                "lon": lon,
            }
    return stations


def _to_float(value: object) -> float | None:
    try:
        if value in (None, "", "None"):
            return None
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _max_line_numbers_observed() -> dict[str, int]:
    """Highest `line_number` used per block_section in full_data's own synthetic
    and cp_sat outputs - used only to widen corridor generation as a safety
    margin over the raw `NOOFTRACKS` count (see module docstring ASSUMPTION).
    """
    observed: dict[str, int] = {}
    for path in (ASSET_DAYS_CSV, CP_SAT_TASKS_CSV):
        if not path.exists():
            continue
        with path.open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                section = row.get("block_section")
                line = row.get("line_number")
                if not section or line in (None, ""):
                    continue
                try:
                    line_int = int(float(line))
                except ValueError:
                    continue
                if line_int > observed.get(section, 0):
                    observed[section] = line_int
    return observed


def _load_distance_enrichment() -> dict[str, float]:
    """block_section -> real published DISTANCE km, best-effort from the route
    files (only covers the 21 main-line hops, not all 63 sections)."""
    distances: dict[str, float] = {}
    for path in (ROUTE_KTV_PSA_CSV, ROUTE_PSA_KTV_CSV):
        if not path.exists():
            continue
        with path.open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                section = (row.get("BLOCK_SECTION") or "").strip()
                distance_km = _to_float(row.get("DISTANCE"))
                if section and distance_km is not None and section not in distances:
                    distances[section] = distance_km
    return distances


def build() -> dict:
    if not BLOCK_SECTIONS_CSV.exists() or not STATIONS_CSV.exists():
        raise SystemExit(
            f"full_data real-data files missing under {BLOCK_SECTIONS_CSV.parent} - "
            "this branch expects the full_data/ release package to already be present "
            "in the repo (it is, as of the fulldata-ktv-psa branch)."
        )

    print("Loading stations…")
    stations = load_stations()
    print(f"  {len(stations):,} stations")

    print("Widening line counts against full_data's own synthetic/cp_sat line_number columns…")
    line_overrides = _max_line_numbers_observed()

    print("Loading real-distance enrichment from route_ktv_psa/psa_ktv.csv…")
    distance_by_section = _load_distance_enrichment()

    print("Reading block_sections.csv…")
    with BLOCK_SECTIONS_CSV.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    corridors: list[dict] = []
    stations_used: set[str] = set()
    sections_seen: set[str] = set()
    dropped_null_key = 0
    dropped_missing_stations: list[str] = []

    for row in rows:
        section = (row.get("MAVBLCKSCTN") or "").strip()
        if not section:
            dropped_null_key += 1
            continue
        if section in sections_seen:
            continue

        code_a = (row.get("MAVFROMSTTNCODE") or "").strip().upper()
        code_b = (row.get("MAVTOSTTNCODE") or "").strip().upper()
        if not code_a or not code_b:
            # A handful of block_sections.csv rows carry no from/to station
            # code at all (e.g. "PSA-KTV") - not a real point-to-point
            # section, matches full_data's own DEC-10 note that a few of the
            # 63 rows are peripheral/branch/dummy entries. Dropped rather than
            # emitted with an empty station, which would fail Corridor's
            # required stationA/B.code validation anyway.
            dropped_missing_stations.append(section)
            continue
        sections_seen.add(section)

        station_a = stations.get(code_a) or _fallback_station(code_a, None)
        station_b = stations.get(code_b) or _fallback_station(code_b, None)
        stations_used.update((code_a, code_b))

        distance_km = distance_by_section.get(section)
        num_lines_raw = _to_float(row.get("MANNUMBLINES"))
        num_lines = max(int(num_lines_raw) if num_lines_raw else 1, line_overrides.get(section, 1), 1)

        for line_number in range(1, num_lines + 1):
            corridors.append(
                {
                    # --- PRD Section 15 `corridors` shape ------------------------
                    "_id": corridor_id(section, line_number),
                    "name": f"{station_a['name']} – {station_b['name']} (line {line_number})",
                    "zone": station_a["zone"] or station_b["zone"],
                    "section": section,
                    "maxDailyBlockWindows": [],
                    "seasonalRiskFlag": None,
                    # --- fulldata-branch extensions ------------------------------
                    "blockSection": section,
                    "lineNumber": line_number,
                    "stationA": station_a,
                    "stationB": station_b,
                    "zones": sorted({z for z in (station_a["zone"], station_b["zone"]) if z}),
                    "states": sorted({s for s in (station_a["state"], station_b["state"]) if s}),
                    "trainTraversals": 0,  # populated by build_calendar_fulldata via seed-time join
                    "distinctTrains": 0,
                    "directionalTraversals": {},
                    "publishedDistanceKm": distance_km,
                    "straightLineKm": distance_km,
                    "derivedFlags": {"longHop": False},
                    "sources": [SOURCE_CITATION],
                }
            )

    report = {
        "task": "fulldata-ktv-psa branch: real corridor data ingestion (KTV-PSA)",
        "inputs": {
            "block_sections.csv": {
                "rows": len(rows),
                "droppedNullKey": dropped_null_key,
                "droppedMissingStations": dropped_missing_stations,
            },
            "stations.csv": {"stations": len(stations)},
            "distanceEnrichmentCoverage": len(distance_by_section),
        },
        "outputs": {
            "blockSections": len(sections_seen),
            "corridorLineDocuments": len(corridors),
            "stationsReferenced": len(stations_used),
        },
        "unpopulatedFields": UNPOPULATED_NOTE,
        "sourceCitation": SOURCE_CITATION,
    }

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    _write_json(
        STATIONS_OUT,
        {
            "source": SOURCE_CITATION,
            "count": len(stations),
            "stations": [stations[code] for code in sorted(stations)],
        },
    )
    _write_json(
        CORRIDORS_OUT,
        {
            "source": SOURCE_CITATION,
            "derivation": "One Corridor document per (block_section, line_number) pair from "
            "full_data's real route_ktv_psa.csv, line_number in 1..NOOFTRACKS (see module "
            "docstring ASSUMPTION on the invented numbering).",
            "count": len(corridors),
            "corridors": corridors,
        },
    )
    _write_json(REPORT_OUT, report)

    print(f"Wrote {STATIONS_OUT} ({STATIONS_OUT.stat().st_size:,} bytes)")
    print(f"Wrote {CORRIDORS_OUT} ({CORRIDORS_OUT.stat().st_size:,} bytes)")
    return report


def _fallback_station(code: str, name: str | None) -> dict:
    return {
        "code": code,
        "name": name or code,
        "zone": None,
        "state": None,
        "address": None,
        "lat": None,
        "lon": None,
    }


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def main() -> int:
    report = build()
    print("\n--- fulldata corridor ingestion report ---")
    print(json.dumps(report["outputs"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
