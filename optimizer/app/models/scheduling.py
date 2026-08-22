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


class CorridorIn(ApiModel):
    """A corridor's free-window pattern."""

    corridor_id: str = Field(min_length=1, max_length=64)
    daily_windows: list[WindowIn] = Field(default_factory=list)
    #: T3's data-quality flag. The solver refuses to schedule a flagged
    #: corridor; surfaced here so Node cannot accidentally send one.
    low_confidence: bool = False

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

    #: FR2.2, task T16. Accepted and deliberately unused by the priority engine.
    failure_risk_score: float | None = Field(default=None, ge=0, le=1)


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


class SolveRequest(ScenarioIn):
    """A scheduling request. Solver weights arrive with T23's policy sliders."""

    horizon_start: date
    horizon_days: int = Field(default=7, ge=1)
    #: Optional per-request cap. Clamped to the service's configured ceiling so
    #: a client cannot ask the solver to run indefinitely.
    max_seconds: float | None = Field(default=None, gt=0)


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
