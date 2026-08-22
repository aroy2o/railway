"""Tests for T2 - real corridor data ingestion (PRD 5.1).

Two kinds of test live here, and the split is deliberate:

* **Provenance tests** assert that the processed output really did come from the
  downloaded files - specific station codes and coordinates are checked back
  against the raw bytes on disk. These are what make the claim "this is real
  data" verifiable rather than asserted.
* **Logic tests** exercise the stop-sequence rules on small hand-built
  fixtures, so the corridor-derivation rules can be checked without loading
  82 MB of JSON.

Provenance tests skip (rather than fail) when data/raw is empty, so a fresh
clone that has not run the download yet still gets a green logic suite.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from ingestion import datameet
from ingestion.build_corridors import (
    CORRIDORS_OUT,
    LONG_HOP_KM,
    STATIONS_OUT,
    build,
    resolve_zone,
)
from ingestion.sources import DATAMEET_SCHEDULES, DATAMEET_STATIONS

raw_data_required = pytest.mark.skipif(
    not (DATAMEET_STATIONS.raw_path.exists() and DATAMEET_SCHEDULES.raw_path.exists()),
    reason="raw datasets not downloaded; run: python -m ingestion.download",
)


# --------------------------------------------------------------------------- #
# Fixtures                                                                     #
# --------------------------------------------------------------------------- #

@pytest.fixture(scope="module")
def stations():
    return datameet.load_stations(DATAMEET_STATIONS.raw_path)


@pytest.fixture(scope="module")
def corridors_payload():
    if not CORRIDORS_OUT.exists():
        build()
    return json.loads(CORRIDORS_OUT.read_text())


# --------------------------------------------------------------------------- #
# Provenance: the output really came from the downloaded files                 #
# --------------------------------------------------------------------------- #

@raw_data_required
def test_raw_downloads_are_substantial_not_stubs():
    """Guards against an error page or truncated download parsing as valid."""
    assert DATAMEET_STATIONS.raw_path.stat().st_size > 1_000_000
    assert DATAMEET_SCHEDULES.raw_path.stat().st_size > 50_000_000


@raw_data_required
def test_station_documented_in_source_readme_is_parsed_exactly(stations):
    """BDHL is the worked example in datameet/railways' own README.

    Checking name, zone, state and both coordinates pins the parse to the real
    file - including the GeoJSON [lon, lat] ordering, which is the easiest thing
    in this pipeline to silently get backwards.
    """
    badhal = stations["BDHL"]

    assert badhal.name == "Badhal"
    assert badhal.zone == "NWR"
    assert badhal.state == "Rajasthan"
    assert badhal.lat == pytest.approx(27.2520587)
    assert badhal.lon == pytest.approx(75.4516454)
    # Sanity on the ordering: every Indian station is north of the equator and
    # east of Greenwich, and latitude here must be the smaller of the two.
    assert 6 < badhal.lat < 38
    assert 68 < badhal.lon < 98


@raw_data_required
@pytest.mark.parametrize("code", ["BDHL", "LTT", "GZB", "SBB", "KYN", "NDLS", "HWH"])
def test_output_station_codes_appear_verbatim_in_the_raw_file(code, stations):
    """Spot-check: each code in our output is physically present in raw bytes."""
    assert code in stations

    raw = DATAMEET_STATIONS.raw_path.read_text()
    assert f'"code": "{code}"' in raw, f"{code} is not in the downloaded stations.json"


@raw_data_required
def test_corridor_count_is_plausible_and_not_a_round_number(corridors_payload):
    """A derived count should look derived.

    A suspiciously round total is the signature of a hardcoded or generated
    list; a real derivation from 417k stop records lands on an arbitrary number.
    """
    count = corridors_payload["count"]

    assert count == len(corridors_payload["corridors"])
    assert 5_000 < count < 30_000, f"implausible corridor count: {count}"
    assert count % 100 != 0, f"corridor count {count} is suspiciously round"


@raw_data_required
def test_every_corridor_endpoint_is_a_known_station(corridors_payload, stations):
    for corridor in corridors_payload["corridors"]:
        assert corridor["stationA"]["code"] in stations
        assert corridor["stationB"]["code"] in stations
        # Undirected sections are keyed on the sorted pair, so this ordering
        # invariant is what guarantees A-B and B-A cannot both exist.
        assert corridor["stationA"]["code"] < corridor["stationB"]["code"]
        assert corridor["_id"] == (
            f"{corridor['stationA']['code']}-{corridor['stationB']['code']}"
        )


@raw_data_required
def test_real_mumbai_central_line_adjacencies_are_present(corridors_payload):
    """Domain check against known ground truth.

    Kalyan - Thakurli - Dombivli - Kopar are genuinely consecutive on the Mumbai
    Central line. If the stop-sequence derivation were wrong, these specific
    adjacencies would not survive.
    """
    ids = {c["_id"] for c in corridors_payload["corridors"]}

    for expected in ("KYN-THK", "DI-THK", "DI-KOPR"):
        assert expected in ids, f"missing real adjacency {expected}"


@raw_data_required
def test_sections_look_like_real_inter_station_distances(corridors_payload):
    """Adjacent Indian stations sit a few km apart, not tens of km.

    This is the check that would fail loudly if stop ordering were scrambled -
    a mis-ordered sequence produces pairs scattered across the network.
    """
    lengths = sorted(
        c["straightLineKm"] for c in corridors_payload["corridors"] if c["straightLineKm"]
    )
    median = lengths[len(lengths) // 2]
    under_threshold = sum(1 for d in lengths if d <= LONG_HOP_KM) / len(lengths)

    assert 2 < median < 15, f"median section length {median} km is not a station gap"
    assert under_threshold > 0.95, f"only {under_threshold:.1%} of sections under {LONG_HOP_KM} km"


@raw_data_required
def test_published_distance_agrees_with_straight_line(corridors_payload):
    """Independently-published track distance must exceed great-circle slightly.

    Track curves; a straight line does not. A ratio distribution centred just
    above 1.0 is only possible if both the stop parsing and the distance join
    are correct - it is not a shape that survives a mis-parse.
    """
    ratios = sorted(
        c["publishedDistanceKm"] / c["straightLineKm"]
        for c in corridors_payload["corridors"]
        if c["publishedDistanceKm"] and c["straightLineKm"] and c["straightLineKm"] > 0.5
    )

    assert len(ratios) > 500, "too few corroborated distances to validate"
    assert 0.95 < ratios[len(ratios) // 2] < 1.30


@raw_data_required
def test_prd_schema_fields_are_present_and_unpopulated_ones_are_empty(corridors_payload):
    """PRD Section 15 shape is honoured, without inventing values for T3/T26."""
    sample = corridors_payload["corridors"][0]

    for field in ("_id", "name", "zone", "section", "maxDailyBlockWindows", "seasonalRiskFlag"):
        assert field in sample

    for corridor in corridors_payload["corridors"]:
        # Never fabricated here - real timetable gaps arrive in T3, seasonal
        # risk in T26.
        assert corridor["maxDailyBlockWindows"] == []
        assert corridor["seasonalRiskFlag"] is None


@raw_data_required
def test_build_is_idempotent(corridors_payload):
    """Re-running on unchanged raw files must not churn the outputs.

    Later tasks (T3 seeding, T4 generation) depend on these files, so a rebuild
    has to be safe to run at any time. This is also why no wall-clock timestamp
    is written into them.
    """
    before = {
        path: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (STATIONS_OUT, CORRIDORS_OUT)
    }

    build()

    for path, digest in before.items():
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, (
            f"{path.name} changed across identical runs"
        )


# --------------------------------------------------------------------------- #
# Logic: stop-sequence rules, on hand-built fixtures                           #
# --------------------------------------------------------------------------- #

def _stop(train, stop_id, code):
    return {"train_number": train, "id": stop_id, "station_code": code}


def test_runs_are_ordered_by_id_not_by_array_position():
    """Records for a train are interleaved in the source, so order is by id."""
    records = [
        _stop("111", 3, "C"),
        _stop("999", 50, "X"),
        _stop("111", 1, "A"),
        _stop("111", 2, "B"),
    ]

    runs = dict(_collect(records))

    assert runs["111"] == [["A", "B", "C"]]


def test_a_duplicated_stop_list_is_split_into_two_runs():
    """The real trap: train 04857 carries its whole stop list twice.

    Chaining straight through would emit JU-PPR - a section joining the end of
    one copy to the start of the next, which does not exist on the ground.
    """
    records = [
        _stop("04857", 11615, "PPR"),
        _stop("04857", 11616, "KSW"),
        _stop("04857", 11617, "JU"),
        # second copy, under a separate id block
        _stop("04857", 11813, "PPR"),
        _stop("04857", 11814, "KSW"),
        _stop("04857", 11815, "JU"),
    ]

    runs = dict(_collect(records))["04857"]

    assert runs == [["PPR", "KSW", "JU"], ["PPR", "KSW", "JU"]]

    stations = _fake_stations("PPR", "KSW", "JU")
    sections, _ = datameet.derive_corridor_sections(records, stations)

    assert ("JU", "PPR") not in sections, "phantom section across duplicate runs"
    assert set(sections) == {("KSW", "PPR"), ("JU", "KSW")}


def test_a_missing_intermediate_stop_splits_the_run():
    """An id gap means a dropped stop, so the neighbours are not adjacent."""
    records = [_stop("222", 1, "A"), _stop("222", 2, "B"), _stop("222", 4, "D")]

    stations = _fake_stations("A", "B", "D")
    sections, _ = datameet.derive_corridor_sections(records, stations)

    assert set(sections) == {("A", "B")}, "B-D must not be joined across a gap"


def test_sections_are_undirected_but_directions_are_counted():
    records = [
        _stop("1", 1, "A"),
        _stop("1", 2, "B"),
        _stop("2", 10, "B"),
        _stop("2", 11, "A"),
    ]

    sections, _ = datameet.derive_corridor_sections(records, _fake_stations("A", "B"))

    assert set(sections) == {("A", "B")}
    section = sections[("A", "B")]
    assert section.directional_traversals == {"A->B": 1, "B->A": 1}
    assert section.total_traversals == 2
    assert section.train_numbers == {"1", "2"}


def test_unknown_stations_and_self_loops_are_skipped_and_counted():
    records = [
        _stop("1", 1, "A"),
        _stop("1", 2, "A"),      # self loop
        _stop("1", 3, "ZZZZ"),   # not in stations.json
        _stop("1", 4, "B"),
    ]

    sections, stats = datameet.derive_corridor_sections(records, _fake_stations("A", "B"))

    assert sections == {}
    assert stats["skipped_self_loop"] == 1
    assert stats["skipped_unknown_station"] == 2
    # Nothing is dropped silently - every skipped pair is accounted for.
    assert stats["stop_pairs_seen"] == (
        stats["pairs_accepted"] + stats["skipped_self_loop"] + stats["skipped_unknown_station"]
    )


def test_station_codes_are_normalised_before_joining():
    """schedules.json pads some codes; without stripping, the join loses rows."""
    records = [_stop("1", 1, " a "), _stop("1", 2, "B")]

    sections, _ = datameet.derive_corridor_sections(records, _fake_stations("A", "B"))

    assert set(sections) == {("A", "B")}


def test_great_circle_distance_matches_a_known_separation():
    """New Delhi to Ghaziabad is roughly 20 km apart in a straight line."""
    ndls = datameet.Station("NDLS", "New Delhi", "NR", None, None, 28.6425, 77.2207)
    gzb = datameet.Station("GZB", "Ghaziabad", "NR", None, None, 28.6667, 77.4333)

    assert datameet.great_circle_km(ndls, gzb) == pytest.approx(20.9, abs=1.5)


def test_great_circle_returns_none_without_coordinates():
    a = datameet.Station("A", "A", None, None, None, None, None)
    b = datameet.Station("B", "B", None, None, None, 28.0, 77.0)

    assert datameet.great_circle_km(a, b) is None


@pytest.mark.parametrize(
    ("zone_a", "zone_b", "expected_zone", "expected_all"),
    [
        ("NR", "NR", "NR", ["NR"]),
        ("NR", None, "NR", ["NR"]),          # one side blank -> use the known one
        (None, None, None, []),               # never invent a zone
        ("NR", "NCR", None, ["NCR", "NR"]),   # straddles two zones -> no single answer
    ],
)
def test_zone_resolution(zone_a, zone_b, expected_zone, expected_all):
    assert resolve_zone(zone_a, zone_b) == (expected_zone, expected_all)


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #

def _collect(records):
    """Group split_train_runs output as train -> list of station-code runs."""
    grouped: dict[str, list[list[str]]] = {}
    for train_number, run in datameet.split_train_runs(records):
        grouped.setdefault(train_number, []).append(
            [str(stop["station_code"]).strip().upper() for stop in run]
        )
    return grouped.items()


def _fake_stations(*codes):
    return {
        code: datameet.Station(code, code.title(), "NR", "Test State", None, 28.0, 77.0)
        for code in codes
    }
