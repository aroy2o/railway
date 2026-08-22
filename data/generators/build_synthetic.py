"""Generate the synthetic maintenance dataset (task T4, PRD Section 5.2).

Reads the real outputs of `data/ingestion` and writes the simulated layer:

    processed/assets.json      physical assets + FR2.1 criticality scores
    processed/tasks.json       pending maintenance/defect backlog
    processed/resources.json   depot-scoped crews, machines, permissions
    processed/SYNTHETIC_REPORT.json  realised distributions, for verification

    python -m generators.build_synthetic

Reproducible by seed, not by luck: `config.RANDOM_SEED` and
`config.REFERENCE_DATE` together fix the output exactly. Re-running without
changing either reproduces byte-identical files.

Everything written here is SIMULATED - see config.SYNTHETIC_DISCLAIMER, which
is embedded in every output file.
"""

from __future__ import annotations

import json
import sys
from collections import Counter

import numpy as np

from generators import config, generate
from ingestion.build_corridors import PROCESSED_DIR, _write_json
from ingestion.build_timetable import CALENDAR_OUT
from ingestion.build_corridors import CORRIDORS_OUT

ASSETS_OUT = PROCESSED_DIR / "assets.json"
TASKS_OUT = PROCESSED_DIR / "tasks.json"
RESOURCES_OUT = PROCESSED_DIR / "resources.json"
REPORT_OUT = PROCESSED_DIR / "SYNTHETIC_REPORT.json"

#: Which fields came from measured data rather than being generated. Embedded in
#: the output so a downstream consumer never has to guess, and so a reviewer can
#: check the real/synthetic boundary without reading this code.
FIELD_PROVENANCE = {
    "real": {
        "corridorId": "T2 - derived from datameet/railways route data",
        "criticality.trainsAffectedCount": "T3 - observed trains per day on the section",
        "criticality.passengerDependency": "T3 - premium share of the observed train class mix",
    },
    "synthetic": {
        "criticality.safetyImportance": "simulated, seeded by asset type",
        "criticality.alternateRouteAvailable": "simulated, probability varies with real traffic",
        "criticality.historicalFailureFreq": "simulated - no public failure history exists",
        "degradationHistory": "simulated asset-health series (PRD 9.1)",
        "tasks.*": "entirely simulated: defect, severity, dates, duration, resources",
    },
    "computedDownstream": {
        "tasks.priorityScore": "T7 (FR2.3)",
        "tasks.failureRiskScore": "T16 (FR2.2 / 9.1)",
    },
}


def _load(path, key):
    if not path.exists():
        raise SystemExit(
            f"{path.name} missing. Run the ingestion pipeline first:\n"
            "  python -m ingestion.download\n"
            "  python -m ingestion.build_corridors\n"
            "  python -m ingestion.build_timetable"
        )
    return {entry["_id"]: entry for entry in json.loads(path.read_text())[key]}


def build() -> dict:
    print("Loading real corridors and occupancy calendar…")
    corridors = _load(CORRIDORS_OUT, "corridors")
    calendar = _load(CALENDAR_OUT, "calendar")

    selected = generate.select_corridors(corridors, calendar)
    print(f"  selected {len(selected)} corridors across "
          f"{len({c.band for c in selected})} utilisation bands")

    rng = np.random.default_rng(config.RANDOM_SEED)

    resources = generate.build_resources(selected)
    assets = generate.generate_assets(selected, rng)
    tasks = generate.generate_tasks(assets, resources, rng)
    print(f"  {len(resources)} resources, {len(assets)} assets, {len(tasks)} tasks")

    report = _build_report(selected, assets, tasks, resources)

    header = {
        "synthetic": True,
        "disclaimer": config.SYNTHETIC_DISCLAIMER,
        "seed": config.RANDOM_SEED,
        "referenceDate": config.REFERENCE_DATE.isoformat(),
        "fieldProvenance": FIELD_PROVENANCE,
    }

    _write_json(ASSETS_OUT, {**header, "count": len(assets), "assets": assets})
    _write_json(TASKS_OUT, {**header, "count": len(tasks), "tasks": tasks})
    _write_json(RESOURCES_OUT, {**header, "count": len(resources), "resources": resources})
    _write_json(REPORT_OUT, report)

    for path in (ASSETS_OUT, TASKS_OUT, RESOURCES_OUT, REPORT_OUT):
        print(f"Wrote {path.relative_to(PROCESSED_DIR.parent)} ({path.stat().st_size:,} bytes)")

    return report


def _build_report(selected, assets, tasks, resources) -> dict:
    severities = Counter(t["severity"] for t in tasks)
    departments = Counter(t["department"] for t in tasks)
    total = len(tasks) or 1

    # Cross-department batching is the core value proposition, so the report
    # states up front whether the dataset can actually demonstrate it.
    dept_by_corridor: dict[str, set[str]] = {}
    for task in tasks:
        dept_by_corridor.setdefault(task["corridorId"], set()).add(task["department"])

    durations_ok = all(
        config.BLOCK_DURATION_MINS[t["department"]][0]
        <= t["estBlockDurationMins"]
        <= config.BLOCK_DURATION_MINS[t["department"]][1]
        for t in tasks
    )

    return {
        "task": "T4 - synthetic maintenance data generator (PRD 5.2)",
        "seed": config.RANDOM_SEED,
        "referenceDate": config.REFERENCE_DATE.isoformat(),
        "anchoring": {
            "corridors_selected": len(selected),
            "selection_rule": "busiest sections in each utilisation band, "
            "excluding every section T3 flagged lowConfidence",
            "by_band": dict(Counter(c.band for c in selected)),
            "trains_observed_range": [
                min(c.trains_observed for c in selected),
                max(c.trains_observed for c in selected),
            ],
            "corridors_with_zero_block_windows": sum(1 for c in selected if c.block_windows == 0),
        },
        "assets": {
            "count": len(assets),
            "by_type": dict(Counter(a["assetType"] for a in assets)),
            "criticality_score": _spread(a["criticalityScore"] for a in assets),
            "dominant_factor": dict(Counter(a["dominantCriticalityFactor"] for a in assets)),
        },
        "tasks": {
            "count": len(tasks),
            "severity_distribution": {
                str(level): {
                    "count": severities.get(level, 0),
                    "pct": round(100 * severities.get(level, 0) / total, 1),
                }
                for level in range(1, 6)
            },
            "severity_mean": round(sum(t["severity"] for t in tasks) / total, 2),
            "department_split_pct": {
                dept: round(100 * count / total, 1) for dept, count in sorted(departments.items())
            },
            "department_target_pct": {k: round(100 * v, 1) for k, v in config.DEPARTMENT_MIX.items()},
            "block_duration_within_prd_ranges": durations_ok,
            "with_dependency": sum(1 for t in tasks if t["dependsOnTaskId"]),
            "defect_types_used": dict(Counter(t["defectType"] for t in tasks)),
        },
        "batching_potential": {
            "corridors_with_tasks": len(dept_by_corridor),
            "corridors_with_multiple_departments": sum(
                1 for depts in dept_by_corridor.values() if len(depts) > 1
            ),
        },
        "resources": {
            "count": len(resources),
            "by_type": dict(Counter(r["type"] for r in resources)),
            "depots": len({r["depot"] for r in resources}),
        },
    }


def _spread(values) -> dict:
    ordered = sorted(values)
    if not ordered:
        return {}
    return {
        "min": ordered[0],
        "median": ordered[len(ordered) // 2],
        "max": ordered[-1],
    }


def main() -> int:
    report = build()
    print("\n--- synthetic dataset report ---")
    print(json.dumps({k: report[k] for k in ("anchoring", "tasks", "batching_potential")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
