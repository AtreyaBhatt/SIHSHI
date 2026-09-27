"""Constrains model output to something safe to execute (PRD §6.2.8).

The model's plan is a suggestion. This module is what decides whether each action
is allowed to reach the user's browser. The rules, mirrored in the extension's
direct-provider-response.ts:

1. **Selector allowlist.** An action may only target a path the client actually
   sent. Without this the model can name any selector on the page — including
   elements the redaction layer deliberately withheld — and the client would
   dutifully act on it. That is an exfiltration path, not a UX bug.
2. **Shape.** click/type/select/hover need a selector; select needs an option;
   key needs a key; navigate needs an http(s) url.
3. **value / value_ref only on type**, and `type` carries exactly one of them.
4. **No marker echo.** `[EMAIL_1]` typed into a form is both wrong and a sign the
   model is treating placeholders as data.
5. **value_ref is a `user_saved:` reference.**
6. **No secret injection.** A Tier 1 field must be filled via `value_ref` or
   `value_token`, never a literal. If the server can put a literal into a
   password box, the server is back in the business of handling secrets.
7. **value_token** names a token from this request's manifest (not one the
   firewall minted), of a resolvable Tier-1 or a Tier-2 type (tier read from the
   type, not the client's entry), and the target field must carry a manifest
   entry of the same type.
8. **Risk floor.** navigate, the Enter key, clicks on buttons and links,
   typing into any field with a manifest entry, and every value_ref/value_token
   are forced `sensitive`, so approve-sensitive pauses on them whatever the
   model said.

Violations are dropped, not raised. One bad action should not lose a good plan,
and the rejections are reported back so the refusal is visible rather than silent.
"""

from __future__ import annotations

import re

from .patterns import CONTAINS_MARKER
from .schemas import AgentAction, AgentRequest, PiiType, PlanOutput, RedactionManifestEntry

VALUE_REF = re.compile(r"^user_saved:[A-Za-z0-9_.\-]{1,64}$")
TOKEN = re.compile(r"^\[[A-Z][A-Z0-9_]*_\d+\]$")

# Mirrors extension/src/shared/schema.ts RESOLVABLE_TIER1. Tier-1 types whose
# value the user may need to reference again get a numbered token instead of
# the fixed [REDACTED:TYPE] marker.
RESOLVABLE_TIER1: frozenset[PiiType] = frozenset({
    "aadhaar", "pan", "card_number", "card_expiry", "ssn", "passport", "bank_account", "ifsc",
})

# Mirrors extension/src/shared/schema.ts TIER_BY_TYPE. A token's tier is read
# from its type here, never from the client-sent entry.tier.
TIER_BY_TYPE: dict[PiiType, int] = {
    "password": 1, "otp": 1, "card_number": 1, "card_expiry": 1, "cvv": 1,
    "aadhaar": 1, "pan": 1, "ssn": 1, "passport": 1, "bank_account": 1, "ifsc": 1,
    "face": 1, "frame": 1,
    "email": 2, "phone": 2, "address": 2, "person_name": 2, "date_of_birth": 2, "account_id": 2,
}

NEEDS_SELECTOR = frozenset({"click", "type", "select", "hover"})
HTTP_URL = re.compile(r"^https?://\S+$")


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
    roles = {node.path: node.role for node in request.dom_summary}
    redacted = {e.dom_path for e in request.redaction_manifest if e.dom_path}
    # Firewall-minted tokens mark values the cascade missed; they are masked, never typeable.
    token_entries: dict[str, RedactionManifestEntry] = {
        e.id: e for e in request.redaction_manifest if not e.detector.startswith("firewall:")
    }
    # A token may only fill a field the client declared as holding that same type.
    target_types = {(e.dom_path, e.type) for e in request.redaction_manifest if e.dom_path}
    available_refs = set(request.available_refs)

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

        if action.action == "select" and not action.option:
            rejected.append(f"{label}: requires an option"); continue
        if action.action == "key" and action.key is None:
            rejected.append(f"{label}: requires a key"); continue
        if action.action == "navigate" and not (action.url and HTTP_URL.match(action.url)):
            rejected.append(f"{label}: requires an http(s) url"); continue

        if action.action != "type" and (action.value is not None or action.value_ref is not None):
            rejected.append(f"{label}: value / value_ref only apply to type")
            continue

        if action.value is not None and CONTAINS_MARKER.search(action.value):
            rejected.append(f"{label}: value echoes a redaction marker")
            continue

        if action.value_ref is not None and not VALUE_REF.match(action.value_ref):
            rejected.append(f"{label}: value_ref {action.value_ref!r} is not a user_saved reference")
            continue

        if action.action != "type" and (
            action.value is not None or action.value_ref is not None or action.value_token is not None
        ):
            rejected.append(f"{label}: value / value_ref / value_token only apply to type")
            continue

        if action.value_token is not None:
            if not TOKEN.match(action.value_token):
                rejected.append(f"{label}: value_token must look like [TYPE_N]")
                continue
            token_id = action.value_token[1:-1]
            entry = token_entries.get(token_id)
            if entry is None or not (entry.type in RESOLVABLE_TIER1 or TIER_BY_TYPE[entry.type] == 2):
                rejected.append(f"{label}: value_token is not a token from this request")
                continue
            if (action.selector, entry.type) not in target_types:
                rejected.append(f"{label}: value_token type does not match the target field")
                continue

        if action.value_ref is not None and available_refs and action.value_ref not in available_refs:
            rejected.append(f"{label}: value_ref names a slot the user has not stored")
            continue

        if action.action == "type":
            sources = sum(
                1 for v in (action.value, action.value_ref, action.value_token) if v is not None
            )
            if sources != 1:
                rejected.append(f"{label}: needs exactly one of value / value_ref / value_token")
                continue
            if action.value is not None and action.selector in tier1:
                rejected.append(
                    f"{label}: {action.selector} is a tier 1 field and must use value_ref or value_token"
                )
                continue

        # Risk floor: these pause in approve-sensitive whatever the model said.
        if (
            action.action == "navigate"
            or (action.action == "key" and action.key == "Enter")
            or (action.action == "click" and roles.get(action.selector) in ("button", "link"))
            or (action.action == "type" and action.selector in redacted)
            or action.value_ref is not None
            or action.value_token is not None
        ):
            action = action.model_copy(update={"risk": "sensitive"})
        kept.append(action)

    return kept, rejected


def requires_client_secret(actions: list[AgentAction]) -> bool:
    """Derived from the plan itself rather than trusted from the model."""
    return any(action.value_ref or action.value_token for action in actions)
