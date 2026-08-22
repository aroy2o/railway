"""Service health endpoints.

/health       liveness  - answers whenever the process is up.
/health/ready readiness - 503 unless OR-Tools CP-SAT is importable, because a
              solver service that cannot construct a model is not useful even
              though its HTTP layer is fine.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Response, status

from app import __version__
from app.config import get_settings
from app.models.health import HealthResponse, ReadinessResponse, SolverCheck

logger = logging.getLogger(__name__)
router = APIRouter(tags=["health"])


def _check_solver() -> SolverCheck:
    """Import CP-SAT and build a trivial model to prove the wheel really loads.

    A bare `import` is not enough: the OR-Tools wheel ships native libraries
    that can fail at first use rather than at import time.
    """
    try:
        from ortools.sat.python import cp_model

        model = cp_model.CpModel()
        model.new_bool_var("readiness_probe")
        return SolverCheck(available=True, backend="ortools.sat.python.cp_model")
    except Exception as exc:  # noqa: BLE001 - readiness must never raise
        logger.exception("CP-SAT readiness probe failed")
        return SolverCheck(
            available=False,
            backend="ortools.sat.python.cp_model",
            detail=f"{type(exc).__name__}: {exc}",
        )


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    settings = get_settings()
    return HealthResponse(
        status="ok",
        service="optimizer",
        version=__version__,
        env=settings.node_env,
        timestamp=datetime.now(timezone.utc),
    )


@router.get("/health/ready", response_model=ReadinessResponse)
def ready(response: Response) -> ReadinessResponse:
    settings = get_settings()
    solver = _check_solver()

    if not solver.available:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return ReadinessResponse(
        status="ready" if solver.available else "not-ready",
        checks={"solver": solver},
        explain_enabled=settings.explain_enabled,
        timestamp=datetime.now(timezone.utc),
    )
