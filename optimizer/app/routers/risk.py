"""`/risk` - the predictive asset-risk model (FR2.2, PRD 9.1, task T16).

Thin, like every router here: validate, delegate to `app.core.risk`, return.

No `response_model`, per D-033. The fields that keep this endpoint honest -
`framing`, `computed`, `reason` - are precisely the ones a response schema
drops silently, and dropping them would leave a bare number that looks like a
real failure prediction.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from app.core.risk import FRAMING, assess_assets
from app.models.scheduling import RiskRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["risk"])


@router.post("/risk")
def risk_endpoint(request: RiskRequest) -> dict:
    """Score each asset's calibrated 30-day failure probability."""
    assessments = assess_assets(
        [
            {
                "assetId": asset.asset_id,
                "department": asset.department,
                "blockSection": asset.block_section,
                "lineNumber": asset.line_number,
                "ageYears": asset.age_years,
                "condition": asset.condition,
                "openDefectsCount": asset.open_defects_count,
                "openDefectsSev0": asset.open_defects_sev0,
                "openDefectsSev1": asset.open_defects_sev1,
                "openDefectsSev2": asset.open_defects_sev2,
                "openDefectsSev3": asset.open_defects_sev3,
                "daysSinceMaintenance": asset.days_since_maintenance,
                "tonnageStress": asset.tonnage_stress,
                "month": asset.month,
            }
            for asset in request.assets
        ]
    )

    scored = [a for a in assessments if a.computed]
    logger.info("risk: %d assets, %d scored", len(assessments), len(scored))

    return {
        "assessments": [a.as_dict() for a in assessments],
        "count": len(assessments),
        "scoredCount": len(scored),
        # Repeated at the top level as well as per-assessment: a consumer that
        # reads only the envelope must not be able to miss it.
        "framing": FRAMING,
        "modelType": "lightgbm-classifier-isotonic-calibrated",
    }
