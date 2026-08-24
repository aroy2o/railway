"""`/explain` - Ask the Planner (PRD 9.2, FR8.2).

Two steps, kept apart so the testable one can be tested:

  1. `assemble_context` selects the real records that bear on the question.
     Pure, deterministic, and asserted by `tests/test_grounding.py`.
  2. `explain` asks Claude, then `verify_answer` checks the reply's numbers
     against step 1's output.

The response carries both the answer and what it was grounded in, so a
Controller (or a judge) can check the answer rather than take it on trust.

No `response_model` - see D-033. The honesty fields here (`verification`,
`unavailable`, `groundedIn`) are exactly the kind a response schema drops
silently, and they are the point of the endpoint.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status

from app.config import get_settings
from app.core.explainer import ExplainerUnavailable, explain
from app.core.grounding import assemble_context
from app.models.explain import ExplainRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["explain"])


@router.post("/explain")
def explain_endpoint(request: ExplainRequest) -> dict:
    """Answer a free-text question, grounded strictly in the supplied records."""
    settings = get_settings()

    context = assemble_context(
        request.question,
        request.schedule,
        tasks=request.tasks,
        overrides=request.overrides,
        approvals=request.approvals,
        workflow=request.workflow,
    )

    try:
        explanation = explain(
            context,
            provider=settings.llm_provider,
            api_key=settings.explain_api_key,
            model=settings.explain_model,
            max_tokens=settings.explain_max_tokens,
        )
    except ExplainerUnavailable as exc:
        # 503, not 500: the service is fine, this one dependency is not, and the
        # message says which - the D-037 standard applied to the LLM layer.
        logger.warning("explain unavailable: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc

    if not explanation.verification.grounded:
        # Answered, but with at least one figure that is not in the grounding
        # data. Logged loudly: this is the failure PRD Section 18 warns about,
        # and it is invisible unless something says so.
        logger.error(
            "explain produced ungrounded numbers %s for question %r",
            explanation.verification.ungrounded_numbers,
            request.question,
        )

    logger.info(
        "explain: %d facts, answered=%s, grounded=%s",
        len(context.facts), explanation.answered, explanation.verification.grounded,
    )

    return {
        **explanation.as_dict(),
        "context": {
            "factCount": len(context.facts),
            "recordIds": context.record_ids,
            "resolvedReferences": context.resolved_references,
            "unknownReferences": context.unknown_references,
            "unavailableTopics": [topic.as_dict() for topic in context.unavailable],
            "provenanceNote": context.provenance_note,
            # Rendered by the UI regardless of whether the model repeated them.
            "modelFramings": context.model_framings(),
        },
    }
