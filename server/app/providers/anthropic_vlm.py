"""Cloud VLM provider — the default path for the live demo.

Structured output is used rather than prompt-and-parse: `messages.parse` with a
Pydantic output format means a malformed plan is a validation error here instead
of a confusing action rejection three layers down in the planner.
"""

from __future__ import annotations

import logging
import os

from anthropic import AsyncAnthropic

from ..schemas import PlanOutput

logger = logging.getLogger("ppva.provider.anthropic")

DEFAULT_MODEL = "claude-opus-5"


class AnthropicProvider:
    name = "anthropic"

    def __init__(self) -> None:
        # Credentials resolve from the environment (ANTHROPIC_API_KEY, an
        # ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
        self._client = AsyncAnthropic()
        self._model = os.getenv("PPVA_MODEL", DEFAULT_MODEL)

    async def plan(self, system: str, user_text: str, image_b64: str | None) -> PlanOutput:
        content: list[dict] = []
        if image_b64:
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": image_b64},
            })
        content.append({"type": "text", "text": user_text})

        response = await self._client.messages.parse(
            model=self._model,
            max_tokens=8000,
            system=system,
            messages=[{"role": "user", "content": content}],
            output_format=PlanOutput,
        )

        # A refusal is a 200 with no usable content. For an action planner the
        # right behaviour is an empty plan, not a fallback to another model:
        # doing nothing is always safe, and the client will re-capture and ask
        # again. Always check stop_reason before reading content.
        if response.stop_reason == "refusal":
            detail = getattr(response, "stop_details", None)
            category = getattr(detail, "category", None)
            logger.warning("model declined to plan (category=%s)", category)
            return PlanOutput(
                reasoning_summary=f"The model declined to produce a plan (category={category}).",
                actions=[],
                requires_client_secret=False,
            )

        return response.parsed_output
