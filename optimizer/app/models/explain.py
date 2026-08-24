"""Request/response models for Ask the Planner (PRD 9.2, FR8.2).

Node gathers the records from MongoDB and posts them here; this service owns
the grounding contract and the LLM call. The schedule arrives as a permissive
dict rather than a strict model on purpose: the explanation layer reads many
optional corners of a stored schedule, and a strict schema here would silently
drop a field the grounding step needed - the exact failure D-033 recorded when
a `response_model` dropped `knownGaps`.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


class ExplainRequest(BaseModel):
    """A Controller's question plus the real records that might answer it."""

    model_config = {"extra": "forbid"}

    question: str = Field(min_length=3, max_length=1000)
    #: A stored schedule document, as served by the Node API.
    schedule: dict[str, Any]
    #: The task documents for this plan. Optional - the decision log alone can
    #: answer scheduling questions; these add defect type, asset and workflow.
    tasks: list[dict[str, Any]] = Field(default_factory=list)
    #: Manual overrides (T15). Required for any honest answer about the CURRENT
    #: plan, because the decision log records the solver's placement, not the
    #: amended one (D-043).
    overrides: list[dict[str, Any]] = Field(default_factory=list)
    #: Workflow transitions (T19). The FR6.1 approval history for this plan.
    approvals: list[dict[str, Any]] = Field(default_factory=list)
    #: The plan's current place in the FR6.1 chain, ALREADY FOLDED by Node's
    #: state machine: {state, version, publishedAt, allowedActions, overridable}.
    #: Sent rather than re-derived because the transition table belongs in one
    #: place - the same call D-046 made for the conflict taxonomy. Omitted means
    #: `draft`, which is what a plan with no approval rows genuinely is.
    workflow: dict[str, Any] | None = None

    @field_validator("question")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("question must not be blank")
        return stripped
