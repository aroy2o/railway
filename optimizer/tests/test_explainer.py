"""Ask the Planner's LLM layer - T18, PRD 9.2 / Section 18.

An LLM is the first component in this project that cannot be tested the usual
way. Everything else is a pure function: inject the bug, watch the test fail,
done. Here the same prompt can produce different words on different calls, so
"it answered correctly once" is close to no evidence at all.

The response is to put the guarantee somewhere deterministic. Three layers:

  1. `build_prompt` - pure. What the model is told is asserted exactly.
  2. `verify_answer` - pure. Given an answer, does every number in it appear in
     the grounding data? This is the runtime guard, and it is the thing that
     gets mutation-tested below: hand it a fabricated figure and it must fire.
  3. The live model - non-deterministic, tested separately in
     `test_explain_live.py`, which skips without an API key and never reports a
     pass it did not earn.

Nothing in this file needs an API key.
"""

from __future__ import annotations

import json

import pytest

from app.core.explainer import (
    SYSTEM_PROMPT,
    ExplainerUnavailable,
    Verification,
    _parse_model_output,
    build_prompt,
    explain,
    verify_answer,
)
from app.core.grounding import _normalise_number, assemble_context

from tests.test_grounding import TASKS, decision_entry  # noqa: F401  (fixture data)


@pytest.fixture
def context():
    schedule = {
        "horizonStart": "2026-08-24", "horizonDays": 7, "status": "OPTIMAL",
        "metrics": {"tasksScheduled": 36, "tasksDeferred": 53, "blocksUsed": 25,
                    "crossDepartmentBatches": 2, "blockUtilisationPct": 74.33},
        "decisionLog": [decision_entry("TSK-00001")],
        "blocks": [{"corridorId": "AAA-BBB", "date": "2026-08-28", "windowIndex": 2,
                    "start": "07:26", "end": "13:34", "capacityMinutes": 368,
                    "usedMinutes": 357, "taskIds": ["TSK-00001"], "trainImpact": None}],
    }
    return assemble_context("Why was TSK-00001 scheduled?", schedule, tasks=TASKS)


class StubClient:
    """Stands in for the Anthropic client. Only the network call is stubbed -
    the grounding, prompt and verification around it are all real."""

    def __init__(self, payload, *, raises=None):
        self.payload, self.raises, self.calls = payload, raises, []
        self.messages = self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.raises:
            raise self.raises
        text = self.payload if isinstance(self.payload, str) else json.dumps(self.payload)
        return type("Response", (), {"content": [type("Block", (), {"text": text})()]})()


# --------------------------------------------------------------------------- #
# The runtime guard - this is the load-bearing test in T18                     #
# --------------------------------------------------------------------------- #

def test_a_fabricated_number_is_caught(context):
    """The failure PRD Section 18 names, injected directly.

    "about 12 trains would be delayed" is exactly the shape of the dangerous
    answer: fluent, specific, plausible, and grounded in nothing. There is no
    12 anywhere in the context, and the verifier must say so."""
    verification = verify_answer(
        "This block would delay about 12 trains on the corridor.", context, []
    )

    assert verification.grounded is False
    assert "12" in verification.ungrounded_numbers


def test_a_real_number_from_the_records_passes(context):
    verification = verify_answer(
        "TSK-00001 was placed in the 07:26-13:34 window, which holds 368 minutes.",
        context, ["decision:TSK-00001"],
    )

    assert verification.grounded is True
    assert verification.ungrounded_numbers == []


def test_a_number_that_is_arithmetic_on_real_numbers_is_still_caught(context):
    """The subtle case. 368 and 357 are both in the data; 11 is their difference
    and is not. A model doing helpful mental arithmetic produces a figure no
    record contains, which is precisely what "never let the LLM invent numbers"
    forbids - even when the arithmetic is right."""
    verification = verify_answer("That leaves 11 minutes unused.", context, [])

    assert verification.grounded is False
    assert "11" in verification.ungrounded_numbers


def test_numbers_the_controller_supplied_are_not_treated_as_invented(context):
    """Echoing the asker is not fabricating. A question mentioning 14:00 must
    not make the answer's "14:00" a violation."""
    grounded = assemble_context("Why not run it at 14:00?", {"decisionLog": [], "metrics": {}})
    verification = verify_answer("Nothing is scheduled at 14:00.", grounded, [])

    assert verification.grounded is True


def test_a_cited_record_id_that_does_not_exist_is_caught(context):
    """A fabricated citation is as bad as a fabricated number: it makes an
    unsupported answer look auditable."""
    verification = verify_answer("It was scheduled.", context, ["decision:TSK-99999"])

    assert verification.grounded is False
    assert verification.unknown_record_ids == ["decision:TSK-99999"]


def test_prose_numbers_do_not_raise_false_alarms(context):
    """"both tasks", "the first reason" - flagging these would produce noise
    that teaches a reader to ignore the flag entirely."""
    verification = verify_answer("There are 2 reasons, and 1 of them is capacity.", context, [])

    assert verification.grounded is True


# --------------------------------------------------------------------------- #
# The prompt                                                                   #
# --------------------------------------------------------------------------- #

def test_the_prompt_states_the_absolute_rule():
    assert "ABSOLUTE RULE" in SYSTEM_PROMPT
    assert "not in the grounding data" in SYSTEM_PROMPT


def test_the_prompt_contains_only_context_facts(context):
    prompt = build_prompt(context)

    assert "GROUNDING DATA" in prompt
    for fact in context.facts:
        assert fact.id in prompt


def test_unavailable_topics_reach_the_prompt():
    """Uses what-if, not approvals: T19 built the approval workflow, so
    "who approved this" is now an ANSWERABLE question and would carry no
    unavailable topic at all. A test that keeps a filled gap as its example of
    an empty one silently stops testing anything."""
    schedule = {"decisionLog": [], "blocks": [], "metrics": {}}
    context = assemble_context("What if I moved this task to Thursday?", schedule)
    prompt = build_prompt(context)

    assert "UNAVAILABLE" in prompt
    assert "T20" in prompt


def test_unknown_ids_reach_the_prompt():
    schedule = {"decisionLog": [decision_entry("TSK-00001")], "blocks": [], "metrics": {}}
    context = assemble_context("What about TSK-77777?", schedule)

    assert "TSK-77777" in build_prompt(context)


# --------------------------------------------------------------------------- #
# Model output handling                                                        #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("raw", [
    '{"answer": "It fits.", "recordIds": ["decision:TSK-00001"], "answered": true}',
    '```json\n{"answer": "It fits.", "recordIds": ["decision:TSK-00001"], "answered": true}\n```',
    'Here you go:\n{"answer": "It fits.", "recordIds": ["decision:TSK-00001"], "answered": true}',
])
def test_json_output_is_parsed_through_common_wrappings(raw):
    answer, ids, answered = _parse_model_output(raw)

    assert answer == "It fits."
    assert ids == ["decision:TSK-00001"]
    assert answered is True


def test_unparseable_output_keeps_the_answer_rather_than_erroring():
    """Losing the citation list is bad; showing an error when real text came
    back is worse. The verifier still checks the prose either way."""
    answer, ids, answered = _parse_model_output("It was scheduled because it fits.")

    assert answer == "It was scheduled because it fits."
    assert ids == []


def test_explain_verifies_the_model_reply_it_receives(context):
    """End to end with the network stubbed: a fluent, fabricated answer must
    come back marked ungrounded rather than being passed along."""
    client = StubClient({"answer": "It will delay 47 express trains by 312 minutes.",
                         "recordIds": [], "answered": True})

    explanation = explain(context, api_key="", model="test-model", client=client)

    assert explanation.answered is True
    assert explanation.verification.grounded is False
    assert explanation.verification.ungrounded_numbers == ["47", "312"]


def test_a_month_number_in_a_date_does_not_whitelist_that_integer(context):
    """Regression, and the reason `numbers()` treats ISO dates specially.

    The fixture has an SLA date of 2026-09-18. Splitting that into 2026/9/18
    put "9" in the allowed set, so "9 express trains" - pure fabrication -
    verified clean. Months are always 1-12, so this quietly whitelisted a small
    integer on essentially every schedule."""
    verification = verify_answer("It will delay 9 express trains.", context, [])

    assert verification.grounded is False
    assert "9" in verification.ungrounded_numbers


def test_a_real_date_quoted_in_full_is_not_flagged(context):
    """Regression from a live run (D-054).

    `numbers()` withholds the MONTH of a stored date on purpose - months are
    1-12 and would whitelist a small integer on every schedule. But the answer
    scanner was still splitting the model's `2026-09-18` into 2026/9/18, so a
    model quoting the SLA date correctly was accused of inventing "9". Dates are
    now checked whole, on both sides."""
    verification = verify_answer(
        "It is still within its SLA due date of 2026-09-18.", context, []
    )

    assert verification.grounded, verification.ungrounded_numbers


def test_a_date_that_is_not_in_the_records_is_still_caught(context):
    """The above must not become a blanket exemption for dates."""
    verification = verify_answer("It runs on 2099-01-01.", context, [])

    assert verification.grounded is False
    assert "2099-01-01" in verification.ungrounded_numbers


def test_a_thousands_separator_does_not_split_a_real_number(context):
    """Regression from a live run (D-054). The model wrote the real figure
    4,880 and the scanner read it as "4" and "880", reporting 880 as invented.
    A verifier that cries wolf on true statements teaches a reader to ignore
    it, which costs more than the check is worth."""
    grounded = assemble_context(
        "How does this compare?",
        {"decisionLog": [], "blocks": [], "metrics": {"blockMinutesUsed": 4880}},
    )
    verification = verify_answer("Both use 4,880 block minutes.", grounded, [])

    assert verification.grounded, verification.ungrounded_numbers


def test_typographic_dashes_are_folded_before_matching(context):
    """Models write U+2011 in "train‑impact". Every literal comparison
    downstream misses it unless it is normalised first."""
    from app.core.explainer import normalise_text

    assert "train-impact" in normalise_text("no train\u2011impact data")


def test_the_verifier_is_a_net_not_a_proof(context):
    """Stated as a test so the limit is documented where it cannot rot.

    A fabricated number that happens to equal a real value elsewhere in the
    context passes. 368 is the block capacity; "368 trains" is nonsense and is
    NOT caught. The verifier catches distinctive invented quantities, which is
    the common failure - it does not certify that an answer is true."""
    verification = verify_answer("It affects 368 trains.", context, [])

    assert verification.grounded is True, (
        "documents a known blind spot - if this ever fails the verifier got "
        "stronger, which is fine: update the note in D-050 and delete this test"
    )


def test_citing_a_record_id_is_not_reported_as_inventing_a_number(context):
    """D-059, found on a live run. Record ids carry a 17-digit timestamp run
    that no fact's DATA contains, so a model that cited its sources exactly as
    instructed was accused of fabricating figures. Whether a cited id exists is
    already checked separately and exactly."""
    cited = context.record_ids[0]
    verification = verify_answer(
        f"The plan was approved (see {cited}).", context, [cited]
    )

    assert verification.grounded is True
    assert verification.ungrounded_numbers == []

    # And the bare record id, which is what a model actually writes in prose -
    # it cites `APR-...-approve`, not the `approval:` fact-id prefix.
    bare = verify_answer(
        "Approved per APR-20260824025855658-approve and published as "
        "APR-20260824025909017-publish.",
        context,
        [],
    )
    assert bare.ungrounded_numbers == []

    # A distinctive invented quantity is still caught - the strip is narrow.
    invented = verify_answer("It affects 987654 trains.", context, [])
    assert invented.ungrounded_numbers == ["987654"]


def test_quoting_the_moment_of_sign_off_is_not_reported_as_inventing_a_number():
    """D-059's second half. `2026-08-24T02:59:09.017Z` is one fact, not the
    quantities 2, 59, 9 and 17 - and a date-only strip left the clock behind.
    Fourth instance of the shape where the checker was wrong and the model was
    right, which is the failure that matters most: a verifier that cries wolf
    trains a Controller to ignore the flag that is real."""
    schedule = {"decisionLog": [], "blocks": [], "metrics": {}}
    context = assemble_context(
        "When was this published?", schedule,
        approvals=[{
            "_id": "APR-1", "action": "publish", "fromState": "approved",
            "toState": "published", "reason": "", "actorRole": "controller",
            "validation": None, "version": 1,
            "createdAt": "2026-08-24T02:59:09.017Z",
        }],
        workflow={"state": "published", "version": 1},
    )

    verification = verify_answer(
        "It was published at 2026-08-24T02:59:09.017Z by the controller role.",
        context, [],
    )
    assert verification.ungrounded_numbers == []

    # A timestamp that is NOT in the records is still caught, as a timestamp.
    invented = verify_answer("It was published at 2026-01-02T03:04:05.678Z.", context, [])
    assert invented.ungrounded_numbers == ["2026-01-02T03:04:05.678Z"]


def test_clock_components_of_a_stored_timestamp_do_not_whitelist_small_integers():
    """The reason timestamps are stripped rather than decomposed. If `09` from a
    sign-off time entered the allowed set, a fabricated "9 trains" would clear
    on any plan approved at nine minutes past - the same false clearance the
    month rule exists to prevent."""
    schedule = {"decisionLog": [], "blocks": [], "metrics": {}}
    context = assemble_context(
        "anything", schedule,
        approvals=[{
            "_id": "APR-1", "action": "approve", "fromState": "under_review",
            "toState": "approved", "reason": "", "actorRole": "controller",
            "validation": None, "version": None,
            "createdAt": "2026-08-24T02:59:09.017Z",
        }],
    )
    numbers = context.numbers()

    assert "2026" in numbers and "24" in numbers, "the year and day stay quotable"
    assert "59" not in numbers
    assert "9" not in numbers


def test_a_seventeen_digit_number_survives_normalisation_intact():
    """Above 2**53 a float cannot hold an integer exactly, so the same value
    normalised differently depending on which side of the check it came from."""
    assert _normalise_number("20260824025855658") == "20260824025855658"
    assert _normalise_number("20260824025855658") != _normalise_number("20260824025855656")


def test_a_declined_answer_is_reported_as_declined(context):
    client = StubClient({"answer": "This system cannot simulate what-if scenarios (T20).",
                         "recordIds": ["plan:summary"], "answered": False})

    explanation = explain(context, api_key="", model="test-model", client=client)

    assert explanation.answered is False
    assert explanation.verification.grounded is True


# --------------------------------------------------------------------------- #
# Failure modes (D-037 standard: actionable, not generic)                      #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("provider,expected_key", [
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("groq", "GROQ_API_KEY"),
])
def test_a_missing_api_key_names_the_right_variable(provider, expected_key, context):
    """The message has to name the variable actually being read, or it sends a
    Controller to configure the wrong one."""
    with pytest.raises(ExplainerUnavailable) as exc:
        explain(context, api_key="", model="test-model", provider=provider)

    assert expected_key in str(exc.value)
    assert "decision log" in str(exc.value)


def test_an_unknown_provider_is_refused_by_name(context):
    with pytest.raises(ExplainerUnavailable) as exc:
        explain(context, api_key="k", model="m", provider="notaprovider")

    assert "notaprovider" in str(exc.value)
    assert "anthropic" in str(exc.value) and "groq" in str(exc.value)


def test_the_model_field_records_which_provider_answered(context):
    """Two providers give different answers to the same prompt. An audit that
    cannot tell which one produced a reply is missing the first thing you would
    want to know about it."""
    client = StubClient({"answer": "ok", "recordIds": [], "answered": True})

    explanation = explain(
        context, api_key="", model="gpt-oss-120b", provider="groq", client=client
    )

    assert explanation.model == "groq:gpt-oss-120b"


def test_an_api_error_is_reported_without_leaking_internals(context):
    client = StubClient(None, raises=ConnectionError("connect: 10.0.0.1:443 refused"))

    with pytest.raises(ExplainerUnavailable) as exc:
        explain(context, api_key="k", model="test-model", client=client)

    message = str(exc.value)
    assert "ConnectionError" in message
    assert "10.0.0.1" not in message, "the upstream address must not reach a Controller"


def test_verification_reports_its_own_meaning():
    assert "inspect before trusting" in Verification().as_dict()["note"]
