"""Smoke tests for the optimizer service shell.

Scope is deliberately narrow: these prove the app boots, the config loader
validates, and CP-SAT is genuinely usable in this environment. The substantive
solver tests arrive with task T6 (CLAUDE.md testing priority 1).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import Settings


def test_health_reports_liveness(client):
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "optimizer"


def test_readiness_confirms_cp_sat_is_usable(client):
    """Guards the highest-risk dependency in the project (PRD Section 18).

    If the OR-Tools wheel is broken or missing, this fails here rather than
    during task T6 when the solver is being written.
    """
    response = client.get("/health/ready")

    assert response.status_code == 200, response.json()
    body = response.json()
    assert body["status"] == "ready"
    assert body["checks"]["solver"]["available"] is True


def test_openapi_schema_is_generated(client):
    """Contract surface the Node client codes against stays introspectable."""
    response = client.get("/openapi.json")

    assert response.status_code == 200
    assert "/health" in response.json()["paths"]


def test_settings_reject_an_invalid_log_level():
    with pytest.raises(ValidationError):
        Settings(LOG_LEVEL="chatty")


def test_settings_reject_a_non_positive_solver_budget():
    """A zero/negative time limit would make CP-SAT return nothing, silently."""
    with pytest.raises(ValidationError):
        Settings(SOLVER_MAX_SECONDS=0)
