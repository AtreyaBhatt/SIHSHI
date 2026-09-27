"""The planner decides what is allowed to reach the user's browser (PRD §6.2.8)."""

from __future__ import annotations

import pytest

from app.action_planner import constrain, requires_client_secret
from app.schemas import AgentAction, AgentRequest, PlanOutput


def _plan(*actions: AgentAction) -> PlanOutput:
    return PlanOutput(reasoning_summary="", actions=list(actions), requires_client_secret=False)


def test_invented_selector_is_dropped(bank_login_payload):
    """The most important guardrail: the model may only target elements the
    client actually sent. Anything else is a path to acting on withheld content."""
    request = AgentRequest.model_validate(bank_login_payload)
    kept, rejected = constrain(_plan(AgentAction(action="click", selector="input#ssn")), request)

    assert kept == []
    assert "was not in dom_summary" in rejected[0]


def test_real_selector_survives(bank_login_payload):
    request = AgentRequest.model_validate(bank_login_payload)
    path = request.dom_summary[0].path
    kept, rejected = constrain(_plan(AgentAction(action="click", selector=path)), request)

    assert rejected == []
    assert kept[0].selector == path


def test_literal_into_a_tier1_field_is_dropped(bank_login_payload):
    """If the server can put a literal into a password box, the server is back in
    the business of handling secrets."""
    request = AgentRequest.model_validate(bank_login_payload)
    password_path = next(
        e.dom_path for e in request.redaction_manifest if e.type == "password"
    )
    kept, rejected = constrain(
        _plan(AgentAction(action="type", selector=password_path, value="hunter2")), request
    )

    assert kept == []
    assert "must use value_ref" in rejected[0]


def test_value_ref_into_a_tier1_field_is_allowed(bank_login_payload):
    request = AgentRequest.model_validate(bank_login_payload)
    password_path = next(
        e.dom_path for e in request.redaction_manifest if e.type == "password"
    )
    kept, rejected = constrain(
        _plan(AgentAction(action="type", selector=password_path, value_ref="user_saved:password")),
        request,
    )

    assert rejected == []
    assert kept[0].value_ref == "user_saved:password"
    assert requires_client_secret(kept)


def test_marker_echo_is_dropped(bank_login_payload):
    request = AgentRequest.model_validate(bank_login_payload)
    path = next(n.path for n in request.dom_summary if n.role == "textbox")
    kept, rejected = constrain(
        _plan(AgentAction(action="type", selector=path, value="[EMAIL_1]")), request
    )

    assert kept == []
    assert "echoes a redaction marker" in rejected[0]


def test_arbitrary_value_ref_is_dropped(bank_login_payload):
    """value_ref names a local credential slot; it is not a smuggling channel."""
    request = AgentRequest.model_validate(bank_login_payload)
    path = next(n.path for n in request.dom_summary if n.role == "textbox")
    kept, rejected = constrain(
        _plan(AgentAction(action="type", selector=path, value_ref="http://evil.example/x")),
        request,
    )

    assert kept == []
    assert "not a user_saved reference" in rejected[0]


def test_type_needs_exactly_one_source(bank_login_payload):
    request = AgentRequest.model_validate(bank_login_payload)
    path = next(n.path for n in request.dom_summary if n.role == "textbox")

    both, rejected_both = constrain(
        _plan(AgentAction(action="type", selector=path, value="x", value_ref="user_saved:u")), request
    )
    neither, rejected_neither = constrain(_plan(AgentAction(action="type", selector=path)), request)

    assert both == [] and neither == []
    assert "exactly one" in rejected_both[0]
    assert "exactly one" in rejected_neither[0]


def test_one_bad_action_does_not_lose_the_plan(bank_login_payload):
    request = AgentRequest.model_validate(bank_login_payload)
    good = next(n.path for n in request.dom_summary if n.role == "button")
    kept, rejected = constrain(
        _plan(
            AgentAction(action="click", selector="button#nope"),
            AgentAction(action="click", selector=good),
        ),
        request,
    )

    assert len(kept) == 1 and kept[0].selector == good
    assert len(rejected) == 1


def test_v2_verbs_survive_and_navigate_is_sensitive(bank_login_payload):
    request = AgentRequest.model_validate(bank_login_payload)
    path = request.dom_summary[0].path
    kept, rejected = constrain(_plan(
        AgentAction(action="hover", selector=path),
        AgentAction(action="key", key="Enter"),
        AgentAction(action="scroll", direction="up"),
        AgentAction(action="navigate", url="https://example.com/x"),
        AgentAction(action="go_back"),
    ), request)
    assert rejected == []
    assert [a.action for a in kept] == ["hover", "key", "scroll", "navigate", "go_back"]
    assert kept[3].risk == "sensitive"


def test_v2_malformed_actions_are_dropped(bank_login_payload):
    request = AgentRequest.model_validate(bank_login_payload)
    path = request.dom_summary[0].path
    kept, rejected = constrain(_plan(
        AgentAction(action="select", selector=path),
        AgentAction(action="navigate", url="javascript:alert(1)"),
        AgentAction(action="hover"),
        AgentAction(action="scroll", selector="input#not-sent"),
    ), request)
    assert kept == []
    assert len(rejected) == 4


def test_key_is_an_enum():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        AgentAction(action="key", key="F5")


def test_value_only_applies_to_type(bank_login_payload):
    request = AgentRequest.model_validate(bank_login_payload)
    path = request.dom_summary[0].path
    kept, rejected = constrain(
        _plan(
            AgentAction(action="click", selector=path, value="x"),
            AgentAction(action="hover", selector=path, value_ref="user_saved:password"),
        ),
        request,
    )
    assert kept == []
    assert all("value / value_ref only apply to type" in r for r in rejected)


@pytest.mark.parametrize(
    "action",
    [
        AgentAction(action="key", key="Enter"),
        AgentAction(action="click", selector="button#submit"),
        AgentAction(action="click", selector="body > header > nav > a:nth-of-type(1)"),
        AgentAction(action="type", selector="input#reg-email", value="a@b.example"),
        AgentAction(action="type", selector="input#password", value_ref="user_saved:password"),
    ],
)
def test_risk_floor_forces_sensitive(bank_login_payload, action):
    request = AgentRequest.model_validate(bank_login_payload)
    kept, rejected = constrain(_plan(action), request)
    assert rejected == []
    assert kept[0].risk == "sensitive"


def test_risk_floor_leaves_routine_alone(bank_login_payload):
    request = AgentRequest.model_validate(bank_login_payload)
    kept, _ = constrain(_plan(
        AgentAction(action="key", key="Tab"),
        AgentAction(action="type", selector="input#customer-id", value="x"),
    ), request)
    assert [a.risk for a in kept] == ["routine", "routine"]
