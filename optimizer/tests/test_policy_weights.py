"""T23 - policy sliders on the CP-SAT objective (PRD Section 8, 13.1).

Two levels. `test_optimizer_api.py`'s wrapper-fidelity level already covers the
plumbing generally; this file is specific to the weight feature: the API
validates and applies overrides correctly, and the safety property D-061 found
(coverage cannot collapse within the exposed range, but CAN outside it) is
mutation-tested rather than merely asserted once.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date

import pytest

from app.core.scheduler import DEFAULT_WEIGHTS, solve_schedule

H = date(2026, 8, 24)

SCENARIO = {
    "tasks": [
        {
            "taskId": "E1", "corridorId": "A-B", "department": "Engineering",
            "estBlockDurationMins": 100, "slaDueDate": "2026-12-01", "severity": 4,
            "assetCriticalityScore": 80.0, "dateRaised": "2026-07-01",
        },
        {
            "taskId": "S1", "corridorId": "A-B", "department": "S&T",
            "estBlockDurationMins": 80, "slaDueDate": "2026-12-01", "severity": 2,
            "assetCriticalityScore": 40.0, "dateRaised": "2026-07-02",
        },
    ],
    "corridors": [
        {"corridorId": "A-B", "dailyWindows": [{"startMinute": 60, "endMinute": 240}]},
    ],
    "horizonStart": "2026-08-24",
    "horizonDays": 1,
}


# --------------------------------------------------------------------------- #
# Request validation - the bound is refused, not silently reinterpreted        #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize(
    "field,value",
    [
        ("coverage", 500),        # below the 1,000 floor
        ("coverage", 200_000),    # above the 100,000 ceiling
        ("slaCompliance", 100),
        ("batching", 100),
        ("unusedMinute", 0),
        ("unusedMinute", 11),
        ("fragmentation", 10),
        ("fragmentation", 6_000),
    ],
)
def test_a_weight_outside_the_verified_safe_range_is_refused(client, field, value):
    """D-061's range is not a suggestion. An out-of-range slider is a 422 naming
    the exact bound, never clamped to the nearest legal value - PRD Section 6
    treats an invalid input as something to explain, not reinterpret."""
    response = client.post("/optimize", json={**SCENARIO, "policyWeights": {field: value}})

    assert response.status_code == 422
    detail = str(response.json()["detail"])
    assert field in detail or field.replace("Compliance", "_compliance").lower() in detail.lower()


def test_omitted_weights_use_the_d023_defaults_exactly(client):
    response = client.post("/optimize", json=SCENARIO)
    assert response.status_code == 200

    assert response.json()["policyWeights"] == {
        "coverage": DEFAULT_WEIGHTS.coverage,
        "slaCompliance": DEFAULT_WEIGHTS.sla_compliance,
        "batching": DEFAULT_WEIGHTS.batching,
        "unusedMinute": DEFAULT_WEIGHTS.unused_minute,
        "fragmentation": DEFAULT_WEIGHTS.fragmentation,
    }


def test_a_named_override_is_applied_and_the_rest_default(client):
    response = client.post(
        "/optimize", json={**SCENARIO, "policyWeights": {"fragmentation": 2500}}
    )
    assert response.status_code == 200

    weights = response.json()["policyWeights"]
    assert weights["fragmentation"] == 2500
    assert weights["coverage"] == DEFAULT_WEIGHTS.coverage
    assert weights["slaCompliance"] == DEFAULT_WEIGHTS.sla_compliance


def test_an_unknown_weight_field_is_refused_not_silently_ignored(client):
    """`extra="forbid"` on ApiModel (D-004 style). A typo'd slider name must not
    silently apply the default while pretending the override was honoured."""
    response = client.post(
        "/optimize", json={**SCENARIO, "policyWeights": {"coveragee": 20000}}
    )
    assert response.status_code == 422


# --------------------------------------------------------------------------- #
# D-061's safety property, mutation-tested                                     #
# --------------------------------------------------------------------------- #

@pytest.fixture(scope="module")
def real_corpus():
    """D-061's evidence was gathered against the real 89-task corpus, not a
    hand-built scenario - a 2-task fixture has too little waste-surface for the
    penalty terms to ever outweigh coverage, at any weight, and would make both
    tests below pass for the wrong reason. Needs the backend API and MongoDB;
    skips otherwise, same convention as test_optimizer_api_real_data.py."""
    from datetime import date as _date

    from scripts.real_data import BackendUnavailable, build_payload
    from app.routers.optimizer import _to_corridors, _to_tasks
    from app.models.scheduling import TaskIn, CorridorIn

    try:
        payload = build_payload(horizon_start=_date(2026, 8, 24), horizon_days=7)
    except BackendUnavailable as exc:
        pytest.skip(f"backend API not reachable: {exc}")

    tasks = _to_tasks([TaskIn(**t) for t in payload["tasks"]], _date(2026, 8, 24))
    corridors = _to_corridors([CorridorIn(**c) for c in payload["corridors"]])
    return tasks, corridors


def test_within_the_exposed_range_coverage_is_never_traded_away(real_corpus):
    """The floor of coverage combined with the ceiling of both penalty terms -
    the single worst-case combination for keeping coverage dominant - must
    still schedule everything the default weights schedule (D-061)."""
    tasks, corridors = real_corpus
    base = solve_schedule(tasks, corridors, horizon_start=H, horizon_days=7)
    worst_within_range = replace(
        DEFAULT_WEIGHTS, coverage=1_000, unused_minute=10, fragmentation=5_000,
    )
    result = solve_schedule(
        tasks, corridors, horizon_start=H, horizon_days=7, weights=worst_within_range,
    )
    assert result.scheduled_task_ids == base.scheduled_task_ids


def test_MUTATION_outside_the_exposed_range_coverage_CAN_be_traded_away(real_corpus):
    """The property above is not vacuous. Pushed far enough outside the range
    the API allows, the same combination genuinely drops coverage (36 -> 3 on
    the real corpus) - proving the boundary is real and `PolicyWeightsIn`'s
    validation is load-bearing, not decorative. If this test ever passes
    without a real boundary crossed, D-061's safety claim would be trivially
    true and worth nothing."""
    tasks, corridors = real_corpus
    base = solve_schedule(tasks, corridors, horizon_start=H, horizon_days=7)
    outside_range = replace(DEFAULT_WEIGHTS, coverage=1, unused_minute=50, fragmentation=5_000)
    result = solve_schedule(
        tasks, corridors, horizon_start=H, horizon_days=7, weights=outside_range,
    )
    assert result.scheduled_task_ids != base.scheduled_task_ids
    assert len(result.scheduled_task_ids) < len(base.scheduled_task_ids)
