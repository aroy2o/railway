"""Predictive asset-risk model - implements FR2.2, PRD 9.1.

fulldata-ktv-psa BRANCH: this is the calibrated-LightGBM replacement for the
original linear-trend-extrapolation model, ported from
full_data/release/integration_package/scoring.py. See docs/DECISIONS.md and
the branch plan for why: the original model was a defensible choice for T4's
synthetic degradation series (see the file this replaced, still readable via
git history on `main`), but full_data's own pipeline had already trained and
gate-validated a real classifier against features this branch's Asset schema
now carries (ageYears, condition, openDefects*, daysSinceMaintenance,
tonnageStress - see build_synthetic_fulldata.py).

WHAT THIS IS, STATED FIRST
---------------------------
A LightGBM classifier, isotonic-calibrated, trained and evaluated ENTIRELY on
full_data's own DGP-simulated asset-day data (full_data/release/ml_data), not
on live Indian Railways TMS/SMMS/TDMS records. Validated metrics, from
full_data/release/MANIFEST.md Gates 4-5: test ROC-AUC 0.7225 against a ceiling
of 0.749 (so it is close to the best this synthetic data-generating process
allows, not an inflated/leaky number), Brier 0.0978 raw -> 0.0849 calibrated.
`FRAMING` below states this plainly and must travel with every score - PRD
Section 6 lists "claiming the predictive risk model forecasts real railway
failures" as an explicit non-goal (NG4), and that applies just as much to a
real trained classifier as it did to the simpler heuristic it replaces: the
model is real, the labels it learned from are not.

THE MODEL
---------
`app/ml_artifacts/failure_model_live.pkl` (LightGBM), `isotonic_calibrator_
live.pkl` (probability calibration) and `power_transformer_live.pkl` (Yeo-
Johnson transform fit at training time on the continuous features) - all
three are required together and loaded once, lazily, at first use.

Categorical features (`department`, `block_section`) are scored using
LightGBM's own `pandas_categorical` mapping baked into the pickled booster at
training time, keyed on the EXACT string values it saw then
("ENGINEERING"/"S&T"/"TRD", not "Engineering") - `_normalise_department`
below exists because this app's own Asset/Task schema stores "Engineering"
title-case. Passing the wrong casing does not error; LightGBM just treats it
as an unseen category and silently mis-scores the asset, which is exactly the
kind of quiet-wrongness this codebase's honesty discipline exists to prevent
- verified against full_data's own artifacts/lightgbm_failure_risk/
failure_risk_predictions.csv during development of this branch.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

#: The honesty framing PRD 9.1 asks for, verbatim enough to satisfy it.
#: Travels with every assessment. Asserted by tests at every layer it reaches.
FRAMING = (
    "Calibrated LightGBM failure-risk model, ported from full_data's gate-validated "
    "pipeline (test ROC-AUC 0.7225 vs. a 0.749 ceiling; see full_data/release/"
    "MANIFEST.md Gates 4-5). Trained and evaluated entirely on DGP-simulated asset-day "
    "data, NOT live Indian Railways TMS/SMMS/TDMS records - it does not predict real "
    "asset failures."
)

MODEL_DIR = Path(__file__).resolve().parent.parent / "ml_artifacts"

#: Order matters: must match power_transformer_live.pkl's fitted
#: feature_names_in_ and failure_model_live.pkl's feature_name_ exactly.
CONT_FEATURES = [
    "age_years",
    "condition",
    "open_defects_count",
    "open_defects_sev0",
    "open_defects_sev1",
    "open_defects_sev2",
    "open_defects_sev3",
    "days_since_maintenance",
    "tonnage_stress",
    "line_number",
    "month",
]
CAT_FEATURES = ["department", "block_section"]
FEATURE_COLS = CONT_FEATURES + CAT_FEATURES

#: This app's Asset.department enum -> the exact casing the model was trained
#: on (see module docstring). block_section needs no normalisation - it was
#: sourced from full_data's own CSVs unchanged all the way through
#: build_synthetic_fulldata.py, so the values already match.
_DEPARTMENT_TO_MODEL_CASING = {"Engineering": "ENGINEERING", "S&T": "S&T", "TRD": "TRD"}


@dataclass(frozen=True)
class RiskAssessment:
    """One asset's risk, with the reasoning that produced it.

    `score` is None when the model genuinely could not assess the asset (a
    required feature was missing) - reported with a `reason`, never defaulted
    to zero or a mid-range guess. Same "not computed is not the same as
    computed to be low" rule this project applies everywhere else (D-015,
    D-045).
    """

    asset_id: str
    score: float | None
    reason: str | None = None
    raw_probability: float | None = None

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
                "rawProbability": _round(self.raw_probability, 4),
                "calibratedProbability": _round(self.score / 100.0 if self.score is not None else None, 4),
                "modelType": "lightgbm-classifier-isotonic-calibrated",
            },
            "framing": FRAMING,
        }


def _round(value: float | None, places: int) -> float | None:
    return None if value is None else round(value, places)


@lru_cache(maxsize=1)
def _load_artifacts():
    import joblib

    logger.info("loading risk model artifacts from %s", MODEL_DIR)
    model = joblib.load(MODEL_DIR / "failure_model_live.pkl")
    calibrator = joblib.load(MODEL_DIR / "isotonic_calibrator_live.pkl")
    power_transformer = joblib.load(MODEL_DIR / "power_transformer_live.pkl")
    return model, calibrator, power_transformer


def assess_assets(assets: Iterable[dict[str, Any]]) -> list[RiskAssessment]:
    """Score a collection of `{assetId, ...features}` records.

    Feature keys are camelCase on the wire (`ageYears`, `openDefectsSev0`,
    `blockSection`, ...), matching `AssetRiskIn` in app/models/scheduling.py.
    An asset missing any required feature is reported unscored with a reason
    rather than guessed - ported logic from full_data's own
    scoring.py::score_assets, which raises on missing columns; here each
    asset is checked individually so one incomplete asset does not fail the
    whole batch.
    """
    import pandas as pd

    assets = list(assets)
    rows: list[dict[str, Any]] = []
    unscored: dict[str, RiskAssessment] = {}

    for asset in assets:
        asset_id = str(asset.get("assetId") or asset.get("asset_id") or "")
        department_raw = asset.get("department")
        department = _DEPARTMENT_TO_MODEL_CASING.get(department_raw, department_raw)

        feature_values = {
            "age_years": asset.get("ageYears"),
            "condition": asset.get("condition"),
            "open_defects_count": asset.get("openDefectsCount"),
            "open_defects_sev0": asset.get("openDefectsSev0"),
            "open_defects_sev1": asset.get("openDefectsSev1"),
            "open_defects_sev2": asset.get("openDefectsSev2"),
            "open_defects_sev3": asset.get("openDefectsSev3"),
            "days_since_maintenance": asset.get("daysSinceMaintenance"),
            "tonnage_stress": asset.get("tonnageStress"),
            "line_number": asset.get("lineNumber"),
            "month": asset.get("month"),
            "department": department,
            "block_section": asset.get("blockSection"),
        }
        missing = [col for col in FEATURE_COLS if feature_values.get(col) is None]
        if missing:
            unscored[asset_id] = RiskAssessment(
                asset_id=asset_id,
                score=None,
                reason=(
                    f"missing feature(s) for the risk model: {', '.join(missing)}. "
                    "Not scored rather than guessed."
                ),
            )
            continue

        rows.append({"asset_id": asset_id, **feature_values})

    scored: dict[str, RiskAssessment] = {}
    if rows:
        model, calibrator, power_transformer = _load_artifacts()
        df = pd.DataFrame(rows)
        df[CONT_FEATURES] = power_transformer.transform(df[CONT_FEATURES])
        for col in CAT_FEATURES:
            df[col] = df[col].astype("category")

        raw_probs = model.predict_proba(df[FEATURE_COLS])[:, 1]
        calibrated_probs = calibrator.predict(raw_probs)

        for asset_id, raw, calibrated in zip(df["asset_id"], raw_probs, calibrated_probs):
            scored[asset_id] = RiskAssessment(
                asset_id=asset_id,
                score=float(calibrated) * 100.0,
                raw_probability=float(raw),
            )

    # Preserve caller's input order; assets appearing more than once are
    # scored once and the result reused for each occurrence.
    ordered: list[RiskAssessment] = []
    for asset in assets:
        asset_id = str(asset.get("assetId") or asset.get("asset_id") or "")
        ordered.append(
            scored.get(asset_id)
            or unscored.get(asset_id)
            or RiskAssessment(asset_id=asset_id, score=None, reason="assetId missing from request")
        )
    return ordered
