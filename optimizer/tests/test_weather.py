"""Seasonal / monsoon risk flagging - T26, PRD 9.9.

Reporting only, mirroring T22 Phase A's tests: the load-bearing assertions
here are that the flag is real (comes from `CorridorAvailability`, never
invented) and that it never changes what the solver schedules - only what it
reports. See docs/DECISIONS.md D-068.
"""

from __future__ import annotations

from datetime import date, timedelta

from app.core.scheduler import (
    CorridorAvailability,
    DailyWindow,
    MaintenanceTask,
    solve_schedule,
)
from app.core.weather import detect_weather_risk, is_monsoon_window

HORIZON_START = date(2026, 8, 24)
FUTURE = HORIZON_START + timedelta(days=30)


# --------------------------------------------------------------------------- #
# is_monsoon_window - the real IMD calendar                                    #
# --------------------------------------------------------------------------- #

def test_the_reference_horizon_is_inside_the_real_monsoon_window():
    """A finding worth pinning: this project's own reference date sits inside
    the real IMD Southwest Monsoon season, so the feature is not academic on
    the actual demo horizon."""
    assert is_monsoon_window(HORIZON_START)


def test_onset_and_withdrawal_boundaries_are_inclusive():
    assert is_monsoon_window(date(2026, 6, 1))
    assert is_monsoon_window(date(2026, 10, 15))


def test_outside_the_window_is_false():
    assert not is_monsoon_window(date(2026, 5, 31))
    assert not is_monsoon_window(date(2026, 10, 16))
    assert not is_monsoon_window(date(2026, 1, 15))


# --------------------------------------------------------------------------- #
# detect_weather_risk                                                          #
# --------------------------------------------------------------------------- #

def test_a_flagged_corridor_scheduled_in_window_is_reported():
    blocks = [
        _block("XX-YY", date(2026, 8, 24)),
    ]
    corridors = {"XX-YY": CorridorAvailability("XX-YY", (), seasonal_risk_flag="monsoon-risk")}

    found = detect_weather_risk(blocks, corridors)

    assert len(found) == 1
    assert found[0]["corridorId"] == "XX-YY"
    assert found[0]["seasonalRiskFlag"] == "monsoon-risk"
    assert found[0]["taskIds"] == ["A"]


def test_an_unflagged_corridor_is_never_reported_even_in_window():
    for flag in (None, "none"):
        blocks = [_block("XX-YY", date(2026, 8, 24))]
        corridors = {"XX-YY": CorridorAvailability("XX-YY", (), seasonal_risk_flag=flag)}

        assert detect_weather_risk(blocks, corridors) == []


def test_a_flagged_corridor_outside_the_window_is_not_reported():
    blocks = [_block("XX-YY", date(2026, 1, 15))]
    corridors = {"XX-YY": CorridorAvailability("XX-YY", (), seasonal_risk_flag="monsoon-risk")}

    assert detect_weather_risk(blocks, corridors) == []


def test_a_corridor_with_no_scheduled_blocks_produces_nothing():
    assert detect_weather_risk([], {"XX-YY": CorridorAvailability("XX-YY", (), seasonal_risk_flag="monsoon-risk")}) == []


def _block(corridor_id: str, day: date):
    from app.core.scheduler import ScheduledBlock

    return ScheduledBlock(
        corridor_id=corridor_id, day=day, window_index=0,
        start_minute=0, end_minute=100, capacity_minutes=100, used_minutes=90,
        task_ids=["A"], departments=["Engineering"],
    )


# --------------------------------------------------------------------------- #
# Never touches the solve - the D-068 boundary, proven not just claimed        #
# --------------------------------------------------------------------------- #

def test_MUTATION_a_flagged_corridor_does_not_change_which_tasks_get_scheduled():
    """Proof this is reporting, not a constraint: solve the SAME scenario with
    and without the seasonal-risk flag set, and the plan must be identical
    down to every placement - flagging must never move a single task."""
    corridors_flagged = {
        "XX-YY": CorridorAvailability(
            "XX-YY", (DailyWindow(0, 300),), seasonal_risk_flag="monsoon-risk"
        )
    }
    corridors_unflagged = {"XX-YY": CorridorAvailability("XX-YY", (DailyWindow(0, 300),))}
    tasks = [
        MaintenanceTask("A", "XX-YY", "Engineering", 100, FUTURE, priority=3),
        MaintenanceTask("B", "XX-YY", "S&T", 80, FUTURE, priority=2),
    ]

    flagged = solve_schedule(tasks, corridors_flagged, horizon_start=HORIZON_START, horizon_days=1)
    unflagged = solve_schedule(
        tasks, corridors_unflagged, horizon_start=HORIZON_START, horizon_days=1
    )

    assert flagged.objective_value == unflagged.objective_value
    key = lambda blocks: sorted((b.as_dict() for b in blocks), key=lambda d: d["startMinute"])
    assert key(flagged.blocks) == key(unflagged.blocks)
    assert flagged.scheduled_task_ids == unflagged.scheduled_task_ids
    # And it DID report, so the mutation (removing the flag) is visible.
    assert flagged.known_gaps["weatherRisk"]["count"] == 1
    assert unflagged.known_gaps["weatherRisk"]["count"] == 0


def test_the_decision_log_carries_the_flag_for_a_reported_task_only():
    corridors = {
        "XX-YY": CorridorAvailability(
            "XX-YY", (DailyWindow(0, 300),), seasonal_risk_flag="monsoon-risk"
        )
    }
    tasks = [MaintenanceTask("A", "XX-YY", "Engineering", 100, FUTURE, priority=3)]

    result = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=1)

    entry = next(e for e in result.decision_log if e["taskId"] == "A")
    assert entry["weatherRisk"] == {"seasonalRiskFlag": "monsoon-risk", "inMonsoonWindow": True}
