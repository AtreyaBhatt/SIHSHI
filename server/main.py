"""ATHENA reasoning backend.

    uv run uvicorn main:app --reload --port 8787

Runs with zero configuration on the mock provider. Set ATHENA_PROVIDER=anthropic
for the cloud VLM, or ATHENA_PROVIDER=openai-compat plus ATHENA_VLM_BASE_URL for a
self-hosted Qwen2-VL.
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.ingress import IngressRejection, current_policy, enforce
from app.providers import get_provider
from app.reasoning import plan_actions
from app.schemas import AgentRequest, AgentResponse

logging.basicConfig(
    level=os.getenv("ATHENA_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
)

app = FastAPI(title="ATHENA reasoning backend", version="0.1.0")

# The extension calls from a chrome-extension:// origin. Host permissions already
# let the service worker bypass CORS, so this is here for browser-side tooling
# and local development; tighten it before this is ever exposed off localhost.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("ATHENA_ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


# Resolve the provider now rather than on the first request: a missing SDK, a
# bad ATHENA_PROVIDER value or a constructor error should stop uvicorn at boot,
# not surface as a 500 in front of an audience.
logging.getLogger("athena").info("provider=%s ingress_policy=%s", get_provider().name, current_policy())


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    """Reports which backend is live — a demo must not silently run on the mock."""
    return {
        "status": "ok",
        "provider": get_provider().name,
        "ingress_policy": current_policy(),
    }


@app.post("/agent/plan", response_model=AgentResponse)
async def agent_plan(request: AgentRequest) -> AgentResponse | JSONResponse:
    try:
        # Nothing is logged or forwarded before this returns.
        validated = enforce(request)
    except IngressRejection as rejection:
        return JSONResponse(status_code=422, content=rejection.detail())

    return await plan_actions(validated)
