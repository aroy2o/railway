"""Load a real scheduling scenario from the backend API.

DEV HARNESS, NOT THE PRODUCTION PATH. PRD Section 11 puts Node in front of
MongoDB: the Controller triggers a schedule, Node gathers tasks, corridors and
resources, and POSTs them to this service's /optimize endpoint (task T9). The
Python service never talks to MongoDB itself - it could not use the Mongoose
models anyway, and a second writer to the same database is exactly the coupling
the microservice split exists to avoid.

This module exists so T6 can validate the solver against the real seeded corpus
before that endpoint exists. It reads through the T5 read-only API rather than
data/processed/*.json, because T5 established the database as the source of
truth. When T9 lands, the request payload replaces this and it can go.
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


class BackendUnavailable(RuntimeError):
    """Raised when the API cannot be reached, so callers can skip rather than fail."""


def _get(url: str, timeout: float = 15.0) -> Any:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
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
