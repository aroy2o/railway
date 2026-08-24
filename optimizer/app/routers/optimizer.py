"""Scheduling endpoints - PRD 10.3, the production path PRD Section 11 describes.

Node gathers tasks, corridors and the asset joins from MongoDB and POSTs them
here; this service runs OR-Tools and returns the plan. **It never touches
MongoDB.** That one-way arrangement is the whole point of the microservice split.

These handlers are deliberately thin. All three underlying functions are pure,
tested (85 tests across T6-T8) and already produce their own serialisable
output, so the endpoint's only jobs are validating the payload, mapping the
contract onto the dataclasses, and handing the result back unaltered.

RESPONSES ARE NOT FILTERED THROUGH A `response_model`, ON PURPOSE
-----------------------------------------------------------------
FastAPI's `response_model` silently *drops* any field the model does not
declare. Every honesty-critical field this project has built - the
`priorityIsPlaceholder` flag, `usesFailureRisk`, the solver's `knownGaps`, the
baseline's conflict report - would disappear the moment a response model drifted
out of sync with the dataclass. That is precisely the failure mode D-015 and
D-018 were about, in a new place.

So the dataclasses' own `as_dict()` remains the single source of truth for the
response shape, and it is returned untouched. The shape is pinned by tests
instead of by a schema that can quietly subtract from it. See D-032.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.config import Settings, get_settings
from app.core.baseline import run_baseline, structurally_contestable
from app.core.conflicts import (
    from_baseline_conflicts,
    from_known_gaps,
    from_train_impact,
    summarise,
)
from app.core.priority import PriorityInputs, rank_tasks
from app.core.scheduler import (
    CorridorAvailability,
    DailyWindow,
    MaintenanceTask,
    solve_schedule,
)
from app.models.scheduling import CorridorIn, PrioritizeRequest, ScenarioIn, SolveRequest, TaskIn

logger = logging.getLogger(__name__)
router = APIRouter(tags=["scheduling"])


# --------------------------------------------------------------------------- #
# Contract -> domain                                                           #
# --------------------------------------------------------------------------- #

def _to_corridors(payload: list[CorridorIn]) -> dict[str, CorridorAvailability]:
    return {
        corridor.corridor_id: CorridorAvailability(
            corridor_id=corridor.corridor_id,
            daily_windows=tuple(
                DailyWindow(window.start_minute, window.end_minute)
                for window in sorted(corridor.daily_windows, key=lambda w: w.start_minute)
            ),
            low_confidence=corridor.low_confidence,
            # T22: carried for costing a traffic block only. The model builder
            # never reads these - it assigns solely into `daily_windows`.
            occupied_windows=tuple(
                DailyWindow(window.start_minute, window.end_minute)
                for window in sorted(corridor.occupied_windows, key=lambda w: w.start_minute)
            ),
            train_class_mix=corridor.train_class_mix,
        )
        for corridor in payload
    }


def _to_tasks(payload: list[TaskIn], as_of) -> list[MaintenanceTask]:
    """Map tasks onto the solver dataclass, scoring priority where possible.

    When `assetCriticalityScore` is present the real FR2.3 score is computed and
    `priority_is_placeholder` is False. When it is absent the task falls back to
    raw severity and the flag stays True - the same honest degradation T6 shipped
    with, rather than a silent pretence that the score is real.
    """
    from app.core.priority import score_task

    tasks: list[MaintenanceTask] = []
    for task in payload:
        if task.asset_criticality_score is not None:
            # T17/D-048: this call already computes the whole FR2.4 breakdown.
            # It used to be reduced to one integer here and the reasoning thrown
            # away, which left the decision log unable to answer "why is this
            # task ranked where it is". Keep it and pass it through.
            breakdown = score_task(
                PriorityInputs(
                    task_id=task.task_id,
                    severity=task.severity,
                    asset_criticality_score=task.asset_criticality_score,
                    sla_due_date=task.sla_due_date,
                    as_of=as_of,
                    failure_risk_score=task.failure_risk_score,
                )
            )
            priority = breakdown.solver_priority
            priority_breakdown = breakdown.as_dict()
            is_placeholder = False
        else:
            priority, is_placeholder = task.severity, True
            priority_breakdown = None

        tasks.append(
            MaintenanceTask(
                task_id=task.task_id,
                corridor_id=task.corridor_id,
                department=task.department,
                duration_minutes=task.est_block_duration_mins,
                sla_due_date=task.sla_due_date,
                priority=priority,
                depends_on_task_id=task.depends_on_task_id,
                required_resource_ids=tuple(task.required_resource_ids),
                priority_is_placeholder=is_placeholder,
                date_raised=task.date_raised,
                priority_breakdown=priority_breakdown,
            )
        )
    return tasks


def _guard_size(scenario: ScenarioIn, settings: Settings) -> None:
    """Refuse an oversized problem at the boundary rather than mid-solve."""
    if len(scenario.tasks) > settings.max_request_tasks:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"{len(scenario.tasks)} tasks exceeds the limit of {settings.max_request_tasks}",
        )
    if len(scenario.corridors) > settings.max_request_corridors:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"{len(scenario.corridors)} corridors exceeds the limit of "
                f"{settings.max_request_corridors}"
            ),
        )


# --------------------------------------------------------------------------- #
# Endpoints                                                                    #
# --------------------------------------------------------------------------- #

@router.post("/prioritize")
def prioritize(request: PrioritizeRequest, settings: Settings = Depends(get_settings)) -> dict:
    """FR2.4 - the ranked task queue, highest priority first.

    Each entry carries its per-factor contributions (which sum exactly to the
    score) and the named dominant factor, so "why is this task first" is
    answerable without re-deriving the arithmetic.

    `assetCriticalityScore` is required: it is a REAL measured-anchored value
    only Node can join in, and scoring without it would silently produce a
    weaker ranking that still looked authoritative.
    """
    if len(request.tasks) > settings.max_request_tasks:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"{len(request.tasks)} tasks exceeds the limit of {settings.max_request_tasks}",
        )

    queue = rank_tasks(
        [
            PriorityInputs(
                task_id=task.task_id,
                severity=task.severity,
                asset_criticality_score=task.asset_criticality_score,
                sla_due_date=task.sla_due_date,
                as_of=request.as_of,
                failure_risk_score=task.failure_risk_score,
            )
            for task in request.tasks
        ]
    )

    return {
        "asOf": request.as_of.isoformat(),
        "count": len(queue),
        "queue": [entry.as_dict() for entry in queue],
    }


@router.post("/optimize")
def optimize(request: SolveRequest, settings: Settings = Depends(get_settings)) -> dict:
    """FR3 - the CP-SAT block schedule (PRD Section 13).

    Returns the plan, every deferral with a machine-readable reason (FR3.3), the
    per-task decision log T17 builds explanations on, and `knownGaps` naming the
    constraints this build does not yet enforce (resource no-overlap -> T25,
    dependency precedence -> T24).
    """
    _guard_size(request, settings)
    if request.horizon_days > settings.max_horizon_days:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"horizonDays {request.horizon_days} exceeds {settings.max_horizon_days}",
        )

    # A client may ask for less time than the service allows, never more.
    budget = min(request.max_seconds or settings.solver_max_seconds, settings.solver_max_seconds)

    try:
        result = solve_schedule(
            _to_tasks(request.tasks, request.horizon_start),
            _to_corridors(request.corridors),
            horizon_start=request.horizon_start,
            horizon_days=request.horizon_days,
            max_seconds=budget,
            num_workers=1,  # reproducibility over speed - D-022
        )
    except ValueError as exc:
        # Raised by expand_windows for a lowConfidence or overlapping-window
        # corridor: a bad payload, so 422 rather than a 500.
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    logger.info(
        "optimize: %d tasks, %d corridors, %s in %.3fs",
        len(request.tasks), len(request.corridors), result.status, result.solve_seconds,
    )
    payload = result.as_dict()
    # PRD 9.5 - the same gaps, named and with a resolution strategy each.
    # Additive: `knownGaps` is untouched, so nothing that already reads it breaks.
    payload["conflictReport"] = summarise(
        from_known_gaps(payload["knownGaps"])
        + from_train_impact(payload["knownGaps"]["trainImpactConflicts"]["conflicts"])
    )
    return payload


@router.post("/baseline")
def baseline(request: SolveRequest, settings: Settings = Depends(get_settings)) -> dict:
    """FR9.1 - the naive per-department baseline (PRD Section 12).

    Takes the same payload as /optimize so the two are directly comparable. The
    double-bookings and over-subscribed windows in the response are the
    algorithm's *output*, not defects: they are what uncoordinated departmental
    booking produces, and what T14 exists to show.

    `contestableTaskIds` is included because the comparison must be drawn from
    that subset, never the full backlog - see docs/DECISIONS.md D-031.
    """
    _guard_size(request, settings)
    if request.horizon_days > settings.max_horizon_days:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"horizonDays {request.horizon_days} exceeds {settings.max_horizon_days}",
        )

    tasks = _to_tasks(request.tasks, request.horizon_start)
    corridors = _to_corridors(request.corridors)

    try:
        result = run_baseline(
            tasks, corridors, horizon_start=request.horizon_start, horizon_days=request.horizon_days
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    payload = result.as_dict()

    # The FCFS ordering rule is only meaningful with real arrival dates. Silence
    # here would let the baseline degrade to "everything sorts last" unnoticed.
    undated = [task.task_id for task in tasks if task.date_raised is None]
    if undated:
        payload["warnings"] = [
            {
                "code": "MISSING_DATE_RAISED",
                "message": (
                    f"{len(undated)} task(s) have no dateRaised, so first-come-first-served "
                    "ordering degrades to task-id order for them (D-029)"
                ),
                "taskIds": undated[:20],
            }
        ]

    payload["contestableTaskIds"] = sorted(structurally_contestable(tasks, corridors))
    # PRD 9.5 typing for the baseline's own conflicts. Kept on the `baseline`
    # layer so it can never be totalled with the optimized plan's (D-045).
    payload["conflictReport"] = summarise(from_baseline_conflicts(payload["conflicts"]))
    logger.info(
        "baseline: %d tasks, %d double-bookings",
        len(request.tasks), payload["metrics"]["doubleBookings"],
    )
    return payload
