"""Naive per-department baseline scheduler - implements PRD FR9.1 / Section 12.

This is the algorithm the whole project is arguing against: the current BDMS
process, where each department books blocks for its own work with no visibility
into what the others have asked for. It exists so the comparison screen (T14)
can show a **real computed** "before", never a hand-typed one - PRD Section 18
lists a fabricated-looking baseline as an explicit project risk.

HOW IT IS DELIBERATELY WORSE
---------------------------
Not by being badly written. The inefficiency is structural, and there are two
distinct kinds:

1. **No cross-department batching.** A department only ever packs its own tasks,
   so a possession never serves two departments. That is not a tuning choice; it
   is unreachable for this algorithm, and `test_baseline_can_never_batch`
   asserts it as an invariant.

2. **Double-booking.** Each department's pass starts from a clean view of the
   calendar, so two departments independently take the same window at the same
   clock time. The conflicts are the *output*, not a bug to be fixed - PRD
   Section 12 wants them demonstrated, not avoided.

THE SUBTLE PART: WHAT EACH DEPARTMENT CAN SEE
---------------------------------------------
A department's pass **is** internally coordinated - the same office knows what it
has already requested, so it packs its own tasks sequentially without colliding
with itself. It is blind only to the *other* departments. Modelling it as
globally blind would be a strawman: no planner double-books themselves. The
complaint in the problem statement is specifically about cross-department
coordination, so that is the only thing this algorithm lacks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from app.core.scheduler import (
    CorridorAvailability,
    DeferralReason,
    DeferredTask,
    MaintenanceTask,
    ScheduledBlock,
    StructuralCategory,
    WindowInstance,
    classify_structural_feasibility,
    expand_windows,
    _clock,
)

#: The order departments run their independent passes in.
#:
#: Engineering first because PRD 5.2 makes it the largest demand source (50% of
#: tasks), which mirrors the real process where track work drives most block
#: demand. The order matters only in that an earlier department gets first pick
#: of the calendar - and that positional advantage is itself part of what the
#: coordinated optimizer removes.
DEPARTMENT_ORDER = ("Engineering", "S&T", "TRD")


@dataclass
class DoubleBooking:
    """Two departments holding the same corridor at the same time.

    The headline failure of uncoordinated planning: both crews arrive, one is
    turned away, and the possession is wasted.
    """

    corridor_id: str
    day: date
    task_ids: tuple[str, str]
    departments: tuple[str, str]
    overlap_start: int
    overlap_end: int

    @property
    def overlap_minutes(self) -> int:
        return self.overlap_end - self.overlap_start

    def as_dict(self) -> dict:
        return {
            "corridorId": self.corridor_id,
            "date": self.day.isoformat(),
            "taskIds": list(self.task_ids),
            "departments": list(self.departments),
            "overlapStart": _clock(self.overlap_start),
            "overlapEnd": _clock(self.overlap_end),
            "overlapMinutes": self.overlap_minutes,
        }


@dataclass
class OverSubscribedWindow:
    """A window claimed for more work than it can physically hold."""

    corridor_id: str
    day: date
    window_index: int
    capacity_minutes: int
    claimed_minutes: int
    departments: list[str]

    @property
    def excess_minutes(self) -> int:
        return self.claimed_minutes - self.capacity_minutes

    def as_dict(self) -> dict:
        return {
            "corridorId": self.corridor_id,
            "date": self.day.isoformat(),
            "windowIndex": self.window_index,
            "capacityMinutes": self.capacity_minutes,
            "claimedMinutes": self.claimed_minutes,
            "excessMinutes": self.excess_minutes,
            "departments": sorted(set(self.departments)),
        }


@dataclass
class BaselineResult:
    """Deliberately shaped like `ScheduleResult` so T14 can diff like with like."""

    horizon: str
    horizon_start: date
    horizon_days: int
    status: str = "BASELINE"
    blocks: list[ScheduledBlock] = field(default_factory=list)
    deferred: list[DeferredTask] = field(default_factory=list)
    double_bookings: list[DoubleBooking] = field(default_factory=list)
    over_subscribed: list[OverSubscribedWindow] = field(default_factory=list)
    decision_log: list[dict] = field(default_factory=list)
    department_order: tuple[str, ...] = DEPARTMENT_ORDER

    @property
    def scheduled_task_ids(self) -> set[str]:
        return {task_id for block in self.blocks for task_id in block.task_ids}

    def metrics(self) -> dict:
        used = sum(b.used_minutes for b in self.blocks)
        # Capacity counted over DISTINCT windows actually claimed. Counting per
        # claim would double-count a window two departments both took, and hide
        # the over-subscription behind a plausible-looking percentage.
        distinct = {
            (b.corridor_id, b.day, b.window_index): b.capacity_minutes for b in self.blocks
        }
        capacity = sum(distinct.values())
        return {
            "tasksScheduled": len(self.scheduled_task_ids),
            "tasksDeferred": len(self.deferred),
            "blocksUsed": len(self.blocks),
            "distinctWindowsClaimed": len(distinct),
            "crossDepartmentBatches": sum(1 for b in self.blocks if b.is_cross_department_batch),
            "blockMinutesUsed": used,
            "blockMinutesCapacity": capacity,
            # Can exceed 100%: that is the over-subscription showing through
            # rather than being smoothed away.
            "blockUtilisationPct": round(100 * used / capacity, 2) if capacity else 0.0,
            "unusedBlockMinutes": capacity - used,
            "doubleBookings": len(self.double_bookings),
            "doubleBookedMinutes": sum(c.overlap_minutes for c in self.double_bookings),
            "overSubscribedWindows": len(self.over_subscribed),
        }

    def as_dict(self) -> dict:
        return {
            "algorithm": "naive-per-department-fcfs",
            "horizon": self.horizon,
            "horizonStart": self.horizon_start.isoformat(),
            "horizonDays": self.horizon_days,
            "status": self.status,
            "departmentOrder": list(self.department_order),
            "metrics": self.metrics(),
            "blocks": [b.as_dict() for b in self.blocks],
            "deferredTasks": [d.as_dict() for d in self.deferred],
            "conflicts": {
                "doubleBookings": [c.as_dict() for c in self.double_bookings],
                "overSubscribedWindows": [w.as_dict() for w in self.over_subscribed],
                "note": "These are the OUTPUT of the baseline, not a defect in it. "
                "Departments booking blocks without cross-visibility is the current "
                "process this system replaces (PRD Section 12).",
            },
            "decisionLog": self.decision_log,
        }


def structurally_contestable(
    tasks: list[MaintenanceTask], corridors: dict[str, CorridorAvailability]
) -> set[str]:
    """Task ids that fit a single window outright - schedulable by EITHER
    engine, splitting or not.

    A task longer than every window its corridor offers is impossible for the
    baseline (which never splits, deliberately - D-082) and was, before T29
    Phase 1, equally impossible for the optimizer. Comparing the two engines
    over the full backlog would still credit the optimizer for work the
    BASELINE could never have placed, so T14's headline is still drawn from
    this subset. See D-031.

    **This is deliberately UNCHANGED by T29 Phase 1 splitting** - it remains
    exactly "fits one window", which is the baseline's real, permanent
    ceiling regardless of what the optimizer can additionally do. See
    `split_only_contestable` for the tasks splitting alone rescues, and
    D-084 for why the two must stay separate rather than being merged.
    """
    contestable: set[str] = set()
    for task in tasks:
        corridor = corridors.get(task.corridor_id)
        if not corridor or not corridor.daily_windows:
            continue
        if task.duration_minutes <= max(w.duration_minutes for w in corridor.daily_windows):
            contestable.add(task.task_id)
    return contestable


def split_only_contestable(
    tasks: list[MaintenanceTask],
    corridors: dict[str, CorridorAvailability],
    *,
    horizon_start: date,
    horizon_days: int,
) -> set[str]:
    """T29 Phase 1 (D-084): task ids that do NOT fit a single window (so are
    absent from `structurally_contestable`) but whose defect type is
    splittable and whose corridor's total capacity across this horizon
    reaches the full duration.

    Structurally unreachable for the baseline - not a close call, a
    capability the FR9.1 process categorically does not have - and only
    reachable for the optimizer if it also wins the resulting real capacity
    contest (`DeferralReason.NO_CAPACITY` names the ones that lose it). This
    is what makes "impossible for both engines" (`structurally_contestable`'s
    complement) an overstatement post-T29: some of that complement is now
    possible for one of the two engines, and reporting it silently as still
    "impossible for both" would understate the optimizer's real, demonstrated
    capability. See docs/DECISIONS.md D-084 for the full reasoning and the
    real corpus numbers this produces (36 contestable / 32 split-only / 21
    genuinely impossible, of 89).

    Takes `horizon_start`/`horizon_days` because - unlike
    `structurally_contestable`'s single-window check, which is a fact about
    the daily pattern alone - total capacity across a horizon genuinely
    depends on how many days that horizon spans (D-021's daily pattern,
    replayed). Evaluated at the SAME horizon the comparison itself is drawn
    from, so the classification matches what that specific solve actually
    considered.
    """
    windows_by_corridor: dict[str, list[WindowInstance]] = {}
    for window in expand_windows(corridors, horizon_start, horizon_days):
        windows_by_corridor.setdefault(window.corridor_id, []).append(window)

    split_only: set[str] = set()
    for task in tasks:
        candidates = windows_by_corridor.get(task.corridor_id, [])
        if classify_structural_feasibility(task, candidates) == StructuralCategory.SPLIT_ONLY:
            split_only.add(task.task_id)
    return split_only


def run_baseline(
    tasks: list[MaintenanceTask],
    corridors: dict[str, CorridorAvailability],
    *,
    horizon_start: date,
    horizon_days: int = 7,
    department_order: tuple[str, ...] = DEPARTMENT_ORDER,
) -> BaselineResult:
    """Each department books its own work, first-come-first-served, blind to the rest.

    Ordering within a department is by `date_raised`, oldest first, with task id
    breaking ties. There is no submission timestamp in the data, and the date the
    defect was raised is the closest honest analogue: a block-demand queue really
    is worked in the order requests arrive.

    Deliberately NOT ordered by `sla_due_date`. That would be earliest-deadline-
    first, which is a genuinely good scheduling heuristic - using it here would
    quietly make the "naive" baseline smarter than the process it represents and
    flatter the comparison in the wrong direction. FCFS means arrival order, and
    nothing else (D-029).

    Ties break on task id so the baseline is as reproducible as the optimizer.
    """
    windows = expand_windows(corridors, horizon_start, horizon_days)
    windows_by_corridor: dict[str, list[WindowInstance]] = {}
    for window in windows:
        windows_by_corridor.setdefault(window.corridor_id, []).append(window)
    # Chronological: an independent planner takes the earliest slot it can see.
    for corridor_windows in windows_by_corridor.values():
        corridor_windows.sort(key=lambda w: (w.day, w.start_minute))

    horizon = "weekly" if horizon_days == 7 else f"{horizon_days}-day"
    result = BaselineResult(
        horizon=horizon,
        horizon_start=horizon_start,
        horizon_days=horizon_days,
        department_order=department_order,
    )

    placements: dict[str, tuple[WindowInstance, int, int]] = {}
    tasks_by_id = {task.task_id: task for task in tasks}
    # window key -> list of (task_id, start, end) placed by ANY department. Used
    # only for conflict reporting afterwards; no department's pass consults it.
    claims: dict[str, list[tuple[str, int, int]]] = {}

    for department in department_order:
        queue = sorted(
            (task for task in tasks if task.department == department),
            # Undated tasks sort last, deterministically, rather than silently
            # jumping the queue.
            key=lambda task: (task.date_raised or date.max, task.task_id),
        )
        # THE POINT OF THE ALGORITHM: this department's view of the calendar
        # starts empty every pass. It tracks only its own consumption, so it
        # never sees the windows another department has already taken.
        own_usage: dict[str, int] = {}

        for task in queue:
            candidates = windows_by_corridor.get(task.corridor_id, [])
            if not candidates:
                result.deferred.append(
                    DeferredTask(
                        task.task_id,
                        DeferralReason.NO_WINDOW_ON_CORRIDOR,
                        f"corridor {task.corridor_id} has no free block window in the "
                        f"{horizon} horizon",
                    )
                )
                continue

            longest = max(window.duration_minutes for window in candidates)
            if task.duration_minutes > longest:
                # D-084: this used to be "impossible for any algorithm" always -
                # true before T29 Phase 1, but no longer true for a task this
                # baseline still cannot place (it never splits, by design -
                # D-082) that the OPTIMIZER genuinely can via splitting. The
                # claim actually made must match which of those two this is.
                category = classify_structural_feasibility(task, candidates)
                if category == StructuralCategory.SPLIT_ONLY:
                    detail = (
                        f"needs {task.duration_minutes} min but the longest free window on "
                        f"{task.corridor_id} is {longest} min - this non-splitting process "
                        f"cannot place it, but a splitting-aware engine could (T29 Phase 1); "
                        f"a baseline limitation, not a fact about the timetable"
                    )
                else:
                    # Identical to the optimizer's verdict, and for the same
                    # reason: the corridor's traffic leaves no gap this long,
                    # even considering splitting (D-024, D-084).
                    detail = (
                        f"needs {task.duration_minutes} min but the longest free window on "
                        f"{task.corridor_id} is {longest} min - impossible for any algorithm, "
                        f"not a baseline shortcoming"
                    )
                result.deferred.append(
                    DeferredTask(task.task_id, DeferralReason.EXCEEDS_LONGEST_WINDOW, detail)
                )
                continue

            placed = False
            for window in candidates:
                used = own_usage.get(window.key, 0)
                if task.duration_minutes <= window.duration_minutes - used:
                    start = window.start_minute + used
                    end = start + task.duration_minutes
                    own_usage[window.key] = used + task.duration_minutes
                    placements[task.task_id] = (window, start, end)
                    claims.setdefault(window.key, []).append((task.task_id, start, end))
                    placed = True
                    break

            if not placed:
                result.deferred.append(
                    DeferredTask(
                        task.task_id,
                        DeferralReason.NO_CAPACITY,
                        f"{department} exhausted the windows it could see on "
                        f"{task.corridor_id}; it had no visibility of other departments' "
                        f"claims, so this is its own backlog competing with itself",
                    )
                )

    _build_blocks(result, placements, tasks_by_id, windows)
    _detect_conflicts(result, claims, tasks_by_id, windows)
    result.decision_log = _build_decision_log(tasks, placements, result.deferred)

    # Same invariant the optimizer holds itself to (FR3.3): nothing vanishes.
    accounted = result.scheduled_task_ids | {d.task_id for d in result.deferred}
    missing = {task.task_id for task in tasks} - accounted
    if missing:
        raise AssertionError(f"tasks missing from the baseline result: {sorted(missing)}")

    return result


def _build_blocks(result, placements, tasks_by_id, windows) -> None:
    """Group placements into blocks - one per department per window.

    Never merged across departments, because two departments taking the same
    window did not agree a shared possession; they each requested one, unaware
    of the other. Merging them would render the conflict invisible and invent a
    batch the baseline cannot produce.
    """
    windows_by_key = {window.key: window for window in windows}
    grouped: dict[tuple[str, str], list[str]] = {}

    for task_id, (window, _start, _end) in placements.items():
        grouped.setdefault((window.key, tasks_by_id[task_id].department), []).append(task_id)

    for (window_key, department), task_ids in sorted(grouped.items()):
        window = windows_by_key[window_key]
        ordered = sorted(task_ids)
        result.blocks.append(
            ScheduledBlock(
                corridor_id=window.corridor_id,
                day=window.day,
                window_index=window.window_index,
                start_minute=window.start_minute,
                end_minute=window.end_minute,
                capacity_minutes=window.duration_minutes,
                used_minutes=sum(tasks_by_id[t].duration_minutes for t in ordered),
                task_ids=ordered,
                departments=[department] * len(ordered),
            )
        )

    result.blocks.sort(key=lambda b: (b.day, b.corridor_id, b.start_minute, b.departments[0]))


def _detect_conflicts(result, claims, tasks_by_id, windows) -> None:
    """Find where uncoordinated passes collided. Reported, never repaired."""
    windows_by_key = {window.key: window for window in windows}

    for window_key, placed in sorted(claims.items()):
        window = windows_by_key[window_key]

        for index, (first_id, first_start, first_end) in enumerate(placed):
            for second_id, second_start, second_end in placed[index + 1 :]:
                first_department = tasks_by_id[first_id].department
                second_department = tasks_by_id[second_id].department
                if first_department == second_department:
                    continue  # a department does not collide with itself
                overlap_start = max(first_start, second_start)
                overlap_end = min(first_end, second_end)
                if overlap_start < overlap_end:
                    result.double_bookings.append(
                        DoubleBooking(
                            corridor_id=window.corridor_id,
                            day=window.day,
                            task_ids=(first_id, second_id),
                            departments=(first_department, second_department),
                            overlap_start=overlap_start,
                            overlap_end=overlap_end,
                        )
                    )

        claimed = sum(end - start for _task_id, start, end in placed)
        if claimed > window.duration_minutes:
            result.over_subscribed.append(
                OverSubscribedWindow(
                    corridor_id=window.corridor_id,
                    day=window.day,
                    window_index=window.window_index,
                    capacity_minutes=window.duration_minutes,
                    claimed_minutes=claimed,
                    departments=[tasks_by_id[t].department for t, _s, _e in placed],
                )
            )

    result.double_bookings.sort(key=lambda c: (c.day, c.corridor_id, c.task_ids))
    result.over_subscribed.sort(key=lambda w: (w.day, w.corridor_id, w.window_index))


def _build_decision_log(tasks, placements, deferred) -> list[dict]:
    reasons = {item.task_id: item for item in deferred}
    log = []

    for task in sorted(tasks, key=lambda t: t.task_id):
        placed = placements.get(task.task_id)
        if placed is not None:
            window, start, end = placed
            log.append(
                {
                    "taskId": task.task_id,
                    "decision": "scheduled",
                    "corridorId": task.corridor_id,
                    "department": task.department,
                    "date": window.day.isoformat(),
                    "window": f"{_clock(start)}-{_clock(end)}",
                    "contributingFactors": {
                        "orderingRule": "first-come-first-served by dateRaised, then task id",
                        "durationMinutes": task.duration_minutes,
                        "sawOtherDepartments": False,
                    },
                }
            )
        else:
            item = reasons[task.task_id]
            log.append(
                {
                    "taskId": task.task_id,
                    "decision": "deferred",
                    "corridorId": task.corridor_id,
                    "department": task.department,
                    "reason": item.reason,
                    "detail": item.detail,
                    "contributingFactors": {
                        "orderingRule": "first-come-first-served by dateRaised, then task id",
                        "durationMinutes": task.duration_minutes,
                        "sawOtherDepartments": False,
                    },
                }
            )

    return log
