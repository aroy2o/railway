"""CP-SAT block scheduler - implements PRD Section 13 / FR3.

WHAT THIS MODULE IS
-------------------
The constraint model and nothing else. It takes plain dataclasses in and returns
a result object; it never touches FastAPI, MongoDB or the network, so it can be
unit-tested standalone (CLAUDE.md Python convention, and testing priority #1).

WHAT IS IMPLEMENTED FROM PRD SECTION 13
---------------------------------------
* Decision variables: `assign[i][j]` per task i and candidate free window j on
  its corridor.
* Each task assigned to at most one window - EXCEPT a splittable task (T29
  Phase 1, see below), which may use several; unassigned means deferred
  either way, and every deferral carries a machine-readable reason (FR3.3 -
  never silently dropped).
* Sum of assigned durations in a window <= window length.
* Windows on one corridor never overlap - guaranteed structurally by T3, which
  emits the merged complement of occupancy, and asserted here rather than
  re-encoded as constraints.
* Cross-department batching: several tasks may share one window, and a window
  carrying two or more departments is explicitly rewarded (implemented for real,
  see `_add_batching`).
* Deadline: SLA compliance is an objective reward, not a hard constraint - see
  the note on `WEIGHT_SLA` below for why the data forces this.
* Dependency precedence (T24, PRD 9.7): a hard constraint, not an objective
  term. A dependent task's window may only start at or after its prerequisite's
  window ends, and a dependent may only be scheduled at all if its prerequisite
  is too - transitively, so a 3-stage chain with a structurally unschedulable
  first stage takes the whole chain out. See `solve_schedule`'s "constraint:
  dependency precedence" section and `DeferralReason.PREREQUISITE_UNSCHEDULABLE`.
* Resource no-overlap (T25, PRD 9.8): also a hard constraint. Two tasks
  sharing any `required_resource_ids` entry (crew, machine or permission)
  cannot occupy overlapping windows, on any corridor - resources are
  depot-scoped, not corridor-scoped. Symmetric, unlike dependency: no linking
  constraint is needed, only a pairwise exclusion per resource-sharing pair.
* Objective: a simplified form of PRD 13.1 - priority-weighted coverage, SLA
  compliance and batching rewarded; unused block time and fragmentation
  penalised.
* Task splitting (T29 Phase 1, new scope beyond the original PRD 13 model): a
  task whose defect type is deemed splittable (`app.core.splitting` - a
  documented judgement call, not a PRD fact) may be covered by 2+
  non-contiguous windows instead of exactly one, each segment >=
  `MIN_SPLIT_SEGMENT_MINUTES`, summing exactly to the task's full duration.
  Mechanically: `assign[i][j]` keeps meaning "task i has some presence in
  window j" for every constraint that only needs that (dependency
  precedence, resource no-overlap, batching, pins); a new
  `segment_minutes[i][j]` carries how much of the duration that presence
  represents, and a new per-task `covered[i]` replaces "at most one window"
  for a splittable task, tied to `sum(segment_minutes) == duration *
  covered` - so a task is always either fully scheduled or fully deferred,
  never partially done. **Known limitation, flagged rather than silently
  left:** T20's `Pin`/T27's `pins` still name at most ONE window per task.
  Pinning a splittable task therefore pins only one of its segments, not
  its full multi-segment placement - a real gap for what-if/emergency
  re-optimization over an already-split plan, out of this phase's scope
  (extending Pin to a per-task window SET) and not yet built.
----------------------------------------------------------------
This list was originally "deferred to a later task"; every task named below
is now done (audit session, 2026-08-25 - the module docstring had not been
updated to say so, which is its own small honesty gap: a reader checking
"is this built yet" against source would have been told no for features
that have been done for days). Each ended up implemented by a mechanism
*other* than a weighted objective term, by deliberate choice, not oversight:

* Real priority scores (FR2.3, T7) - done. `MaintenanceTask.priority` is the
  real weighted score (severity + asset criticality + SLA urgency/breach),
  not a severity placeholder. Feeds `weights.coverage * task.priority` above.
* Asset risk reduction (beta, FR2.2, T16) - `failureRiskScore` is computed
  and surfaced (Controller Dashboard, `/explain`), but is reporting-only:
  it does not reduce or reward anything in this objective.
* Train-delay-impact (lambda, PRD 9.6, T22) - traffic-block cost and train
  impact are computed and shown per block, same reporting-only treatment.
* Weather/seasonal risk (xi, PRD 9.9, T26) - `seasonalRiskFlag` is real data
  (Ministry of Jal Shakti), advisory only: the solver neither avoids nor
  prioritises flagged corridors. See T26's decision log entry for why this
  one is real but narrow (state-level, not section-specific).
* Resource conflicts (rho, PRD 9.8, T25) - the opposite direction: promoted
  to a hard constraint (`solve_schedule`'s "constraint: resource no-overlap"
  section) rather than a soft objective penalty, same treatment as
  dependency precedence (T24) above.
* Policy-slider weights (PRD 13.1, T23) - NOT deferred and not a constant:
  `weights.coverage`/`sla_compliance`/`batching`/`unused_minute`/
  `fragmentation` above are caller-supplied (Controller Dashboard sliders),
  validated against the widest range verified safe on the real corpus.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta

from ortools.sat.python import cp_model

from app.core.splitting import MIN_SPLIT_SEGMENT_MINUTES, is_splittable_defect
from app.core.trains import cheapest_displacement
from app.core.weather import detect_weather_risk

logger = logging.getLogger(__name__)

MINUTES_PER_DAY = 24 * 60


# --------------------------------------------------------------------------- #
# Objective weights                                                            #
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class ObjectiveWeights:
    """Simplified PRD 13.1 objective. Becomes policy sliders in T23.

    The magnitudes encode a deliberate priority ORDER, not fine-tuning. Coverage
    is set far above every other term so that scheduling one more unit of
    priority-weighted work always beats any saving from batching, tighter
    packing or fewer possessions. The remaining terms only ever break ties
    between solutions that cover the same work.

    Concretely: covering the lowest-priority task earns 10,000, while the worst
    possible waste penalty on a single window is about 1,440 (a full day) plus
    500 for opening it. So coverage can never be traded away for tidiness -
    which is the correct railway answer, since deferred maintenance is a safety
    and reliability cost, not an inconvenience.
    """

    #: alpha - per unit of task priority scheduled (PRD 13.1 "Maintenance Priority").
    coverage: int = 10_000
    #: epsilon - per task landing on or before its slaDueDate ("SLA Compliance").
    sla_compliance: int = 2_000
    #: delta - per window carrying two or more departments ("Cross-Department Batching").
    batching: int = 3_000
    #: mu - per unused minute inside an opened window ("Unused Block Time").
    unused_minute: int = 1
    #: nu - per window opened at all ("Schedule Fragmentation").
    fragmentation: int = 500


DEFAULT_WEIGHTS = ObjectiveWeights()


# --------------------------------------------------------------------------- #
# Inputs                                                                       #
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class DailyWindow:
    """A free window in the repeating 24-hour pattern T3 produced."""

    start_minute: int
    end_minute: int

    @property
    def duration_minutes(self) -> int:
        return self.end_minute - self.start_minute


@dataclass(frozen=True)
class CorridorAvailability:
    """One corridor's free-window pattern, as computed by T3."""

    corridor_id: str
    daily_windows: tuple[DailyWindow, ...]
    #: T3's data-quality flag. A corridor carrying this must never be scheduled;
    #: T4 already excluded them from demand generation, so it is asserted here.
    low_confidence: bool = False
    #: When trains actually occupy the corridor (T3). Unused by the CP-SAT model
    #: - carried so a deferral can be costed as a traffic block (T22 Phase A).
    #: The solver still never schedules into these.
    occupied_windows: tuple[DailyWindow, ...] = ()
    #: The corridor's observed train-class counts (T3), for apportioning the
    #: class split of a displacement. See `app.core.trains`.
    train_class_mix: dict[str, int] | None = None
    #: T26, PRD 9.9. `"monsoon-risk"` | `"none"` | `None` (state unknown -
    #: never guessed). Real, from Ministry of Jal Shakti flood-risk state
    #: data joined at seed time - see `app.core.weather` and D-068. Unused
    #: by the CP-SAT model; advisory only, like `occupied_windows` above.
    seasonal_risk_flag: str | None = None


@dataclass(frozen=True)
class MaintenanceTask:
    """A pending maintenance task awaiting a block."""

    task_id: str
    corridor_id: str
    department: str
    duration_minutes: int
    sla_due_date: date
    #: FR2.3 priority. T7 supplies a real 0-100 score from severity + asset
    #: criticality + SLA urgency; before T7 this carried raw severity 1-5.
    priority: int
    depends_on_task_id: str | None = None
    required_resource_ids: tuple[str, ...] = ()
    #: True while `priority` is a stand-in rather than a computed FR2.3 score.
    #: Surfaced in the decision log so a downstream consumer can tell the
    #: difference instead of assuming. Defaults True so an un-migrated caller
    #: is honest by default rather than silently claiming a real score.
    priority_is_placeholder: bool = True
    #: When the defect was raised. Unused by the CP-SAT model - it is here for
    #: the FR9.1 baseline (T8), whose first-come-first-served ordering needs a
    #: genuine arrival time. Optional so existing callers are unaffected.
    date_raised: date | None = None
    #: T7's full FR2.4 breakdown behind `priority`, as `PriorityBreakdown.as_dict()`.
    #: Unused by the model - carried so the decision log can say WHY a task ranks
    #: where it does, not merely that it ranks there (T17). `/optimize` already
    #: computed this and discarded all but `solver_priority`; see D-048.
    priority_breakdown: dict | None = None
    #: T29 Phase 1. PRD 5.2's real defect-type vocabulary (e.g. "rail
    #: fracture", "track geometry defect"). Empty string when unset -
    #: `is_splittable` is then always False, which keeps every pre-T29
    #: caller (hand-built tests included) on exactly the old single-window
    #: behaviour with zero opt-in required.
    defect_type: str = ""

    @property
    def is_splittable(self) -> bool:
        """Whether this task's real-world work may be split across 2+
        non-contiguous windows (T29 Phase 1). See `app.core.splitting` for
        the rule and its reasoning - a documented judgement call, not a fact.
        """
        return is_splittable_defect(self.defect_type)


@dataclass(frozen=True)
class WindowInstance:
    """A dated occurrence of a daily window - the actual assignable slot.

    T3's calendar is a repeating daily pattern (it has no day-of-week data), so a
    weekly horizon is that pattern replayed once per day. See docs/DECISIONS.md
    D-021.
    """

    key: str
    corridor_id: str
    day: date
    window_index: int
    start_minute: int
    end_minute: int

    @property
    def duration_minutes(self) -> int:
        return self.end_minute - self.start_minute


# --------------------------------------------------------------------------- #
# Outputs                                                                      #
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Pin:
    """T20 - force one task's placement, or its exclusion, before the solve
    runs. The mechanism behind what-if simulation: everything else in the
    model - batching, capacity, the real objective - runs exactly as it does
    for a normal solve, so a pinned solve is a real CP-SAT answer, not a
    simplified stand-in.

    `window_key` is a `WindowInstance.key` (`corridorId|isoDate|windowIndex`)
    on the task's OWN corridor. A cross-corridor pin is refused for the same
    reason D-043 already refuses a cross-corridor override: the defect is on
    that corridor's asset, and moving the paperwork does not move the cracked
    rail.

    `window_key=None` means "exclude this task from the model entirely" - the
    what-if question "what if we deferred this instead, to free the
    capacity?"

    T29 PHASE 1 BUG, FOUND AND FIXED IN THE SAME SESSION SPLITTING SHIPPED IN
    ---------------------------------------------------------------------------
    A split task's real placement is 2+ windows, not one - `window_key`
    alone cannot express "hold this task's placement exactly as it stands"
    once splitting exists. T27's emergency re-optimization builds one `Pin`
    per currently-placed task from `current_placements`; before this field
    existed, a split task collapsed to whichever ONE of its segments
    happened to be last in that list, silently leaving its OTHER segments
    completely unpinned - free for the very re-solve that is supposed to
    hold "everything off the affected corridor exactly fixed" (PRD 9.10) to
    move or drop them instead. Caught by re-running T27's own real-corpus
    test after enabling splitting: dozens of off-corridor blocks that should
    have been byte-identical were not. This is not a T20/what-if-shaped risk
    (that sandbox never commits); T27 commits, so a silent gap here could
    have let a real emergency re-solve discard part of an already-executed
    possession. `window_keys` closes it: every window named here is forced
    to stay assigned, so a caller pinning a split task's full segment list
    genuinely holds all of it, not just one arbitrarily-chosen piece.
    """

    task_id: str
    window_key: str | None = None
    #: T29 Phase 1. All of a split task's windows, when more than one must be
    #: held simultaneously - mutually exclusive with `window_key` (set
    #: exactly one of the two, never both, never neither unless excluding).
    window_keys: tuple[str, ...] | None = None


class DeferralReason:
    """Machine-readable deferral codes (FR3.3).

    Kept as codes rather than free text so the API (T9) can group them and the
    explainability layer (T17) can turn them into grounded prose without parsing
    English.
    """

    NO_WINDOW_ON_CORRIDOR = "NO_WINDOW_ON_CORRIDOR"
    EXCEEDS_LONGEST_WINDOW = "EXCEEDS_LONGEST_WINDOW"
    NO_CAPACITY = "NO_CAPACITY"
    #: T27, PRD 9.10: every window that would otherwise have fit this task was
    #: removed by `blocked_window_keys` (already executed, or consumed by the
    #: disruption itself) before the solver ever weighed one task against
    #: another. Distinct from NO_CAPACITY on purpose: NO_CAPACITY means this
    #: task lost a real contest to higher-priority work, which is not true
    #: here - there was no contest, because there was nothing left to contest.
    WINDOW_UNAVAILABLE = "WINDOW_UNAVAILABLE"
    #: T24, PRD 9.7: this task's prerequisite (`dependsOnTaskId`) cannot itself
    #: be scheduled in this horizon, so precedence makes this task unschedulable
    #: too - discovered before the solver runs, by walking the chain to a fixed
    #: point, so a 3-stage chain whose first stage is structural takes the whole
    #: chain out rather than leaving stages 2-3 to lose an unwinnable contest.
    PREREQUISITE_UNSCHEDULABLE = "PREREQUISITE_UNSCHEDULABLE"
    #: T29 Phase 1: this task's defect type is splittable, but even summing
    #: EVERY free window on its corridor across the whole horizon (each
    #: segment floored at MIN_SPLIT_SEGMENT_MINUTES) is not enough to reach
    #: its full duration. Distinct from EXCEEDS_LONGEST_WINDOW, which this
    #: replaces for a splittable task - splitting was tried and still did
    #: not fit, not skipped.
    EXCEEDS_TOTAL_CAPACITY_EVEN_SPLIT = "EXCEEDS_TOTAL_CAPACITY_EVEN_SPLIT"


@dataclass
class ScheduledBlock:
    """One possession: a window with the tasks assigned into it."""

    corridor_id: str
    day: date
    window_index: int
    start_minute: int
    end_minute: int
    capacity_minutes: int
    used_minutes: int
    task_ids: list[str]
    departments: list[str]
    #: T29 Phase 1: task_id -> minutes THIS block contributes to that task.
    #: Equals the task's full duration for a normal (non-split) placement;
    #: less than it for one segment of a split task - which is exactly what
    #: distinguishes the two cases for a reader of this block alone, without
    #: cross-referencing `ScheduleResult.split_tasks`.
    segment_minutes: dict[str, int] = field(default_factory=dict)

    @property
    def unused_minutes(self) -> int:
        return self.capacity_minutes - self.used_minutes

    @property
    def is_cross_department_batch(self) -> bool:
        return len(set(self.departments)) > 1

    def as_dict(self) -> dict:
        return {
            "corridorId": self.corridor_id,
            "date": self.day.isoformat(),
            "windowIndex": self.window_index,
            "start": _clock(self.start_minute),
            "end": _clock(self.end_minute),
            "startMinute": self.start_minute,
            "endMinute": self.end_minute,
            "capacityMinutes": self.capacity_minutes,
            "usedMinutes": self.used_minutes,
            "unusedMinutes": self.unused_minutes,
            "taskIds": sorted(self.task_ids),
            "departments": sorted(set(self.departments)),
            "isCrossDepartmentBatch": self.is_cross_department_batch,
            "taskSegmentMinutes": dict(sorted(self.segment_minutes.items())),
        }


@dataclass
class DeferredTask:
    """A task the solver could not place, with why (FR3.3)."""

    task_id: str
    reason: str
    detail: str
    #: T22 Phase A: what a traffic block for this task would cost, when one is
    #: possible. D-024 promised this figure and could not yet give it. None when
    #: the deferral has nothing to do with window length.
    displacement: dict | None = None

    def as_dict(self) -> dict:
        payload = {"taskId": self.task_id, "reason": self.reason, "detail": self.detail}
        if self.displacement is not None:
            payload["displacementOption"] = self.displacement
        return payload


@dataclass
class ScheduleResult:
    """The full, inspectable result.

    This shape is what T9 wraps in an API response and what T17 builds
    explanations on, so it carries per-task reasoning rather than only the
    assignment.
    """

    horizon: str
    horizon_start: date
    horizon_days: int
    status: str
    objective_value: int
    solve_seconds: float
    blocks: list[ScheduledBlock] = field(default_factory=list)
    deferred: list[DeferredTask] = field(default_factory=list)
    decision_log: list[dict] = field(default_factory=list)
    known_gaps: dict = field(default_factory=dict)
    #: T29 Phase 1: task_id -> split summary, present ONLY for a task placed
    #: across 2+ segments (a task that happened to fit in one window is not
    #: "split" even if its defect type is splittable). The authoritative
    #: source for "is this task split" - the decision log's `isSplit`/
    #: `segments` are derived from this same data, never a second
    #: computation, so the two can never disagree.
    split_tasks: dict[str, dict] = field(default_factory=dict)

    @property
    def scheduled_task_ids(self) -> set[str]:
        return {task_id for block in self.blocks for task_id in block.task_ids}

    def metrics(self) -> dict:
        used = sum(b.used_minutes for b in self.blocks)
        capacity = sum(b.capacity_minutes for b in self.blocks)
        return {
            "tasksScheduled": len(self.scheduled_task_ids),
            "tasksDeferred": len(self.deferred),
            "blocksUsed": len(self.blocks),
            "crossDepartmentBatches": sum(1 for b in self.blocks if b.is_cross_department_batch),
            "blockMinutesUsed": used,
            "blockMinutesCapacity": capacity,
            "blockUtilisationPct": round(100 * used / capacity, 2) if capacity else 0.0,
            "unusedBlockMinutes": capacity - used,
            "tasksSplit": len(self.split_tasks),
        }

    def as_dict(self) -> dict:
        return {
            "horizon": self.horizon,
            "horizonStart": self.horizon_start.isoformat(),
            "horizonDays": self.horizon_days,
            "status": self.status,
            "objectiveValue": self.objective_value,
            "solveSeconds": round(self.solve_seconds, 3),
            "metrics": self.metrics(),
            "blocks": [b.as_dict() for b in self.blocks],
            "deferredTasks": [d.as_dict() for d in self.deferred],
            "decisionLog": self.decision_log,
            "knownGaps": self.known_gaps,
            "splitTasks": self.split_tasks,
        }


def _clock(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


# --------------------------------------------------------------------------- #
# Horizon expansion                                                            #
# --------------------------------------------------------------------------- #

def expand_windows(
    corridors: dict[str, CorridorAvailability],
    horizon_start: date,
    horizon_days: int,
) -> list[WindowInstance]:
    """Replay each corridor's daily free-window pattern across the horizon.

    T3's calendar has no day-of-week dimension - it is one representative day
    (D-010) - so a weekly plan is that day repeated. Asserts the windows on a
    corridor are disjoint and ordered, which is what lets PRD 13's "no overlap
    between windows on the same corridor" hold structurally instead of needing
    its own constraint.
    """
    instances: list[WindowInstance] = []

    for corridor_id in sorted(corridors):
        corridor = corridors[corridor_id]

        if corridor.low_confidence:
            # T4 excluded these from demand generation. Reaching one here means
            # something upstream regressed, and scheduling against untrusted
            # occupancy would be worse than failing.
            raise ValueError(
                f"corridor {corridor_id} is flagged lowConfidence and must not be scheduled"
            )

        previous_end = -1
        for index, window in enumerate(corridor.daily_windows):
            if window.start_minute < previous_end:
                raise ValueError(
                    f"corridor {corridor_id} window {index} overlaps the previous one; "
                    "T3 must emit a disjoint, ordered free-window set"
                )
            if window.duration_minutes <= 0:
                raise ValueError(f"corridor {corridor_id} window {index} has non-positive length")
            previous_end = window.end_minute

            for offset in range(horizon_days):
                day = horizon_start + timedelta(days=offset)
                instances.append(
                    WindowInstance(
                        key=f"{corridor_id}|{day.isoformat()}|{index}",
                        corridor_id=corridor_id,
                        day=day,
                        window_index=index,
                        start_minute=window.start_minute,
                        end_minute=window.end_minute,
                    )
                )

    return instances


class StructuralCategory:
    """Where a task sits before the solver ever weighs one against another
    (T29 Phase 1 follow-up, docs/DECISIONS.md D-084).

    Three-way, not two-way, because splitting genuinely split D-024's old
    binary in two: a task the BASELINE (which never splits, deliberately -
    D-082) can never place is no longer automatically a task the OPTIMIZER
    can never place either.
    """

    #: Fits a single window outright - placeable by ANY engine, splitting or
    #: not. This is the fair, apples-to-apples comparison set (D-031) and is
    #: UNCHANGED by T29 Phase 1 - it must stay exactly what `structurally_
    #: contestable()` already computes, since that is the baseline's real
    #: ceiling regardless of what the optimizer can additionally do.
    CONTESTABLE = "contestable"
    #: T29 Phase 1: does NOT fit a single window, but the defect type is
    #: splittable and the corridor's total capacity across this horizon
    #: (respecting MIN_SPLIT_SEGMENT_MINUTES) reaches the full duration.
    #: Structurally unreachable for the baseline - not a close call, a
    #: capability the baseline categorically does not have - and only
    #: reachable for the optimizer if it also wins the resulting real
    #: capacity contest (see `DeferralReason.NO_CAPACITY`).
    SPLIT_ONLY = "splitOnly"
    #: Genuinely impossible for either engine even considering splitting -
    #: `DeferralReason.EXCEEDS_LONGEST_WINDOW` (not splittable) or
    #: `EXCEEDS_TOTAL_CAPACITY_EVEN_SPLIT` (splittable but still not enough
    #: total capacity across the whole horizon).
    IMPOSSIBLE = "impossible"


def classify_structural_feasibility(
    task: MaintenanceTask, candidates: list[WindowInstance]
) -> str:
    """One task's `StructuralCategory`, given its corridor's real candidate
    windows across the horizon being solved.

    The SINGLE source of truth for "could this task ever be placed" - used
    by `solve_schedule`'s own pre-solve check (so the actual solve and this
    classification can never disagree) and by `app.core.baseline`'s
    reporting (so the Comparison view's denominators match what the solver
    itself decided, not a second, potentially-drifting computation).
    """
    if not candidates:
        return StructuralCategory.IMPOSSIBLE
    longest = max(window.duration_minutes for window in candidates)
    if task.duration_minutes <= longest:
        return StructuralCategory.CONTESTABLE
    if task.is_splittable:
        total_capacity = sum(window.duration_minutes for window in candidates)
        if total_capacity >= task.duration_minutes:
            return StructuralCategory.SPLIT_ONLY
    return StructuralCategory.IMPOSSIBLE


# --------------------------------------------------------------------------- #
# Solve                                                                        #
# --------------------------------------------------------------------------- #

def solve_schedule(
    tasks: list[MaintenanceTask],
    corridors: dict[str, CorridorAvailability],
    *,
    horizon_start: date,
    horizon_days: int = 7,
    weights: ObjectiveWeights = DEFAULT_WEIGHTS,
    max_seconds: float = 10.0,
    num_workers: int = 1,
    random_seed: int = 20260822,
    #: T20 - force one or more tasks' placement or exclusion. Everything else
    #: in the model is unchanged, so this is a real answer, not an
    #: approximation. A single `Pin` remains accepted for T20's callers;
    #: `pins` (T27) is how more than one task is forced in the same solve -
    #: e.g. holding an entire existing plan fixed except for the one corridor
    #: an emergency re-optimization is allowed to touch.
    pin: Pin | None = None,
    pins: list[Pin] | None = None,
    #: T27 - window keys (`WindowInstance.key`) no task may be assigned into,
    #: regardless of which task. Distinct from a pin: a pin forces or excludes
    #: ONE task; this removes a window from the model entirely, which is what
    #: "already-executed" means for a window nothing happened to be scheduled
    #: into - it must stay unusable, not look freshly available.
    blocked_window_keys: frozenset[str] | None = None,
) -> ScheduleResult:
    """Build and solve the CP-SAT block-allocation model.

    `num_workers=1` with a fixed seed is the default because reproducibility
    matters more here than raw speed: CP-SAT's parallel portfolio returns
    whichever optimal solution a worker finds first, so identical input can
    yield different (equally optimal) schedules run to run. A plan that changes
    when nothing changed is indefensible in a demo and impossible to test.
    See docs/DECISIONS.md D-022.
    """
    # T28, PRD Section 15's own enum (`horizon: "weekly"|"monthly"`). 28-31
    # covers every real calendar month length without hardcoding 30 - a
    # monthly plan is still the SAME exact-slot CP-SAT solve as a weekly one,
    # just over a longer horizon (see docs/DECISIONS.md D-070); nothing else
    # about the model changes because of this label.
    if horizon_days == 7:
        horizon = "weekly"
    elif 28 <= horizon_days <= 31:
        horizon = "monthly"
    else:
        horizon = f"{horizon_days}-day"
    windows = expand_windows(corridors, horizon_start, horizon_days)
    windows_by_corridor: dict[str, list[WindowInstance]] = {}
    for window in windows:
        windows_by_corridor.setdefault(window.corridor_id, []).append(window)

    # --- structural feasibility, decided before the solver sees anything ----
    # Separating "impossible" from "did not fit" is what makes a deferral
    # reason actionable rather than a shrug (FR3.3).
    schedulable: list[MaintenanceTask] = []
    deferred: list[DeferredTask] = []

    for task in sorted(tasks, key=lambda t: t.task_id):
        candidates = windows_by_corridor.get(task.corridor_id, [])
        if not candidates:
            deferred.append(
                DeferredTask(
                    task.task_id,
                    DeferralReason.NO_WINDOW_ON_CORRIDOR,
                    f"corridor {task.corridor_id} has no free block window in the "
                    f"{horizon} horizon",
                )
            )
            continue

        # D-084: the single shared classification also `app.core.baseline`
        # reports from, so this decision and the Comparison view's
        # denominators can never drift apart.
        category = classify_structural_feasibility(task, candidates)
        if category in (StructuralCategory.CONTESTABLE, StructuralCategory.SPLIT_ONLY):
            schedulable.append(task)
            continue

        longest = max(window.duration_minutes for window in candidates)

        if task.is_splittable:
            # T29 Phase 1: this defect type may be covered by 2+ non-contiguous
            # segments, each >= MIN_SPLIT_SEGMENT_MINUTES, summing to the full
            # duration - but `category` above is IMPOSSIBLE, so even that did
            # not reach the required total. Structural impossibility here means
            # the same thing D-024 means for a non-split task: even the best
            # possible packing cannot reach the required total - checked before
            # the solver runs so this stays separated from losing a real
            # capacity contest. Every window T3 emits already clears
            # MIN_SPLIT_SEGMENT_MINUTES (D-010's own 30-minute floor), so
            # summing full window capacity is the right upper bound to compare
            # against.
            total_capacity = sum(window.duration_minutes for window in candidates)
            deferred.append(
                DeferredTask(
                    task.task_id,
                    DeferralReason.EXCEEDS_TOTAL_CAPACITY_EVEN_SPLIT,
                    f"needs {task.duration_minutes} min total and defect type "
                    f"'{task.defect_type}' is treated as splittable (T29 Phase 1), but "
                    f"even summing every free window on {task.corridor_id} across the "
                    f"{horizon} horizon gives only {total_capacity} min across "
                    f"{len(candidates)} window(s) - no combination of segments (each "
                    f">= {MIN_SPLIT_SEGMENT_MINUTES} min) can cover it",
                )
            )
            continue

        # T22 Phase A: the deferral message has always said this needs a
        # traffic block. Now it says what that block would COST, so the
        # sentence stops being an explanation and becomes a decision a
        # Controller can actually take. Reached only for a non-splittable
        # task (T29 Phase 1 handled splittable ones above).
        corridor = corridors[task.corridor_id]
        option = cheapest_displacement(
            task.corridor_id,
            [
                {"startMin": w.start_minute, "endMin": w.end_minute}
                for w in corridor.daily_windows
            ],
            [
                {"startMin": w.start_minute, "endMin": w.end_minute}
                for w in corridor.occupied_windows
            ],
            corridor.train_class_mix,
            task.duration_minutes,
        )
        # "0 trains" and "we were not given the occupancy data" are very
        # different statements, and the first one would be a false claim
        # dressed as a reassuring one. Only assert a cost when the corridor
        # actually carried occupancy data.
        impact = option.impact
        if not corridor.occupied_windows:
            cost = (
                " The cost of that block is not computed here: no train-occupancy "
                "data was supplied for this corridor."
            )
        elif impact is not None:
            cost = (
                f" A traffic block would displace {impact.trains_affected} train(s) "
                f"for {impact.displaced_minutes} min."
            )
        else:
            cost = f" No traffic block is possible: {option.reason}."
        deferred.append(
            DeferredTask(
                task.task_id,
                DeferralReason.EXCEEDS_LONGEST_WINDOW,
                f"needs {task.duration_minutes} min but the longest free window on "
                f"{task.corridor_id} is {longest} min - this corridor's traffic leaves "
                f"no gap long enough, so the work requires a traffic block that displaces "
                f"trains (train-impact-aware planning, T22)." + cost,
                displacement=(
                    option.as_dict() if corridor.occupied_windows else None
                ),
            )
        )

    # --- T24: prerequisite chains, walked to a fixed point ------------------
    # A task whose prerequisite already failed the physical-fit check above
    # (EXCEEDS_LONGEST_WINDOW / NO_WINDOW_ON_CORRIDOR) can never satisfy PRD
    # 9.7's ordering rule either, no matter how the solver arranges everything
    # else - so it is removed here, structurally, exactly like D-024 removes a
    # task that cannot fit any window on its own. Looping to a fixed point
    # (rather than one pass) is what makes a 3-stage chain work: if stage 1 is
    # structural, stage 2 is deferred on this pass, and stage 3 - whose
    # prerequisite is stage 2 - is deferred on the next.
    deferred_by_id = {item.task_id: item for item in deferred}
    changed = True
    while changed:
        changed = False
        still_schedulable: list[MaintenanceTask] = []
        for task in schedulable:
            prereq_id = task.depends_on_task_id
            prereq_deferral = deferred_by_id.get(prereq_id) if prereq_id else None
            if prereq_deferral is not None:
                item = DeferredTask(
                    task.task_id,
                    DeferralReason.PREREQUISITE_UNSCHEDULABLE,
                    f"depends on {prereq_id}, which cannot be scheduled in this {horizon} "
                    f"horizon ({prereq_deferral.reason}: {prereq_deferral.detail}) - PRD 9.7 "
                    f"requires the prerequisite to complete first, so this task cannot be "
                    f"scheduled either",
                )
                deferred.append(item)
                deferred_by_id[task.task_id] = item
                changed = True
            else:
                still_schedulable.append(task)
        schedulable = still_schedulable

    model = cp_model.CpModel()

    # --- decision variables: assign[i][j] (PRD Section 13), plus T29 Phase 1's
    # per-window segment minutes and per-task coverage flag -------------------
    # `assign[(task_id, window_key)]` keeps its original meaning throughout the
    # rest of this function: "task i has SOME presence in window j" - true for
    # a non-split task's one placement, and equally true for one of a split
    # task's several segments. Every constraint below that only needs to know
    # "is this task here" (dependency precedence, resource no-overlap,
    # batching, pins) is therefore untouched by splitting. What changes is how
    # much of the task's DURATION that presence represents -
    # `segment_minutes[(task_id, window_key)]`, 0 for an unused pair - and
    # whether the task is scheduled at all, in full - `covered[task_id]` -
    # which replaces the old blanket "at most one window" for a splittable
    # task while keeping it, unchanged, for every other one.
    assign: dict[tuple[str, str], cp_model.IntVar] = {}
    # A real IntVar for a splittable task's segment; a plain linear expression
    # (`duration * assign`) for a non-split one - see the creation loop below
    # for why. `solver.value()` reads either one the same way.
    segment_minutes: dict[tuple[str, str], object] = {}
    covered: dict[str, cp_model.IntVar] = {}
    candidates_for_task: dict[str, list[WindowInstance]] = {}

    # A blocked window is unusable for a NEW placement - but a pin naming that
    # exact window is reconstructing something that already happened, not
    # creating a new use of it, so it stays exempt. Computed here, ahead of
    # `candidates_for_task`, because the exemption has to exist before the
    # variable it would otherwise be filtered out of.
    all_pins = list(pins or [])
    if pin is not None:
        all_pins.append(pin)
    pinned_window_keys = {p.window_key for p in all_pins if p.window_key is not None} | {
        key for p in all_pins if p.window_keys is not None for key in p.window_keys
    }
    blocked = (blocked_window_keys or frozenset()) - pinned_window_keys

    for task in schedulable:
        corridor_windows = windows_by_corridor[task.corridor_id]
        longest_on_corridor = max(w.duration_minutes for w in corridor_windows)
        # A splittable task that already fits in ONE window needs no widening
        # at all - nothing in the objective rewards gratuitous splitting
        # (coverage/SLA are per-TASK now, and fragmentation actively penalises
        # opening extra windows), so giving it every window on the corridor as
        # a candidate would only add combinatorial size with zero possible
        # benefit. Measured on the real corpus: widening indiscriminately
        # (every splittable task, not just the ones that need it) pushed the
        # solve from OPTIMAL in under a second to not proving optimal within
        # 90s and losing run-to-run determinism (D-022's guarantee) - this
        # check is what keeps splitting's cost proportional to how many tasks
        # actually need it (32 of 89 on this corpus), not to how many are
        # merely eligible (50 of 89).
        needs_split = task.is_splittable and task.duration_minutes > longest_on_corridor
        if needs_split:
            # Every window T3 emits already clears MIN_SPLIT_SEGMENT_MINUTES
            # (D-010's 30-minute floor), so nothing needs filtering out here on
            # segment-size grounds - the floor is enforced per-segment below.
            # Not filtered by "duration <= window duration" either: a segment
            # may be shorter than the task's full duration.
            fitting = [window for window in corridor_windows if window.key not in blocked]
        else:
            fitting = [
                window
                for window in windows_by_corridor[task.corridor_id]
                if task.duration_minutes <= window.duration_minutes
                and window.key not in blocked
            ]
        candidates_for_task[task.task_id] = fitting
        covered[task.task_id] = model.new_bool_var(f"covered[{task.task_id}]")

        for window in fitting:
            key = (task.task_id, window.key)
            assign[key] = model.new_bool_var(f"assign[{task.task_id}][{window.key}]")

        if needs_split:
            # A real IntVar only for a splittable task - non-split tasks are
            # the majority even on this corpus, and giving every one of them
            # a needless extra integer variable plus a linking equality
            # measurably slowed the solve for no informational gain (an
            # equality-defined variable IS the expression it's tied to).
            for window in fitting:
                key = (task.task_id, window.key)
                cap = min(task.duration_minutes, window.duration_minutes)
                segment_minutes[key] = model.new_int_var(
                    0, cap, f"segmin[{task.task_id}][{window.key}]"
                )
                model.add(segment_minutes[key] <= cap * assign[key])
                model.add(segment_minutes[key] >= MIN_SPLIT_SEGMENT_MINUTES * assign[key])
            # Sum of segments == the full duration when covered, 0 when not -
            # never a partial task (FR3.3 stays scheduled/deferred, never
            # "half done"). Each USED segment is floored at
            # MIN_SPLIT_SEGMENT_MINUTES; the number of segments self-limits
            # from that floor, so no separate cap on segment count is needed.
            model.add(
                sum(segment_minutes[(task.task_id, w.key)] for w in fitting)
                == task.duration_minutes * covered[task.task_id]
            )
        else:
            # Unchanged from before splitting existed: exactly one window (or
            # none), and that one window carries the whole duration. No new
            # variable needed - `duration * assign` already IS the segment
            # size, definitionally, so it is stored as that expression
            # directly rather than a variable CP-SAT would have to solve for.
            for window in fitting:
                key = (task.task_id, window.key)
                segment_minutes[key] = task.duration_minutes * assign[key]
            model.add_at_most_one(assign[(task.task_id, w.key)] for w in fitting)
            model.add(
                covered[task.task_id] == sum(assign[(task.task_id, w.key)] for w in fitting)
            )

    # --- constraint: dependency precedence (T24, PRD 9.7) -------------------
    # "A task cannot be scheduled before its prerequisite completes" - the
    # exact PRD 9.7 wording, and the exact ordering `detect_known_gaps`'s
    # violation check already used for reporting, so the hard constraint and
    # the post-solve check can never disagree about what counts as a
    # violation. Two constraints per dependent task with a schedulable
    # prerequisite:
    #   1. scheduled at all implies the prerequisite is scheduled at all;
    #   2. every (dependent window, prerequisite window) pair that would have
    #      the prerequisite still running (or not yet started) when the
    #      dependent begins is forbidden outright.
    # A dangling or already-excluded prerequisite is skipped here - the
    # pre-solve fixed-point pass above already removed every task whose
    # prerequisite is structurally deferred, so reaching this loop with an
    # unresolvable prerequisite only happens for a dangling reference, which
    # the post-solve check reports as "prerequisite not scheduled".
    for task in schedulable:
        prereq_id = task.depends_on_task_id
        if prereq_id is None or prereq_id not in candidates_for_task:
            continue
        dep_windows = candidates_for_task[task.task_id]
        pre_windows = candidates_for_task[prereq_id]
        # T29 Phase 1: `covered` replaces the old `sum(assign dep) <=
        # sum(assign prereq)` - both express "scheduled at all implies the
        # prerequisite is too", but only `covered` stays correct once a task
        # may have more than one `assign` var set to 1.
        model.add(covered[task.task_id] <= covered[prereq_id])
        for w_dep in dep_windows:
            for w_pre in pre_windows:
                if (w_pre.day, w_pre.end_minute) > (w_dep.day, w_dep.start_minute):
                    model.add(
                        assign[(task.task_id, w_dep.key)] + assign[(prereq_id, w_pre.key)] <= 1
                    )

    # --- constraint: resource no-overlap (T25, PRD 9.8) ---------------------
    # "No overlap on the same required resource across concurrent tasks" (PRD
    # line 437) - exactly the same-day-and-overlapping test
    # `detect_known_gaps`'s resource-conflict check already used for
    # reporting since T21, so the two can never disagree. Unlike dependency,
    # this is symmetric (no ordering, no "prerequisite") - two tasks sharing
    # ANY resource id simply cannot occupy overlapping windows, on any
    # corridor, since resources are depot-scoped rather than corridor-scoped.
    resource_pairs: set[tuple[str, str]] = set()
    tasks_by_resource: dict[str, list[MaintenanceTask]] = {}
    for task in schedulable:
        for resource_id in task.required_resource_ids:
            tasks_by_resource.setdefault(resource_id, []).append(task)
    for group in tasks_by_resource.values():
        for i, first in enumerate(group):
            for second in group[i + 1 :]:
                resource_pairs.add(tuple(sorted((first.task_id, second.task_id))))

    # T29 Phase 1 widened some tasks' candidate sets from "the few windows
    # long enough" to "every window on the corridor" (see the variable-
    # creation loop above), which made the naive cross product here measurably
    # expensive on the real corpus - two windows on different days can never
    # overlap, so grouping each side by day first and only cross-producting
    # WITHIN a day (rather than filtering after the fact) skips that dead
    # weight up front instead of paying for it and discarding it.
    def _by_day(instances: list[WindowInstance]) -> dict[date, list[WindowInstance]]:
        grouped: dict[date, list[WindowInstance]] = {}
        for instance in instances:
            grouped.setdefault(instance.day, []).append(instance)
        return grouped

    for task_a_id, task_b_id in sorted(resource_pairs):
        windows_a_by_day = _by_day(candidates_for_task[task_a_id])
        windows_b_by_day = _by_day(candidates_for_task[task_b_id])
        for day, windows_a in windows_a_by_day.items():
            for w_a in windows_a:
                for w_b in windows_b_by_day.get(day, ()):
                    if _overlaps(w_a, w_b):
                        model.add(
                            assign[(task_a_id, w_a.key)] + assign[(task_b_id, w_b.key)] <= 1
                        )

    # --- T20/T27: pins, if any were given -------------------------------------
    #
    # Validated here rather than trusted, because a pin naming a window that
    # does not exist or does not fit would otherwise build a model that is
    # silently infeasible for a reason nobody can see - the CP-SAT equivalent
    # of D-025's "a rewarded indicator must be free to be zero". `all_pins`
    # (merging `pin` and `pins`) was already computed above, ahead of
    # `candidates_for_task`, so a pin naming a blocked window could stay exempt.
    splittable_schedulable_ids = {task.task_id for task in schedulable if task.is_splittable}
    seen_pin_tasks: set[str] = set()
    for one_pin in all_pins:
        if one_pin.task_id in seen_pin_tasks:
            raise ValueError(f"task {one_pin.task_id} is pinned more than once")
        seen_pin_tasks.add(one_pin.task_id)

        if one_pin.window_key is not None and one_pin.window_keys is not None:
            raise ValueError(
                f"pin for {one_pin.task_id} sets both window_key and window_keys - set exactly one"
            )

        # T29 Phase 1: a split task's real placement is 2+ windows, so
        # holding it fixed means holding ALL of them, not just one - see
        # the `Pin` docstring for the real bug this closes.
        keys: tuple[str, ...] = (
            one_pin.window_keys
            if one_pin.window_keys is not None
            else ((one_pin.window_key,) if one_pin.window_key is not None else ())
        )

        if not keys:
            if one_pin.task_id in candidates_for_task:
                model.add(
                    sum(
                        assign[(one_pin.task_id, window.key)]
                        for window in candidates_for_task[one_pin.task_id]
                    )
                    == 0
                )
            # A task already outside `schedulable` (structurally deferred) is
            # already excluded - pinning it out again is a no-op, not an error.
            continue

        if one_pin.task_id not in candidates_for_task:
            raise ValueError(
                f"cannot pin {one_pin.task_id} to {keys}: this task fits "
                f"no window in the {horizon} horizon at all (structurally deferred), so "
                f"there is no placement to force it into"
            )
        if len(keys) > 1 and one_pin.task_id not in splittable_schedulable_ids:
            raise ValueError(
                f"cannot pin {one_pin.task_id} to {len(keys)} windows: this task's defect "
                f"type is not splittable, so it can never legitimately occupy more than one"
            )
        for window_key in keys:
            if (one_pin.task_id, window_key) not in assign:
                raise ValueError(
                    f"cannot pin {one_pin.task_id} to {window_key}: that window is "
                    f"not a real, fitting, same-corridor candidate for this task"
                )
            model.add(assign[(one_pin.task_id, window_key)] == 1)
        if len(keys) > 1:
            # Multiple windows forced assigned is only a genuine "this task's
            # full placement is held" when the task is actually covered -
            # otherwise a contradiction elsewhere could let the solver try to
            # satisfy `== 1` on some windows while `covered` stays free. Since
            # each `assign[key] == 1` already forces `covered == 1` through
            # the splittable-task linking constraint, this is redundant but
            # documents the intent explicitly rather than relying on a reader
            # tracing it back through an unrelated section of the model.
            model.add(covered[one_pin.task_id] == 1)

    # "Each task in at most one window" (FR3.3: zero means deferred, a
    # representable outcome, not an infeasible model) is now enforced above,
    # per task, at variable-creation time - unconditionally for a non-split
    # task, and via `covered` for a splittable one that may use several.

    # --- constraint: window capacity, and the open/used bookkeeping ---------
    window_open: dict[str, cp_model.IntVar] = {}
    used_expr: dict[str, object] = {}
    tasks_in_window: dict[str, list[MaintenanceTask]] = {}

    for window in windows:
        occupants = [
            task
            for task in schedulable
            if (task.task_id, window.key) in assign
        ]
        tasks_in_window[window.key] = occupants
        if not occupants:
            continue

        is_open = model.new_bool_var(f"open[{window.key}]")
        window_open[window.key] = is_open

        # T29 Phase 1: real occupied minutes, whether a task's presence here
        # is its whole duration (non-split) or one segment of several.
        used = sum(segment_minutes[(task.task_id, window.key)] for task in occupants)
        used_expr[window.key] = used

        # PRD Section 13: sum of assigned durations <= window length. Multiplying
        # by `is_open` also links the two: a window with work in it is open.
        model.add(used <= window.duration_minutes * is_open)
        for task in occupants:
            model.add(assign[(task.task_id, window.key)] <= is_open)

    batched = _add_batching(model, schedulable, tasks_in_window, assign, window_open)

    # --- objective: simplified PRD 13.1 -------------------------------------
    objective_terms = []

    # alpha - priority-weighted coverage. One term per TASK, not per window:
    # `covered` is exactly 0/1 for both split and non-split tasks (T29 Phase
    # 1), so this rewards a task once, in full, when scheduled - never
    # proportional to how many segments a split task happens to use. Summing
    # per-window `assign` here instead (the pre-T29 form) would over-reward a
    # split task in proportion to its segment count, which is exactly the
    # kind of reward-scale bug D-025 warns about in a new shape.
    for task in schedulable:
        objective_terms.append(weights.coverage * task.priority * covered[task.task_id])

    # epsilon - SLA compliance, as a REWARD rather than a hard deadline.
    # 17 of the 89 real tasks are already past their slaDueDate at the horizon
    # start; a hard constraint would make them permanently unschedulable, which
    # is precisely backwards - overdue maintenance is more urgent, not less.
    # PRD 13.1 lists SLA compliance as an objective term, and Section 13's
    # "where feasible" wording says the same. See docs/DECISIONS.md D-020.
    #
    # T29 Phase 1: also one term per task now, via `within_sla` - the natural
    # generalisation of "the window it landed in is on time" to "every
    # segment of the work completed on time" (a split task is not genuinely
    # SLA-compliant if its LAST segment lands after the deadline, even if its
    # first one did not). `within_sla <= covered` keeps it free to be zero for
    # an uncovered task, and unconstrained-but-rewarded otherwise - the same
    # "reward variable must be free to be zero" discipline D-025 established,
    # checked in the direction that matters here: without that link, an
    # UNCOVERED task could claim the reward for free, since nothing else
    # would stop the solver setting the flag true.
    within_sla: dict[str, cp_model.IntVar] = {}
    for task in schedulable:
        flag = model.new_bool_var(f"within_sla[{task.task_id}]")
        model.add(flag <= covered[task.task_id])
        for window in candidates_for_task[task.task_id]:
            if window.day > task.sla_due_date:
                model.add(flag + assign[(task.task_id, window.key)] <= 1)
        within_sla[task.task_id] = flag
        objective_terms.append(weights.sla_compliance * flag)

    # delta - cross-department batching, the headline capability.
    for variable in batched.values():
        objective_terms.append(weights.batching * variable)

    # mu - unused minutes inside opened windows. Penalising only OPENED windows
    # is the point: leaving a window shut costs nothing, but taking a possession
    # and not using it is real waste.
    for key, is_open in window_open.items():
        window = next(w for w in windows if w.key == key)
        objective_terms.append(-weights.unused_minute * window.duration_minutes * is_open)
        objective_terms.append(weights.unused_minute * used_expr[key])

    # nu - fragmentation: prefer fewer, fuller possessions over many thin ones.
    for is_open in window_open.values():
        objective_terms.append(-weights.fragmentation * is_open)

    model.maximize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_seconds
    solver.parameters.num_workers = num_workers
    solver.parameters.random_seed = random_seed
    status = solver.solve(model)

    return _build_result(
        status=status,
        solver=solver,
        model_tasks=schedulable,
        all_tasks=tasks,
        windows=windows,
        assign=assign,
        segment_minutes=segment_minutes,
        candidates_for_task=candidates_for_task,
        deferred=deferred,
        corridors=corridors,
        horizon=horizon,
        horizon_start=horizon_start,
        horizon_days=horizon_days,
    )


def _add_batching(
    model: cp_model.CpModel,
    tasks: list[MaintenanceTask],
    tasks_in_window: dict[str, list[MaintenanceTask]],
    assign: dict[tuple[str, str], cp_model.IntVar],
    window_open: dict[str, cp_model.IntVar],
) -> dict[str, cp_model.IntVar]:
    """Reward windows carrying more than one department (PRD 13 batching).

    The capacity constraint already *permits* sharing; without an explicit
    reward the solver is indifferent between two Engineering tasks in a window
    and one Engineering plus one S&T. Real value comes from the second case: one
    possession serves two departments, so the corridor is taken out of traffic
    once instead of twice.

    Both bounds matter. `department_used <= sum(assigns)` stops the flag being
    set for a department with no work in the window, and requiring two distinct
    departments stops `batched` being claimed for a single-department window.
    Without them the solver would happily collect the reward for nothing, since
    the objective maximises these variables.

    The two-department requirement is attached with `only_enforce_if(flag)`, and
    that detail is load-bearing. Written as an unconditional
    `flag <= sum(used_flags) - 1`, an eligible window that ends up EMPTY forces
    `flag <= -1`, which a boolean cannot satisfy - making the entire model
    infeasible. The hand-built scenarios never left a batching-eligible window
    empty, so they passed; the real corpus, where most eligible windows go
    unused, returned INFEASIBLE immediately. Implication as a rule: a reward
    variable must be free to be zero.
    """
    batched: dict[str, cp_model.IntVar] = {}

    for window_key, occupants in tasks_in_window.items():
        departments = sorted({task.department for task in occupants})
        if len(departments) < 2 or window_key not in window_open:
            continue

        used_flags = []
        for department in departments:
            members = [task for task in occupants if task.department == department]
            flag = model.new_bool_var(f"dept[{window_key}][{department}]")
            model.add(flag <= sum(assign[(task.task_id, window_key)] for task in members))
            used_flags.append(flag)

        flag = model.new_bool_var(f"batched[{window_key}]")
        model.add(sum(used_flags) >= 2).only_enforce_if(flag)
        batched[window_key] = flag

    return batched


def _build_result(
    *,
    status,
    solver,
    model_tasks,
    all_tasks,
    windows,
    assign,
    segment_minutes,
    candidates_for_task,
    deferred,
    corridors,
    horizon,
    horizon_start,
    horizon_days,
) -> ScheduleResult:
    """Read the solution back out, and account for every single task."""
    status_name = solver.status_name(status)
    result = ScheduleResult(
        horizon=horizon,
        horizon_start=horizon_start,
        horizon_days=horizon_days,
        status=status_name,
        objective_value=int(solver.objective_value) if status in (
            cp_model.OPTIMAL,
            cp_model.FEASIBLE,
        ) else 0,
        solve_seconds=solver.wall_time,
        deferred=list(deferred),
    )

    tasks_by_id = {task.task_id: task for task in all_tasks}
    # T29 Phase 1: one task may now have 2+ segments, so the per-task solution
    # is a LIST of (window, minutes) rather than a single window. Sorted
    # chronologically so "segment 1" always means "the earliest one" for
    # every consumer below.
    task_segments: dict[str, list[tuple[WindowInstance, int]]] = {}

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        windows_by_key = {window.key: window for window in windows}
        grouped: dict[str, list[tuple[MaintenanceTask, int]]] = {}

        for (task_id, window_key), variable in assign.items():
            if solver.value(variable):
                window = windows_by_key[window_key]
                minutes = solver.value(segment_minutes[(task_id, window_key)])
                grouped.setdefault(window_key, []).append((tasks_by_id[task_id], minutes))
                task_segments.setdefault(task_id, []).append((window, minutes))

        for segments in task_segments.values():
            segments.sort(key=lambda pair: (pair[0].day, pair[0].start_minute))

        for window_key in sorted(grouped):
            window = windows_by_key[window_key]
            occupants = sorted(grouped[window_key], key=lambda pair: pair[0].task_id)
            result.blocks.append(
                ScheduledBlock(
                    corridor_id=window.corridor_id,
                    day=window.day,
                    window_index=window.window_index,
                    start_minute=window.start_minute,
                    end_minute=window.end_minute,
                    capacity_minutes=window.duration_minutes,
                    used_minutes=sum(minutes for _task, minutes in occupants),
                    task_ids=[task.task_id for task, _minutes in occupants],
                    departments=[task.department for task, _minutes in occupants],
                    segment_minutes={task.task_id: minutes for task, minutes in occupants},
                )
            )

    result.blocks.sort(key=lambda b: (b.day, b.corridor_id, b.start_minute))

    # T29 Phase 1: a task with more than one segment is genuinely split -
    # recorded once here, from the same `task_segments` the decision log
    # reads, so the two can never disagree about which tasks are split.
    for task_id, segments in task_segments.items():
        if len(segments) <= 1:
            continue
        task = tasks_by_id[task_id]
        result.split_tasks[task_id] = {
            "taskId": task_id,
            "corridorId": task.corridor_id,
            "defectType": task.defect_type,
            "totalDurationMinutes": task.duration_minutes,
            "segmentCount": len(segments),
            "segments": [
                {
                    "date": window.day.isoformat(),
                    "windowIndex": window.window_index,
                    "window": f"{_clock(window.start_minute)}-{_clock(window.end_minute)}",
                    "minutes": minutes,
                }
                for window, minutes in segments
            ],
        }

    # Anything the solver considered but did not place is deferred for capacity
    # reasons - stated separately from structural impossibility.
    scheduled = set(task_segments)
    for task in model_tasks:
        if task.task_id not in scheduled:
            candidate_count = len(candidates_for_task[task.task_id])
            if candidate_count == 0:
                # T27: every physically-fitting window was removed by
                # `blocked_window_keys` before any contest could happen - the
                # NO_CAPACITY wording below would otherwise claim a contest
                # this task never got to enter.
                result.deferred.append(
                    DeferredTask(
                        task.task_id,
                        DeferralReason.WINDOW_UNAVAILABLE,
                        f"every window on {task.corridor_id} this task could physically fit "
                        f"was already executed or consumed by the disruption itself - not lost "
                        f"to another task's priority, because there was nothing left to contest",
                    )
                )
            else:
                result.deferred.append(
                    DeferredTask(
                        task.task_id,
                        DeferralReason.NO_CAPACITY,
                        f"{candidate_count} window(s) on {task.corridor_id} could physically hold "
                        f"this task, but every one was better used by higher-priority work",
                    )
                )

    result.deferred.sort(key=lambda d: d.task_id)
    result.decision_log = _build_decision_log(
        all_tasks, task_segments, result.deferred, candidates_for_task
    )
    result.known_gaps = detect_known_gaps(all_tasks, task_segments)
    # T22: checked, not assumed. Lands in knownGaps so it travels the same route
    # to the UI as every other honesty field.
    train_impacts = detect_train_impact(result.blocks, corridors)
    result.known_gaps["trainImpactConflicts"] = {
        "count": len(train_impacts),
        "note": (
            "Scheduled blocks overlapping observed train movements (PRD 9.5/9.6). The model "
            "only assigns into free windows, so a non-zero count means the free-window data "
            "and the occupancy data disagree."
        ),
        "conflicts": train_impacts[:20],
    }
    # T26, PRD 9.9: real, not a live constraint. Advisory only - see
    # app.core.weather's module docstring and D-068 for why this stops at
    # reporting rather than an objective term, the same call T22 made for
    # train-delay impact.
    weather_risk = detect_weather_risk(result.blocks, corridors)
    result.known_gaps["weatherRisk"] = {
        "count": len(weather_risk),
        "note": (
            "Scheduled blocks on a corridor real Ministry of Jal Shakti flood-risk data "
            "flags as monsoon-risk (T26), falling inside India's real IMD monsoon window "
            "(~June 1 - ~October 15). Advisory only - the solver does not avoid or move "
            "these blocks; a Controller decides whether to act on the flag."
        ),
        "blocks": weather_risk[:20],
    }
    annotate_conflicts(result.decision_log, result.known_gaps)
    annotate_weather_risk(result.decision_log, weather_risk)

    # FR3.3 as an invariant, not an aspiration: no task may vanish.
    accounted = result.scheduled_task_ids | {d.task_id for d in result.deferred}
    missing = {task.task_id for task in all_tasks} - accounted
    if missing:
        raise AssertionError(f"tasks missing from the result: {sorted(missing)}")

    # T24 as an invariant too: the CP-SAT constraints above make a dependency
    # violation structurally impossible in an OPTIMAL/FEASIBLE solve, so this
    # is checked rather than trusted - the same discipline as the FR3.3 check
    # just above. A non-empty result here means the constraint itself has a
    # bug, not that a real conflict was found.
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        violations = result.known_gaps["dependencyViolations"]["violations"]
        if violations:
            raise AssertionError(
                f"dependency precedence constraint failed to prevent violation(s): {violations}"
            )
        # T25, same pattern: resource no-overlap is a hard constraint now, so
        # a survivor here means the constraint has a bug.
        resource_conflicts = result.known_gaps["resourceConflicts"]["conflicts"]
        if resource_conflicts:
            raise AssertionError(
                f"resource no-overlap constraint failed to prevent conflict(s): {resource_conflicts}"
            )

    return result


def _priority_factors(task: MaintenanceTask) -> dict:
    """The FR2.3 score and the FR2.4 reasoning behind it, when T7 supplied one.

    `priority` is the integer the CP-SAT objective uses - `round(score)`. The
    unrounded score and its four contributions are what a Controller actually
    asks about ("why is this one ahead of that one?"), and answering from the
    rounded integer alone would give a number that does not match the priority
    queue on screen. Both are reported, labelled, so neither has to be inferred.
    """
    factors = {
        "priority": task.priority,
        "priorityIsPlaceholder": task.priority_is_placeholder,
        "durationMinutes": task.duration_minutes,
        "slaDueDate": task.sla_due_date.isoformat(),
    }

    breakdown = task.priority_breakdown
    if breakdown is None:
        # No T7 score was supplied. Say so rather than omitting the key, so a
        # consumer can tell "not computed" from "computed and unremarkable".
        factors["priorityBreakdown"] = None
        return factors

    factors["priorityScore"] = breakdown.get("priorityScore")
    factors["dominantPriorityFactor"] = breakdown.get("dominantFactor")
    factors["priorityBreakdown"] = {
        "contributions": breakdown.get("contributions"),
        "components": breakdown.get("components"),
        "daysToDue": breakdown.get("daysToDue"),
        "isOverdue": breakdown.get("isOverdue"),
        "usesFailureRisk": breakdown.get("usesFailureRisk"),
    }
    return factors


def _build_decision_log(all_tasks, task_segments, deferred, candidates=None) -> list[dict]:
    """Per-task record of what happened and the factors behind it.

    Deliberately structured rather than prose: T18 turns these factors into
    plain English grounded in the solver's own decisions, and PRD 18 is explicit
    that the explanation layer must never invent numbers. Everything here is
    therefore a figure the solver actually used, never a derived narrative.

    `candidates` maps task id -> the eligible window keys the model considered.
    It answers "why this window and not another one" with a count rather than a
    claim, which is the honest version: the model's choice among N eligible
    windows is an objective outcome, not a rule that can be quoted.

    T29 PHASE 1 - SPLIT TASKS MARKED EXPLICITLY, NEVER IMPLIED
    ------------------------------------------------------------
    `task_segments` maps task id -> a chronological list of (window, minutes)
    pairs - one entry for a normal placement, 2+ for a split one. A scheduled
    entry ALWAYS keeps the legacy singular `date`/`window`/`windowIndex` keys
    (the EARLIEST segment, so every pre-T29 reader - the frontend, /explain's
    grounding - keeps working unchanged) and ALWAYS adds `isSplit` plus the
    full `segments` list, so a split placement can never be mistaken for or
    silently collapsed into a normal one by a reader that only checks the
    legacy fields.

    WHAT THIS LOG IS NOT
    --------------------
    It records what the **solver** decided. It does not reflect manual overrides
    (T15), which are a separate append-only log by D-043 precisely so that "what
    the AI decided" and "what the plan is now" stay independently answerable. A
    consumer explaining the *current* plan must join both - see the grounding
    contract in `app/core/grounding.py`.
    """
    reasons = {item.task_id: item for item in deferred}
    candidates = candidates or {}
    tasks_by_id = {task.task_id: task for task in all_tasks}
    log = []

    # Who else landed in ANY of this task's window instances - the basis of
    # the batching claim, computed from `task_segments` rather than asserted.
    # A split task can batch independently in each of its segments, so this
    # naturally covers all of them, not just the first.
    occupants: dict[object, list[MaintenanceTask]] = {}
    for task_id, segments in task_segments.items():
        task = tasks_by_id[task_id]
        for window, _minutes in segments:
            occupants.setdefault(window.key, []).append(task)

    # Real minutes used in each window, across every task present (whether a
    # normal placement or one segment of a split task) - what
    # `windowUsedMinutes` below reports the fullness of.
    window_used_minutes: dict[object, int] = {}
    for segments in task_segments.values():
        for window, minutes in segments:
            window_used_minutes[window.key] = window_used_minutes.get(window.key, 0) + minutes

    for task in sorted(all_tasks, key=lambda t: t.task_id):
        segments = task_segments.get(task.task_id)
        eligible = len(candidates.get(task.task_id, ()))

        if segments is not None:
            is_split = len(segments) > 1
            primary_window, _primary_minutes = segments[0]
            last_window, _last_minutes = segments[-1]

            share_ids: set[str] = set()
            share_departments: set[str] = set()
            for window, _minutes in segments:
                for other in occupants[window.key]:
                    if other.task_id != task.task_id:
                        share_ids.add(other.task_id)
                        share_departments.add(other.department)
            share = sorted(share_ids)

            factors = _priority_factors(task)
            factors.update(
                {
                    # T29 Phase 1: for a split task these describe only the
                    # EARLIEST segment's window - a documented simplification
                    # (the full per-segment detail is in `segments` below),
                    # kept rather than dropped so the existing
                    # windowUsedMinutes/windowCapacityMinutes-driven "how full
                    # is this possession" reading (BlockDetailPanel) keeps
                    # working unchanged for every non-split task.
                    "windowCapacityMinutes": primary_window.duration_minutes,
                    "windowUsedMinutes": window_used_minutes[primary_window.key],
                    # "On time" now means the task's LAST segment - the whole
                    # job, not just its first session - lands on or before
                    # the deadline. Matches the `within_sla` CP-SAT variable
                    # exactly, so this can never disagree with what the
                    # objective actually rewarded.
                    "withinSla": last_window.day <= task.sla_due_date,
                    "eligibleWindowsConsidered": eligible,
                    "sharedWith": share,
                    "sharedWithDepartments": sorted(share_departments),
                    "isCrossDepartmentBatch": any(
                        tasks_by_id[t].department != task.department for t in share
                    ),
                }
            )
            log.append(
                {
                    "taskId": task.task_id,
                    "decision": "scheduled",
                    "department": task.department,
                    "corridorId": task.corridor_id,
                    "date": primary_window.day.isoformat(),
                    "window": (
                        f"{_clock(primary_window.start_minute)}-{_clock(primary_window.end_minute)}"
                    ),
                    "windowIndex": primary_window.window_index,
                    "isSplit": is_split,
                    "segments": [
                        {
                            "date": window.day.isoformat(),
                            "windowIndex": window.window_index,
                            "window": f"{_clock(window.start_minute)}-{_clock(window.end_minute)}",
                            "minutes": minutes,
                        }
                        for window, minutes in segments
                    ],
                    "contributingFactors": factors,
                }
            )
        else:
            item = reasons[task.task_id]
            factors = _priority_factors(task)
            factors["eligibleWindowsConsidered"] = eligible
            log.append(
                {
                    "taskId": task.task_id,
                    "decision": "deferred",
                    "department": task.department,
                    "corridorId": task.corridor_id,
                    "reason": item.reason,
                    "detail": item.detail,
                    "contributingFactors": factors,
                }
            )

    return log


def detect_train_impact(blocks, corridors) -> list[dict]:
    """Blocks overlapping observed train occupancy (PRD 9.5/9.6, T22).

    Expected to be empty: the model only ever assigns into T3's free windows, so
    an overlap would mean the window data and the occupancy data disagree. That
    is exactly why it is CHECKED rather than assumed - a silent inconsistency
    between the two would put maintenance on top of a running train, on paper.
    """
    found: list[dict] = []
    for block in blocks:
        corridor = corridors.get(block.corridor_id)
        if corridor is None or not corridor.occupied_windows:
            continue
        affected = 0
        displaced = 0
        for window in corridor.occupied_windows:
            overlap = min(block.end_minute, window.end_minute) - max(
                block.start_minute, window.start_minute
            )
            if overlap > 0:
                affected += 1
                displaced += overlap
        if affected:
            found.append(
                {
                    "corridorId": block.corridor_id,
                    "date": block.day.isoformat(),
                    "taskIds": list(block.task_ids),
                    "departments": sorted(set(block.departments)),
                    "trainsAffected": affected,
                    "displacedMinutes": displaced,
                }
            )
    return found


def annotate_conflicts(decision_log: list[dict], known_gaps: dict) -> None:
    """Cross-reference each task to the typed conflicts it takes part in (T21).

    Only the type names go on the log entry; the full records stay in
    `conflictReport`, which owns them (D-046). Both are derived from the same
    `known_gaps` in the same call, so they cannot drift apart within a schedule.
    """
    from app.core.conflicts import from_known_gaps

    by_task: dict[str, set[str]] = {}
    for conflict in from_known_gaps(known_gaps):
        for task_id in conflict.task_ids:
            if task_id:
                by_task.setdefault(task_id, set()).add(conflict.type)

    for entry in decision_log:
        entry["conflictTypes"] = sorted(by_task.get(entry["taskId"], ()))


def annotate_weather_risk(decision_log: list[dict], weather_risk: list[dict]) -> None:
    """Cross-reference each task to whether it sits in a real weather-risk
    block (T26). Same pattern as `annotate_conflicts`, and for the same
    reason: computed once here so the decision log and the report can never
    drift apart. `None` (not a missing key) for a task with nothing to
    report, matching T16's "no data" convention.
    """
    by_task: dict[str, dict] = {}
    for record in weather_risk:
        for task_id in record["taskIds"]:
            by_task[task_id] = record

    for entry in decision_log:
        record = by_task.get(entry["taskId"])
        entry["weatherRisk"] = (
            {"seasonalRiskFlag": record["seasonalRiskFlag"], "inMonsoonWindow": True}
            if record
            else None
        )


def detect_known_gaps(
    all_tasks, task_segments: dict[str, list[tuple[WindowInstance, int]]]
) -> dict:
    """Check the two PRD Section 13 constraints (9.7, 9.8) this module also
    enforces as hard CP-SAT constraints (T24, T25).

    Originally written when both were unmodelled, to report a gap rather than
    ship a scheduler that quietly violated them. Now that both are hard
    constraints, this doubles as the invariant `_build_result` asserts on
    every OPTIMAL/FEASIBLE solve - a non-empty result here on a real solve
    means one of those constraints has a bug, not that a real gap exists.

    T29 Phase 1: `task_segments` may carry 2+ windows per task now, so both
    checks below are generalised to compare every relevant SEGMENT pair
    rather than a single placement each - matching exactly what the
    corresponding hard constraint in `solve_schedule` actually enforces (see
    its own comments), so the two can never disagree about what counts as a
    violation. For a non-split task (the overwhelming majority) this
    collapses back to exactly the original single-window comparison.
    """
    tasks_by_id = {task.task_id: task for task in all_tasks}

    # --- resource conflicts (T25, PRD 9.8) ---------------------------------
    # Two tasks sharing a resource are in conflict when ANY of their segments
    # overlap in real time. Same window is the obvious case; different
    # corridors' windows can also overlap, because resources are
    # depot-scoped across corridors.
    resource_conflicts = []
    scheduled = sorted(task_segments)
    for index, first_id in enumerate(scheduled):
        first_task = tasks_by_id[first_id]
        for second_id in scheduled[index + 1 :]:
            second_task = tasks_by_id[second_id]
            shared = set(first_task.required_resource_ids) & set(
                second_task.required_resource_ids
            )
            if not shared:
                continue
            for first_window, _fm in task_segments[first_id]:
                for second_window, _sm in task_segments[second_id]:
                    if first_window.day != second_window.day:
                        continue
                    if not _overlaps(first_window, second_window):
                        continue
                    # Every field below was already in scope; only the count and
                    # a three-field stub used to be returned, which was too thin
                    # to build a conflict view from at parity with the
                    # baseline's report (T21). This is additive.
                    overlap_start = max(first_window.start_minute, second_window.start_minute)
                    overlap_end = min(first_window.end_minute, second_window.end_minute)
                    corridors = [first_window.corridor_id, second_window.corridor_id]
                    resource_conflicts.append(
                        {
                            "taskIds": [first_id, second_id],
                            "sharedResourceIds": sorted(shared),
                            "date": first_window.day.isoformat(),
                            # Resources are depot-scoped, so the two tasks may sit
                            # on different corridors. `corridorId` is only set when
                            # they agree; `corridorIds` always carries both.
                            "corridorIds": corridors,
                            "corridorId": corridors[0] if corridors[0] == corridors[1] else None,
                            "departments": [first_task.department, second_task.department],
                            "overlapStart": _clock(overlap_start),
                            "overlapEnd": _clock(overlap_end),
                            "overlapMinutes": overlap_end - overlap_start,
                        }
                    )

    # --- dependency ordering (T24, PRD 9.7) --------------------------------
    # "Before its prerequisite completes" now means before EVERY segment of
    # the prerequisite has finished - the dependent's EARLIEST segment start
    # is compared against the prerequisite's LATEST segment end, matching
    # exactly what `solve_schedule`'s pairwise-forbid loop enforces (every
    # (dependent segment, prerequisite segment) pair where the prerequisite
    # segment could still be unfinished is forbidden, which in aggregate means
    # the whole prerequisite must finish before the whole dependent starts).
    dependency_violations = []
    for task_id, segments in task_segments.items():
        task = tasks_by_id[task_id]
        if not task.depends_on_task_id:
            continue
        prereq_segments = task_segments.get(task.depends_on_task_id)
        earliest_dep_window = min(segments, key=lambda pair: (pair[0].day, pair[0].start_minute))[0]
        # As above: corridor, date and department were already available here
        # and simply were not returned (T21).
        common = {
            "taskId": task_id,
            "dependsOn": task.depends_on_task_id,
            "corridorId": task.corridor_id,
            "date": earliest_dep_window.day.isoformat(),
            "departments": [task.department],
            "scheduledAt": (
                f"{_clock(earliest_dep_window.start_minute)}-{_clock(earliest_dep_window.end_minute)}"
            ),
        }
        if prereq_segments is None:
            dependency_violations.append(
                {
                    **common,
                    "issue": "prerequisite not scheduled",
                    "prerequisiteDate": None,
                }
            )
            continue
        latest_prereq_window = max(
            prereq_segments, key=lambda pair: (pair[0].day, pair[0].end_minute)
        )[0]
        if (latest_prereq_window.day, latest_prereq_window.end_minute) > (
            earliest_dep_window.day,
            earliest_dep_window.start_minute,
        ):
            dependency_violations.append(
                {
                    **common,
                    "issue": "scheduled before its prerequisite completes",
                    "prerequisiteDate": latest_prereq_window.day.isoformat(),
                    "prerequisiteAt": (
                        f"{_clock(latest_prereq_window.start_minute)}-"
                        f"{_clock(latest_prereq_window.end_minute)}"
                    ),
                }
            )

    return {
        "resourceConflicts": {
            "count": len(resource_conflicts),
            "note": (
                "Resource no-overlap (PRD 9.8) is enforced as a hard CP-SAT constraint "
                "(T25): two tasks sharing a required resource (crew, machine or "
                "permission) cannot occupy overlapping windows - including across a "
                "split task's individual segments (T29 Phase 1). Checked, not assumed - "
                "the count should always be zero for an OPTIMAL or FEASIBLE solve, and "
                "`solve_schedule` asserts exactly that."
            ),
            "conflicts": resource_conflicts[:20],
        },
        "dependencyViolations": {
            "count": len(dependency_violations),
            "note": (
                "Dependency precedence (PRD 9.7) is enforced as a hard CP-SAT constraint "
                "(T24): a dependent task's EARLIEST segment can only start at or after "
                "its prerequisite's LATEST segment ends (T29 Phase 1 generalises this "
                "from a single window each), and only if the prerequisite is itself "
                "scheduled. This is therefore checked, not assumed - the count should "
                "always be zero for an OPTIMAL or FEASIBLE solve, and `solve_schedule` "
                "asserts exactly that rather than trusting the constraint silently."
            ),
            "violations": dependency_violations[:20],
        },
    }


def _overlaps(first: WindowInstance, second: WindowInstance) -> bool:
    return first.start_minute < second.end_minute and second.start_minute < first.end_minute
