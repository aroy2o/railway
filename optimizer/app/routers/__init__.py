"""FastAPI routers.

Route handlers stay thin: they validate input with Pydantic models and delegate
to modules under `app/core`. Solver logic in particular lives in
`app/core/scheduler.py` so it can be unit-tested without starting a server
(CLAUDE.md Python convention).
"""
