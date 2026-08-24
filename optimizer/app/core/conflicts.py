"""Typed conflict taxonomy - implements PRD 9.5.

PRD 9.5 argues that named, distinct conflict types with named resolutions are
far more convincing than a black-box "optimized" label. This module makes that
true: it converts what the solver and the baseline already detect into one
shape, with a type discriminator and the resolution strategy each type calls
for.

WHAT THIS DOES NOT DO
---------------------
It does not resolve anything. Resource no-overlap is still task T25; this
classifies and labels what is detected so a Controller can see it. Labelling a
resolution is not performing one, and the output says so. Dependency
precedence (PRD 9.7) is the one exception: T24 made it a hard CP-SAT
constraint, so `DEPENDENCY_ORDER_VIOLATION` is CHECKED_AND_CLEAR below, not a
live conflict type - see `app.core.scheduler`'s dependency constraints.

TWO CONFLICT LAYERS, KEPT APART
-------------------------------
Conflicts come from two different plans and must never be added together:

  * `baseline`  - conflicts the naive per-department process produces. They are
                  the FR9.1 finding, not a defect in this system.
  * `optimized` - constraints the CP-SAT model does not yet enforce. They are
                  real gaps in the plan this system produces.

Presenting "6 double-bookings" beside "11 resource conflicts" without that
distinction would read as the optimized plan carrying 17 conflicts, which is
false. Every record therefore carries `plan`. See docs/DECISIONS.md D-045.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable


class ConflictType:
    """The named types. PRD 9.5 asks for these to be distinct and demoable."""

    #: Two departments holding the same corridor at overlapping times.
    CORRIDOR_DOUBLE_BOOKING = "CORRIDOR_DOUBLE_BOOKING"
    #: A window claimed for more work than it can physically hold.
    WINDOW_OVER_SUBSCRIPTION = "WINDOW_OVER_SUBSCRIPTION"
    #: Two concurrent tasks needing the same crew, machine or permission.
    RESOURCE_CONTENTION = "RESOURCE_CONTENTION"
    #: A task scheduled before the prerequisite it depends on.
    DEPENDENCY_ORDER_VIOLATION = "DEPENDENCY_ORDER_VIOLATION"
    #: PRD 9.5 names this too. It CANNOT be detected yet - see
    #: `NOT_YET_DETECTABLE`. The constant exists so the taxonomy is complete.
    TRAIN_IMPACT_CONFLICT = "TRAIN_IMPACT_CONFLICT"


#: Types named by PRD 9.5 that this build genuinely cannot detect.
#:
#: Reported separately rather than as a count of zero. Zero would claim "we
#: checked and found none"; the truth is that nothing checks, because
#: train-impact scoring is task T22. That distinction is the same one this
#: project draws everywhere else between "not computed" and "computed as zero".
NOT_YET_DETECTABLE: dict[str, str] = {}

#: Types that ARE checked and found to have no occurrences.
#:
#: The distinction this whole structure exists to preserve: "we checked and
#: found none" is a different claim from "nothing checks". T22 moved
#: TRAIN_IMPACT_CONFLICT across that line, and it moved OUT of
#: `NOT_YET_DETECTABLE` rather than being listed in both - a type reported as
#: simultaneously undetectable and zero would be incoherent (D-056).
CHECKED_AND_CLEAR: dict[str, str] = {
    ConflictType.TRAIN_IMPACT_CONFLICT: (
        "Every scheduled block is checked against the corridor's observed train occupancy "
        "(T3's ISL-wise timetable). The optimizer only ever places work in free windows, so "
        "a collision would mean a defect in the window data or the model - which is why this "
        "is checked rather than assumed."
    ),
    ConflictType.DEPENDENCY_ORDER_VIOLATION: (
        "Dependency precedence (PRD 9.7) is enforced as a hard CP-SAT constraint (T24): a "
        "dependent task's window can only start once its prerequisite's window has ended, "
        "and only if the prerequisite is itself scheduled. `solve_schedule` asserts this "
        "holds on every solve rather than trusting it silently, which is why this is checked "
        "rather than assumed."
    ),
}


@dataclass(frozen=True)
class Resolution:
    """What to do about a conflict of this kind (PRD 9.5)."""

    #: Short label for a table cell.
    strategy: str
    #: A sentence a Controller can act on.
    explanation: str
    #: The task that would make this conflict impossible, where one exists.
    enforced_by: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "strategy": self.strategy,
            "explanation": self.explanation,
            "enforcedBy": self.enforced_by,
        }


@dataclass
class Conflict:
    """One detected conflict, in the shared shape."""

    type: str
    #: Which plan this conflict exists in - `optimized` or `baseline`.
    plan: str
    corridor_id: str | None
    date: str | None
    task_ids: list[str]
    departments: list[str]
    #: One line naming the specific clash, with real figures.
    detail: str
    resolution: Resolution
    #: Type-specific extras (shared resources, overlap minutes, and so on).
    extra: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "plan": self.plan,
            "corridorId": self.corridor_id,
            "date": self.date,
            "taskIds": self.task_ids,
            "departments": self.departments,
            "detail": self.detail,
            "resolution": self.resolution.as_dict(),
            **self.extra,
        }


# --------------------------------------------------------------------------- #
# Resolution strategies                                                        #
# --------------------------------------------------------------------------- #

CORRIDOR_RESOLUTION = Resolution(
    strategy="Merge into one shared possession",
    explanation=(
        "Both departments want the same corridor at the same time. If the combined work fits "
        "the window, one coordinated possession serves both and the corridor is taken out of "
        "traffic once instead of twice. If it does not fit, the lower-priority task defers."
    ),
    enforced_by=None,  # the optimizer already does this; the baseline cannot
)

OVER_SUBSCRIPTION_RESOLUTION = Resolution(
    strategy="Defer the excess work",
    explanation=(
        "More work is booked into this window than it can physically hold. Something must move "
        "to another window or be deferred - the window cannot be stretched, because the time "
        "either side of it is occupied by scheduled trains."
    ),
    enforced_by=None,
)

TRAIN_IMPACT_RESOLUTION = Resolution(
    strategy="Defer, or accept the traffic block",
    explanation=(
        "A maintenance window overlapping scheduled train movements. Either the work moves to "
        "a genuine gap, or a traffic block is taken and the displacement is accepted as its "
        "cost. This system costs that option but does not take it - see T22 Phase A."
    ),
    enforced_by=None,  # the model only ever assigns into free windows
)

DEPENDENCY_RESOLUTION = Resolution(
    strategy="Reorder to respect precedence",
    explanation=(
        "A maintenance workflow runs inspection, then repair, then testing. The optimizer "
        "already refuses to place a later stage before its prerequisite completes (T24); "
        "reaching this record at all would mean that constraint had a bug."
    ),
    enforced_by=None,  # the optimizer already does this - see CHECKED_AND_CLEAR above
)


def resource_resolution(same_department: bool) -> Resolution:
    """Resource contention reads differently within a department than across two.

    PRD 9.5's example is "two tasks need the same crew/machine, only one
    proceeds", which describes the cross-department case. Within one department
    it is not a contest between rival claimants - it is one office having
    double-booked its own gang, and the fix is to stagger the work rather than
    to drop a task.
    """
    if same_department:
        return Resolution(
            strategy="Stagger within the department",
            explanation=(
                "One department has booked the same crew or machine for two jobs running at "
                "the same time. Nobody outranks anybody here - the department sequences its "
                "own work into different windows."
            ),
            enforced_by="T25",
        )
    return Resolution(
        strategy="Only one proceeds",
        explanation=(
            "Two departments need the same depot resource simultaneously. One task proceeds "
            "and the other moves to a window where the resource is free."
        ),
        enforced_by="T25",
    )


# --------------------------------------------------------------------------- #
# Builders                                                                     #
# --------------------------------------------------------------------------- #

def from_known_gaps(known_gaps: dict[str, Any]) -> list[Conflict]:
    """Type the conflicts the CP-SAT plan carries (`optimized` layer)."""
    conflicts: list[Conflict] = []

    for raw in known_gaps.get("resourceConflicts", {}).get("conflicts", []):
        departments = raw.get("departments", [])
        same_department = len(set(departments)) <= 1
        shared = raw.get("sharedResourceIds", [])
        conflicts.append(
            Conflict(
                type=ConflictType.RESOURCE_CONTENTION,
                plan="optimized",
                corridor_id=raw.get("corridorId"),
                date=raw.get("date"),
                task_ids=raw.get("taskIds", []),
                departments=departments,
                detail=(
                    f"{' and '.join(raw.get('taskIds', []))} run at the same time and both need "
                    f"{', '.join(shared)}."
                ),
                resolution=resource_resolution(same_department),
                extra={
                    "sharedResourceIds": shared,
                    "sameDepartment": same_department,
                    "overlapStart": raw.get("overlapStart"),
                    "overlapEnd": raw.get("overlapEnd"),
                    "overlapMinutes": raw.get("overlapMinutes"),
                    # `corridorId` above is None for a cross-corridor pair (T24
                    # surfaced the first real one: resources are depot-scoped
                    # across corridors, not corridor-scoped) - `corridorIds`
                    # always carries both so that case is not silently dropped.
                    "corridorIds": raw.get("corridorIds"),
                },
            )
        )

    for raw in known_gaps.get("dependencyViolations", {}).get("violations", []):
        conflicts.append(
            Conflict(
                type=ConflictType.DEPENDENCY_ORDER_VIOLATION,
                plan="optimized",
                corridor_id=raw.get("corridorId"),
                date=raw.get("date"),
                task_ids=[raw.get("taskId"), raw.get("dependsOn")],
                departments=raw.get("departments", []),
                detail=(
                    f"{raw.get('taskId')} depends on {raw.get('dependsOn')} but "
                    f"{raw.get('issue')}."
                ),
                resolution=DEPENDENCY_RESOLUTION,
                extra={
                    "issue": raw.get("issue"),
                    "workflowStage": raw.get("workflowStage"),
                    "prerequisiteDate": raw.get("prerequisiteDate"),
                },
            )
        )

    return conflicts


def from_train_impact(records: list[dict[str, Any]], plan: str = "optimized") -> list[Conflict]:
    """Type any block that overlaps observed train occupancy (PRD 9.5/9.6, T22)."""
    return [
        Conflict(
            type=ConflictType.TRAIN_IMPACT_CONFLICT,
            plan=plan,
            corridor_id=raw.get("corridorId"),
            date=raw.get("date"),
            task_ids=raw.get("taskIds", []),
            departments=raw.get("departments", []),
            detail=(
                f"A block on {raw.get('corridorId')} overlaps {raw.get('trainsAffected')} "
                f"observed train movement(s) by {raw.get('displacedMinutes')} minutes."
            ),
            resolution=TRAIN_IMPACT_RESOLUTION,
            extra={
                "trainsAffected": raw.get("trainsAffected"),
                "displacedMinutes": raw.get("displacedMinutes"),
            },
        )
        for raw in records
    ]


def from_baseline_conflicts(conflicts_payload: dict[str, Any]) -> list[Conflict]:
    """Type the conflicts the naive baseline produces (`baseline` layer)."""
    conflicts: list[Conflict] = []

    for raw in conflicts_payload.get("doubleBookings", []):
        conflicts.append(
            Conflict(
                type=ConflictType.CORRIDOR_DOUBLE_BOOKING,
                plan="baseline",
                corridor_id=raw.get("corridorId"),
                date=raw.get("date"),
                task_ids=raw.get("taskIds", []),
                departments=raw.get("departments", []),
                detail=(
                    f"{' and '.join(raw.get('departments', []))} both hold "
                    f"{raw.get('corridorId')} from {raw.get('overlapStart')} to "
                    f"{raw.get('overlapEnd')} - {raw.get('overlapMinutes')} minutes of overlap."
                ),
                resolution=CORRIDOR_RESOLUTION,
                extra={
                    "overlapStart": raw.get("overlapStart"),
                    "overlapEnd": raw.get("overlapEnd"),
                    "overlapMinutes": raw.get("overlapMinutes"),
                },
            )
        )

    for raw in conflicts_payload.get("overSubscribedWindows", []):
        conflicts.append(
            Conflict(
                type=ConflictType.WINDOW_OVER_SUBSCRIPTION,
                plan="baseline",
                corridor_id=raw.get("corridorId"),
                date=raw.get("date"),
                task_ids=[],
                departments=raw.get("departments", []),
                detail=(
                    f"{' + '.join(raw.get('departments', []))} claimed "
                    f"{raw.get('claimedMinutes')} min of a {raw.get('capacityMinutes')} min "
                    f"window - {raw.get('excessMinutes')} min more than it can hold."
                ),
                resolution=OVER_SUBSCRIPTION_RESOLUTION,
                extra={
                    "windowIndex": raw.get("windowIndex"),
                    "capacityMinutes": raw.get("capacityMinutes"),
                    "claimedMinutes": raw.get("claimedMinutes"),
                    "excessMinutes": raw.get("excessMinutes"),
                },
            )
        )

    return conflicts


def summarise(conflicts: Iterable[Conflict]) -> dict[str, Any]:
    """Group typed conflicts for display, keeping the two plans apart.

    Counts are nested under their plan on purpose. A flat total across both
    layers would be a meaningless number that reads as an indictment of the
    optimized plan (D-045).
    """
    listed = list(conflicts)
    by_plan: dict[str, dict[str, Any]] = {}
    seen_types = {conflict.type for conflict in listed}

    for conflict in listed:
        plan_bucket = by_plan.setdefault(conflict.plan, {"total": 0, "byType": {}})
        plan_bucket["total"] += 1
        plan_bucket["byType"][conflict.type] = plan_bucket["byType"].get(conflict.type, 0) + 1

    return {
        "byPlan": by_plan,
        "conflicts": [conflict.as_dict() for conflict in listed],
        "notYetDetectable": [
            {"type": conflict_type, "reason": reason}
            for conflict_type, reason in NOT_YET_DETECTABLE.items()
        ],
        # Checked, and none found. Reported separately from both the counted
        # types and the undetectable ones, because "zero" only means something
        # when you can say what was checked to get it.
        "checkedAndClear": [
            {"type": conflict_type, "reason": reason}
            for conflict_type, reason in CHECKED_AND_CLEAR.items()
            if conflict_type not in seen_types
        ],
        "note": (
            "Conflicts are grouped by the plan they occur in and are never totalled across "
            "plans: baseline conflicts are the FR9.1 finding, while optimized-plan conflicts "
            "are constraints the solver does not yet enforce (T25 - dependency precedence, "
            "PRD 9.7, is enforced as of T24 and lives in checkedAndClear instead). "
            "Resolutions are classified, not applied."
        ),
    }
