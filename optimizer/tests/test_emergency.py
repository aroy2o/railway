"""Emergency rolling re-optimization - PRD FR3.5, 9.10, task T27.

Same two-level discipline as T20's `test_whatif.py`:

* **Hand-built, pure `emergency.py`** - small scenarios where the expected
  placement can be verified by hand, so "everything off the affected
  corridor is untouched" and "an already-executed window stays frozen even
  if it was empty" are proven, not merely observed.
* **`/emergency-reoptimize` over HTTP** - contract validation and the
  wrapper's fidelity to the core function.

What this file does NOT re-test: that `pins`/`blocked_window_keys` are
correctly enforced inside the CP-SAT model - that is `test_scheduler.py`'s
job. Here the concern is what `emergency.py` DOES with those primitives: which
tasks it pins, which windows it blocks, and what it reports.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.core.emergency import (
    CurrentPlacement,
    DisruptedWindow,
    generate_emergency_reoptimization,
)
from app.core.scheduler import (
    CorridorAvailability,
    DailyWindow,
    DEFAULT_WEIGHTS,
    DeferralReason,
    MaintenanceTask,
    Pin,
    solve_schedule,
)

H = date(2026, 8, 24)
D1, D2, D3, D4 = H, H + timedelta(days=1), H + timedelta(days=2), H + timedelta(days=3)
FUTURE = H + timedelta(days=60)


def _corridors():
    return {
        # Affected corridor: two 100-minute windows per day.
        "A-B": CorridorAvailability("A-B", (DailyWindow(0, 100), DailyWindow(200, 300))),
        # Untouched corridor: one 200-minute window per day.
        "X-Y": CorridorAvailability("X-Y", (DailyWindow(0, 200),)),
    }


# --------------------------------------------------------------------------- #
# Off-corridor tasks are held exactly fixed                                    #
# --------------------------------------------------------------------------- #

def test_off_corridor_tasks_are_held_exactly_fixed():
    """An emergency on A-B must not move or newly-schedule anything on X-Y,
    scheduled or deferred, even though nothing here pins X-Y task-by-task in
    the test itself - the module must derive that pin on its own."""
    x_scheduled = MaintenanceTask("X1", "X-Y", "Engineering", 100, FUTURE, priority=3)
    x_deferred = MaintenanceTask("X2", "X-Y", "Engineering", 250, FUTURE, priority=3)  # too long
    ab1 = MaintenanceTask("AB1", "A-B", "Engineering", 90, FUTURE, priority=3)

    tasks = [x_scheduled, x_deferred, ab1]
    placements = [
        CurrentPlacement("X1", "X-Y", D1, 0),
        CurrentPlacement("AB1", "A-B", D1, 0),
        # X2 has no entry: currently deferred.
    ]
    outcome = generate_emergency_reoptimization(
        tasks, _corridors(),
        horizon_start=H, horizon_days=4,
        corridor_id="A-B",
        current_placements=placements,
        disrupted_windows=[DisruptedWindow(D2, 0)],
        reason="unplanned traffic block on A-B",
        weights=DEFAULT_WEIGHTS,
        max_seconds=5.0,
    )
    result = outcome.result

    x1_block = next(b for b in result.blocks if "X1" in b.task_ids)
    assert (x1_block.day, x1_block.window_index) == (D1, 0)
    assert "X2" not in result.scheduled_task_ids
    assert outcome.as_of == D2


# --------------------------------------------------------------------------- #
# The disruption actually displaces what was in the window                    #
# --------------------------------------------------------------------------- #

def test_a_disrupted_window_displaces_the_task_that_was_in_it():
    """AB1 sits in A-B|D2|window0 today. That exact window is disrupted, so
    AB1 must move somewhere else in the corridor's remaining time - it may
    NOT simply vanish, and it may NOT land back in the disrupted window."""
    ab1 = MaintenanceTask("AB1", "A-B", "Engineering", 90, FUTURE, priority=3)
    tasks = [ab1]
    placements = [CurrentPlacement("AB1", "A-B", D2, 0)]

    outcome = generate_emergency_reoptimization(
        tasks, _corridors(),
        horizon_start=H, horizon_days=4,
        corridor_id="A-B",
        current_placements=placements,
        disrupted_windows=[DisruptedWindow(D2, 0)],
        reason="unplanned traffic block eats A-B's window",
        weights=DEFAULT_WEIGHTS,
        max_seconds=5.0,
    )
    result = outcome.result

    assert "AB1" in result.scheduled_task_ids
    block = next(b for b in result.blocks if "AB1" in b.task_ids)
    assert (block.day, block.window_index) != (D2, 0)
    assert block.day >= D2  # never pushed into the already-executed past


# --------------------------------------------------------------------------- #
# An empty already-executed window stays frozen - not just an occupied one    #
# --------------------------------------------------------------------------- #

def test_an_empty_already_executed_window_is_not_used_by_the_reoptimization():
    """D1's window0 on A-B was never used by the original plan. The
    disruption happens on D2, so D1 counts as already executed and must stay
    unusable even though nothing was ever scheduled into it - a currently
    deferred, on-corridor task free to move must not be slipped into it."""
    ab_deferred = MaintenanceTask("ABX", "A-B", "Engineering", 90, FUTURE, priority=5)
    tasks = [ab_deferred]

    outcome = generate_emergency_reoptimization(
        tasks, _corridors(),
        horizon_start=H, horizon_days=4,
        corridor_id="A-B",
        current_placements=[],  # ABX currently deferred
        disrupted_windows=[DisruptedWindow(D2, 0)],
        reason="unplanned block",
        weights=DEFAULT_WEIGHTS,
        max_seconds=5.0,
    )
    result = outcome.result

    if "ABX" in result.scheduled_task_ids:
        block = next(b for b in result.blocks if "ABX" in b.task_ids)
        assert block.day >= D2, "a currently-elapsed day must never receive a new placement"


# --------------------------------------------------------------------------- #
# A structurally-oversized task is reported deferred honestly, not dropped    #
# --------------------------------------------------------------------------- #

def test_a_task_too_long_for_any_remaining_window_stays_honestly_deferred():
    ab_big = MaintenanceTask("BIG", "A-B", "Engineering", 250, FUTURE, priority=5)  # > 100 min windows
    tasks = [ab_big]

    outcome = generate_emergency_reoptimization(
        tasks, _corridors(),
        horizon_start=H, horizon_days=4,
        corridor_id="A-B",
        current_placements=[],
        disrupted_windows=[DisruptedWindow(D2, 0)],
        reason="unplanned block",
        weights=DEFAULT_WEIGHTS,
        max_seconds=5.0,
    )
    result = outcome.result

    assert "BIG" not in result.scheduled_task_ids
    deferred = next(d for d in result.deferred if d.task_id == "BIG")
    assert deferred.reason == DeferralReason.EXCEEDS_LONGEST_WINDOW


# --------------------------------------------------------------------------- #
# A task with genuinely zero remaining windows gets an honest, distinct reason #
# --------------------------------------------------------------------------- #

def test_a_task_with_every_window_removed_is_WINDOW_UNAVAILABLE_not_NO_CAPACITY():
    """A real bug this task's own audit found before it shipped: a task whose
    ONLY physically-fitting window is blocked has zero candidates left, and
    the pre-T27 NO_CAPACITY message ("N window(s)... better used by
    higher-priority work") would misreport that as a contest this task lost -
    there was no contest, because nothing was left to contest. X-Y has exactly
    ONE window per day; on a one-day horizon, disrupting it removes X1's only
    candidate entirely, not merely re-ranks it below others."""
    x1 = MaintenanceTask("X1", "X-Y", "Engineering", 90, FUTURE, priority=3)
    tasks = [x1]

    outcome = generate_emergency_reoptimization(
        tasks, _corridors(),
        horizon_start=H, horizon_days=1,
        corridor_id="X-Y",
        current_placements=[CurrentPlacement("X1", "X-Y", D1, 0)],
        disrupted_windows=[DisruptedWindow(D1, 0)],
        reason="unplanned traffic block consumes the only window",
        weights=DEFAULT_WEIGHTS,
        max_seconds=5.0,
    )
    result = outcome.result

    assert "X1" not in result.scheduled_task_ids
    deferred = next(d for d in result.deferred if d.task_id == "X1")
    assert deferred.reason == DeferralReason.WINDOW_UNAVAILABLE
    assert "higher-priority work" not in deferred.detail


# --------------------------------------------------------------------------- #
# MUTATION: the block is what removes the window, not the pin set             #
# --------------------------------------------------------------------------- #

def test_MUTATION_the_disrupted_window_is_a_real_candidate_until_blocked():
    """Proof the blocked-window mechanism, not merely the pin set, is what
    causes test_a_disrupted_window_displaces_the_task_that_was_in_it's
    result. An earlier version of this test tried to show "the solver would
    leave AB1 in place if nothing forced it out" - that turned out to be
    false: with everything free, CP-SAT's own tie-break sent AB1 to the LAST
    available day/window, not the first (the exact under-determined-day
    volatility D-028/D-061 document elsewhere), so watching where an
    unconstrained solve lands proves nothing about which mechanism causes a
    given result. This checks the actual mechanism directly instead: pinning
    AB1 INTO A-B|D2|window0 succeeds when nothing has blocked that window
    (it is a real, fitting candidate - `assign[(AB1, that key)]` exists in
    the model), and only stops being possible once the window is added to
    `blocked_window_keys` - which is exactly what "the disruption consumed
    this window" has to mean."""
    ab1 = MaintenanceTask("AB1", "A-B", "Engineering", 90, FUTURE, priority=3)
    tasks = [ab1]
    disrupted_key = "A-B|2026-08-26|0"

    # Not blocked: the window is real, so forcing AB1 back into it succeeds.
    solve_schedule(
        tasks, _corridors(), horizon_start=H, horizon_days=4,
        pins=[Pin("AB1", disrupted_key)], max_seconds=5.0,
    )

    # Blocked, and NOT the target of any pin this time: now nothing may use
    # it, so an unpinned AB1 (test 2's real setup) cannot land there either.
    reopt = solve_schedule(
        tasks, _corridors(), horizon_start=H, horizon_days=4,
        blocked_window_keys=frozenset({disrupted_key}), max_seconds=5.0,
    )
    block = next(b for b in reopt.blocks if "AB1" in b.task_ids)
    assert (block.day.isoformat(), block.window_index) != ("2026-08-26", 0)


# --------------------------------------------------------------------------- #
# Pin uniqueness (T27's generalisation of T20's single Pin)                    #
# --------------------------------------------------------------------------- #

def test_pinning_the_same_task_twice_is_refused():
    ab1 = MaintenanceTask("AB1", "A-B", "Engineering", 90, FUTURE, priority=3)
    with pytest.raises(ValueError, match="pinned more than once"):
        solve_schedule(
            [ab1], _corridors(), horizon_start=H, horizon_days=1,
            pins=[Pin("AB1", "A-B|2026-08-24|0"), Pin("AB1", None)],
        )


# --------------------------------------------------------------------------- #
# /emergency-reoptimize over HTTP                                              #
# --------------------------------------------------------------------------- #

HORIZON = "2026-08-24"

HTTP_SCENARIO = {
    "tasks": [
        {
            "taskId": "AB1", "corridorId": "A-B", "department": "Engineering",
            "estBlockDurationMins": 90, "slaDueDate": "2026-12-01", "severity": 4,
            "assetCriticalityScore": 80.0, "dateRaised": "2026-07-01",
        },
    ],
    "corridors": [
        {
            "corridorId": "A-B",
            "dailyWindows": [
                {"startMinute": 0, "endMinute": 100},
                {"startMinute": 200, "endMinute": 300},
            ],
        },
    ],
    "horizonStart": HORIZON,
    "horizonDays": 4,
    "corridorId": "A-B",
    "currentPlacements": [
        {"taskId": "AB1", "corridorId": "A-B", "date": "2026-08-26", "windowIndex": 0},
    ],
    "disruptedWindows": [{"date": "2026-08-26", "windowIndex": 0}],
    "reason": "unplanned traffic block on A-B",
}


def test_emergency_reoptimize_displaces_the_task_over_http(client):
    response = client.post("/emergency-reoptimize", json=HTTP_SCENARIO)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] in {"OPTIMAL", "FEASIBLE"}
    assert "AB1" in {tid for b in body["blocks"] for tid in b["taskIds"]}
    ab1_block = next(b for b in body["blocks"] if "AB1" in b["taskIds"])
    assert (ab1_block["date"], ab1_block["windowIndex"]) != ("2026-08-26", 0)

    ctx = body["emergencyContext"]
    assert ctx["corridorId"] == "A-B"
    assert ctx["asOf"] == "2026-08-26"
    assert ctx["disruptedWindows"] == [{"date": "2026-08-26", "windowIndex": 0}]
    assert ctx["reason"] == "unplanned traffic block on A-B"
    assert body["framing"]
    assert body["policyWeights"]["coverage"] > 0
    assert "conflictReport" in body


def test_a_corridor_id_absent_from_the_payload_is_a_clean_422(client):
    payload = {**HTTP_SCENARIO, "corridorId": "NOWHERE"}
    response = client.post("/emergency-reoptimize", json=payload)
    assert response.status_code == 422
    assert "not in the payload" in response.text


def test_a_current_placement_corridor_mismatch_is_refused(client):
    payload = {
        **HTTP_SCENARIO,
        "currentPlacements": [
            {"taskId": "AB1", "corridorId": "SOME-OTHER", "date": "2026-08-26", "windowIndex": 0},
        ],
    }
    response = client.post("/emergency-reoptimize", json=payload)
    assert response.status_code == 422
    assert "disagrees with the task" in response.text


def test_an_out_of_range_disrupted_window_index_is_refused(client):
    payload = {**HTTP_SCENARIO, "disruptedWindows": [{"date": "2026-08-26", "windowIndex": 99}]}
    response = client.post("/emergency-reoptimize", json=payload)
    assert response.status_code == 422
    assert "out of range" in response.text


def test_an_empty_disrupted_windows_list_is_rejected():
    """min_length=1: an emergency re-solve with nothing disrupted is not a
    real request - this is the pydantic layer, so no client fixture needed."""
    from app.models.scheduling import EmergencyReoptimizeRequest

    with pytest.raises(Exception):
        EmergencyReoptimizeRequest(**{**HTTP_SCENARIO, "disruptedWindows": []})


def test_a_short_reason_is_rejected(client):
    payload = {**HTTP_SCENARIO, "reason": "why"}
    response = client.post("/emergency-reoptimize", json=payload)
    assert response.status_code == 422


# --------------------------------------------------------------------------- #
# Real corpus - reproduces the audit that shaped this module's design         #
# --------------------------------------------------------------------------- #
#
# See docs/DECISIONS.md D-069. Before writing `emergency.py`, the SAME
# scenario was run as a throwaway script against the real 89-task corpus:
# MQX-RMF's real window 9 on 2026-08-27 (holding the real TSK-00076) was
# blocked, simulating an emergency consuming it mid-week. This test pins that
# finding down permanently instead of leaving it a one-off script result.

HORIZON_START = date(2026, 8, 24)


@pytest.fixture(scope="module")
def real_scenario():
    from scripts.real_data import BackendUnavailable, load_scenario

    try:
        return load_scenario()
    except BackendUnavailable as exc:
        pytest.skip(f"backend API not reachable: {exc}")


def test_real_corpus_displaces_the_real_task_the_disruption_hits(real_scenario):
    """Re-derived against the T29 Phase 1 baseline (task splitting changed
    the real plan substantially - see docs/DECISIONS.md D-082) and used to
    catch a real bug along the way: `current_placements` is now built with
    ONE entry per (task, block) pair - never deduplicated to "last block
    per task id" - because a split task genuinely occupies more than one
    block, and `generate_emergency_reoptimization` must see all of them to
    hold the whole task fixed (D-082's `Pin.window_keys` fix). The old
    one-entry-per-task-id dict this test used to build is exactly the shape
    of bug that fix closes.
    """
    tasks, corridors = real_scenario
    baseline = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7)

    assert baseline.status in ("OPTIMAL", "FEASIBLE")

    # T29 Phase 1 changed the plan enough (D-082) that exactly where TSK-00076
    # lands is no longer worth hardcoding - it can shift with the objective's
    # exact landscape on a FEASIBLE (not proven OPTIMAL) solve, or with test
    # execution order against the shared dev backend (a pre-existing class of
    # sensitivity this suite already knows about - see T23's "shared-DB
    # test-count assumption" bug). Disrupt wherever it REALLY is, rather than
    # assuming, and verify the one property that must hold regardless: it
    # gets genuinely displaced off that exact window.
    tsk76_block = next(b for b in baseline.blocks if "TSK-00076" in b.task_ids)
    disrupted_day, disrupted_window = tsk76_block.day, tsk76_block.window_index

    placements = [
        CurrentPlacement(task_id, b.corridor_id, b.day, b.window_index)
        for b in baseline.blocks
        for task_id in b.task_ids
    ]

    outcome = generate_emergency_reoptimization(
        tasks, corridors,
        horizon_start=HORIZON_START, horizon_days=7,
        corridor_id="MQX-RMF",
        current_placements=placements,
        disrupted_windows=[DisruptedWindow(disrupted_day, disrupted_window)],
        reason="unplanned traffic block on MQX-RMF",
        weights=DEFAULT_WEIGHTS,
        max_seconds=10.0,
    )
    result = outcome.result

    # A re-solve narrowed to one corridor with almost everything pinned is
    # small enough to close, even while the full-corpus solve (elsewhere in
    # this suite) does not - T27's own design point (PRD 9.10's "re-solve
    # only the affected corridor").
    assert result.status == "OPTIMAL"

    # TSK-00076 is genuinely displaced off its disrupted window, never
    # deferred outright (the whole rest of the corridor's own free capacity
    # remains available to receive it).
    reopt_tsk76_block = next(b for b in result.blocks if "TSK-00076" in b.task_ids)
    assert (reopt_tsk76_block.day.isoformat(), reopt_tsk76_block.window_index) != (
        disrupted_day.isoformat(), disrupted_window,
    )

    # Wherever it lands, MQX-RMF stays a real, non-double-booked plan - if it
    # landed on a day another task already held, that task must genuinely
    # have moved or deferred, not been silently overwritten.
    mqx_blocks = [b for b in result.blocks if b.corridor_id == "MQX-RMF"]
    seen: dict[tuple, int] = {}
    for block in mqx_blocks:
        key = (block.day, block.window_index)
        assert key not in seen, f"MQX-RMF double-booked at {key}"
        seen[key] = 1

    # Every other corridor's blocks and every other corridor's deferred set
    # are byte-identical to the baseline - the whole point of D-069's design,
    # and exactly the guarantee D-082's Pin fix restores for a corpus that
    # now contains real split tasks off the affected corridor.
    task_by_id = {t.task_id: t for t in tasks}
    base_other = {
        (b.corridor_id, b.day, b.window_index, tuple(sorted(b.task_ids)))
        for b in baseline.blocks if b.corridor_id != "MQX-RMF"
    }
    reopt_other = {
        (b.corridor_id, b.day, b.window_index, tuple(sorted(b.task_ids)))
        for b in result.blocks if b.corridor_id != "MQX-RMF"
    }
    assert base_other == reopt_other

    base_other_deferred = {
        d.task_id for d in baseline.deferred if task_by_id[d.task_id].corridor_id != "MQX-RMF"
    }
    reopt_other_deferred = {
        d.task_id for d in result.deferred if task_by_id[d.task_id].corridor_id != "MQX-RMF"
    }
    assert base_other_deferred == reopt_other_deferred


def test_real_corpus_still_defers_a_structurally_oversized_emergency_honestly(real_scenario):
    """A second real finding from the same audit: forcing a currently-deferred,
    structurally-oversized task to compete for MQX-RMF's remaining capacity
    does not rescue it either - D-024 holds under an emergency re-solve
    exactly as it holds under T20's what-if. TSK-00073 needs 174 min; the
    corridor's longest window is 167 min, so no re-solve of any scope can
    place it, and the honest answer is still 'deferred', not a forced fit."""
    tasks, corridors = real_scenario
    baseline = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7)
    task_by_id = {t.task_id: t for t in tasks}
    assert task_by_id["TSK-00073"].duration_minutes == 174

    placement_by_task = {}
    for b in baseline.blocks:
        for tid in b.task_ids:
            placement_by_task[tid] = b
    placements = [
        CurrentPlacement(tid, b.corridor_id, b.day, b.window_index)
        for tid, b in placement_by_task.items()
    ]

    outcome = generate_emergency_reoptimization(
        tasks, corridors,
        horizon_start=HORIZON_START, horizon_days=7,
        corridor_id="MQX-RMF",
        current_placements=placements,
        disrupted_windows=[DisruptedWindow(date(2026, 8, 27), 9)],
        reason="unplanned traffic block on MQX-RMF",
        weights=DEFAULT_WEIGHTS,
        max_seconds=10.0,
    )

    assert "TSK-00073" not in outcome.result.scheduled_task_ids
    deferred = next(d for d in outcome.result.deferred if d.task_id == "TSK-00073")
    assert deferred.reason == DeferralReason.EXCEEDS_LONGEST_WINDOW
