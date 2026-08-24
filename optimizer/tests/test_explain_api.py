"""`POST /explain` over HTTP - T18.

Only the network call to Anthropic is faked. The context assembly, the prompt,
and the number verification all run for real, so this exercises the honest part
of the pipeline end to end against a genuine schedule snapshot.
"""

from __future__ import annotations

import json
import pathlib

import pytest

import app.core.explainer as explainer_module
from app.config import get_settings

SNAPSHOT = pathlib.Path(__file__).parent / "fixtures" / "schedule_snapshot.json"


@pytest.fixture(scope="module")
def payload():
    data = json.loads(SNAPSHOT.read_text())
    return {"schedule": data["schedule"], "tasks": data["tasks"], "overrides": data["overrides"]}


class StubMessages:
    def __init__(self, reply):
        self.reply = reply
        self.prompts = []

    def create(self, **kwargs):
        self.prompts.append(kwargs)
        text = json.dumps(self.reply)
        return type("R", (), {"content": [type("B", (), {"text": text})()]})()


@pytest.fixture
def fake_claude(monkeypatch):
    """Inject a stub Anthropic client into the real `explain`.

    The router imported `explain` by name, so the patch goes on the router's
    reference. `explain` itself is the genuine function - only its `client` is
    supplied, so the prompt is really built and the answer is really verified.
    """
    import app.routers.explain as router_module

    real_explain = explainer_module.explain

    def install(reply):
        stub = StubMessages(reply)
        client = type("Client", (), {"messages": stub})()
        monkeypatch.setattr(
            router_module, "explain",
            lambda context, **kwargs: real_explain(context, client=client, **kwargs),
        )
        return stub

    return install


def test_a_grounded_answer_comes_back_with_its_evidence(client, payload, fake_claude, monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_provider", "anthropic", raising=False)
    monkeypatch.setattr(get_settings(), "anthropic_api_key", "test-key", raising=False)
    fake_claude({
        "answer": "TSK-00004 was scheduled on 2026-08-28 in the 07:26-13:34 window.",
        "recordIds": ["decision:TSK-00004"],
        "answered": True,
    })

    response = client.post(
        "/explain", json={"question": "Why was TSK-00004 scheduled?", **payload}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["answered"] is True
    assert body["verification"]["grounded"] is True
    assert body["groundedIn"] == ["decision:TSK-00004"]
    # The audit surface: what the answer could have been built from.
    assert "decision:TSK-00004" in body["context"]["recordIds"]
    assert body["context"]["resolvedReferences"]["tasks"] == ["TSK-00004"]
    assert body["context"]["factCount"] > 0
    assert "SYNTHETIC" in body["context"]["provenanceNote"]


def test_an_invented_number_is_reported_not_hidden(client, payload, fake_claude, monkeypatch):
    """The endpoint returns the answer AND the verdict on it. Suppressing the
    answer would hide the evidence; returning it unmarked would launder it."""
    monkeypatch.setattr(get_settings(), "llm_provider", "anthropic", raising=False)
    monkeypatch.setattr(get_settings(), "anthropic_api_key", "test-key", raising=False)
    fake_claude({
        "answer": "It would delay 47 express trains by 312 minutes.",
        "recordIds": [],
        "answered": True,
    })

    body = client.post(
        "/explain", json={"question": "What is the train impact?", **payload}
    ).json()

    assert body["verification"]["grounded"] is False
    assert body["verification"]["ungroundedNumbers"] == ["47", "312"]
    assert body["answer"]  # still returned, so it can be inspected


def test_an_out_of_scope_question_carries_its_unavailable_topic(client, payload, fake_claude, monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_provider", "anthropic", raising=False)
    monkeypatch.setattr(get_settings(), "anthropic_api_key", "test-key", raising=False)
    fake_claude({"answer": "This build cannot simulate alternative scenarios.",
                 "recordIds": ["plan:summary"], "answered": False})

    body = client.post(
        "/explain",
        json={"question": "What if I moved TSK-00004 to Thursday?", **payload},
    ).json()

    topics = [topic["topic"] for topic in body["context"]["unavailableTopics"]]
    assert "what-if simulation" in topics
    assert body["answered"] is False


def test_approval_records_reach_the_context_and_the_answer_carries_the_framing(
    client, payload, fake_claude, monkeypatch
):
    """T19 end to end over HTTP. The plan's workflow state and sign-off rows are
    posted by Node and must reach the grounding context; the attribution caveat
    is returned separately, so a Controller sees "roles, not people" even on the
    call where the model forgot to say it."""
    monkeypatch.setattr(get_settings(), "llm_provider", "anthropic", raising=False)
    monkeypatch.setattr(get_settings(), "anthropic_api_key", "test-key", raising=False)
    fake_claude({"answer": "Approved by the controller role, published as version 3.",
                 "recordIds": ["approval:APR-2"], "answered": True})

    body = client.post("/explain", json={
        **payload,
        "question": "Who approved this plan and when was it published?",
        "approvals": [{
            "_id": "APR-2", "action": "approve", "fromState": "under_review",
            "toState": "approved", "reason": "Night windows agreed with operations",
            "actorRole": "controller", "version": None, "validation": None,
            "createdAt": "2026-08-24T11:00:00Z",
        }],
        "workflow": {"state": "published", "version": 3,
                     "publishedAt": "2026-08-24T12:00:00Z",
                     "allowedActions": [], "overridable": False},
    }).json()

    assert "approval:APR-2" in body["context"]["recordIds"]
    assert "plan:workflow" in body["context"]["recordIds"]
    # No longer an unavailable topic - T19 made that claim false.
    assert body["context"]["unavailableTopics"] == []
    framing = " ".join(f["framing"] for f in body["context"]["modelFramings"])
    assert "ROLE, not a person" in framing
    # And the version number the answer quotes is genuinely in the grounding set.
    assert body["verification"]["grounded"] is True


def test_a_risk_answer_carries_the_prd_91_framing_whatever_the_model_said(
    client, payload, fake_claude, monkeypatch
):
    """T16 + PRD 9.1 / NG4. The model is TOLD to repeat the framing, but the
    response carries it independently, so a Controller sees the caveat even on
    the call where the model forgot. Tested with a model reply that deliberately
    omits it."""
    monkeypatch.setattr(get_settings(), "llm_provider", "anthropic", raising=False)
    monkeypatch.setattr(get_settings(), "anthropic_api_key", "test-key", raising=False)
    fake_claude({"answer": "The failure risk score is 65.17.", "recordIds": [], "answered": True})

    tasks = [{**task, "failureRiskScore": 65.17} for task in payload["tasks"][:3]]
    body = client.post(
        "/explain",
        json={**payload, "tasks": tasks, "question": "What is the failure risk on TSK-00004?"},
    ).json()

    framings = body["context"]["modelFramings"]
    assert framings, "a risk answer must carry the PRD 9.1 framing"
    text = " ".join(f["framing"] for f in framings).lower()
    assert "simulated" in text
    assert "does not predict real" in text
    # And the answer itself did NOT say it - which is exactly why this is
    # returned separately rather than left to the model.
    assert "simulated" not in body["answer"].lower()


def test_a_missing_key_returns_503_with_an_actionable_message(client, payload, monkeypatch):
    # Pinned: whichever provider a developer has configured locally, the
    # unconfigured path must behave the same way.
    monkeypatch.setattr(get_settings(), "llm_provider", "anthropic", raising=False)
    monkeypatch.setattr(get_settings(), "anthropic_api_key", "", raising=False)

    response = client.post("/explain", json={"question": "Why was TSK-00004 scheduled?", **payload})

    assert response.status_code == 503
    assert "ANTHROPIC_API_KEY" in response.json()["detail"]


def test_a_blank_question_is_refused_at_the_boundary(client, payload):
    assert client.post("/explain", json={"question": "  ", **payload}).status_code == 422


def test_an_unknown_field_is_refused_rather_than_ignored(client, payload):
    """`extra="forbid"`, as everywhere else in this service - a typo'd key must
    not be silently dropped into a context that then lacks it."""
    response = client.post(
        "/explain", json={"question": "Why?", "tsaks": [], **payload}
    )

    assert response.status_code == 422
