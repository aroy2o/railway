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
    """Score each asset's likelihood of reaching the intervention threshold."""
    assessments = assess_assets(
        [
            {
                "assetId": asset.asset_id,
                "degradationHistory": [
                    {"healthMetric": point.health_metric} for point in asset.degradation_history
                ],
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
        "modelType": "linear-trend-extrapolation-to-threshold",
    }
