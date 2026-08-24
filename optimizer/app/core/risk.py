"""Predictive asset-risk model - implements FR2.2, PRD 9.1.

WHAT THIS IS, STATED FIRST
--------------------------
This model is trained on SIMULATED asset degradation data. It does not predict
real Indian Railways asset failures, and no output of it may be presented as if
it does. `FRAMING` below is the sentence that must travel with every score, and
a test asserts it reaches the API, the decision log and the explanation layer.

PRD Section 6 lists "claiming the predictive risk model forecasts real railway
failures" as an explicit non-goal (NG4). This module is written so that claim is
hard to make by accident.

THE MODEL: linear trend extrapolation to an intervention threshold
------------------------------------------------------------------
For each asset, fit ordinary least squares to its 12 monthly `healthMetric`
observations, extrapolate the fitted line to the intervention threshold, and
express the resulting time-to-threshold as a 0-100 score.

Chosen over the alternatives because it MATCHES THE DATA-GENERATING PROCESS.
T4 generates each asset as a constant per-asset decline rate plus N(0, 0.015)
observation noise (`data/generators/generate.py::_degradation_history`). A
linear fit is not an approximation of that - it is the right functional form,
and its two parameters are exactly the two the generator used.

Alternatives considered and rejected:

* **Gradient-boosted classifier / logistic regression.** There are no failure
  labels. T4 generated health series, not failure events, so a classifier would
  require labels derived from the same series it learns from - circular by
  construction, and any accuracy figure from it would measure nothing. PRD 9.1
  offers this as an option; the data does not support it.
* **Probability of crossing the threshold within a horizon.** Tried and
  measured. Observation noise (sigma ~ 0.0125) is small relative to the decline,
  so the predictive interval barely straddles the threshold: at a six-month
  horizon 30 of 55 assets scored under 5 and 23 scored over 50, with almost
  nothing between. A near-binary flag is a poor priority input. Time-to-
  threshold keeps the same information and stays continuous.
* **Latest observed health alone.** Simpler, and on this corpus it correlates
  -0.95 with the chosen score - but it discards the decline rate, and two assets
  at the same health with a 4x difference in decline rate are not equally
  urgent. See D-055 for the honest caveat about how correlated these are here.

WHAT A CONTROLLER CAN INSPECT
-----------------------------
The score decomposes the way `criticalityBreakdown` and `priorityBreakdown` do:
current fitted health, decline per month, and the resulting months-to-threshold,
plus the uncertainty band on that estimate. "Why is this asset high risk" has a
real answer - "it is at 0.34 and losing 0.041 a month, so it reaches the
intervention threshold in about one month" - not a number from a black box.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

#: The honesty framing PRD 9.1 asks for, verbatim enough to satisfy it.
#: Travels with every assessment. Asserted by tests at every layer it reaches.
FRAMING = (
    "Prototype predictive risk model trained on simulated asset degradation patterns, "
    "designed to be replaced/retrained using historical railway asset-health data when "
    "available. It does not predict real Indian Railways asset failures."
)

#: Health level treated as "needs intervention".
#:
#: T4's generator defines no failure threshold, so this is a modelling choice
#: and is stated as one. 0.30 sits just below the lowest current fitted health
#: in the corpus (0.317), which matters: a higher threshold would mean the model
#: reports assets as ALREADY past intervention, which is a statement about the
#: present dressed up as a prediction. At 0.30 every score is a genuine forecast.
FAILURE_THRESHOLD = 0.30

#: Beyond this, an asset is not a near-term concern and scores 0.
#:
#: Two years. Measured on the corpus: median time-to-threshold is 8.4 months and
#: only 3 of 55 assets exceed 24, so the cap expresses "not soon" without
#: flattening the distribution that actually carries the signal.
HORIZON_MONTHS = 24.0

#: OLS needs three points to have any residual degrees of freedom at all.
MIN_POINTS = 3

#: Observations are monthly (T4: DEGRADATION_INTERVAL_DAYS = 30).
DAYS_PER_STEP = 30


@dataclass(frozen=True)
class RiskAssessment:
    """One asset's risk, with the reasoning that produced it.

    `score` is None when the model genuinely could not assess the asset. That is
    reported with a `reason` rather than defaulted to zero or to a mid-range
    guess - the same "not computed is not the same as computed to be low"
    distinction this project draws for `priorityIsPlaceholder` (D-015) and for
    undetectable conflict types (D-045).
    """

    asset_id: str
    score: float | None
    reason: str | None = None
    current_health: float | None = None
    decline_per_month: float | None = None
    months_to_threshold: float | None = None
    #: 95% interval on `months_to_threshold`, from the OLS parameter standard
    #: errors. Wide bands are the model saying it is unsure, and it says so.
    months_to_threshold_low: float | None = None
    months_to_threshold_high: float | None = None
    observation_count: int = 0
    volatility: float | None = None

    @property
    def computed(self) -> bool:
        return self.score is not None

    def as_dict(self) -> dict[str, Any]:
        return {
            "assetId": self.asset_id,
            "failureRiskScore": None if self.score is None else round(self.score, 2),
            "computed": self.computed,
            "reason": self.reason,
            "breakdown": {
                "currentHealth": _round(self.current_health, 4),
                "declinePerMonth": _round(self.decline_per_month, 5),
                "monthsToThreshold": _round(self.months_to_threshold, 1),
                "monthsToThresholdRange": [
                    _round(self.months_to_threshold_low, 1),
                    _round(self.months_to_threshold_high, 1),
                ],
                "observationCount": self.observation_count,
                "volatility": _round(self.volatility, 4),
                "failureThreshold": FAILURE_THRESHOLD,
                "horizonMonths": HORIZON_MONTHS,
            },
            "framing": FRAMING,
        }


def _round(value: float | None, places: int) -> float | None:
    return None if value is None else round(value, places)


def _fit_line(values: Sequence[float]) -> tuple[float, float, float, float, float]:
    """OLS on evenly spaced observations.

    Returns (intercept, slope_per_step, residual_sigma, sxx, mean_x).
    """
    n = len(values)
    xs = range(n)
    mean_x = (n - 1) / 2.0
    mean_y = sum(values) / n
    sxx = sum((x - mean_x) ** 2 for x in xs)
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, values)) / sxx
    intercept = mean_y - slope * mean_x
    residuals = [y - (intercept + slope * x) for x, y in zip(xs, values)]
    # n-2 degrees of freedom: two parameters were fitted.
    sigma = math.sqrt(sum(r * r for r in residuals) / (n - 2))
    return intercept, slope, sigma, sxx, mean_x


def assess_asset(asset_id: str, history: Iterable[dict[str, Any]]) -> RiskAssessment:
    """Score one asset from its degradation history.

    `history` is T4's `degradationHistory`: dicts with `healthMetric`, oldest
    first. Only the values are used - the observations are evenly spaced by
    construction, and reading the dates would invite a false precision the
    generator does not support.
    """
    points = [
        float(point["healthMetric"])
        for point in history
        if isinstance(point, dict) and point.get("healthMetric") is not None
    ]

    if len(points) < MIN_POINTS:
        return RiskAssessment(
            asset_id=asset_id,
            score=None,
            reason=(
                f"only {len(points)} degradation observation(s); the trend model needs at "
                f"least {MIN_POINTS}. Not scored rather than guessed."
            ),
            observation_count=len(points),
        )

    intercept, slope_per_step, sigma, sxx, mean_x = _fit_line(points)
    n = len(points)
    last_x = n - 1
    current = intercept + slope_per_step * last_x

    common = {
        "asset_id": asset_id,
        "current_health": current,
        "decline_per_month": slope_per_step,
        "observation_count": n,
        "volatility": sigma,
    }

    if current <= FAILURE_THRESHOLD:
        # Already at or below the intervention threshold. That is an observation,
        # not a forecast, and the reason says so.
        return RiskAssessment(
            score=100.0,
            reason=(
                f"fitted health {current:.3f} is already at or below the intervention "
                f"threshold {FAILURE_THRESHOLD}; this reflects the current trend, not a forecast"
            ),
            months_to_threshold=0.0,
            **common,
        )

    if slope_per_step >= 0:
        # Flat or improving: extrapolation never reaches the threshold. A real
        # inference, so it is scored 0 rather than left unassessed.
        return RiskAssessment(
            score=0.0,
            reason="no declining trend in the observed history, so no threshold crossing is projected",
            **common,
        )

    months = (current - FAILURE_THRESHOLD) / (-slope_per_step)

    # 95% band on the crossing time, from the standard errors of the two fitted
    # parameters. Propagated through the ratio by evaluating it at the optimistic
    # and pessimistic ends of each - crude, but it is a band, not a p-value, and
    # a Controller reads it as "roughly this soon, give or take".
    se_slope = sigma / math.sqrt(sxx)
    se_current = sigma * math.sqrt(1.0 / n + (last_x - mean_x) ** 2 / sxx)
    fast_slope = -slope_per_step + 1.96 * se_slope
    slow_slope = max(1e-6, -slope_per_step - 1.96 * se_slope)
    low = max(0.0, (current - 1.96 * se_current - FAILURE_THRESHOLD) / fast_slope)
    high = (current + 1.96 * se_current - FAILURE_THRESHOLD) / slow_slope

    score = 100.0 * max(0.0, min(1.0, 1.0 - months / HORIZON_MONTHS))

    return RiskAssessment(
        score=score,
        months_to_threshold=months,
        months_to_threshold_low=low,
        months_to_threshold_high=high,
        **common,
    )


def assess_assets(assets: Iterable[dict[str, Any]]) -> list[RiskAssessment]:
    """Score a collection of `{assetId, degradationHistory}` records."""
    return [
        assess_asset(str(asset.get("assetId") or asset.get("_id")), asset.get("degradationHistory") or [])
        for asset in assets
    ]
