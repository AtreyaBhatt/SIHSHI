"""Provider failures degrade to an empty plan, never to a 500 in front of the extension."""

from __future__ import annotations

import asyncio
import json

import anthropic
import httpx
from app.providers.anthropic_vlm import AnthropicProvider
from app.providers.openai_compat import OpenAICompatProvider, _strip_fences

PLAN = {"reasoning_summary": "ok", "actions": [{"action": "wait"}], "requires_client_secret": False}


def test_anthropic_connection_error_is_an_empty_plan(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    provider = AnthropicProvider()

    async def boom(**_):
        raise anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))

    monkeypatch.setattr(provider._client.messages, "parse", boom)
    plan = asyncio.run(provider.plan(system="s", user_text="u", image_b64=None))
    assert plan.actions == []
    assert "unreachable" in plan.reasoning_summary


class _Response:
    def __init__(self, status: int, body: dict | None = None):
        self.status_code = status
        self._body = body or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("bad", request=None, response=None)

    def json(self):
        return self._body


def test_openai_compat_retries_without_response_format_and_strips_fences(monkeypatch):
    provider = OpenAICompatProvider()
    seen: list[dict] = []

    async def fake_post(_self, _client, body):
        seen.append(dict(body))
        if "response_format" in body:
            return _Response(400)
        return _Response(200, {"choices": [{"message": {"content": f"```json\n{json.dumps(PLAN)}\n```"}}]})

    monkeypatch.setattr(OpenAICompatProvider, "_post", fake_post)
    plan = asyncio.run(provider.plan(system="s", user_text="u", image_b64=None))

    assert [("response_format" in b) for b in seen] == [True, False]
    assert plan.actions[0].action == "wait"


def test_openai_compat_network_error_is_an_empty_plan(monkeypatch):
    provider = OpenAICompatProvider()

    async def fake_post(_self, _client, _body):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(OpenAICompatProvider, "_post", fake_post)
    plan = asyncio.run(provider.plan(system="s", user_text="u", image_b64=None))
    assert plan.actions == []


def test_strip_fences_leaves_plain_json_alone():
    assert _strip_fences('{"a": 1}') == '{"a": 1}'
    assert _strip_fences('```json\n{"a": 1}\n```') == '{"a": 1}'
