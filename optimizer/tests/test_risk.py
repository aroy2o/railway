"""The predictive asset-risk model - T16, FR2.2, PRD 9.1.

fulldata-ktv-psa BRANCH: rewritten for the calibrated LightGBM model that
replaces the original linear-trend heuristic (see app/core/risk.py's module
docstring for the full rationale). Three things have to be true here, and
they are genuinely separate:

  1. **The ported model reproduces full_data's own validated output.**
     `tests/fixtures/fulldata_risk_fixture.json` pins 8 real assets from this
     branch's seeded data against the exact calibrated probability
     full_data's own live model produced for them
     (full_data/data/processed/asset_failure_probs.csv, itself the output of
     full_data's gate-audited pipeline - see full_data/release/MANIFEST.md
     Gate 6). If this drifts, the port is wrong, not full_data's model.
  2. **Department-casing normalisation is load-bearing, not cosmetic.**
     LightGBM's categorical encoding is keyed on the exact training-time
     string ("ENGINEERING"), while this app's own schema stores "Engineering"
     title-case. Get this wrong and the model does not error - it silently
     mis-scores. A dedicated test locks this down.
  3. **The model is honestly framed** - PRD Section 6 lists "claiming the
     predictive risk model forecasts real railway failures" as an explicit
     non-goal (NG4), and the framing has to be *present*, not merely
     intended, on every assessment including unscored ones.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from app.core.risk import FEATURE_COLS, FRAMING, assess_assets

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "fulldata_risk_fixture.json"


@pytest.fixture(scope="module")
def fixture_assets() -> list[dict]:
    return json.loads(FIXTURE.read_text())["assets"]


def _feature_only(asset: dict) -> dict:
    return {k: v for k, v in asset.items() if k != "expectedCalibratedProbability"}


# --------------------------------------------------------------------------- #
# Correctness: reproduces full_data's own gate-validated output               #
# --------------------------------------------------------------------------- #


def test_reproduces_fulldatas_own_calibrated_predictions(fixture_assets):
    """Regression-pins the port against real ground truth, not just internal
    consistency - a bug that silently shifted every score by a constant amount
    would pass a "does it run" test but fail this one."""
    records = [_feature_only(a) for a in fixture_assets]
    results = {r.asset_id: r for r in assess_assets(records)}

    assert len(results) == len(fixture_assets)
    for asset in fixture_assets:
        result = results[asset["assetId"]]
        assert result.computed, f"{asset['assetId']} should have scored"
        calibrated = result.score / 100.0
        assert calibrated == pytest.approx(asset["expectedCalibratedProbability"], abs=1e-3), (
            f"{asset['assetId']}: got {calibrated}, full_data's own live model gave "
            f"{asset['expectedCalibratedProbability']}"
        )


def test_a_worse_condition_scores_higher_all_else_equal(fixture_assets):
    """Sanity check the model actually reads its input, not a proxy: worsening
    one asset's condition and defect load must raise its risk, never lower it."""
    base = _feature_only(fixture_assets[0])
    worse = {
        **base,
        "assetId": "SANITY-WORSE",
        "condition": max(0.0, base["condition"] - 0.4),
        "openDefectsCount": base["openDefectsCount"] + 3,
        "openDefectsSev3": base["openDefectsSev3"] + 2,
        "daysSinceMaintenance": base["daysSinceMaintenance"] + 200,
    }
    results = {r.asset_id: r for r in assess_assets([base, worse])}

    assert results["SANITY-WORSE"].score > results[base["assetId"]].score


# --------------------------------------------------------------------------- #
# Department-casing normalisation - load-bearing, silently wrong if missed    #
# --------------------------------------------------------------------------- #


def test_title_case_department_is_normalised_to_the_models_training_casing(fixture_assets):
    """This app stores 'Engineering'/'S&T'/'TRD'; the model was trained on
    'ENGINEERING'/'S&T'/'TRD'. Passing the app's own casing straight through
    must still hit the model's real category, not an unseen-category code."""
    asset = next(a for a in fixture_assets if a["department"] == "Engineering")
    title_case = _feature_only(asset)
    upper_case = {**title_case, "department": "ENGINEERING"}

    title_result = assess_assets([title_case])[0]
    upper_result = assess_assets([upper_case])[0]

    assert title_result.computed and upper_result.computed
    assert title_result.score == pytest.approx(upper_result.score, abs=1e-6)


# --------------------------------------------------------------------------- #
# Honest handling of what it cannot assess                                    #
# --------------------------------------------------------------------------- #


def test_missing_features_are_unscored_with_a_reason_not_defaulted(fixture_assets):
    incomplete = {"assetId": "THIN", "department": "Engineering"}
    result = assess_assets([incomplete])[0]

    assert result.score is None
    assert result.computed is False
    assert "not scored rather than guessed" in result.reason.lower()
    for col in FEATURE_COLS:
        if col not in ("department",):
            assert col in result.reason


def test_partial_batch_scores_the_complete_assets_and_flags_the_incomplete_one(fixture_assets):
    """One bad asset in a batch must not take the others down with it."""
    complete = _feature_only(fixture_assets[0])
    incomplete = {"assetId": "PARTIAL-MISSING", "department": "TRD"}

    results = {r.asset_id: r for r in assess_assets([complete, incomplete])}

    assert results[complete["assetId"]].computed is True
    assert results["PARTIAL-MISSING"].computed is False


# --------------------------------------------------------------------------- #
# Honest framing (PRD 9.1 / NG4) - present, not merely intended               #
# --------------------------------------------------------------------------- #


def test_the_framing_disclaims_real_failures_and_states_it_is_simulated_dgp():
    lowered = FRAMING.lower()

    assert "dgp-simulated" in lowered or "simulated" in lowered
    assert "does not predict real" in lowered


def test_every_assessment_carries_the_framing_including_unscored_ones(fixture_assets):
    scored = assess_assets([_feature_only(fixture_assets[0])])[0]
    unscored = assess_assets([{"assetId": "NO-FEATURES"}])[0]

    assert scored.as_dict()["framing"] == FRAMING
    assert unscored.as_dict()["framing"] == FRAMING


def test_the_breakdown_is_inspectable_not_a_bare_number(fixture_assets):
    payload = assess_assets([_feature_only(fixture_assets[0])])[0].as_dict()["breakdown"]

    assert set(payload) >= {"rawProbability", "calibratedProbability", "modelType"}
    assert payload["modelType"] == "lightgbm-classifier-isotonic-calibrated"
