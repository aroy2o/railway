"""Build the corridor occupancy calendar and train metadata (task T3).

Reads only files already in data/raw/ - no new downloads. Run after
``ingestion.build_corridors``:

    python -m ingestion.download
    python -m ingestion.build_corridors     # T2: corridors.json
    python -m ingestion.build_timetable     # T3: calendar + trains

Outputs (all deterministic - identical inputs give byte-identical files, see
docs/DECISIONS.md D-008):

    processed/trains.json            per-train class/type metadata
    processed/corridor_calendar.json occupancy + free windows per section
    processed/TIMETABLE_REPORT.json  coverage and validation stats

**This step does not modify corridors.json.** The calendar is a separate file
keyed on the same ``_id``; ``maxDailyBlockWindows`` lives there and is joined in
at seed time. Rewriting T2's output in place would make the two stages
order-dependent and destroy the rebuild determinism T2 guarantees - see
docs/DECISIONS.md D-009.
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import Counter, defaultdict

from ingestion import datameet, timetable, trains_meta
from ingestion.sources import (
    DATAMEET_SCHEDULES,
    DATAMEET_TRAINS,
    PROCESSED_DIR,
)
from ingestion.build_corridors import CORRIDORS_OUT, _write_json

TRAINS_OUT = PROCESSED_DIR / "trains.json"
CALENDAR_OUT = PROCESSED_DIR / "corridor_calendar.json"
REPORT_OUT = PROCESSED_DIR / "TIMETABLE_REPORT.json"


def load_corridor_index() -> tuple[dict[tuple[str, str], dict], set[tuple[str, str]]]:
    """Read T2's corridors.json into a lookup keyed the same way T2 keyed it."""
    if not CORRIDORS_OUT.exists():
        raise SystemExit(
            "processed/corridors.json missing. Run:  python -m ingestion.build_corridors"
        )

    payload = json.loads(CORRIDORS_OUT.read_text())
    index = {}
    for corridor in payload["corridors"]:
        key = (corridor["stationA"]["code"], corridor["stationB"]["code"])
        index[key] = corridor
    return index, set(index)


def build() -> dict:
    print("Loading corridors from T2…")
    corridor_index, known_sections = load_corridor_index()
    print(f"  {len(corridor_index):,} sections")

    print("Parsing trains.json…")
    trains = trains_meta.load_trains(DATAMEET_TRAINS.raw_path)
    print(f"  {len(trains):,} trains")

    print("Loading schedules… (~82 MB)")
    records = datameet.load_schedule_records(DATAMEET_SCHEDULES.raw_path)
    print(f"  {len(records):,} stop records")

    print("Deriving section occupancy from real arrival/departure times…")
    raw_windows: dict[tuple[str, str], list[timetable.Window]] = defaultdict(list)
    section_trains: dict[tuple[str, str], set[str]] = defaultdict(set)
    methods: Counter[str] = Counter()
    transit_stats: dict[str, int] = {}

    for key, train_number, window, method in timetable.iter_section_transits(
        records, known_sections, stats=transit_stats
    ):
        raw_windows[key].append(window)
        section_trains[key].add(train_number)
        methods[method] += 1

    print(f"  {sum(len(v) for v in raw_windows.values()):,} transit windows "
          f"across {len(raw_windows):,} sections")

    calendar = []
    occupied_minutes_all: list[int] = []
    free_minutes_all: list[int] = []
    low_confidence = 0
    no_traffic = 0

    for key in sorted(known_sections):
        corridor = corridor_index[key]
        section_id = corridor["_id"]
        windows = raw_windows.get(key, [])

        occupied = timetable.merge_windows(windows)
        free = timetable.free_windows(occupied)

        occupied_minutes = sum(w.duration for w in occupied)
        free_minutes = sum(w.duration for w in free)

        # A section T2 flagged as a skip-halt hop is not one maintainable unit,
        # so its "transit" spans stations in between. The calendar is still
        # emitted - the observation is real - but marked so no downstream task
        # treats it as a normal section. (T2 finding; data/README.md.)
        reasons = []
        if corridor["derivedFlags"]["longHop"]:
            reasons.append("longHop: derived from a skip-halt pair, not a single section")
        if not windows:
            reasons.append("no timed traffic: every stop record for this pair lacks times")
            no_traffic += 1
        if reasons:
            low_confidence += 1

        if windows:
            occupied_minutes_all.append(occupied_minutes)
            free_minutes_all.append(free_minutes)

        calendar.append(
            {
                "_id": section_id,
                "corridorId": section_id,
                # PRD Section 15 `corridors.maxDailyBlockWindows`, joined in at
                # seed time. These are the FREE windows - what the solver needs.
                "maxDailyBlockWindows": [w.as_dict() for w in free],
                "occupiedWindows": [w.as_dict() for w in occupied],
                "trainsObserved": len(section_trains.get(key, ())),
                "transitWindows": len(windows),
                "occupiedMinutes": occupied_minutes,
                "freeMinutes": free_minutes,
                "utilisationPct": round(100 * occupied_minutes / timetable.MINUTES_PER_DAY, 2),
                "lowConfidence": bool(reasons),
                "lowConfidenceReasons": reasons,
            }
        )

    # Invariant: every stop pair is accounted for. If this ever fails, a code
    # path is dropping data without saying so.
    accounted = (
        transit_stats["pairs_used"]
        + transit_stats["skipped_self_loop"]
        + transit_stats["skipped_unknown_section"]
        + transit_stats["skipped_missing_time"]
        + transit_stats["skipped_implausible_transit"]
    )
    assert accounted == transit_stats["pairs_seen"], (
        f"unaccounted stop pairs: {transit_stats['pairs_seen'] - accounted}"
    )

    report = _build_report(
        records, trains, calendar, methods, occupied_minutes_all, free_minutes_all,
        low_confidence, no_traffic, len(known_sections), transit_stats,
    )

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    _write_json(
        TRAINS_OUT,
        {
            "source": "datameet/railways trains.json (CC0)",
            "note": "Raw published fields only. No priority score is assigned here - "
            "mapping a class code to an objective-function weight is task T22.",
            "count": len(trains),
            "trains": [trains[number].as_dict() for number in sorted(trains)],
        },
    )
    _write_json(
        CALENDAR_OUT,
        {
            "source": "Derived from datameet/railways schedules.json arrival/departure times.",
            "model": {
                "occupancy": "A train occupies a section from its departure at one "
                "endpoint to its arrival at the next. MODELLING CHOICE, not a "
                "published fact - the data has no signalling-block granularity.",
                "horizon": "One representative 24-hour day. The source has no "
                "day-of-week field, so every train is treated as running daily, "
                "which over-estimates occupancy rather than under-estimating it.",
                "clearanceMarginMin": timetable.DEFAULT_CLEARANCE_MARGIN_MIN,
                "minBlockWindowMin": timetable.DEFAULT_MIN_BLOCK_WINDOW_MIN,
                "maxPlausibleTransitMin": timetable.MAX_PLAUSIBLE_TRANSIT_MIN,
            },
            "count": len(calendar),
            "calendar": calendar,
        },
    )
    _write_json(REPORT_OUT, report)

    for path in (TRAINS_OUT, CALENDAR_OUT, REPORT_OUT):
        print(f"Wrote {path.relative_to(PROCESSED_DIR.parent)} ({path.stat().st_size:,} bytes)")

    return report


def _build_report(
    records, trains, calendar, methods, occupied_all, free_all,
    low_confidence, no_traffic, section_count, transit_stats,
) -> dict:
    typed = Counter(t.type or "(missing)" for t in trains.values())
    with_traffic = [c for c in calendar if c["transitWindows"] > 0]

    return {
        "task": "T3 - timetable occupancy calendar (PRD FR1.2)",
        "inputs": {
            "stop_records": len(records),
            "trains": len(trains),
            "sections_from_T2": section_count,
        },
        "stopPairAccounting": transit_stats,
        "occupancy": {
            "sections_with_traffic": len(with_traffic),
            "sections_without_timed_traffic": no_traffic,
            "sections_low_confidence": low_confidence,
            "transit_windows_total": sum(c["transitWindows"] for c in calendar),
            "transit_method_counts": dict(methods),
            "median_occupied_minutes": statistics.median(occupied_all) if occupied_all else None,
            "median_free_minutes": statistics.median(free_all) if free_all else None,
            "median_utilisation_pct": round(
                statistics.median(c["utilisationPct"] for c in with_traffic), 2
            ) if with_traffic else None,
            "sections_with_no_usable_block_window": sum(
                1 for c in with_traffic if not c["maxDailyBlockWindows"]
            ),
        },
        "trains": {
            "count": len(trains),
            "by_type": dict(typed.most_common()),
        },
        "modellingChoices": {
            "occupancy": "departure at endpoint A -> arrival at endpoint B",
            "horizon": "one representative 24-hour day; no day-of-week in source",
            "clearanceMarginMin": timetable.DEFAULT_CLEARANCE_MARGIN_MIN,
            "minBlockWindowMin": timetable.DEFAULT_MIN_BLOCK_WINDOW_MIN,
        },
    }


def main() -> int:
    report = build()
    print("\n--- timetable report ---")
    print(json.dumps({"occupancy": report["occupancy"]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
