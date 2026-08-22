"""Asset Criticality Score - implements PRD FR2.1.

    "Compute an Asset Criticality Score per asset from: passenger-traffic
     dependency, alternate-route availability, safety importance, historical
     failure frequency, number of trains affected."

The PRD names the five inputs but not how to combine them, so the formula here
is this project's answer, built on one stated principle:

    **Criticality is the consequence of failure.**

That is what orders the weights (see CRITICALITY_WEIGHTS in config.py):
consequence terms - safety importance, trains affected, lack of an alternate
route, passenger dependency - outweigh the one likelihood term, historical
failure frequency. Likelihood is scored separately as predicted failure risk
under FR2.2, and weighting it heavily here would double-count probability into
a score that is supposed to measure impact.

Four of the five inputs are simulated. **`trainsAffectedCount` is real** - it
comes from the observed train count on the corridor section (T3), and this
module will refuse to accept a value that was not supplied.

The function is pure and has no randomness, so it can be unit-tested directly
and re-run against real inputs later without touching the generator.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from generators.config import (
    CRITICALITY_WEIGHTS,
    FAILURE_FREQ_REFERENCE_MAX,
    TRAINS_AFFECTED_REFERENCE_MAX,
)


@dataclass(frozen=True)
class CriticalityInputs:
    """The five FR2.1 inputs. Only `trains_affected_count` is real data."""

    #: 0-1. Share of the section's importance driven by passenger service.
    passenger_dependency: float
    #: True when traffic can be diverted if this asset is out.
    alternate_route_available: bool
    #: 0-1. How directly a failure of this asset threatens safety.
    safety_importance: float
    #: Simulated failures per year for this asset.
    historical_failure_freq: float
    #: REAL - observed trains per day on the section (T3 `trainsObserved`).
    trains_affected_count: int


def normalise_trains_affected(count: int, reference_max: int = TRAINS_AFFECTED_REFERENCE_MAX) -> float:
    """Scale an observed train count onto 0-1 using a log curve.

    **Log, not linear, and the choice is measured rather than stylistic.** Train
    counts across the network span two orders of magnitude (median 24, maximum
    281). On a linear scale 70.3% of sections land below 0.2, so the component
    stops discriminating between the ordinary majority of sections. On a log1p
    scale only 10.7% do, and the middle 80% of sections spread across 0.65 of
    the range instead of 0.42.

    The reference maximum is a fixed constant rather than the maximum of
    whatever set is being scored, so an asset's score does not change when the
    corridor selection changes.
    """
    if count <= 0:
        return 0.0
    return min(1.0, math.log1p(count) / math.log1p(reference_max))


def normalise_failure_frequency(
    failures_per_year: float, reference_max: float = FAILURE_FREQ_REFERENCE_MAX
) -> float:
    """Scale simulated failure frequency onto 0-1, capped at the reference."""
    if failures_per_year <= 0:
        return 0.0
    return min(1.0, failures_per_year / reference_max)


def criticality_components(inputs: CriticalityInputs) -> dict[str, float]:
    """The five normalised 0-1 components, before weighting.

    Exposed separately so FR2.4 can show *which factor dominated* for an asset
    rather than only the final number - the explainability requirement means a
    score that cannot be broken down is not good enough.
    """
    return {
        "safety_importance": _clamp(inputs.safety_importance),
        "trains_affected": normalise_trains_affected(inputs.trains_affected_count),
        # Inverted deliberately: having NO alternate route is what raises
        # criticality, because there is nowhere to divert traffic to.
        "no_alternate_route": 0.0 if inputs.alternate_route_available else 1.0,
        "passenger_dependency": _clamp(inputs.passenger_dependency),
        "historical_failure_freq": normalise_failure_frequency(inputs.historical_failure_freq),
    }


def criticality_score(inputs: CriticalityInputs) -> float:
    """Weighted criticality score on a 0-100 scale, rounded to 2 decimals.

    0-100 rather than 0-1 purely for readability on the dashboard; the weights
    sum to 1.0 so the score is a genuine weighted average, not an arbitrary
    total that could drift if a component were added later.
    """
    components = criticality_components(inputs)
    total = sum(CRITICALITY_WEIGHTS[name] * value for name, value in components.items())
    return round(100.0 * total, 2)


def dominant_factor(inputs: CriticalityInputs) -> str:
    """Which weighted component contributed most - backs the FR2.4 breakdown."""
    components = criticality_components(inputs)
    return max(components, key=lambda name: CRITICALITY_WEIGHTS[name] * components[name])


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


# Fail loudly at import time if the weights are ever edited into an invalid set:
# a score presented as a weighted average must actually be one.
_weight_total = sum(CRITICALITY_WEIGHTS.values())
if abs(_weight_total - 1.0) > 1e-9:
    raise ValueError(f"CRITICALITY_WEIGHTS must sum to 1.0, got {_weight_total}")
