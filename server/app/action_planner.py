"""Constrains model output to something safe to execute (PRD §6.2.8).

The model's plan is a suggestion. This module is what decides whether each action
is allowed to reach the user's browser. Four guardrails, in order of how badly
they fail if missing:

1. **Selector allowlist.** An action may only target a path the client actually
   sent. Without this the model can name any selector on the page — including
   elements the redaction layer deliberately withheld — and the client would
   dutifully act on it. That is an exfiltration path, not a UX bug.
2. **No secret injection.** A Tier 1 field must be filled via `value_ref`, never
   a literal. If the server can put a literal into a password box, the server is
   back in the business of handling secrets.
3. **No marker echo.** `[EMAIL_1]` typed into a form is both wrong and a sign the
   model is treating placeholders as data.
4. **Shape.** Verbs that need a selector have one; `type` carries exactly one of
   value / value_ref.

Violations are dropped, not raised. One bad action should not lose a good plan,
and the rejections are reported back so the refusal is visible rather than silent.
"""

from __future__ import annotations

import re

from .patterns import CONTAINS_MARKER
from .schemas import AgentAction, AgentRequest, PlanOutput

VALUE_REF = re.compile(r"^user_saved:[A-Za-z0-9_.\-]{1,64}$")

NEEDS_SELECTOR = frozenset({"click", "type", "focus"})
FORBIDS_SELECTOR: frozenset[str] = frozenset()


def _tier1_paths(request: AgentRequest) -> set[str]:
    return {
        entry.dom_path
        for entry in request.redaction_manifest
        if entry.tier == 1 and entry.dom_path
    }


def constrain(plan: PlanOutput, request: AgentRequest) -> tuple[list[AgentAction], list[str]]:
    """Returns (executable actions, human-readable rejections)."""
    allowed_paths = {node.path for node in request.dom_summary}
    tier1 = _tier1_paths(request)

    kept: list[AgentAction] = []
    rejected: list[str] = []

    for index, action in enumerate(plan.actions):
        label = f"action[{index}] {action.action}"

        if action.action in NEEDS_SELECTOR and not action.selector:
            rejected.append(f"{label}: requires a selector")
            continue

        if action.selector and action.selector not in allowed_paths:
            # The single most important check in this file.
            rejected.append(f"{label}: selector {action.selector!r} was not in dom_summary")
            continue

        if action.value is not None and CONTAINS_MARKER.search(action.value):
            rejected.append(f"{label}: value echoes a redaction marker")
            continue

        if action.value_ref is not None and not VALUE_REF.match(action.value_ref):
            rejected.append(f"{label}: value_ref {action.value_ref!r} is not a user_saved reference")
            continue

        if action.action == "type":
            has_value = action.value is not None
            has_ref = action.value_ref is not None
            if has_value == has_ref:
                rejected.append(f"{label}: needs exactly one of value / value_ref")
                continue
            if has_value and action.selector in tier1:
                rejected.append(
                    f"{label}: {action.selector} is a tier 1 field and must use value_ref, not a literal"
                )
                continue

        kept.append(action)

    return kept, rejected


def requires_client_secret(actions: list[AgentAction]) -> bool:
    """Derived from the plan itself rather than trusted from the model."""
    return any(action.value_ref for action in actions)
