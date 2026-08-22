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


def test_optimize_reproduces_the_t6_t7_numbers_over_http(optimized):
    """36 scheduled / 53 deferred, OPTIMAL, inside PRD Section 7's 10s budget."""
    metrics = optimized["metrics"]

    assert optimized["status"] == "OPTIMAL"
    assert metrics["tasksScheduled"] == 36
    assert metrics["tasksDeferred"] == 53
    assert metrics["crossDepartmentBatches"] == 2
    assert optimized["solveSeconds"] < 10.0


def test_all_89_tasks_are_accounted_for_in_the_response(optimized, payload):
    """FR3.3 across the wire, not just inside the solver."""
    scheduled = {task_id for block in optimized["blocks"] for task_id in block["taskIds"]}
    deferred = {item["taskId"] for item in optimized["deferredTasks"]}

    assert scheduled | deferred == {task["taskId"] for task in payload["tasks"]}
    assert len(optimized["decisionLog"]) == 89


def test_every_deferral_over_http_is_structural(optimized):
    """D-024: on this corpus nothing loses a capacity contest over a week."""
    reasons = {item["reason"] for item in optimized["deferredTasks"]}

    assert reasons == {"EXCEEDS_LONGEST_WINDOW"}


def test_saturated_gzb_sbb_is_still_deferred_over_http(optimized):
    """281 trains a day, one 54-minute window, 580 minutes of backlog."""
    assert not [b for b in optimized["blocks"] if b["corridorId"] == "GZB-SBB"]

    gzb = [
        item for item in optimized["deferredTasks"]
        if item["taskId"] in {"TSK-00042", "TSK-00043", "TSK-00044", "TSK-00045"}
    ]
    assert len(gzb) == 4
    assert all(item["reason"] == "EXCEEDS_LONGEST_WINDOW" for item in gzb)
    assert all("traffic block" in item["detail"] for item in gzb)


def test_known_gaps_are_reported_over_http(optimized):
    """T24 and T25 are unbuilt; the response says so rather than looking clean."""
    gaps = optimized["knownGaps"]

    assert gaps["resourceConflicts"]["count"] > 0
    assert gaps["dependencyViolations"]["count"] > 0
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
    """D-031: the comparison must be drawn from this set, never the full 89."""
    assert len(naive["contestableTaskIds"]) == 36


def test_the_honest_comparison_holds_over_http(optimized, naive):
    """Both engines schedule the same contestable work; the difference is that
    the baseline's plan is not executable. This is the claim T14 may make."""
    contestable = set(naive["contestableTaskIds"])
    opt = {t for b in optimized["blocks"] for t in b["taskIds"]} & contestable
    base = {t for b in naive["blocks"] for t in b["taskIds"]} & contestable

    assert len(opt) == len(base) == 36, "there is no throughput advantage - do not claim one"
    assert naive["metrics"]["doubleBookings"] == 6
    assert optimized["metrics"]["crossDepartmentBatches"] == 2

    # And the trap: the baseline's utilisation looks BETTER because it
    # over-subscribes. Never render it without the conflict count.
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
    assert all(entry["usesFailureRisk"] is False for entry in body["queue"])


def test_endpoints_are_deterministic_over_http(client, payload):
    first = client.post("/optimize", json=payload).json()
    second = client.post("/optimize", json=payload).json()

    first.pop("solveSeconds"), second.pop("solveSeconds")
    assert first == second
