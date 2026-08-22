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


def load_scenario(api_base: str = DEFAULT_API) -> tuple[list[MaintenanceTask], dict[str, CorridorAvailability]]:
    """Fetch every corridor carrying demand, its free windows, and the backlog.

    Uses `hasSyntheticDemand=true`, which is the indexed filter T5 added - so
    this pulls the ~30 relevant corridors rather than all 10,149.
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
    tasks = [
        MaintenanceTask(
            task_id=task["_id"],
            corridor_id=task["corridorId"],
            department=task["department"],
            duration_minutes=task["estBlockDurationMins"],
            sla_due_date=date.fromisoformat(task["slaDueDate"]),
            # PLACEHOLDER (T6): severity stands in for T7's FR2.3 priority score.
            priority=task["severity"],
            depends_on_task_id=task.get("dependsOnTaskId"),
            required_resource_ids=tuple(task.get("requiredResourceIds") or []),
        )
        for task in task_payload
    ]

    return tasks, corridors
