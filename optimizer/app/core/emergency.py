"""Emergency rolling re-optimization - PRD FR3.5 / 9.10, task T27.

"'Simulate an emergency block request' button triggers incremental
re-optimization of the remaining week's schedule (re-solve only the affected
corridor/window, holding already-executed blocks fixed)" (PRD 9.10 / 13.1).

WHAT "EMERGENCY" MEANS HERE, AND WHY
-------------------------------------
An audit against the real corpus (see docs/DECISIONS.md D-069) ruled out the
other plausible reading - "a new/elevated task needs a window right now" -
before this module was written. On this data every deferral is structural
(D-024): a task deferred because it is longer than any window on its corridor
stays exactly that deferred no matter how much of the corridor's remaining
capacity a re-solve frees up for it, so that reading produces the same
disappointing "cannot be rescued" answer regardless of which real task is
picked, and demonstrates nothing about T27 that T20 had not already shown.

The reading this module implements - an unplanned event CONSUMES part of the
corridor's remaining calendar (an emergency train movement, a safety-driven
closure, another authority's urgent possession) - is both closer to "block
REQUEST" (a request that a block of time be granted, i.e. taken out of
availability) and the one verified to produce a real, positive
re-optimization on this corpus: displacing an already-planned task into
another window in the corridor's remaining time, cascading if necessary,
while every other corridor and everything already executed stays untouched.
It also needs no new task-creation write path at all - PRD FR1.1 stays T10's,
unstarted here.

WHAT THIS MODULE DOES NOT DO
-----------------------------
It does not decide what counts as "already executed" from a clock - the
caller (Node) supplies `current_placements`, because only Node knows what is
really committed right now, including anything T15's manual overrides have
since moved (D-065's "the effective plan, never the base blocks" rule applies
here exactly as it does to override validation). And unlike T20 (D-064), a
result here is meant to be persisted: this module returns a real
`ScheduleResult`, and the caller is expected to save it as a new schedule,
consistent with D-034 (a schedule is an event that happened, and an emergency
re-solve is one).

THE MECHANISM: PIN EVERYTHING BUT ONE CORRIDOR'S REMAINING TIME
-----------------------------------------------------------------
Reuses T20's `Pin` unchanged, generalised to a list (T27's own contribution -
see `scheduler.py`): every task NOT on the affected corridor is pinned to its
exact current placement (or excluded, if currently deferred), so the model
cannot drift anywhere else even by CP-SAT's own tie-breaking (D-028/D-061's
volatility, closed off entirely here rather than merely reported as T20
does). On the affected corridor, everything before the earliest disrupted
date is additionally BLOCKED at the window level (`blocked_window_keys`, also
new in `scheduler.py` for this task) - a pin only holds a task that is
already there; an empty past window needs to stay empty too, which a pin
cannot express. Only the disrupted window(s) themselves and whatever remains
on the corridor from the earliest disrupted date onward are left free.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.core.scheduler import (
    CorridorAvailability,
    MaintenanceTask,
    ObjectiveWeights,
    Pin,
    ScheduleResult,
    expand_windows,
    solve_schedule,
)

FRAMING = (
    "This is a real re-solve of the same CP-SAT model that produced the "
    "committed plan, constrained to the affected corridor's remaining time "
    "(PRD 9.10) - not an estimate. Every task on every OTHER corridor, and "
    "everything already executed on this one, is held to its exact current "
    "placement; only the disrupted window(s) and whatever remains on this "
    "corridor from the earliest disrupted date onward were re-decided. If a "
    "displaced task cannot fit anywhere in what remains, it is reported "
    "deferred rather than forced - the same honesty the rest of this system "
    "applies everywhere else."
)


@dataclass
class CurrentPlacement:
    task_id: str
    corridor_id: str
    day: date
    window_index: int


@dataclass
class DisruptedWindow:
    day: date
    window_index: int


@dataclass
class EmergencyReoptResult:
    result: ScheduleResult
    corridor_id: str
    disrupted_windows: list[DisruptedWindow]
    as_of: date
    reason: str
    pinned_task_count: int
    blocked_window_count: int
    framing: str = FRAMING

    def as_dict(self) -> dict[str, Any]:
        payload = self.result.as_dict()
        payload["emergencyContext"] = {
            "corridorId": self.corridor_id,
            "disruptedWindows": [
                {"date": w.day.isoformat(), "windowIndex": w.window_index}
                for w in self.disrupted_windows
            ],
            "asOf": self.as_of.isoformat(),
            "reason": self.reason,
            "pinnedTaskCount": self.pinned_task_count,
            "blockedWindowCount": self.blocked_window_count,
        }
        payload["framing"] = self.framing
        return payload


def generate_emergency_reoptimization(
    tasks: list[MaintenanceTask],
    corridors: dict[str, CorridorAvailability],
    *,
    horizon_start: date,
    horizon_days: int,
    corridor_id: str,
    current_placements: list[CurrentPlacement],
    disrupted_windows: list[DisruptedWindow],
    reason: str,
    weights: ObjectiveWeights,
    max_seconds: float,
) -> EmergencyReoptResult:
    """FR3.5 / PRD 9.10: re-solve one corridor's remaining time around a
    disruption, holding everything else - including everything already
    executed on that same corridor - exactly as it stands.

    `current_placements` is the plan as Node knows it to REALLY stand right
    now (effective plan, overrides included) - not recomputed here, because
    unlike T20 this result is meant to be committed, and committing on top of
    a plan the caller does not actually hold would silently discard whatever
    an override had already changed.
    """
    as_of = min(w.day for w in disrupted_windows)

    placement_by_task = {p.task_id: p for p in current_placements}

    pins: list[Pin] = []
    for task in tasks:
        on_affected = task.corridor_id == corridor_id
        placement = placement_by_task.get(task.task_id)
        if placement is not None:
            already_executed = on_affected and placement.day < as_of
            if not on_affected or already_executed:
                key = f"{placement.corridor_id}|{placement.day.isoformat()}|{placement.window_index}"
                pins.append(Pin(task.task_id, key))
            # On-affected and NOT already executed: left unpinned, free for
            # the re-solve to keep, move within the corridor, or defer.
        else:
            # Currently deferred. Off the affected corridor, it must stay
            # deferred - this re-solve is not allowed to touch that corridor
            # at all, so there is no capacity there for it to newly claim.
            if not on_affected:
                pins.append(Pin(task.task_id, None))
            # On-affected and currently deferred: left unpinned too - the
            # disruption may have freed capacity on a DIFFERENT window this
            # task could not have used before, so it is fair to reconsider.

    blocked: set[str] = set()
    for window in expand_windows(corridors, horizon_start, horizon_days):
        if window.corridor_id == corridor_id and window.day < as_of:
            blocked.add(window.key)
    for disrupted in disrupted_windows:
        blocked.add(f"{corridor_id}|{disrupted.day.isoformat()}|{disrupted.window_index}")

    result = solve_schedule(
        tasks,
        corridors,
        horizon_start=horizon_start,
        horizon_days=horizon_days,
        weights=weights,
        max_seconds=max_seconds,
        pins=pins,
        blocked_window_keys=frozenset(blocked),
    )

    return EmergencyReoptResult(
        result=result,
        corridor_id=corridor_id,
        disrupted_windows=disrupted_windows,
        as_of=as_of,
        reason=reason,
        pinned_task_count=len(pins),
        blocked_window_count=len(blocked),
    )
