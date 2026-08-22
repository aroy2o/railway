"""Shared pytest fixtures for the optimizer service."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture(scope="session")
def client() -> TestClient:
    """In-process HTTP client - no socket is bound and no server is started."""
    with TestClient(create_app()) as test_client:
        yield test_client
