"""The grounding contract for Ask the Planner - PRD 9.2, FR8.2, Section 18.

PRD Section 18's rule is absolute: *"Ground every explanation strictly in the
solver's own decision log, never let the LLM invent numbers."* This module is
how that rule is enforced rather than merely requested.

THE SHAPE OF THE GUARANTEE
--------------------------
The LLM is never handed the schedule. It is handed a `GroundingContext`: a flat
list of `Fact` records, each one a value copied out of a stored record, each one
carrying the id of the record it came from. The prompt states that no number may
appear in the answer unless it appears in that list. Because the list is built
by a pure function, a test can assert exactly what the model was allowed to see
*before* any API call happens - which is the only part of this pipeline that is
deterministic, and therefore the only part where "verified" means anything
strong.

So the division of labour is deliberate:

  * **What the model may say** - decided here, deterministically, fully tested.
  * **How it phrases it** - decided by the model, non-deterministic, checked by
    tests that tolerate wording but not invented figures.

WHAT THIS SYSTEM CANNOT ANSWER
------------------------------
A Controller will ask about what-if scenarios, policy weighting and weather,
because a real planning system has them. This one does not.
`UNAVAILABLE_TOPICS` names each gap and the reason, the context carries the
relevant ones, and the prompt instructs the model to decline and say why.
Declining is a feature: PRD Section 18 lists LLM invention as a headline risk,
and the most likely invention is an answer to a question about data that does
not exist. Same principle as T21's `notYetDetectable` - "we cannot check this"
is a different claim from "we checked and found nothing".

A gap that gets FILLED has to be removed from that list on the same day, or the
system starts asserting a limitation it no longer has - which is exactly as
wrong as overclaiming, just in the flattering direction. Train impact left this
list at T22 and failure risk at T16; approval history leaves it here at T19.
What replaces each one is not silence but a FRAMING fact: the thing an answer
can now actually get wrong. For approvals that is attribution - this build has
roles, not user accounts, so "who approved this" has a role for an answer and
never a name.
"""

from __future__ import annotations

import re
import json
from dataclasses import dataclass, field
from typing import Any, Iterable

from app.core.risk import FRAMING as RISK_FRAMING
from app.core.trains import FRAMING as TRAIN_FRAMING

#: ISO dates get special handling in `GroundingContext.numbers` - see there.
ISO_DATE_PATTERN = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")

#: A full ISO-8601 instant, as every `createdAt` in the audit trail is stored.
#: Handled before dates and never decomposed: the clock components are all small
#: integers, so whitelisting them would clear a fabricated "9 trains" on any
#: plan whose approval happened to land at 09 minutes past. Same reasoning that
#: withholds a date's MONTH, applied to the rest of the timestamp.
ISO_TIMESTAMP_PATTERN = re.compile(
    r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?"
)

#: Ids look like TSK-00001; corridors like ABEO-ABU or BBPR-SYU.
TASK_ID_PATTERN = re.compile(r"\bTSK-\d{3,6}\b", re.IGNORECASE)
CORRIDOR_ID_PATTERN = re.compile(r"\b[A-Z]{2,6}-[A-Z]{2,6}\b")

#: How many decision-log entries to include when a question names no task.
#: Enough to answer "what got deferred and why" without an unbounded prompt.
DEFAULT_ENTRY_LIMIT = 12

#: Fact kinds whose `framing` the UI renders beside the answer whatever the
#: model said. `model_framing` covers model OUTPUTS (risk scores, apportioned
#: train classes) and carries a simulated-data disclaimer; `workflow_framing`
#: covers stored facts whose caveat is about attribution, not simulation.
FRAMING_KINDS = ("model_framing", "workflow_framing")

#: Character ceiling on the serialised facts.
#:
#: Not a tidiness measure - a hard requirement. A question naming no task built
#: a ~45,000-character prompt (~11,000 tokens) from the real corpus, which
#: exceeds the per-minute token allowance of every model this service is
#: configured against and would simply fail.
#:
#: Sized against MEASURED tokens, not the char/4 rule of thumb: dense JSON full
#: of ids, quotes and hyphens tokenises at roughly 1.3 characters per token, so
#: 5,600 characters measured 4,241 prompt tokens - three times the estimate.
#: 4,500 characters lands near 1,750 tokens, which fits an 8,000 tokens/minute
#: budget four times over.
#:
#: Facts are dropped from the END, and the drop is REPORTED rather than silent:
#: a context that quietly lost the record holding the answer would produce a
#: confident "the plan does not show that", which is a wrong answer wearing the
#: costume of an honest one. See D-053.
MAX_CONTEXT_CHARS = 4500

#: Survival tiers under the size budget. Lower survives longer.
TIER_ESSENTIAL = 1   # plan summary, and the gaps that stop a misreading
TIER_NAMED = 2       # evidence about what the question actually asked about
TIER_COMPARISON = 3  # FR9.3 baseline figures, with their D-031 caveats
TIER_CONTEXT = 4     # the bounded slice, included only for perspective


@dataclass(frozen=True)
class Fact:
    """One value, and the stored record it was copied from.

    `record_id` is what makes an answer auditable: every figure the model is
    permitted to use can be traced back to a record a Controller can open.
    """

    id: str
    kind: str
    summary: str
    data: dict[str, Any]
    #: Survival rank when the context exceeds its size budget. Lower survives.
    #: Evidence about a task the Controller NAMED outranks plan-level
    #: perspective; the bounded slice is dropped first. Positional order alone
    #: got this wrong - the plan summary sits first for readability, and
    #: truncating from the end discarded the named task's own block and
    #: conflicts while keeping generic context. See D-053.
    priority: int = TIER_CONTEXT

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "summary": self.summary, "data": self.data}


@dataclass(frozen=True)
class UnavailableTopic:
    """Something this build genuinely cannot answer, and why."""

    topic: str
    reason: str
    blocked_on: str

    def as_dict(self) -> dict[str, Any]:
        return {"topic": self.topic, "reason": self.reason, "blockedOn": self.blocked_on}


#: Topics a Controller will reasonably raise that this build has no data for.
#:
#: Keyed by topic; `triggers` are matched case-insensitively against the
#: question. Detection is deliberately keyword-based and deterministic so a test
#: can assert it, and it only ever *adds* a caveat to the context - it never
#: suppresses an answer on its own. The model decides whether the question
#: actually depends on the missing data; the caveat makes sure it knows the data
#: is missing rather than assuming it was merely omitted.
UNAVAILABLE_TOPICS: dict[str, dict[str, Any]] = {
    "what-if simulation": {
        "triggers": ("what if", "what-if", "simulate", "if i moved", "if we moved",
                     "suppose", "scenario"),
        "reason": (
            "What-if simulation is not built. This system can explain the plan it produced "
            "and validate a specific proposed override, but it cannot generate alternative "
            "scenarios or compare their outcomes."
        ),
        "blocked_on": "T20 (PRD 9.4 what-if simulation)",
    },
    "policy weighting": {
        "triggers": ("policy", "weighting", "slider", "tune the objective", "change the weights",
                     "prioritise differently", "prioritize differently"),
        "reason": (
            "Objective weights are fixed in this build. There are no controls to re-weight "
            "the trade-off between urgency, utilisation and disruption."
        ),
        "blocked_on": "T23 (policy sliders)",
    },
    "weather and season": {
        "triggers": ("weather", "monsoon", "rain", "flood", "season"),
        "reason": (
            "Corridors carry no seasonal or weather risk data, and the optimizer does not "
            "consider weather at all."
        ),
        "blocked_on": "PRD 9.9 (weather-aware scheduling), not scheduled",
    },
}

#: T16 built the predictive risk model, so "we cannot answer risk questions" is
#: no longer true - but the answer needs a caveat of a different kind. The model
#: is trained on SIMULATED degradation data, and an answer that quoted a risk
#: score as an operational prediction would breach PRD Section 6's NG4. This is
#: attached whenever a question touches risk, alongside the real numbers.
#: Questions that are ABOUT the workflow, rather than merely near it.
#: When one matches, the approval rows are promoted so the size budget cannot
#: drop the very records the question asked for - the failure D-053 recorded.
APPROVAL_TRIGGERS = (
    "approve", "approval", "audit", "sign off", "signed off", "signoff",
    "who authorised", "who authorized", "reject", "publish", "published",
    "version", "workflow", "review",
)

RISK_FRAMING_TRIGGERS = (
    "failure risk", "risk score", "predict", "probability of failure", "degradation",
    "will it fail", "risk model", "survival", "asset health", "condition",
)

#: Stated in every context. The maintenance corpus is synthetic (PRD Section 5),
#: and an explanation that presents it as operational data would be misleading
#: even if every number in it were real.
DATA_PROVENANCE_NOTE = (
    "Corridor, station and timetable data are real (Indian Railways open datasets). "
    "Maintenance tasks, defects, assets and resources are SYNTHETIC, generated to realistic "
    "distributions for this prototype. Never present a maintenance figure as an observed "
    "operational fact."
)


@dataclass
class GroundingContext:
    """Everything the model is permitted to know, and nothing else."""

    question: str
    facts: list[Fact] = field(default_factory=list)
    unavailable: list[UnavailableTopic] = field(default_factory=list)
    #: Task/corridor ids the question referred to that exist in this schedule.
    resolved_references: dict[str, list[str]] = field(default_factory=dict)
    #: Ids named in the question that are NOT in this schedule. Carried so the
    #: model can say "that task is not in this plan" instead of inventing it.
    unknown_references: list[str] = field(default_factory=list)
    #: Records dropped to fit the size budget. Reported, never silent (D-053).
    omitted_fact_count: int = 0
    provenance_note: str = DATA_PROVENANCE_NOTE

    @property
    def record_ids(self) -> list[str]:
        return [fact.id for fact in self.facts]

    def model_framings(self) -> list[dict[str, Any]]:
        """Framing caveats the context carried, for the UI to render itself.

        The prompt also instructs the model to repeat these, but a prompt is not
        a guarantee (D-050). Returning them separately means the caveat appears
        beside the answer whether or not the model remembered it - the same
        "verify, do not trust" split the number checker uses.
        """
        return [
            {"factId": fact.id, "framing": fact.data.get("framing"),
             "applies_to": fact.data.get("field")}
            for fact in self.facts
            if fact.kind in FRAMING_KINDS and fact.data.get("framing")
        ]

    def numbers(self) -> set[str]:
        """Every numeric value the model is allowed to state.

        Used by the runtime verifier: a number in an answer that is not in this
        set (and not in the question) was not taken from any record.

        **Known limit.** An ISO date contributes its year and day but NOT its
        month, because a month is always 1-12 and would whitelist a small
        integer on nearly every schedule - "9 trains" passing because some task
        is due in September is a false clearance, and this set exists to catch
        exactly that shape of claim. Small integers can still be whitelisted by
        coincidence from real values elsewhere; the verifier is a net for
        distinctive fabricated quantities, not a proof of grounding. See D-050.
        """
        found: set[str] = set()

        def walk(value: Any) -> None:
            if isinstance(value, bool) or value is None:
                return
            if isinstance(value, (int, float)):
                found.add(_normalise_number(value))
            elif isinstance(value, str):
                # Timestamps first: a bare date pass would leave `T02:59:09Z`
                # behind and feed 2, 59 and 9 into the allowed set.
                remainder = ISO_TIMESTAMP_PATTERN.sub(
                    lambda m: m.group(0)[:10], value
                )
                for match in ISO_DATE_PATTERN.finditer(remainder):
                    year, _month, day = match.groups()
                    found.add(_normalise_number(float(year)))
                    found.add(_normalise_number(float(day)))
                    remainder = remainder.replace(match.group(0), " ")
                for match in re.findall(r"\d+(?:\.\d+)?", remainder):
                    found.add(_normalise_number(match))
            elif isinstance(value, dict):
                for item in value.values():
                    walk(item)
            elif isinstance(value, (list, tuple)):
                for item in value:
                    walk(item)

        for fact in self.facts:
            walk(fact.data)
        return found

    def date_strings(self) -> set[str]:
        """Every whole ISO date and instant the model may state.

        Checked as whole strings rather than as loose integers - see
        `verify_answer`. Timestamps are included so an audit answer can quote
        the moment a plan was signed off without its clock components being
        read as quantities.
        """
        found: set[str] = set()

        def walk(value: Any) -> None:
            if isinstance(value, str):
                found.update(m.group(0) for m in ISO_TIMESTAMP_PATTERN.finditer(value))
                found.update(m.group(0) for m in ISO_DATE_PATTERN.finditer(value))
            elif isinstance(value, dict):
                for item in value.values():
                    walk(item)
            elif isinstance(value, (list, tuple)):
                for item in value:
                    walk(item)

        for fact in self.facts:
            walk(fact.data)
        return found

    def as_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "facts": [fact.as_dict() for fact in self.facts],
            "unavailable": [topic.as_dict() for topic in self.unavailable],
            "resolvedReferences": self.resolved_references,
            "unknownReferences": self.unknown_references,
            "omittedFactCount": self.omitted_fact_count,
            "provenanceNote": self.provenance_note,
            "recordIds": self.record_ids,
        }


def _normalise_number(value: float | str) -> str:
    """`36`, `36.0` and `36.00` are the same number for grounding purposes.

    A whole-number STRING is normalised without going through `float`. Above
    2**53 a float cannot hold an integer exactly, so a 17-digit run - the shape
    of every id timestamp in this system - came back off by one or two, and the
    same value could normalise differently depending on which side of the check
    it arrived from. Surfaced by a live run; see D-059.
    """
    if isinstance(value, str) and value.isdigit():
        return value.lstrip("0") or "0"
    rounded = round(float(value), 2)
    return str(int(rounded)) if rounded == int(rounded) else f"{rounded:g}"


def _mentions(question: str, trigger: str) -> bool:
    """Word-boundary match, not substring.

    Substring matching looked fine until "express **train**" tripped the weather
    caveat via "rain". A false caveat is not harmless: it tells the model data is
    missing when it is not, which is a route to a wrongly-declined answer.

    The boundary is on the LEADING edge only, so "approve" still matches
    "approved" and "approval" - English inflection is a suffix, and requiring a
    trailing boundary silently missed every past-tense phrasing a Controller
    would actually type.
    """
    return re.search(rf"\b{re.escape(trigger)}", question, re.IGNORECASE) is not None


def detect_unavailable_topics(question: str) -> list[UnavailableTopic]:
    """Which known gaps this question appears to touch. Deterministic."""
    return [
        UnavailableTopic(topic, spec["reason"], spec["blocked_on"])
        for topic, spec in UNAVAILABLE_TOPICS.items()
        if any(_mentions(question, trigger) for trigger in spec["triggers"])
    ]


def extract_references(question: str) -> dict[str, list[str]]:
    """Task and corridor ids named in the question, uppercased and de-duplicated."""
    tasks = sorted({match.upper() for match in TASK_ID_PATTERN.findall(question)})
    corridors = sorted(
        {match for match in CORRIDOR_ID_PATTERN.findall(question.upper())}
        - set(tasks)
    )
    return {"tasks": tasks, "corridors": corridors}


# --------------------------------------------------------------------------- #
# Fact builders - each one copies stored values, never derives a new claim      #
# --------------------------------------------------------------------------- #

def _plan_summary_fact(schedule: dict) -> Fact:
    metrics = schedule.get("metrics") or {}
    return Fact(
        id="plan:summary",
        kind="plan_summary",
        priority=TIER_ESSENTIAL,
        summary="Headline figures for this schedule.",
        data={
            "horizonStart": schedule.get("horizonStart"),
            "horizonDays": schedule.get("horizonDays"),
            "solverStatus": schedule.get("status"),
            "tasksScheduled": metrics.get("tasksScheduled"),
            "tasksDeferred": metrics.get("tasksDeferred"),
            "blocksUsed": metrics.get("blocksUsed"),
            "crossDepartmentBatches": metrics.get("crossDepartmentBatches"),
            "blockMinutesUsed": metrics.get("blockMinutesUsed"),
            "blockMinutesCapacity": metrics.get("blockMinutesCapacity"),
            "blockUtilisationPct": metrics.get("blockUtilisationPct"),
        },
    )


def _comparison_fact(schedule: dict) -> Fact | None:
    """FR9.3 baseline-vs-AI, carried WITH its caveats.

    D-031 found that the baseline's utilisation reads higher and that neither
    engine schedules more tasks than the other. An explanation that quoted the
    comparison without those caveats would be technically sourced and
    substantively misleading, so the caveats travel with the numbers.
    """
    comparison = schedule.get("comparisonToBaseline")
    if not comparison:
        return None
    return Fact(
        id="plan:comparison",
        kind="baseline_comparison",
        priority=TIER_COMPARISON,
        summary="Optimized plan vs the naive per-department baseline (FR9.3).",
        data={
            "optimized": comparison.get("optimized"),
            "baseline": comparison.get("baseline"),
            "contestableTaskCount": comparison.get("contestableTaskCount"),
            # T29 Phase 1 (D-084): tasks placeable only via splitting - the
            # baseline structurally cannot do this work, at any horizon.
            "splitOnlyTaskCount": comparison.get("splitOnlyTaskCount"),
            "structurallyImpossibleCount": comparison.get("structurallyImpossibleCount"),
            "caveats": comparison.get("caveats"),
        },
    )


#: Dropped from a compact decision entry. `components` are the pre-weighting
#: normalised values; `contributions` (which are kept) carry the same story in
#: the units the score is actually in, so this is redundancy, not information.
_COMPACT_BREAKDOWN_DROP = ("components",)


def _decision_fact(entry: dict, *, compact: bool = False, priority: int = TIER_CONTEXT) -> Fact:
    """One decision-log entry.

    `compact` trims the breakdown internals for entries that are context rather
    than subject. A task the Controller named gets its full record; the dozen
    others included to give the answer perspective do not need every normalised
    component, and at ~500 characters each they are what pushes a prompt past
    the token budget (D-053).
    """
    factors = dict(entry.get("contributingFactors") or {})
    breakdown = factors.get("priorityBreakdown")
    if isinstance(breakdown, dict):
        # `components` are dropped for every entry, not just compact ones:
        # they are the pre-weighting normalised values, and `contributions`
        # carries the same story in the units the score is actually in.
        factors["priorityBreakdown"] = {
            key: value for key, value in breakdown.items()
            if key not in _COMPACT_BREAKDOWN_DROP
        }
    if compact:
        factors.pop("priorityBreakdown", None)
    data = {**entry, "contributingFactors": factors}

    return Fact(
        id=f"decision:{entry['taskId']}",
        kind="decision_log_entry",
        summary=(
            f"{entry['taskId']} was {entry['decision']} by the solver"
            + (f" on {entry.get('date')} in the {entry.get('window')} window"
               if entry.get("date") else "")
            + "."
        ),
        data=data,
        priority=priority,
    )


def _task_fact(task: dict) -> Fact:
    return Fact(
        id=f"task:{task['_id']}",
        kind="task_record",
        priority=TIER_NAMED,
        summary=f"The stored maintenance task {task['_id']}.",
        data={
            key: task.get(key)
            for key in (
                "_id", "corridorId", "assetId", "department", "defectType", "severity",
                "workflowStage", "status", "slaDueDate", "dateRaised",
                "estBlockDurationMins", "dependsOnTaskId", "requiredResourceIds",
                "priorityScore", "dominantPriorityFactor", "failureRiskScore",
            )
        },
    )


def _block_fact(block: dict) -> Fact:
    return Fact(
        id=f"block:{block['corridorId']}:{block['date']}:{block.get('windowIndex')}",
        kind="scheduled_block",
        summary=(
            f"A block on {block['corridorId']} on {block['date']}, "
            f"{block.get('start')}-{block.get('end')}."
        ),
        data=block,
        priority=TIER_NAMED,
    )


def _conflict_fact(conflict: dict, *, priority: int = TIER_CONTEXT) -> Fact:
    """One typed conflict (T21).

    `resolution.explanation` is a paragraph written for a human reading the
    conflicts screen. It is the single largest string in a conflict record and
    contains no figure the model needs, so only the strategy label and the task
    that would enforce it are carried. `detail` already states the specifics.
    """
    ids = "+".join(conflict.get("taskIds") or []) or conflict.get("corridorId") or "?"
    resolution = conflict.get("resolution") or {}
    trimmed = {
        key: value for key, value in conflict.items()
        if key not in ("resolution", "plan")
    }
    trimmed["resolution"] = {
        "strategy": resolution.get("strategy"),
        "enforcedBy": resolution.get("enforcedBy"),
    }
    trimmed["plan"] = conflict.get("plan")
    return Fact(
        id=f"conflict:{conflict['type']}:{ids}",
        kind="typed_conflict",
        summary=conflict.get("detail", conflict["type"]),
        data=trimmed,
        priority=priority,
    )


def _override_fact(override: dict, *, priority: int = TIER_CONTEXT) -> Fact:
    return Fact(
        id=f"override:{override.get('_id', override.get('taskId'))}",
        kind="manual_override",
        summary=(
            f"A Controller manually moved {override.get('taskId')} after the solver ran."
        ),
        data=override,
        priority=priority,
    )


#: Attached whenever risk is in play (T16).
#:
#: The score is real now, so it is quotable - but it comes from a model trained
#: on SIMULATED degradation data, and PRD Section 6's NG4 forbids presenting it
#: as a forecast of real Indian Railways failures. The number and the caveat
#: therefore travel as one fact rather than as two the model might separate.
RISK_MODEL_FRAMING_FACT = Fact(
    id="framing:riskModel",
    kind="model_framing",
    summary="How the FR2.2 failure-risk score must be described.",
    data={
        "field": "task.failureRiskScore / asset.failureRiskScore",
        "scale": "0-100, higher means sooner to the intervention threshold",
        "model": "linear trend extrapolation over simulated degradation history",
        "framing": RISK_FRAMING,
        "mustNotSay": (
            "Do not describe this as predicting a real failure, a real probability, or an "
            "observed condition. It is a model output over simulated data."
        ),
    },
    priority=TIER_ESSENTIAL,
)

#: Always attached. Replaces the pre-T22 "no train-impact data exists" gap fact.
#:
#: T22 made that claim false, and the same discipline T16 applied to its own
#: stale "model not built" line applies here: a system that keeps asserting a
#: limitation it has since removed is as wrong as one that overclaims. What
#: replaces it is the measurement/estimate boundary - the thing an answer can
#: now actually get wrong.
TRAIN_IMPACT_FRAMING_FACT = Fact(
    id="framing:trainImpact",
    kind="model_framing",
    priority=TIER_ESSENTIAL,
    summary="How train-impact figures must be described.",
    data={
        "field": "deferredTask.displacementOption",
        "measured": (
            "The count of displaced services and the minutes of overlap - derived from "
            "T3's real ISL-wise timetable."
        ),
        "estimated": (
            "The CLASS SPLIT of those trains, apportioned from the corridor's overall "
            "train-class mix; the per-service class was not retained alongside the "
            "occupied windows."
        ),
        "framing": TRAIN_FRAMING,
        "mustNotSay": (
            "Do not describe displaced minutes as predicted passenger delay or as a "
            "modelled knock-on effect - this build has no delay-propagation model. Do "
            "not state the class of any individual displaced train."
        ),
    },
)


#: Attached to every context (T19).
#:
#: Replaces the pre-T19 "there is no approval workflow" gap, which the workflow
#: made false. What an answer about approvals can now get wrong is ATTRIBUTION:
#: this build has roles, not user accounts, so a sign-off is recorded as
#: `actorRole: "controller"` and there is no person to name. A model that
#: rendered that as a name would be inventing the single most quotable detail in
#: an audit trail.
APPROVAL_FRAMING_FACT = Fact(
    id="framing:approval",
    # NOT `model_framing`. The prompt attaches a "this came from a model trained
    # on simulated data" disclaimer to that kind, and an approval record is the
    # opposite of a model output - it is a stored fact about what a human role
    # did. Carrying it under the same kind would make the system disclaim its
    # own audit trail as simulated, which is a false statement in the humble
    # direction. It still renders beside the answer via `model_framings`.
    kind="workflow_framing",
    priority=TIER_ESSENTIAL,
    summary="How approval and audit facts must be described.",
    data={
        "field": "workflow.state / approval.actorRole",
        "states": "draft -> under_review -> approved -> published; reject ends it",
        "framing": (
            "The approval workflow records a ROLE, not a person - this prototype has no "
            "user accounts. Every sign-off is attributable to 'controller' or 'drm' and "
            "to a timestamp, and to nothing finer."
        ),
        "mustNotSay": (
            "Never name an individual as approver, and never describe a plan as approved "
            "or published unless workflow.state says so. A plan in state 'draft' has not "
            "been reviewed by anyone - say that plainly rather than declining to answer."
        ),
    },
)


def _workflow_fact(workflow: dict) -> Fact:
    """The plan's current place in the FR6.1 chain.

    Carried on EVERY context, not only when the question mentions approval. A
    Controller asking "why is TSK-00042 on Tuesday" is owed an answer that knows
    whether the plan they are looking at has been issued to anyone.

    The state arrives already folded by Node's own state machine rather than
    being re-derived here. The transition table lives in exactly one place, the
    same call D-046 made for the conflict taxonomy - a second implementation in
    a second language is a second thing to drift.
    """
    return Fact(
        id="plan:workflow",
        kind="approval_state",
        priority=TIER_ESSENTIAL,
        summary=f"This plan is {workflow.get('state', 'draft')} (FR6.1).",
        data={
            "state": workflow.get("state", "draft"),
            "publishedVersion": workflow.get("version"),
            "publishedAt": workflow.get("publishedAt"),
            "allowedActions": workflow.get("allowedActions"),
            "overridable": workflow.get("overridable"),
            "approvalRecordCount": workflow.get("approvalCount", 0),
        },
    )


def _approval_fact(approval: dict, *, priority: int = TIER_CONTEXT) -> Fact:
    """One workflow transition, as recorded.

    `validation.checks` is dropped: six pass/fail lines per approval is the
    largest thing in the record and carries no figure an answer needs - the
    count and the verdict do. `knownUnresolved` is KEPT, because what a
    signature accepted as still-open is the substance of the sign-off.
    """
    validation = approval.get("validation") or {}
    checks = validation.get("checks") or []
    return Fact(
        id=f"approval:{approval.get('_id', approval.get('action'))}",
        kind="approval_record",
        priority=priority,
        summary=(
            f"The plan was {approval.get('action')}ed by role "
            f"{approval.get('actorRole')}, moving it from {approval.get('fromState')} "
            f"to {approval.get('toState')}."
        ),
        data={
            "action": approval.get("action"),
            "fromState": approval.get("fromState"),
            "toState": approval.get("toState"),
            "actorRole": approval.get("actorRole"),
            "reason": approval.get("reason"),
            "createdAt": approval.get("createdAt"),
            "version": approval.get("version"),
            "revalidation": (
                {
                    "constraintsSatisfied": validation.get("constraintsSatisfied"),
                    "checksRun": len(checks),
                    "knownUnresolved": validation.get("knownUnresolved"),
                }
                if validation
                else None
            ),
        },
    )


# --------------------------------------------------------------------------- #
# Assembly                                                                     #
# --------------------------------------------------------------------------- #

def assemble_context(
    question: str,
    schedule: dict,
    *,
    tasks: Iterable[dict] = (),
    overrides: Iterable[dict] = (),
    approvals: Iterable[dict] = (),
    workflow: dict | None = None,
    entry_limit: int = DEFAULT_ENTRY_LIMIT,
    max_chars: int = MAX_CONTEXT_CHARS,
) -> GroundingContext:
    """Select the real records that could answer `question`.

    Pure: same inputs, same context, every time. This is the whole testable
    surface of the explanation layer - what the model is allowed to see is fixed
    here, before any API call, and an assertion about it is an assertion about
    what the model could possibly have said.

    Selection, in order:

      1. Tasks named in the question - their decision entry, stored record,
         block, conflicts and overrides.
      2. Corridors named in the question - the blocks on them.
      3. When nothing is named, a bounded slice of the plan: the highest-priority
         deferrals and the cross-department batches, which is what "why wasn't X
         done" and "what did the AI actually improve" need.
      4. Always: the plan summary, the plan's FR6.1 workflow state, the
         baseline comparison with its caveats, the train-impact and approval
         framings, and any topic caveats the question triggered.
    """
    log = schedule.get("decisionLog") or []
    blocks = schedule.get("blocks") or []
    task_records = {task["_id"]: task for task in tasks if task.get("_id")}
    override_records = list(overrides)
    conflicts = ((schedule.get("conflictReport") or {}).get("conflicts")) or []
    baseline_conflicts = (
        ((schedule.get("baseline") or {}).get("conflictReport") or {}).get("conflicts")
    ) or []

    references = extract_references(question)
    entries_by_task = {entry["taskId"]: entry for entry in log}

    known_tasks = [tid for tid in references["tasks"] if tid in entries_by_task]
    unknown = [tid for tid in references["tasks"] if tid not in entries_by_task]

    known_corridors = sorted(
        {cid for cid in references["corridors"] if any(b["corridorId"] == cid for b in blocks)}
    )
    unknown += [
        cid for cid in references["corridors"]
        if cid not in known_corridors and any(c.isdigit() for c in cid) is False
        and not any(entry.get("corridorId") == cid for entry in log)
    ]

    approval_records = list(approvals)

    facts: list[Fact] = [_plan_summary_fact(schedule)]
    comparison = _comparison_fact(schedule)
    if comparison:
        facts.append(comparison)
    facts.append(TRAIN_IMPACT_FRAMING_FACT)

    # The workflow state is essential context for ANY question, not only an
    # approval one: "why is this task on Tuesday" reads very differently
    # depending on whether Tuesday has been issued to a crew. When no workflow
    # block was supplied at all, the state is `draft` - which is what a plan
    # with no approval rows genuinely is, so the default is a fact rather than
    # a guess.
    facts.append(_workflow_fact({**(workflow or {}), "approvalCount": len(approval_records)}))

    # The attribution caveat rides along only when a sign-off is actually in
    # play - the question raised it, or this plan has been through the workflow.
    # Same rule as the risk framing, and for the same reason in reverse: an
    # unconditional caveat is not free. Adding it to every context pushed a
    # NAMED task's own override past the size budget, which is D-053's failure
    # exactly - a caveat displacing the evidence the question asked for.
    approval_in_question = any(_mentions(question, t) for t in APPROVAL_TRIGGERS)
    if approval_in_question or approval_records:
        facts.append(APPROVAL_FRAMING_FACT)

    # The risk framing rides along whenever risk is plausibly in play - either
    # the question raised it, or a task in scope carries a score. Attaching it
    # only on keyword match would leave an answer free to quote a risk number
    # unframed simply because the Controller asked "why is this urgent".
    risk_in_question = any(_mentions(question, trigger) for trigger in RISK_FRAMING_TRIGGERS)
    risk_in_scope = any(
        (task_records.get(tid) or {}).get("failureRiskScore") is not None
        for tid in references["tasks"]
    ) or any(
        (record or {}).get("failureRiskScore") is not None for record in task_records.values()
    )
    if risk_in_question or risk_in_scope:
        facts.append(RISK_MODEL_FRAMING_FACT)

    selected_tasks: list[str] = list(known_tasks)

    # 3. Nothing named - take a bounded, meaningful slice rather than the lot.
    if not selected_tasks and not known_corridors:
        deferred = sorted(
            (e for e in log if e["decision"] == "deferred"),
            key=lambda e: -(e["contributingFactors"].get("priorityScore") or 0),
        )
        batched = [
            e for e in log
            if e["decision"] == "scheduled"
            and e["contributingFactors"].get("isCrossDepartmentBatch")
        ]
        # Interleaved, not concatenated. The budget usually admits only the
        # first few slice entries, and a straight `deferred + batched` meant
        # "which tasks share a block across departments" was answered from a
        # context containing no batched task at all - the one thing it asked
        # about. Alternating keeps both kinds represented whatever the cut.
        selected_tasks = [
            entry["taskId"] for entry in _interleave(batched, deferred[:entry_limit])
        ]

    for corridor_id in known_corridors:
        for block in blocks:
            if block["corridorId"] == corridor_id:
                facts.append(_block_fact(block))
        selected_tasks += [
            e["taskId"] for e in log if e.get("corridorId") == corridor_id
        ][:entry_limit]

    seen: set[str] = set()
    for task_id in selected_tasks:
        if task_id in seen:
            continue
        seen.add(task_id)
        entry = entries_by_task.get(task_id)
        named = task_id in known_tasks
        if entry:
            facts.append(
                _decision_fact(
                    entry,
                    compact=not named,
                    priority=TIER_NAMED if named else TIER_CONTEXT,
                )
            )
        # The stored task record (defect type, asset, workflow stage) is only
        # worth its size for a task the question actually named.
        if named and task_id in task_records:
            facts.append(_task_fact(task_records[task_id]))
        if entry and entry.get("decision") == "scheduled" and task_id in known_tasks:
            for block in blocks:
                if task_id in (block.get("taskIds") or []):
                    facts.append(_block_fact(block))

    # Conflicts and overrides touching any selected task, from both plan layers.
    #
    # Tier follows whether the question NAMED the task, not merely whether the
    # task ended up in the slice. A conflict involving some task from the
    # bounded slice is perspective, and must not outrank the FR9.3 comparison
    # when the question was "how does this compare to the baseline".
    named_set = set(known_tasks)
    for conflict in conflicts + baseline_conflicts:
        touched = set(conflict.get("taskIds") or [])
        if seen & touched:
            facts.append(
                _conflict_fact(
                    conflict,
                    priority=TIER_NAMED if named_set & touched else TIER_CONTEXT,
                )
            )
    for override in override_records:
        task_id = override.get("taskId")
        if task_id in seen or not seen:
            facts.append(
                _override_fact(
                    override,
                    priority=TIER_NAMED if task_id in named_set else TIER_CONTEXT,
                )
            )

    # The approval history, always at TIER_NAMED - never keyword-gated.
    #
    # Gating it on the question was wrong twice over. It is unreliable: "Who
    # signed this off?" matches no trigger ("sign off" is not "signed this
    # off"), and the answer that came back was a DECLINE saying the role was not
    # in the data - directly contradicting the answer the same plan gave to
    # "who approved this?" a second earlier. A system that declines depending on
    # phrasing is worse than one that declines consistently, because a
    # Controller cannot tell which answer to believe.
    #
    # And it is unnecessary. The state machine bounds this list structurally:
    # the longest legal path is submit -> approve -> publish, so a plan can
    # never carry more than three rows, and the six pass/fail check lines are
    # already dropped from each. There is no unbounded case to protect against.
    for approval in approval_records:
        facts.append(_approval_fact(approval, priority=TIER_NAMED))

    # De-duplicate by id, preserving order.
    unique: dict[str, Fact] = {}
    for fact in facts:
        unique.setdefault(fact.id, fact)

    kept, omitted = _apply_budget(list(unique.values()), max_chars)

    return GroundingContext(
        question=question,
        facts=kept,
        unavailable=detect_unavailable_topics(question),
        resolved_references={"tasks": known_tasks, "corridors": known_corridors},
        unknown_references=sorted(set(unknown)),
        omitted_fact_count=omitted,
    )


def _interleave(first: list[dict], second: list[dict]) -> list[dict]:
    """Alternate two lists, exhausting whichever runs out last."""
    merged: list[dict] = []
    for index in range(max(len(first), len(second))):
        if index < len(first):
            merged.append(first[index])
        if index < len(second):
            merged.append(second[index])
    return merged


def _apply_budget(facts: list[Fact], max_chars: int) -> tuple[list[Fact], int]:
    """Trim to the character budget, keeping earlier (more relevant) facts.

    Facts are ranked by tier first, so what survives is evidence about what was
    actually asked, then the plan summary, then the baseline comparison, then
    the bounded slice - rather than whatever happened to be appended first.
    """
    kept: list[Fact] = []
    used = 0

    # Stable sort by tier: within a tier, assembly order (most relevant first)
    # is preserved.
    for fact in sorted(facts, key=lambda f: f.priority):
        size = len(json.dumps(fact.as_dict(), default=str))
        if kept and used + size > max_chars:
            break
        kept.append(fact)
        used += size

    return kept, len(facts) - len(kept)
