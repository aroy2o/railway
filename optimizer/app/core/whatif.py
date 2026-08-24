"""What-if simulation - PRD FR5 / 9.4, task T20.

"Given a candidate task, generate 2+ scheduling options... and recommend the
best one with a stated reason" (FR5.1/5.3). This module answers that question
by re-running the REAL CP-SAT model with the task's placement forced (T20's
`Pin` in `scheduler.py`) - not a simplified stand-in, so a what-if answer is
exactly as trustworthy as a real generation.

WHAT THIS MODULE DOES NOT DO, AND WHY
--------------------------------------
It does not persist anything. A what-if result is a pure function of its
inputs - same tasks, corridors, weights and candidate task, same answer, every
time - and nothing about the world changes by asking the question. See
docs/DECISIONS.md D-064.

WHAT THE REAL CORPUS FORCED THIS MODULE TO CONFRONT BEFORE IT WAS WRITTEN
---------------------------------------------------------------------
Two things, checked directly against `solve_schedule` before any option-
generation code existed:

1. D-024 holds under exclusion too, not just under weight changes (T23).
   Excluding any of 15 sampled scheduled tasks never rescued a single
   currently-deferred one - deferral on this corpus is never a capacity
   contest, so freeing a window never helps a task that fits no window at all.
   A "defer this instead" option's value is NEVER "something else gets
   rescued"; it is only ever "does the rest of the week reshuffle, and by how
   much."

2. ANY perturbation - excluding a task, or just moving one to a different
   window - reshuffles a large, variable number of OTHER already-scheduled
   tasks' DAYS as a side effect: 0 in some cases, 25 of 35 in others,
   depending on how much day-tie-breaking the corridor's other tasks were
   already subject to (the same under-determined-day effect D-028 and D-061
   found). A diff that listed every one of those as a "change" would bury the
   one thing the Controller actually asked about under noise nobody asked for.
   So the diff below reports the CANDIDATE task's own outcome in full, and
   every other affected task as a COUNT with a small sample - never a wall of
   rows - with a framing note explaining why that number is often large and
   is not a targeted consequence of this specific choice.
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

#: How this feature's ceiling is explained, every time - PRD 9.1's framing
#: discipline applied to a fourth kind of honesty caveat.
FRAMING = (
    "This is a real re-solve of the same CP-SAT model that produced the "
    "committed plan, with this one task's placement forced - not an estimate. "
    "On the real corpus, every deferral is structural (D-024): excluding a "
    "scheduled task never rescues a deferred one, because deferral here is "
    "never about losing a capacity contest. What a what-if CAN show is "
    "whether the candidate task's own placement changes, and whether other "
    "already-scheduled tasks shift day as a side effect of re-optimising "
    "around the change - which happens often and is not unique to this "
    "particular choice (T23/D-061 found the same volatility from a weight "
    "nudge alone)."
)

#: Bounded so a what-if request cannot become an unbounded number of solves.
#: 1 baseline + up to 3 options is 2-4 real CP-SAT runs, ~1-2s each on the
#: real corpus (T6) - a few seconds total, reasonable for an interactive panel.
MAX_OPTIONS = 3


@dataclass
class TaskOutcome:
    """Where the candidate task ends up under one option."""

    placed: bool
    corridor_id: str | None = None
    date_: str | None = None
    window_index: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "placed": self.placed,
            "corridorId": self.corridor_id,
            "date": self.date_,
            "windowIndex": self.window_index,
        }


@dataclass
class OptionDiff:
    """How one option's full result differs from the baseline plan.

    `reshuffled` is deliberately a COUNT plus a small sample, not every
    affected task - see the module docstring's second finding.
    """

    newly_scheduled: list[str] = field(default_factory=list)
    newly_deferred: list[str] = field(default_factory=list)
    reshuffled_count: int = 0
    reshuffled_sample: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "newlyScheduled": self.newly_scheduled,
            "newlyDeferred": self.newly_deferred,
            "reshuffledCount": self.reshuffled_count,
            "reshuffledSample": self.reshuffled_sample,
        }


@dataclass
class WhatIfOption:
    label: str
    kind: str  # "move" | "defer" | "traffic-block"
    task_outcome: TaskOutcome
    diff: OptionDiff | None
    metrics: dict[str, Any]
    reason: str
    #: None for the traffic-block option, which is not a re-solve.
    solve_seconds: float | None = None
    #: CP-SAT's own status: "OPTIMAL", "FEASIBLE", or a failure name. None for
    #: the traffic-block option. `whatif_solver_max_seconds` (T20) is
    #: deliberately shorter than a normal solve's budget, so an option CAN
    #: come back FEASIBLE rather than proven OPTIMAL - carried here rather
    #: than hidden inside `metrics`, so the UI can show that honestly instead
    #: of implying every option was proven best of all possible placements.
    status: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "kind": self.kind,
            "taskOutcome": self.task_outcome.as_dict(),
            "diff": self.diff.as_dict() if self.diff else None,
            "metrics": self.metrics,
            "reason": self.reason,
            "solveSeconds": self.solve_seconds,
            "status": self.status,
        }


@dataclass
class WhatIfResult:
    task_id: str
    currently_scheduled: bool
    baseline_metrics: dict[str, Any]
    options: list[WhatIfOption]
    recommended_index: int | None
    framing: str = FRAMING

    def as_dict(self) -> dict[str, Any]:
        return {
            "taskId": self.task_id,
            "currentlyScheduled": self.currently_scheduled,
            "baselineMetrics": self.baseline_metrics,
            "options": [o.as_dict() for o in self.options],
            "recommendedIndex": self.recommended_index,
            "framing": self.framing,
        }


def _task_outcome(result: ScheduleResult, task_id: str) -> TaskOutcome:
    for block in result.blocks:
        if task_id in block.task_ids:
            return TaskOutcome(True, block.corridor_id, block.day.isoformat(), block.window_index)
    return TaskOutcome(False)


def _diff(baseline: ScheduleResult, option: ScheduleResult, task_id: str) -> OptionDiff:
    base_scheduled = baseline.scheduled_task_ids
    option_scheduled = option.scheduled_task_ids

    newly_scheduled = sorted((option_scheduled - base_scheduled) - {task_id})
    newly_deferred = sorted((base_scheduled - option_scheduled) - {task_id})

    base_days = {t: b.day for b in baseline.blocks for t in b.task_ids}
    option_days = {t: b.day for b in option.blocks for t in b.task_ids}
    others = (base_scheduled & option_scheduled) - {task_id}
    reshuffled = sorted(t for t in others if base_days.get(t) != option_days.get(t))

    return OptionDiff(
        newly_scheduled=newly_scheduled,
        newly_deferred=newly_deferred,
        reshuffled_count=len(reshuffled),
        reshuffled_sample=reshuffled[:5],
    )


def _candidate_windows(
    task: MaintenanceTask,
    corridors: dict[str, CorridorAvailability],
    horizon_start: date,
    horizon_days: int,
    exclude_key: str | None,
    limit: int,
) -> list[str]:
    """Up to `limit` real, fitting, same-corridor windows, deterministic order.

    Same-corridor only, for the reason D-043 already established for manual
    overrides: the defect is on that corridor's asset, and a what-if that
    proposed a different corridor would be answering a question about a
    different asset's problem, not this one.
    """
    windows = [
        w
        for w in expand_windows(corridors, horizon_start, horizon_days)
        if w.corridor_id == task.corridor_id
        and w.key != exclude_key
        and task.duration_minutes <= w.duration_minutes
    ]
    windows.sort(key=lambda w: (w.day, w.window_index))
    return [w.key for w in windows[:limit]]


def generate_whatif(
    tasks: list[MaintenanceTask],
    corridors: dict[str, CorridorAvailability],
    *,
    horizon_start: date,
    horizon_days: int,
    task_id: str,
    weights: ObjectiveWeights,
    max_seconds: float,
) -> WhatIfResult:
    """FR5.1-5.3: 2+ real options for one task, each a genuine re-solve,
    diffed against the baseline, with a stated recommendation.

    Raises `ValueError` if `task_id` is not in `tasks` - the caller's job to
    turn into a 404, the same split every other endpoint in this service uses.
    """
    task = next((t for t in tasks if t.task_id == task_id), None)
    if task is None:
        raise ValueError(f"no task {task_id} in this scenario")

    import time

    t0 = time.monotonic()
    baseline = solve_schedule(
        tasks, corridors, horizon_start=horizon_start, horizon_days=horizon_days,
        weights=weights, max_seconds=max_seconds,
    )
    baseline_seconds = time.monotonic() - t0
    currently_scheduled = task_id in baseline.scheduled_task_ids

    options: list[WhatIfOption] = []

    if not currently_scheduled:
        # D-024's ceiling, reached directly: this task fits no window in the
        # model at all, so there is no placement to re-solve into. The one
        # honest option is the T22 traffic-block cost the baseline already
        # computed - reused verbatim, not recomputed, because it is the same
        # question asked the same way.
        deferred_entry = next((d for d in baseline.deferred if d.task_id == task_id), None)
        detail = deferred_entry.detail if deferred_entry else "This task was not evaluated."
        displacement = deferred_entry.displacement if deferred_entry else None
        options.append(
            WhatIfOption(
                label="Force via a traffic block",
                kind="traffic-block",
                task_outcome=TaskOutcome(False),
                diff=None,
                metrics={"displacementOption": displacement},
                reason=(
                    f"No alternate window exists to re-solve into: {detail} There is "
                    "nothing else to compare - a traffic block is the only real option."
                ),
                solve_seconds=None,
            )
        )
        return WhatIfResult(
            task_id=task_id,
            currently_scheduled=False,
            baseline_metrics=baseline.metrics(),
            options=options,
            recommended_index=0 if displacement and displacement.get("feasible") else None,
        )

    # Currently scheduled: alternate same-corridor windows, up to MAX_OPTIONS,
    # plus a "defer instead" option if room remains under the cap.
    current_block = next(b for b in baseline.blocks if task_id in b.task_ids)
    current_key = f"{current_block.corridor_id}|{current_block.day.isoformat()}|{current_block.window_index}"

    move_slots = max(0, MAX_OPTIONS - 1)
    alt_keys = _candidate_windows(
        task, corridors, horizon_start, horizon_days, current_key, move_slots,
    )

    for key in alt_keys:
        t1 = time.monotonic()
        result = solve_schedule(
            tasks, corridors, horizon_start=horizon_start, horizon_days=horizon_days,
            weights=weights, max_seconds=max_seconds, pin=Pin(task_id, key),
        )
        seconds = time.monotonic() - t1
        outcome = _task_outcome(result, task_id)
        diff = _diff(baseline, result, task_id)
        options.append(
            WhatIfOption(
                label=f"Move to {outcome.date_} window {outcome.window_index}",
                kind="move",
                task_outcome=outcome,
                diff=diff,
                metrics=result.metrics(),
                reason=(
                    f"Every other currently-scheduled task stays scheduled."
                    if not diff.newly_deferred
                    else f"Displaces {', '.join(diff.newly_deferred)} to fit."
                ),
                solve_seconds=seconds,
                status=result.status,
            )
        )

    if len(options) < MAX_OPTIONS:
        t2 = time.monotonic()
        result = solve_schedule(
            tasks, corridors, horizon_start=horizon_start, horizon_days=horizon_days,
            weights=weights, max_seconds=max_seconds, pin=Pin(task_id, None),
        )
        seconds = time.monotonic() - t2
        diff = _diff(baseline, result, task_id)
        options.append(
            WhatIfOption(
                label="Defer this task",
                kind="defer",
                task_outcome=TaskOutcome(False),
                diff=diff,
                metrics=result.metrics(),
                reason=(
                    "Frees this task's window. Rescues no other deferred task on this "
                    "corpus - every deferral here is structural, not a capacity contest "
                    "(D-024) - so the only effect is on already-scheduled tasks' days."
                ),
                solve_seconds=seconds,
                status=result.status,
            )
        )

    recommended = _recommend(options)

    return WhatIfResult(
        task_id=task_id,
        currently_scheduled=True,
        baseline_metrics=baseline.metrics(),
        options=options,
        recommended_index=recommended,
    )


def _recommend(options: list[WhatIfOption]) -> int | None:
    """FR5.3: recommend the best option with a stated reason.

    Ranked, in order: fewer newly-deferred tasks (coverage is never traded for
    tidiness - D-023/D-061's own priority order, applied here); then the task
    is actually placed (a move beats a defer, all else equal); then fewer
    reshuffled tasks (less disruption to the rest of the week). A recommended
    option is a starting point for the Controller, never a decision made for
    them - FR5.3 is explicit that any option may be picked.
    """
    if not options:
        return None

    def rank(option: WhatIfOption) -> tuple[int, int, int]:
        newly_deferred = len(option.diff.newly_deferred) if option.diff else 0
        not_placed = 0 if option.task_outcome.placed else 1
        reshuffled = option.diff.reshuffled_count if option.diff else 0
        return (newly_deferred, not_placed, reshuffled)

    best = min(range(len(options)), key=lambda i: rank(options[i]))
    return best
