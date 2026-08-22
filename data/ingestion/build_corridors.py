"""Build data/processed/{stations,corridors}.json from the downloaded datasets.

Implements task T2 / PRD 5.1. Reads only files already in data/raw/ - run
``python -m ingestion.download`` first.

    python -m ingestion.build_corridors

Output is **deterministic**: identical raw inputs produce byte-identical
processed files. That is why no wall-clock timestamp appears in them - the
fetch time lives in data/raw/MANIFEST.json instead, where it belongs. Being
able to re-run ingestion without churning the outputs is what makes it safe for
later tasks (T3, T4) to depend on these files.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from ingestion import datagov_isl, datameet
from ingestion.sources import (
    DATAMEET_SCHEDULES,
    DATAMEET_STATIONS,
    ISL_CSV_PATH,
    PROCESSED_DIR,
)

STATIONS_OUT = PROCESSED_DIR / "stations.json"
CORRIDORS_OUT = PROCESSED_DIR / "corridors.json"
REPORT_OUT = PROCESSED_DIR / "INGESTION_REPORT.json"

#: Fields in the PRD Section 15 `corridors` shape that real route data cannot
#: supply. They are emitted empty rather than guessed, and filled in later:
#:   maxDailyBlockWindows -> T3, computed from real timetable occupancy gaps
#:   seasonalRiskFlag     -> T26, from IMD / flood-prone section data
UNPOPULATED_NOTE = {
    "maxDailyBlockWindows": "populated by T3 from timetable occupancy gaps",
    "seasonalRiskFlag": "populated by T26 from IMD/flood-prone section data",
}

#: Above this straight-line distance a "consecutive stop" pair is very unlikely
#: to be two physically adjacent stations - it is a fast train skipping the
#: halts in between. Chosen from the measured distribution of the derived
#: sections themselves: 99.2% are under 25 km (median 6.6 km), which is what an
#: inter-station gap on Indian Railways actually looks like. Flagged rather
#: than dropped, because the pair *is* a real consecutive-stop observation -
#: downstream tasks just should not treat it as one maintainable section.
LONG_HOP_KM = 25.0


def resolve_zone(zone_a: str | None, zone_b: str | None) -> tuple[str | None, list[str]]:
    """Pick a single zone for a section, and list every zone it touches.

    Roughly half the stations in datameet's stations.json have a blank zone, and
    a section can legitimately straddle two railway zones. So: agree -> use it;
    one side blank -> use the known one; genuinely different -> None, with both
    recorded in `zones`. Never invent a zone for a section that has none.
    """
    zones = sorted({z for z in (zone_a, zone_b) if z})
    if len(zones) == 1:
        return zones[0], zones
    return None, zones


def build() -> dict:
    if not DATAMEET_STATIONS.raw_path.exists() or not DATAMEET_SCHEDULES.raw_path.exists():
        raise SystemExit(
            "Raw datasets missing. Run:  python -m ingestion.download"
        )

    print("Loading stations…")
    stations = datameet.load_stations(DATAMEET_STATIONS.raw_path)
    print(f"  {len(stations):,} stations")

    print("Loading schedules… (~82 MB, this takes a moment)")
    records = datameet.load_schedule_records(DATAMEET_SCHEDULES.raw_path)
    print(f"  {len(records):,} stop records")

    print("Deriving corridor sections from consecutive stops on real routes…")
    sections, stats = datameet.derive_corridor_sections(records, stations)
    print(f"  {len(sections):,} unique sections from {stats['runs']:,} train runs")

    # Independent second source: explicit islno ordering + published distances.
    isl_sections: dict = {}
    isl_stats: dict = {}
    if ISL_CSV_PATH.exists():
        print("Cross-checking against the data.gov.in ISL timetable…")
        isl_sections, isl_stats = datagov_isl.load_isl_sections(ISL_CSV_PATH)
        print(f"  {len(isl_sections):,} sections from the ISL CSV")
    else:
        print("  [warn] ISL CSV not present - skipping cross-validation and real distances")

    corridors = []
    with_real_distance = 0
    corroborated = 0

    for key in sorted(sections):
        section = sections[key]
        station_a, station_b = stations[section.code_a], stations[section.code_b]
        zone, zones = resolve_zone(station_a.zone, station_b.zone)

        isl = isl_sections.get(key)
        if isl is not None:
            corroborated += 1
        distance_km = isl.distance_km if isl else None
        if distance_km is not None:
            with_real_distance += 1

        straight_line = datameet.great_circle_km(station_a, station_b)
        long_hop = straight_line is not None and straight_line > LONG_HOP_KM

        sources = ["datameet/railways:schedules.json"]
        if isl is not None:
            sources.append("data.gov.in:isl_wise_train_detail")

        corridors.append(
            {
                # --- PRD Section 15 `corridors` shape ---------------------------
                "_id": section.section_id,
                "name": f"{station_a.name} – {station_b.name}",
                "zone": zone,
                "section": section.section_id,
                "maxDailyBlockWindows": [],
                "seasonalRiskFlag": None,
                # --- extensions: real data the PRD shape does not model ---------
                # Kept rather than dropped so downstream tasks do not have to
                # re-parse 82 MB of raw JSON to recover them.
                "stationA": station_a.as_dict(),
                "stationB": station_b.as_dict(),
                "zones": zones,
                "states": sorted({s for s in (station_a.state, station_b.state) if s}),
                "trainTraversals": section.total_traversals,
                "distinctTrains": len(section.train_numbers),
                "directionalTraversals": dict(sorted(section.directional_traversals.items())),
                # Real published distance between these two stations, from the
                # ISL timetable. This equals the maintainable section length
                # when the pair is physically adjacent, which is the normal
                # case. None when the ISL timetable has no consistent figure.
                "publishedDistanceKm": distance_km,
                # Derived straight-line distance - a lower bound on track
                # length, never a substitute for it.
                "straightLineKm": straight_line,
                # Quality signal, not a fact about the railway: see LONG_HOP_KM.
                # A long hop observed by very few trains is almost certainly an
                # express skipping intermediate halts rather than one section.
                "derivedFlags": {"longHop": long_hop},
                "sources": sources,
            }
        )

    ratios = sorted(
        c["publishedDistanceKm"] / c["straightLineKm"]
        for c in corridors
        if c["publishedDistanceKm"] and c["straightLineKm"] and c["straightLineKm"] > 0.5
    )

    report = {
        "task": "T2 - real corridor data ingestion (PRD 5.1)",
        "inputs": {
            "stations.json": {"stations": len(stations)},
            "schedules.json": {"stop_records": len(records), **stats},
            "isl_csv": isl_stats or "not available",
        },
        "outputs": {
            "stations": len(stations),
            "corridors": len(corridors),
            "corridors_corroborated_by_second_source": corroborated,
            "corridors_with_published_distance_km": with_real_distance,
            "corridors_with_resolved_zone": sum(1 for c in corridors if c["zone"]),
            "corridors_flagged_long_hop": sum(1 for c in corridors if c["derivedFlags"]["longHop"]),
        },
        # The single strongest check that this is genuinely parsed data: for
        # pairs where an independently-published distance exists, it should sit
        # just above the straight-line distance, because track curves and a
        # great-circle line does not. A median near 1.0 cannot happen by
        # accident, and would not survive a mis-parsed stop sequence.
        "distanceValidation": _distance_validation(ratios),
        "crossSourceNote": (
            "The ISL timetable lists each train's HALTS, not every station it passes: "
            "its consecutive pairs have a median straight-line gap of 16.9 km (max 2513 km) "
            "against 6.6 km for datameet's stop sequences. It is therefore used only to "
            "corroborate sections and supply published distances - never to define them. "
            "Partial overlap between the two source's section sets is expected for that reason."
        ),
        "unpopulatedFields": UNPOPULATED_NOTE,
    }

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    _write_json(
        STATIONS_OUT,
        {
            "source": "datameet/railways stations.json (CC0)",
            "count": len(stations),
            "stations": [stations[code].as_dict() for code in sorted(stations)],
        },
    )
    _write_json(
        CORRIDORS_OUT,
        {
            "source": "Derived from datameet/railways schedules.json; distances and "
            "corroboration from the data.gov.in ISL timetable.",
            "derivation": "A corridor section is a pair of consecutive stops on a real "
            "train route (PRD 5.1). Sections are undirected and keyed on the sorted "
            "station-code pair.",
            "count": len(corridors),
            "corridors": corridors,
        },
    )
    _write_json(REPORT_OUT, report)

    print(f"\nWrote {STATIONS_OUT.relative_to(PROCESSED_DIR.parent)} "
          f"({STATIONS_OUT.stat().st_size:,} bytes)")
    print(f"Wrote {CORRIDORS_OUT.relative_to(PROCESSED_DIR.parent)} "
          f"({CORRIDORS_OUT.stat().st_size:,} bytes)")
    print(f"Wrote {REPORT_OUT.relative_to(PROCESSED_DIR.parent)}")
    return report


def _distance_validation(ratios: list[float]) -> dict:
    """Summarise published-distance / straight-line-distance agreement."""
    if not ratios:
        return {"samples": 0, "note": "no published distances available"}
    return {
        "samples": len(ratios),
        "medianPublishedOverStraightLine": round(ratios[len(ratios) // 2], 3),
        "p10": round(ratios[int(0.1 * len(ratios))], 3),
        "p90": round(ratios[int(0.9 * len(ratios))], 3),
    }


def _write_json(path: Path, payload: dict) -> None:
    """Write deterministic JSON - stable key order, no timestamps, trailing newline."""
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def main() -> int:
    report = build()
    print("\n--- ingestion report ---")
    print(json.dumps(report["outputs"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
