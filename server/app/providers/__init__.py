"""Provider selection. `PPVA_PROVIDER` is the whole cloud-vs-self-hosted switch."""

from __future__ import annotations

import os
from functools import lru_cache

from .base import VisionProvider


@lru_cache(maxsize=1)
def get_provider() -> VisionProvider:
    choice = os.getenv("PPVA_PROVIDER", "mock").strip().lower()
    if choice == "anthropic":
        from .anthropic_vlm import AnthropicProvider

        return AnthropicProvider()
    if choice in {"openai-compat", "self-hosted", "vllm"}:
        from .openai_compat import OpenAICompatProvider

        return OpenAICompatProvider()

    from .mock import MockProvider

    return MockProvider()


__all__ = ["VisionProvider", "get_provider"]
