"""Defense in depth at the edge (PRD §6.2.6).

The client redacts. This layer assumes the client is wrong — a bug, an older
build, or a bypass — and re-validates every string in the payload before the
model sees it or anything is written to a log.

Two rules govern everything here:

1. **Nothing is logged before validation.** The whole point is to keep raw PII
   out of server-side logs and provider logs; validating after logging would be
   theatre.

2. **Findings never quote the offending text.** A rejection names the dom_path
   and the pattern that fired. Echoing the value into an error response or a log
   line would leak exactly what this layer exists to stop.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Literal

from .patterns import find_raw_pii
from .schemas import AgentRequest, SanitizedDomNode

logger = logging.getLogger("athena.ingress")

Policy = Literal["reject", "redact"]


def current_policy() -> Policy:
    """`reject` fails closed and is the default; `redact` scrubs and continues."""
    value = os.getenv("ATHENA_INGRESS_POLICY", "reject").strip().lower()
    return "redact" if value == "redact" else "reject"


@dataclass
class Finding:
    dom_path: str
    field_name: str
    pattern: str

    def describe(self) -> str:
        return f"{self.dom_path}.{self.field_name} matches {self.pattern}"


@dataclass
class IngressReport:
    findings: list[Finding] = field(default_factory=list)
    scrubbed: AgentRequest | None = None

    @property
    def clean(self) -> bool:
        return not self.findings


def _scan_node(node: SanitizedDomNode) -> list[Finding]:
    found: list[Finding] = []
    for name, text in (("label", node.label), ("value", node.value)):
        if not text:
            continue
        for pattern in find_raw_pii(text):
            found.append(Finding(node.path, name, pattern.name))
    return found


def inspect(request: AgentRequest) -> IngressReport:
    """Scan a payload. Pure — decides nothing, logs nothing."""
    report = IngressReport()
    for node in request.dom_summary:
        report.findings.extend(_scan_node(node))
    report.findings.extend(
        Finding("task_instruction", "text", pattern.name)
        for pattern in find_raw_pii(request.task_instruction)
    )
    return report


def scrub(request: AgentRequest, findings: list[Finding]) -> AgentRequest:
    """Replace every offending field wholesale under the `redact` policy.

    Deliberately blunt: a server that tries to mask surgically is guessing at
    what the client meant, and a partial scrub of an unknown format is how
    leftovers survive. The field goes, and the model reasons without it.
    """
    offending = {(f.dom_path, f.field_name) for f in findings}
    nodes = []
    for node in request.dom_summary:
        updates = {}
        if (node.path, "label") in offending:
            updates["label"] = "[REDACTED:INGRESS]"
        if (node.path, "value") in offending:
            updates["value"] = "[REDACTED:INGRESS]"
        nodes.append(node.model_copy(update=updates) if updates else node)

    instruction = request.task_instruction
    if any(f.dom_path == "task_instruction" for f in findings):
        instruction = "[REDACTED:INGRESS]"

    return request.model_copy(update={"dom_summary": nodes, "task_instruction": instruction})


class IngressRejection(Exception):
    """Raised under the `reject` policy. Carries paths and pattern names only."""

    def __init__(self, findings: list[Finding]) -> None:
        self.findings = findings
        super().__init__(f"{len(findings)} raw PII pattern(s) survived client redaction")

    def detail(self) -> dict[str, object]:
        return {
            "error": "raw_pii_in_payload",
            "message": str(self),
            "findings": [f.describe() for f in self.findings],
        }


def enforce(request: AgentRequest) -> AgentRequest:
    """Validate, then return the payload that may proceed to the model.

    Raises IngressRejection under the `reject` policy.
    """
    report = inspect(request)
    if report.clean:
        logger.info(
            "ingress ok session=%s nodes=%d redactions=%d",
            request.session_id, len(request.dom_summary), len(request.redaction_manifest),
        )
        return request

    # Paths and pattern names only — never the matched text.
    logger.warning(
        "ingress found raw PII session=%s findings=%s",
        request.session_id, [f.describe() for f in report.findings],
    )
    if current_policy() == "reject":
        raise IngressRejection(report.findings)
    return scrub(request, report.findings)
