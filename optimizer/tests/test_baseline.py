"""Naive baseline tests - PRD FR9.1 / Section 12.

The baseline has to be *genuinely* worse in the way the problem statement
describes - uncoordinated, not merely badly written - so these tests assert the
specific failure modes rather than just a lower task count.

Hand-checkable throughout, same discipline as the solver tests.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.core.baseline import (
    DEPARTMENT_ORDER,
    run_baseline,
    structurally_contestable,
)
from app.core.scheduler import (
    CorridorAvailability,
    DailyWindow,
    DeferralReason,
    MaintenanceTask,
)

H = date(2026, 8, 24)
FAR = H + timedelta(days=90)


def task(task_id, corridor, department, duration, raised_offset=0, due=FAR, priority=50):
    return MaintenanceTask(
        task_id=task_id,
        corridor_id=corridor,
        department=department,
        duration_minutes=duration,
        sla_due_date=due,
        priority=priority,
        date_raised=H - timedelta(days=90 - raised_offset),
    )


# --------------------------------------------------------------------------- #
# The defining failure mode: uncoordinated double-booking                      #
# --------------------------------------------------------------------------- #

def test_two_departments_independently_claim_the_same_window():
    """One 180-minute window, two departments, neither aware of the other.

    Engineering runs first and takes 01:00-02:40 (100 min). S&T's pass starts
    from a clean view, so it also starts at 01:00 and runs to 02:30 (90 min).
    Overlap is 01:00-02:30 = 90 minutes, and the window is claimed for 190
    minutes of work it can only hold 180 of.
    """
    corridors = {"A-B": CorridorAvailability("A-B", (DailyWindow(60, 240),))}
    tasks = [
        task("E1", "A-B", "Engineering", 100),
        task("S1", "A-B", "S&T", 90),
    ]

    result = run_baseline(tasks, corridors, horizon_start=H, horizon_days=1)

    assert result.scheduled_task_ids == {"E1", "S1"}
    assert len(result.double_bookings) == 1

    conflict = result.double_bookings[0]
    assert set(conflict.task_ids) == {"E1", "S1"}
    assert set(conflict.departments) == {"Engineering", "S&T"}
    assert conflict.overlap_minutes == 90

    assert len(result.over_subscribed) == 1
    assert result.over_subscribed[0].claimed_minutes == 190
    assert result.over_subscribed[0].capacity_minutes == 180
    assert result.over_subscribed[0].excess_minutes == 10


def test_a_department_never_collides_with_itself():
    """The subtle half of the model: a department's own pass IS coordinated.

    The same office knows what it has already requested, so it packs its tasks
    back to back. Modelling it as globally blind would be a strawman - no
    planner double-books themselves. Only cross-department visibility is missing.
    """
    corridors = {"A-B": CorridorAvailability("A-B", (DailyWindow(0, 300),))}
    tasks = [
        task("E1", "A-B", "Engineering", 100, raised_offset=1),
        task("E2", "A-B", "Engineering", 100, raised_offset=2),
    ]

    result = run_baseline(tasks, corridors, horizon_start=H, horizon_days=1)

    assert result.scheduled_task_ids == {"E1", "E2"}
    assert result.double_bookings == []
    assert result.over_subscribed == []


def test_double_booked_minutes_are_reported_not_repaired():
    """PRD Section 12 wants the conflicts demonstrated. Silently resolving them
    would turn the baseline into a worse optimizer and prove nothing."""
    corridors = {"A-B": CorridorAvailability("A-B", (DailyWindow(0, 120),))}
    tasks = [
        task("E1", "A-B", "Engineering", 120),
        task("S1", "A-B", "S&T", 120),
        task("T1", "A-B", "TRD", 120),
    ]

    result = run_baseline(tasks, corridors, horizon_start=H, horizon_days=1)

    # All three placed, all three on top of each other: 3 pairwise collisions.
    assert len(result.scheduled_task_ids) == 3
    assert len(result.double_bookings) == 3
    assert result.metrics()["doubleBookedMinutes"] == 360
    assert result.over_subscribed[0].excess_minutes == 240


# --------------------------------------------------------------------------- #
# Batching is unreachable, by construction                                     #
# --------------------------------------------------------------------------- #

def test_baseline_can_never_batch():
    """An invariant, not an observation.

    A block is built per department per window, so a possession never carries
    two departments. This is the capability the coordinated optimizer adds, and
    asserting it here is what makes the T14 comparison meaningful.
    """
    corridors = {
        "A-B": CorridorAvailability("A-B", (DailyWindow(0, 600), DailyWindow(700, 1300)))
    }
    tasks = [
        task("E1", "A-B", "Engineering", 100),
        task("S1", "A-B", "S&T", 100),
        task("T1", "A-B", "TRD", 100),
    ]

    result = run_baseline(tasks, corridors, horizon_start=H, horizon_days=3)

    assert result.metrics()["crossDepartmentBatches"] == 0
    for block in result.blocks:
        assert len(set(block.departments)) == 1
        assert block.is_cross_department_batch is False


# --------------------------------------------------------------------------- #
# Ordering rule                                                                #
# --------------------------------------------------------------------------- #

def test_first_come_first_served_uses_arrival_order():
    """The earlier-raised task gets the only slot."""
    corridors = {"A-B": CorridorAvailability("A-B", (DailyWindow(0, 100),))}
    early = task("LATE_ID", "A-B", "Engineering", 100, raised_offset=1)
    late = task("EARLY_ID", "A-B", "Engineering", 100, raised_offset=50)

    result = run_baseline([late, early], corridors, horizon_start=H, horizon_days=1)

    # Raised first wins, despite sorting later by id.
    assert result.scheduled_task_ids == {"LATE_ID"}


def test_ordering_is_not_earliest_deadline_first():
    """Guards against quietly upgrading the baseline into a good heuristic.

    The task raised first wins even though the other is due much sooner. EDF is
    a genuinely effective rule, and using it would flatter the baseline and
    understate the optimizer's advantage.
    """
    corridors = {"A-B": CorridorAvailability("A-B", (DailyWindow(0, 100),))}
    raised_first_due_later = task("A", "A-B", "Engineering", 100, raised_offset=1, due=FAR)
    raised_later_due_soon = task(
        "B", "A-B", "Engineering", 100, raised_offset=60, due=H + timedelta(days=1)
    )

    result = run_baseline(
        [raised_first_due_later, raised_later_due_soon], corridors, horizon_start=H, horizon_days=1
    )

    assert result.scheduled_task_ids == {"A"}


def test_department_order_gives_the_first_department_first_pick():
    """A positional advantage the coordinated optimizer removes."""
    corridors = {"A-B": CorridorAvailability("A-B", (DailyWindow(0, 100),))}
    tasks = [task("E1", "A-B", "Engineering", 100), task("S1", "A-B", "S&T", 100)]

    forward = run_baseline(tasks, corridors, horizon_start=H, horizon_days=1)
    reversed_order = run_baseline(
        tasks, corridors, horizon_start=H, horizon_days=1,
        department_order=("S&T", "Engineering", "TRD"),
    )

    # Both still claim the window - neither can see the other - so the conflict
    # is order-independent even though the block ordering is not.
    assert len(forward.double_bookings) == len(reversed_order.double_bookings) == 1


# --------------------------------------------------------------------------- #
# Shared structural reality (D-024)                                            #
# --------------------------------------------------------------------------- #

def test_impossible_tasks_are_impossible_for_the_baseline_too():
    """A task longer than every window is a fact about the corridor, not about
    which algorithm reads it. Same reason code as the optimizer."""
    corridors = {"A-B": CorridorAvailability("A-B", (DailyWindow(0, 60),))}
    tasks = [task("BIG", "A-B", "Engineering", 200)]

    result = run_baseline(tasks, corridors, horizon_start=H, horizon_days=7)

    assert result.scheduled_task_ids == set()
    assert result.deferred[0].reason == DeferralReason.EXCEEDS_LONGEST_WINDOW
    assert "any algorithm" in result.deferred[0].detail


def test_structurally_contestable_identifies_the_fair_comparison_set():
    corridors = {
        "A-B": CorridorAvailability("A-B", (DailyWindow(0, 100),)),
        "C-D": CorridorAvailability("C-D", ()),
    }
    tasks = [
        task("FITS", "A-B", "Engineering", 90),
        task("TOOBIG", "A-B", "Engineering", 200),
        task("NOWINDOW", "C-D", "S&T", 30),
    ]

    assert structurally_contestable(tasks, corridors) == {"FITS"}


def test_every_task_is_accounted_for():
    """Same FR3.3 invariant the optimizer holds itself to."""
    corridors = {"A-B": CorridorAvailability("A-B", (DailyWindow(0, 150),))}
    tasks = [
        task("E1", "A-B", "Engineering", 100),
        task("E2", "A-B", "Engineering", 100),
        task("BIG", "A-B", "TRD", 400),
    ]

    result = run_baseline(tasks, corridors, horizon_start=H, horizon_days=1)
    accounted = result.scheduled_task_ids | {d.task_id for d in result.deferred}

    assert accounted == {"E1", "E2", "BIG"}
    for deferral in result.deferred:
        assert deferral.reason and deferral.detail


def test_a_department_exhausting_its_own_windows_says_so():
    corridors = {"A-B": CorridorAvailability("A-B", (DailyWindow(0, 150),))}
    tasks = [
        task("E1", "A-B", "Engineering", 100, raised_offset=1),
        task("E2", "A-B", "Engineering", 100, raised_offset=2),
    ]

    result = run_baseline(tasks, corridors, horizon_start=H, horizon_days=1)

    deferral = next(d for d in result.deferred if d.task_id == "E2")
    assert deferral.reason == DeferralReason.NO_CAPACITY
    assert "no visibility of other departments" in deferral.detail


# --------------------------------------------------------------------------- #
# Determinism and reporting                                                    #
# --------------------------------------------------------------------------- #

def test_baseline_is_reproducible():
    corridors = {
        "A-B": CorridorAvailability("A-B", (DailyWindow(0, 200), DailyWindow(400, 700)))
    }
    tasks = [
        task("E1", "A-B", "Engineering", 100, raised_offset=1),
        task("S1", "A-B", "S&T", 150, raised_offset=2),
        task("T1", "A-B", "TRD", 120, raised_offset=3),
    ]

    runs = [run_baseline(tasks, corridors, horizon_start=H, horizon_days=2).as_dict() for _ in range(3)]

    for run in runs[1:]:
        assert run == runs[0]


def test_utilisation_can_exceed_one_hundred_percent():
    """Over-subscription must show through the metric rather than be smoothed
    away - a plausible-looking 95% would hide the whole point."""
    corridors = {"A-B": CorridorAvailability("A-B", (DailyWindow(0, 100),))}
    tasks = [task("E1", "A-B", "Engineering", 100), task("S1", "A-B", "S&T", 100)]

    result = run_baseline(tasks, corridors, horizon_start=H, horizon_days=1)

    assert result.metrics()["blockUtilisationPct"] == 200.0
    assert result.metrics()["distinctWindowsClaimed"] == 1
    assert result.metrics()["blocksUsed"] == 2


def test_decision_log_records_the_blindness(scenario_free=None):
    corridors = {"A-B": CorridorAvailability("A-B", (DailyWindow(0, 200),))}
    tasks = [task("E1", "A-B", "Engineering", 100)]

    result = run_baseline(tasks, corridors, horizon_start=H, horizon_days=1)

    entry = result.decision_log[0]
    assert entry["contributingFactors"]["sawOtherDepartments"] is False
    assert "first-come-first-served" in entry["contributingFactors"]["orderingRule"]


def test_department_order_constant_covers_all_three():
    assert set(DEPARTMENT_ORDER) == {"Engineering", "S&T", "TRD"}
