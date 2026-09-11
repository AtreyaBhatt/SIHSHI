"""Server-side mirror of the client↔server contract (PRD §7).

These models are the wire format. They are deliberately strict: unknown fields
are rejected, so a client sending a shape this server does not understand fails
loudly at the edge instead of having extra data quietly forwarded to a model.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

PiiType = Literal[
    "password", "otp", "card_number", "card_expiry", "cvv",
    "aadhaar", "pan", "ssn", "passport", "bank_account", "ifsc", "face", "frame",
    "email", "phone", "address", "person_name", "date_of_birth",
]

MaskingStrategy = Literal["blackbox", "blur", "token", "partial"]

# PRD §3.2 caps the action grammar at these verbs. Widening this is a product
# decision, not a convenience — a general automation DSL is an explicit non-goal.
ActionVerb = Literal["click", "type", "focus", "scroll", "read", "wait"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RedactionManifestEntry(Strict):
    """PRD §6.2.4. Says what kind of thing was removed and where — never the value."""

    id: str
    type: PiiType
    tier: Literal[1, 2, 3]
    bbox: list[float] | None = None
    dom_path: str | None = None
    masking: MaskingStrategy
    detector: str = "unknown"
    confidence: float = 1.0


class SanitizedDomNode(Strict):
    path: str
    role: str | None = None
    label: str | None = None
    value: str | None = None


class AgentAction(Strict):
    action: ActionVerb
    selector: str | None = None
    value: str | None = None
    #: PRD §7.2 indirection. Names a locally-stored credential; the server never
    #: sees or supplies the secret itself.
    value_ref: str | None = None


class AgentRequest(Strict):
    """PRD §7.1."""

    session_id: str
    task_instruction: str
    screenshot_redacted: str | None = None
    dom_summary: list[SanitizedDomNode]
    redaction_manifest: list[RedactionManifestEntry] = Field(default_factory=list)
    prior_actions: list[AgentAction] = Field(default_factory=list)


class AgentResponse(Strict):
    """PRD §7.2, plus one addition.

    `guardrail_rejections` is not in the PRD's response shape. It carries the
    actions the planner refused and why — an invented selector, a literal aimed
    at a Tier 1 field. Silent refusal would make the guardrail invisible exactly
    when it matters, and PRD §5 story 4 asks for an auditable trail. It is
    additive and clients may ignore it.
    """

    session_id: str
    reasoning_summary: str
    actions: list[AgentAction]
    requires_client_secret: bool
    guardrail_rejections: list[str] = Field(default_factory=list)


class PlanOutput(Strict):
    """What the model is asked to produce. Session id is ours, not the model's."""

    reasoning_summary: str
    actions: list[AgentAction]
    requires_client_secret: bool
