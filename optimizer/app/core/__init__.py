"""Domain logic, independent of FastAPI.

Nothing in this package may import from `app.routers` or from `fastapi` - that
one-way dependency is what keeps the CP-SAT model unit-testable standalone.

Planned modules:
  scheduler.py  CP-SAT model construction and solve   (task T6,  PRD 13)
  priority.py   asset criticality + priority scoring  (task T7,  PRD FR2)
  baseline.py   naive per-department scheduler        (task T8,  PRD FR9.1)
"""
