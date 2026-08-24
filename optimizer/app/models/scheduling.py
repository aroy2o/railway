"""Request and response contract for the scheduling endpoints.

THE CONTRACT IS A CLEAN INTERMEDIATE SHAPE, NOT MONGODB DOCUMENTS
-----------------------------------------------------------------
Node owns MongoDB; this service owns OR-Tools. The payload is deliberately the
narrow set of facts the solver actually needs, not the documents Node happens to
have. Two reasons: a schema change in T5's collections must not break the
optimizer, and the contract then documents exactly what a solve depends on -
which is far less than a corridor or task document carries.

It also means the joins are Node's job. `assetCriticalityScore` arrives already
resolved onto the task, because only Node can reach the assets collection. That
matches the data flow in PRD Section 11.

Field names are camelCase to match the rest of the system's JSON (the T5 API,
and the `as_dict()` output of the solver dataclasses). `populate_by_name` is on,
so a snake_case client also works.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(word.capitalize() for word in rest)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel,
        populate_by_name=True,
        # Reject unknown fields rather than ignoring them. A typo in a field
        # name would otherwise be silently dropped and change the solve - a
        # missing `dateRaised`, for instance, degrades the baseline's
        # first-come-first-served ordering to "everything sorts last" without
        # any error at all.
        extra="forbid",
    )


class WindowIn(ApiModel):
    """One free window in a corridor's repeating daily pattern (T3)."""

    start_minute: int = Field(ge=0, le=1440)
    end_minute: int = Field(ge=0, le=1440)

    @model_validator(mode="after")
    def _check_order(self) -> "WindowIn":
        if self.end_minute <= self.start_minute:
            raise ValueError("endMinute must be greater than startMinute")
        return self


class OccupiedWindowIn(ApiModel):
    """When trains actually hold the corridor (T3).

    Used only to cost a traffic block (T22 Phase A). The solver never assigns
    work into these - it only ever uses `daily_windows`.
    """

    start_minute: int = Field(ge=0, le=1440)
    end_minute: int = Field(ge=0, le=1440)


class CorridorIn(ApiModel):
    """A corridor's free-window pattern."""

    corridor_id: str = Field(min_length=1, max_length=64)
    daily_windows: list[WindowIn] = Field(default_factory=list)
    #: T3's data-quality flag. The solver refuses to schedule a flagged
    #: corridor; surfaced here so Node cannot accidentally send one.
    low_confidence: bool = False
    #: T22. Optional - without them a deferral is reported as UNCOSTED rather
    #: than as costing zero, because "we did not look" is not "nothing there".
    occupied_windows: list[OccupiedWindowIn] = Field(default_factory=list)
    #: T3's observed train-class counts, for apportioning a displacement's
    #: class split. See `app.core.trains`.
    train_class_mix: dict[str, int] | None = None
    #: T26, PRD 9.9. Real, from Ministry of Jal Shakti flood-risk state data
    #: (see app.core.weather). `None` when the corridor's stations have no
    #: known state - never guessed as "not at risk".
    seasonal_risk_flag: Literal["monsoon-risk", "none", "flood-prone"] | None = None

    @field_validator("daily_windows")
    @classmethod
    def _check_disjoint(cls, windows: list[WindowIn]) -> list[WindowIn]:
        ordered = sorted(windows, key=lambda w: w.start_minute)
        for previous, current in zip(ordered, ordered[1:]):
            if current.start_minute < previous.end_minute:
                raise ValueError(
                    "dailyWindows must be disjoint; T3 emits a merged complement of occupancy"
                )
        return windows


class TaskIn(ApiModel):
    """A pending maintenance task, with the joins Node has already resolved."""

    task_id: str = Field(min_length=1, max_length=64)
    corridor_id: str = Field(min_length=1, max_length=64)
    department: str = Field(min_length=1, max_length=32)
    est_block_duration_mins: int = Field(gt=0, le=1440)
    sla_due_date: date
    severity: int = Field(ge=1, le=5)

    #: REAL - the asset's FR2.1 criticality score, joined on by Node. Optional
    #: only so /optimize can be driven without it; /prioritize requires it.
    asset_criticality_score: float | None = Field(default=None, ge=0, le=100)

    #: Load-bearing for the FR9.1 baseline's first-come-first-served ordering
    #: (D-029). Optional in the schema, but its absence degrades the baseline to
    #: "everything sorts last", so /baseline warns when it is missing.
    date_raised: date | None = None

    depends_on_task_id: str | None = Field(default=None, max_length=64)
    required_resource_ids: list[str] = Field(default_factory=list)

    #: FR2.2 predicted failure risk (T16). Real since T16; the priority engine
    #: weights it at 0.20 when present and renormalises the other four when not.
    # 0-100, matching `asset_criticality_score`. T7 declared this 0-1 while the
    # field was unpopulated and unused; T16 made it real and aligned the two
    # scales, because two 0-100 factors and one 0-1 factor in the same weighted
    # sum is a silent-scaling bug waiting to happen. Nothing consumed the old
    # range - it was null on every task (D-055).
    failure_risk_score: float | None = Field(default=None, ge=0, le=100)


class ScenarioIn(ApiModel):
    """Tasks plus the corridors they sit on - the input both solvers share."""

    # At least one of each. An empty payload would solve to an empty plan
    # perfectly happily, which is almost certainly the caller having fetched
    # nothing - the same fail-loud-at-the-boundary posture used everywhere else
    # in this project.
    tasks: list[TaskIn] = Field(min_length=1)
    corridors: list[CorridorIn] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_referential_integrity(self) -> "ScenarioIn":
        """Catch a dangling corridor reference here, not as a KeyError inside
        the solver. A 422 naming the offending ids is a far better failure than
        a 500 from three frames deep."""
        seen: set[str] = set()
        duplicates: set[str] = set()
        for corridor in self.corridors:
            if corridor.corridor_id in seen:
                duplicates.add(corridor.corridor_id)
            seen.add(corridor.corridor_id)
        if duplicates:
            raise ValueError(f"duplicate corridorId(s): {sorted(duplicates)}")

        task_ids: set[str] = set()
        duplicate_tasks: set[str] = set()
        for task in self.tasks:
            if task.task_id in task_ids:
                duplicate_tasks.add(task.task_id)
            task_ids.add(task.task_id)
        if duplicate_tasks:
            raise ValueError(f"duplicate taskId(s): {sorted(duplicate_tasks)}")

        missing = sorted({task.corridor_id for task in self.tasks} - seen)
        if missing:
            raise ValueError(
                f"tasks reference corridor(s) not present in the payload: {missing}"
            )

        dangling = sorted(
            {t.depends_on_task_id for t in self.tasks if t.depends_on_task_id} - task_ids
        )
        if dangling:
            raise ValueError(f"dependsOnTaskId references unknown task(s): {dangling}")
        return self


#: Bounds on each policy weight, as a multiplier of its D-023 default.
#:
#: Independently AND in worst-case combination, this range was verified never
#: to trade away coverage: at the floor of every weight simultaneously (0.1x
#: coverage against the 10x CEILING of unused_minute and fragmentation - the
#: combination that most favours "tidiness" over "get the work done") the real
#: corpus still schedules all 36 tasks. Going further out breaks it - coverage
#: at 0.01x with the same ceiling drops scheduling to 27 tasks, and at 0.0001x
#: to 3 - so the chosen range sits with a wide margin inside "safe", not on the
#: edge of it. See docs/DECISIONS.md D-061.
#:
#: A fixed multiplier range was chosen over deriving a formula from the
#: corpus's minimum priority score (24 on the real corpus) because a formula
#: tied to today's data would need re-deriving the moment the corpus changes;
#: a margin this wide does not.
WEIGHT_MIN_MULTIPLIER = 0.1
WEIGHT_MAX_MULTIPLIER = 10.0


class PolicyWeightsIn(ApiModel):
    """T23 (PRD 13.1) - the five D-023 objective terms, as overridable inputs.

    Every field is optional; an omitted term keeps its D-023 default. Bounds
    are validated, not clamped - PRD Section 6 treats an invalid input as
    something to refuse and explain, not to quietly reinterpret. A caller who
    asked for `coverage=1` almost certainly did not mean "silently use the
    nearest safe value"; they meant something the system cannot honestly do.
    """

    coverage: int | None = Field(default=None, ge=1000, le=100_000)
    sla_compliance: int | None = Field(default=None, ge=200, le=20_000)
    batching: int | None = Field(default=None, ge=300, le=30_000)
    unused_minute: int | None = Field(default=None, ge=1, le=10)
    fragmentation: int | None = Field(default=None, ge=50, le=5_000)


class SolveRequest(ScenarioIn):
    """A scheduling request."""

    horizon_start: date
    horizon_days: int = Field(default=7, ge=1)
    #: Optional per-request cap. Clamped to the service's configured ceiling so
    #: a client cannot ask the solver to run indefinitely.
    max_seconds: float | None = Field(default=None, gt=0)
    #: T23's policy sliders (PRD Section 8, 13.1). Omitted terms use the
    #: D-023 default; the weights actually used are always returned in the
    #: response so a caller (and `schedule.policyWeights`) can see the real
    #: values, never an assumed default.
    policy_weights: PolicyWeightsIn | None = None


class WhatIfRequest(ScenarioIn):
    """T20 (PRD FR5, 9.4) - "what if this task were placed differently?"

    Deliberately the SAME scenario shape as `SolveRequest` - a what-if is a
    real re-solve of the real model, not a lighter parallel endpoint, so it
    needs exactly the inputs a solve needs.
    """

    horizon_start: date
    horizon_days: int = Field(default=7, ge=1)
    max_seconds: float | None = Field(default=None, gt=0)
    policy_weights: PolicyWeightsIn | None = None
    #: The task the Controller is asking about.
    task_id: str = Field(min_length=1, max_length=64)


class CurrentPlacementIn(ApiModel):
    """Where one task sits in the plan being amended (T27).

    Node's job, not the optimizer's: this service never touches MongoDB, so it
    has no way to know what is currently scheduled, including anything T15's
    manual overrides have since moved. A task with no entry here is currently
    deferred - the absence IS the information, not a value to default.
    """

    task_id: str = Field(min_length=1, max_length=64)
    corridor_id: str = Field(min_length=1, max_length=64)
    date: date
    window_index: int = Field(ge=0)


class DisruptedWindowIn(ApiModel):
    """One window on the affected corridor that an emergency has consumed."""

    date: date
    window_index: int = Field(ge=0)


class EmergencyReoptimizeRequest(ScenarioIn):
    """T27 (PRD FR3.5, 9.10) - disruption-resilient rolling re-optimization.

    "Re-solve constrained to only the affected corridor and remaining
    unelapsed time window, holding already-executed blocks fixed" (PRD 13.1).
    Unlike T20's what-if, this is not a hypothetical: the caller means to
    commit the answer, so it needs the plan as it REALLY stands right now
    (`current_placements`, effective-plan-with-overrides, not a freshly
    re-solved baseline) rather than reconstructing one.
    """

    horizon_start: date
    horizon_days: int = Field(default=7, ge=1)
    max_seconds: float | None = Field(default=None, gt=0)
    policy_weights: PolicyWeightsIn | None = None
    #: The one corridor this re-solve is allowed to change.
    corridor_id: str = Field(min_length=1, max_length=64)
    #: The plan being amended, as it currently stands - every task NOT listed
    #: here is currently deferred.
    current_placements: list[CurrentPlacementIn] = Field(default_factory=list)
    #: The emergency itself: window(s) on `corridor_id` that are no longer
    #: available. At least one is required - an emergency re-solve with
    #: nothing disrupted is not a real request.
    disrupted_windows: list[DisruptedWindowIn] = Field(min_length=1)
    #: FR6.2's mandatory-reason discipline, applied here too: this re-solve
    #: commits, so it needs the same audit trail an override does.
    reason: str = Field(min_length=8, max_length=500)

    @model_validator(mode="after")
    def _check_referential_integrity(self) -> "EmergencyReoptimizeRequest":
        corridor_ids = {c.corridor_id for c in self.corridors}
        if self.corridor_id not in corridor_ids:
            raise ValueError(f"corridorId {self.corridor_id!r} is not in the payload's corridors")

        task_ids = {t.task_id for t in self.tasks}
        dangling = sorted({p.task_id for p in self.current_placements} - task_ids)
        if dangling:
            raise ValueError(f"currentPlacements reference unknown task(s): {dangling}")

        by_task = {t.task_id: t for t in self.tasks}
        mismatched = sorted(
            p.task_id
            for p in self.current_placements
            if by_task[p.task_id].corridor_id != p.corridor_id
        )
        if mismatched:
            raise ValueError(
                f"currentPlacements corridorId disagrees with the task's own corridorId "
                f"for: {mismatched}"
            )

        corridor_window_counts = {c.corridor_id: len(c.daily_windows) for c in self.corridors}
        affected_window_count = corridor_window_counts.get(self.corridor_id, 0)
        out_of_range = sorted(
            {w.window_index for w in self.disrupted_windows if w.window_index >= affected_window_count}
        )
        if out_of_range:
            raise ValueError(
                f"disruptedWindows windowIndex {out_of_range} out of range for "
                f"{self.corridor_id!r}, which has {affected_window_count} daily window(s)"
            )
        return self


class PrioritizeRequest(ApiModel):
    """FR2.4 ranked-queue request."""

    tasks: list[TaskIn] = Field(min_length=1)
    #: The date SLA urgency is measured against - normally the horizon start.
    as_of: date

    @model_validator(mode="after")
    def _require_criticality(self) -> "PrioritizeRequest":
        missing = sorted(
            task.task_id for task in self.tasks if task.asset_criticality_score is None
        )
        if missing:
            raise ValueError(
                "assetCriticalityScore is required for FR2.3 scoring and is a REAL "
                f"value Node must join from the assets collection; missing for: {missing[:10]}"
            )
        return self


class DegradationPointIn(ApiModel):
    """One simulated asset-health observation (T4)."""

    #: Accepted for contract fidelity with T4's stored shape and then ignored:
    #: observations are evenly spaced by construction, and reading the dates
    #: would invite a precision the generator does not support. Typed as a
    #: string rather than a date because the field name shadows the `date` type
    #: imported above - and a parsed value nothing reads is dead weight anyway.
    date: str | None = None
    health_metric: float = Field(ge=0, le=1)


class AssetRiskIn(ApiModel):
    """An asset and its simulated degradation history (FR2.2, PRD 9.1)."""

    asset_id: str = Field(min_length=1, max_length=64)
    degradation_history: list[DegradationPointIn] = Field(default_factory=list)


class RiskRequest(ApiModel):
    """Assets to score. See PRD 9.1 on how the output must be framed."""

    assets: list[AssetRiskIn] = Field(min_length=1)
