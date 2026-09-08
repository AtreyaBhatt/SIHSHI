# Product Requirements Document
## Privacy-Preserving Browser-Native Vision Agent (PPVA)

**Version:** 0.1 (Draft for hackathon build)
**Owner:** [Team name]
**Date:** September 2026
**Status:** Draft — ready for engineering kickoff

---

## 1. Summary

PPVA is a browser extension paired with a cloud/server reasoning backend that lets an AI agent understand and act on a user's screen — reading page structure, screenshots, and UI state — without ever transmitting sensitive or personally identifiable visual/textual content off the device. All perception happens locally via lightweight in-browser ML (ONNX Runtime Web / Transformers.js, optionally WebGPU-accelerated). A local redaction layer strips or masks PII before any network call. Only the sanitized, structurally-rich context is sent to a server-side VLM/LLM, which returns a small, auditable action plan (click / type / scroll / read) that the extension executes locally.

The core bet: **you can get most of the reasoning benefit of a large cloud model while giving up almost none of the user's privacy**, by splitting the pipeline at exactly the point where perception ends and reasoning begins — and doing the redaction on the perception side, in a browser sandbox the user already trusts.

---

## 2. Problem Statement

### 2.1 Background
Agentic AI systems that can see and act on a user's screen (browser copilot agents, RPA-style assistants, accessibility agents) are becoming common. Nearly all production systems today send full screenshots or DOM dumps to a server-hosted model to decide what to do next. This creates a hard privacy problem:

- Screens routinely contain passwords, OTPs, card numbers, health data, private messages, faces (in video calls, photos), government ID numbers, and more.
- Users and enterprises are increasingly unwilling (and in regulated industries, legally unable) to ship this data to third-party servers, even transiently.
- On-device-only models are not yet capable enough to do the heavy reasoning (multi-step planning, complex instruction following) that makes these agents useful.

### 2.2 Opportunity
Modern browsers now expose WebGPU, WASM SIMD, and mature JS ML runtimes (ONNX Runtime Web, Transformers.js, TensorFlow.js) that can run small-to-medium vision models (face detectors, lightweight ViTs, OCR, layout parsers) locally at interactive latency. This makes it possible to do all *perception and redaction* on-device, and send only a sanitized, structured, non-reidentifiable context to the cloud for the *reasoning and planning* step.

### 2.3 Target users
- **Primary (hackathon judges' framing):** any end user of a browser-based AI agent who wants task automation (form filling, navigation, data extraction, workflow completion) without exposing personal/sensitive data to a third-party server.
- **Secondary personas for demo purposes:**
  - A user filling a government/banking form (Aadhaar, PAN, card numbers).
  - A user on a video-call-embedded page (faces visible on screen).
  - An enterprise employee using an internal dashboard with customer PII.

---

## 3. Goals and Non-Goals

### 3.1 Goals (in priority order, aligned to evaluation rubric)
| # | Goal | Rationale |
|---|---|---|
| G1 | High-precision, high-recall detection of sensitive/PII elements on screen (text + visual) | 20% of eval score; also the ethical core of the product |
| G2 | High-precision redaction — sensitive regions fully and only sensitive regions removed | 20% of eval score |
| G3 | Accurate screen/context understanding sent to the server (agent still completes the task correctly) | Core "accuracy of visual context" metric |
| G4 | Low client-side resource utilization (CPU/GPU/memory) | 20% of eval score; also determines real-world adoptability |
| G5 | Low end-to-end task latency | 15% of eval score |
| G6 | Demonstrate one complete, realistic end-to-end task | Required deliverable |

### 3.2 Non-goals (explicitly out of scope for v0.1 / hackathon)
- Supporting every browser (Chrome + Firefox via WebExtensions API is sufficient; Safari/Edge out of scope for now).
- A generalized action DSL supporting arbitrary automation (keep to click/type/scroll/read/wait).
- Full formal differential-privacy or cryptographic guarantees — this is a practical redaction pipeline, not a formally verified privacy system (should be stated clearly to judges to avoid overclaiming).
- Multi-tab / multi-window orchestration.
- On-device fine-tuning or personalization of models.
- Handling adversarial users trying to *defeat* their own redaction (out of scope; the threat model is "don't leak PII to the server by default," not "prevent a malicious user from disabling their own privacy tool").

---

## 4. Threat Model and Privacy Definition

Being explicit about the threat model is itself a deliverable — judges are scoring PII precision/recall and redaction precision, which only makes sense against a stated model.

### 4.1 What we protect against
- **Server-side data exposure**: the server (and anything logging its traffic — provider logs, network intermediaries, breach of the server) should never receive raw PII, raw faces, or raw credential material.
- **Accidental over-collection**: screenshots/DOM dumps sent for "what's on this page" reasoning should not incidentally carry sensitive fields just because they happened to be in the viewport.

### 4.2 What we do NOT protect against (explicitly out of scope, state this to avoid overclaiming)
- A user or malicious extension reading data before it hits our pipeline (browser compromise).
- A server operator that ignores the redaction manifest and asks a human to guess redacted content from context (a determined server-side adversary could try to infer things — we reduce, not eliminate, this risk; see §9 Limitations).
- Side-channel leakage via timing or DOM structure metadata alone (e.g., input field named "password" reveals the field is a password field, but not its value — this is treated as acceptable structural leakage, not PII).

### 4.3 Definition of "sensitive/PII" for this project
We define three tiers, since not everything needs the same treatment:

| Tier | Examples | Treatment |
|---|---|---|
| **Tier 1 — Hard-block (never leaves device)** | Passwords, OTPs/2FA codes, credit/debit card numbers, CVV, government ID numbers (Aadhaar/PAN/SSN-equivalent), biometric imagery (faces) | Full redaction; value replaced with typed placeholder token, pixels blacked out/blurred |
| **Tier 2 — Mask but preserve shape** | Emails, phone numbers, physical addresses, names in form labels | Partially masked (e.g., `j***@***.com`) or tokenized (`[EMAIL_1]`) so the server can still reason about "this is a login form" without seeing the value |
| **Tier 3 — Structural, not sensitive** | Button labels, field names/types, page layout, non-personal headings | Sent as-is |

---

## 5. User Stories

1. **As a user filling a bank transfer form**, I want the agent to help me find and click "Confirm Transfer" without my account number or IFSC code ever being sent to the cloud model.
2. **As a user on a page with an embedded video/photo**, I want any visible faces automatically blurred before any screen data leaves my machine.
3. **As a user typing a password**, I want the agent to never see or transmit the password value, even though it can see that a password field exists and is focused.
4. **As a developer/judge evaluating this system**, I want to see, for any given screen, exactly what was detected as sensitive, exactly what was redacted, and exactly what was sent to the server — a transparent audit trail.
5. **As a user**, I want the agent to still successfully complete multi-step tasks (e.g., "find and submit this form") despite redaction, because the server has enough structural context to reason correctly.

---

## 6. System Architecture

### 6.1 High-level diagram (textual)

```
┌───────────────────────────── BROWSER (client) ─────────────────────────────┐
│                                                                              │
│  ┌───────────────┐   ┌─────────────────────┐   ┌──────────────────────┐    │
│  │ Capture Layer  │──▶│ Local Perception     │──▶│ PII Detection Layer  │    │
│  │ - DOM snapshot │   │ Layer                │   │ - DOM/attribute       │    │
│  │ - Screenshot   │   │ - Local ViT / object │   │   heuristics          │    │
│  │   (canvas)     │   │   detector (ONNX RT  │   │ - Regex/NER on text   │    │
│  │ - Accessibility│   │   Web / Transformers │   │   nodes               │    │
│  │   tree         │   │   .js, WebGPU/WASM)  │   │ - BlazeFace (faces)   │    │
│  └───────────────┘   │ - OCR (if needed)     │   │ - Confidence scoring  │    │
│                       └─────────────────────┘   └──────────┬───────────┘    │
│                                                              ▼               │
│                                              ┌───────────────────────────┐   │
│                                              │ Redaction Engine           │   │
│                                              │ - Pixel-level (blur/box)   │   │
│                                              │ - Text-level (mask/token)  │   │
│                                              │ - Redaction manifest gen   │   │
│                                              └─────────────┬─────────────┘   │
│                                                             ▼                │
│                                              ┌───────────────────────────┐   │
│                                              │ Local Policy Cache /       │   │
│                                              │ Change Detector            │   │
│                                              │ (MutationObserver — only   │   │
│                                              │ re-run pipeline on         │   │
│                                              │ meaningful DOM change)     │   │
│                                              └─────────────┬─────────────┘   │
└────────────────────────────────────────────────────────────┼────────────────┘
                                                               │ HTTPS/WSS
                                                               │ (sanitized image +
                                                               │  structured JSON +
                                                               │  redaction manifest)
                                                               ▼
┌────────────────────────────── SERVER (cloud) ───────────────────────────────┐
│  ┌───────────────┐   ┌─────────────────────┐   ┌──────────────────────┐     │
│  │ Ingress /      │──▶│ Redaction-Aware      │──▶│ Action Planner /      │     │
│  │ Schema         │   │ VLM/LLM Reasoning    │   │ Response Formatter    │     │
│  │ Validator      │   │ (Qwen2-VL / LLaVA /  │   │ - JSON action schema  │     │
│  │ (rejects if    │   │  cloud VLM API)      │   │ - Guardrails: no      │     │
│  │  raw PII       │   │ - Prompted to treat  │   │   token pass-through  │     │
│  │  patterns      │   │   redaction markers  │   │                        │     │
│  │  detected)     │   │   as opaque          │   │                        │     │
│  └───────────────┘   └─────────────────────┘   └──────────┬───────────┘     │
└──────────────────────────────────────────────────────────┼─────────────────┘
                                                              │ action plan (JSON)
                                                              ▼
                                          Content script executes action locally
                                          (click / type-safe-value / scroll / wait)
                                          Loop back to Capture Layer if task incomplete
```

### 6.2 Component breakdown

#### 6.2.1 Capture Layer (client)
- **DOM snapshot**: serialize visible DOM subtree — tag, role, aria-label, type, bounding rect, visible text — via `document.elementsFromPoint` sampling or a full accessibility-tree walk.
- **Screenshot**: `chrome.tabCapture` (MV3 service worker) or `html2canvas` fallback for simple pages.
- **Trigger strategy**: use `MutationObserver` + `IntersectionObserver` to avoid re-capturing on every pixel change; debounce to ~300–500ms after DOM settles, or on explicit user action ("ask agent").

#### 6.2.2 Local Perception Layer (client)
- **Local vision model**: a small ViT (e.g., quantized `vit-tiny`/`mobilevit`) or a lightweight object/UI-element detector run via ONNX Runtime Web with the WebGPU execution provider (fallback to WASM SIMD if WebGPU unavailable). Purpose: classify screen regions (form, media, text block, navigation) to help both task understanding and to prioritize where the PII detector should look.
- **OCR (optional, if needed for canvas/image-only text)**: Tesseract.js or a small ONNX OCR model, only invoked on image regions that DOM parsing can't already give us text for.

#### 6.2.3 PII Detection Layer (client) — the core of the privacy guarantee
Layered detectors, cheapest/most-precise first:

1. **DOM/attribute heuristics (highest precision, near-zero cost)**
   `input[type=password]`, `input[autocomplete*=cc-]`, `name`/`id` containing `ssn|aadhaar|pan|card|cvv|otp`, `type=email`, `type=tel`.
2. **Regex/pattern matchers on extracted text nodes**
   Emails, phone numbers (locale-aware), credit card number patterns (Luhn-validated), national ID formats (configurable per-locale), IBAN/account-number-like digit runs.
3. **Lightweight local NER (optional stretch goal)**
   A distilled/quantized token-classification model (e.g., a small BERT PII model exported to ONNX) for names/addresses in free text that regex can't catch.
4. **Local face detector**
   BlazeFace (TF.js) or an ONNX-exported equivalent — real-time, sub-10ms inference, runs on any screenshot/video-frame region.
5. **Confidence aggregation**
   Each candidate gets a confidence score and a tier (see §4.3). Anything above a configurable threshold (default conservative — biased toward over-redaction) is passed to the Redaction Engine.

#### 6.2.4 Redaction Engine (client)
- **Pixel-level**: canvas operations — Gaussian blur (`filter: blur(Npx)`) or solid black-box fill over bounding boxes for Tier 1 visual PII (faces, on-screen card images).
- **Text/DOM-level**: replace text-node content in the serialized snapshot (never the live page DOM — we must not mutate what the user sees) with:
  - Tier 1: `[REDACTED:<type>]` (e.g., `[REDACTED:PASSWORD]`)
  - Tier 2: partial mask (`j***@***.com`) or stable token (`[EMAIL_1]`) — stable per-session so the server can refer back to "the email field" across turns without re-identifying it.
- **Redaction manifest**: a JSON side-channel sent alongside the sanitized payload, describing *what kind* of thing was redacted and *where* (bounding box / DOM path), but never the value. This is what makes the server "redaction-aware."

Example manifest entry:
```json
{
  "id": "EMAIL_1",
  "type": "email",
  "tier": 2,
  "bbox": [120, 340, 260, 360],
  "dom_path": "form#login > input#user-email",
  "masking": "partial"
}
```

#### 6.2.5 Local Policy Cache / Change Detector (client)
- Avoids re-running the full pipeline on every frame; only triggers a new capture+redact+send cycle when the DOM meaningfully changes (new modal, navigation, form state change) or the server explicitly requests a fresh read (e.g., after executing an action, to verify success).

#### 6.2.6 Server: Ingress / Schema Validator
- A defense-in-depth check: even though the client redacts, the server validates incoming payloads against the same regex/PII patterns and **rejects or re-redacts** any payload that still contains obvious PII patterns before it ever reaches the model or is logged. This protects against client-side bugs or bypass.

#### 6.2.7 Server: Redaction-Aware VLM/LLM Reasoning
- System prompt explicitly instructs the model: treat `[REDACTED:*]` and `[TOKEN_N]` markers as opaque placeholders; do not attempt to infer their contents; use only visible structure, labels, and layout to decide the next action.
- Model choice: open-weights VLM (Qwen2-VL, LLaVA-NeXT, InternVL) self-hostable for the "offline deployable" requirement; cloud-hosted equivalent permitted during live demo per the problem statement.

#### 6.2.8 Server: Action Planner / Response Formatter
- Constrains model output to a strict JSON schema (small action grammar) — reduces hallucination risk and makes execution deterministic.
- Guardrail: action targets must reference DOM paths/selectors that were present in the manifest sent to the server — the planner cannot invent a selector that wasn't in the sanitized context (prevents a subtle path for exfiltration or misdirected actions).

#### 6.2.9 Client: Action Executor
- Executes the returned action against the **real, unredacted live DOM** (the redaction was only ever applied to the copy sent to the server — the extension itself, running locally, still has full access to the real page to actually complete the task, e.g., typing a real password the user provides, which never had to be sent anywhere).
- This is an important architectural point worth stating clearly in the PRD: **redaction applies to what's sent over the network, not to what the local agent can see/do** — the local agent is trusted (it's the user's own browser), the network boundary is the trust boundary.

---

## 7. Action Schema (client ⇄ server contract)

### 7.1 Client → Server request
```json
{
  "session_id": "uuid",
  "task_instruction": "Fill and submit the login form using my saved credentials",
  "screenshot_redacted": "<base64 PNG, PII regions blurred/boxed>",
  "dom_summary": [
    {"path": "input#username", "role": "textbox", "label": "Username", "value": null},
    {"path": "input#password", "role": "textbox", "label": "Password", "value": "[REDACTED:PASSWORD]"},
    {"path": "button#submit", "role": "button", "label": "Log In"}
  ],
  "redaction_manifest": [ /* see §6.2.4 */ ],
  "prior_actions": [ /* history for multi-step tasks */ ]
}
```

### 7.2 Server → Client response
```json
{
  "session_id": "uuid",
  "reasoning_summary": "This is a login form; username field is empty, password is redacted but present.",
  "actions": [
    {"action": "focus", "selector": "input#username"},
    {"action": "type", "selector": "input#username", "value_ref": "user_saved:username"},
    {"action": "click", "selector": "button#submit"}
  ],
  "requires_client_secret": true
}
```

Note the `value_ref` indirection for Tier 1 fields: the server never supplies actual secret values — it only says *which* locally-stored credential reference to use, and the **client** resolves `value_ref` to a real value from the browser's own credential store (e.g., `chrome.password_manager` equivalent / user-provided local vault), never round-tripping the secret through the server at all.

---

## 8. Metrics & Evaluation Plan

Mapped directly to the stated rubric so both the team and judges can verify against the same numbers.

| Metric | Weight | Definition | How we'll measure it |
|---|---|---|---|
| Accuracy of visual context extraction | (part of overall) | Does the structured context sent to the server correctly reflect the real page (element roles, labels, layout)? | Manual-labeled test set of ~30 screens; compare extracted DOM summary vs. ground truth; report F1 |
| PII detection recall/precision | 20% | Of all PII instances in a labeled test set, how many are correctly flagged (recall), and of all flagged items, how many are truly PII (precision)? | Build a labeled corpus (≥50 screenshots spanning forms, chat UIs, dashboards, video-call mockups) with hand-annotated PII bounding boxes/text spans; compute precision/recall/F1 per PII type and overall |
| Redaction precision | 20% | Of the regions redacted, what fraction *should* have been redacted (i.e., we didn't over-redact non-sensitive content)? | Same corpus; compare redacted bounding boxes against ground-truth PII boxes using IoU threshold (e.g., ≥0.5) to count true/false redactions |
| Client-side resource utilization | 20% | CPU%, memory (MB), GPU utilization during pipeline run; model load time; steady-state idle cost | Chrome Task Manager + `performance.memory` + `chrome://tracing`; report peak and average across the demo task; report model size (MB) and quantization used |
| End-to-end task latency | 15% | Time from "agent triggered" to "task action executed," broken down by stage (capture → local inference → redaction → network round-trip → server reasoning → action execution) | Instrument each stage with `performance.now()` timestamps; report a latency waterfall for the demo task, plus p50/p95 over N runs |
| Task success (qualitative, supports the "end-to-end task" requirement) | — | Did the agent complete the demonstrated task correctly despite redaction? | Live demo + recorded runs across the 3 demo scenarios (§10) |

**Target numbers to aim for (hackathon-realistic, not final):**
- PII recall ≥ 0.90 on Tier 1 categories (password/OTP/card/ID) — false negatives here are the worst failure mode.
- PII precision ≥ 0.80 overall (some over-redaction is an acceptable trade-off vs. leakage).
- Redaction IoU-based precision ≥ 0.85 on Tier 1.
- Client steady-state CPU overhead < 15% on a mid-range laptop; model payload < 20MB total (quantized).
- End-to-end latency < 3s for a single-step action on a typical form page (dominated by server VLM call, not local pipeline — local pipeline should be < 300ms).

---

## 9. Limitations & Honest Trade-offs (for the write-up / judges)

Stating these explicitly is a strength, not a weakness, in a rubric-scored evaluation — it shows the team understands the boundaries of what they built.

1. **Redaction is heuristic, not provably complete.** A sufficiently novel PII format (e.g., an uncommon national ID format not in our regex library) could slip through. Mitigated by conservative thresholds and the server-side re-validation layer, but not eliminated.
2. **Local models are smaller/weaker than server models by necessity**, trading some detection accuracy for the ability to run in-browser at interactive latency. We quantify this gap explicitly (§8) rather than hiding it.
3. **The server is trusted to honor the redaction contract** (i.e., not attempt adversarial reconstruction of redacted content from context clues). We add technical friction (schema validation, redaction-aware prompting) but this is ultimately a trust boundary, not a cryptographic guarantee — true zero-trust would require something like secure enclaves or homomorphic inference on the server side, which is out of scope for this hackathon build.
4. **Stable per-session tokens (`[EMAIL_1]`) reduce re-identification risk within a session but are not anonymous across sessions** if reused; tokens should be regenerated per session.
5. **Face blurring protects against casual visual exposure but does not protect against voice, filenames, or other non-visual identity leaks** on the same page — out of scope for a *vision* agent, but worth naming as a boundary.

---

## 10. Demo Plan (end-to-end task scenarios)

Pick at least one, ideally two, for the live demo:

**Scenario A — Form-filling with credential protection**
User asks the agent to "log me into this test banking portal." Screen shows a username/password form. Agent detects the password field (Tier 1, DOM heuristic), redacts it in both the screenshot and DOM summary, sends sanitized context to server, server returns a plan (`focus username → type username → focus password → [client resolves credential locally] → click submit`), client executes. Judges see: raw screen → redacted payload (side-by-side) → server response → successful login.

**Scenario B — Video-call-style page with visible faces**
Mock page with an embedded video thumbnail/photo grid. Agent detects faces via BlazeFace, blurs them in the screenshot before sending, server is asked to "find and click the 'mute' button," succeeds without ever receiving unblurred faces.

**Scenario C — Government form with structured PII (Aadhaar/PAN/phone/email)**
A mock KYC-style form. Agent masks Aadhaar/PAN number fields and email/phone (Tier 1/2), server is asked to "check which required fields are still empty and tell me what to fill next," and correctly reasons about the form despite never seeing actual values.

For each scenario, the demo should show, side by side: (1) raw screen, (2) what was detected as sensitive (overlay with bounding boxes + labels), (3) the exact payload sent to the server, (4) the server's response, (5) the resulting action on screen. This visual "diff" is likely to be the single most persuasive artifact for judges scoring PII precision/recall and redaction precision.

---

## 11. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Extension framework | Manifest V3 (Chrome), WebExtensions-compatible (Firefox) | Content script + background service worker |
| Screenshot capture | `chrome.tabCapture` / `html2canvas` fallback | |
| Local inference runtime | ONNX Runtime Web (WebGPU EP, WASM SIMD fallback) + Transformers.js | |
| Local vision model | Quantized ViT-tiny / MobileViT (screen understanding); BlazeFace (faces) | int8 quantized where possible |
| Local OCR (optional) | Tesseract.js or small ONNX OCR model | Only for image-embedded text |
| Local NER (stretch) | Distilled BERT PII model, ONNX-exported | |
| Server framework | FastAPI (Python) | |
| Server VLM/LLM | Qwen2-VL / LLaVA-NeXT (self-hosted, open-weights) or cloud VLM API for live demo | Per hackathon rules, cloud allowed during SIH |
| Client↔server transport | HTTPS (or WSS for lower-latency iterative loops) | |
| Metrics/instrumentation | Chrome Task Manager, `performance.now()`/`performance.memory`, custom logging | |

---

## 12. Milestones (hackathon timeline)

| Phase | Deliverable |
|---|---|
| M1 | Extension scaffold; DOM snapshot + screenshot capture working; manual trigger |
| M2 | DOM-heuristic + regex PII detection layer; redaction manifest format finalized |
| M3 | Local ViT/BlazeFace integrated via ONNX Runtime Web; visual redaction (blur/box) working |
| M4 | Server skeleton (FastAPI) + redaction-aware prompt + action schema; end-to-end round trip on Scenario A |
| M5 | Metrics instrumentation (latency waterfall, resource monitor); labeled test corpus + precision/recall numbers |
| M6 | Scenarios B & C; polish side-by-side demo visualization; write-up and final numbers |

---

## 13. Open Questions

1. Do we need Firefox parity for the hackathon demo, or is Chrome-only acceptable given time constraints? (Affects `tabCapture` API differences.)
2. Should credential resolution (`value_ref`) integrate with the browser's native password manager, or use a simple local mock vault for the demo?
3. How conservative should the default redaction threshold be — do we bias hard toward over-redaction (safer, may reduce task accuracy) or tune for balance? Recommend defaulting conservative and making it a visible, judge-demonstrable slider.
4. Self-host the VLM for the "offline deployable" requirement, or rely on cloud API and just document the self-hosted path as feasible? (Time/GPU-budget dependent.)
