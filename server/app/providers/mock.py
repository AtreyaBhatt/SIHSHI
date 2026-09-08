"""Deterministic planner. No API key, no GPU, no network.

Not a stub to be deleted later — it is what makes the end-to-end loop testable in
CI and demoable on a laptop with no connectivity, and it is the default provider
so the server runs with zero configuration. It plans Scenario A (PRD §10) from
the sanitized payload alone, which also proves the payload really does carry
enough structure to act on after redaction.
"""

from __future__ import annotations

import json
import re

from ..schemas import AgentAction, PlanOutput

USERNAME_HINT = re.compile(r"user|customer|login|account\s*id|email", re.I)
SUBMIT_HINT = re.compile(r"sign\s*in|log\s*in|submit|continue|next", re.I)


class MockProvider:
    name = "mock"

    async def plan(self, system: str, user_text: str, image_b64: str | None) -> PlanOutput:
        dom = _extract_section(user_text, "dom_summary")
        manifest = _extract_section(user_text, "redaction_manifest")
        tier1_paths = {e.get("dom_path") for e in manifest if e.get("tier") == 1}

        password_path = next(
            (e.get("dom_path") for e in manifest if e.get("type") == "password"), None
        )
        username_path = next(
            (
                n["path"] for n in dom
                if n.get("role") in {"textbox", "searchbox"}
                and n["path"] not in tier1_paths
                and USERNAME_HINT.search(n.get("label") or "")
            ),
            None,
        )
        submit_path = next(
            (
                n["path"] for n in dom
                if n.get("role") == "button" and SUBMIT_HINT.search(n.get("label") or "")
            ),
            None,
        )

        actions: list[AgentAction] = []
        if username_path:
            actions.append(AgentAction(action="type", selector=username_path, value_ref="user_saved:username"))
        if password_path:
            actions.append(AgentAction(action="type", selector=password_path, value_ref="user_saved:password"))
        if submit_path:
            actions.append(AgentAction(action="click", selector=submit_path))

        if not actions:
            return PlanOutput(
                reasoning_summary="No login form was identifiable in the sanitized context.",
                actions=[],
                requires_client_secret=False,
            )

        return PlanOutput(
            reasoning_summary=(
                "This is a sign-in form. The password field is redacted but present, so the "
                "client resolves both credentials locally before submitting."
            ),
            actions=actions,
            requires_client_secret=any(a.value_ref for a in actions),
        )


def _extract_section(text: str, heading: str) -> list[dict]:
    marker = f"## {heading}\n"
    start = text.find(marker)
    if start == -1:
        return []
    body = text[start + len(marker):].lstrip()
    # raw_decode stops at the end of the first JSON value and ignores whatever
    # follows, so this works for the last section as well as the middle ones.
    try:
        parsed, _ = json.JSONDecoder().raw_decode(body)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []
