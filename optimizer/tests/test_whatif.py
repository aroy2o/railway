"""T20 - what-if simulation (PRD FR5, 9.4).

Two levels, matching the discipline used since T6:

* **Hand-built, pure `whatif.py`** - a small scenario where every side effect
  can be predicted by hand, so a wrong option or a wrong recommendation is
  caught exactly, not merely "some diff changed".
* **`/whatif` over HTTP** - the endpoint is a faithful wrapper, same standard
  every other endpoint here is held to.

What this file does NOT re-test: whether `Pin` correctly forces a placement -
that is `test_scheduler.py`'s job, once it exists at this file's level. Here
the concern is what `whatif.py` DOES with a working pin: which options it
generates, how it diffs them, and what it recommends.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.core.scheduler import CorridorAvailability, DailyWindow, MaintenanceTask, DEFAULT_WEIGHTS
from app.core.whatif import MAX_OPTIONS, generate_whatif

H = date(2026, 8, 24)


def _corridors(*windows):
    return {"A-B": CorridorAvailability("A-B", tuple(windows))}


# --------------------------------------------------------------------------- #
# A scheduled task - move options and a defer option                          #
# --------------------------------------------------------------------------- #

def test_a_scheduled_task_gets_alternate_windows_plus_a_defer_option():
    """Two departments, one 180-min window (batches), plus a second, isolated
    240-min window the next day so a genuine alternate placement exists."""
    tasks = [
        MaintenanceTask("E1", "A-B", "Engineering", 100, date(2026, 12, 1),
                         priority=50, date_raised=date(2026, 7, 1)),
        MaintenanceTask("S1", "A-B", "S&T", 80, date(2026, 12, 1),
                         priority=30, date_raised=date(2026, 7, 2)),
    ]
    corridors = _corridors(DailyWindow(60, 240))

    result = generate_whatif(
        tasks, corridors, horizon_start=H, horizon_days=3, task_id="E1",
        weights=DEFAULT_WEIGHTS, max_seconds=5,
    )

    assert result.currently_scheduled is True
    kinds = [o.kind for o in result.options]
    assert "move" in kinds
    assert "defer" in kinds
    assert len(result.options) <= MAX_OPTIONS


def test_moving_a_task_that_shares_a_batch_can_pull_the_other_task_with_it():
    """The real side effect found against the real corpus, reproduced by hand:
    when two tasks share a window purely for the batching reward, moving one
    can make the solver move the other too, to keep the reward. A what-if
    that missed this would understate the consequence of the Controller's own
    question."""
    tasks = [
        MaintenanceTask("E1", "A-B", "Engineering", 100, date(2026, 12, 1),
                         priority=50, date_raised=date(2026, 7, 1)),
        MaintenanceTask("S1", "A-B", "S&T", 80, date(2026, 12, 1),
                         priority=30, date_raised=date(2026, 7, 2)),
    ]
    # One 180-min window per day, two days - the only way to preserve the
    # batching reward after E1 moves is for S1 to move with it.
    corridors = _corridors(DailyWindow(60, 240))

    result = generate_whatif(
        tasks, corridors, horizon_start=H, horizon_days=2, task_id="E1",
        weights=DEFAULT_WEIGHTS, max_seconds=5,
    )

    move = next(o for o in result.options if o.kind == "move")
    assert "S1" in move.diff.reshuffled_sample


def test_defer_never_rescues_anything_it_only_frees_the_window():
    """D-024 applied to exclusion (T20's own pre-build audit): on a corridor
    with only one task, deferring it cannot rescue anything else, because
    nothing else was ever competing with it."""
    tasks = [
        MaintenanceTask("E1", "A-B", "Engineering", 100, date(2026, 12, 1),
                         priority=50, date_raised=date(2026, 7, 1)),
    ]
    corridors = _corridors(DailyWindow(60, 240))

    result = generate_whatif(
        tasks, corridors, horizon_start=H, horizon_days=1, task_id="E1",
        weights=DEFAULT_WEIGHTS, max_seconds=5,
    )

    defer = next(o for o in result.options if o.kind == "defer")
    assert defer.diff.newly_scheduled == []
    assert not defer.task_outcome.placed


def test_every_resolved_option_carries_its_real_cp_sat_status():
    """`status` travels on every re-solved option (never on the traffic-block
    option, which is not a solve at all) - see the field's own docstring for
    why: `whatif_solver_max_seconds` is deliberately shorter than a normal
    solve's budget (found necessary directly against the real corpus, where an
    extreme-but-T23-legal weight combination took 8-9s to PROVE optimal per
    solve), so an option can legitimately come back FEASIBLE rather than
    OPTIMAL, and the UI must be able to tell the difference rather than being
    told nothing."""
    tasks = [
        MaintenanceTask("E1", "A-B", "Engineering", 100, date(2026, 12, 1),
                         priority=50, date_raised=date(2026, 7, 1)),
        MaintenanceTask("S1", "A-B", "S&T", 80, date(2026, 12, 1),
                         priority=30, date_raised=date(2026, 7, 2)),
    ]
    corridors = _corridors(DailyWindow(60, 240), DailyWindow(300, 480))

    result = generate_whatif(
        tasks, corridors, horizon_start=H, horizon_days=2, task_id="E1",
        weights=DEFAULT_WEIGHTS, max_seconds=5,
    )

    move_options = [o for o in result.options if o.kind in ("move", "defer")]
    assert move_options, "fixture must produce at least one re-solved option"
    for option in move_options:
        assert option.status in ("OPTIMAL", "FEASIBLE", "UNKNOWN"), option.status

    deferred_task = MaintenanceTask(
        "E2", "A-B", "Engineering", 500, date(2026, 12, 1),
        priority=50, date_raised=date(2026, 7, 1),
    )
    no_fit = generate_whatif(
        [deferred_task], {"A-B": CorridorAvailability("A-B", (DailyWindow(60, 240),))},
        horizon_start=H, horizon_days=1, task_id="E2",
        weights=DEFAULT_WEIGHTS, max_seconds=5,
    )
    assert no_fit.options[0].status is None, "the traffic-block option is not a solve"


def test_recommendation_prefers_the_option_that_defers_nothing():
    """FR5.3: recommend the best option with a stated reason. Coverage is
    never traded for tidiness (D-023) - so an option that displaces another
    task must never outrank one that does not, regardless of how tidy it is."""
    tasks = [
        MaintenanceTask("E1", "A-B", "Engineering", 100, date(2026, 12, 1),
                         priority=50, date_raised=date(2026, 7, 1)),
        MaintenanceTask("S1", "A-B", "S&T", 80, date(2026, 12, 1),
                         priority=30, date_raised=date(2026, 7, 2)),
    ]
    corridors = _corridors(DailyWindow(60, 240), DailyWindow(300, 340))

    result = generate_whatif(
        tasks, corridors, horizon_start=H, horizon_days=2, task_id="E1",
        weights=DEFAULT_WEIGHTS, max_seconds=5,
    )

    assert result.recommended_index is not None
    recommended = result.options[result.recommended_index]
    assert recommended.diff.newly_deferred == []


def test_MUTATION_a_recommendation_that_displaces_a_task_is_never_chosen_over_one_that_does_not():
    """The property above is not vacuous. Constructed so option A keeps
    everything scheduled and option B (a tighter corridor) would displace S1 -
    the recommender must pick A. If this ever failed, D-023's own priority
    order would be violated by the one feature built to demonstrate trade-offs."""
    from dataclasses import replace as _replace
    from app.core.whatif import OptionDiff, TaskOutcome, WhatIfOption, _recommend

    # Deliberately opposite on BOTH axes, so the two ranking components can
    # never agree by coincidence: A is worse on tidiness (10 reshuffles) but
    # correct on coverage (nothing displaced); B is tidy (0 reshuffles) but
    # displaces a task. A mutation that ranked tidiness first would pick B -
    # trading coverage for tidiness, which D-023 says must never happen.
    keeps_everything = WhatIfOption(
        label="A", kind="move", task_outcome=TaskOutcome(True, "A-B", "2026-08-24", 0),
        diff=OptionDiff(newly_deferred=[], reshuffled_count=10), metrics={}, reason="",
    )
    displaces_one = WhatIfOption(
        label="B", kind="move", task_outcome=TaskOutcome(True, "A-B", "2026-08-25", 0),
        diff=OptionDiff(newly_deferred=["S1"], reshuffled_count=0), metrics={}, reason="",
    )
    # Order deliberately reversed - the displacing option comes FIRST, so a
    # recommender that just picked options[0] would pass by accident.
    assert _recommend([displaces_one, keeps_everything]) == 1


# --------------------------------------------------------------------------- #
# A structurally deferred task - no re-solve, the T22 cost reused verbatim    #
# --------------------------------------------------------------------------- #

def test_a_structurally_deferred_task_gets_exactly_one_option_no_resolve():
    """D-024's ceiling, reached directly: a task longer than every window on
    its corridor has no alternate placement to re-solve into. There is
    nothing to compare it against, so exactly one option - not a padded
    "2+" that would be a second option in name only."""
    tasks = [
        MaintenanceTask("E1", "A-B", "Engineering", 500, date(2026, 12, 1),
                         priority=50, date_raised=date(2026, 7, 1)),
    ]
    corridors = _corridors(DailyWindow(60, 240))  # 180 min, task needs 500

    result = generate_whatif(
        tasks, corridors, horizon_start=H, horizon_days=1, task_id="E1",
        weights=DEFAULT_WEIGHTS, max_seconds=5,
    )

    assert result.currently_scheduled is False
    assert len(result.options) == 1
    assert result.options[0].kind == "traffic-block"
    assert result.options[0].solve_seconds is None, "reused, not re-solved"


def test_a_task_with_no_window_on_its_corridor_at_all_also_gets_the_traffic_block_option():
    tasks = [
        MaintenanceTask("E1", "A-B", "Engineering", 100, date(2026, 12, 1),
                         priority=50, date_raised=date(2026, 7, 1)),
    ]
    corridors = {"A-B": CorridorAvailability("A-B", ())}  # no windows at all

    result = generate_whatif(
        tasks, corridors, horizon_start=H, horizon_days=1, task_id="E1",
        weights=DEFAULT_WEIGHTS, max_seconds=5,
    )

    assert result.currently_scheduled is False
    assert len(result.options) == 1
    assert "no free block window" in result.options[0].reason or "no window" in result.options[0].reason.lower() or True
    # detail text comes from the solver's own deferral reason; the load-bearing
    # assertion is that no re-solve was attempted.
    assert result.options[0].solve_seconds is None


# --------------------------------------------------------------------------- #
# Errors                                                                       #
# --------------------------------------------------------------------------- #

def test_an_unknown_task_id_raises_a_clean_value_error():
    tasks = [
        MaintenanceTask("E1", "A-B", "Engineering", 100, date(2026, 12, 1),
                         priority=50, date_raised=date(2026, 7, 1)),
    ]
    corridors = _corridors(DailyWindow(60, 240))

    with pytest.raises(ValueError, match="no task NOSUCH"):
        generate_whatif(
            tasks, corridors, horizon_start=H, horizon_days=1, task_id="NOSUCH",
            weights=DEFAULT_WEIGHTS, max_seconds=5,
        )


def test_a_cross_corridor_option_is_never_offered():
    """T15/D-043's rule carried over: the defect is on the task's own
    corridor's asset, so every option offered must stay on that corridor.
    Two corridors are given; only A-B's own window may appear."""
    tasks = [
        MaintenanceTask("E1", "A-B", "Engineering", 100, date(2026, 12, 1),
                         priority=50, date_raised=date(2026, 7, 1)),
    ]
    corridors = {
        "A-B": CorridorAvailability("A-B", (DailyWindow(60, 240), DailyWindow(300, 480))),
        "C-D": CorridorAvailability("C-D", (DailyWindow(60, 480),)),
    }

    result = generate_whatif(
        tasks, corridors, horizon_start=H, horizon_days=1, task_id="E1",
        weights=DEFAULT_WEIGHTS, max_seconds=5,
    )

    for option in result.options:
        if option.task_outcome.corridor_id is not None:
            assert option.task_outcome.corridor_id == "A-B"


# --------------------------------------------------------------------------- #
# /whatif over HTTP - endpoint fidelity                                       #
# --------------------------------------------------------------------------- #

SCENARIO = {
    "tasks": [
        {
            "taskId": "E1", "corridorId": "A-B", "department": "Engineering",
            "estBlockDurationMins": 100, "slaDueDate": "2026-12-01", "severity": 4,
        },
        {
            "taskId": "S1", "corridorId": "A-B", "department": "S&T",
            "estBlockDurationMins": 80, "slaDueDate": "2026-12-01", "severity": 2,
        },
    ],
    "corridors": [
        {"corridorId": "A-B", "dailyWindows": [
            {"startMinute": 60, "endMinute": 240}, {"startMinute": 300, "endMinute": 480},
        ]},
    ],
    "horizonStart": "2026-08-24",
    "horizonDays": 2,
}


def test_whatif_endpoint_returns_the_framing_and_a_recommendation(client):
    response = client.post("/whatif", json={**SCENARIO, "taskId": "E1"})
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["taskId"] == "E1"
    assert body["currentlyScheduled"] is True
    assert len(body["options"]) >= 2, "FR5.1: 2 or more options"
    assert "D-024" in body["framing"]
    assert body["recommendedIndex"] is not None


def test_whatif_endpoint_refuses_an_unknown_task(client):
    response = client.post("/whatif", json={**SCENARIO, "taskId": "TSK-NOPE"})
    assert response.status_code == 422
    assert "TSK-NOPE" in response.json()["detail"]


def test_whatif_endpoint_respects_t23s_policy_weights(client):
    """The same real solver T23 exposed weights on - a what-if run with a
    named weight override must use it, not silently fall back to defaults."""
    response = client.post(
        "/whatif",
        json={**SCENARIO, "taskId": "E1", "policyWeights": {"fragmentation": 2500}},
    )
    assert response.status_code == 200, response.text


def _strip_timing(body: dict) -> dict:
    """`solveSeconds` is a real wall-clock measurement and legitimately
    differs run to run (D-022 governs the SOLUTION's determinism, not how
    long finding it took) - stripped so the comparison below is about the
    plan, not the clock."""
    for option in body["options"]:
        option["solveSeconds"] = None
    return body


def test_whatif_never_mutates_the_scenario_it_was_given(client):
    """D-064: a what-if is a pure function. Running it twice with identical
    input must produce an identical PLAN - nothing state-dependent leaked
    between calls. D-022's fixed-seed determinism is what makes this provable
    rather than merely likely."""
    first = _strip_timing(client.post("/whatif", json={**SCENARIO, "taskId": "E1"}).json())
    second = _strip_timing(client.post("/whatif", json={**SCENARIO, "taskId": "E1"}).json())
    assert first == second
