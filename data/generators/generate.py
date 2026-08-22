"""Generation of the synthetic maintenance layer (PRD Section 5.2).

Everything produced here is simulated, and every record says so. What it is
*anchored to* is real: corridor sections and their observed train counts and
class mix come from `data/ingestion`, so the synthetic demand sits on top of
genuine railway geography and genuine traffic rather than floating free.

All randomness flows through one seeded generator, and every collection is
built in sorted order, so a given seed reproduces a given dataset exactly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import numpy as np

from generators import config
from generators.criticality import (
    CriticalityInputs,
    criticality_components,
    criticality_score,
    dominant_factor,
)


@dataclass(frozen=True)
class SelectedCorridor:
    """A real corridor section chosen to carry synthetic maintenance demand."""

    corridor_id: str
    name: str
    zone: str | None
    band: str
    #: REAL - observed trains per day (T3).
    trains_observed: int
    #: REAL - observed utilisation of the 24-hour day (T3).
    utilisation_pct: float
    #: REAL - derived from T3's raw class mix.
    passenger_dependency: float
    #: REAL - count of usable free windows (T3).
    block_windows: int


# --------------------------------------------------------------------------- #
# Corridor selection                                                           #
# --------------------------------------------------------------------------- #

def passenger_dependency(class_mix: dict[str, int]) -> float:
    """Share of premium/long-distance services among classified trains.

    Codes whose meaning was not confidently established are excluded from both
    sides rather than guessed into one. A section with no classified trains
    returns a neutral fallback - absence of evidence is not evidence of low
    dependency.
    """
    premium = sum(n for code, n in class_mix.items() if code in config.PREMIUM_CLASS_CODES)
    local = sum(n for code, n in class_mix.items() if code in config.LOCAL_CLASS_CODES)
    classified = premium + local

    if classified == 0:
        return config.PASSENGER_DEPENDENCY_FALLBACK
    return round(premium / classified, 4)


def select_corridors(
    corridors: dict[str, dict], calendar: dict[str, dict]
) -> list[SelectedCorridor]:
    """Choose the real sections that will carry synthetic maintenance demand.

    Two rules, both deliberate:

    1. **Only sections T3 did not flag.** A `lowConfidence` section is either a
       skip-halt pair that is not one maintainable unit, or has no timed traffic
       at all. Generating a maintenance backlog against either would anchor
       synthetic data to a corridor the pipeline itself does not trust.

    2. **Spread across the real utilisation range.** A dataset drawn only from
       quiet corridors would let the optimizer schedule everything and prove
       nothing; one drawn only from saturated corridors would defer everything.
       The interesting decisions live in between.

    3. **And spread across the traffic range within each band.** Sections are
       taken at evenly spaced percentiles of observed traffic inside the band,
       not simply the busiest.

       That third rule was added after the first attempt: taking the busiest of
       each band produced 30 corridors whose train counts ran 134-281, so
       `trainsAffectedCount` - a real FR2.1 criticality input - barely varied,
       and criticality scores compressed into a narrow high band. Spanning
       percentiles keeps the busiest section of each band (the top percentile is
       always included) while restoring genuine variation in the input.

    Fully deterministic: no randomness is involved in selection at all.
    """
    usable = [
        entry
        for entry in calendar.values()
        if not entry["lowConfidence"] and entry["_id"] in corridors
    ]

    selected: list[SelectedCorridor] = []
    for band, lower, upper, count in config.UTILISATION_BANDS:
        in_band = [e for e in usable if lower < e["utilisationPct"] <= upper]
        # Ascending by traffic; section id breaks ties so the order never
        # depends on dictionary iteration order.
        in_band.sort(key=lambda e: (e["trainsObserved"], e["_id"]))

        if len(in_band) < count:
            raise ValueError(
                f"utilisation band {band!r} has only {len(in_band)} sections, need {count}"
            )

        # Evenly spaced percentiles across the band's traffic range, inclusive of
        # both ends, so the quietest and busiest section of each band are both
        # represented.
        step = (len(in_band) - 1) / (count - 1) if count > 1 else 0
        picks = sorted({int(round(i * step)) for i in range(count)})
        while len(picks) < count:  # collapse from rounding on a short band
            for candidate in range(len(in_band)):
                if candidate not in picks:
                    picks.append(candidate)
                    break
            picks.sort()

        for entry in (in_band[i] for i in picks[:count]):
            corridor = corridors[entry["_id"]]
            selected.append(
                SelectedCorridor(
                    corridor_id=entry["_id"],
                    name=corridor["name"],
                    zone=corridor["zone"],
                    band=band,
                    trains_observed=entry["trainsObserved"],
                    utilisation_pct=entry["utilisationPct"],
                    passenger_dependency=passenger_dependency(entry["trainClassMix"]),
                    block_windows=len(entry["maxDailyBlockWindows"]),
                )
            )

    selected.sort(key=lambda c: c.corridor_id)
    return selected


# --------------------------------------------------------------------------- #
# Resources (PRD Section 15 `resources`, PRD 5.2 / 9.8)                        #
# --------------------------------------------------------------------------- #

def build_resources(selected: list[SelectedCorridor]) -> list[dict[str, Any]]:
    """Create depot-scoped crews, machines and permissions.

    Resources are shared across the corridors a depot covers rather than being
    per-corridor. That is both realistic - one tower wagon serves a section of
    the division, not a single block - and the thing that creates genuine
    resource contention for PRD 9.8: two tasks on different corridors competing
    for the same machine at the same time.
    """
    resources: list[dict[str, Any]] = []
    depot_count = max(1, -(-len(selected) // config.CORRIDORS_PER_DEPOT))  # ceil

    for depot_index in range(depot_count):
        start = depot_index * config.CORRIDORS_PER_DEPOT
        scope = [c.corridor_id for c in selected[start : start + config.CORRIDORS_PER_DEPOT]]
        if not scope:
            continue
        depot = f"D{depot_index + 1:02d}"

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
                            # Extension beyond the PRD shape: which department
                            # owns this resource. Needed to assign a task the
                            # right crew without re-deriving it from the name.
                            "department": department,
                            "depot": depot,
                            "synthetic": True,
                        }
                    )

    return resources


# --------------------------------------------------------------------------- #
# Assets (PRD Section 15 `assets`)                                             #
# --------------------------------------------------------------------------- #

def generate_assets(
    selected: list[SelectedCorridor], rng: np.random.Generator
) -> list[dict[str, Any]]:
    """One to three physical assets per corridor, with an FR2.1 criticality score.

    Asset types are allocated by **exact quota**, not by independent draws.

    That matters. PRD 5.2 specifies the department mix as a property of the
    dataset (Engineering 50%, S&T 30%, TRD 20%), and at this size - roughly 60
    assets - independent sampling misses it badly: the first run of this
    generator produced a 34/42/24 task split, with S&T over-represented by 12
    percentage points purely through sampling noise. A quota fixes the mix by
    construction while the shuffle keeps *which* corridor gets *which* type
    random.

    A corridor can legitimately hold two track segments; types are not drawn
    without replacement, since forcing every three-asset corridor to hold one of
    each type would flatten the mix towards uniform, which PRD 5.2 explicitly
    does not want.
    """
    assets: list[dict[str, Any]] = []
    low, high = config.ASSETS_PER_CORRIDOR

    # Draw every corridor's asset count first, so the total is known before the
    # type quota is allocated against it.
    counts = [int(rng.integers(low, high + 1)) for _ in selected]
    asset_types = _allocate_asset_types(sum(counts), rng)

    cursor = 0
    for corridor, count in zip(selected, counts):
        for index in range(count):
            asset_type = asset_types[cursor]
            cursor += 1
            asset_id = f"AST-{corridor.corridor_id}-{index + 1}"

            # --- the four simulated criticality inputs ----------------------
            safety = float(
                np.clip(
                    config.SAFETY_IMPORTANCE_BY_TYPE[asset_type]
                    + rng.uniform(-config.SAFETY_IMPORTANCE_JITTER, config.SAFETY_IMPORTANCE_JITTER),
                    0.0,
                    1.0,
                )
            )
            # A busier section is less likely to have spare capacity elsewhere
            # to divert onto, so alternate-route availability is made to depend
            # on real traffic rather than being a free coin flip.
            divert_probability = float(np.clip(0.75 - corridor.trains_observed / 400.0, 0.1, 0.75))
            alternate_route = bool(rng.random() < divert_probability)
            failure_freq = round(float(rng.gamma(shape=1.5, scale=0.6)), 3)

            inputs = CriticalityInputs(
                passenger_dependency=corridor.passenger_dependency,  # REAL
                alternate_route_available=alternate_route,
                safety_importance=round(safety, 4),
                historical_failure_freq=failure_freq,
                trains_affected_count=corridor.trains_observed,  # REAL
            )

            assets.append(
                {
                    "_id": asset_id,
                    "corridorId": corridor.corridor_id,
                    "assetType": asset_type,
                    "department": config.ASSET_TYPES[asset_type],
                    "criticality": {
                        "passengerDependency": corridor.passenger_dependency,
                        "alternateRouteAvailable": alternate_route,
                        "safetyImportance": round(safety, 4),
                        "historicalFailureFreq": failure_freq,
                        "trainsAffectedCount": corridor.trains_observed,
                    },
                    "criticalityScore": criticality_score(inputs),
                    # FR2.4 requires showing *why* a score is what it is, so the
                    # breakdown ships with the asset rather than being recomputed.
                    "criticalityBreakdown": {
                        name: round(value, 4)
                        for name, value in criticality_components(inputs).items()
                    },
                    "dominantCriticalityFactor": dominant_factor(inputs),
                    "degradationHistory": _degradation_history(rng),
                    "synthetic": True,
                }
            )

    return assets


def _allocate_asset_types(total: int, rng: np.random.Generator) -> list[str]:
    """Build exactly `total` asset types matching the PRD 5.2 department mix.

    Largest-remainder allocation, so the realised proportions are as close to
    the target as integer counts permit, and the leftover from rounding goes to
    the departments with the largest fractional shortfall rather than to
    whichever happens to be first.
    """
    type_names = sorted(config.ASSET_TYPES)
    shares = {name: config.DEPARTMENT_MIX[config.ASSET_TYPES[name]] for name in type_names}

    exact = {name: total * share for name, share in shares.items()}
    quota = {name: int(value) for name, value in exact.items()}

    remainder = total - sum(quota.values())
    for name in sorted(type_names, key=lambda n: (-(exact[n] - quota[n]), n))[:remainder]:
        quota[name] += 1

    allocation = [name for name in type_names for _ in range(quota[name])]
    rng.shuffle(allocation)
    return allocation


def _degradation_history(rng: np.random.Generator) -> list[dict[str, Any]]:
    """A simulated asset-health series (PRD 9.1).

    SIMULATED, and framed that way everywhere it appears. This is a plausible
    monotone-decline-with-noise pattern, NOT observed Indian Railways asset
    health - no such public data exists. It is here so the predictive risk model
    (T16) has a shape to train against, and it is explicitly designed to be
    replaced by real historical asset-health data when that becomes available.
    Any claim that this predicts real failures would be false.
    """
    health = float(rng.uniform(0.75, 1.0))
    decline = float(rng.uniform(0.01, 0.045))
    series: list[dict[str, Any]] = []

    for step in range(config.DEGRADATION_POINTS):
        observed_on = config.REFERENCE_DATE - timedelta(
            days=(config.DEGRADATION_POINTS - 1 - step) * config.DEGRADATION_INTERVAL_DAYS
        )
        noisy = float(np.clip(health + rng.normal(0.0, 0.015), 0.0, 1.0))
        series.append({"date": observed_on.isoformat(), "healthMetric": round(noisy, 4)})
        health = max(0.0, health - decline)

    return series


# --------------------------------------------------------------------------- #
# Tasks (PRD Section 15 `tasks`)                                               #
# --------------------------------------------------------------------------- #

def generate_tasks(
    assets: list[dict[str, Any]],
    resources: list[dict[str, Any]],
    rng: np.random.Generator,
) -> list[dict[str, Any]]:
    """Pending maintenance tasks, following the PRD 5.2 distributions.

    Severity is Beta-distributed rather than uniform, which is the difference
    between a credible backlog (mostly routine work, a handful of urgent items)
    and an implausible one where a fifth of all defects are critical.
    """
    by_corridor_dept: dict[tuple[str, str], list[dict]] = {}
    for resource in resources:
        for corridor_id in resource["corridorScope"]:
            by_corridor_dept.setdefault((corridor_id, resource["department"]), []).append(resource)

    tasks: list[dict[str, Any]] = []
    counter = 0

    for asset in assets:
        department = asset["department"]
        low, high = config.TASKS_PER_ASSET
        task_count = int(rng.integers(low, high + 1))
        if task_count == 0:
            continue

        # PRD 5.2 makes dependencies optional, so only a minority of assets get
        # a multi-stage workflow. A chain needs at least two tasks to exist.
        as_chain = task_count >= 2 and bool(rng.random() < config.DEPENDENCY_CHAIN_RATE)

        # Chain members describe stages of one underlying defect, so they share
        # its severity, defect type and raise date.
        shared_severity = _draw_severity(rng)
        shared_defect = str(rng.choice(config.DEFECT_TYPES[department]))
        shared_raised = _draw_date_raised(rng)

        previous_id: str | None = None
        for stage_index in range(task_count):
            counter += 1
            task_id = f"TSK-{counter:05d}"

            if as_chain:
                severity, defect_type, raised = shared_severity, shared_defect, shared_raised
                stage = config.DEPENDENCY_STAGES[
                    min(stage_index, len(config.DEPENDENCY_STAGES) - 1)
                ]
                depends_on = previous_id
            else:
                severity = _draw_severity(rng)
                defect_type = str(rng.choice(config.DEFECT_TYPES[department]))
                raised = _draw_date_raised(rng)
                stage, depends_on = None, None

            duration_low, duration_high = config.BLOCK_DURATION_MINS[department]
            pool = by_corridor_dept.get((asset["corridorId"], department), [])
            primary, required = _assign_resources(pool, rng)

            tasks.append(
                {
                    "_id": task_id,
                    "department": department,
                    "corridorId": asset["corridorId"],
                    "assetId": asset["_id"],
                    "defectType": defect_type,
                    "severity": severity,
                    "dateRaised": raised.isoformat(),
                    "slaDueDate": (
                        raised + timedelta(days=config.SLA_DAYS_BY_SEVERITY[severity])
                    ).isoformat(),
                    "estBlockDurationMins": int(rng.integers(duration_low, duration_high + 1)),
                    "requiredResourceId": primary,
                    # Extension beyond the PRD's singular field: PRD 5.2 describes
                    # a task needing a crew AND a machine AND a permission, so the
                    # full set is kept for the resource-conflict model (9.8, T25).
                    "requiredResourceIds": required,
                    "dependsOnTaskId": depends_on,
                    "workflowStage": stage,
                    # Populated downstream, never guessed here:
                    #   priorityScore    -> T7  (FR2.3)
                    #   failureRiskScore -> T16 (FR2.2 / 9.1)
                    "priorityScore": None,
                    "failureRiskScore": None,
                    "status": "pending",
                    "synthetic": True,
                }
            )
            previous_id = task_id

    return tasks


def _draw_severity(rng: np.random.Generator) -> int:
    """Severity 1-5 from a Beta draw (PRD 5.2: skewed, explicitly not uniform)."""
    alpha, beta = config.SEVERITY_BETA
    return int(np.clip(np.floor(rng.beta(alpha, beta) * 5) + 1, 1, 5))


def _draw_date_raised(rng: np.random.Generator) -> date:
    """A raise date within the last 90 days of the fixed reference date."""
    return config.REFERENCE_DATE - timedelta(
        days=int(rng.integers(0, config.DATE_RAISED_WINDOW_DAYS))
    )


def _assign_resources(
    pool: list[dict[str, Any]], rng: np.random.Generator
) -> tuple[str | None, list[str]]:
    """Pick one crew, one machine and one permission from the depot's pool.

    ``requiredResourceId`` points at the **machine** where one exists, because
    machines are the genuinely scarce resource - a depot has one tower wagon and
    several gangs - so that is where contention actually bites (PRD 9.8). It
    falls back to the crew when the department's catalogue has no machine.
    """
    chosen: list[str] = []
    picked_by_type: dict[str, str] = {}

    for resource_type in ("crew", "machine", "permission"):
        candidates = sorted(r["_id"] for r in pool if r["type"] == resource_type)
        if not candidates:
            continue
        selection = str(rng.choice(candidates))
        picked_by_type[resource_type] = selection
        chosen.append(selection)

    primary = picked_by_type.get("machine") or picked_by_type.get("crew")
    return primary, chosen
