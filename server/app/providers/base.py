"""Provider interface.

PRD §13 Q4 was answered "both, cloud first": ship against a cloud VLM, keep the
self-hosted open-weights path a configuration change rather than a refactor.
That promise is only real if nothing above this interface knows which one is in
use — so `reasoning.py` sees exactly these three methods and never imports a
concrete provider.
"""

from __future__ import annotations

from typing import Protocol

from ..schemas import PlanOutput


class VisionProvider(Protocol):
    #: Reported in /healthz so a demo cannot silently run on the wrong backend.
    name: str

    async def plan(self, system: str, user_text: str, image_b64: str | None) -> PlanOutput:
        """Return a plan. Implementations must not raise for a model refusal —
        return an empty action list with the reason in reasoning_summary."""
        ...
