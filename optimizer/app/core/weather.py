"""Seasonal / monsoon risk flagging - PRD 9.9, T26.

Reporting only, mirroring T22 Phase A's precedent exactly: this module never
touches the CP-SAT objective or constraints. `seasonal_risk_flag` on a
`CorridorAvailability` was already decided by T26's real-data ingestion
(`data/ingestion/build_seasonal_risk.py`, joined onto each corridor at seed
time - see docs/DECISIONS.md D-068); this module only checks whether a
SCHEDULED block on a flagged corridor falls inside the real IMD monsoon
window, and reports it as an advisory a Controller can act on - never a rule
the solver silently avoids or a penalty inside the objective. See D-068 for
why this stops at reporting rather than wiring PRD 13.1's xi term into the
objective, the same question T22 asked of lambda and answered the same way.
"""

from __future__ import annotations

from datetime import date

#: IMD's own published "normal" dates for the Southwest Monsoon: onset over
#: Kerala around June 1 (covering the whole country by ~July 8), retreat
#: beginning around September 17, complete withdrawal by ~October 15.
#: Source: IMD MAUSAM journal, "Normal dates of onset/progress and
#: withdrawal of southwest monsoon over India". A fixed calendar window
#: rather than a live API - the same reasoning as T26's fixed state list:
#: a normal-year approximation is what "high-risk window" can honestly mean
#: without per-year IMD forecast data this project does not have.
MONSOON_START = (6, 1)
MONSOON_END = (10, 15)


def is_monsoon_window(day: date) -> bool:
    """True when `day` falls within India's real Southwest Monsoon season."""
    month_day = (day.month, day.day)
    return MONSOON_START <= month_day <= MONSOON_END


def detect_weather_risk(blocks, corridors) -> list[dict]:
    """Scheduled blocks on a real monsoon-risk corridor, during the real
    monsoon window (PRD 9.9).

    Advisory only - see module docstring. Mirrors `detect_train_impact`'s
    shape exactly (T22), since both are "check a scheduled block against a
    real-world fact the solver does not otherwise reason about".
    """
    found: list[dict] = []
    for block in blocks:
        corridor = corridors.get(block.corridor_id)
        if corridor is None or corridor.seasonal_risk_flag != "monsoon-risk":
            continue
        if not is_monsoon_window(block.day):
            continue
        found.append(
            {
                "corridorId": block.corridor_id,
                "date": block.day.isoformat(),
                "taskIds": list(block.task_ids),
                "departments": sorted(set(block.departments)),
                "seasonalRiskFlag": corridor.seasonal_risk_flag,
            }
        )
    return found
