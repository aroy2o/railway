"""The real corpus, through the real endpoints - T9's actual proof.

T6, T7 and T8 validated the solver, priority engine and baseline by calling the
functions directly. The value of T9 is making that proven logic reachable over
HTTP, so the test that matters is the same corpus producing the same numbers
through the endpoints rather than each endpoint returning something plausible
against a small fixture.

Needs the backend API, MongoDB and `npm run seed`. Skips otherwise.
"""

from __future__ import annotations

from datetime import date

import pytest

from scripts.real_data import BackendUnavailable, build_payload

HORIZON_START = date(2026, 8, 24)


@pytest.fixture(scope="module")
def payload():
    try:
        return build_payload(horizon_start=HORIZON_START, horizon_days=7)
    except BackendUnavailable as exc:
        pytest.skip(f"backend API not reachable: {exc}")


@pytest.fixture(scope="module")
def optimized(client, payload):
    response = client.post("/optimize", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="module")
def naive(client, payload):
    response = client.post("/baseline", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_the_payload_is_the_real_corpus(payload):
    assert len(payload["tasks"]) == 89
    assert len(payload["corridors"]) == 30
    # The joins Node is responsible for must all be present.
    assert all(task["assetCriticalityScore"] is not None for task in payload["tasks"])
    assert all(task["dateRaised"] for task in payload["tasks"])


def test_optimize_reproduces_the_t29_numbers_over_http(optimized):
    """64 scheduled / 25 deferred, FEASIBLE, inside PRD Section 7's 10s budget.

    T6-T23 reproduced 36/53. T24 moved it to 35/54 (TSK-00025 correctly
    cascades to PREREQUISITE_UNSCHEDULABLE - see docs/DECISIONS.md). T29
    Phase 1 moves it again, for a real and much larger reason: 29 of the 53
    previously-structural tasks are now placeable by splitting their work
    across non-contiguous windows, so tasksScheduled jumps from 35 to 64.

    The status is FEASIBLE, not OPTIMAL, and that is reported honestly
    rather than hidden - splitting made this a genuinely harder CP-SAT
    instance that the 10s budget no longer always closes. Reproducible all
    the same (D-022's guarantee still holds - see
    `test_endpoints_are_deterministic_over_http`), which is the property
    that actually matters for a live demo.
    """
    metrics = optimized["metrics"]

    assert optimized["status"] in ("OPTIMAL", "FEASIBLE")
    assert metrics["tasksScheduled"] == 64
    assert metrics["tasksDeferred"] == 25
    assert metrics["tasksSplit"] == 29
    assert optimized["solveSeconds"] <= 10.5


def test_all_89_tasks_are_accounted_for_in_the_response(optimized, payload):
    """FR3.3 across the wire, not just inside the solver."""
    scheduled = {task_id for block in optimized["blocks"] for task_id in block["taskIds"]}
    deferred = {item["taskId"] for item in optimized["deferredTasks"]}

    assert scheduled | deferred == {task["taskId"] for task in payload["tasks"]}
    assert len(optimized["decisionLog"]) == 89


def test_every_deferral_over_http_is_mostly_structural(optimized):
    """D-024: pre-T29, nothing on this corpus ever lost a capacity contest
    over a week. T24 added a second structural reason (a task whose PRD 9.7
    prerequisite is itself unschedulable), still never a contest loss.

    T29 Phase 1 adds a real, genuine NO_CAPACITY case for the first time:
    3 previously-structural tasks (TSK-00044, TSK-00062, TSK-00085) now
    have enough total capacity to be split, but lose the resulting real
    fight for space to higher-priority work - see
    `test_deferrals_on_this_corpus_are_mostly_structural_but_t29_adds_real_contests`
    in test_scheduler_real_data.py for the full reasoning.
    """
    reasons = {item["reason"] for item in optimized["deferredTasks"]}

    assert reasons == {"EXCEEDS_LONGEST_WINDOW", "PREREQUISITE_UNSCHEDULABLE", "NO_CAPACITY"}


def test_saturated_gzb_sbb_now_gets_real_but_never_over_packed_coverage_over_http(optimized):
    """281 trains a day, one 54-minute window, 580 minutes of backlog. T29
    Phase 1 makes this corridor's "ballast deficiency" work splittable
    across several days of that same 54-minute window - see
    `test_saturated_gzb_sbb_is_no_longer_untouchable_but_never_over_packed`
    in test_scheduler_real_data.py. The one invariant that must hold either
    way: no possession here may ever exceed its real 54 minutes.
    """
    gzb_blocks = [b for b in optimized["blocks"] if b["corridorId"] == "GZB-SBB"]
    for block in gzb_blocks:
        assert block["usedMinutes"] <= 54

    # TSK-00042/TSK-00043 ("relay fault", not splittable) still cannot fit
    # and still name the traffic-block alternative. TSK-00044/TSK-00045
    # ("ballast deficiency", splittable) are no longer automatically in this
    # deferred set - TSK-00045 is placed via splitting on this corpus;
    # TSK-00044 may or may not be, depending on the real capacity contest
    # (if deferred, it is NO_CAPACITY now - it cleared the total-capacity
    # check - not EXCEEDS_LONGEST_WINDOW), so it is checked separately below
    # rather than assumed either way.
    deferred_by_id = {item["taskId"]: item for item in optimized["deferredTasks"]}
    for task_id in ("TSK-00042", "TSK-00043"):
        assert deferred_by_id[task_id]["reason"] == "EXCEEDS_LONGEST_WINDOW"
        assert "traffic block" in deferred_by_id[task_id]["detail"]
    if "TSK-00044" in deferred_by_id:
        assert deferred_by_id["TSK-00044"]["reason"] == "NO_CAPACITY"

    scheduled = {t for b in optimized["blocks"] for t in b["taskIds"]}
    assert "TSK-00045" in scheduled, "expected splitting to rescue at least this GZB-SBB task"
    assert "TSK-00045" in optimized["splitTasks"]


def test_known_gaps_are_reported_over_http(optimized):
    """Both T24 and T25 are now enforced, so both counts must be zero over
    the wire too."""
    gaps = optimized["knownGaps"]

    assert gaps["resourceConflicts"]["count"] == 0
    assert gaps["dependencyViolations"]["count"] == 0
    assert "T25" in gaps["resourceConflicts"]["note"]


def test_priority_is_not_a_placeholder_over_http(optimized):
    flags = {
        entry["contributingFactors"]["priorityIsPlaceholder"]
        for entry in optimized["decisionLog"]
    }

    assert flags == {False}


def test_baseline_reproduces_the_t8_numbers_over_http(naive):
    """6 double-bookings, 605 double-booked minutes, 3 over-subscribed windows,
    zero batching - the FR9.1 result, now via the endpoint."""
    metrics = naive["metrics"]

    assert metrics["doubleBookings"] == 6
    assert metrics["doubleBookedMinutes"] == 605
    assert metrics["overSubscribedWindows"] == 3
    assert metrics["crossDepartmentBatches"] == 0
    assert len(naive["conflicts"]["doubleBookings"]) == 6


def test_the_contestable_subset_comes_back_for_t14(naive):
    """D-031: the comparison must be drawn from this set, never the full 89.
    Unchanged by T29 Phase 1 splitting (D-084) - it still means "fits one
    window", the baseline's real, permanent ceiling."""
    assert len(naive["contestableTaskIds"]) == 36


def test_the_split_only_subset_comes_back_for_t14(naive):
    """D-084: the further 32 tasks that fit no single window but ARE
    placeable by the optimizer via splitting - structurally unreachable for
    the baseline, at any horizon. Disjoint from `contestableTaskIds` and,
    together with the 21 genuinely impossible tasks, accounts for all 89."""
    contestable = set(naive["contestableTaskIds"])
    split_only = set(naive["splitOnlyTaskIds"])

    assert len(split_only) == 32
    assert contestable.isdisjoint(split_only)


def test_the_honest_comparison_holds_over_http(optimized, naive):
    """T6-T23 found the two engines scheduled the identical 36 contestable
    tasks, so the story was purely coordination vs chaos, never throughput.
    T24 changes this in a real and slightly less tidy way: the optimizer now
    schedules 35 of the 36, one FEWER than the baseline's 36 - not a
    regression, but the honest cost of respecting PRD 9.7. TSK-00025 is
    structurally contestable (it physically fits a BRMD-NIM window on its own)
    and the naive per-department baseline, which has never known about
    `dependsOnTaskId`, schedules it anyway - even though TSK-00024, the
    prerequisite it depends on, never gets a window in the baseline's plan
    either. That is a genuine, demonstrated dependency-order violation sitting
    inside the baseline's own output, on the real corpus - not a hypothetical.

    T29 Phase 1 leaves the CONTESTABLE-36 comparison itself untouched
    (`structurally_contestable()` still means "fits in one window", the
    baseline's real ceiling - the baseline never splits, deliberately, so it
    stays a faithful naive process rather than quietly gaining the
    optimizer's new capability). What changes is a NEW, separate, additive
    number: the optimizer now schedules 64 tasks in total - 29 more than the
    35 inside the strict old comparison - entirely from tasks that were
    NEVER contestable by this definition (too long for any single window)
    and that the baseline could not schedule at any horizon length, by
    construction. That is reported via `metrics.tasksSplit`
    (`optimized["metrics"]["tasksSplit"] == 29`), never folded into the
    36-task comparison itself - the same "additive, never silently mixed
    into an existing framing" discipline this project applies everywhere
    else a new capability is found (batching, conflicts, weather risk).

    Cross-department batching also rose for a real reason, not by
    definition change: covering 29 more tasks means more possessions opened
    in total, so more real opportunities for two departments to share one.
    """
    contestable = set(naive["contestableTaskIds"])
    opt = {t for b in optimized["blocks"] for t in b["taskIds"]} & contestable
    base = {t for b in naive["blocks"] for t in b["taskIds"]} & contestable

    assert len(opt) == 35, "the optimizer must not place TSK-00025 without its prerequisite"
    assert len(base) == 36, "the baseline, ignorant of dependsOnTaskId, still does"
    assert naive["metrics"]["doubleBookings"] == 6
    assert optimized["metrics"]["crossDepartmentBatches"] >= 2

    # The new, additive T29 Phase 1 finding: real coverage the strict
    # contestable-36 comparison was never designed to see, because the
    # baseline structurally cannot compete for it at all.
    optimizer_scheduled = {t for b in optimized["blocks"] for t in b["taskIds"]}
    assert len(optimizer_scheduled) > len(opt), (
        "expected split tasks to add real coverage beyond the contestable-36 set"
    )
    assert optimized["metrics"]["tasksSplit"] > 0

    # The dependency violation living inside the baseline's own plan: TSK-00025
    # scheduled, its prerequisite TSK-00024 not, and the baseline never checks.
    base_scheduled = {t for b in naive["blocks"] for t in b["taskIds"]}
    assert "TSK-00025" in base_scheduled
    assert "TSK-00024" not in base_scheduled

    # And the trap: the baseline's utilisation looks BETTER because it
    # over-subscribes. Never render it without the conflict count. T29 makes
    # this MORE true, not less: the optimizer's utilisation now looks worse
    # still, because covering 29 extra tasks via partial segments opens many
    # more windows than it fills - real coverage, reported as if it were
    # "less full", another reason utilisation alone must never be trusted.
    assert naive["metrics"]["blockUtilisationPct"] > optimized["metrics"]["blockUtilisationPct"]


def test_prioritize_ranks_the_real_backlog_over_http(client, payload):
    response = client.post(
        "/prioritize",
        json={"tasks": payload["tasks"], "asOf": HORIZON_START.isoformat()},
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["count"] == 89
    scores = [entry["priorityScore"] for entry in body["queue"]]
    assert scores == sorted(scores, reverse=True)
    # T7 measured the real range at 25.04-87.31.
    assert scores[0] > 80 and scores[-1] < 30
    # T16 made FR2.2 real, and the seeded corpus now carries risk scores, so the
    # flag is True wherever a score came through. It must still be False for any
    # task whose asset the model could not assess - the flag tracks the data,
    # not the feature's existence.
    with_risk = [t for t in payload["tasks"] if t.get("failureRiskScore") is not None]
    by_id = {entry["taskId"]: entry for entry in body["queue"]}
    for task in payload["tasks"]:
        expected = task.get("failureRiskScore") is not None
        assert by_id[task["taskId"]]["usesFailureRisk"] is expected
    assert with_risk, "expected the real corpus to carry FR2.2 scores after T16"


def test_endpoints_are_deterministic_over_http(client, payload):
    first = client.post("/optimize", json=payload).json()
    second = client.post("/optimize", json=payload).json()

    first.pop("solveSeconds"), second.pop("solveSeconds")
    assert first == second
