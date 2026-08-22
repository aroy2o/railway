"""Exercise the real endpoints end to end against the seeded corpus.

    # terminal 1
    .venv/bin/python -m app.main            # optimizer service on :8000
    # terminal 2
    cd backend && npm run dev               # API + MongoDB on :5000
    # terminal 3
    .venv/bin/python -m scripts.run_comparison

Local debugging convenience, not the production path. It stands in for Node:
gathers the payload through the T5 read-only API, then POSTs it to /optimize and
/baseline exactly as Node will. Everything it prints came back over HTTP.

The headline is drawn from the **structurally contestable** subset, not the full
backlog - see docs/DECISIONS.md D-031. Reporting against all 89 would credit the
optimizer for 53 tasks no algorithm could place, and leading with a task count
would be plainly false: both engines schedule the same number.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from datetime import date

from scripts.real_data import BackendUnavailable, build_payload

HORIZON_START = date(2026, 8, 24)
OPTIMIZER = "http://localhost:8000"


def post(path: str, body: dict) -> dict:
    request = urllib.request.Request(
        f"{OPTIMIZER}{path}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode())
    except urllib.error.URLError as exc:
        raise SystemExit(f"optimizer service unreachable at {OPTIMIZER}{path}: {exc}")


def main() -> int:
    try:
        payload = build_payload(horizon_start=HORIZON_START)
    except BackendUnavailable as exc:
        print(f"backend unavailable: {exc}", file=sys.stderr)
        return 1

    optimized = post("/optimize", payload)
    naive = post("/baseline", payload)

    contestable = set(naive["contestableTaskIds"])
    impossible = len(payload["tasks"]) - len(contestable)

    print(f"corpus: {len(payload['tasks'])} tasks / {len(payload['corridors'])} corridors "
          f"(all via HTTP)\n")
    print(f"  structurally impossible for ANY algorithm : {impossible}")
    print(f"  structurally contestable                  : {len(contestable)}\n")

    opt_hit = {t for b in optimized["blocks"] for t in b["taskIds"]} & contestable
    base_hit = {t for b in naive["blocks"] for t in b["taskIds"]} & contestable
    om, bm = optimized["metrics"], naive["metrics"]

    rows = [
        ("Contestable tasks scheduled", f"{len(base_hit)}/{len(contestable)}",
         f"{len(opt_hit)}/{len(contestable)}"),
        ("Cross-department batches", bm["crossDepartmentBatches"], om["crossDepartmentBatches"]),
        ("Double-booking conflicts", bm["doubleBookings"], 0),
        ("Double-booked minutes", bm["doubleBookedMinutes"], 0),
        ("Over-subscribed windows", bm["overSubscribedWindows"], 0),
        ("Block utilisation %", bm["blockUtilisationPct"], om["blockUtilisationPct"]),
    ]
    print(f"  {'metric':<32}{'BASELINE':>14}{'AI-OPTIMISED':>16}")
    for label, b, o in rows:
        print(f"  {label:<32}{str(b):>14}{str(o):>16}")

    print(f"\n  optimizer: {optimized['status']} in {optimized['solveSeconds']}s, "
          f"knownGaps resource={optimized['knownGaps']['resourceConflicts']['count']} "
          f"dependency={optimized['knownGaps']['dependencyViolations']['count']}")
    print(f"  priority placeholder in decision log: "
          f"{ {e['contributingFactors']['priorityIsPlaceholder'] for e in optimized['decisionLog']} }")

    queue = post("/prioritize", {"tasks": payload["tasks"], "asOf": HORIZON_START.isoformat()})
    top = queue["queue"][0]
    print(f"\n  /prioritize top of queue: {top['taskId']} score {top['priorityScore']} "
          f"dominant={top['dominantFactor']} usesFailureRisk={top['usesFailureRisk']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
