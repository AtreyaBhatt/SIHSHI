# CLAUDE.md

Guidance for Claude Code (or any agentic coding assistant) working in this repository.

## Project

**Privacy-Preserving Browser-Native Vision Agent (ATHENA)** — a browser extension + server
system that lets a cloud/server VLM/LLM reason about a user's screen and drive UI actions,
without ever receiving raw sensitive/PII visual or textual content. All perception and
redaction happen client-side (in-browser ML via ONNX Runtime Web / Transformers.js); only
sanitized, structured context crosses the network.

Full product spec: `PRD_Privacy_Preserving_Vision_Agent.md` in this repo. **Read that file
before making architectural decisions** — this CLAUDE.md is operational guidance, not a
replacement for the PRD's rationale (threat model in §4, redaction tiers in §4.3, schema
contract in §7, and limitations in §9 especially).

## Repo layout (target — create as you go)

```
/extension          # Manifest V3 browser extension (Chrome, Firefox via WebExtension polyfill)
  /src
    /capture         # DOM snapshot + screenshot capture (content script)
    /perception      # Local ViT / object detector via ONNX Runtime Web
    /pii-detection   # DOM heuristics, regex/NER, BlazeFace face detection
    /redaction       # Pixel-level + text-level redaction engine, manifest generator
    /executor        # Action executor (click/type/scroll/wait) against live DOM
    /background      # Service worker: orchestration, network calls to server
  /models            # Quantized ONNX model weights (gitignored if large; document source)
  manifest.json

/server              # FastAPI backend
  /app
    ingress.py        # Schema validation + PII re-check (defense in depth)
    reasoning.py       # VLM/LLM call, redaction-aware system prompt
    action_planner.py  # Constrains model output to the action JSON schema
  main.py

/eval                # Metrics harness
  corpus/             # Labeled test screenshots + ground-truth PII annotations
  run_eval.py         # Computes precision/recall/F1, IoU-based redaction precision
  latency_bench.py    # Instruments capture → redact → network → reason → execute

PRD_Privacy_Preserving_Vision_Agent.md
CLAUDE.md
```

## The one rule that overrides all others

**The trust boundary is the network call, not the browser.** The local agent (content
script + background worker) is trusted and may read/act on the real, unredacted DOM to
complete tasks. Redaction applies exclusively to what is serialized and sent to the server.
Never "simplify" by redacting the live page or by sending raw data to the server "just for
now" / "to get it working first" — build the redaction step before the first network call
exists, not after.

If you (the coding agent) are about to write code that sends a screenshot, DOM dump, or
extracted text to `fetch()`/`WebSocket` targeting the server, **stop and check**: has it
passed through `redaction/` and does it have a `redaction_manifest` attached? If not, that's
a bug, not a shortcut to fix later.

## Working conventions

### Extension code
- Manifest V3. Content script does capture + local inference + redaction; background
  service worker owns network calls (content scripts have restricted fetch in some
  contexts) and orchestration/session state.
- Never mutate the live page DOM during redaction — redaction operates on a *serialized
  copy* (JSON snapshot + canvas copy of the screenshot). The user's real page must be
  untouched except when the Action Executor deliberately performs a requested action.
- Prefer `MutationObserver`/`IntersectionObserver`-gated triggers over polling or
  per-frame capture — resource utilization is a scored metric (PRD §8).
- All ML inference client-side must go through the ONNX Runtime Web WebGPU execution
  provider with a WASM SIMD fallback — check `navigator.gpu` availability before assuming
  WebGPU; don't hard-fail if it's unavailable.
- Keep model artifacts quantized (int8 where feasible) and document size/latency
  trade-offs made — this gets reported in the eval writeup (PRD §8).

### PII detection & redaction
- Follow the three-tier model in PRD §4.3 exactly (Tier 1 hard-block, Tier 2 mask-but-
  preserve-shape, Tier 3 structural/pass-through). Don't invent new tiers or collapse them
  — the eval corpus and demo script assume this taxonomy.
- Detector order matters for cost: DOM/attribute heuristics first (near-zero cost, highest
  precision), then regex/pattern matchers, then local NER (if implemented), then face
  detection on image regions. Don't run expensive detectors on regions cheap detectors
  already ruled sensitive or already ruled definitely non-sensitive.
- Default thresholds should be conservative (bias toward over-redaction). This is a
  deliberate trade-off stated in the PRD (§9) — don't "tune for recall" by loosening
  thresholds without discussing the precision trade-off.
- Every redacted item must produce a `redaction_manifest` entry per the schema in PRD
  §6.2.4 (id, type, tier, bbox, dom_path, masking). The manifest is what makes the server
  "redaction-aware" — an undocumented redaction is as bad as no redaction, because the
  server can't reason about it.
- Session-scoped tokens (`[EMAIL_1]`, etc.) must be regenerated per session — do not
  persist or reuse token↔value mappings across sessions (PRD §9, point 4).
- Two types exist beyond PRD §4.3's examples: `frame` (Tier 1 — an iframe whose
  contents were never walked; the region is black-boxed and declared) and
  `account_id` (Tier 2 — customer/member/reference ids, usernames; tokenised).
  Snapshot paths may contain ` >>> ` for open shadow roots; resolve them only
  through `shared/resolve-path.ts`, never with a bare `querySelector`.

### Server code
- The ingress layer (`ingress.py`) must independently re-validate incoming payloads
  against PII patterns and reject/re-redact before anything is logged or passed to the
  model — this is defense-in-depth against a buggy or bypassed client, not optional
  scaffolding (PRD §6.2.6).
- The system prompt to the VLM/LLM must explicitly instruct it to treat
  `[REDACTED:*]`/`[TOKEN_N]` markers as opaque and never attempt to infer their contents.
  Any change to this prompt needs a corresponding note in the PRD/eval writeup.
- The action planner must constrain output to the strict JSON action schema (PRD §7.2)
  and must only reference selectors/DOM paths that were present in the manifest sent by
  the client — never let the model invent a selector.
- Secrets (passwords, credentials) are never sent to or returned from the server. Use the
  `value_ref` indirection (PRD §7.2) — the server names *which* locally-stored credential
  to use; the client resolves it locally. If you find yourself passing an actual secret
  value through a request/response body, stop — that's the one line this project cannot
  cross.

### Eval / metrics
- Every PII detector or redaction change should be checked against `/eval/corpus` before
  being considered done — report precision/recall/F1 and IoU-based redaction precision,
  not just "seems to work" (PRD §8 has target numbers).
- Latency changes should be measured with `latency_bench.py`'s stage breakdown (capture →
  local inference → redaction → network round-trip → server reasoning → action execution),
  not just wall-clock end-to-end — regressions often hide in one stage.
- When adding a new PII category or model, add corresponding labeled examples to
  `/eval/corpus` in the same change — don't let the eval corpus drift behind the detector
  code.

## Explicit non-goals (don't build these without discussion — see PRD §3.2)
- Cross-browser support beyond Chrome + Firefox.
- A general-purpose automation DSL beyond click/type/scroll/read/wait.
- Cryptographic/formally-verified privacy guarantees (secure enclaves, homomorphic
  inference) — this is a heuristic redaction pipeline, not a zero-trust system. Don't
  describe it as one in code comments, docs, or demo copy.
- Multi-tab/multi-window orchestration.
- On-device model fine-tuning/personalization.

## When in doubt
Re-read PRD §9 (Limitations & Honest Trade-offs) before making a claim in code comments,
README text, or demo copy about what this system guarantees. Overclaiming privacy
guarantees is worse than underclaiming — state what's heuristic as heuristic.
