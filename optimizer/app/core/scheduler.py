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
* Each task assigned to at most one window; unassigned means deferred, and every
  deferral carries a machine-readable reason (FR3.3 - never silently dropped).
* Sum of assigned durations in a window <= window length.
* Windows on one corridor never overlap - guaranteed structurally by T3, which
  emits the merged complement of occupancy, and asserted here rather than
  re-encoded as constraints.
* Cross-department batching: several tasks may share one window, and a window
  carrying two or more departments is explicitly rewarded (implemented for real,
  see `_add_batching`).
* Deadline: SLA compliance is an objective reward, not a hard constraint - see
  the note on `WEIGHT_SLA` below for why the data forces this.
* Objective: a simplified form of PRD 13.1 - priority-weighted coverage, SLA
  compliance and batching rewarded; unused block time and fragmentation
  penalised.

WHAT IS DEFERRED, AND TO WHERE
------------------------------
* Real priority scores            -> T7  (FR2.3). `MaintenanceTask.priority` is
                                    a PLACEHOLDER carrying severity 1-5.
* Asset risk reduction term (beta) -> T16 (FR2.2), needs failureRiskScore.
* Train-delay-impact term (lambda) -> T22 (PRD 9.6).
* Policy-slider weights            -> T23 (PRD 13.1). Weights are constants here.
* Dependency precedence            -> T24 (PRD 9.7). Violations are DETECTED and
                                    reported, never silently produced.
* Resource no-overlap              -> T25 (PRD 9.8). Same treatment: detected and
                                    reported as a known gap.
* Weather/seasonal risk term (xi)  -> T26 (PRD 9.9).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta

from ortools.sat.python import cp_model

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

class DeferralReason:
    """Machine-readable deferral codes (FR3.3).

    Kept as codes rather than free text so the API (T9) can group them and the
    explainability layer (T17) can turn them into grounded prose without parsing
    English.
    """

    NO_WINDOW_ON_CORRIDOR = "NO_WINDOW_ON_CORRIDOR"
    EXCEEDS_LONGEST_WINDOW = "EXCEEDS_LONGEST_WINDOW"
    NO_CAPACITY = "NO_CAPACITY"


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
        }


@dataclass
class DeferredTask:
    """A task the solver could not place, with why (FR3.3)."""

    task_id: str
    reason: str
    detail: str

    def as_dict(self) -> dict:
        return {"taskId": self.task_id, "reason": self.reason, "detail": self.detail}


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
) -> ScheduleResult:
    """Build and solve the CP-SAT block-allocation model.

    `num_workers=1` with a fixed seed is the default because reproducibility
    matters more here than raw speed: CP-SAT's parallel portfolio returns
    whichever optimal solution a worker finds first, so identical input can
    yield different (equally optimal) schedules run to run. A plan that changes
    when nothing changed is indefensible in a demo and impossible to test.
    See docs/DECISIONS.md D-022.
    """
    horizon = "weekly" if horizon_days == 7 else f"{horizon_days}-day"
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

        longest = max(window.duration_minutes for window in candidates)
        if task.duration_minutes > longest:
            deferred.append(
                DeferredTask(
                    task.task_id,
                    DeferralReason.EXCEEDS_LONGEST_WINDOW,
                    f"needs {task.duration_minutes} min but the longest free window on "
                    f"{task.corridor_id} is {longest} min - this corridor's traffic leaves "
                    f"no gap long enough, so the work requires a traffic block that displaces "
                    f"trains (train-impact-aware planning, T22)",
                )
            )
            continue

        schedulable.append(task)

    model = cp_model.CpModel()

    # --- decision variables: assign[i][j] (PRD Section 13) ------------------
    # Only created where the task physically fits the window, which keeps the
    # model small and makes infeasibility explicit rather than implicit.
    assign: dict[tuple[str, str], cp_model.IntVar] = {}
    candidates_for_task: dict[str, list[WindowInstance]] = {}

    for task in schedulable:
        fitting = [
            window
            for window in windows_by_corridor[task.corridor_id]
            if task.duration_minutes <= window.duration_minutes
        ]
        candidates_for_task[task.task_id] = fitting
        for window in fitting:
            assign[(task.task_id, window.key)] = model.new_bool_var(
                f"assign[{task.task_id}][{window.key}]"
            )

    # --- constraint: each task in at most one window ------------------------
    # "At most", not "exactly": zero means deferred, which FR3.3 requires to be
    # a representable outcome rather than an infeasible model.
    for task in schedulable:
        model.add_at_most_one(
            assign[(task.task_id, window.key)] for window in candidates_for_task[task.task_id]
        )

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

        used = sum(
            task.duration_minutes * assign[(task.task_id, window.key)] for task in occupants
        )
        used_expr[window.key] = used

        # PRD Section 13: sum of assigned durations <= window length. Multiplying
        # by `is_open` also links the two: a window with work in it is open.
        model.add(used <= window.duration_minutes * is_open)
        for task in occupants:
            model.add(assign[(task.task_id, window.key)] <= is_open)

    batched = _add_batching(model, schedulable, tasks_in_window, assign, window_open)

    # --- objective: simplified PRD 13.1 -------------------------------------
    objective_terms = []

    # alpha - priority-weighted coverage.
    for task in schedulable:
        for window in candidates_for_task[task.task_id]:
            objective_terms.append(
                weights.coverage * task.priority * assign[(task.task_id, window.key)]
            )

    # epsilon - SLA compliance, as a REWARD rather than a hard deadline.
    # 17 of the 89 real tasks are already past their slaDueDate at the horizon
    # start; a hard constraint would make them permanently unschedulable, which
    # is precisely backwards - overdue maintenance is more urgent, not less.
    # PRD 13.1 lists SLA compliance as an objective term, and Section 13's
    # "where feasible" wording says the same. See docs/DECISIONS.md D-020.
    for task in schedulable:
        for window in candidates_for_task[task.task_id]:
            if window.day <= task.sla_due_date:
                objective_terms.append(
                    weights.sla_compliance * assign[(task.task_id, window.key)]
                )

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
        candidates_for_task=candidates_for_task,
        deferred=deferred,
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
    candidates_for_task,
    deferred,
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
    placements: dict[str, WindowInstance] = {}

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        windows_by_key = {window.key: window for window in windows}
        grouped: dict[str, list[MaintenanceTask]] = {}

        for (task_id, window_key), variable in assign.items():
            if solver.value(variable):
                grouped.setdefault(window_key, []).append(tasks_by_id[task_id])
                placements[task_id] = windows_by_key[window_key]

        for window_key in sorted(grouped):
            window = windows_by_key[window_key]
            occupants = sorted(grouped[window_key], key=lambda t: t.task_id)
            result.blocks.append(
                ScheduledBlock(
                    corridor_id=window.corridor_id,
                    day=window.day,
                    window_index=window.window_index,
                    start_minute=window.start_minute,
                    end_minute=window.end_minute,
                    capacity_minutes=window.duration_minutes,
                    used_minutes=sum(task.duration_minutes for task in occupants),
                    task_ids=[task.task_id for task in occupants],
                    departments=[task.department for task in occupants],
                )
            )

    result.blocks.sort(key=lambda b: (b.day, b.corridor_id, b.start_minute))

    # Anything the solver considered but did not place is deferred for capacity
    # reasons - stated separately from structural impossibility.
    scheduled = set(placements)
    for task in model_tasks:
        if task.task_id not in scheduled:
            candidate_count = len(candidates_for_task[task.task_id])
            result.deferred.append(
                DeferredTask(
                    task.task_id,
                    DeferralReason.NO_CAPACITY,
                    f"{candidate_count} window(s) on {task.corridor_id} could physically hold "
                    f"this task, but every one was better used by higher-priority work",
                )
            )

    result.deferred.sort(key=lambda d: d.task_id)
    result.decision_log = _build_decision_log(all_tasks, placements, result.deferred)
    result.known_gaps = detect_known_gaps(all_tasks, placements)

    # FR3.3 as an invariant, not an aspiration: no task may vanish.
    accounted = result.scheduled_task_ids | {d.task_id for d in result.deferred}
    missing = {task.task_id for task in all_tasks} - accounted
    if missing:
        raise AssertionError(f"tasks missing from the result: {sorted(missing)}")

    return result


def _build_decision_log(all_tasks, placements, deferred) -> list[dict]:
    """Per-task record of what happened and the factors behind it.

    Deliberately structured rather than prose: T17 turns these factors into
    plain English grounded in the solver's own decisions, and PRD 18 is explicit
    that the explanation layer must never invent numbers.
    """
    reasons = {item.task_id: item for item in deferred}
    log = []

    for task in sorted(all_tasks, key=lambda t: t.task_id):
        window = placements.get(task.task_id)
        if window is not None:
            log.append(
                {
                    "taskId": task.task_id,
                    "decision": "scheduled",
                    "corridorId": task.corridor_id,
                    "date": window.day.isoformat(),
                    "window": f"{_clock(window.start_minute)}-{_clock(window.end_minute)}",
                    "contributingFactors": {
                        "priority": task.priority,
                        "priorityIsPlaceholder": task.priority_is_placeholder,
                        "durationMinutes": task.duration_minutes,
                        "windowCapacityMinutes": window.duration_minutes,
                        "slaDueDate": task.sla_due_date.isoformat(),
                        "withinSla": window.day <= task.sla_due_date,
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
                    "reason": item.reason,
                    "detail": item.detail,
                    "contributingFactors": {
                        "priority": task.priority,
                        "priorityIsPlaceholder": task.priority_is_placeholder,
                        "durationMinutes": task.duration_minutes,
                        "slaDueDate": task.sla_due_date.isoformat(),
                    },
                }
            )

    return log


def detect_known_gaps(all_tasks, placements: dict[str, WindowInstance]) -> dict:
    """Report constraints this task deliberately does NOT enforce.

    PRD Section 13 lists resource no-overlap (9.8) and dependency precedence
    (9.7) as constraints, but CLAUDE.md's build order assigns them to T25 and
    T24. Rather than ship a scheduler that quietly violates them, the violations
    are measured and reported here, so the gap is visible in the output instead
    of being discovered later as a scheduling bug.
    """
    tasks_by_id = {task.task_id: task for task in all_tasks}

    # --- resource conflicts (T25, PRD 9.8) ---------------------------------
    # Two tasks sharing a resource are in conflict when their windows overlap in
    # real time. Same window is the obvious case; different corridors' windows
    # can also overlap, because resources are depot-scoped across corridors.
    resource_conflicts = []
    scheduled = sorted(placements)
    for index, first_id in enumerate(scheduled):
        first_window = placements[first_id]
        first_task = tasks_by_id[first_id]
        for second_id in scheduled[index + 1 :]:
            second_window = placements[second_id]
            second_task = tasks_by_id[second_id]
            if first_window.day != second_window.day:
                continue
            if not _overlaps(first_window, second_window):
                continue
            shared = set(first_task.required_resource_ids) & set(
                second_task.required_resource_ids
            )
            if shared:
                resource_conflicts.append(
                    {
                        "taskIds": [first_id, second_id],
                        "sharedResourceIds": sorted(shared),
                        "date": first_window.day.isoformat(),
                    }
                )

    # --- dependency ordering (T24, PRD 9.7) --------------------------------
    dependency_violations = []
    for task_id, window in placements.items():
        task = tasks_by_id[task_id]
        if not task.depends_on_task_id:
            continue
        prerequisite = placements.get(task.depends_on_task_id)
        if prerequisite is None:
            dependency_violations.append(
                {
                    "taskId": task_id,
                    "dependsOn": task.depends_on_task_id,
                    "issue": "prerequisite not scheduled",
                }
            )
        elif (prerequisite.day, prerequisite.end_minute) > (window.day, window.start_minute):
            dependency_violations.append(
                {
                    "taskId": task_id,
                    "dependsOn": task.depends_on_task_id,
                    "issue": "scheduled before its prerequisite completes",
                }
            )

    return {
        "resourceConflicts": {
            "count": len(resource_conflicts),
            "note": "Resource no-overlap (PRD 9.8) is not modelled in T6; it is task T25. "
            "Conflicts are detected and reported rather than silently produced.",
            "conflicts": resource_conflicts[:20],
        },
        "dependencyViolations": {
            "count": len(dependency_violations),
            "note": "Dependency precedence (PRD 9.7) is not modelled in T6; it is task T24.",
            "violations": dependency_violations[:20],
        },
    }


def _overlaps(first: WindowInstance, second: WindowInstance) -> bool:
    return first.start_minute < second.end_minute and second.start_minute < first.end_minute
