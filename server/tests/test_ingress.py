"""Ingress is the layer that assumes the client is broken (PRD §6.2.6)."""

from __future__ import annotations

import pytest

from app.ingress import IngressRejection, enforce, inspect, scrub
from app.schemas import AgentRequest

RAW_CARD = "4539 1488 0343 6467"
RAW_EMAIL = "ada.lovelace@example.org"


def test_real_client_payload_passes_clean(bank_login_payload):
    report = inspect(AgentRequest.model_validate(bank_login_payload))
    assert report.clean, [f.describe() for f in report.findings]


def test_redaction_markers_are_not_mistaken_for_pii(bank_login_payload):
    """The client's own placeholders must never trip the check that exists to
    catch the client failing."""
    request = AgentRequest.model_validate(bank_login_payload)
    values = {node.value for node in request.dom_summary}
    assert "[REDACTED:PASSWORD]" in values
    assert inspect(request).clean


@pytest.mark.parametrize(
    ("leak", "pattern"),
    [(RAW_CARD, "card_number+luhn"), (RAW_EMAIL, "email"), ("ABCDE1234F", "pan")],
)
def test_leaked_value_is_caught(bank_login_payload, leak, pattern):
    payload = dict(bank_login_payload)
    payload["dom_summary"] = [*payload["dom_summary"], {"path": "input#leak", "value": leak}]

    report = inspect(AgentRequest.model_validate(payload))
    assert not report.clean
    assert any(f.pattern == pattern and f.dom_path == "input#leak" for f in report.findings)


def test_rejection_never_echoes_the_value(bank_login_payload):
    """A rejection that quotes the offending text leaks exactly what this layer
    exists to stop — including into whatever logs the error response."""
    payload = dict(bank_login_payload)
    payload["dom_summary"] = [*payload["dom_summary"], {"path": "input#leak", "value": RAW_CARD}]

    with pytest.raises(IngressRejection) as excinfo:
        enforce(AgentRequest.model_validate(payload))

    serialized = repr(excinfo.value.detail())
    assert RAW_CARD not in serialized
    assert RAW_CARD.replace(" ", "") not in serialized
    assert "input#leak" in serialized
    assert "card_number" in serialized


def test_reject_is_the_default_policy(bank_login_payload, monkeypatch):
    monkeypatch.delenv("ATHENA_INGRESS_POLICY", raising=False)
    payload = dict(bank_login_payload)
    payload["dom_summary"] = [*payload["dom_summary"], {"path": "input#leak", "value": RAW_CARD}]

    with pytest.raises(IngressRejection):
        enforce(AgentRequest.model_validate(payload))


def test_redact_policy_scrubs_and_continues(bank_login_payload, monkeypatch):
    monkeypatch.setenv("ATHENA_INGRESS_POLICY", "redact")
    payload = dict(bank_login_payload)
    payload["dom_summary"] = [*payload["dom_summary"], {"path": "input#leak", "value": RAW_CARD}]

    cleaned = enforce(AgentRequest.model_validate(payload))
    assert RAW_CARD not in cleaned.model_dump_json()
    assert inspect(cleaned).clean


def test_scrub_leaves_untouched_nodes_alone(bank_login_payload):
    request = AgentRequest.model_validate(bank_login_payload)
    findings = inspect(request).findings
    assert scrub(request, findings) == request


def test_pii_in_the_task_instruction_is_caught(bank_login_payload):
    payload = dict(bank_login_payload)
    payload["task_instruction"] = f"Send a statement to {RAW_EMAIL}"
    report = inspect(AgentRequest.model_validate(payload))
    assert any(f.dom_path == "task_instruction" for f in report.findings)
