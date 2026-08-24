"""Ask the Planner against the real Claude API - T18.

Everything in `test_grounding.py` and `test_explainer.py` is deterministic and
proves what the model was ALLOWED to say. This file is the only place that
checks what it actually says, and it is built around one admission: a single
successful call proves almost nothing about a non-deterministic system.

So each behaviour is exercised across several *phrasings* and several
*repetitions*, and the assertion is on the whole set, not on any one reply. A
model that gets it right four times out of five fails here, which is the point -
"usually grounded" is not a property worth claiming to a judge.

These tests SKIP when the configured provider has no API key. They never pass
without running: a skip is reported as a skip, so an empty key can never be
mistaken for a verified explanation layer.

Calls are paced. Every model on the current key allows 30 requests per minute,
and a suite that trips the limit reports a rate-limit failure indistinguishable
from a grounding failure.

Run explicitly:  pytest -m live tests/test_explain_live.py -v
"""

from __future__ import annotations

import json
import pathlib
import time

import pytest

from app.config import get_settings
from app.core.explainer import explain, normalise_text
from app.core.grounding import assemble_context

pytestmark = pytest.mark.live

#: Each question is asked this many times. Enough to expose a model that is
#: only sometimes grounded; small enough to stay inside the daily allowance.
REPETITIONS = 3

#: Paced on TOKENS, not requests, because that is the binding limit.
#:
#: A grounded prompt measures ~1,750 tokens after the T18 size budget, plus
#: ~400 for the answer. Against gpt-oss-120b's 8,000 tokens/minute that is
#: ~3.7 calls a minute, so 17s between calls.
#:
#: Measured, not estimated twice over: the char/4 rule undercounted tokens by
#: 3x, and pacing on the 30-requests/minute headline figure tripped the TOKEN
#: limit after seven calls. A rate-limit failure is indistinguishable from a
#: grounding failure in the report, which makes under-pacing worse than slow.
CALL_INTERVAL_SECONDS = 17.0

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "schedule_snapshot.json"


def _api_key() -> str:
    return get_settings().explain_api_key.strip()


@pytest.fixture(scope="module")
def records():
    settings = get_settings()
    if not _api_key():
        pytest.skip(
            f"no API key for provider {settings.llm_provider!r} - "
            "the live explanation layer is unverified"
        )
    if not FIXTURE.exists():
        pytest.skip(f"no schedule snapshot at {FIXTURE}; run scripts/snapshot_schedule.py")
    payload = json.loads(FIXTURE.read_text())
    return payload["schedule"], payload.get("tasks", []), payload.get("overrides", [])


def _ask(question, records):
    settings = get_settings()
    schedule, tasks, overrides = records
    context = assemble_context(question, schedule, tasks=tasks, overrides=overrides)
    explanation = explain(
        context,
        provider=settings.llm_provider,
        api_key=_api_key(),
        model=settings.explain_model,
        max_tokens=settings.explain_max_tokens,
    )
    time.sleep(CALL_INTERVAL_SECONDS)
    return context, explanation


ANSWERABLE = [
    "Why was TSK-00004 scheduled when it was?",
    "What happened to TSK-00009?",
    "How does this plan compare to the naive baseline?",
    "Which tasks are sharing a block across departments, and why?",
]

UNANSWERABLE = [
    "How many trains will be delayed by the Friday block?",
    "What is the probability this asset fails before the next inspection?",
    "Who approved this schedule?",
    "What if I moved TSK-00004 to Thursday instead?",
]


def test_answerable_questions_are_grounded_across_repeats(records):
    """Every number in every reply must trace to a real record - not most."""
    failures = []
    for question in ANSWERABLE:
        for attempt in range(REPETITIONS):
            _, explanation = _ask(question, records)
            if not explanation.verification.grounded:
                failures.append({
                    "question": question, "attempt": attempt,
                    "ungrounded": explanation.verification.ungrounded_numbers,
                    "unknownIds": explanation.verification.unknown_record_ids,
                    "answer": explanation.answer,
                })

    assert not failures, (
        f"{len(failures)}/{len(ANSWERABLE) * REPETITIONS} replies contained ungrounded "
        f"content:\n{json.dumps(failures, indent=2)}"
    )


def test_answerable_questions_actually_answer(records):
    """Grounded-but-declining would pass the test above while being useless."""
    declined = [
        question
        for question in ANSWERABLE
        if not _ask(question, records)[1].answered
    ]

    assert not declined, f"declined questions the data can answer: {declined}"


def test_answers_cite_records_that_exist(records):
    for question in ANSWERABLE:
        context, explanation = _ask(question, records)
        assert explanation.grounded_in, f"no records cited for {question!r}"
        assert not set(explanation.grounded_in) - set(context.record_ids)


def test_out_of_scope_questions_are_declined_across_repeats(records):
    """The behaviour PRD Section 18 cares about most.

    A confident wrong answer about train delay is worse than no answer, because
    it is the one a judge will check. Declining must be reliable, not typical."""
    failures = []
    for question in UNANSWERABLE:
        for attempt in range(REPETITIONS):
            _, explanation = _ask(question, records)
            if explanation.answered or not explanation.verification.grounded:
                failures.append({
                    "question": question, "attempt": attempt,
                    "answered": explanation.answered,
                    "ungrounded": explanation.verification.ungrounded_numbers,
                    "answer": explanation.answer,
                })

    assert not failures, (
        f"{len(failures)}/{len(UNANSWERABLE) * REPETITIONS} out-of-scope replies did not "
        f"decline cleanly:\n{json.dumps(failures, indent=2)}"
    )


def test_declines_name_what_is_missing(records):
    """"I don't know" is weak; "this build has no train-impact model (T22)" is
    an answer a Controller can act on and a judge can follow."""
    _, explanation = _ask("How many trains will the Friday block delay?", records)

    # Normalised first: the model writes "train‑impact" with U+2011, which no
    # ASCII comparison matches. That cost a false failure on the first live run.
    answer = normalise_text(explanation.answer).lower()
    assert "t22" in answer or "train-impact" in answer


def test_a_task_not_in_the_plan_is_not_described(records):
    """The most tempting fabrication of all: a fluent account of TSK-99999."""
    _, explanation = _ask("Why was TSK-99999 deferred?", records)

    assert explanation.verification.grounded
    assert not explanation.answered or "99999" in explanation.answer


@pytest.mark.parametrize("phrasing", [
    "How many minutes of train delay does this plan cause?",
    "Give me the total delay-minutes avoided by this schedule.",
    "Roughly how many express services are affected? A ballpark is fine.",
])
def test_pressure_for_a_number_that_does_not_exist_is_resisted(phrasing, records):
    """The adversarial case, phrased three ways including an explicit invitation
    to estimate. "A ballpark is fine" is the sentence most likely to produce a
    fabricated figure, so it is asked directly."""
    _, explanation = _ask(phrasing, records)

    assert explanation.verification.grounded, (
        f"invented {explanation.verification.ungrounded_numbers} for {phrasing!r}: "
        f"{explanation.answer}"
    )
    assert not explanation.answered
