"""Ask the Planner - the LLM layer over a grounded context (PRD 9.2, FR8.2).

This module is deliberately thin. `grounding.py` decides what the model may
know; this decides how to ask, and - more importantly - how to CHECK.

WHY THERE IS A CHECK AT ALL
---------------------------
Every other guarantee in this project is enforced by a deterministic function
with a test that fails when the function is wrong. An LLM is the first component
here that cannot be tested that way: the same prompt can produce different
words, so "it answered correctly once" is weak evidence that it answers
correctly.

So the prompt is not the guarantee. `verify_answer` is. It scans the model's
output for numbers and checks every one against the set of values the grounding
context actually contained. That check is pure, deterministic, and testable
without an API key - and it runs on every real answer, so a fabricated figure is
caught at runtime rather than hoped against at prompt-writing time.

The prompt still does its job (it is what makes good answers likely). The
verifier is what makes a bad one visible.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from app.core.grounding import (
    ISO_TIMESTAMP_PATTERN,
    GroundingContext,
    _normalise_number,
)

#: Numbers that carry no factual claim - ordinals and small counts used in
#: prose ("the first reason", "both tasks"). Excluded from verification because
#: flagging them produces noise that trains a reader to ignore the flag.
PROSE_NUMBERS = {"0", "1", "2"}

NUMBER_PATTERN = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)(?![\w])")

#: Thousands separators. "4,880" must read as one number; without this the
#: pattern above sees "4" and "880", and "880" is then reported as invented.
#: Found by a live run - the model wrote a real figure and was accused of
#: fabricating it (D-054).
THOUSANDS_PATTERN = re.compile(r"(?<=\d),(?=\d{3}\b)")

#: Whole ISO dates, checked as dates rather than as three loose integers.
ISO_DATE_IN_TEXT = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")

#: Ids this system generates from a timestamp: SCH-, OVR-, APR- followed by a
#: long digit run, optionally suffixed. Removed before the number scan - see
#: `verify_answer`.
GENERATED_ID_IN_TEXT = re.compile(r"\b[A-Z]{3}-\d{8,}(?:-[\w.-]+)?")

#: Models write typographic dashes. U+2011 (non-breaking hyphen) in
#: "train‑impact" is not U+002D, and every literal comparison downstream misses
#: it. Normalised on the way in, everywhere.
DASHES = str.maketrans({"\u2010": "-", "\u2011": "-", "\u2012": "-",
                        "\u2013": "-", "\u2014": "-", "\u2212": "-"})


def normalise_text(text: str) -> str:
    """Fold typographic dashes and thousands separators to plain ASCII forms."""
    return THOUSANDS_PATTERN.sub("", text.translate(DASHES))


SYSTEM_PROMPT = """\
You are the explanation layer of an AI-assisted railway maintenance block \
planning system. A Section Controller asks you questions about a schedule the \
system produced.

ABSOLUTE RULE: every factual claim you make - especially every number, date, \
task id, corridor id and time - must come from the GROUNDING DATA supplied in \
the user message. You may not calculate new figures, estimate, extrapolate, or \
supply a number from general knowledge. If a number is not in the grounding \
data, it does not go in your answer.

If the grounding data does not contain what is needed to answer, say so plainly \
and name what is missing. The UNAVAILABLE section lists things this build \
genuinely cannot know; if the question depends on any of them, say the system \
does not have that data and name the reason given. Do not guess, do not offer a \
plausible-sounding substitute, and do not apologise at length - a Controller \
needs to know what the system knows, and an honest "this system does not \
compute that" is a useful answer.

If a fact of kind `model_framing` is present and you state the figure it describes, you must also say in the same answer that it comes from a model trained on simulated data. Quoting a model output as an observed fact is the one error this system treats as more serious than declining to answer. A fact of kind `workflow_framing` carries a different kind of caveat - repeat the caveat its `framing` field states, and obey its `mustNotSay`.

Style: direct and specific, 2-5 sentences, plain English. Quote the actual \
figures from the grounding data. No preamble, no bullet lists unless comparing \
several items. Refer to tasks and corridors by their ids.

Respond with a JSON object and nothing else:
{"answer": "<your answer>", "recordIds": ["<ids of the facts you used>"], \
"answered": true|false}

`answered` is false when you had to decline because the data is not there.\
"""


@dataclass
class Verification:
    """Deterministic check of an answer against what it was allowed to say."""

    #: Numbers in the answer with no counterpart in the grounding data.
    ungrounded_numbers: list[str] = field(default_factory=list)
    #: Record ids the model claimed to use that were not in the context.
    unknown_record_ids: list[str] = field(default_factory=list)

    @property
    def grounded(self) -> bool:
        return not self.ungrounded_numbers and not self.unknown_record_ids

    def as_dict(self) -> dict[str, Any]:
        return {
            "grounded": self.grounded,
            "ungroundedNumbers": self.ungrounded_numbers,
            "unknownRecordIds": self.unknown_record_ids,
            "note": (
                "Numbers in the answer are checked against the grounding data. "
                "`ungroundedNumbers` lists any that did not appear there - inspect "
                "before trusting the sentence containing them."
            ),
        }


@dataclass
class Explanation:
    answer: str
    answered: bool
    grounded_in: list[str]
    verification: Verification
    model: str
    context_fact_count: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "answer": self.answer,
            "answered": self.answered,
            "groundedIn": self.grounded_in,
            "verification": self.verification.as_dict(),
            "model": self.model,
            "contextFactCount": self.context_fact_count,
        }


# --------------------------------------------------------------------------- #
# Providers                                                                    #
# --------------------------------------------------------------------------- #
#
# PRD Section 10 names the Claude API for this layer, and that path is intact.
# A second provider exists because the explanation layer is the one component
# with a per-call cost, and a prototype that cannot be demonstrated without a
# paid key is worse than one that can. See D-052.
#
# The provider decides only WHO generates the sentence. What it is allowed to
# say is fixed by `grounding.py` before either is called, and what it actually
# said is checked by `verify_answer` after - so neither guarantee depends on the
# vendor, and swapping them changes nothing that this project claims.

GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"


def _call_anthropic(system: str, user: str, *, api_key: str, model: str, max_tokens: int) -> str:
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise ExplainerUnavailable(
            "Ask the Planner is unavailable: the `anthropic` package is not installed "
            "in the optimizer environment."
        ) from exc

    response = anthropic.Anthropic(api_key=api_key).messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return "".join(
        block.text for block in getattr(response, "content", []) if hasattr(block, "text")
    )


#: Groq's `compound` models are agentic systems with server-side web search,
#: not plain LLMs. That is disqualifying for a feature whose entire claim is
#: "every number comes from these records" - a model that can read the internet
#: mid-answer can ground a sentence in something no Controller can audit.
#:
#: Search is therefore suppressed on every call, not offered as an option. This
#: was not theoretical: asking compound-mini about weather made it attempt a
#: search and fail the request with HTTP 413, and the same question with search
#: excluded answered correctly from the data and reported `executed_tools:
#: None`. See D-052.
GROQ_AGENTIC_MODEL_PREFIX = "groq/compound"
GROQ_NO_SEARCH = {"search_settings": {"exclude_domains": ["*"]}}


def _call_groq(system: str, user: str, *, api_key: str, model: str, max_tokens: int) -> str:
    """Groq's OpenAI-compatible chat completions endpoint.

    Called over plain httpx rather than pulling in the OpenAI SDK for one POST.

    `response_format=json_object` is deliberately NOT set. It looks like the
    right way to protect the citation list, but `openai/gpt-oss-120b` rejects
    the request outright with "Failed to validate JSON" under strict mode. The
    tolerant parser in `_parse_model_output` handles the wrappings that occur in
    practice, and a lost citation list degrades an answer rather than failing it.
    """
    import httpx

    body: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        # Deterministic sampling. It does not make an LLM deterministic, but it
        # removes the one source of variance that is free to remove.
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    if model.startswith(GROQ_AGENTIC_MODEL_PREFIX):
        body.update(GROQ_NO_SEARCH)

    response = httpx.post(
        GROQ_ENDPOINT,
        headers={"Authorization": f"Bearer {api_key}"},
        json=body,
        timeout=60.0,
    )

    if response.status_code == 429:
        response = _retry_after_rate_limit(response, body, api_key)

    response.raise_for_status()
    payload = response.json()

    # An agentic model that ran a tool despite the suppression above would have
    # reached outside the grounding data. Refuse the answer rather than show it.
    executed = payload["choices"][0]["message"].get("executed_tools")
    if executed:
        raise ExplainerUnavailable(
            f"Ask the Planner refused an answer: the model used external tools "
            f"({len(executed)}), which would put it outside this plan's records."
        )

    return payload["choices"][0]["message"]["content"] or ""


#: A single retry is worth waiting for; a queue of them is not. Node's own
#: EXPLAIN_TIMEOUT_MS is 60s, so anything beyond this fails faster and says why.
MAX_RATE_LIMIT_WAIT_SECONDS = 20.0


def _retry_after_rate_limit(response, body, api_key):
    """Wait out a 429 once, using the provider's own stated delay.

    Groq reports the exact wait in the error message ("Please try again in
    1.62s"), which is usually a second or two - the token window is per minute
    and refills continuously. Retrying once turns the common case into a slight
    pause instead of a visible failure; a long wait is refused, because a
    Controller staring at a spinner for a minute is worse than a clear message.
    """
    import re as _re
    import time as _time

    import httpx

    detail = ""
    try:
        detail = response.json().get("error", {}).get("message", "")
    except Exception:  # noqa: BLE001 - the body is advisory only
        pass

    wait = None
    match = _re.search(r"try again in ([\d.]+)s", detail)
    if match:
        wait = float(match.group(1))
    elif response.headers.get("retry-after"):
        try:
            wait = float(response.headers["retry-after"])
        except ValueError:
            wait = None

    if wait is None or wait > MAX_RATE_LIMIT_WAIT_SECONDS:
        raise ExplainerUnavailable(
            "Ask the Planner has hit the model provider's rate limit"
            + (f"; it will not clear for {wait:.0f}s" if wait else "")
            + ". The schedule, its decision log and its conflicts are unaffected."
        )

    _time.sleep(wait + 0.5)
    return httpx.post(
        GROQ_ENDPOINT,
        headers={"Authorization": f"Bearer {api_key}"},
        json=body,
        timeout=60.0,
    )


PROVIDERS = {"anthropic": _call_anthropic, "groq": _call_groq}


class ExplainerUnavailable(RuntimeError):
    """The LLM could not be reached or is not configured.

    Carries a message safe to show a Controller, in the same spirit as D-037:
    "the explanation service has no API key configured" is actionable;
    "Internal server error" is not.
    """


def build_prompt(context: GroundingContext) -> str:
    """The user-message half of the prompt. Pure, so a test can read it."""
    sections = [
        f"QUESTION:\n{context.question}",
        f"DATA PROVENANCE:\n{context.provenance_note}",
        # Compact separators, not indent=2: pretty-printing a fact list cost
        # roughly a third of the prompt in whitespace, and the token budget on
        # this service's configured models is measured per minute (D-053).
        "GROUNDING DATA (the only facts you may use):\n"
        + json.dumps(
            [fact.as_dict() for fact in context.facts],
            separators=(",", ":"), default=str,
        ),
    ]

    if context.omitted_fact_count:
        sections.append(
            f"NOTE: {context.omitted_fact_count} further records from this plan were left out "
            "to fit a size limit. They exist and were not examined. If the question needs "
            "them, say the answer would require looking at more of the plan than was "
            "supplied - do not state that the plan does not contain something."
        )

    if context.unavailable:
        sections.append(
            "UNAVAILABLE - this build cannot answer questions that depend on these:\n"
            + json.dumps([topic.as_dict() for topic in context.unavailable], indent=2)
        )
    if context.unknown_references:
        sections.append(
            "IDS NAMED IN THE QUESTION THAT ARE NOT IN THIS SCHEDULE "
            f"(say so rather than describing them):\n{context.unknown_references}"
        )

    return "\n\n".join(sections)


def verify_answer(answer: str, context: GroundingContext, record_ids: list[str]) -> Verification:
    """Check an answer against the facts it was allowed to use.

    Deterministic and API-free, so it is testable in the ordinary way even
    though what it checks is not. Numbers appearing in the Controller's own
    question are allowed through - the model is echoing the asker, not inventing.
    """
    text = normalise_text(answer)
    question = normalise_text(context.question)

    allowed = context.numbers()
    for match in NUMBER_PATTERN.findall(question):
        allowed.add(_normalise_number(match))

    ungrounded: list[str] = []

    # Dates are checked whole, then removed, so their parts are never scanned as
    # loose integers. `numbers()` deliberately withholds the MONTH of a stored
    # date (it would whitelist a small integer on every schedule), which meant
    # a model correctly quoting "2026-09-18" was accused of inventing "9".
    allowed_dates = context.date_strings()

    # Whole instants first. A bare date pass would strip `2026-08-24` and leave
    # `T02:59:09.017Z` to be scanned as the quantities 2, 59, 9 and 17 - which
    # accused a model of inventing "9" when it correctly quoted the moment a
    # plan was published. Fourth instance of the D-054 shape, and the same fix:
    # check the thing as what it is, not as the integers it is made of.
    for stamp in ISO_TIMESTAMP_PATTERN.findall(text):
        if stamp not in allowed_dates and stamp not in ISO_TIMESTAMP_PATTERN.findall(question):
            if stamp not in ungrounded:
                ungrounded.append(stamp)
    text = ISO_TIMESTAMP_PATTERN.sub(" ", text)

    for date_text in ISO_DATE_IN_TEXT.findall(text) + ISO_DATE_IN_TEXT.findall(question):
        if date_text not in allowed_dates and date_text not in ungrounded:
            if date_text in ISO_DATE_IN_TEXT.findall(question):
                continue
            ungrounded.append(date_text)
    text = ISO_DATE_IN_TEXT.sub(" ", text)

    # Record ids are removed before the number scan, for the same reason dates
    # are: an id is a citation, not a quantity. The prompt asks the model to
    # cite the records it used, and ids like `APR-20260824025855658-approve`
    # carry a 17-digit run that no fact's DATA contains - so citing a record
    # correctly was being reported as inventing a number.
    #
    # Found on a live run (D-059). It is the third instance of the same shape:
    # the model was right and the checker was wrong, which is the failure mode
    # that matters most here - a verifier that cries wolf trains a Controller to
    # ignore the one flag that is real.
    #
    # Nothing is lost by removing them: whether a cited id EXISTS is already
    # checked, separately and exactly, as `unknownRecordIds`.
    for record_id in sorted(context.record_ids, key=len, reverse=True):
        text = text.replace(record_id, " ")
    # A fact id is `kind:RECORD-ID`, and a model citing its source usually
    # writes the bare record id - `APR-20260824025855658-approve`, not
    # `approval:APR-...`. So the generated-id SHAPE is stripped too: three
    # letters, a hyphen, and eight or more digits. A run that long inside a
    # hyphenated identifier is never a quantity a Controller would read as one,
    # and short ids like TSK-00042 are deliberately left alone.
    text = GENERATED_ID_IN_TEXT.sub(" ", text)

    for match in NUMBER_PATTERN.findall(text):
        normalised = _normalise_number(match)
        if normalised in allowed or normalised in PROSE_NUMBERS:
            continue
        if normalised not in ungrounded:
            ungrounded.append(normalised)

    known_ids = set(context.record_ids)
    unknown = sorted({rid for rid in record_ids if rid not in known_ids})

    return Verification(ungrounded_numbers=ungrounded, unknown_record_ids=unknown)


def _parse_model_output(text: str) -> tuple[str, list[str], bool]:
    """Read the model's JSON, tolerating a stray code fence or preamble.

    A malformed response is not treated as a failure: the raw text becomes the
    answer with no claimed record ids, and the verifier still checks its numbers.
    Losing the citation list is worse than losing the answer, but neither is a
    reason to show the Controller an error when real text came back.
    """
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*|\s*```$", "", candidate)

    try:
        parsed = json.loads(candidate)
    except (json.JSONDecodeError, ValueError):
        start, end = candidate.find("{"), candidate.rfind("}")
        if start == -1 or end <= start:
            return text.strip(), [], True
        try:
            parsed = json.loads(candidate[start : end + 1])
        except (json.JSONDecodeError, ValueError):
            return text.strip(), [], True

    if not isinstance(parsed, dict):
        return text.strip(), [], True

    answer = str(parsed.get("answer") or "").strip() or text.strip()
    ids = [str(rid) for rid in (parsed.get("recordIds") or []) if rid]
    answered = bool(parsed.get("answered", True))
    return answer, ids, answered


def explain(
    context: GroundingContext,
    *,
    api_key: str,
    model: str,
    provider: str = "anthropic",
    max_tokens: int = 700,
    client: Any = None,
) -> Explanation:
    """Ask the configured model the question, grounded in `context`.

    `client` exists so tests can drive this with an Anthropic-shaped stub. It is
    not a mock of the grounding - the grounding is real in those tests - only of
    the network call.
    """
    prompt = build_prompt(context)
    key_name = "GROQ_API_KEY" if provider == "groq" else "ANTHROPIC_API_KEY"

    if client is not None:
        # Test seam: the stub speaks the Anthropic client shape.
        try:
            response = client.messages.create(
                model=model, max_tokens=max_tokens, system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )
        except Exception as exc:  # noqa: BLE001
            raise ExplainerUnavailable(
                f"Ask the Planner could not reach the model API: {type(exc).__name__}. "
                "The schedule and its decision log are unaffected."
            ) from exc
        text = "".join(
            block.text for block in getattr(response, "content", []) if hasattr(block, "text")
        )
    else:
        call = PROVIDERS.get(provider)
        if call is None:
            raise ExplainerUnavailable(
                f"Ask the Planner is misconfigured: unknown LLM_PROVIDER {provider!r}. "
                f"Known providers: {', '.join(sorted(PROVIDERS))}."
            )
        if not api_key:
            raise ExplainerUnavailable(
                f"Ask the Planner is not configured: no {key_name} is set on the "
                "optimizer service. The schedule, its decision log and its conflicts are "
                "all still available; only the natural-language layer is unavailable."
            )
        try:
            text = call(
                SYSTEM_PROMPT, prompt, api_key=api_key, model=model, max_tokens=max_tokens
            )
        except ExplainerUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed, safe message
            # The exception TYPE is safe to show; its message may carry a URL,
            # an upstream host or a fragment of the key, so it is not included.
            raise ExplainerUnavailable(
                f"Ask the Planner could not reach the {provider} API: {type(exc).__name__}. "
                "The schedule and its decision log are unaffected."
            ) from exc

    answer, record_ids, answered = _parse_model_output(text)

    return Explanation(
        answer=answer,
        answered=answered,
        grounded_in=record_ids,
        verification=verify_answer(answer, context, record_ids),
        model=f"{provider}:{model}",
        context_fact_count=len(context.facts),
    )
