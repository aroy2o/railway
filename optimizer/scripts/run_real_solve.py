"""Run the CP-SAT scheduler against the real seeded corpus and print a report.

    python -m scripts.run_real_solve

Requires the backend API and MongoDB to be up, and `npm run seed` to have run.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import date

from app.core.scheduler import solve_schedule
from scripts.real_data import BackendUnavailable, load_scenario

HORIZON_START = date(2026, 8, 24)  # Monday after the dataset reference date


def main() -> int:
    try:
        tasks, corridors = load_scenario(horizon_start=HORIZON_START)
    except BackendUnavailable as exc:
        print(f"backend unavailable: {exc}", file=sys.stderr)
        return 1

    print(f"loaded {len(tasks)} tasks across {len(corridors)} corridors")
    print(f"priority source: FR2.3 engine (range "
          f"{min(t.priority for t in tasks)}-{max(t.priority for t in tasks)})")

    result = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7)
    payload = result.as_dict()

    print(f"\nstatus {payload['status']} | objective {payload['objectiveValue']:,} "
          f"| solve {payload['solveSeconds']}s")
    print(json.dumps(payload["metrics"], indent=2))

    print("\ndeferral reasons:")
    for reason, count in Counter(d["reason"] for d in payload["deferredTasks"]).most_common():
        print(f"  {reason:<26} {count}")

    print("\ncross-department batches:")
    for block in payload["blocks"]:
        if block["isCrossDepartmentBatch"]:
            print(f"  {block['corridorId']} {block['date']} {block['start']}-{block['end']}  "
                  f"{block['departments']}  tasks {block['taskIds']}")

    print("\nknown gaps (deliberately not modelled in T6):")
    for name, gap in payload["knownGaps"].items():
        print(f"  {name}: {gap['count']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
