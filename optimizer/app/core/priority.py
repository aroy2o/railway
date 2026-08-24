"""Task priority scoring - implements PRD FR2.3 and FR2.4.

Replaces the placeholder T6 was running on. Until now `MaintenanceTask.priority`
carried raw severity 1-5, which on the real corpus leaves **1,057 pairwise ties
among 89 tasks** - roughly a quarter of all pairs indistinguishable. This module
combines the defect's own severity with the criticality of the asset it sits on
and how the SLA clock is running, so those ties resolve on real information.

WHAT IS IMPLEMENTED
-------------------
* FR2.3 - one priority score from severity + asset criticality + SLA urgency,
  with configurable weights.
* FR2.4 - a ranked queue where every score carries a per-factor breakdown and a
  named dominant factor, so "why is this task first" is answerable without
  re-deriving the arithmetic.

WHAT IS DEFERRED
----------------
* FR2.2 predicted failure risk -> T16. `failure_risk_score` is accepted on the
  input and deliberately **not used**: folding in a fabricated risk number to
  make the formula look complete is exactly the dishonesty PRD 9.1 warns
  against. `PriorityBreakdown.uses_failure_risk` reports False so a downstream
  consumer can tell.
* Policy-slider weighting -> T23.

WHY ADDITIVE RATHER THAN MULTIPLICATIVE
---------------------------------------
Severity times criticality is tempting and wrong here for two reasons. It is not
decomposable - FR2.4 asks which factor dominated, and a product has no honest
answer to that - and a single near-zero factor annihilates the score, so a
critical defect on an asset with no recorded criticality would rank at nothing.
A weighted sum decomposes exactly, which is the same reasoning D-012 used for
asset criticality itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

# --------------------------------------------------------------------------- #
# Constants                                                                    #
# --------------------------------------------------------------------------- #

#: Weights for the FR2.3 score. They sum to 1.0 and are ordered by one
#: principle: **the physical state of the asset outranks the paperwork clock.**
#:
#:   severity          0.35  The defect's own observed condition. A rail
#:                           fracture is more urgent than joint wear wherever it
#:                           sits, so this leads.
#:   asset_criticality 0.30  The same defect matters more on a high-consequence
#:                           asset. Real, measured-anchored data (T4/FR2.1).
#:   sla_urgency       0.20  Deadline pressure is a compliance signal, not a
#:                           physical one. It must not let a trivial defect on an
#:                           unimportant asset leapfrog a critical one merely
#:                           because a date is closer.
#:   sla_breach        0.15  Escalation for a commitment already broken -
#:                           deliberately the smallest term, and capped, so that
#:                           being months late can never outrank genuine
#:                           criticality. Verified: see
#:                           `test_a_badly_overdue_trivial_task_cannot_outrank_a_fresh_critical_one`.
#:   failure_risk      0.20  FR2.2, added by T16. Likelihood-of-failing, which
#:                           is a different question from asset_criticality's
#:                           consequence-if-it-fails - the two halves of a risk
#:                           matrix, so they coexist rather than compete.
#:                           Measured near-orthogonal to both existing physical
#:                           factors on the real corpus (rho -0.084 vs severity,
#:                           +0.141 vs criticality), which is the same evidence
#:                           that earned criticality its weight in D-026.
#:                           Capped BELOW criticality on purpose: this score is
#:                           derived from SIMULATED degradation data, while
#:                           criticality is anchored in real train counts (T3),
#:                           and a synthetic input must not outweigh a measured
#:                           one. See D-055.
PRIORITY_WEIGHTS = {
    "severity": 0.30,
    "asset_criticality": 0.25,
    "failure_risk": 0.20,
    "sla_urgency": 0.15,
    "sla_breach": 0.10,
}

#: The weights to use when no failure-risk score is available for a task.
#:
#: NOT the old D-026 set: the remaining four are renormalised so they still sum
#: to 1.0, keeping their relative proportions. A task whose asset has too little
#: degradation history must not be systematically ranked lower than one that has
#: it - that would penalise a data gap as though it were a low-risk finding,
#: which is exactly the "not computed is not the same as computed to be low"
#: error this project avoids elsewhere (D-015, D-045).
WEIGHTS_WITHOUT_RISK = {
    name: weight / (1.0 - PRIORITY_WEIGHTS["failure_risk"])
    for name, weight in PRIORITY_WEIGHTS.items()
    if name != "failure_risk"
}

#: Severity is 1-5, so dividing by 5 keeps a floor of 0.2 rather than mapping the
#: lowest severity to zero. A severity-1 defect is still a defect.
SEVERITY_MAX = 5

#: Asset criticality (FR2.1) is already a 0-100 score.
CRITICALITY_MAX = 100.0

#: Failure risk (FR2.2, T16) is likewise 0-100.
RISK_MAX = 100.0

#: Days over which SLA urgency ramps from 0 (far away) to 1 (due now). 90 is not
#: arbitrary: PRD 5.2 sets the longest SLA tier at 90 days, so this is exactly
#: one full SLA window and the ramp spans the real range of the data.
SLA_URGENCY_HORIZON_DAYS = 90

#: Days past due at which breach urgency saturates. The worst case in the real
#: corpus is 58 days overdue, so 60 covers it: past two months late, further
#: lateness stops changing the ranking. Without a cap, an ancient low-severity
#: task would eventually dominate the queue purely by ageing.
SLA_BREACH_SATURATION_DAYS = 60


# --------------------------------------------------------------------------- #
# Types                                                                        #
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class PriorityInputs:
    """Everything FR2.3 needs about one task."""

    task_id: str
    severity: int
    #: REAL - the asset's FR2.1 criticality score, 0-100 (T4, seeded).
    asset_criticality_score: float
    sla_due_date: date
    #: The date the plan starts from; SLA urgency is measured against it.
    as_of: date
    #: FR2.2, task T16. Accepted and deliberately unused - see module docstring.
    failure_risk_score: float | None = None


@dataclass(frozen=True)
class PriorityBreakdown:
    """A score plus the reasoning behind it (FR2.4)."""

    task_id: str
    score: float
    #: Each factor normalised to 0-1, before weighting.
    components: dict[str, float]
    #: Each factor's actual contribution to the 0-100 score. Sums to `score`.
    contributions: dict[str, float]
    dominant_factor: str
    days_to_due: int
    is_overdue: bool
    uses_failure_risk: bool

    @property
    def solver_priority(self) -> int:
        """Integer priority for the CP-SAT objective.

        CP-SAT needs integer coefficients, and T6 multiplies this by its
        coverage weight. Rounding to the 0-100 scale keeps 100 distinct levels,
        which is ample resolution for a queue of ~89 tasks.
        """
        return max(1, round(self.score))

    def as_dict(self) -> dict:
        return {
            "taskId": self.task_id,
            "priorityScore": round(self.score, 2),
            "solverPriority": self.solver_priority,
            "components": {k: round(v, 4) for k, v in self.components.items()},
            "contributions": {k: round(v, 2) for k, v in self.contributions.items()},
            "dominantFactor": self.dominant_factor,
            "daysToDue": self.days_to_due,
            "isOverdue": self.is_overdue,
            "usesFailureRisk": self.uses_failure_risk,
        }


# --------------------------------------------------------------------------- #
# Scoring                                                                      #
# --------------------------------------------------------------------------- #

def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def sla_urgency(days_to_due: int) -> float:
    """How hard the deadline is pressing, 0-1.

    Ramps linearly from 0 at a full SLA window away to 1 on the due date, and
    stays at 1 once past it - further lateness is scored by `sla_breach`, so the
    two terms measure different things rather than double-counting.
    """
    return _clamp((SLA_URGENCY_HORIZON_DAYS - days_to_due) / SLA_URGENCY_HORIZON_DAYS)


def sla_breach(days_to_due: int) -> float:
    """How far a broken commitment has been broken, 0-1. Zero if not yet due.

    This is the term D-020 left for T7. Because the solver keeps SLA soft - 18 of
    the 89 real tasks are already past due, and a hard deadline would make them
    permanently unschedulable - the escalation for being overdue has to live in
    the priority score. That is where urgency belongs anyway: an overdue task is
    not ineligible, it is more important.
    """
    if days_to_due >= 0:
        return 0.0
    return _clamp(-days_to_due / SLA_BREACH_SATURATION_DAYS)


def score_task(inputs: PriorityInputs, weights: dict[str, float] | None = None) -> PriorityBreakdown:
    """Compute one task's FR2.3 priority score, with its FR2.4 breakdown."""
    days_to_due = (inputs.sla_due_date - inputs.as_of).days
    has_risk = inputs.failure_risk_score is not None

    if weights is not None:
        active = weights
    else:
        active = PRIORITY_WEIGHTS if has_risk else WEIGHTS_WITHOUT_RISK

    components = {
        "severity": _clamp(inputs.severity / SEVERITY_MAX),
        "asset_criticality": _clamp(inputs.asset_criticality_score / CRITICALITY_MAX),
        "sla_urgency": sla_urgency(days_to_due),
        "sla_breach": sla_breach(days_to_due),
    }
    if "failure_risk" in active:
        if not has_risk:
            raise ValueError(
                "weights include failure_risk but no failure_risk_score was supplied; "
                "pass WEIGHTS_WITHOUT_RISK, or a score"
            )
        # FR2.2 (T16). 0-100 like criticality, so the same normalisation.
        components["failure_risk"] = _clamp(inputs.failure_risk_score / RISK_MAX)
    contributions = {name: 100.0 * active[name] * value for name, value in components.items()}
    total = sum(contributions.values())

    return PriorityBreakdown(
        task_id=inputs.task_id,
        score=total,
        components=components,
        contributions=contributions,
        # Largest actual contribution, not largest raw component - the whole
        # point of FR2.4 is which factor moved the score, and that is the
        # weighted figure.
        dominant_factor=max(contributions, key=lambda name: (contributions[name], name)),
        days_to_due=days_to_due,
        is_overdue=days_to_due < 0,
        # True only when a real FR2.2 score was supplied AND weighted. Reported
        # so nobody mistakes a renormalised four-factor score for a risk-aware
        # one, and so the PRD 9.1 framing can be attached wherever it is True.
        uses_failure_risk="failure_risk" in active,
    )


def rank_tasks(
    inputs: list[PriorityInputs], weights: dict[str, float] | None = None
) -> list[PriorityBreakdown]:
    """FR2.4 - the ranked queue, highest priority first.

    Ties break on task id so the queue is stable run to run, matching the
    determinism the solver guarantees (D-022).
    """
    scored = [score_task(item, weights) for item in inputs]
    scored.sort(key=lambda breakdown: (-breakdown.score, breakdown.task_id))
    return scored


# Fail loudly at import if the weights are edited into an invalid set: a score
# presented as a weighted average on a 0-100 scale must actually be one.
_total = sum(PRIORITY_WEIGHTS.values())
if abs(_total - 1.0) > 1e-9:
    raise ValueError(f"PRIORITY_WEIGHTS must sum to 1.0, got {_total}")
