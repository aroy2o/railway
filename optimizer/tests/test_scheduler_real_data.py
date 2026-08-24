"""The CP-SAT scheduler against the real seeded corpus.

CLAUDE.md's testing priority #1 is the solver in isolation, and
test_scheduler.py covers that with hand-checkable scenarios. This file is the
second stage: run the same model over the 89 real tasks and 30 real corridors
and assert the outcome matches what is already known about the data from T2-T4.

Requires the backend API, MongoDB and a completed `npm run seed`. Skips rather
than fails when the API is not up, so the suite stays green on a machine that
only has the Python service.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.core.scheduler import DeferralReason, solve_schedule
from scripts.real_data import BackendUnavailable, load_scenario

HORIZON_START = date(2026, 8, 24)


@pytest.fixture(scope="module")
def scenario():
    try:
        return load_scenario()
    except BackendUnavailable as exc:
        pytest.skip(f"backend API not reachable: {exc}")


@pytest.fixture(scope="module")
def result(scenario):
    tasks, corridors = scenario
    return solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7)


def test_the_real_corpus_is_the_expected_size(scenario):
    tasks, corridors = scenario

    assert len(tasks) == 89
    assert len(corridors) == 30


def test_the_model_solves_to_optimality(result):
    """Not merely feasible: the weekly model is small enough to close."""
    assert result.status == "OPTIMAL"


def test_solve_time_is_within_the_prd_budget(result):
    """PRD Section 7: a weekly-horizon solve must return in under 10 seconds for
    50-100 tasks. Measured with a single worker, which is the slower but
    reproducible configuration (D-022)."""
    assert result.solve_seconds < 10.0


def test_every_one_of_the_89_tasks_is_accounted_for(result, scenario):
    """FR3.3 - no task may silently disappear from the plan."""
    tasks, _ = scenario
    accounted = result.scheduled_task_ids | {d.task_id for d in result.deferred}

    assert accounted == {task.task_id for task in tasks}
    assert len(result.scheduled_task_ids) + len(result.deferred) == 89


def test_no_scheduled_block_exceeds_its_window(result):
    for block in result.blocks:
        assert block.used_minutes <= block.capacity_minutes, block.as_dict()
        assert block.task_ids, "an opened block must carry work"


def test_no_corridor_is_double_booked_at_the_same_time(result):
    """Windows on a corridor are disjoint by construction (T3), so two blocks on
    the same corridor and date must never overlap in clock time."""
    seen: dict[tuple[str, date], list[tuple[int, int]]] = {}

    for block in result.blocks:
        key = (block.corridor_id, block.day)
        for start, end in seen.get(key, []):
            assert block.end_minute <= start or block.start_minute >= end, (
                f"{block.corridor_id} double-booked on {block.day}"
            )
        seen.setdefault(key, []).append((block.start_minute, block.end_minute))


def test_saturated_gzb_sbb_is_deferred_not_over_packed(result, scenario):
    """The corridor this project knows best: 281 trains a day leave one
    54-minute window, and the backlog on it needs 580 minutes.

    The right behaviour is to schedule none of it and say why - over-packing a
    54-minute possession would be a scheduling bug wearing a green tick.
    """
    tasks, corridors = scenario
    gzb_tasks = [t for t in tasks if t.corridor_id == "GZB-SBB"]

    assert gzb_tasks, "expected the seeded GZB-SBB backlog"
    assert max(w.duration_minutes for w in corridors["GZB-SBB"].daily_windows) == 54
    assert sum(t.duration_minutes for t in gzb_tasks) > 500

    assert not [b for b in result.blocks if b.corridor_id == "GZB-SBB"]

    deferrals = {d.task_id: d for d in result.deferred}
    for task in gzb_tasks:
        assert deferrals[task.task_id].reason == DeferralReason.EXCEEDS_LONGEST_WINDOW


def test_deferrals_on_this_corpus_are_structural_not_contention(result):
    """A finding worth pinning: over a 7-day horizon nothing loses a capacity
    contest. Every deferral is a task longer than any gap its corridor offers,
    or (T24) a task whose PRD 9.7 prerequisite is itself unschedulable - never
    a task that lost a fair fight for space. TSK-00025 is the one real
    instance: its immediate prerequisite TSK-00024 is independently
    EXCEEDS_LONGEST_WINDOW, so TSK-00025 cascades to PREREQUISITE_UNSCHEDULABLE
    even though its own 169 minutes would fit BRMD-NIM's longest window fine.

    If this ever starts failing with NO_CAPACITY deferrals, the character of the
    problem has changed and the objective weights deserve a fresh look.
    """
    reasons = {d.reason for d in result.deferred}

    assert reasons == {
        DeferralReason.EXCEEDS_LONGEST_WINDOW,
        DeferralReason.PREREQUISITE_UNSCHEDULABLE,
    }
    cascaded = [d for d in result.deferred if d.reason == DeferralReason.PREREQUISITE_UNSCHEDULABLE]
    assert {d.task_id for d in cascaded} == {"TSK-00025"}


def test_scheduled_tasks_all_fit_the_window_they_were_given(result, scenario):
    tasks, _ = scenario
    by_id = {task.task_id: task for task in tasks}

    for block in result.blocks:
        for task_id in block.task_ids:
            assert by_id[task_id].duration_minutes <= block.capacity_minutes
            assert by_id[task_id].corridor_id == block.corridor_id


def test_cross_department_batching_occurs_on_the_real_data(result):
    """The headline capability has to actually fire on real input, not only in
    a constructed fixture."""
    batches = [b for b in result.blocks if b.is_cross_department_batch]

    assert batches, "expected at least one multi-department possession"
    for block in batches:
        assert len(set(block.departments)) > 1
        assert block.used_minutes <= block.capacity_minutes


def test_known_gaps_are_reported_with_counts(result):
    """Both T24 and T25 are now enforced (hard CP-SAT constraints, not
    detectors), so both counts must be zero - checked every solve, not
    merely assumed once and forgotten."""
    gaps = result.known_gaps

    assert "T25" in gaps["resourceConflicts"]["note"]
    assert "T24" in gaps["dependencyViolations"]["note"]
    assert gaps["resourceConflicts"]["count"] == 0
    assert gaps["dependencyViolations"]["count"] == 0


def test_the_real_solve_is_reproducible(scenario):
    """Same corpus, same plan - every time."""
    tasks, corridors = scenario

    first = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7).as_dict()
    second = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7).as_dict()

    second["solveSeconds"] = first["solveSeconds"]
    assert first == second


def test_decision_log_has_an_entry_per_task(result, scenario):
    tasks, _ = scenario

    assert len(result.decision_log) == len(tasks)


def test_the_priority_placeholder_flag_is_now_false(result):
    """T6 ran on raw severity and flagged every log entry
    `priorityIsPlaceholder: true`. T7 supplies the real FR2.3 score, so the flag
    must flip - it exists precisely so a downstream consumer can tell, and a
    stale `true` would be a lie in the other direction.
    """
    flags = {entry["contributingFactors"]["priorityIsPlaceholder"] for entry in result.decision_log}

    assert flags == {False}


def test_priorities_come_from_the_fr23_score_not_severity(scenario):
    """Severity is 1-5; the FR2.3 score is 0-100. If priorities were still
    severity, every value would sit in 1-5."""
    tasks, _ = scenario
    priorities = {task.priority for task in tasks}

    assert max(priorities) > 5, "priorities look like raw severity, not FR2.3 scores"
    assert min(priorities) >= 1
    # The placeholder left 1,057 tied pairs among 89 tasks; the real score should
    # be far more discriminating.
    assert len(priorities) > 20


def test_priority_wiring_does_not_change_which_tasks_are_scheduled(scenario):
    """A finding worth pinning rather than assuming.

    Swapping severity for the real FR2.3 score leaves the scheduled SET
    identical on this corpus. That is not the engine failing to work - it is a
    consequence of D-024: the few genuine capacity contests here are ones where
    both orderings agree on the winner, and every other deferral is structural.

    If this starts failing, contention has increased (a shorter horizon, more
    demand, or T22 opening up saturated corridors) and the priority engine has
    begun changing outcomes, not just reasoning. That is worth noticing.
    """
    from scripts.real_data import load_scenario

    tasks, corridors = scenario
    with_priority = solve_schedule(
        tasks, corridors, horizon_start=HORIZON_START, horizon_days=7
    ).scheduled_task_ids

    placeholder_tasks, placeholder_corridors = load_scenario(
        horizon_start=HORIZON_START, use_priority_engine=False
    )
    with_placeholder = solve_schedule(
        placeholder_tasks, placeholder_corridors, horizon_start=HORIZON_START, horizon_days=7
    ).scheduled_task_ids

    assert with_priority == with_placeholder
