"""Standard-library logging setup, driven by LOG_LEVEL.

Kept in one place so the service, its routers and the solver module all emit
through the same configured root logger rather than each calling basicConfig.
"""

from __future__ import annotations

import logging

from app.config import get_settings


def configure_logging() -> None:
    settings = get_settings()
    level = getattr(logging, settings.log_level.upper(), logging.INFO)

    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)-8s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
        force=True,  # replace uvicorn's own handlers so output stays uniform
    )
    logging.getLogger("app").setLevel(level)
