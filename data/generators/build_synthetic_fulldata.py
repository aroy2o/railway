"""Generate assets/tasks/resources for the fulldata-ktv-psa branch.

Reads the real corridor set (build_corridors_fulldata) and real occupancy
calendar (build_timetable_fulldata) already written to data/processed/, plus
full_data's own DGP-simulated, gate-validated maintenance layer
(full_data/data/synthetic/asset_days.csv, full_data/data/processed/
cp_sat_tasks_v2.csv - see full_data/release/MANIFEST.md Gates 0-6), and
produces:

    processed/assets.json
    processed/tasks.json
    processed/resources.json
    processed/FULLDATA_SYNTHETIC_REPORT.json

    python -m generators.build_synthetic_fulldata

This is a MAPPING layer, not a re-derivation: full_data's own DGP has already
been gate-validated (train/test split with zero overlap, calibrated ROC-AUC
0.7225 against a ceiling of 0.749 - see full_data/release/MANIFEST.md), so its
distributions are reused rather than re-simulated from scratch here.

Two things this project's own criticality/resource model still had to supply,
because full_data has no equivalent concept:
  - Resources (crew/machine/permission) - full_data's own scheduler explicitly
    does not model crew capacity as a hard constraint (see
    full_data/release/integration_package/README.md "Known Limitations"). This
    branch keeps the existing resource no-double-booking constraint, so
    resources are generated the same way `generators.generate.build_resources`
    already does it, just scoped to the new KTV-PSA corridor set.
  - The FR2.1 criticality score (safetyImportance, alternateRouteAvailable,
    historicalFailureFreq) - full_data has no such concept at all. Generated
    with the exact same seeded methodology `generators.generate.generate_assets`
    already uses (see ASSUMPTIONS below), just fed real trainsAffectedCount/
    passengerDependency derived from full_data's own real freight+passenger
    counts instead of datameet's IR class-code mix.

ASSUMPTIONS (flagged, not hidden):
  - severity (1-5, required by the current Task schema) is derived from
    cp_sat_tasks_v2.csv's own `priority_band` (LOW/MEDIUM/HIGH, a 3-level
    scale) as LOW->2, MEDIUM->3, HIGH->4. full_data's task table carries no
    finer-grained severity signal than this.
  - dateRaised is set to REFERENCE_DATE for every task (full_data's task table
    has no raise-date field, only a scheduling-horizon minute offset);
    slaDueDate is REFERENCE_DATE + deadline_min.
  - dependsOnTaskId/workflowStage are always null - full_data's task table has
    no dependency/workflow-stage concept (a real capability gap, documented in
    the branch plan, not silently dropped).
  - `month` (1-24) is carried through as a static snapshot value from
    asset_days.csv's latest available row per asset, not a live-advancing
    calendar month - full_data's own model card admits the same limitation
    (see full_data/release/integration_package/README.md "Known Limitations").
"""

from __future__ import annotations

import csv
import json
import sys
from collections import Counter, defaultdict
from datetime import timedelta

import numpy as np

from generators import config
from generators.criticality import CriticalityInputs, criticality_components, criticality_score, dominant_factor
from generators.generate import _assign_resources
from ingestion.build_corridors_fulldata import CORRIDORS_OUT
from ingestion.build_timetable_fulldata import CALENDAR_OUT
from ingestion.fulldata_sources import ASSET_DAYS_CSV, CP_SAT_TASKS_CSV, PROCESSED_DIR, SOURCE_CITATION

ASSETS_OUT = PROCESSED_DIR / "assets.json"
TASKS_OUT = PROCESSED_DIR / "tasks.json"
RESOURCES_OUT = PROCESSED_DIR / "resources.json"
REPORT_OUT = PROCESSED_DIR / "FULLDATA_SYNTHETIC_REPORT.json"

#: department string normalisation: full_data uses "ENGINEERING"/"S&T"/"TRD".
DEPARTMENT_NORMALISE = {"ENGINEERING": "Engineering", "S&T": "S&T", "TRD": "TRD"}

#: inverse of config.ASSET_TYPES ({"track": "Engineering", ...}).
DEPARTMENT_TO_ASSET_TYPE = {dept: kind for kind, dept in config.ASSET_TYPES.items()}

#: cp_sat_tasks_v2.csv's `priority_band` -> Task.severity (1-5). See module
#: docstring ASSUMPTIONS.
SEVERITY_BY_BAND = {"LOW": 2, "MEDIUM": 3, "HIGH": 4}

DISCLAIMER = (
    "SYNTHETIC DATA (fulldata-ktv-psa branch). Maintenance tasks and asset "
    "condition/defect features are DGP-simulated by full_data's own gate-"
    "validated pipeline (full_data/release/MANIFEST.md Gates 3-5: calibrated "
    "ROC-AUC 0.7225 against a ceiling of 0.749), not measured Indian Railways "
    "TMS/SMMS/TDMS data. Anchored to the real KTV-PSA corridor and real "
    "freight+passenger traffic volume (full_data/data/real, "
    "processed/traffic_profiles.csv) - passengerDependency and "
    "trainsAffectedCount below are real counts, not simulated. Resource "
    "catalogue and FR2.1 criticality inputs beyond trainsAffectedCount/"
    "passengerDependency are simulated with the same seeded methodology as "
    "the project's original synthetic generator (generators.generate)."
)

FIELD_PROVENANCE = {
    "real": {
        "corridorId": "build_corridors_fulldata - full_data/data/real/route_ktv_psa.csv",
        "criticality.trainsAffectedCount": "processed/traffic_profiles.csv - real daily freight+passenger count",
        "criticality.passengerDependency": "processed/traffic_profiles.csv - real passenger share of traffic",
    },
    "synthetic": {
        "criticality.safetyImportance": "simulated, seeded by asset type (generators.config)",
        "criticality.alternateRouteAvailable": "simulated, probability varies with real traffic",
        "criticality.historicalFailureFreq": "simulated - no public failure history exists",
        "degradationHistory": "full_data DGP-simulated per-asset condition time series (gate-validated)",
        "ageYears/condition/openDefects*/daysSinceMaintenance/tonnageStress/month": (
            "full_data DGP-simulated (synthetic/asset_days.csv), gate-validated, latest snapshot per asset"
        ),
        "tasks.*": "full_data DGP-simulated (processed/cp_sat_tasks_v2.csv), gate-validated",
    },
    "computedDownstream": {
        "tasks.priorityScore": "this app's own FR2.3 engine, computed on demand (not full_data's own priority_score)",
        "tasks.failureRiskScore": "this app's calibrated LightGBM risk model, computed on demand via /risk",
    },
}


def _load_collection(path, key) -> dict[str, dict]:
    payload = json.loads(path.read_text())
    return {entry["_id"]: entry for entry in payload[key]}


def _load_asset_snapshots() -> dict[str, dict]:
    """asset_id -> latest-available row from asset_days.csv (highest `date`)."""
    latest: dict[str, dict] = {}
    with ASSET_DAYS_CSV.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            asset_id = row["asset_id"]
            current = latest.get(asset_id)
            if current is None or row["date"] > current["date"]:
                latest[asset_id] = row
    return latest


def _load_asset_histories() -> dict[str, list[dict]]:
    """asset_id -> full sorted (date, condition) time series, for degradationHistory."""
    history: dict[str, list[dict]] = defaultdict(list)
    with ASSET_DAYS_CSV.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            history[row["asset_id"]].append(row)
    for rows in history.values():
        rows.sort(key=lambda r: r["date"])
    return history


def _load_tasks_raw() -> list[dict]:
    with CP_SAT_TASKS_CSV.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def build_resources_for(corridor_ids: list[str]) -> tuple[list[dict], dict[str, str]]:
    """Depot-scoped resources over the fulldata corridor set (same algorithm as
    generators.generate.build_resources, inlined because that function takes
    the original pipeline's SelectedCorridor dataclass, which this branch has
    no equivalent of - see module docstring)."""
    resources: list[dict] = []
    corridor_depot: dict[str, str] = {}
    depot_count = max(1, -(-len(corridor_ids) // config.CORRIDORS_PER_DEPOT))

    for depot_index in range(depot_count):
        start = depot_index * config.CORRIDORS_PER_DEPOT
        scope = corridor_ids[start : start + config.CORRIDORS_PER_DEPOT]
        if not scope:
            continue
        depot = f"D{depot_index + 1:02d}"
        for corridor_id in scope:
            corridor_depot[corridor_id] = depot

        for department, by_type in sorted(config.RESOURCE_CATALOGUE.items()):
            for resource_type, names in sorted(by_type.items()):
                for name in names:
                    slug = name.lower().replace(" ", "-").replace(".", "")
                    resources.append(
                        {
                            "_id": f"RES-{depot}-{slug}",
                            "type": resource_type,
                            "name": f"{name} ({depot})",
                            "corridorScope": scope,
                            "department": department,
                            "depot": depot,
                            "synthetic": True,
                        }
                    )
    return resources, corridor_depot


def build() -> dict:
    print("Loading fulldata corridors + calendar…")
    corridors = _load_collection(CORRIDORS_OUT, "corridors")
    calendar = _load_collection(CALENDAR_OUT, "calendar")
    corridor_ids = sorted(corridors)
    print(f"  {len(corridor_ids):,} corridor-line documents")

    print("Building resources…")
    resources, corridor_depot = build_resources_for(corridor_ids)
    print(f"  {len(resources)} resources across {len(set(corridor_depot.values()))} depots")

    print("Loading asset_days.csv snapshots + histories…")
    snapshots = _load_asset_snapshots()
    histories = _load_asset_histories()
    print(f"  {len(snapshots):,} assets")

    rng = np.random.default_rng(config.RANDOM_SEED)
    assets: list[dict] = []
    skipped_unknown_corridor = 0
    skipped_low_confidence = 0

    for asset_id in sorted(snapshots):
        row = snapshots[asset_id]
        block_section = row["block_section"]
        line_number = int(float(row["line_number"]))
        corridor_id = f"{block_section}#L{line_number}"
        corridor = corridors.get(corridor_id)
        if corridor is None:
            skipped_unknown_corridor += 1
            continue
        # Same rule the original pipeline's generate.select_corridors applies:
        # never anchor generated maintenance demand to a corridor the calendar
        # itself does not trust (no traffic data to derive real occupancy
        # from). The optimizer's own /optimize validation enforces this as a
        # hard rule too - it refuses a scenario containing a lowConfidence
        # corridor outright, which is what surfaced this during manual
        # end-to-end testing of this branch.
        if (calendar.get(corridor_id) or {}).get("lowConfidence"):
            skipped_low_confidence += 1
            continue

        department = DEPARTMENT_NORMALISE.get(row["department"], row["department"])
        asset_type = DEPARTMENT_TO_ASSET_TYPE.get(department, "track")
        cal = calendar.get(corridor_id, {})
        class_mix = cal.get("trainClassMix", {})
        freight = class_mix.get("FREIGHT", 0)
        passenger = class_mix.get("PASSENGER", 0)
        trains_observed = cal.get("trainsObserved", freight + passenger)
        passenger_dependency = round(passenger / (freight + passenger), 4) if (freight + passenger) else 0.5

        safety = float(
            np.clip(
                config.SAFETY_IMPORTANCE_BY_TYPE[asset_type]
                + rng.uniform(-config.SAFETY_IMPORTANCE_JITTER, config.SAFETY_IMPORTANCE_JITTER),
                0.0,
                1.0,
            )
        )
        divert_probability = float(np.clip(0.75 - trains_observed / 400.0, 0.1, 0.75))
        alternate_route = bool(rng.random() < divert_probability)
        failure_freq = round(float(rng.gamma(shape=1.5, scale=0.6)), 3)

        inputs = CriticalityInputs(
            passenger_dependency=passenger_dependency,
            alternate_route_available=alternate_route,
            safety_importance=round(safety, 4),
            historical_failure_freq=failure_freq,
            trains_affected_count=trains_observed,
        )

        degradation_history = [
            {"date": h["date"], "healthMetric": round(float(h["condition"]), 4)}
            for h in histories.get(asset_id, [])
        ]

        assets.append(
            {
                "_id": asset_id,
                "corridorId": corridor_id,
                "assetType": asset_type,
                "department": department,
                "criticality": {
                    "passengerDependency": passenger_dependency,
                    "alternateRouteAvailable": alternate_route,
                    "safetyImportance": round(safety, 4),
                    "historicalFailureFreq": failure_freq,
                    "trainsAffectedCount": trains_observed,
                },
                "criticalityScore": criticality_score(inputs),
                "criticalityBreakdown": {
                    name: round(value, 4) for name, value in criticality_components(inputs).items()
                },
                "dominantCriticalityFactor": dominant_factor(inputs),
                "degradationHistory": degradation_history,
                "synthetic": True,
                # --- fulldata-branch ML feature fields (see module docstring) ---
                "blockSection": block_section,
                "lineNumber": line_number,
                "ageYears": round(float(row["age_years"]), 3),
                "condition": round(float(row["condition"]), 4),
                "openDefectsCount": int(row["open_defects_count"]),
                "openDefectsSev0": int(row["open_defects_sev0"]),
                "openDefectsSev1": int(row["open_defects_sev1"]),
                "openDefectsSev2": int(row["open_defects_sev2"]),
                "openDefectsSev3": int(row["open_defects_sev3"]),
                "daysSinceMaintenance": float(row["days_since_maintenance"]),
                "tonnageStress": round(float(row["tonnage_stress"]), 4),
                "month": int(row["month"]),
            }
        )

    known_asset_ids = {a["_id"] for a in assets}

    print("Loading cp_sat_tasks_v2.csv…")
    raw_tasks = _load_tasks_raw()
    reference_date = config.REFERENCE_DATE
    tasks: list[dict] = []
    skipped_unknown_asset = 0

    for row in raw_tasks:
        asset_id = row["asset_id"]
        if asset_id not in known_asset_ids:
            skipped_unknown_asset += 1
            continue

        block_section = row["block_section"]
        line_number = int(float(row["line_number"]))
        corridor_id = f"{block_section}#L{line_number}"
        department = DEPARTMENT_NORMALISE.get(row["department"], row["department"])
        deadline_min = int(float(row["deadline_min"]))
        depot = corridor_depot.get(corridor_id)

        pool = [r for r in resources if r["department"] == department and r["depot"] == depot]
        primary, required = _assign_resources(pool, rng)
        permission_id = f"RES-{depot}-{row['required_block_type'].replace('_', '-')}" if depot else None
        if permission_id and permission_id not in {r["_id"] for r in pool} :
            permission_id = None
        if permission_id and permission_id not in required:
            required = [*required, permission_id]

        tasks.append(
            {
                "_id": row["task_id"],
                "department": department,
                "corridorId": corridor_id,
                "assetId": asset_id,
                "defectType": row["task_type"],
                "severity": SEVERITY_BY_BAND.get(row["priority_band"], 3),
                "dateRaised": reference_date.isoformat(),
                "slaDueDate": (reference_date + timedelta(minutes=deadline_min)).isoformat(),
                "estBlockDurationMins": int(float(row["total_block_minutes"])),
                "requiredResourceId": primary,
                "requiredResourceIds": required,
                "dependsOnTaskId": None,
                "workflowStage": None,
                "priorityScore": None,
                "failureRiskScore": None,
                "status": "pending",
                "synthetic": True,
                "blockSection": block_section,
                "lineNumber": line_number,
            }
        )

    header = {
        "synthetic": True,
        "disclaimer": DISCLAIMER,
        "seed": config.RANDOM_SEED,
        "referenceDate": reference_date.isoformat(),
        "fieldProvenance": FIELD_PROVENANCE,
    }

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    _write(ASSETS_OUT, {**header, "count": len(assets), "assets": assets})
    _write(TASKS_OUT, {**header, "count": len(tasks), "tasks": tasks})
    _write(RESOURCES_OUT, {**header, "count": len(resources), "resources": resources})

    report = {
        "task": "fulldata-ktv-psa branch: synthetic maintenance layer (KTV-PSA)",
        "assets": {
            "count": len(assets),
            "skippedUnknownCorridor": skipped_unknown_corridor,
            "skippedLowConfidenceCorridor": skipped_low_confidence,
            "byType": dict(Counter(a["assetType"] for a in assets)),
            "criticalityScoreRange": [
                min((a["criticalityScore"] for a in assets), default=None),
                max((a["criticalityScore"] for a in assets), default=None),
            ],
        },
        "tasks": {
            "count": len(tasks),
            "skippedUnknownAsset": skipped_unknown_asset,
            "severityDistribution": dict(Counter(t["severity"] for t in tasks)),
            "departmentSplitPct": {
                dept: round(100 * count / max(len(tasks), 1), 1)
                for dept, count in Counter(t["department"] for t in tasks).items()
            },
        },
        "resources": {"count": len(resources), "depots": len(set(corridor_depot.values()))},
        "sourceCitation": SOURCE_CITATION,
    }
    REPORT_OUT.write_text(json.dumps(report, indent=2) + "\n")

    for path in (ASSETS_OUT, TASKS_OUT, RESOURCES_OUT, REPORT_OUT):
        print(f"Wrote {path} ({path.stat().st_size:,} bytes)")

    return report


def _write(path, payload) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def main() -> int:
    report = build()
    print("\n--- fulldata synthetic dataset report ---")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
