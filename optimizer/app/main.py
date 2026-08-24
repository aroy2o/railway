"""FastAPI application for the optimizer / AI microservice.

Endpoints arrive with the tasks that need them (PRD 10.3):
    /prioritize  asset criticality + priority ranking   (task T9,  FR2)
    /optimize    CP-SAT block schedule                  (task T9,  FR3)
    /baseline    naive per-department schedule          (task T9,  FR9.1)
    /whatif      alternative scheduling options         (task T20, FR5)
    /explain     grounded natural-language justification(task T18, FR8)

Run locally:
    uvicorn app.main:app --reload
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __version__
from app.config import get_settings
from app.logging_config import configure_logging
from app.routers import explain, health, optimizer, risk

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    configure_logging()
    settings = get_settings()
    logger.info(
        "Optimizer service starting (version=%s, solver_max_seconds=%.1f, explain_enabled=%s)",
        __version__,
        settings.solver_max_seconds,
        settings.explain_enabled,
    )
    yield
    logger.info("Optimizer service stopped")


def create_app() -> FastAPI:
    """Application factory - lets tests build an app without import side effects."""
    app = FastAPI(
        title="Railway Block Planning Optimizer",
        description=(
            "CP-SAT scheduling, asset-risk scoring and explanation layer for the "
            "AI-assisted railway maintenance block planning system (SIH 26027)."
        ),
        version=__version__,
        lifespan=lifespan,
    )

    # Only the Express API is meant to call this service; it is not exposed to
    # the browser. CORS stays closed until there is a reason to open it.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router)
    app.include_router(optimizer.router)
    app.include_router(explain.router)
    app.include_router(risk.router)

    @app.middleware("http")
    async def limit_body_size(request: Request, call_next):
        """Refuse an oversized body before it is parsed.

        Starlette does not bound request size by default, so a large payload
        would be fully read and parsed before any handler saw it. Same
        fail-loud-at-the-boundary posture as the Express validate() middleware.
        """
        settings = get_settings()
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > settings.max_request_bytes:
            return JSONResponse(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                content={
                    "error": {
                        "code": "PAYLOAD_TOO_LARGE",
                        "message": f"body exceeds {settings.max_request_bytes} bytes",
                    }
                },
            )
        return await call_next(request)

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        """Log every unhandled error with a stack trace before responding.

        Mirrors the Express error envelope so the Node client has one shape to
        parse regardless of which service failed, and never leaks an internal
        exception message to the caller.
        """
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": {"code": "INTERNAL_ERROR", "message": "Internal server error"}},
        )

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.optimizer_host,
        port=settings.optimizer_port,
        log_level=settings.log_level,
    )
