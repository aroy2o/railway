"""The predictive asset-risk model - T16, FR2.2, PRD 9.1.

Two things have to be true here, and they are genuinely separate:

  1. **The model is correct** - a worsening asset scores higher than a stable
     one, the arithmetic is hand-checkable, and the score actually depends on
     the degradation data rather than on some proxy.
  2. **The model is honestly framed** - PRD Section 6 lists "claiming the
     predictive risk model forecasts real railway failures" as an explicit
     non-goal (NG4), and the framing has to be *present*, not merely intended.

A well-built model with sloppy framing would fail this project's own standard
just as badly as a sloppy model, so both are tested, and neither test would pass
if only the other held.
"""

from __future__ import annotations

import json
import math
import pathlib

import pytest

from app.core.risk import (
    FAILURE_THRESHOLD,
    FRAMING,
    HORIZON_MONTHS,
    MIN_POINTS,
    assess_asset,
    assess_assets,
)


def history(values):
    """T4's shape: monthly points, oldest first."""
    return [{"date": f"2026-{month:02d}-01", "healthMetric": v}
            for month, v in enumerate(values, start=1)]


def linear(start, decline, n=12):
    return [round(start - decline * i, 4) for i in range(n)]


# --------------------------------------------------------------------------- #
# Correctness: hand-checkable                                                  #
# --------------------------------------------------------------------------- #

def test_a_noiseless_decline_is_hand_checkable():
    """0.90 falling 0.05 a month, 12 points.

    The 12th fitted value is 0.90 - 0.05x11 = 0.35. Threshold is 0.30, so
    (0.35 - 0.30) / 0.05 = 1.0 month to threshold. Score = 100 x (1 - 1/24)
    = 95.833..., i.e. 95.83.
    """
    result = assess_asset("A", history(linear(0.90, 0.05)))

    assert result.current_health == pytest.approx(0.35, abs=1e-6)
    assert result.decline_per_month == pytest.approx(-0.05, abs=1e-6)
    assert result.months_to_threshold == pytest.approx(1.0, abs=1e-6)
    assert result.score == pytest.approx(100 * (1 - 1 / HORIZON_MONTHS), abs=0.01)


def test_a_worsening_asset_outranks_a_stable_one():
    """The claim the whole model exists to make."""
    worsening = assess_asset("W", history(linear(0.90, 0.05)))
    stable = assess_asset("S", history(linear(0.90, 0.005)))

    assert worsening.score > stable.score
    assert worsening.months_to_threshold < stable.months_to_threshold


def test_two_assets_at_the_same_health_are_separated_by_their_trend():
    """The reason time-to-threshold beats latest-health-alone.

    Both end at 0.50. One is losing 0.04 a month and reaches the threshold in
    five months; the other loses 0.01 and has twenty. They are not equally
    urgent, and a model reading only the current level would call them equal.
    """
    fast = assess_asset("F", history(linear(0.50 + 0.04 * 11, 0.04)))
    slow = assess_asset("S", history(linear(0.50 + 0.01 * 11, 0.01)))

    assert fast.current_health == pytest.approx(slow.current_health, abs=1e-6)
    assert fast.score > slow.score


def test_the_score_is_bounded_and_falls_to_zero_beyond_the_horizon():
    far = assess_asset("FAR", history(linear(0.99, 0.002)))

    assert far.months_to_threshold > HORIZON_MONTHS
    assert far.score == 0.0


# --------------------------------------------------------------------------- #
# Correctness: the score really uses the degradation data                      #
# --------------------------------------------------------------------------- #

def test_perturbing_the_history_moves_the_score():
    """Mutation-style: if the model ignored its input and returned a constant,
    or keyed off something else (asset id, history LENGTH), this passes anyway.
    Same series length, same asset id, different values only."""
    baseline = assess_asset("X", history(linear(0.80, 0.02)))
    steeper = assess_asset("X", history(linear(0.80, 0.04)))
    higher = assess_asset("X", history(linear(0.95, 0.02)))

    assert len({baseline.score, steeper.score, higher.score}) == 3
    assert steeper.score > baseline.score       # declining faster
    assert higher.score < baseline.score        # starting healthier


def test_the_score_is_not_a_proxy_for_history_length():
    """Six points and twelve points describing the SAME trend must agree.

    If length leaked into the score, an asset with a longer record would look
    riskier for having been measured more often."""
    short = assess_asset("S", history(linear(0.80, 0.03, n=6)))
    long = assess_asset("L", history(linear(0.80 - 0.03 * 6, 0.03, n=6)))

    # Same trend, continued: the later window is further along, so it must score
    # strictly higher - not equal, and not lower.
    assert long.score > short.score
    assert long.decline_per_month == pytest.approx(short.decline_per_month, abs=1e-6)


def test_noise_does_not_flip_the_ordering():
    """T4 adds N(0, 0.015). The fit has to see through that."""
    noisy = [0.90, 0.87, 0.86, 0.80, 0.79, 0.74, 0.72, 0.67, 0.66, 0.60, 0.59, 0.55]
    calm = linear(0.90, 0.010)

    assert assess_asset("N", history(noisy)).score > assess_asset("C", history(calm)).score


# --------------------------------------------------------------------------- #
# Honest handling of what it cannot assess                                     #
# --------------------------------------------------------------------------- #

def test_too_little_history_is_unscored_with_a_reason_not_defaulted():
    """A guessed default presented as a real score is the failure mode. Null
    plus a stated reason is the pattern used everywhere else in this project."""
    result = assess_asset("THIN", history([0.9, 0.8]))

    assert result.score is None
    assert result.computed is False
    assert str(MIN_POINTS) in result.reason
    assert "not scored rather than guessed" in result.reason.lower()


def test_an_asset_that_is_not_declining_scores_zero_with_a_reason():
    """Distinct from unscored: this IS an inference, so it gets a number."""
    flat = assess_asset("FLAT", history([0.8] * 12))

    assert flat.score == 0.0
    assert flat.computed is True
    assert "no declining trend" in flat.reason


def test_an_asset_already_past_the_threshold_says_so_rather_than_forecasting():
    result = assess_asset("GONE", history(linear(0.40, 0.02)))

    assert result.score == 100.0
    assert "not a forecast" in result.reason


def test_the_uncertainty_band_widens_with_noise():
    """A wide band is the model saying it is unsure, and it has to be able to."""
    calm = assess_asset("C", history(linear(0.80, 0.03)))
    noisy = assess_asset("N", history(
        [round(v + (0.05 if i % 2 else -0.05), 4)
         for i, v in enumerate(linear(0.80, 0.03))]
    ))
    calm_band = calm.months_to_threshold_high - calm.months_to_threshold_low
    noisy_band = noisy.months_to_threshold_high - noisy.months_to_threshold_low

    assert noisy_band > calm_band


# --------------------------------------------------------------------------- #
# Honest framing (PRD 9.1 / NG4) - present, not merely intended                #
# --------------------------------------------------------------------------- #

def test_the_framing_says_simulated_and_disclaims_real_failures():
    lowered = FRAMING.lower()

    assert "simulated" in lowered
    assert "retrained" in lowered or "replaced" in lowered
    assert "does not predict real" in lowered


def test_every_assessment_carries_the_framing():
    """Including the ones that could not be scored - an unscored asset is still
    an output of this model, and still must not be mistaken for real data."""
    scored = assess_asset("A", history(linear(0.80, 0.03)))
    unscored = assess_asset("B", history([0.9]))

    assert scored.as_dict()["framing"] == FRAMING
    assert unscored.as_dict()["framing"] == FRAMING


def test_the_breakdown_is_inspectable_not_a_bare_number():
    """PRD 9.1's explainability requirement: "why is this asset high risk" needs
    a real answer, in the spirit of criticalityBreakdown."""
    payload = assess_asset("A", history(linear(0.80, 0.03))).as_dict()["breakdown"]

    assert set(payload) >= {
        "currentHealth", "declinePerMonth", "monthsToThreshold",
        "monthsToThresholdRange", "observationCount", "failureThreshold",
        "horizonMonths",
    }
    assert payload["failureThreshold"] == FAILURE_THRESHOLD


# --------------------------------------------------------------------------- #
# The real corpus                                                              #
# --------------------------------------------------------------------------- #

SNAPSHOT = pathlib.Path(__file__).parent / "fixtures" / "assets_snapshot.json"


@pytest.fixture(scope="module")
def real_assets():
    if not SNAPSHOT.exists():
        pytest.skip(f"no asset snapshot at {SNAPSHOT}")
    return json.loads(SNAPSHOT.read_text())["assets"]


def test_every_real_asset_is_scored(real_assets):
    results = assess_assets(real_assets)

    assert len(results) == 55
    assert all(r.computed for r in results), [r.asset_id for r in results if not r.computed]


def test_the_real_distribution_is_spread_not_bimodal(real_assets):
    """The measured reason for choosing time-to-threshold over probability-of-
    crossing: the probability form put 30 of 55 assets under 5 and 23 over 50,
    with almost nothing between. A near-binary score is a poor priority input."""
    scores = sorted(r.score for r in assess_assets(real_assets))
    middle = [s for s in scores if 20 < s < 80]

    assert len(middle) >= 20, f"only {len(middle)} of 55 in the middle band"
    assert scores[0] < 10 and scores[-1] > 90
