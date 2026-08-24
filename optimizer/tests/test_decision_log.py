"""Decision-log completeness - T17, the foundation T18 is grounded in.

Every assertion here exists because of one failure mode: an explanation layer
stating something that is not true of the plan. PRD Section 18's rule is that
the LLM must never invent a number, but a number it did not invent can still be
wrong if the log handed it the wrong one. These tests are about the log being
right, so that rule has something sound to stand on.

The load-bearing case is `test_priority_score_is_the_real_score_not_the_rounded
_integer`. The log used to carry only `priority` - `round(score)` - while the
priority queue on screen shows the unrounded FR2.3 score. An explanation
sourced from the log would then quote a number that disagrees with the UI beside
it, which is exactly the kind of quiet wrongness that survives a demo.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.core.priority import PriorityInputs, score_task
from app.core.scheduler import (
    CorridorAvailability,
    DailyWindow,
    MaintenanceTask,
    solve_schedule,
)

H = date(2026, 8, 24)


def scored(task_id: str, severity: int, criticality: float, due: str):
    return score_task(
        PriorityInputs(task_id, severity, criticality, date.fromisoformat(due), H)
    )


def task(task_id, department, duration, *, severity=3, criticality=50.0,
         due="2026-12-01", corridor="A-B", **kwargs):
    breakdown = scored(task_id, severity, criticality, due)
    return MaintenanceTask(
        task_id, corridor, department, duration, date.fromisoformat(due),
        priority=breakdown.solver_priority, priority_is_placeholder=False,
        date_raised=date(2026, 7, 1), priority_breakdown=breakdown.as_dict(), **kwargs,
    )


def entry_for(result, task_id):
    return next(e for e in result.decision_log if e["taskId"] == task_id)


@pytest.fixture
def batched():
    """Two departments, one window wide enough for both - a real batch."""
    return solve_schedule(
        [task("E1", "Engineering", 100), task("S1", "S&T", 80)],
        {"A-B": CorridorAvailability("A-B", (DailyWindow(60, 300),))},
        horizon_start=H, horizon_days=1,
    )


# --------------------------------------------------------------------------- #
# Priority: the score, not a lossy stand-in for it                             #
# --------------------------------------------------------------------------- #

def test_priority_score_is_the_real_score_not_the_rounded_integer():
    """The log must carry the same number the priority queue shows.

    Criticality 71.2 is chosen because it scores 44.75, which the solver rounds
    UP to 45. Quoting the integer would therefore overstate the priority - and
    would do so in a plausible-looking way. A fixture whose score lands on a
    whole number would let the two agree by coincidence and hide the bug."""
    result = solve_schedule(
        [task("E1", "Engineering", 100, criticality=71.2)],
        {"A-B": CorridorAvailability("A-B", (DailyWindow(60, 300),))},
        horizon_start=H, horizon_days=1,
    )
    factors = entry_for(result, "E1")["contributingFactors"]
    expected = scored("E1", 3, 71.2, "2026-12-01")

    assert expected.score == 44.75 and expected.solver_priority == 45
    assert factors["priorityScore"] == 44.75
    assert factors["priority"] == 45


def test_every_entry_carries_the_fr24_breakdown(batched):
    for entry in batched.decision_log:
        breakdown = entry["contributingFactors"]["priorityBreakdown"]
        assert breakdown is not None
        assert set(breakdown["contributions"]) == {
            "severity", "asset_criticality", "sla_urgency", "sla_breach",
        }
        assert entry["contributingFactors"]["dominantPriorityFactor"] in breakdown["contributions"]


def test_contributions_sum_to_the_reported_score(batched):
    """If these disagree, an explanation could justify a score with figures that
    do not add up to it - true numbers assembled into a false claim."""
    for entry in batched.decision_log:
        factors = entry["contributingFactors"]
        assert sum(factors["priorityBreakdown"]["contributions"].values()) == pytest.approx(
            factors["priorityScore"], abs=0.02
        )


def test_a_task_with_no_t7_score_reports_null_rather_than_omitting_the_key():
    """"Not computed" must be distinguishable from "computed and unremarkable"."""
    result = solve_schedule(
        [MaintenanceTask("X1", "A-B", "Engineering", 60, date(2026, 12, 1), priority=3)],
        {"A-B": CorridorAvailability("A-B", (DailyWindow(60, 300),))},
        horizon_start=H, horizon_days=1,
    )
    factors = entry_for(result, "X1")["contributingFactors"]

    assert "priorityBreakdown" in factors
    assert factors["priorityBreakdown"] is None
    assert factors["priorityIsPlaceholder"] is True
    assert "priorityScore" not in factors


# --------------------------------------------------------------------------- #
# Why THIS window                                                              #
# --------------------------------------------------------------------------- #

def test_batching_is_recorded_on_both_participants(batched):
    e1 = entry_for(batched, "E1")["contributingFactors"]
    s1 = entry_for(batched, "S1")["contributingFactors"]

    assert e1["sharedWith"] == ["S1"] and s1["sharedWith"] == ["E1"]
    assert e1["isCrossDepartmentBatch"] is True
    assert s1["sharedWithDepartments"] == ["Engineering"]


def test_same_department_sharing_is_not_reported_as_a_cross_department_batch():
    """The batching claim is this project's headline differentiator. Two tasks
    from one department in one window is not it, and must not be labelled it."""
    result = solve_schedule(
        [task("E1", "Engineering", 100), task("E2", "Engineering", 80)],
        {"A-B": CorridorAvailability("A-B", (DailyWindow(60, 300),))},
        horizon_start=H, horizon_days=1,
    )
    factors = entry_for(result, "E1")["contributingFactors"]

    assert factors["sharedWith"] == ["E2"]
    assert factors["isCrossDepartmentBatch"] is False


def test_window_occupancy_is_reported_so_capacity_can_be_explained(batched):
    factors = entry_for(batched, "E1")["contributingFactors"]

    assert factors["windowCapacityMinutes"] == 240
    assert factors["windowUsedMinutes"] == 180  # both tasks, not just this one
    assert factors["eligibleWindowsConsidered"] >= 1


def test_deferred_entries_keep_their_reason_and_gain_the_eligible_count():
    """A task that cannot fit anywhere: the count is the evidence for the claim."""
    result = solve_schedule(
        [task("E1", "Engineering", 500)],
        {"A-B": CorridorAvailability("A-B", (DailyWindow(60, 300),))},
        horizon_start=H, horizon_days=1,
    )
    entry = entry_for(result, "E1")

    assert entry["decision"] == "deferred"
    assert entry["reason"] and entry["detail"]
    assert entry["contributingFactors"]["eligibleWindowsConsidered"] == 0


def test_department_is_on_every_entry(batched):
    assert {e["department"] for e in batched.decision_log} == {"Engineering", "S&T"}


# --------------------------------------------------------------------------- #
# Conflict cross-reference (T21)                                               #
# --------------------------------------------------------------------------- #

def test_conflict_types_match_the_conflict_report_exactly():
    """Two views of one fact. If they can disagree, an explanation can cite a
    conflict the conflict screen does not show, or miss one it does.

    T25 made resource conflicts a hard CP-SAT constraint, so a real solve can
    no longer produce one to exercise this cross-reference against (the same
    reason T24 did this for dependency violations) - `annotate_conflicts` is
    exercised directly against a hand-built `known_gaps`, decoupled from
    `solve_schedule`, matching the standalone-testability convention every
    core module here follows."""
    from app.core.scheduler import annotate_conflicts

    known_gaps = {
        "resourceConflicts": {
            "count": 1,
            "conflicts": [
                {
                    "taskIds": ["E1", "S1"],
                    "sharedResourceIds": ["RES-tamper"],
                    "date": "2026-08-24",
                    "corridorIds": ["A-B", "A-B"],
                    "corridorId": "A-B",
                    "departments": ["Engineering", "S&T"],
                    "overlapStart": "01:00",
                    "overlapEnd": "02:20",
                    "overlapMinutes": 80,
                }
            ],
        },
        "dependencyViolations": {"count": 0, "violations": []},
    }
    decision_log = [
        {"taskId": "E1", "decision": "scheduled"},
        {"taskId": "S1", "decision": "scheduled"},
        {"taskId": "T1", "decision": "deferred"},
    ]

    annotate_conflicts(decision_log, known_gaps)

    by_task = {entry["taskId"]: set(entry["conflictTypes"]) for entry in decision_log}
    assert by_task["E1"] == {"RESOURCE_CONTENTION"}
    assert by_task["S1"] == {"RESOURCE_CONTENTION"}
    assert by_task["T1"] == set()


def test_a_task_in_no_conflict_reports_an_empty_list_not_a_missing_key(batched):
    for entry in batched.decision_log:
        assert entry["conflictTypes"] == []


# --------------------------------------------------------------------------- #
# What the log deliberately does NOT claim                                     #
# --------------------------------------------------------------------------- #

def test_the_log_records_the_solver_not_the_current_plan(batched):
    """D-043: overrides live in their own log and the schedule is never mutated,
    so this log is "what the AI decided", not "what the plan is now". Nothing
    here may imply otherwise - joining the two is the grounding layer's job."""
    serialised = str(batched.decision_log)

    assert "override" not in serialised.lower()
