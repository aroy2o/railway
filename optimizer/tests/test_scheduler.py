"""CP-SAT scheduler tests - PRD Section 13 / FR3.

CLAUDE.md names this the single highest-risk component and testing priority #1,
so the scenarios here are small enough to verify BY HAND. Each one states the
arithmetic it expects in its docstring, which is what makes a passing test
evidence that the constraint model is right rather than merely that it ran.

The real-corpus test lives in test_scheduler_real_data.py and needs the API up;
everything here is self-contained.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.core.scheduler import (
    CorridorAvailability,
    DailyWindow,
    DeferralReason,
    MaintenanceTask,
    ObjectiveWeights,
    expand_windows,
    solve_schedule,
)

HORIZON_START = date(2026, 8, 24)
FUTURE = HORIZON_START + timedelta(days=30)


# --------------------------------------------------------------------------- #
# The hand-built scenario                                                      #
# --------------------------------------------------------------------------- #
#
# Two corridors:
#   AA-BB  one window 01:00-04:00  -> 180 minutes
#   CC-DD  one window 02:00-03:00  ->  60 minutes
#
# Four tasks:
#   T1  AA-BB  Engineering  100 min  priority 3
#   T2  AA-BB  S&T           60 min  priority 2
#   T3  AA-BB  Engineering  120 min  priority 5
#   T4  CC-DD  TRD           90 min  priority 4   <- longer than its only window
#
# On a ONE-day horizon the 180-minute window can hold:
#   {T3,T2} = 180 min exactly, priority 7   <- best
#   {T1,T2} = 160 min,         priority 5
#   {T3}    = 120 min,         priority 5
#   {T1,T3} = 220 min          -> violates capacity
# so the solver must choose {T3, T2}, defer T1 for capacity, and defer T4
# structurally. T3 and T2 are different departments, so that window is also a
# cross-department batch.

CORRIDORS = {
    "AA-BB": CorridorAvailability("AA-BB", (DailyWindow(60, 240),)),
    "CC-DD": CorridorAvailability("CC-DD", (DailyWindow(120, 180),)),
}

T1 = MaintenanceTask("T1", "AA-BB", "Engineering", 100, FUTURE, priority=3)
T2 = MaintenanceTask("T2", "AA-BB", "S&T", 60, FUTURE, priority=2)
T3 = MaintenanceTask("T3", "AA-BB", "Engineering", 120, FUTURE, priority=5)
T4 = MaintenanceTask("T4", "CC-DD", "TRD", 90, FUTURE, priority=4)

TASKS = [T1, T2, T3, T4]


@pytest.fixture(scope="module")
def one_day():
    return solve_schedule(TASKS, CORRIDORS, horizon_start=HORIZON_START, horizon_days=1)


# --------------------------------------------------------------------------- #
# Constraints actually hold                                                    #
# --------------------------------------------------------------------------- #

def test_solver_reaches_optimality_on_the_hand_built_case(one_day):
    assert one_day.status == "OPTIMAL"


def test_no_window_exceeds_its_capacity(one_day):
    """PRD Section 13: sum of assigned durations <= window length."""
    for block in one_day.blocks:
        assert block.used_minutes <= block.capacity_minutes, block.as_dict()


def test_the_solver_picks_the_highest_priority_feasible_packing(one_day):
    """Hand-checked: {T3,T2} fills 180/180 for priority 7 and beats every
    alternative packing of the same window."""
    scheduled = one_day.scheduled_task_ids

    assert scheduled == {"T2", "T3"}
    block = next(b for b in one_day.blocks if b.corridor_id == "AA-BB")
    assert block.used_minutes == 180
    assert block.unused_minutes == 0


def test_a_task_too_long_for_any_window_is_deferred_structurally(one_day):
    """T4 needs 90 minutes; its only window is 60. That is not a capacity
    contest, it is impossible, and the reason must say so."""
    deferral = next(d for d in one_day.deferred if d.task_id == "T4")

    assert deferral.reason == DeferralReason.EXCEEDS_LONGEST_WINDOW
    assert "90" in deferral.detail and "60" in deferral.detail
    # The reason must point at the real-world remedy, not just state failure.
    assert "traffic block" in deferral.detail


def test_a_task_that_lost_a_capacity_contest_says_so(one_day):
    """T1 could physically fit; it simply lost to higher-priority work."""
    deferral = next(d for d in one_day.deferred if d.task_id == "T1")

    assert deferral.reason == DeferralReason.NO_CAPACITY


def test_every_task_is_accounted_for(one_day):
    """FR3.3 - a task is never silently dropped."""
    accounted = one_day.scheduled_task_ids | {d.task_id for d in one_day.deferred}

    assert accounted == {task.task_id for task in TASKS}
    assert len(one_day.deferred) == 2
    for deferral in one_day.deferred:
        assert deferral.reason and deferral.detail


def test_cross_department_batching_actually_happens(one_day):
    """The headline capability: one possession serving two departments."""
    block = next(b for b in one_day.blocks if b.corridor_id == "AA-BB")

    assert block.is_cross_department_batch
    assert sorted(set(block.departments)) == ["Engineering", "S&T"]
    assert one_day.metrics()["crossDepartmentBatches"] == 1


def test_a_longer_horizon_fits_the_work_that_did_not_fit_in_one_day():
    """Same tasks, two days: the 180-minute window recurs, so T1 fits on day 2.

    This is also what proves the horizon expansion is real rather than cosmetic.
    """
    result = solve_schedule(TASKS, CORRIDORS, horizon_start=HORIZON_START, horizon_days=2)

    assert result.scheduled_task_ids == {"T1", "T2", "T3"}
    # T4 is still structurally impossible - a longer horizon cannot lengthen a
    # window.
    assert [d.task_id for d in result.deferred] == ["T4"]
    assert len({(b.day, b.corridor_id) for b in result.blocks}) == 2


# --------------------------------------------------------------------------- #
# SLA is soft, deliberately                                                    #
# --------------------------------------------------------------------------- #

def test_an_overdue_task_is_still_schedulable():
    """17 of the 89 real tasks are already past their SLA date.

    A hard deadline constraint would make overdue maintenance permanently
    unschedulable, which is exactly backwards. PRD 13.1 lists SLA compliance as
    an objective term, so it is a reward here, not a gate. See D-020.
    """
    overdue = MaintenanceTask(
        "OVERDUE", "AA-BB", "Engineering", 100, HORIZON_START - timedelta(days=40), priority=5
    )

    result = solve_schedule([overdue], CORRIDORS, horizon_start=HORIZON_START, horizon_days=1)

    assert result.scheduled_task_ids == {"OVERDUE"}
    entry = next(e for e in result.decision_log if e["taskId"] == "OVERDUE")
    # Scheduled, but honestly reported as outside SLA.
    assert entry["contributingFactors"]["withinSla"] is False


def test_sla_compliance_breaks_a_tie_between_equal_priority_tasks():
    """Two identical tasks, one window, one can go. The one whose deadline the
    window meets must win - that is the epsilon term doing its job."""
    within = MaintenanceTask("WITHIN", "AA-BB", "Engineering", 180, FUTURE, priority=3)
    outside = MaintenanceTask(
        "OUTSIDE", "AA-BB", "Engineering", 180, HORIZON_START - timedelta(days=1), priority=3
    )

    result = solve_schedule(
        [within, outside], CORRIDORS, horizon_start=HORIZON_START, horizon_days=1
    )

    assert result.scheduled_task_ids == {"WITHIN"}


# --------------------------------------------------------------------------- #
# Objective behaviour                                                          #
# --------------------------------------------------------------------------- #

def test_coverage_always_outranks_tidiness():
    """A low-priority task in a huge window wastes a lot of block time, and must
    still be scheduled: deferred maintenance is a safety cost, not untidiness.

    One 900-minute window, one 60-minute priority-1 task. Waste would be 840
    minutes plus a 500 fragmentation penalty - both must lose to the 10,000
    coverage reward.
    """
    corridors = {"XX-YY": CorridorAvailability("XX-YY", (DailyWindow(0, 900),))}
    task = MaintenanceTask("TINY", "XX-YY", "TRD", 60, FUTURE, priority=1)

    result = solve_schedule([task], corridors, horizon_start=HORIZON_START, horizon_days=1)

    assert result.scheduled_task_ids == {"TINY"}


def test_fragmentation_penalty_prefers_one_window_over_two():
    """Two tasks that fit together in one window should share it rather than
    take two separate possessions, when both options cover the same work."""
    corridors = {
        "XX-YY": CorridorAvailability("XX-YY", (DailyWindow(0, 200), DailyWindow(400, 600)))
    }
    tasks = [
        MaintenanceTask("A", "XX-YY", "Engineering", 100, FUTURE, priority=3),
        MaintenanceTask("B", "XX-YY", "Engineering", 100, FUTURE, priority=3),
    ]

    result = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=1)

    assert result.scheduled_task_ids == {"A", "B"}
    assert len(result.blocks) == 1, "should consolidate into a single possession"
    assert result.blocks[0].used_minutes == 200


def test_batching_reward_cannot_be_claimed_without_two_departments():
    """Guards the modelling trap: the batching flag is maximised, so without an
    upper bound tying it to genuinely distinct departments the solver would
    collect the reward for a single-department window."""
    corridors = {"XX-YY": CorridorAvailability("XX-YY", (DailyWindow(0, 300),))}
    tasks = [
        MaintenanceTask("A", "XX-YY", "Engineering", 100, FUTURE, priority=3),
        MaintenanceTask("B", "XX-YY", "Engineering", 100, FUTURE, priority=3),
    ]

    result = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=1)

    assert result.metrics()["crossDepartmentBatches"] == 0
    assert result.blocks[0].is_cross_department_batch is False


def test_weights_are_configurable_and_change_the_plan():
    """Sanity check for T23's policy sliders: the objective must actually be
    driven by the weights rather than hardcoded behaviour."""
    corridors = {"XX-YY": CorridorAvailability("XX-YY", (DailyWindow(0, 100),))}
    task = MaintenanceTask("A", "XX-YY", "Engineering", 60, FUTURE, priority=1)

    # Coverage worth nothing, waste ruinous -> scheduling is no longer worth it.
    starved = ObjectiveWeights(coverage=0, sla_compliance=0, batching=0,
                               unused_minute=100, fragmentation=100_000)
    result = solve_schedule(
        [task], corridors, horizon_start=HORIZON_START, horizon_days=1, weights=starved
    )

    assert result.scheduled_task_ids == set()
    assert result.deferred[0].reason == DeferralReason.NO_CAPACITY


# --------------------------------------------------------------------------- #
# Determinism                                                                  #
# --------------------------------------------------------------------------- #

def test_same_input_gives_byte_identical_output():
    """CP-SAT's parallel portfolio returns whichever optimal solution a worker
    finds first, so identical input can otherwise yield different (equally
    optimal) plans. A plan that changes when nothing changed is indefensible in
    a demo, hence one worker and a fixed seed (D-022).
    """
    runs = [
        solve_schedule(TASKS, CORRIDORS, horizon_start=HORIZON_START, horizon_days=3).as_dict()
        for _ in range(3)
    ]

    for run in runs[1:]:
        # Solve time legitimately varies; everything else must not.
        run["solveSeconds"] = runs[0]["solveSeconds"]
        assert run == runs[0]


# --------------------------------------------------------------------------- #
# Input validation                                                             #
# --------------------------------------------------------------------------- #

def test_a_low_confidence_corridor_is_refused():
    """T3 flagged these as untrusted and T4 excluded them from demand. Reaching
    one here means an upstream regression, and scheduling against untrusted
    occupancy is worse than failing loudly."""
    corridors = {
        "BAD-ONE": CorridorAvailability("BAD-ONE", (DailyWindow(0, 100),), low_confidence=True)
    }

    with pytest.raises(ValueError, match="lowConfidence"):
        expand_windows(corridors, HORIZON_START, 1)


def test_overlapping_windows_on_one_corridor_are_refused():
    """PRD Section 13 requires no overlap between windows on a corridor. T3
    guarantees it by emitting a merged complement, so this asserts the invariant
    rather than re-encoding it as a constraint."""
    corridors = {
        "BAD-TWO": CorridorAvailability("BAD-TWO", (DailyWindow(0, 100), DailyWindow(50, 200)))
    }

    with pytest.raises(ValueError, match="overlaps"):
        expand_windows(corridors, HORIZON_START, 1)


def test_horizon_expansion_replays_the_daily_pattern():
    windows = expand_windows(CORRIDORS, HORIZON_START, 7)

    # 2 corridors x 1 window each x 7 days.
    assert len(windows) == 14
    assert len({w.day for w in windows}) == 7
    assert all(w.duration_minutes > 0 for w in windows)


# --------------------------------------------------------------------------- #
# Known gaps are reported, not hidden                                          #
# --------------------------------------------------------------------------- #

def test_resource_conflicts_are_detected_and_reported():
    """Resource no-overlap is T25. Until then a conflict must be visible in the
    output rather than silently shipped as a valid-looking plan."""
    corridors = {"XX-YY": CorridorAvailability("XX-YY", (DailyWindow(0, 300),))}
    tasks = [
        MaintenanceTask("A", "XX-YY", "Engineering", 100, FUTURE, priority=3,
                        required_resource_ids=("RES-tamper",)),
        MaintenanceTask("B", "XX-YY", "Engineering", 100, FUTURE, priority=3,
                        required_resource_ids=("RES-tamper",)),
    ]

    result = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=1)

    gaps = result.known_gaps["resourceConflicts"]
    assert gaps["count"] == 1
    assert gaps["conflicts"][0]["sharedResourceIds"] == ["RES-tamper"]
    assert "T25" in gaps["note"]


def test_dependency_violations_are_detected_and_reported():
    """Precedence is T24. Same treatment: measured, not hidden."""
    corridors = {"XX-YY": CorridorAvailability("XX-YY", (DailyWindow(0, 300),))}
    tasks = [
        MaintenanceTask("STEP1", "XX-YY", "Engineering", 100, FUTURE, priority=1),
        MaintenanceTask("STEP2", "XX-YY", "Engineering", 100, FUTURE, priority=5,
                        depends_on_task_id="STEP1"),
    ]

    result = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=1)

    gaps = result.known_gaps["dependencyViolations"]
    assert "T24" in gaps["note"]
    assert isinstance(gaps["count"], int)


def test_decision_log_covers_every_task_with_factors(one_day):
    """T17 builds explanations on this, and PRD 18 forbids the LLM inventing
    numbers - so every figure it needs must already be here."""
    assert len(one_day.decision_log) == len(TASKS)

    for entry in one_day.decision_log:
        assert entry["decision"] in ("scheduled", "deferred")
        factors = entry["contributingFactors"]
        assert factors["priority"] >= 1
        # T6's priority is severity standing in for T7's real score, and the
        # log says so rather than letting a downstream reader assume otherwise.
        assert factors["priorityIsPlaceholder"] is True
        if entry["decision"] == "deferred":
            assert entry["reason"]


def test_an_eligible_but_empty_batching_window_does_not_break_the_model():
    """Regression: the batching reward must be free to be zero.

    Written unconditionally, `batched <= (departments used) - 1` forces
    `batched <= -1` on a batching-eligible window that ends up empty, which no
    boolean can satisfy - and the whole model returns INFEASIBLE. The hand-built
    scenarios all happened to fill their eligible windows, so this only surfaced
    on the real 89-task corpus.

    Here the corridor offers two windows and both departments could use either,
    so at least one eligible window is guaranteed to go unused.
    """
    corridors = {
        "XX-YY": CorridorAvailability("XX-YY", (DailyWindow(0, 600), DailyWindow(700, 1300)))
    }
    tasks = [
        MaintenanceTask("A", "XX-YY", "Engineering", 60, FUTURE, priority=3),
        MaintenanceTask("B", "XX-YY", "S&T", 60, FUTURE, priority=3),
    ]

    result = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=2)

    assert result.status == "OPTIMAL"
    assert result.scheduled_task_ids == {"A", "B"}
    # Four eligible window-instances exist; at most one is used, so three are
    # empty - exactly the case that used to make the model infeasible.
    assert len(result.blocks) == 1


def test_a_model_with_no_feasible_assignment_still_solves_to_all_deferred():
    """The all-deferred solution must always exist - deferral is an outcome, not
    an infeasibility (FR3.3)."""
    corridors = {"XX-YY": CorridorAvailability("XX-YY", (DailyWindow(0, 30),))}
    tasks = [MaintenanceTask("TOOBIG", "XX-YY", "TRD", 500, FUTURE, priority=5)]

    result = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=1)

    assert result.status in ("OPTIMAL", "FEASIBLE")
    assert result.scheduled_task_ids == set()
    assert result.deferred[0].reason == DeferralReason.EXCEEDS_LONGEST_WINDOW


def test_the_tightest_fitting_window_is_preferred():
    """The unused-minute term should steer work into the window that fits it.

    Opening a 1200-minute possession for a 100-minute job wastes 1100 minutes;
    the 150-minute window wastes 50. Both cover the same task, so the mu term
    decides - which is what stops the plan from burning a whole night's
    availability on a short job.
    """
    corridors = {
        "XX-YY": CorridorAvailability("XX-YY", (DailyWindow(0, 150), DailyWindow(200, 1400)))
    }
    task = MaintenanceTask("A", "XX-YY", "Engineering", 100, FUTURE, priority=3)

    result = solve_schedule([task], corridors, horizon_start=HORIZON_START, horizon_days=1)

    assert len(result.blocks) == 1
    assert result.blocks[0].capacity_minutes == 150
    assert result.blocks[0].unused_minutes == 50
