"""Cloud VLM provider — the default path for the live demo.

Structured output is used rather than prompt-and-parse: `messages.parse` with a
Pydantic output format means a malformed plan is a validation error here instead
of a confusing action rejection three layers down in the planner.
"""

from __future__ import annotations

import logging
import os

import anthropic
from anthropic import AsyncAnthropic

from ..schemas import PlanOutput

logger = logging.getLogger("athena.provider.anthropic")

DEFAULT_MODEL = "claude-opus-5"


class AnthropicProvider:
    name = "anthropic"

    def __init__(self) -> None:
        # Credentials resolve from the environment (ANTHROPIC_API_KEY, an
        # ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
        # A plan is a few hundred tokens; a minute is generous. The SDK's default
        # is ten, which would leave the extension's fetch hanging on a bad day.
        self._client = AsyncAnthropic(timeout=float(os.getenv("ATHENA_MODEL_TIMEOUT", "60")))
        self._model = os.getenv("ATHENA_MODEL", DEFAULT_MODEL)

    async def plan(self, system: str, user_text: str, image_b64: str | None) -> PlanOutput:
        content: list[dict] = []
        if image_b64:
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": image_b64},
            })
        content.append({"type": "text", "text": user_text})

        try:
            response = await self._client.messages.parse(
                model=self._model,
                max_tokens=8000,
                system=system,
                messages=[{"role": "user", "content": content}],
                output_format=PlanOutput,
            )
        except anthropic.APIStatusError as err:
            # Auth, rate limit, bad model id. The class and status are enough to
            # act on; the body is not repeated because it is not ours to log.
            logger.error("anthropic request failed: %s (HTTP %s)", type(err).__name__, err.status_code)
            return _no_plan(f"The reasoning backend rejected the request ({type(err).__name__}, HTTP {err.status_code}).")
        except anthropic.APIConnectionError as err:
            logger.error("anthropic unreachable: %s", type(err).__name__)
            return _no_plan(f"The reasoning backend is unreachable ({type(err).__name__}).")

        # A refusal is a 200 with no usable content. For an action planner the
        # right behaviour is an empty plan, not a fallback to another model:
        # doing nothing is always safe, and the client will re-capture and ask
        # again. Always check stop_reason before reading content.
        if response.stop_reason == "refusal":
            detail = getattr(response, "stop_details", None)
            category = getattr(detail, "category", None)
            logger.warning("model declined to plan (category=%s)", category)
            return _no_plan(f"The model declined to produce a plan (category={category}).")

        if response.parsed_output is None:
            logger.warning("model returned no parseable plan (stop_reason=%s)", response.stop_reason)
            return _no_plan(f"The model returned no usable plan (stop_reason={response.stop_reason}).")
        return response.parsed_output


def _no_plan(reason: str) -> PlanOutput:
    """Doing nothing is always safe; the client re-captures and asks again."""
    return PlanOutput(reasoning_summary=reason, actions=[], requires_client_secret=False)
