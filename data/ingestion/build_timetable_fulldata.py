"""Build data/processed/corridor_calendar.json from full_data's real freight +
passenger traffic aggregates, for the fulldata-ktv-psa branch.

The fulldata-branch analogue of `ingestion.build_timetable` (T3). Two real
differences from T3's approach:

  1. **maxDailyBlockWindows model the real IR "corridor block" standard, not
     full_data's own two-window assumption.** full_data's own Gate 6
     scheduler (release/integration_package/scheduler.py) always offered two
     fixed candidate windows per line per day - NIGHT (00:00-05:00, 300 min)
     and LEAN (11:00-15:00, 240 min), 540 min/day total - an unsourced
     assumption, not derived from anything. Researched against actual Indian
     Railways practice instead (see sources below): since 2018 IR mandates a
     **minimum 3-hour daily corridor block per section**, published in the
     Working Time Table at a division/section-specific time (not a single
     network-wide clock time), during which no trains run so
     maintenance/inspection can proceed. That minimum is a floor, not a
     ceiling - real corridor blocks do run longer where the local traffic
     pattern supports it (the Mumbai suburban precedent cited alongside the
     mandate: ~3h on an ordinary day, ~6h on a Sunday, when there is
     genuinely less traffic to work around). This module models that:
     ONE daily window per corridor, placed over the longest CONTIGUOUS
     stretch of that specific section's own below-average traffic hours
     (from `traffic_profiles.csv`), floored at the 3h mandate and capped at
     6h against the Mumbai precedent rather than left unbounded - not the
     original two-window 540 min/day, and not a flat 180 min/day either, but
     whatever the section's own real traffic pattern actually supports
     between those two sourced bounds.
     Sources:
       - https://www.freepressjournal.in/india/railways-to-observe-mandatory-3-hour-block-daily-for-track-maintenance-following-increase-in-freight-services
       - https://swarajyamag.com/news-brief/maintenance-corridor-to-feature-in-new-time-table-of-indian-railways
       - https://indianrailways.gov.in/railwayboard/uploads/codesmanual/IRPWM/PermanentWayManualCh8_data.htm
       - https://swarajyamag.com/economy/indian-railways-is-stepping-up-maintenance-by-emulating-mumbais-track-record
         (Mumbai suburban: ~3h daily / ~6h Sunday precedent for the 6h cap)
     Still well under full_data's original 540 min/day assumption in most
     cases - expect more deferrals than the original branch state, and more
     cross-department batching than a flat 180 min/day would allow, as a
     direct, understood consequence of grounding this in real traffic data
     rather than either extreme.

  2. **Occupancy comes from `traffic_profiles.csv`**, which is already
     aggregated to (block_section, direction, hour, freight_count,
     passenger_count, total_count) rather than individual train timestamps -
     so there is no per-train transit-window derivation to do, only an
     hour-level occupied/free classification.

ASSUMPTIONS (flagged):
  - Every physical line of a block section is given the same traffic profile
    and the same derived block window (the source data is not split by
    line/track, only by direction).
  - An hour counts as "occupied" if `total_count > 0` for that hour on that
    section, summed across both directions - a coarser, hour-granularity
    occupancy model than T3's minute-level one, appropriate to what this
    source data actually resolves.
  - "Below-average" means at or under that section's own mean hourly total
    (freight + passenger) across its 24 hours - a per-section relative
    threshold, not a network-wide absolute one, so a genuinely busier
    section still gets a real (if shorter) quiet stretch relative to itself.
  - The quiet-run search does not wrap past midnight (0-23 only) - real quiet
    periods for this corridor's actual traffic pattern are overwhelmingly
    late-night/early-morning, well inside that range, and it avoids
    re-implementing T3's own midnight-wrap window splitting for a case that
    would not materially change the result here.
  - When no contiguous run of at least 3 quiet hours exists for a section
    (a genuinely always-busy corridor), this falls back to the flat 3h
    mandate, placed at that section's own least-bad 3 consecutive hours -
    the sourced floor is never skipped, only extended when the data
    supports it.
  - A section with no traffic_profiles.csv rows at all (already flagged
    lowConfidence, and excluded from synthetic demand generation by
    build_synthetic_fulldata.py) falls back to 00:00-03:00 - IR's real
    minimum, applied honestly rather than guessing a data-driven time that
    does not exist for it.
"""

from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict

from ingestion.build_corridors_fulldata import CORRIDORS_OUT
from ingestion.fulldata_sources import PROCESSED_DIR, SOURCE_CITATION, TRAFFIC_PROFILES_CSV
from ingestion.timetable import Window, free_windows, merge_windows

CALENDAR_OUT = PROCESSED_DIR / "corridor_calendar.json"
REPORT_OUT = PROCESSED_DIR / "FULLDATA_CALENDAR_REPORT.json"

#: IR's real mandated floor and the Mumbai-precedent ceiling (see module
#: docstring sources) - the range a section's own quiet period is allowed to
#: fill, not full_data's original two fixed windows.
CORRIDOR_BLOCK_MIN_MINUTES = 3 * 60
CORRIDOR_BLOCK_MAX_MINUTES = 6 * 60

#: Fallback for a section with no traffic data to search against at all.
FALLBACK_WINDOW = Window(0, CORRIDOR_BLOCK_MIN_MINUTES)


def _quiet_hour_runs(totals: list[int], mean_traffic: float) -> list[tuple[int, int]]:
    """Maximal contiguous runs of hours at or under `mean_traffic`, as
    half-open [start, end) hour ranges. No midnight wrap (0-23 only)."""
    runs: list[tuple[int, int]] = []
    run_start: int | None = None
    for hour in range(24):
        quiet = totals[hour] <= mean_traffic
        if quiet and run_start is None:
            run_start = hour
        elif not quiet and run_start is not None:
            runs.append((run_start, hour))
            run_start = None
    if run_start is not None:
        runs.append((run_start, 24))
    return runs


def _quietest_window(hourly: dict[int, dict[str, int]]) -> tuple[Window, int, int]:
    """This section's real daily corridor block: the longest contiguous run
    of its own below-average traffic hours, floored at IR's 3h mandate and
    capped at the 6h Mumbai-precedent (see module docstring).

    Returns (window, start_hour, duration_minutes). Falls back to
    FALLBACK_WINDOW when there is no traffic data to search at all.
    """
    if not hourly:
        return FALLBACK_WINDOW, 0, CORRIDOR_BLOCK_MIN_MINUTES

    totals = [hourly.get(hour, {}).get("total", 0) for hour in range(24)]
    mean_traffic = sum(totals) / 24
    runs = _quiet_hour_runs(totals, mean_traffic)

    best_run = max(runs, key=lambda run: run[1] - run[0], default=None)
    if best_run is not None and (best_run[1] - best_run[0]) >= 3:
        start, end = best_run
        minutes = min(end - start, 6) * 60
        return Window(start * 60, start * 60 + minutes), start, minutes

    # No 3+ hour quiet stretch exists for this section - IR's flat minimum
    # still applies, placed at the section's own least-bad 3 consecutive
    # hours rather than a guessed time.
    best_start, best_total = 0, None
    for start in range(0, 22):  # start+3 <= 24
        total = sum(totals[start : start + 3])
        if best_total is None or total < best_total:
            best_total, best_start = total, start
    return (
        Window(best_start * 60, best_start * 60 + CORRIDOR_BLOCK_MIN_MINUTES),
        best_start,
        CORRIDOR_BLOCK_MIN_MINUTES,
    )


def load_corridor_index() -> dict[str, list[dict]]:
    """block_section -> list of this section's Corridor docs (one per line)."""
    if not CORRIDORS_OUT.exists():
        raise SystemExit(
            "processed/corridors.json missing. Run:  python -m ingestion.build_corridors_fulldata"
        )
    payload = json.loads(CORRIDORS_OUT.read_text())
    by_section: dict[str, list[dict]] = defaultdict(list)
    for corridor in payload["corridors"]:
        by_section[corridor["blockSection"]].append(corridor)
    return by_section


def load_hourly_traffic() -> dict[str, dict[int, dict[str, int]]]:
    """block_section -> {hour: {freight, passenger, total}}, summed across direction."""
    traffic: dict[str, dict[int, dict[str, int]]] = defaultdict(
        lambda: defaultdict(lambda: {"freight": 0, "passenger": 0, "total": 0})
    )
    if not TRAFFIC_PROFILES_CSV.exists():
        return traffic
    with TRAFFIC_PROFILES_CSV.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            section = row.get("block_section")
            try:
                hour = int(row.get("hour", ""))
            except ValueError:
                continue
            if not section or not (0 <= hour <= 23):
                continue
            bucket = traffic[section][hour]
            bucket["freight"] += _to_int(row.get("freight_count"))
            bucket["passenger"] += _to_int(row.get("passenger_count"))
            bucket["total"] += _to_int(row.get("total_count"))
    return traffic


def _to_int(value: object) -> int:
    try:
        return int(round(float(value)))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def build() -> dict:
    print("Loading corridors from build_corridors_fulldata…")
    by_section = load_corridor_index()
    print(f"  {len(by_section):,} block sections, "
          f"{sum(len(v) for v in by_section.values()):,} corridor-line documents")

    print("Loading traffic_profiles.csv…")
    traffic = load_hourly_traffic()
    print(f"  {len(traffic):,} sections with traffic data")

    calendar: list[dict] = []
    low_confidence = 0
    block_start_hours: list[int] = []
    block_durations: list[int] = []

    for section in sorted(by_section):
        hourly = traffic.get(section, {})
        occupied_hours = sorted(h for h, v in hourly.items() if v["total"] > 0)
        occupied_windows = merge_windows(Window(h * 60, (h + 1) * 60) for h in occupied_hours)
        free = free_windows(occupied_windows)

        occupied_minutes = sum(w.duration for w in occupied_windows)
        free_minutes = sum(w.duration for w in free)
        trains_observed = sum(v["total"] for v in hourly.values())
        freight_total = sum(v["freight"] for v in hourly.values())
        passenger_total = sum(v["passenger"] for v in hourly.values())

        block_window, block_start_hour, block_minutes = _quietest_window(hourly)
        block_start_hours.append(block_start_hour)
        block_durations.append(block_minutes)

        reasons = []
        if not hourly:
            reasons.append("no traffic_profiles.csv rows for this block_section")
            low_confidence += 1

        for corridor in by_section[section]:
            cid = corridor["_id"]
            calendar.append(
                {
                    "_id": cid,
                    "corridorId": cid,
                    "trainClassMix": {"FREIGHT": freight_total, "PASSENGER": passenger_total},
                    "maxDailyBlockWindows": [block_window.as_dict()],
                    "occupiedWindows": [w.as_dict() for w in occupied_windows],
                    "trainsObserved": trains_observed,
                    "transitWindows": len(occupied_hours),
                    "occupiedMinutes": occupied_minutes,
                    "freeMinutes": free_minutes,
                    "utilisationPct": round(100 * occupied_minutes / 1440, 2),
                    "lowConfidence": bool(reasons),
                    "lowConfidenceReasons": reasons,
                }
            )

    report = {
        "task": "fulldata-ktv-psa branch: real occupancy calendar (KTV-PSA)",
        "corridorBlockModel": {
            "note": "One real IR-standard corridor block per section: its own longest "
            "contiguous below-average-traffic run, floored at IR's 3h mandate and capped at "
            "the 6h Mumbai-precedent - replaces full_data's original unsourced two-window "
            "(540min/day, always the same clock time) assumption. See module docstring for "
            "sources.",
            "minMinutesPerDay": CORRIDOR_BLOCK_MIN_MINUTES,
            "maxMinutesPerDay": CORRIDOR_BLOCK_MAX_MINUTES,
            "meanMinutesPerDay": round(sum(block_durations) / len(block_durations), 1)
            if block_durations
            else None,
            "durationDistribution": {
                str(minutes): block_durations.count(minutes) for minutes in sorted(set(block_durations))
            },
            "startHourDistribution": {
                str(hour): block_start_hours.count(hour) for hour in sorted(set(block_start_hours))
            },
        },
        "outputs": {
            "corridorLineDocuments": len(calendar),
            "sectionsWithNoTrafficData": low_confidence,
        },
        "sourceCitation": SOURCE_CITATION,
    }

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    CALENDAR_OUT.write_text(
        json.dumps(
            {
                "source": SOURCE_CITATION,
                "count": len(calendar),
                "calendar": calendar,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
    REPORT_OUT.write_text(json.dumps(report, indent=2) + "\n")

    print(f"Wrote {CALENDAR_OUT} ({CALENDAR_OUT.stat().st_size:,} bytes)")
    return report


def main() -> int:
    report = build()
    print("\n--- fulldata calendar ingestion report ---")
    print(json.dumps(report["outputs"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
