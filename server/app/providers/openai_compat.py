"""Self-hosted open-weights VLM (Qwen2-VL, LLaVA-NeXT) behind an OpenAI-compatible
endpoint — what vLLM, SGLang and Ollama all expose.

This is the "offline deployable" path from PRD §11. Selecting it is a change of
two environment variables, which is the whole reason the provider interface
exists. Raw HTTP rather than a client library: there is no vendor SDK for
"whatever is serving Qwen2-VL on this box", and one httpx call is less to keep
working than an SDK pinned for a server we do not control.
"""

from __future__ import annotations

import json
import logging
import os

import httpx

from ..schemas import PlanOutput

logger = logging.getLogger("athena.provider.openai_compat")


class OpenAICompatProvider:
    name = "openai-compat"

    def __init__(self) -> None:
        self._base_url = os.getenv("ATHENA_VLM_BASE_URL", "http://127.0.0.1:8000/v1").rstrip("/")
        self._model = os.getenv("ATHENA_VLM_MODEL", "Qwen/Qwen2-VL-7B-Instruct")
        self._timeout = float(os.getenv("ATHENA_VLM_TIMEOUT", "120"))
        self._api_key = os.getenv("ATHENA_VLM_API_KEY", "not-needed")

    async def plan(self, system: str, user_text: str, image_b64: str | None) -> PlanOutput:
        content: list[dict] = []
        if image_b64:
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{image_b64}"},
            })
        content.append({"type": "text", "text": user_text})

        body = {
            "model": self._model,
            "max_tokens": 2048,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": content},
            ],
            # vLLM and SGLang honour this as guided decoding; servers that don't
            # fall back to best-effort JSON, which the parse below still catches.
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "plan", "schema": PlanOutput.model_json_schema()},
            },
        }

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(
                f"{self._base_url}/chat/completions",
                json=body,
                headers={"Authorization": f"Bearer {self._api_key}"},
            )
            response.raise_for_status()
            payload = response.json()

        text = payload["choices"][0]["message"]["content"]
        try:
            return PlanOutput.model_validate_json(text)
        except Exception:
            logger.warning("self-hosted model returned unparseable JSON; planning nothing")
            return PlanOutput(
                reasoning_summary="The self-hosted model did not return a valid plan.",
                actions=[],
                requires_client_secret=False,
            )
