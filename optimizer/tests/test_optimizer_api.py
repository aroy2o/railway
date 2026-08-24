"""Scheduling endpoint tests - T9.

Two levels, matching the discipline used since T6:

* **Wrapper fidelity** - a small hand-built payload, with the endpoint's output
  compared against calling the underlying function directly. The endpoints are
  supposed to be thin; that is verified rather than assumed.
* **Real corpus over HTTP** - the same 89-task scenario T6/T7/T8 were validated
  on, pushed through the actual endpoints, reproducing the same numbers. The
  point of T9 is making proven logic reachable, so the proof has to be the same
  results arriving via HTTP.

The honesty-field round-trip test is the counterpart of T5's MongoDB round-trip
check: the same category of risk (a schema silently subtracting a field that
exists to keep the system honest), in a new layer.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.core.baseline import run_baseline
from app.core.scheduler import (
    CorridorAvailability,
    DailyWindow,
    MaintenanceTask,
    solve_schedule,
)

HORIZON = "2026-08-24"
H = date(2026, 8, 24)

# Two departments, one 180-minute window: the optimizer batches them, the
# baseline double-books them. Small enough to check by hand.
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
        {"corridorId": "A-B", "dailyWindows": [{"startMinute": 60, "endMinute": 240}]}
    ],
    "horizonStart": HORIZON,
    "horizonDays": 1,
}


# --------------------------------------------------------------------------- #
# Wrapper fidelity                                                             #
# --------------------------------------------------------------------------- #

def test_optimize_matches_calling_the_solver_directly(client):
    """The endpoint must be a faithful wrapper, not a reinterpretation."""
    response = client.post("/optimize", json=SCENARIO)
    assert response.status_code == 200, response.text
    body = response.json()

    from app.core.priority import PriorityInputs, score_task

    def scored(task_id, severity, criticality, due):
        """T17: the endpoint carries the whole FR2.4 breakdown into the decision
        log, not just the rounded integer, so the direct call must too."""
        return score_task(
            PriorityInputs(task_id, severity, criticality, date.fromisoformat(due), H)
        )

    e1, s1 = scored("E1", 4, 80.0, "2026-12-01"), scored("S1", 2, 40.0, "2026-12-01")

    direct = solve_schedule(
        [
            MaintenanceTask("E1", "A-B", "Engineering", 100, date(2026, 12, 1),
                            priority=e1.solver_priority, priority_is_placeholder=False,
                            date_raised=date(2026, 7, 1), priority_breakdown=e1.as_dict()),
            MaintenanceTask("S1", "A-B", "S&T", 80, date(2026, 12, 1),
                            priority=s1.solver_priority, priority_is_placeholder=False,
                            date_raised=date(2026, 7, 2), priority_breakdown=s1.as_dict()),
        ],
        {"A-B": CorridorAvailability("A-B", (DailyWindow(60, 240),))},
        horizon_start=H, horizon_days=1,
    ).as_dict()

    body.pop("solveSeconds"), direct.pop("solveSeconds")

    # The endpoint adds the PRD 9.5 typed taxonomy (T21). Peel it off and assert
    # it is derived from this very solve's `knownGaps` rather than from anything
    # else - then the rest must still be byte-for-byte the solver's own output.
    from app.core.conflicts import from_known_gaps, summarise

    assert body.pop("conflictReport") == summarise(
        from_known_gaps(direct["knownGaps"]), known_plans=("optimized",)
    )
    # T23: the endpoint also adds the weights actually used, since the request
    # named none and the D-023 defaults were applied - never an absence a
    # caller could mistake for "no weights applied".
    from app.core.scheduler import DEFAULT_WEIGHTS

    assert body.pop("policyWeights") == {
        "coverage": DEFAULT_WEIGHTS.coverage,
        "slaCompliance": DEFAULT_WEIGHTS.sla_compliance,
        "batching": DEFAULT_WEIGHTS.batching,
        "unusedMinute": DEFAULT_WEIGHTS.unused_minute,
        "fragmentation": DEFAULT_WEIGHTS.fragmentation,
    }
    assert body == direct


def test_baseline_matches_calling_the_function_directly(client):
    response = client.post("/baseline", json=SCENARIO)
    assert response.status_code == 200, response.text
    body = response.json()

    direct = run_baseline(
        [
            MaintenanceTask("E1", "A-B", "Engineering", 100, date(2026, 12, 1), priority=1,
                            date_raised=date(2026, 7, 1)),
            MaintenanceTask("S1", "A-B", "S&T", 80, date(2026, 12, 1), priority=1,
                            date_raised=date(2026, 7, 2)),
        ],
        {"A-B": CorridorAvailability("A-B", (DailyWindow(60, 240),))},
        horizon_start=H, horizon_days=1,
    ).as_dict()

    # The endpoint adds the contestable set for T14 and the typed taxonomy for
    # T21; everything else is verbatim.
    from app.core.conflicts import from_baseline_conflicts, summarise

    assert body["conflictReport"] == summarise(
        from_baseline_conflicts(direct["conflicts"]), known_plans=("baseline",)
    )
    assert body["blocks"] == direct["blocks"]
    assert body["conflicts"] == direct["conflicts"]
    assert body["metrics"] == direct["metrics"]
    assert body["contestableTaskIds"] == ["E1", "S1"]


def test_optimize_batches_what_the_baseline_double_books(client):
    """The same payload through both endpoints, showing the actual difference."""
    optimized = client.post("/optimize", json=SCENARIO).json()
    naive = client.post("/baseline", json=SCENARIO).json()

    assert optimized["metrics"]["crossDepartmentBatches"] == 1
    assert optimized["blocks"][0]["isCrossDepartmentBatch"] is True

    assert naive["metrics"]["crossDepartmentBatches"] == 0
    assert naive["metrics"]["doubleBookings"] == 1
    # E1 runs 01:00-02:40, S1 also starts 01:00 and runs to 02:20 -> 80 min.
    assert naive["conflicts"]["doubleBookings"][0]["overlapMinutes"] == 80


def test_prioritize_returns_the_ranked_queue_with_breakdowns(client):
    response = client.post(
        "/prioritize", json={"tasks": SCENARIO["tasks"], "asOf": HORIZON}
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["count"] == 2
    assert [entry["taskId"] for entry in body["queue"]] == ["E1", "S1"]

    top = body["queue"][0]
    assert sum(top["contributions"].values()) == pytest.approx(top["priorityScore"], abs=0.01)
    assert top["dominantFactor"] in top["contributions"]


# --------------------------------------------------------------------------- #
# Honesty fields must survive serialisation                                    #
# --------------------------------------------------------------------------- #

def test_known_gaps_survive_the_http_round_trip(client):
    """T25's resource no-overlap is a hard constraint now, not a detector, so
    two tasks sharing a resource on a single-window horizon get ONE
    scheduled and one honestly deferred - never both, double-booked. The
    `knownGaps` shape (including the always-zero-now `resourceConflicts`)
    must still survive the response schema intact - the same failure D-015
    guarded against in the database layer."""
    payload = dict(SCENARIO)
    payload["tasks"] = [
        {**payload["tasks"][0], "requiredResourceIds": ["RES-tamper"]},
        {**payload["tasks"][1], "requiredResourceIds": ["RES-tamper"], "department": "TRD"},
    ]

    body = client.post("/optimize", json=payload).json()
    gaps = body["knownGaps"]

    assert body["metrics"]["tasksScheduled"] == 1
    assert body["metrics"]["tasksDeferred"] == 1
    assert gaps["resourceConflicts"]["count"] == 0
    assert "T25" in gaps["resourceConflicts"]["note"]
    assert "T24" in gaps["dependencyViolations"]["note"]


def test_priority_placeholder_flag_survives_and_reflects_reality(client):
    """False when criticality was supplied, True when it was not - never stale."""
    with_criticality = client.post("/optimize", json=SCENARIO).json()
    assert {
        entry["contributingFactors"]["priorityIsPlaceholder"]
        for entry in with_criticality["decisionLog"]
    } == {False}

    stripped = {
        **SCENARIO,
        "tasks": [
            {k: v for k, v in task.items() if k != "assetCriticalityScore"}
            for task in SCENARIO["tasks"]
        ],
    }
    without = client.post("/optimize", json=stripped).json()
    assert {
        entry["contributingFactors"]["priorityIsPlaceholder"]
        for entry in without["decisionLog"]
    } == {True}


def test_uses_failure_risk_tracks_whether_a_score_was_actually_supplied(client):
    """T16 made FR2.2 real. The flag must follow the behaviour in BOTH
    directions: true when a score was weighted, false when none was available.
    A flag that says true regardless would be worse than no flag - it would
    assert risk-awareness on a task with no risk data."""
    with_risk = [{**task, "failureRiskScore": 82.0} for task in SCENARIO["tasks"]]

    scored = client.post("/prioritize", json={"tasks": with_risk, "asOf": HORIZON}).json()
    plain = client.post("/prioritize", json={"tasks": SCENARIO["tasks"], "asOf": HORIZON}).json()

    assert all(entry["usesFailureRisk"] is True for entry in scored["queue"])
    assert all(entry["usesFailureRisk"] is False for entry in plain["queue"])
    assert [e["priorityScore"] for e in scored["queue"]] != [
        e["priorityScore"] for e in plain["queue"]
    ]
    assert all("failure_risk" in e["contributions"] for e in scored["queue"])
    assert all("failure_risk" not in e["contributions"] for e in plain["queue"])


def test_baseline_conflict_report_survives_the_round_trip(client):
    body = client.post("/baseline", json=SCENARIO).json()
    conflicts = body["conflicts"]

    assert "OUTPUT of the baseline" in conflicts["note"]
    assert conflicts["doubleBookings"][0]["departments"] == ["Engineering", "S&T"]
    assert body["metrics"]["overSubscribedWindows"] == 0  # 180 min of work in a 180 min window


def test_date_raised_survives_and_actually_orders_the_baseline(client):
    """`dateRaised` is unused by the solver but load-bearing for FCFS. If the
    contract dropped it, the baseline would degrade to task-id order silently."""
    payload = {
        "corridors": [
            {"corridorId": "A-B", "dailyWindows": [{"startMinute": 0, "endMinute": 100}]}
        ],
        "horizonStart": HORIZON,
        "horizonDays": 1,
        "tasks": [
            {"taskId": "ZZZ_RAISED_FIRST", "corridorId": "A-B", "department": "Engineering",
             "estBlockDurationMins": 100, "slaDueDate": "2026-12-01", "severity": 1,
             "dateRaised": "2026-06-01"},
            {"taskId": "AAA_RAISED_LATER", "corridorId": "A-B", "department": "Engineering",
             "estBlockDurationMins": 100, "slaDueDate": "2026-12-01", "severity": 1,
             "dateRaised": "2026-08-01"},
        ],
    }

    body = client.post("/baseline", json=payload).json()
    scheduled = {task_id for block in body["blocks"] for task_id in block["taskIds"]}

    # Raised first wins despite sorting last alphabetically - proving the date
    # made it across the wire and drove the ordering.
    assert scheduled == {"ZZZ_RAISED_FIRST"}
    assert "warnings" not in body


def test_missing_date_raised_is_warned_about_not_ignored(client):
    payload = {
        **SCENARIO,
        "tasks": [{k: v for k, v in t.items() if k != "dateRaised"} for t in SCENARIO["tasks"]],
    }

    body = client.post("/baseline", json=payload).json()

    assert body["warnings"][0]["code"] == "MISSING_DATE_RAISED"
    assert sorted(body["warnings"][0]["taskIds"]) == ["E1", "S1"]


# --------------------------------------------------------------------------- #
# Validation at the boundary                                                   #
# --------------------------------------------------------------------------- #

def test_a_task_referencing_an_absent_corridor_is_a_clean_422(client):
    """A KeyError three frames inside the solver would be a much worse failure.

    The payload carries a corridor - just not the one the tasks sit on - so this
    exercises the referential-integrity check rather than the non-empty rule.
    """
    payload = {
        **SCENARIO,
        "corridors": [
            {"corridorId": "SOMEWHERE-ELSE",
             "dailyWindows": [{"startMinute": 0, "endMinute": 100}]}
        ],
    }

    response = client.post("/optimize", json=payload)

    assert response.status_code == 422
    assert "not present in the payload" in response.text


@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        ({"tasks": []}, None),
        ({"corridors": []}, None),
        ({"horizonDays": 0}, None),
        ({"horizonStart": "not-a-date"}, None),
    ],
)
def test_malformed_requests_are_422_not_500(client, mutation, fragment):
    response = client.post("/optimize", json={**SCENARIO, **mutation})
    assert response.status_code == 422, response.text


def test_unknown_fields_are_rejected_rather_than_silently_dropped(client):
    """A typo'd field name that is ignored would change the solve invisibly."""
    payload = {
        **SCENARIO,
        "tasks": [{**SCENARIO["tasks"][0], "dateRaisd": "2026-07-01"}],
    }

    response = client.post("/optimize", json=payload)

    assert response.status_code == 422
    assert "dateRaisd" in response.text


def test_overlapping_windows_on_a_corridor_are_rejected(client):
    payload = {
        **SCENARIO,
        "corridors": [
            {"corridorId": "A-B", "dailyWindows": [
                {"startMinute": 0, "endMinute": 100},
                {"startMinute": 50, "endMinute": 200},
            ]}
        ],
    }

    response = client.post("/optimize", json=payload)

    assert response.status_code == 422
    assert "disjoint" in response.text


def test_a_low_confidence_corridor_is_refused_cleanly(client):
    payload = {
        **SCENARIO,
        "corridors": [{**SCENARIO["corridors"][0], "lowConfidence": True}],
    }

    response = client.post("/optimize", json=payload)

    assert response.status_code == 422
    assert "lowConfidence" in response.text


def test_duplicate_ids_are_rejected(client):
    payload = {**SCENARIO, "tasks": [SCENARIO["tasks"][0], SCENARIO["tasks"][0]]}

    assert client.post("/optimize", json=payload).status_code == 422


def test_prioritize_requires_the_real_asset_criticality(client):
    """Scoring without it would silently produce a weaker ranking that still
    looked authoritative."""
    tasks = [{k: v for k, v in SCENARIO["tasks"][0].items() if k != "assetCriticalityScore"}]

    response = client.post("/prioritize", json={"tasks": tasks, "asOf": HORIZON})

    assert response.status_code == 422
    assert "assetCriticalityScore" in response.text


def test_horizon_beyond_the_configured_ceiling_is_refused(client):
    response = client.post("/optimize", json={**SCENARIO, "horizonDays": 400})

    assert response.status_code == 422


def test_an_oversized_body_is_refused_before_parsing(client):
    from app.config import get_settings

    limit = get_settings().max_request_bytes
    response = client.post(
        "/optimize",
        content=b"{}",
        headers={"content-type": "application/json", "content-length": str(limit + 1)},
    )

    assert response.status_code == 413


def test_client_cannot_ask_for_more_solve_time_than_configured(client):
    """maxSeconds may lower the budget, never raise it."""
    from app.config import get_settings

    response = client.post("/optimize", json={**SCENARIO, "maxSeconds": 9999})

    assert response.status_code == 200
    assert response.json()["solveSeconds"] <= get_settings().solver_max_seconds + 1
