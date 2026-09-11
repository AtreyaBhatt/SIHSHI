"""build_user_message must tell the model when the capture was truncated."""

from __future__ import annotations

from app.prompt import build_user_message
from app.schemas import AgentRequest


def test_truncated_note_present_when_truncated(bank_login_payload):
    payload = {**bank_login_payload, "truncated": True}
    message = build_user_message(AgentRequest.model_validate(payload))
    assert "this view is partial" in message


def test_truncated_note_absent_by_default(bank_login_payload):
    message = build_user_message(AgentRequest.model_validate(bank_login_payload))
    assert "this view is partial" not in message
