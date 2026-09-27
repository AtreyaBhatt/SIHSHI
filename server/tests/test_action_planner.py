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


def test_value_token_for_a_resolvable_tier1_type_is_allowed(bank_login_payload):
    """PAN_1 is Tier 1 but a resolvable type — the model may reference it by
    token, and doing so forces the action sensitive and marks the plan as
    requiring a client-side resolution step."""
    request = AgentRequest.model_validate(bank_login_payload)
    kept, rejected = constrain(
        _plan(AgentAction(action="type", selector="input#pan", value_token="[PAN_1]")), request
    )

    assert rejected == []
    assert kept[0].value_token == "[PAN_1]"
    assert kept[0].risk == "sensitive"
    assert requires_client_secret(kept)


def test_value_token_not_in_the_manifest_is_dropped(bank_login_payload):
    """An id the request never declared, and a non-resolvable Tier 1 type
    (password) both fail the same check."""
    request = AgentRequest.model_validate(bank_login_payload)

    unknown, rejected_unknown = constrain(
        _plan(AgentAction(action="type", selector="input#pan", value_token="[AADHAAR_9]")), request
    )
    not_resolvable, rejected_not_resolvable = constrain(
        _plan(AgentAction(action="type", selector="input#pan", value_token="[PASSWORD_1]")), request
    )

    assert unknown == [] and not_resolvable == []
    assert "not a token from this request" in rejected_unknown[0]
    assert "not a token from this request" in rejected_not_resolvable[0]


def test_value_ref_outside_available_refs_is_dropped(bank_login_payload):
    """available_refs, when non-empty, names every slot the vault actually
    holds. A model may not reference a slot the user never stored — but an
    empty list (a client that predates available_refs) does not gate value_ref
    at all, for backwards compatibility."""
    payload = {**bank_login_payload, "available_refs": ["user_saved:username"]}
    request = AgentRequest.model_validate(payload)

    kept, rejected = constrain(
        _plan(AgentAction(action="type", selector="input#customer-id", value_ref="user_saved:nothing")),
        request,
    )
    assert kept == []
    assert "slot the user has not stored" in rejected[0]

    ok, rejected_ok = constrain(
        _plan(AgentAction(action="type", selector="input#customer-id", value_ref="user_saved:username")),
        request,
    )
    assert rejected_ok == []
    assert ok[0].value_ref == "user_saved:username"

    no_refs_request = AgentRequest.model_validate(bank_login_payload)
    backwards_compatible, rejected_backwards = constrain(
        _plan(AgentAction(action="type", selector="input#customer-id", value_ref="user_saved:anything")),
        no_refs_request,
    )
    assert rejected_backwards == []
    assert backwards_compatible[0].value_ref == "user_saved:anything"


def test_value_token_type_must_match_the_target_field(bank_login_payload):
    """A token only fills a field declared (in the manifest) as holding that same
    type — PAN_1 into the customer-id box, or into the email field, is refused."""
    request = AgentRequest.model_validate(bank_login_payload)
    for selector in ("input#customer-id", "input#reg-email"):
        kept, rejected = constrain(
            _plan(AgentAction(action="type", selector=selector, value_token="[PAN_1]")), request
        )
        assert kept == []
        assert "value_token type does not match the target field" in rejected[0]


def test_value_token_tier_comes_from_the_type_not_the_client(bank_login_payload):
    """The client's entry.tier is not trusted: a password entry claiming Tier 2 is
    still not typeable, and an email entry claiming Tier 1 still is."""
    payload = {**bank_login_payload, "redaction_manifest": [
        {**e, "tier": 2} if e["type"] == "password" else {**e, "tier": 1} if e["type"] == "email" else e
        for e in bank_login_payload["redaction_manifest"]
    ]}
    request = AgentRequest.model_validate(payload)
    password_path = next(e["dom_path"] for e in payload["redaction_manifest"] if e["type"] == "password")
    lied, rejected_lied = constrain(
        _plan(AgentAction(action="type", selector=password_path, value_token="[PASSWORD_1]")), request
    )
    email, rejected_email = constrain(
        _plan(AgentAction(action="type", selector="input#reg-email", value_token="[EMAIL_1]")), request
    )
    assert lied == [] and "not a token from this request" in rejected_lied[0]
    assert rejected_email == [] and email[0].value_token == "[EMAIL_1]"


def test_firewall_minted_token_is_not_typeable(bank_login_payload):
    payload = {**bank_login_payload, "redaction_manifest": [
        {**e, "detector": "firewall:pan"} if e["id"] == "PAN_1" else e
        for e in bank_login_payload["redaction_manifest"]
    ]}
    kept, rejected = constrain(
        _plan(AgentAction(action="type", selector="input#pan", value_token="[PAN_1]")),
        AgentRequest.model_validate(payload),
    )
    assert kept == []
    assert "not a token from this request" in rejected[0]
    ok, rejected_ok = constrain(
        _plan(AgentAction(action="type", selector="input#pan", value_token="[PAN_1]")),
        AgentRequest.model_validate(bank_login_payload),
    )
    assert rejected_ok == [] and ok[0].value_token == "[PAN_1]"
