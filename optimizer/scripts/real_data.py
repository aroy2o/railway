"""Build a real scheduling payload from the backend API.

WHAT THIS IS NOW. Since T9, the production path is Node gathering inputs from
MongoDB and POSTing them to /optimize, /baseline and /prioritize. This module is
the *test and development* stand-in for Node's gathering step: it reads the same
data through the T5 read-only API and shapes it into the same request payload.

It exists so the optimizer's tests can exercise the endpoints against the real
seeded corpus without a Node orchestration layer, and so a developer can
reproduce a solve locally. It is NOT on the request path, and the Python service
still never talks to MongoDB - that stays Node's alone.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import date
from typing import Any

from app.core.priority import PriorityInputs, score_task
from app.core.scheduler import CorridorAvailability, DailyWindow, MaintenanceTask

DEFAULT_API = "http://localhost:5000/api"

#: The auth session (2026-08-25, see docs/DECISIONS.md D-073) gated every
#: read route behind `requireAuth`, which this dev/test helper predates. The
#: `controller` demo account (DEMO_ACCOUNTS.md) has full read access to
#: everything this module fetches.
_DEMO_USERNAME = "controller"
_DEMO_PASSWORD = "controller123"

_token_cache: str | None = None


class BackendUnavailable(RuntimeError):
    """Raised when the API cannot be reached, so callers can skip rather than fail."""


def _login(api_base: str, timeout: float) -> str:
    global _token_cache
    if _token_cache is not None:
        return _token_cache
    body = json.dumps({"username": _DEMO_USERNAME, "password": _DEMO_PASSWORD}).encode()
    request = urllib.request.Request(
        f"{api_base}/auth/login",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
        raise BackendUnavailable(f"could not log in at {api_base}/auth/login: {exc}") from exc
    _token_cache = payload["data"]["token"]
    return _token_cache


def _get(url: str, timeout: float = 15.0) -> Any:
    api_base = url.split("/api/", 1)[0] + "/api"
    token = _login(api_base, timeout)
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
        raise BackendUnavailable(f"could not reach {url}: {exc}") from exc


def load_scenario(
    api_base: str = DEFAULT_API,
    *,
    horizon_start: date | None = None,
    use_priority_engine: bool = True,
) -> tuple[list[MaintenanceTask], dict[str, CorridorAvailability]]:
    """Fetch every corridor carrying demand, its free windows, and the backlog.

    Uses `hasSyntheticDemand=true`, which is the indexed filter T5 added - so
    this pulls the ~30 relevant corridors rather than all 10,149.

    `use_priority_engine=False` reproduces T6's severity-only placeholder, which
    is what makes a genuine before/after comparison possible rather than a
    remembered one.
    """
    corridor_list = _get(f"{api_base}/corridors?hasSyntheticDemand=true&limit=200")["data"]

    corridors: dict[str, CorridorAvailability] = {}
    for summary in corridor_list:
        detail = _get(f"{api_base}/corridors/{summary['_id']}")["data"]
        windows = tuple(
            DailyWindow(window["startMin"], window["endMin"])
            for window in detail.get("maxDailyBlockWindows", [])
        )
        corridors[detail["_id"]] = CorridorAvailability(
            corridor_id=detail["_id"],
            daily_windows=windows,
            low_confidence=bool((detail.get("occupancy") or {}).get("lowConfidence", False)),
        )

    task_payload = _get(f"{api_base}/tasks?limit=200")["data"]

    # Asset criticality is a REAL input to FR2.3 (T4 computed it from measured
    # train counts), so the priority engine needs the assets joined in.
    asset_payload = _get(f"{api_base}/assets?limit=200")["data"]
    criticality = {asset["_id"]: asset["criticalityScore"] for asset in asset_payload}

    as_of = horizon_start or date.today()
    tasks = []
    for task in task_payload:
        if use_priority_engine:
            breakdown = score_task(
                PriorityInputs(
                    task_id=task["_id"],
                    severity=task["severity"],
                    asset_criticality_score=criticality[task["assetId"]],
                    sla_due_date=date.fromisoformat(task["slaDueDate"]),
                    as_of=as_of,
                    # FR2.2 stays null until T16; the engine ignores it.
                    failure_risk_score=task.get("failureRiskScore"),
                )
            )
            priority, is_placeholder = breakdown.solver_priority, False
        else:
            priority, is_placeholder = task["severity"], True

        tasks.append(
            MaintenanceTask(
                task_id=task["_id"],
                corridor_id=task["corridorId"],
                department=task["department"],
                duration_minutes=task["estBlockDurationMins"],
                sla_due_date=date.fromisoformat(task["slaDueDate"]),
                priority=priority,
                depends_on_task_id=task.get("dependsOnTaskId"),
                required_resource_ids=tuple(task.get("requiredResourceIds") or []),
                priority_is_placeholder=is_placeholder,
                date_raised=date.fromisoformat(task["dateRaised"]),
                # T29 Phase 1: decides splittability (app.core.splitting).
                defect_type=task.get("defectType") or "",
            )
        )

    return tasks, corridors


def load_priority_queue(
    api_base: str = DEFAULT_API, *, horizon_start: date | None = None
) -> list:
    """FR2.4 - the ranked queue with per-task breakdowns, straight from the API."""
    from app.core.priority import rank_tasks

    task_payload = _get(f"{api_base}/tasks?limit=200")["data"]
    asset_payload = _get(f"{api_base}/assets?limit=200")["data"]
    criticality = {asset["_id"]: asset["criticalityScore"] for asset in asset_payload}
    as_of = horizon_start or date.today()

    return rank_tasks(
        [
            PriorityInputs(
                task_id=task["_id"],
                severity=task["severity"],
                asset_criticality_score=criticality[task["assetId"]],
                sla_due_date=date.fromisoformat(task["slaDueDate"]),
                as_of=as_of,
                failure_risk_score=task.get("failureRiskScore"),
            )
            for task in task_payload
        ]
    )


def build_payload(
    api_base: str = DEFAULT_API, *, horizon_start: date, horizon_days: int = 7
) -> dict:
    """Shape the seeded corpus into a /optimize or /baseline request body.

    Mirrors what Node will send: corridors with their real free windows, and
    tasks with the asset criticality join already resolved.
    """
    corridor_list = _get(f"{api_base}/corridors?hasSyntheticDemand=true&limit=200")["data"]

    corridors = []
    for summary in corridor_list:
        detail = _get(f"{api_base}/corridors/{summary['_id']}")["data"]
        corridors.append(
            {
                "corridorId": detail["_id"],
                "dailyWindows": [
                    {"startMinute": w["startMin"], "endMinute": w["endMin"]}
                    for w in detail.get("maxDailyBlockWindows", [])
                ],
                "lowConfidence": bool((detail.get("occupancy") or {}).get("lowConfidence", False)),
            }
        )

    task_payload = _get(f"{api_base}/tasks?limit=200")["data"]
    asset_payload = _get(f"{api_base}/assets?limit=200")["data"]
    criticality = {asset["_id"]: asset["criticalityScore"] for asset in asset_payload}

    tasks = [
        {
            "taskId": task["_id"],
            "corridorId": task["corridorId"],
            "department": task["department"],
            "estBlockDurationMins": task["estBlockDurationMins"],
            "slaDueDate": task["slaDueDate"],
            "severity": task["severity"],
            "assetCriticalityScore": criticality[task["assetId"]],
            "dateRaised": task["dateRaised"],
            "dependsOnTaskId": task.get("dependsOnTaskId"),
            "requiredResourceIds": task.get("requiredResourceIds") or [],
            "failureRiskScore": task.get("failureRiskScore"),
            # T29 Phase 1: decides splittability (app.core.splitting).
            "defectType": task.get("defectType") or "",
        }
        for task in task_payload
    ]

    return {
        "tasks": tasks,
        "corridors": corridors,
        "horizonStart": horizon_start.isoformat(),
        "horizonDays": horizon_days,
    }
