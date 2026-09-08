"""The whole server path: real client payload in, executable plan out."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_healthz_names_the_live_provider():
    body = client.get("/healthz").json()
    assert body["status"] == "ok"
    assert body["provider"] == "mock"
    assert body["ingress_policy"] == "reject"


def test_scenario_a_round_trips(bank_login_payload):
    """PRD §10 Scenario A: the sanitized payload alone must carry enough structure
    to plan a login. If this fails, redaction has destroyed task accuracy."""
    response = client.post("/agent/plan", json=bank_login_payload)
    assert response.status_code == 200
    body = response.json()

    assert body["session_id"] == bank_login_payload["session_id"]
    assert body["actions"], "planner produced no actions from a login form"
    assert body["requires_client_secret"] is True
    assert body["guardrail_rejections"] == []

    verbs = [a["action"] for a in body["actions"]]
    assert "click" in verbs

    # Every selector must be one the client actually sent.
    known = {n["path"] for n in bank_login_payload["dom_summary"]}
    assert all(a["selector"] in known for a in body["actions"] if a.get("selector"))


def test_no_secret_is_ever_returned(bank_login_payload):
    """The server names which credential to use; it never supplies one."""
    body = client.post("/agent/plan", json=bank_login_payload).json()
    password_path = next(
        e["dom_path"] for e in bank_login_payload["redaction_manifest"] if e["type"] == "password"
    )
    typed = [a for a in body["actions"] if a["action"] == "type" and a["selector"] == password_path]

    assert typed, "no action targets the password field"
    assert typed[0].get("value") is None
    assert typed[0]["value_ref"] == "user_saved:password"


def test_payload_with_raw_pii_is_rejected(bank_login_payload):
    payload = dict(bank_login_payload)
    payload["dom_summary"] = [
        *payload["dom_summary"],
        {"path": "input#leak", "value": "4539 1488 0343 6467"},
    ]
    response = client.post("/agent/plan", json=payload)

    assert response.status_code == 422
    body = response.json()
    assert body["error"] == "raw_pii_in_payload"
    assert "4539" not in repr(body)


def test_unknown_fields_are_rejected(bank_login_payload):
    """Strict models mean a client sending a shape we do not understand fails at
    the edge rather than having extra data forwarded to a model."""
    payload = dict(bank_login_payload)
    payload["raw_screenshot"] = "definitely-not-allowed"
    assert client.post("/agent/plan", json=payload).status_code == 422


@pytest.mark.parametrize("verb", ["delete", "navigate", "execute_script"])
def test_action_grammar_is_closed(verb):
    """PRD §3.2: a general automation DSL is an explicit non-goal."""
    from app.schemas import AgentAction

    with pytest.raises(Exception):
        AgentAction.model_validate({"action": verb, "selector": "button#x"})
