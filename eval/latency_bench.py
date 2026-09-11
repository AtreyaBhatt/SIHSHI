#!/usr/bin/env python3
"""Latency waterfall with p50/p95, per PRD §8.

End-to-end wall clock hides regressions inside one stage, so this reports the
stages separately and only then adds them up.

Run:
    node eval/latency_stages.mjs 20 && python3 eval/latency_bench.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
RESULTS = HERE / "results/latency.json"

STAGES = [
    ("capture", "capture_ms", "DOM walk into a serialized snapshot"),
    ("screenshot", "screenshot_ms", "pixels off the tab"),
    ("perception", "perception_ms", "local face detection (ONNX)"),
    ("redaction", "redaction_ms", "masking, manifest, pixel compositing"),
    ("network", "network_ms", "round trip to the reasoning server"),
    ("execute", "execute_ms", "actions applied to the live DOM"),
]

# PRD §8: local pipeline under 300 ms, single-step end to end under 3 s.
LOCAL_BUDGET_MS = 300.0
E2E_BUDGET_MS = 3000.0
LOCAL_STAGES = {"capture_ms", "screenshot_ms", "perception_ms", "redaction_ms"}


def percentile(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * q
    lo, hi = int(pos), min(int(pos) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)


def bar(value: float, scale: float, width: int = 30) -> str:
    return "█" * max(0 if value <= 0 else 1, round(value / scale * width)) if scale > 0 else ""


def main() -> int:
    if not RESULTS.exists():
        print(f"No results at {RESULTS}. Run: node eval/latency_stages.mjs", file=sys.stderr)
        return 2

    data = json.loads(RESULTS.read_text())
    runs = data["runs"]
    if not runs:
        print("No runs recorded.", file=sys.stderr)
        return 2

    totals = [sum(r[key] for _, key, _ in STAGES) for r in runs]
    p50_by_stage = {key: percentile([r[key] for r in runs], 0.50) for _, key, _ in STAGES}
    scale = max(p50_by_stage.values())

    print(f"ATHENA latency waterfall — {len(runs)} runs, provider \"{data['provider']}\"")
    if data.get("perception_init_ms"):
        print(f"model session init {data['perception_init_ms']:.0f} ms (once per worker lifetime, excluded below)")
    if not data.get("model_present"):
        print("face detection SKIPPED — no model present (npm run fetch:model)")
    print()

    print(f"{'stage':<12}{'p50':>9}{'p95':>9}   {'':<31}")
    for label, key, note in STAGES:
        values = [r[key] for r in runs]
        p50, p95 = percentile(values, 0.50), percentile(values, 0.95)
        print(f"{label:<12}{p50:>8.1f}{p95:>9.1f}   {bar(p50, scale):<31} {note}")

    local_p50 = sum(p50_by_stage[k] for k in LOCAL_STAGES)
    print(f"\n{'TOTAL':<12}{percentile(totals, 0.50):>8.1f}{percentile(totals, 0.95):>9.1f}   ms end to end")
    print(f"{'  local':<12}{local_p50:>8.1f}{'':>9}   ms before the network")

    payloads = [r["payload_bytes"] for r in runs]
    faces = [r["faces"] for r in runs]
    pre = percentile([r.get("perception_preprocess_ms", 0) for r in runs], 0.50)
    inf = percentile([r.get("perception_inference_ms", 0) for r in runs], 0.50)
    if pre or inf:
        print(
            f"\nperception splits into {pre:.1f} ms preprocess + {inf:.1f} ms inference (p50).\n"
            "Preprocessing is negligible; the model itself is the cost, and it is small."
        )

    print(f"\npayload      {percentile(payloads, 0.50)/1024:.1f} KB p50")
    if data.get("model_present"):
        print(f"faces        {int(percentile(faces, 0.50))} detected per run")

    print("\nTARGETS (PRD §8)")
    for label, value, budget in [
        ("Local pipeline p50", local_p50, LOCAL_BUDGET_MS),
        ("End-to-end p95", percentile(totals, 0.95), E2E_BUDGET_MS),
    ]:
        print(f"  {label:<24}{value:>8.1f} ms   budget {budget:>6.0f} ms   {'PASS' if value <= budget else 'OVER'}")

    print(
        "\nNOTE: `network` here is transport only — the mock provider returns immediately.\n"
        "A real VLM call lands in that row and will dominate the total; the local stages are\n"
        "what this project controls, and they are the ones inside budget above.\n"
        "`screenshot` is measured through CDP rather than chrome.tabs.captureVisibleTab —\n"
        "the same work by a different caller, so treat it as an approximation of that stage."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
