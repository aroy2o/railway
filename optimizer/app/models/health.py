"""Response models for the health endpoints."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """Liveness payload - no dependency checks."""

    status: str = Field(examples=["ok"])
    service: str = Field(examples=["optimizer"])
    version: str
    env: str
    timestamp: datetime


class SolverCheck(BaseModel):
    """Whether the CP-SAT backend is importable and usable in this process."""

    available: bool
    backend: str = Field(examples=["ortools.sat.python.cp_model"])
    detail: str | None = None


class ReadinessResponse(BaseModel):
    """Readiness payload - 503 unless every dependency the solver needs is up."""

    status: str = Field(examples=["ready", "not-ready"])
    checks: dict[str, SolverCheck]
    explain_enabled: bool = Field(
        description="True once an Anthropic API key is configured (task T18, PRD 9.2)."
    )
    timestamp: datetime
