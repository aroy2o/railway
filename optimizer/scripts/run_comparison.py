"""Run the optimizer and the naive baseline on the same real corpus.

    python -m scripts.run_comparison

Dev harness for T8. The API endpoint and the comparison screen are T9 and T14.

The headline is drawn from the **structurally contestable** subset, not the full
backlog - see docs/DECISIONS.md D-031. Reporting "36 vs N out of 89" would credit
the optimizer for 53 tasks that no algorithm could place, which is exactly the
kind of technically-true-but-misleading number PRD Section 18 warns against.
"""

from __future__ import annotations

import sys
from datetime import date

from app.core.baseline import run_baseline, structurally_contestable
from app.core.scheduler import solve_schedule
from scripts.real_data import BackendUnavailable, load_scenario

HORIZON_START = date(2026, 8, 24)


def main() -> int:
    try:
        tasks, corridors = load_scenario(horizon_start=HORIZON_START)
    except BackendUnavailable as exc:
        print(f"backend unavailable: {exc}", file=sys.stderr)
        return 1

    optimized = solve_schedule(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7)
    baseline = run_baseline(tasks, corridors, horizon_start=HORIZON_START, horizon_days=7)

    contestable = structurally_contestable(tasks, corridors)
    impossible = len(tasks) - len(contestable)

    print(f"corpus: {len(tasks)} tasks / {len(corridors)} corridors, weekly horizon\n")
    print(f"  structurally impossible for ANY algorithm : {impossible}")
    print(f"  structurally contestable                  : {len(contestable)}")
    print("  (the comparison below is drawn from the contestable set)\n")

    opt_hit = optimized.scheduled_task_ids & contestable
    base_hit = baseline.scheduled_task_ids & contestable

    om, bm = optimized.metrics(), baseline.metrics()
    rows = [
        ("Contestable tasks scheduled", f"{len(base_hit)}/{len(contestable)}",
         f"{len(opt_hit)}/{len(contestable)}"),
        ("Cross-department batches", bm["crossDepartmentBatches"], om["crossDepartmentBatches"]),
        ("Double-booking conflicts", bm["doubleBookings"], 0),
        ("Double-booked minutes", bm["doubleBookedMinutes"], 0),
        ("Over-subscribed windows", bm["overSubscribedWindows"], 0),
        ("Distinct windows claimed", bm["distinctWindowsClaimed"], om["blocksUsed"]),
        ("Block minutes used", bm["blockMinutesUsed"], om["blockMinutesUsed"]),
        ("Block utilisation %", bm["blockUtilisationPct"], om["blockUtilisationPct"]),
    ]
    print(f"  {'metric':<32}{'BASELINE':>14}{'AI-OPTIMISED':>16}")
    for label, b, o in rows:
        print(f"  {label:<32}{str(b):>14}{str(o):>16}")

    print(f"\n  baseline double-bookings in detail:")
    for conflict in baseline.double_bookings:
        print(f"    {conflict.corridor_id} {conflict.day} "
              f"{conflict.departments[0]}/{conflict.departments[1]} "
              f"overlap {conflict.overlap_minutes} min ({conflict.task_ids[0]}, {conflict.task_ids[1]})")

    only_opt = sorted(opt_hit - base_hit)
    only_base = sorted(base_hit - opt_hit)
    print(f"\n  scheduled by optimizer only: {only_opt or 'none'}")
    print(f"  scheduled by baseline only : {only_base or 'none'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
