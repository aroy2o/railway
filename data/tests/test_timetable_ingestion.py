"""Tests for T3 - timetable occupancy calendar and train metadata (PRD FR1.2).

Same two-part split as the T2 suite:

* **Provenance tests** check parsed values back against the downloaded bytes,
  using trains whose details are independently verifiable (12951 is the Mumbai
  Rajdhani; 01101 is the worked example in datameet's own README).
* **Logic tests** drive the occupancy rules from hand-built fixtures, so the
  modelling choices - transit window, midnight split, clearance margin,
  minimum block length - are pinned without loading 82 MB of JSON.

Provenance tests skip when data/raw is empty so a fresh clone still gets a green
logic suite.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from ingestion import timetable, trains_meta
from ingestion.build_timetable import CALENDAR_OUT, TRAINS_OUT, build, load_corridor_index
from ingestion.sources import DATAMEET_SCHEDULES, DATAMEET_TRAINS
from ingestion.timetable import MINUTES_PER_DAY, Window

raw_data_required = pytest.mark.skipif(
    not (DATAMEET_TRAINS.raw_path.exists() and DATAMEET_SCHEDULES.raw_path.exists()),
    reason="raw datasets not downloaded; run: python -m ingestion.download",
)


@pytest.fixture(scope="module")
def trains():
    return trains_meta.load_trains(DATAMEET_TRAINS.raw_path)


@pytest.fixture(scope="module")
def calendar():
    if not CALENDAR_OUT.exists():
        build()
    payload = json.loads(CALENDAR_OUT.read_text())
    return {entry["_id"]: entry for entry in payload["calendar"]}


# --------------------------------------------------------------------------- #
# Provenance                                                                   #
# --------------------------------------------------------------------------- #

@raw_data_required
def test_train_documented_in_source_readme_parses_exactly(trains):
    """01101 is the worked example in datameet/railways' own README.

    Checking every field pins the parse to the real file - including the
    duration_h/duration_m combination, which is the easiest value here to get
    quietly wrong.
    """
    train = trains["01101"]

    assert train.name == "Mumbai LTT - Gwalior (Weekly) Special"
    assert train.type == "Exp"
    assert train.zone == "CR"
    assert train.from_station_code == "LTT"
    assert train.to_station_code == "GWL"
    assert train.distance_km == 1216.0
    assert train.return_train == "01102"
    assert train.duration_minutes == 23 * 60 + 45  # duration_h=23, duration_m=45
    assert train.classes["third_ac"] is True
    assert train.classes["first_ac"] is False


@raw_data_required
@pytest.mark.parametrize(
    ("number", "expected_type", "expected_zone"),
    [
        ("12951", "Raj", "WR"),    # Mumbai Central - New Delhi Rajdhani
        ("12301", "Raj", "ER"),    # Howrah - New Delhi Rajdhani
        ("12259", "Drnt", "ER"),   # Sealdah - New Delhi Duronto
    ],
)
def test_real_named_trains_carry_their_real_class_code(number, expected_type, expected_zone, trains):
    """Independently verifiable services, so a wrong class code is detectable."""
    train = trains[number]

    assert train.type == expected_type
    assert train.zone == expected_zone
    assert f'"number": "{number}"' in DATAMEET_TRAINS.raw_path.read_text()


@raw_data_required
def test_train_set_matches_the_schedule_set(trains):
    """trains.json and schedules.json must describe the same 5,208 services."""
    assert len(trains) == 5208


@raw_data_required
def test_no_priority_score_is_invented_in_t3():
    """T3 surfaces the real class code only; weighting it is task T22."""
    payload = json.loads(TRAINS_OUT.read_text()) if TRAINS_OUT.exists() else None
    if payload is None:
        pytest.skip("trains.json not built yet")

    sample = payload["trains"][0]
    for forbidden in ("priority", "priorityScore", "weight", "impact"):
        assert forbidden not in sample, f"T3 must not invent {forbidden!r}"


@raw_data_required
def test_ghaziabad_sahibabad_is_genuinely_congested(calendar):
    """A real, checkable outcome: GZB-SBB is one of the busiest pairs on IR.

    281 trains a day leaves almost no maintenance window, which is precisely
    the scarcity the problem statement is about. If the occupancy model were
    broken, this section would not come out saturated.
    """
    entry = calendar["GZB-SBB"]

    assert entry["trainsObserved"] > 200
    assert entry["utilisationPct"] > 50
    # Whatever free time remains must be a genuine, usable window.
    for window in entry["maxDailyBlockWindows"]:
        assert window["durationMin"] >= timetable.DEFAULT_MIN_BLOCK_WINDOW_MIN


@raw_data_required
def test_calendar_covers_every_corridor_from_t2(calendar):
    _, known_sections = load_corridor_index()

    assert len(calendar) == len(known_sections)


@raw_data_required
def test_windows_are_well_formed_and_within_one_day(calendar):
    for entry in calendar.values():
        for key in ("occupiedWindows", "maxDailyBlockWindows"):
            previous_end = -1
            for window in entry[key]:
                assert 0 <= window["startMin"] < window["endMin"] <= MINUTES_PER_DAY
                assert window["durationMin"] == window["endMin"] - window["startMin"]
                # Merged output must be disjoint and ordered.
                assert window["startMin"] >= previous_end
                previous_end = window["endMin"]


@raw_data_required
def test_low_confidence_sections_are_flagged_with_a_reason(calendar):
    """T2's longHop finding must be honoured here, not rediscovered or ignored."""
    flagged = [e for e in calendar.values() if e["lowConfidence"]]

    assert flagged, "expected some low-confidence sections"
    for entry in flagged:
        assert entry["lowConfidenceReasons"], f"{entry['_id']} flagged without a reason"

    long_hops = [e for e in flagged if any("longHop" in r for r in e["lowConfidenceReasons"])]
    assert len(long_hops) == 81, "T2 flagged 81 longHop sections; all must carry through"


@raw_data_required
def test_build_is_idempotent(calendar):
    before = {
        path: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (TRAINS_OUT, CALENDAR_OUT)
    }

    build()

    for path, digest in before.items():
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, (
            f"{path.name} changed across identical runs"
        )


# --------------------------------------------------------------------------- #
# Logic: time parsing                                                          #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("07:55:00", 475),
        ("00:00:00", 0),
        ("23:59:00", 1439),
        ("'15:50:00'", 950),   # the ISL CSV quotes its times
        ("None", None),        # the source writes missing times as this string
        (None, None),
        ("", None),
        ("25:00:00", None),    # out of range, not a silent modulo
        ("banana", None),
    ],
)
def test_clock_parsing(value, expected):
    assert timetable.parse_clock_minutes(value) == expected


# --------------------------------------------------------------------------- #
# Logic: transit duration - the core modelling rule                            #
# --------------------------------------------------------------------------- #

def test_transit_is_the_gap_between_departure_and_arrival():
    duration, method = timetable.transit_duration(475, 482)

    assert (duration, method) == (7, "clock-wrap")


def test_transit_across_midnight_is_not_negative():
    """23:50 -> 00:10 is twenty minutes, not minus one thousand four hundred."""
    duration, method = timetable.transit_duration(23 * 60 + 50, 10)

    assert (duration, method) == (20, "clock-wrap")


def test_zero_length_transit_is_floored_to_one_minute():
    """Times are minute-resolution, so very short sections can round to zero.

    A zero-length occupancy is meaningless to the solver.
    """
    duration, _ = timetable.transit_duration(600, 600)

    assert duration == timetable.MIN_OCCUPANCY_MIN


def test_implausibly_long_transit_is_rejected_not_clamped():
    """Four hours between adjacent stations is a data error, not an occupancy."""
    duration, method = timetable.transit_duration(0, 4 * 60 + 30)

    assert duration is None
    assert method == "implausible"


def test_day_fields_rescue_a_false_midnight_wrap():
    """Fallback path: wrap says 23h, but the day fields say a short same-day hop.

    Measured on the real data, clock-wrap beats day-delta overall (day-delta
    produces 308 negative and 196 over-24h durations), so day is consulted only
    when the wrapped value is already implausible.
    """
    # departure 10:00, arrival 09:00 -> wrap gives 1380 min (implausible).
    # Same day, so the day fields imply -60, which is also invalid -> rejected.
    duration, method = timetable.transit_duration(600, 540, 1, 1)
    assert duration is None and method == "implausible"

    # departure 23:00 day 1, arrival 00:30 day 2 -> wrap already gives 90 min.
    duration, method = timetable.transit_duration(23 * 60, 30, 1, 2)
    assert (duration, method) == (90, "clock-wrap")


# --------------------------------------------------------------------------- #
# Logic: window algebra                                                        #
# --------------------------------------------------------------------------- #

def test_window_not_crossing_midnight_is_left_whole():
    assert timetable.split_at_midnight(600, 30) == [Window(600, 630)]


def test_window_crossing_midnight_is_split_in_two():
    """23:50 + 20 min becomes [23:50, 24:00) and [00:00, 00:10) of the same day."""
    windows = timetable.split_at_midnight(23 * 60 + 50, 20)

    assert windows == [Window(1430, MINUTES_PER_DAY), Window(0, 10)]
    assert sum(w.duration for w in windows) == 20


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ([(0, 10), (5, 20)], [(0, 20)]),        # overlapping
        ([(0, 10), (10, 20)], [(0, 20)]),       # touching counts as contiguous
        ([(0, 10), (30, 40)], [(0, 10), (30, 40)]),  # disjoint
        ([(30, 40), (0, 10)], [(0, 10), (30, 40)]),  # unsorted input
        ([(0, 100), (10, 20)], [(0, 100)]),     # fully contained
    ],
)
def test_window_merging(given, expected):
    merged = timetable.merge_windows(Window(s, e) for s, e in given)

    assert [(w.start, w.end) for w in merged] == expected


def test_free_windows_are_the_complement_with_a_clearance_margin():
    occupied = [Window(600, 660)]  # 10:00-11:00

    free = timetable.free_windows(occupied, clearance_margin_min=5, min_block_window_min=30)

    # Margin widens the occupancy to 09:55-11:05, so the gaps stop/start there.
    assert [(w.start, w.end) for w in free] == [(0, 595), (665, MINUTES_PER_DAY)]


def test_gaps_shorter_than_the_minimum_are_not_reported_as_block_windows():
    """A ten-minute gap between trains is not a maintenance opportunity."""
    occupied = [Window(0, 600), Window(610, MINUTES_PER_DAY)]

    free = timetable.free_windows(occupied, clearance_margin_min=0, min_block_window_min=30)

    assert free == []


def test_a_fully_occupied_section_yields_no_block_window():
    free = timetable.free_windows([Window(0, MINUTES_PER_DAY)])

    assert free == []


def test_an_empty_section_is_free_all_day():
    free = timetable.free_windows([])

    assert [(w.start, w.end) for w in free] == [(0, MINUTES_PER_DAY)]


# --------------------------------------------------------------------------- #
# Logic: transit extraction honours the T2 rules                               #
# --------------------------------------------------------------------------- #

def _stop(train, stop_id, code, departure=None, arrival=None, day=1):
    return {
        "train_number": train,
        "id": stop_id,
        "station_code": code,
        "departure": departure or "None",
        "arrival": arrival or "None",
        "day": day,
    }


def test_duplicate_run_does_not_produce_a_phantom_occupancy():
    """The T2 trap, carried forward: train 04857's stop list appears twice.

    A phantom adjacency must not become a phantom occupancy window.
    """
    records = [
        _stop("04857", 11615, "PPR", departure="06:50:00"),
        _stop("04857", 11616, "JU", arrival="08:30:00"),
        _stop("04857", 11813, "PPR", departure="06:50:00"),
        _stop("04857", 11814, "JU", arrival="08:30:00"),
    ]
    stats: dict[str, int] = {}

    keys = {key for key, _, _, _ in timetable.iter_section_transits(records, stats=stats)}

    assert keys == {("JU", "PPR")}
    assert stats["pairs_used"] == 2       # one per run, not three
    assert stats["pairs_seen"] == 2       # the split prevented the third pair


def test_stop_pairs_without_times_are_skipped_and_counted():
    """5.4% of real records have no arrival, departure or day at all."""
    records = [
        _stop("1", 1, "A", departure="10:00:00"),
        _stop("1", 2, "B"),                       # no times at all
        _stop("1", 3, "C", arrival="10:40:00"),
    ]
    stats: dict[str, int] = {}

    list(timetable.iter_section_transits(records, stats=stats))

    assert stats["skipped_missing_time"] == 2
    assert stats["pairs_used"] == 0


def test_every_stop_pair_is_accounted_for():
    """The no-silent-drops invariant the pipeline asserts on real data."""
    records = [
        _stop("1", 1, "A", departure="10:00:00"),
        _stop("1", 2, "B", arrival="10:07:00", departure="10:09:00"),
        _stop("1", 3, "B", arrival="10:10:00"),   # self loop
        _stop("1", 4, "C", arrival="23:00:00"),   # implausible transit
    ]
    stats: dict[str, int] = {}

    list(timetable.iter_section_transits(records, stats=stats))

    accounted = (
        stats["pairs_used"]
        + stats["skipped_self_loop"]
        + stats["skipped_unknown_section"]
        + stats["skipped_missing_time"]
        + stats["skipped_implausible_transit"]
    )
    assert accounted == stats["pairs_seen"]


def test_sections_outside_the_known_set_are_skipped():
    records = [
        _stop("1", 1, "A", departure="10:00:00"),
        _stop("1", 2, "B", arrival="10:07:00"),
    ]
    stats: dict[str, int] = {}

    result = list(
        timetable.iter_section_transits(records, known_sections=set(), stats=stats)
    )

    assert result == []
    assert stats["skipped_unknown_section"] == 1


# --------------------------------------------------------------------------- #
# Logic: train metadata                                                        #
# --------------------------------------------------------------------------- #

def test_duration_is_combined_from_hours_and_minutes():
    assert trains_meta._duration_minutes({"duration_h": 2, "duration_m": 30}) == 150
    assert trains_meta._duration_minutes({"duration_h": 0, "duration_m": 45}) == 45
    assert trains_meta._duration_minutes({}) is None
