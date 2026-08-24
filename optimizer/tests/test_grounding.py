"""The grounding contract - T18, PRD 9.2 / Section 18.

This is where "the LLM must never invent a number" is actually enforced, and it
is enforced *before* the model is involved: `assemble_context` is a pure
function, so a test can state exactly what the model was permitted to see.

That matters more here than anywhere else in this project. Every other component
is deterministic, so one passing run is evidence. An LLM's output is not, so a
single good answer proves very little. The strategy is therefore to make the
deterministic half carry the guarantee: what goes in is fully asserted here, and
what comes out is checked by `verify_answer` (see test_explainer.py). Neither
test needs an API key, and neither depends on the model behaving well.
"""

from __future__ import annotations

import pytest

from app.core.grounding import (
    DEFAULT_ENTRY_LIMIT,
    assemble_context,
    detect_unavailable_topics,
    extract_references,
)


def decision_entry(task_id, decision="scheduled", **overrides):
    factors = {
        "priority": 40,
        "priorityScore": 39.75,
        "priorityIsPlaceholder": False,
        "dominantPriorityFactor": "severity",
        "priorityBreakdown": {"contributions": {"severity": 28.0}, "isOverdue": False},
        "durationMinutes": 120,
        "slaDueDate": "2026-09-18",
        "eligibleWindowsConsidered": 7,
        "isCrossDepartmentBatch": False,
        "sharedWith": [],
    }
    factors.update(overrides.pop("contributingFactors", {}))
    entry = {
        "taskId": task_id,
        "decision": decision,
        "department": "TRD",
        "corridorId": "AAA-BBB",
        "conflictTypes": [],
        "contributingFactors": factors,
    }
    if decision == "scheduled":
        entry.update({"date": "2026-08-28", "window": "07:26-13:34", "windowIndex": 2})
    else:
        entry.update({"reason": "EXCEEDS_LONGEST_WINDOW", "detail": "needs 500 min"})
    entry.update(overrides)
    return entry


@pytest.fixture
def schedule():
    return {
        "horizonStart": "2026-08-24",
        "horizonDays": 7,
        "status": "OPTIMAL",
        "metrics": {
            "tasksScheduled": 2, "tasksDeferred": 1, "blocksUsed": 1,
            "crossDepartmentBatches": 1, "blockMinutesUsed": 180,
            "blockMinutesCapacity": 240, "blockUtilisationPct": 75.0,
        },
        "decisionLog": [
            decision_entry("TSK-00001"),
            decision_entry("TSK-00002", contributingFactors={"isCrossDepartmentBatch": True}),
            decision_entry("TSK-00003", decision="deferred"),
        ],
        "blocks": [{
            "corridorId": "AAA-BBB", "date": "2026-08-28", "windowIndex": 2,
            "start": "07:26", "end": "13:34", "capacityMinutes": 368,
            "usedMinutes": 357, "taskIds": ["TSK-00001", "TSK-00002"],
            "departments": ["TRD", "S&T"], "isCrossDepartmentBatch": True,
            "trainImpact": None,
        }],
        "comparisonToBaseline": {
            "optimized": {"doubleBookings": 0, "blockUtilisationPct": 74.33},
            "baseline": {"doubleBookings": 6, "blockUtilisationPct": 77.01},
            "contestableTaskCount": 36,
            "structurallyImpossibleCount": 53,
            "caveats": ["Counts are drawn from the structurally contestable subset."],
        },
        "conflictReport": {
            "conflicts": [{
                "type": "RESOURCE_CONTENTION", "plan": "optimized",
                "taskIds": ["TSK-00001", "TSK-00002"], "corridorId": "AAA-BBB",
                "date": "2026-08-28", "departments": ["TRD", "S&T"],
                "detail": "both need RES-tamper",
                "resolution": {"strategy": "Stagger", "enforcedBy": "T25"},
            }],
        },
    }


TASKS = [{
    "_id": "TSK-00001", "corridorId": "AAA-BBB", "assetId": "AST-1",
    "department": "TRD", "defectType": "OHE dropper wear", "severity": 4,
    "workflowStage": "repair", "status": "open", "slaDueDate": "2026-09-18",
    "dateRaised": "2026-07-01", "estBlockDurationMins": 120,
    "priorityScore": 39.75, "dominantPriorityFactor": "severity",
    "failureRiskScore": None,
}]


# --------------------------------------------------------------------------- #
# Determinism - the property everything else here relies on                    #
# --------------------------------------------------------------------------- #

def test_assembly_is_deterministic(schedule):
    """Same question, same records, same context - every time.

    Without this, no assertion about "what the model was allowed to see" means
    anything, because it could differ on the call that mattered."""
    first = assemble_context("Why was TSK-00001 scheduled?", schedule, tasks=TASKS)
    second = assemble_context("Why was TSK-00001 scheduled?", schedule, tasks=TASKS)

    assert first.as_dict() == second.as_dict()


# --------------------------------------------------------------------------- #
# What gets selected                                                           #
# --------------------------------------------------------------------------- #

def test_naming_a_task_pulls_its_whole_record_set(schedule):
    context = assemble_context("Why was TSK-00001 scheduled?", schedule, tasks=TASKS)

    assert "decision:TSK-00001" in context.record_ids
    assert "task:TSK-00001" in context.record_ids
    assert "block:AAA-BBB:2026-08-28:2" in context.record_ids
    assert any(rid.startswith("conflict:RESOURCE_CONTENTION") for rid in context.record_ids)
    assert context.resolved_references["tasks"] == ["TSK-00001"]


def test_an_unknown_task_id_is_reported_not_invented(schedule):
    """The single most tempting fabrication: a plausible answer about a task
    that is not in the plan. The context must make its absence explicit."""
    context = assemble_context("What happened to TSK-99999?", schedule, tasks=TASKS)

    assert context.unknown_references == ["TSK-99999"]
    assert not any("99999" in rid for rid in context.record_ids)


def test_a_question_naming_nothing_gets_a_bounded_meaningful_slice(schedule):
    """"Why wasn't the relay fault fixed this week?" names no id. The context
    must still contain the deferrals and the batches, and must stay bounded."""
    context = assemble_context("What did the AI improve?", schedule, tasks=TASKS)

    kinds = [fact.kind for fact in context.facts]
    assert "decision_log_entry" in kinds
    assert "baseline_comparison" in kinds
    assert len([k for k in kinds if k == "decision_log_entry"]) <= DEFAULT_ENTRY_LIMIT + 5


def test_the_comparison_carries_its_caveats_with_its_numbers(schedule):
    """D-031: the baseline's utilisation reads HIGHER. Handing the model those
    two percentages without the caveats invites "utilisation improved", which
    is false. The caveats travel in the same fact."""
    context = assemble_context("How does this compare to the baseline?", schedule)
    fact = next(f for f in context.facts if f.kind == "baseline_comparison")

    assert fact.data["caveats"]
    assert fact.data["baseline"]["blockUtilisationPct"] > fact.data["optimized"]["blockUtilisationPct"]


def test_the_train_impact_framing_is_always_stated(schedule):
    """T22 replaced the "no train-impact data exists" gap fact - that claim
    became false. What every context now carries instead is the boundary between
    what is measured and what is apportioned, which is the thing an answer can
    now get wrong."""
    context = assemble_context("Why was TSK-00001 scheduled?", schedule, tasks=TASKS)
    fact = next(f for f in context.facts if f.id == "framing:trainImpact")

    assert "measured" in fact.data and "estimated" in fact.data
    assert "CLASS SPLIT" in fact.data["estimated"]
    assert "delay-propagation model" in fact.data["mustNotSay"]
    assert not any(f.id == "gap:trainImpact" for f in context.facts)


def test_overrides_are_included_so_the_current_plan_can_be_described(schedule):
    """D-043: the decision log records where the SOLVER put a task, not where it
    is now. Answering "when does TSK-00001 run?" from the log alone would give a
    time the plan no longer contains, so overrides must be in the context."""
    override = {"_id": "OVR-1", "taskId": "TSK-00001", "toAssignment": {"date": "2026-08-30"}}
    context = assemble_context(
        "When does TSK-00001 run?", schedule, tasks=TASKS, overrides=[override]
    )

    assert "override:OVR-1" in context.record_ids


def test_provenance_is_carried_in_every_context(schedule):
    context = assemble_context("anything at all", schedule)

    assert "SYNTHETIC" in context.provenance_note


# --------------------------------------------------------------------------- #
# Honest refusal                                                               #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize(
    "question,expected",
    [
        ("What if I moved TSK-00001 to Thursday?", "what-if simulation"),
        ("Can I change the weights with a policy slider?", "policy weighting"),
        ("Will monsoon affect this corridor?", "weather and season"),
    ],
)
def test_questions_about_missing_capabilities_are_flagged(question, expected):
    topics = [topic.topic for topic in detect_unavailable_topics(question)]

    assert expected in topics


APPROVALS = [
    {
        "_id": "APR-1", "action": "submit", "fromState": "draft",
        "toState": "under_review", "reason": "", "actorRole": "controller",
        "validation": None, "version": None, "createdAt": "2026-08-24T10:00:00Z",
    },
    {
        "_id": "APR-2", "action": "approve", "fromState": "under_review",
        "toState": "approved", "reason": "Night windows agreed with operations",
        "actorRole": "controller", "version": None,
        "createdAt": "2026-08-24T11:00:00Z",
        "validation": {
            "constraintsSatisfied": True,
            "checks": [{"check": "no-window-over-capacity", "passed": True, "detail": "x"}],
            "knownUnresolved": [{"type": "RESOURCE_DOUBLE_BOOKING", "count": 11}],
        },
    },
    {
        "_id": "APR-3", "action": "publish", "fromState": "approved",
        "toState": "published", "reason": "", "actorRole": "drm",
        "validation": None, "version": 3, "createdAt": "2026-08-24T12:00:00Z",
    },
]

PUBLISHED_WORKFLOW = {
    "state": "published", "version": 3, "publishedAt": "2026-08-24T12:00:00Z",
    "allowedActions": [], "overridable": False,
}


def test_approval_questions_are_answerable_now_and_carry_the_attribution_framing(schedule):
    """T19 built the workflow, so "there is no approval workflow" became false -
    and, exactly as with T16's risk model and T22's train impact, a new caveat
    took its place. What an approval answer can now get wrong is ATTRIBUTION:
    this build has roles, not user accounts."""
    assert detect_unavailable_topics("Who approved this plan?") == []
    assert detect_unavailable_topics("Who signed off on the Tuesday block?") == []

    context = assemble_context(
        "Who approved this plan?", schedule,
        approvals=APPROVALS, workflow=PUBLISHED_WORKFLOW,
    )
    fact = next(f for f in context.facts if f.id == "framing:approval")

    assert "ROLE, not a person" in fact.data["framing"]
    assert "no user accounts" in fact.data["framing"]
    assert "Never name an individual as approver" in fact.data["mustNotSay"]


def test_the_approval_framing_is_not_a_model_framing(schedule):
    """The prompt attaches a "trained on simulated data" disclaimer to facts of
    kind `model_framing`. An approval record is a stored fact about what a human
    role did, so carrying it under that kind would make the system disclaim its
    own audit trail as simulated - false, in the humble direction."""
    context = assemble_context(
        "Who approved this?", schedule, approvals=APPROVALS, workflow=PUBLISHED_WORKFLOW,
    )
    fact = next(f for f in context.facts if f.id == "framing:approval")

    assert fact.kind == "workflow_framing"
    # It still reaches the UI, which renders framings whatever the model said.
    assert "framing:approval" in [entry["factId"] for entry in context.model_framings()]


def test_an_unapproved_plan_states_that_honestly_rather_than_declining(schedule):
    """The "not yet approved" case is the one most likely to be answered badly.
    It is not a missing-data refusal and it is not an approval - it is a state,
    and the context has to carry it as a fact so the answer can be "nobody has,
    it is still a draft"."""
    context = assemble_context("Who approved this plan?", schedule)
    fact = next(f for f in context.facts if f.id == "plan:workflow")

    assert fact.data["state"] == "draft"
    assert fact.data["approvalRecordCount"] == 0
    assert fact.data["publishedVersion"] is None
    # No approval rows exist, so there is nothing for the model to mistake for one.
    assert [f for f in context.facts if f.kind == "approval_record"] == []


def test_the_workflow_state_rides_on_every_context_not_only_approval_questions(schedule):
    """"Why is TSK-00001 on Tuesday" reads very differently depending on whether
    Tuesday has been issued to a crew."""
    context = assemble_context("Why was TSK-00001 scheduled then?", schedule,
                               workflow=PUBLISHED_WORKFLOW)
    fact = next(f for f in context.facts if f.id == "plan:workflow")

    assert fact.data["state"] == "published"
    assert fact.data["publishedVersion"] == 3
    assert fact.data["overridable"] is False


@pytest.mark.parametrize("question", [
    "Who signed off on this and when was it published?",
    # Matches no keyword trigger. On a live run this phrasing produced a
    # DECLINE claiming the role was not in the data, one second after the same
    # plan answered "who approved this?" correctly. Approval rows are no longer
    # keyword-gated at all - the state machine bounds them to three.
    "Who signed this off?",
    "Why is this plan the way it is?",
])
def test_approval_records_survive_the_budget_whatever_the_phrasing(schedule, question):
    """D-053's rule applied to a third kind of evidence: a context that dropped
    the sign-off rows and then answered "who approved this" would produce a
    confident wrong answer wearing an honest one's costume."""
    context = assemble_context(
        question, schedule,
        tasks=TASKS, approvals=APPROVALS, workflow=PUBLISHED_WORKFLOW,
    )

    assert {"approval:APR-1", "approval:APR-2", "approval:APR-3"} <= set(context.record_ids)
    approve = next(f for f in context.facts if f.id == "approval:APR-2")
    assert approve.data["actorRole"] == "controller"
    assert approve.data["reason"] == "Night windows agreed with operations"
    # What a signature accepted as still-open is the substance of the sign-off.
    assert approve.data["revalidation"]["knownUnresolved"] == [
        {"type": "RESOURCE_DOUBLE_BOOKING", "count": 11}
    ]
    # The six pass/fail lines are the largest part of the record and carry no
    # figure an answer needs; the count and the verdict do.
    assert "checks" not in approve.data["revalidation"]
    assert approve.data["revalidation"]["checksRun"] == 1


def test_the_published_version_number_is_quotable(schedule):
    """FR6.3's version is the kind of small integer a model would otherwise have
    to invent, so it has to be IN the grounding numbers, not merely implied."""
    context = assemble_context(
        "Which version is published?", schedule,
        approvals=APPROVALS, workflow=PUBLISHED_WORKFLOW,
    )

    assert "3" in context.numbers()


def test_risk_questions_are_answerable_now_but_carry_the_prd_91_framing(schedule):
    """T16 built the model, so "we cannot answer that" became false - and a new
    caveat took its place. The score is real and quotable; describing it as a
    forecast of real failures is what PRD Section 6 NG4 forbids. The framing
    therefore travels as a FACT, not as an unavailable-topic refusal."""
    assert detect_unavailable_topics("What's the failure risk on this asset?") == []

    tasks = [{**TASKS[0], "failureRiskScore": 71.4}]
    context = assemble_context("What is the failure risk here?", schedule, tasks=tasks)
    fact = next(f for f in context.facts if f.id == "framing:riskModel")

    assert "simulated" in fact.data["framing"].lower()
    assert "does not predict real" in fact.data["framing"].lower()
    assert "Do not describe this as predicting a real failure" in fact.data["mustNotSay"]


def test_the_risk_framing_attaches_even_when_the_question_never_says_risk(schedule):
    """"Why is this task urgent" can be answered with a risk figure. The caveat
    cannot depend on the Controller having used the word."""
    tasks = [{**TASKS[0], "failureRiskScore": 71.4}]
    context = assemble_context("Why is TSK-00001 so urgent?", schedule, tasks=tasks)

    assert "framing:riskModel" in context.record_ids


def test_unavailable_topics_name_the_task_that_would_provide_them():
    """A refusal that says "not supported" is weak. One that says "train-impact
    scoring is T22" is a roadmap answer a judge can follow."""
    for topic in detect_unavailable_topics("what if policy monsoon"):
        assert topic.blocked_on
        assert topic.reason


def test_a_plain_scheduling_question_triggers_no_caveat():
    """False caveats are not free: they tell the model data is missing when it
    is not, which is a route to a wrongly-declined answer."""
    assert detect_unavailable_topics("Why was TSK-00004 scheduled on the 28th?") == []


def test_train_does_not_trigger_the_weather_caveat_via_rain():
    """Regression: substring matching read "t-RAIN" as a weather question.

    Since T22 the train-impact topic is gone entirely (the system can answer
    those now), so this asserts only the thing that could still break."""
    topics = [t.topic for t in detect_unavailable_topics("Which train uses this corridor?")]

    assert "weather and season" not in topics


# --------------------------------------------------------------------------- #
# Reference extraction                                                         #
# --------------------------------------------------------------------------- #

def test_reference_extraction_finds_ids_in_ordinary_prose():
    refs = extract_references("why is tsk-00042 on BBPR-SYU and not MQX-RMF?")

    assert refs["tasks"] == ["TSK-00042"]
    assert refs["corridors"] == ["BBPR-SYU", "MQX-RMF"]


def test_the_allowed_number_set_covers_nested_values(schedule):
    """`numbers()` is what the runtime verifier checks answers against, so a
    value it misses becomes a false accusation of fabrication."""
    context = assemble_context("Why was TSK-00001 scheduled?", schedule, tasks=TASKS)
    allowed = context.numbers()

    assert "39.75" in allowed          # nested in contributingFactors
    assert "368" in allowed            # nested in the block
    assert "28" in allowed             # inside the date string 2026-08-28
    assert "28" in allowed and "2026" in allowed
