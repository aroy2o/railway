"""Priority engine tests - PRD FR2.3 and FR2.4.

Same discipline as the solver tests: small enough to verify by hand, with the
arithmetic stated in the docstring so a passing test is evidence the formula is
right rather than merely that it ran.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.core.priority import (
    PRIORITY_WEIGHTS,
    PriorityInputs,
    rank_tasks,
    score_task,
    sla_breach,
    sla_urgency,
)

AS_OF = date(2026, 8, 24)
FAR = AS_OF + timedelta(days=90)


def make(task_id="T", severity=3, criticality=60.0, due_in_days=45, risk=None):
    return PriorityInputs(
        task_id=task_id,
        severity=severity,
        asset_criticality_score=criticality,
        sla_due_date=AS_OF + timedelta(days=due_in_days),
        as_of=AS_OF,
        failure_risk_score=risk,
    )


# --------------------------------------------------------------------------- #
# The formula                                                                  #
# --------------------------------------------------------------------------- #

def test_weights_sum_to_one():
    assert sum(PRIORITY_WEIGHTS.values()) == pytest.approx(1.0)


def test_score_is_hand_checkable():
    """severity 4/5=0.8, criticality 60/100=0.6, due in 45 days -> urgency
    (90-45)/90=0.5, not overdue -> breach 0.

    score = 100 x (0.35x0.8 + 0.30x0.6 + 0.20x0.5 + 0.15x0)
          = 100 x (0.28 + 0.18 + 0.10 + 0)  = 56.0
    """
    breakdown = score_task(make(severity=4, criticality=60.0, due_in_days=45))

    assert breakdown.score == pytest.approx(56.0)
    assert breakdown.contributions["severity"] == pytest.approx(28.0)
    assert breakdown.contributions["asset_criticality"] == pytest.approx(18.0)
    assert breakdown.contributions["sla_urgency"] == pytest.approx(10.0)
    assert breakdown.contributions["sla_breach"] == pytest.approx(0.0)


def test_contributions_always_sum_to_the_score():
    """FR2.4 - the breakdown has to reconcile, or it is not an explanation."""
    for severity in range(1, 6):
        for criticality in (27.92, 61.86, 90.75):
            for due in (-58, -1, 0, 7, 45, 86):
                breakdown = score_task(make(severity=severity, criticality=criticality,
                                            due_in_days=due))
                assert sum(breakdown.contributions.values()) == pytest.approx(breakdown.score)


def test_asset_criticality_separates_tasks_of_identical_severity():
    """The specific gap the severity placeholder left: on the real corpus
    severity and criticality are uncorrelated, and 1,057 task pairs tie on
    severity alone."""
    low = score_task(make("LOW", severity=3, criticality=27.92))
    high = score_task(make("HIGH", severity=3, criticality=90.75))

    assert high.score > low.score
    # 0.30 weight x (90.75-27.92)/100 x 100 = 18.85 points of separation.
    assert high.score - low.score == pytest.approx(18.85, abs=0.01)


def test_severity_outranks_asset_criticality_at_the_margin():
    """A deliberate ordering choice: the defect's own condition leads, because a
    rail fracture is more urgent than joint wear wherever it sits."""
    severe_on_dull = score_task(make(severity=5, criticality=30.0))
    mild_on_critical = score_task(make(severity=1, criticality=100.0))

    assert severe_on_dull.score > mild_on_critical.score


# --------------------------------------------------------------------------- #
# Overdue handling - the gap T6's D-020 left for T7                            #
# --------------------------------------------------------------------------- #

def test_an_overdue_task_outranks_an_identical_task_that_is_not_due():
    """SLA is soft in the solver, so the urgency of being late has to come from
    the priority score. 18 of the 89 real tasks are already past due."""
    fresh = score_task(make("FRESH", due_in_days=80))
    due_today = score_task(make("TODAY", due_in_days=0))
    overdue = score_task(make("LATE", due_in_days=-30))

    assert overdue.score > due_today.score > fresh.score
    assert overdue.is_overdue is True
    assert due_today.is_overdue is False


def test_being_more_overdue_ranks_higher_up_to_the_cap():
    scores = [score_task(make(due_in_days=-d)).score for d in (1, 15, 30, 60)]

    assert scores == sorted(scores), "further past due must not rank lower"
    # Saturates: past the cap, further lateness stops changing the ranking, so
    # an ancient trivial task cannot creep to the top of the queue by ageing.
    assert score_task(make(due_in_days=-60)).score == pytest.approx(
        score_task(make(due_in_days=-200)).score
    )


def test_a_badly_overdue_trivial_task_cannot_outrank_a_fresh_critical_one():
    """The check that sets the ceiling on the breach weight.

    Worst-case overdue trivia: severity 1, lowest criticality seen in the real
    corpus (27.92), 60 days late. Against a fresh critical job: severity 5,
    highest criticality (90.75), not due for 86 days.

    An SLA-dominant weighting (20/20/35/25) inverts this - measured at 69.58 vs
    39.71 - which is why the breach term is capped at 0.15.
    """
    trivial_but_late = score_task(make("LATE", severity=1, criticality=27.92, due_in_days=-60))
    critical_but_fresh = score_task(make("CRIT", severity=5, criticality=90.75, due_in_days=86))

    assert critical_but_fresh.score > trivial_but_late.score


@pytest.mark.parametrize(
    ("days_to_due", "expected"),
    [(90, 0.0), (45, 0.5), (0, 1.0), (-10, 1.0), (200, 0.0)],
)
def test_sla_urgency_ramp(days_to_due, expected):
    assert sla_urgency(days_to_due) == pytest.approx(expected)


@pytest.mark.parametrize(
    ("days_to_due", "expected"),
    [(5, 0.0), (0, 0.0), (-30, 0.5), (-60, 1.0), (-120, 1.0)],
)
def test_sla_breach_only_applies_past_the_due_date(days_to_due, expected):
    assert sla_breach(days_to_due) == pytest.approx(expected)


# --------------------------------------------------------------------------- #
# FR2.4 - the ranked queue and its breakdown                                   #
# --------------------------------------------------------------------------- #

def test_dominant_factor_is_the_largest_contribution_not_the_largest_component():
    """A raw component can be big while contributing little after weighting;
    FR2.4 asks which factor moved the score, so the weighted figure decides."""
    # urgency component is 1.0 (maximum) but weighted only 0.20 -> 20 points,
    # while severity 5 is weighted 0.35 -> 35 points.
    breakdown = score_task(make(severity=5, criticality=10.0, due_in_days=0))

    assert breakdown.components["sla_urgency"] == pytest.approx(1.0)
    assert breakdown.dominant_factor == "severity"


def test_ranked_queue_is_ordered_and_stable():
    tasks = [
        make("A", severity=1, criticality=30.0, due_in_days=80),
        make("B", severity=5, criticality=90.0, due_in_days=-10),
        make("C", severity=3, criticality=60.0, due_in_days=20),
    ]

    queue = rank_tasks(tasks)

    assert [b.task_id for b in queue] == ["B", "C", "A"]
    assert all(
        queue[i].score >= queue[i + 1].score for i in range(len(queue) - 1)
    )


def test_ties_break_on_task_id_so_the_queue_is_reproducible():
    """Matches the determinism the solver guarantees (D-022)."""
    identical = [make("Z"), make("A"), make("M")]

    assert [b.task_id for b in rank_tasks(identical)] == ["A", "M", "Z"]


def test_scoring_is_deterministic():
    inputs = make("T", severity=4, criticality=73.4, due_in_days=-12)

    first = score_task(inputs).as_dict()
    assert all(score_task(inputs).as_dict() == first for _ in range(5))


# --------------------------------------------------------------------------- #
# FR2.2 stays out until T16                                                    #
# --------------------------------------------------------------------------- #

def test_failure_risk_is_accepted_and_deliberately_unused():
    """Folding a fabricated risk number in to make the formula look complete is
    exactly what PRD 9.1 warns against. T16 owns this input."""
    without = score_task(make("T", risk=None))
    with_risk = score_task(make("T", risk=0.97))

    assert with_risk.score == without.score
    assert with_risk.uses_failure_risk is False


# --------------------------------------------------------------------------- #
# Solver interface                                                             #
# --------------------------------------------------------------------------- #

def test_solver_priority_is_a_positive_integer():
    """CP-SAT needs integer coefficients, and T6's coverage term multiplies by
    this. A zero would make a task worth nothing to schedule, so it is floored
    at 1 - every defect is worth doing."""
    lowest = score_task(make(severity=1, criticality=0.0, due_in_days=200))

    assert isinstance(lowest.solver_priority, int)
    assert lowest.solver_priority >= 1


def test_solver_priority_preserves_the_ranking():
    tasks = [
        make("A", severity=1, criticality=30.0, due_in_days=80),
        make("B", severity=5, criticality=90.0, due_in_days=-10),
    ]

    queue = rank_tasks(tasks)

    assert queue[0].solver_priority > queue[1].solver_priority
