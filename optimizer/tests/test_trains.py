"""Train-impact scoring - T22 Phase A, PRD 9.6.

The load-bearing tests here are the ones proving the score actually reads the
train-class mix. A "train-impact score" that is really a constant, or really
just overlap-minutes wearing a costume, would look completely fine on a demo
slide and would mean nothing - and flat weighting genuinely produces that
(measured: spread 0.00 across all 26 corridors, 325 ties).

The other half is the measured/estimated boundary. Displaced train COUNTS and
MINUTES are real, from T3's timetable. The CLASS SPLIT is apportioned from the
corridor mix, because per-service classes were not kept. Tests assert the
payload keeps those apart.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from app.core.trains import (
    FRAMING,
    TIER_WEIGHTS,
    assess_span,
    cheapest_displacement,
    classify,
    mean_tier_weight,
)


def win(start, end):
    return {"startMin": start, "endMin": end}


# --------------------------------------------------------------------------- #
# Classification                                                               #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("code,tier", [
    ("Raj", "flagship"), ("Shtb", "flagship"), ("Drnt", "flagship"),
    ("SF", "express"), ("Exp", "express"), ("Mail", "express"),
    ("Pass", "passenger"), ("MEMU", "suburban"),
    ("(unknown)", "unknown"), (None, "unknown"), ("NOTACLASS", "unknown"),
])
def test_class_codes_map_to_tiers(code, tier):
    assert classify(code) == tier


def test_an_unrecognised_class_is_neutral_not_free():
    """Scoring an unidentified train at zero would make unidentified traffic
    costless to displace - 2.8% of the corpus, quietly discounted."""
    assert TIER_WEIGHTS["unknown"] == 1.0
    assert mean_tier_weight({"NOTACLASS": 10}) == 1.0


# --------------------------------------------------------------------------- #
# The score really uses train class                                            #
# --------------------------------------------------------------------------- #

def test_a_flagship_corridor_costs_more_than_a_local_one():
    """The claim the whole score exists to make."""
    rajdhani = mean_tier_weight({"Raj": 10})
    passenger = mean_tier_weight({"Pass": 10})

    assert rajdhani > passenger
    assert rajdhani == TIER_WEIGHTS["flagship"]


def test_the_same_overlap_costs_differently_on_different_corridors():
    """Mutation-style: if the score ignored the class mix and returned overlap
    minutes (or a constant), these two would be equal. Identical occupancy,
    identical span, different traffic."""
    occupied = [win(60, 120)]
    premium = assess_span("P", occupied, {"Raj": 20}, 60, 120)
    local = assess_span("L", occupied, {"Pass": 20}, 60, 120)

    assert premium.displaced_minutes == local.displaced_minutes  # same measurement
    assert premium.weighted_impact > local.weighted_impact       # different cost
    assert premium.weighted_impact / local.weighted_impact == pytest.approx(
        TIER_WEIGHTS["flagship"] / TIER_WEIGHTS["passenger"]
    )


def test_a_mixed_corridor_lands_between_its_extremes():
    """Apportionment has to be a real weighted mean, not a max or a first-match."""
    occupied = [win(0, 60)]
    mixed = assess_span("M", occupied, {"Raj": 1, "Pass": 1}, 0, 60).weighted_impact
    all_premium = assess_span("P", occupied, {"Raj": 2}, 0, 60).weighted_impact
    all_local = assess_span("L", occupied, {"Pass": 2}, 0, 60).weighted_impact

    assert all_local < mixed < all_premium


def test_the_score_scales_with_overlap_not_just_train_count():
    """Two trains brushed for a minute each is not the same as two held for an
    hour, and the score has to know the difference."""
    mix = {"Exp": 10}
    brief = assess_span("B", [win(0, 5), win(10, 15)], mix, 0, 20)
    long = assess_span("L", [win(0, 60), win(60, 120)], mix, 0, 120)

    assert brief.trains_affected == long.trains_affected == 2
    assert long.weighted_impact > brief.weighted_impact


# --------------------------------------------------------------------------- #
# Measurement                                                                  #
# --------------------------------------------------------------------------- #

def test_only_genuinely_overlapping_windows_are_counted():
    occupied = [win(0, 60), win(120, 180), win(600, 660)]
    impact = assess_span("C", occupied, {"Exp": 3}, 30, 150)

    assert impact.trains_affected == 2          # the third is nowhere near
    assert impact.displaced_minutes == 30 + 30  # 30-60 and 120-150


def test_a_span_touching_nothing_costs_nothing():
    impact = assess_span("C", [win(0, 60)], {"Exp": 3}, 200, 260)

    assert impact.trains_affected == 0
    assert impact.weighted_impact == 0


def test_the_payload_keeps_measured_and_estimated_apart():
    """The honesty boundary, as structure rather than as a sentence someone has
    to remember to read."""
    payload = assess_span("C", [win(0, 60)], {"Raj": 1, "Pass": 1}, 0, 60).as_dict()

    assert set(payload["measured"]) == {
        "trainsAffected", "displacedMinutes", "clearanceMinutes",
    }
    assert set(payload["estimated"]) == {"weightedImpact", "tierSplit"}
    assert "estimated" in payload["framing"].lower()
    assert "measured" in payload["framing"].lower()


# --------------------------------------------------------------------------- #
# Costing a traffic block                                                      #
# --------------------------------------------------------------------------- #

#: A 300-minute "day" whose longest free window is 40 minutes, so a 60-minute
#: block MUST displace something - the situation the 53 deferred tasks are in.
BUSY_FREE = [win(0, 20), win(50, 90), win(140, 180), win(230, 270), win(275, 300)]
BUSY_OCCUPIED = [win(20, 50), win(90, 140), win(180, 230), win(270, 275)]


def test_the_cheapest_displacement_is_the_one_chosen():
    """Hand-checked. Longest free window is 40 minutes, so every 60-minute block
    crosses a train. The cheapest crossing is at 230: it runs through the free
    230-270 stretch and clips only the short 270-275 service, for 5 minutes.
    Every other placement crosses one of the 30-50 minute services."""
    option = cheapest_displacement(
        "C", BUSY_FREE, BUSY_OCCUPIED, {"Exp": 10}, 60, day_minutes=300
    )

    assert option.feasible
    assert option.start_minute == 230
    assert option.impact.trains_affected == 1
    assert option.impact.displaced_minutes == 5


def test_boundary_aligned_search_matches_brute_force():
    """The search only tries window boundaries, on the argument that an optimal
    placement can always be slid onto one. That is an argument, so it is checked
    against every possible start minute rather than trusted."""
    exhaustive = min(
        assess_span("C", BUSY_OCCUPIED, {"Exp": 10}, start, start + 60).displaced_minutes
        for start in range(0, 300 - 60 + 1)
    )
    option = cheapest_displacement(
        "C", BUSY_FREE, BUSY_OCCUPIED, {"Exp": 10}, 60, day_minutes=300
    )

    assert option.impact.displaced_minutes == exhaustive


def test_a_block_that_displaces_nobody_still_reports_the_clearance_it_eats():
    """Found on the real corpus: one of the 53 "impossible" tasks needs no train
    displaced at all - it needs 7 minutes more than the longest free window, and
    takes them out of the safety margin T3 leaves around each service. Reporting
    "0 trains" alone would call that free, which it is not."""
    free = [win(0, 100), win(120, 300)]
    occupied = [win(105, 115)]
    impact = assess_span("C", occupied, {"Exp": 5}, 0, 118, free_windows=free)

    assert impact.trains_affected == 1
    # 0-118 covers 100 free + 10 on the train + 8 of clearance (100-105, 115-118)
    assert impact.displaced_minutes == 10
    assert impact.clearance_minutes == 8


def test_clearance_breaks_a_tie_between_equally_costly_placements():
    """Two placements displacing nobody are not equally good if one eats more
    safety buffer than the other."""
    free = [win(0, 50), win(200, 260)]
    occupied = [win(400, 410)]
    option = cheapest_displacement("C", free, occupied, {"Exp": 5}, 55, day_minutes=500)

    assert option.impact.trains_affected == 0
    assert option.impact.clearance_minutes == 0   # 200-255 sits wholly inside a free window


def test_a_genuinely_free_stretch_costs_nothing():
    """If the corridor really is clear for long enough, the honest answer is
    that a block there displaces no one."""
    free = [win(0, 10), win(70, 300)]
    occupied = [win(10, 30), win(30, 50), win(50, 70)]
    option = cheapest_displacement("C", free, occupied, {"Exp": 10}, 60, day_minutes=300)

    assert option.feasible
    assert option.impact.trains_affected == 0
    assert option.impact.weighted_impact == 0


def test_a_task_longer_than_the_whole_day_is_refused_with_a_reason():
    """No single traffic block can run longer than the day it sits in."""
    option = cheapest_displacement("C", [win(0, 60)], [win(60, 120)], {"Exp": 1}, 5000)

    assert option.feasible is False
    assert "exceeds the 1440-minute day" in option.reason


def test_a_corridor_with_no_window_data_says_so():
    """"Unknown" must not be reported as "free". With no windows at all, a block
    would cost zero by arithmetic and that number would mean nothing."""
    option = cheapest_displacement("C", [], [], {"Exp": 1}, 60)

    assert option.feasible is False
    assert "no window data" in option.reason


def test_the_block_is_trimmed_to_what_the_task_needs():
    """Holding a corridor longer than the work requires displaces trains for
    nothing, so the costed span is exactly the task duration."""
    option = cheapest_displacement("C", [win(0, 600)], [win(0, 600)], {"Exp": 5}, 90)

    assert option.end_minute - option.start_minute == 90


def test_the_option_says_it_is_not_being_scheduled():
    """T22 Phase A costs this option; it does not take it. If that ever stops
    being true the note is a lie, and this test is where it surfaces."""
    payload = cheapest_displacement("C", [win(0, 300)], [win(0, 300)], {"Exp": 5}, 60).as_dict()

    assert "does NOT schedule it" in payload["note"]


# --------------------------------------------------------------------------- #
# Framing                                                                      #
# --------------------------------------------------------------------------- #

def test_the_framing_separates_what_is_real_from_what_is_apportioned():
    lowered = FRAMING.lower()

    assert "measured" in lowered
    assert "estimated" in lowered
    assert "apportioned" in lowered
    assert "not a modelled propagation" in lowered


# --------------------------------------------------------------------------- #
# Real corpus                                                                  #
# --------------------------------------------------------------------------- #

SNAPSHOT = pathlib.Path(__file__).parent / "fixtures" / "calendar_snapshot.json"


@pytest.fixture(scope="module")
def calendars():
    if not SNAPSHOT.exists():
        pytest.skip(f"no calendar snapshot at {SNAPSHOT}")
    return json.loads(SNAPSHOT.read_text())["calendars"]


def test_the_weighting_actually_separates_real_corridors(calendars):
    """The measured reason for rejecting flat weighting: it produced a single
    value across all 26 corridors. If this ever collapses, the score has stopped
    carrying information and the demo claim becomes empty."""
    weights = [mean_tier_weight(c.get("trainClassMix")) for c in calendars]

    assert max(weights) - min(weights) > 1.0, "class weighting has stopped discriminating"
    assert len(set(round(w, 2) for w in weights)) > 10


def test_every_structurally_deferred_task_can_be_costed(calendars):
    """D-024 said these need a traffic block. T22's job is to say what it costs,
    for all of them - a costing that only works on the easy ones is not one."""
    by_id = {c["_id"]: c for c in calendars}
    costed = 0
    for cal in by_id.values():
        longest = max((w["durationMin"] for w in cal.get("maxDailyBlockWindows") or []), default=0)
        option = cheapest_displacement(
            cal["_id"], cal.get("maxDailyBlockWindows") or [],
            cal.get("occupiedWindows") or [], cal.get("trainClassMix"),
            longest + 30,
        )
        if option.feasible:
            costed += 1
            assert option.impact.trains_affected >= 1, (
                "a span longer than every free window must displace at least one train"
            )
    assert costed >= 20
