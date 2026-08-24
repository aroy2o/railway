"""Train-impact scoring - implements FR3.4 / PRD 9.6 (task T22), Phase A.

WHAT THIS IS, AND WHAT IT IS NOT
--------------------------------
It answers: *"if a maintenance block took this corridor for these minutes, how
many trains would it displace and what would that cost?"*

It does **not** change what the solver schedules. See D-056 for why Phase B -
letting the solver treat displacement as a schedulable option with a penalty
term in the objective - was scoped out rather than attempted.

THE MEASUREMENT / ESTIMATE BOUNDARY
-----------------------------------
Two different qualities of number come out of here, and they are labelled
differently because they are not equally trustworthy:

* **Measured.** How many occupied windows a block overlaps, and by how many
  minutes. T3 derived those windows from the real ISL-wise timetable, so a
  count of displaced trains and the minutes of overlap are real.
* **Estimated.** *Which classes* those trains are. T3's `occupiedWindows` carry
  times only - the train's class was not kept alongside them. So the class split
  is apportioned from the corridor's overall `trainClassMix`, which is real data
  used in a way that is statistically reasonable and specifically unverified for
  any individual block.

Every payload says which is which. `estimatedDelayMinutes` is a displacement
figure, not a modelled propagation of delay through a timetable - this build has
no such model, and calling it one would be the same overreach PRD 9.1 warns
about for the risk score.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

#: Operational priority tiers, by the class codes T3 observed in the real
#: timetable. Ordering follows Indian Railways' own precedence: the flagship
#: services are the ones a Section Controller may not casually delay.
TRAIN_TIERS: dict[str, set[str]] = {
    "flagship": {"Raj", "Shtb", "JShtb", "Drnt"},
    "express": {"SF", "Mail", "Exp", "GR", "SKr", "Hyd", "Del", "Klkt"},
    "passenger": {"Pass"},
    "suburban": {"MEMU", "DEMU", "Toy"},
}

#: Relative cost of delaying one train of each tier.
#:
#: Measured against the alternatives across the 26 demand-carrying corridors,
#: the same way D-026 fixed the priority weights:
#:
#: | weighting | spread | ties | rho vs utilisation |
#: |---|---:|---:|---:|
#: | flat 1/1/1/1 | **0.00** | **325** | +0.131 |
#: | binary 2/2/1/1 | 1.00 | 16 | +0.597 |
#: | moderate 3/2/1/0.7 | 1.44 | 8 | +0.584 |
#: | **chosen 4/2/1/0.7** | **1.63** | **5** | +0.590 |
#:
#: Flat weighting is the failure mode to avoid: it produces a constant, so the
#: "score" would carry no information at all. The chosen set separates corridors
#: best and ties fewest, and rho +0.59 against utilisation shows it is related
#: to how busy a corridor is without merely restating it.
#:
#: `unknown` sits at 1.0 - neutral rather than free. A class T3 could not
#: identify is 2.8% of observations, and scoring it zero would quietly make
#: unidentified traffic costless to displace.
TIER_WEIGHTS: dict[str, float] = {
    "flagship": 4.0,
    "express": 2.0,
    "passenger": 1.0,
    "suburban": 0.7,
    "unknown": 1.0,
}

#: Stated wherever an impact figure surfaces (PRD Section 5's honesty standard
#: applied to an estimate rather than to synthetic data).
#: A planning day, in minutes.
DAY_MINUTES = 1440

FRAMING = (
    "Train-impact figures are derived from the real ISL-wise timetable: the count of "
    "displaced services and the minutes of overlap are measured. The CLASS SPLIT is "
    "estimated - it is apportioned from the corridor's overall train-class mix, because "
    "the per-service class was not retained alongside the occupied windows. Delay minutes "
    "are displacement time, not a modelled propagation of delay through the timetable."
)


def classify(code: str | None) -> str:
    """Map a timetable class code to its priority tier."""
    if not code:
        return "unknown"
    for tier, codes in TRAIN_TIERS.items():
        if code in codes:
            return tier
    return "unknown"


def tier_mix(class_mix: dict[str, int] | None) -> dict[str, int]:
    """Collapse a corridor's per-code counts into tier counts."""
    collapsed: dict[str, int] = {}
    for code, count in (class_mix or {}).items():
        tier = classify(code)
        collapsed[tier] = collapsed.get(tier, 0) + int(count)
    return collapsed


def mean_tier_weight(class_mix: dict[str, int] | None) -> float:
    """Average cost of displacing one train on this corridor.

    The apportionment step: without per-service classes, the expected cost of
    displacing an unidentified train is the corridor's class-weighted mean.
    """
    tiers = tier_mix(class_mix)
    total = sum(tiers.values())
    if total == 0:
        return TIER_WEIGHTS["unknown"]
    return sum(TIER_WEIGHTS[tier] * count for tier, count in tiers.items()) / total


@dataclass(frozen=True)
class TrainImpact:
    """What taking a corridor for a span would cost, in trains and minutes."""

    corridor_id: str
    start_minute: int
    end_minute: int
    #: MEASURED: occupied windows the span overlaps.
    trains_affected: int
    #: MEASURED: total minutes of overlap with occupied windows.
    displaced_minutes: int
    #: ESTIMATED: class-weighted cost, apportioned from the corridor mix.
    weighted_impact: float
    #: ESTIMATED: how those trains probably split by tier.
    estimated_tier_split: dict[str, float] = field(default_factory=dict)
    #: MEASURED: minutes of the block falling outside T3's declared free windows
    #: but on no train - i.e. the clearance margin T3 leaves around each service.
    #: Reported because a block that displaces nobody is still not free if it
    #: eats safety buffer, and "0 trains" alone would say it was (D-056).
    clearance_minutes: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "corridorId": self.corridor_id,
            "window": f"{self.start_minute}-{self.end_minute}",
            "measured": {
                "trainsAffected": self.trains_affected,
                "displacedMinutes": self.displaced_minutes,
                "clearanceMinutes": self.clearance_minutes,
            },
            "estimated": {
                "weightedImpact": round(self.weighted_impact, 2),
                "tierSplit": {k: round(v, 2) for k, v in self.estimated_tier_split.items()},
            },
            "framing": FRAMING,
        }


def _overlap(a_start: int, a_end: int, b_start: int, b_end: int) -> int:
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def assess_span(
    corridor_id: str,
    occupied_windows: Iterable[dict[str, Any]],
    class_mix: dict[str, int] | None,
    start_minute: int,
    end_minute: int,
    free_windows: Iterable[dict[str, Any]] = (),
) -> TrainImpact:
    """Cost of holding `corridor_id` from `start_minute` to `end_minute`.

    Implements the FR3.4 / PRD 9.6 impact calculation for one candidate span.
    """
    affected = 0
    displaced = 0
    for window in occupied_windows:
        minutes = _overlap(start_minute, end_minute, window["startMin"], window["endMin"])
        if minutes > 0:
            affected += 1
            displaced += minutes

    # Whatever the block covers that is neither declared-free nor on a train is
    # T3's clearance margin around a service.
    free_covered = sum(
        _overlap(start_minute, end_minute, w["startMin"], w["endMin"]) for w in free_windows
    )
    clearance = max(0, (end_minute - start_minute) - free_covered - displaced)

    weight = mean_tier_weight(class_mix)
    tiers = tier_mix(class_mix)
    total = sum(tiers.values()) or 1
    split = {tier: affected * count / total for tier, count in tiers.items()}

    return TrainImpact(
        corridor_id=corridor_id,
        start_minute=start_minute,
        end_minute=end_minute,
        trains_affected=affected,
        displaced_minutes=displaced,
        weighted_impact=weight * displaced,
        estimated_tier_split=split,
        clearance_minutes=clearance,
    )


@dataclass(frozen=True)
class DisplacementOption:
    """The cheapest way to open a long enough span on a busy corridor.

    This is the figure D-024 promised and could not yet give: the 53 tasks that
    fit no free window are not simply impossible - they need a traffic block,
    and this says what that block would cost.
    """

    corridor_id: str
    required_minutes: int
    feasible: bool
    reason: str | None = None
    start_minute: int | None = None
    end_minute: int | None = None
    impact: TrainImpact | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "corridorId": self.corridor_id,
            "requiredMinutes": self.required_minutes,
            "feasible": self.feasible,
            "reason": self.reason,
            "window": (
                None if self.start_minute is None
                else f"{self.start_minute}-{self.end_minute}"
            ),
            "impact": None if self.impact is None else self.impact.as_dict(),
            "note": (
                "A traffic block that displaces scheduled trains. This system does NOT "
                "schedule it - the option is costed so a Controller can decide (T22 Phase A)."
            ),
            "framing": FRAMING,
        }


def cheapest_displacement(
    corridor_id: str,
    free_windows: Sequence[dict[str, Any]],
    occupied_windows: Sequence[dict[str, Any]],
    class_mix: dict[str, int] | None,
    required_minutes: int,
    day_minutes: int = DAY_MINUTES,
) -> DisplacementOption:
    """The lowest-impact span of `required_minutes` on this corridor.

    A traffic block is simply an interval on the day - it does not have to be
    assembled out of T3's listed windows, and trying to assemble it that way was
    wrong twice over. Building runs out of adjacent spans first jumped the gaps
    between them (proposing blocks across hours the timetable says nothing
    about); requiring strict adjacency then made almost every corridor look
    infeasible, because free and occupied windows deliberately do NOT touch -
    T3 leaves a clearance margin around every train.

    So the span is placed freely and only its OVERLAP with occupied windows is
    costed. Candidate starts are the window boundaries: an optimal placement can
    always be slid onto one without increasing overlap, so this is exhaustive
    rather than a heuristic.
    """
    if not free_windows and not occupied_windows:
        # No information about this corridor. Placing a block anywhere and
        # costing it at zero would report "free" when the truth is "unknown".
        return DisplacementOption(
            corridor_id, required_minutes, False,
            reason="no window data for this corridor, so a traffic block cannot be costed",
        )

    if required_minutes > day_minutes:
        return DisplacementOption(
            corridor_id, required_minutes, False,
            reason=(
                f"{required_minutes} min exceeds the {day_minutes}-minute day; no single "
                "traffic block can cover it"
            ),
        )

    boundaries = {0}
    for window in list(free_windows) + list(occupied_windows):
        boundaries.add(int(window["startMin"]))
        # Starting the moment a train clears is the other natural alignment.
        boundaries.add(int(window["endMin"]))
    candidates = sorted(
        start for start in boundaries if 0 <= start <= day_minutes - required_minutes
    )
    if not candidates:
        candidates = [0]

    best: DisplacementOption | None = None
    for start in candidates:
        impact = assess_span(
            corridor_id, occupied_windows, class_mix, start, start + required_minutes,
            free_windows=free_windows,
        )
        # Tie-break on clearance: two placements that displace the same trains
        # are not equally good if one eats more safety margin.
        if best is None or (impact.weighted_impact, impact.clearance_minutes) < (
            best.impact.weighted_impact, best.impact.clearance_minutes
        ):
            best = DisplacementOption(
                corridor_id, required_minutes, True,
                start_minute=start, end_minute=start + required_minutes, impact=impact,
            )
    return best
