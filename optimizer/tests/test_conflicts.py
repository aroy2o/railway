"""The typed conflict taxonomy - implements PRD 9.5.

Two stages, matching the pattern the rest of this suite uses: hand-built cases
where the expected classification is obvious by inspection, then the real
corpus, where the numbers must match what T6/T8 already established.

The load-bearing test here is `test_summarise_never_totals_across_plans`. The
whole point of the `plan` discriminator is that baseline conflicts (the FR9.1
finding) and optimized-plan conflicts (gaps the solver does not yet close) are
different claims about different plans, and adding them produces a number that
misrepresents this system. That test is written to fail if anyone ever
flattens the structure - see D-045.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.core.baseline import run_baseline
from app.core.conflicts import (
    ConflictType,
    from_baseline_conflicts,
    from_known_gaps,
    summarise,
)
from app.core.scheduler import solve_schedule
from scripts.real_data import BackendUnavailable, load_scenario

HORIZON_START = date(2026, 8, 24)


def _resource_gap(departments: list[str]) -> dict:
    return {
        "resourceConflicts": {
            "count": 1,
            "conflicts": [
                {
                    "taskIds": ["TSK-A", "TSK-B"],
                    "sharedResourceIds": ["RES-tamper"],
                    "date": "2026-08-24",
                    "corridorId": "AAA-BBB",
                    "departments": departments,
                    "overlapStart": "02:00",
                    "overlapEnd": "03:00",
                    "overlapMinutes": 60,
                }
            ],
        },
        "dependencyViolations": {"count": 0, "violations": []},
    }


# --------------------------------------------------------------------------- #
# Classification                                                               #
# --------------------------------------------------------------------------- #

def test_resource_contention_within_one_department_staggers_rather_than_drops():
    """PRD 9.5's "only one proceeds" describes rival departments. One department
    double-booking its own gang is not a contest, so the strategy differs.
    T25 already enforces this in the solver, so `enforced_by` is None rather
    than naming a future task - the same treatment T24 gave dependency
    violations."""
    (conflict,) = from_known_gaps(_resource_gap(["Engineering", "Engineering"]))

    assert conflict.type == ConflictType.RESOURCE_CONTENTION
    assert conflict.plan == "optimized"
    assert conflict.resolution.strategy == "Stagger within the department"
    assert conflict.resolution.enforced_by is None
    assert conflict.as_dict()["sameDepartment"] is True


def test_resource_contention_across_departments_uses_the_prd_wording():
    (conflict,) = from_known_gaps(_resource_gap(["Engineering", "S&T"]))

    assert conflict.resolution.strategy == "Only one proceeds"
    assert conflict.as_dict()["sameDepartment"] is False


def test_dependency_violations_are_typed_with_no_further_enforcement_needed():
    """T24 already enforces this in the solver - `from_known_gaps` typing a
    violation here (a hand-fed one; a real solve can no longer produce one) is
    a defensive fallback, not a live gap, so `enforced_by` is None rather than
    naming a future task."""
    gaps = {
        "resourceConflicts": {"count": 0, "conflicts": []},
        "dependencyViolations": {
            "count": 1,
            "violations": [
                {
                    "taskId": "TSK-B",
                    "dependsOn": "TSK-A",
                    "issue": "scheduled before its prerequisite completes",
                    "corridorId": "AAA-BBB",
                    "date": "2026-08-24",
                    "departments": ["Engineering"],
                }
            ],
        },
    }

    (conflict,) = from_known_gaps(gaps)

    assert conflict.type == ConflictType.DEPENDENCY_ORDER_VIOLATION
    assert conflict.task_ids == ["TSK-B", "TSK-A"]
    assert conflict.resolution.enforced_by is None


def test_baseline_conflicts_are_typed_on_the_baseline_layer():
    payload = {
        "doubleBookings": [
            {
                "corridorId": "AAA-BBB",
                "date": "2026-08-24",
                "taskIds": ["TSK-A", "TSK-B"],
                "departments": ["S&T", "TRD"],
                "overlapStart": "04:00",
                "overlapEnd": "06:00",
                "overlapMinutes": 120,
            }
        ],
        "overSubscribedWindows": [
            {
                "corridorId": "AAA-BBB",
                "date": "2026-08-24",
                "windowIndex": 0,
                "departments": ["S&T", "TRD"],
                "capacityMinutes": 240,
                "claimedMinutes": 330,
                "excessMinutes": 90,
            }
        ],
    }

    double_booking, over_subscription = from_baseline_conflicts(payload)

    assert double_booking.type == ConflictType.CORRIDOR_DOUBLE_BOOKING
    assert over_subscription.type == ConflictType.WINDOW_OVER_SUBSCRIPTION
    assert {c.plan for c in (double_booking, over_subscription)} == {"baseline"}


def test_detail_lines_carry_the_real_figures_not_a_generic_label():
    """A demo claim needs the specific numbers, not "conflict detected"."""
    (conflict,) = from_baseline_conflicts(
        {
            "doubleBookings": [
                {
                    "corridorId": "AAA-BBB",
                    "date": "2026-08-24",
                    "taskIds": ["TSK-A", "TSK-B"],
                    "departments": ["S&T", "TRD"],
                    "overlapStart": "04:00",
                    "overlapEnd": "06:00",
                    "overlapMinutes": 120,
                }
            ],
            "overSubscribedWindows": [],
        }
    )

    assert "S&T and TRD" in conflict.detail
    assert "AAA-BBB" in conflict.detail
    assert "120 minutes" in conflict.detail


# --------------------------------------------------------------------------- #
# The separation that must hold (D-045)                                        #
# --------------------------------------------------------------------------- #

def test_summarise_never_totals_across_plans():
    """The adversarial case: 1 baseline conflict + 1 optimized conflict must
    never surface as "2 conflicts" anywhere in the payload. That number would
    read as an indictment of the optimized plan, half of it earned by the
    baseline it is being compared against."""
    mixed = from_known_gaps(_resource_gap(["Engineering", "Engineering"])) + from_baseline_conflicts(
        {
            "doubleBookings": [
                {
                    "corridorId": "AAA-BBB",
                    "date": "2026-08-24",
                    "taskIds": ["TSK-C", "TSK-D"],
                    "departments": ["S&T", "TRD"],
                    "overlapStart": "04:00",
                    "overlapEnd": "05:00",
                    "overlapMinutes": 60,
                }
            ],
            "overSubscribedWindows": [],
        }
    )

    summary = summarise(mixed)

    assert summary["byPlan"]["optimized"]["total"] == 1
    assert summary["byPlan"]["baseline"]["total"] == 1
    # No combined total anywhere: walk every integer in the summary shape and
    # assert none of them is the cross-plan sum presented as one figure.
    assert "total" not in summary
    assert set(summary["byPlan"]) == {"optimized", "baseline"}
    for bucket in summary["byPlan"].values():
        assert bucket["total"] == sum(bucket["byType"].values())


def test_every_conflict_carries_its_plan():
    """If a record ever loses `plan`, the UI cannot keep the layers apart."""
    summary = summarise(
        from_known_gaps(_resource_gap(["Engineering", "Engineering"]))
        + from_baseline_conflicts(
            {"doubleBookings": [], "overSubscribedWindows": [
                {
                    "corridorId": "AAA-BBB", "date": "2026-08-24", "windowIndex": 0,
                    "departments": ["S&T"], "capacityMinutes": 240,
                    "claimedMinutes": 300, "excessMinutes": 60,
                }
            ]}
        )
    )

    assert all(c["plan"] in {"optimized", "baseline"} for c in summary["conflicts"])


def test_train_impact_graduated_cleanly_and_is_not_listed_in_both_places():
    """T22 moved this type from "nothing checks" to "checked, none found".

    The transition has to be clean: a type reported as simultaneously
    undetectable AND clear is incoherent, and would let a reader take whichever
    reading suited them. It appears in exactly one list."""
    summary = summarise([])

    undetectable = {entry["type"] for entry in summary["notYetDetectable"]}
    clear = {entry["type"] for entry in summary["checkedAndClear"]}

    assert ConflictType.TRAIN_IMPACT_CONFLICT not in undetectable
    assert ConflictType.TRAIN_IMPACT_CONFLICT in clear
    # Still not a counted type when there are none - "checked and clear" is a
    # different statement from "0 occurrences" sitting in a count table.
    for bucket in summary["byPlan"].values():
        assert ConflictType.TRAIN_IMPACT_CONFLICT not in bucket["byType"]


def test_a_real_train_impact_conflict_is_counted_not_left_in_the_clear_list():
    """If one is ever found, it must move OUT of `checkedAndClear` into the
    counts - otherwise the payload would report a conflict and simultaneously
    report that none exist."""
    from app.core.conflicts import from_train_impact

    summary = summarise(from_train_impact([{
        "corridorId": "AAA-BBB", "date": "2026-08-24", "taskIds": ["TSK-A"],
        "departments": ["Engineering"], "trainsAffected": 3, "displacedMinutes": 22,
    }]))

    assert summary["byPlan"]["optimized"]["byType"][ConflictType.TRAIN_IMPACT_CONFLICT] == 1
    assert ConflictType.TRAIN_IMPACT_CONFLICT not in {
        entry["type"] for entry in summary["checkedAndClear"]
    }


def test_resolutions_are_labelled_not_claimed_to_be_applied():
    summary = summarise(from_known_gaps(_resource_gap(["Engineering", "Engineering"])))

    assert "classified, not applied" in summary["note"]


# --------------------------------------------------------------------------- #
# Real corpus                                                                  #
# --------------------------------------------------------------------------- #

@pytest.fixture(scope="module")
def scenario():
    try:
        return load_scenario()
    except BackendUnavailable as exc:
        pytest.skip(f"backend API not reachable: {exc}")


def test_real_corpus_types_match_the_counts_t6_and_t8_established(scenario):
    """T6-T23 established 11 resource + 5 dependency conflicts on the optimized
    side. T24 enforced dependency precedence (11 resource conflicts became 10,
    a side effect of the plan reflowing) and T25 now enforces resource
    no-overlap too, so the OPTIMIZED plan carries zero live conflicts of
    either type - both live in checkedAndClear instead. The baseline side is
    untouched: neither T8's algorithm nor this comparison have anything to do
    with what the optimizer now enforces, so 6 double-bookings + 3
    over-subscribed windows still come from T8."""
    tasks, corridors = scenario
    solved = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7)
    baseline = run_baseline(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7)

    optimized_summary = summarise(from_known_gaps(solved.as_dict()["knownGaps"]))
    baseline_summary = summarise(from_baseline_conflicts(baseline.as_dict()["conflicts"]))

    assert optimized_summary["byPlan"] == {}
    checked_types = {item["type"] for item in optimized_summary["checkedAndClear"]}
    assert checked_types == {
        ConflictType.TRAIN_IMPACT_CONFLICT,
        ConflictType.DEPENDENCY_ORDER_VIOLATION,
        ConflictType.RESOURCE_CONTENTION,
    }
    assert baseline_summary["byPlan"]["baseline"]["byType"] == {
        ConflictType.CORRIDOR_DOUBLE_BOOKING: 6,
        ConflictType.WINDOW_OVER_SUBSCRIPTION: 3,
    }


def test_the_optimized_plan_carries_no_resource_conflicts(scenario):
    """T25 made resource no-overlap a hard constraint, so a real solve can no
    longer produce one - this replaces the old detected-but-shipped-anyway
    check with the honest one: the type simply never appears."""
    tasks, corridors = scenario
    solved = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7)

    conflicts = [
        c for c in from_known_gaps(solved.as_dict()["knownGaps"])
        if c.type == ConflictType.RESOURCE_CONTENTION
    ]
    assert conflicts == []
    assert solved.known_gaps["resourceConflicts"]["count"] == 0


def test_the_baselines_own_resource_conflicts_are_all_same_department(scenario):
    """T4's resource catalogue is keyed by department, so a machine belongs to
    exactly one department and cross-department contention cannot occur by
    construction - true of the baseline's real conflicts too, computed by
    reusing the SAME detector against the baseline's own placements (the
    mechanism generalises; nothing baseline-specific was written for this).
    If this ever fails, the resource model changed and the "only one
    proceeds" branch has become reachable on real data."""
    from app.core.scheduler import WindowInstance, detect_known_gaps

    tasks, corridors = scenario
    baseline = run_baseline(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7)

    placements = {
        task_id: WindowInstance(
            f"{b.corridor_id}|{b.day.isoformat()}|{b.window_index}",
            b.corridor_id, b.day, b.window_index, b.start_minute, b.end_minute,
        )
        for b in baseline.blocks
        for task_id in b.task_ids
    }
    gaps = detect_known_gaps(tasks, placements)
    conflicts = [
        c for c in from_known_gaps(gaps) if c.type == ConflictType.RESOURCE_CONTENTION
    ]

    # D-067: the baseline commits this violation for real, unmonitored - a
    # much larger number than the (now zero) optimized side ever had.
    # `detect_known_gaps` caps the listed `conflicts` at 20 (same cap as the
    # real endpoint response), so the true count is asserted separately from
    # the capped list `from_known_gaps` was built from.
    assert gaps["resourceConflicts"]["count"] > 20
    assert conflicts, "expected the capped list to still carry real conflicts"
    assert all(c.as_dict()["sameDepartment"] for c in conflicts)
    assert all(c.resolution.strategy == "Stagger within the department" for c in conflicts)


def test_real_conflicts_all_carry_corridor_and_date(scenario):
    """T21's whole point: enough detail to render a row a Controller can act on.
    Before T21 the solver's entries carried no corridor and no time window.

    A resource conflict is the one legitimate exception to "a single
    corridorId": resources are depot-scoped across corridors (T21), so two
    tasks on DIFFERENT corridors can genuinely contend for one. `corridorId`
    is None there by design and `corridorIds` (both) carries the detail
    instead - T24's reflow surfaced the first real instance of this on the
    corpus, which is exactly the case this test must not paper over."""
    tasks, corridors = scenario
    solved = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7)

    for conflict in from_known_gaps(solved.as_dict()["knownGaps"]):
        if conflict.type == ConflictType.RESOURCE_CONTENTION and conflict.corridor_id is None:
            assert len(conflict.extra.get("corridorIds") or []) == 2, (
                "a cross-corridor resource conflict must still name both corridors"
            )
        else:
            assert conflict.corridor_id, f"{conflict.type} has no corridor"
        assert conflict.date, f"{conflict.type} has no date"
        assert conflict.departments, f"{conflict.type} has no department"
