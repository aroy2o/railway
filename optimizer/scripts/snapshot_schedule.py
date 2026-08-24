"""Freeze a real generated schedule for the live Ask the Planner tests.

`test_explain_live.py` needs real records to ground against, but it must not
depend on MongoDB, the backend or a fresh solve being available - a live test
that skips for the wrong reason is a live test that never runs.

So the schedule is snapshotted once, committed, and used as-is. It is genuine
output from `POST /api/schedules/generate`, not a hand-written fixture: the
whole value of the live test is that the model is answering about a plan the
system actually produced.

Refresh it with:  python -m scripts.snapshot_schedule
"""

from __future__ import annotations

import json
import pathlib
import sys
import urllib.error
import urllib.request

API = "http://localhost:5000/api"
OUT = pathlib.Path(__file__).parent.parent / "tests" / "fixtures" / "schedule_snapshot.json"


def _get(path: str):
    try:
        with urllib.request.urlopen(f"{API}{path}", timeout=30) as response:
            return json.loads(response.read())["data"]
    except (urllib.error.URLError, OSError) as exc:
        sys.exit(f"backend not reachable at {API}{path}: {exc}")


def main() -> None:
    schedule = _get("/schedules/latest")
    tasks = _get("/tasks?limit=200")
    payload = {
        "note": (
            "Real output of POST /api/schedules/generate, frozen for the live "
            "Ask the Planner tests. Regenerate with scripts/snapshot_schedule.py."
        ),
        "schedule": schedule,
        "tasks": tasks if isinstance(tasks, list) else tasks.get("items", []),
        "overrides": schedule.get("overrides") or [],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True))
    print(
        f"wrote {OUT.relative_to(OUT.parent.parent.parent)} - "
        f"{len(schedule.get('decisionLog') or [])} decision entries, "
        f"{len(payload['tasks'])} tasks, {len(payload['overrides'])} overrides"
    )


if __name__ == "__main__":
    main()
