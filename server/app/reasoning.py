"""Orchestration: sanitized payload in, constrained plan out.

Deliberately thin. Everything with a policy in it lives elsewhere — ingress
validates, prompt.py phrases, the provider infers, action_planner decides what is
allowed to execute. This module only wires them in the right order, which is the
order that matters: validate before anything is logged or sent, constrain before
anything is returned.
"""

from __future__ import annotations

import logging

from .action_planner import constrain, requires_client_secret
from .prompt import SYSTEM_PROMPT, build_user_message
from .providers import get_provider
from .schemas import AgentRequest, AgentResponse

logger = logging.getLogger("athena.reasoning")


async def plan_actions(request: AgentRequest) -> AgentResponse:
    provider = get_provider()
    plan = await provider.plan(
        system=SYSTEM_PROMPT,
        user_text=build_user_message(request),
        image_b64=request.screenshot_redacted,
    )

    actions, rejections = constrain(plan, request)
    if rejections:
        logger.warning(
            "planner guardrails dropped %d action(s) session=%s: %s",
            len(rejections), request.session_id, rejections,
        )

    return AgentResponse(
        session_id=request.session_id,
        reasoning_summary=plan.reasoning_summary,
        actions=actions,
        # Derived from the surviving actions rather than trusted from the model.
        requires_client_secret=requires_client_secret(actions),
        guardrail_rejections=rejections,
    )
