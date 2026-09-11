# ATHENA — pitch script and project breakdown

For whoever has to explain this project: a judge panel, a teammate joining
late, or yourself the night before. Everything here is true of the code on
`hopefully_final` today; the roadmap section says what is in progress.

---

## 1. The 30-second version

> Browser agents are getting good at doing things on your screen — filling forms,
> navigating sites, completing tasks. Every one of them works by sending your
> screen to a cloud model. That screen has your password field, your card
> number, your Aadhaar, your face in a video call.
>
> ATHENA splits the agent in two. **Perception and redaction run in the
> browser.** Only a sanitized, structured description of the page crosses the
> network. The model reasons over that and sends back a small, auditable plan
> — click this, type into that — and the browser executes it against the real
> page, with the real values, locally.
>
> The model never sees the password. The browser still types it.

If you only get one sentence: **the trust boundary is the network call, not
the browser.**

## 2. The problem, in the judges' terms

- Agentic AI on screens is the next interface. Almost every product ships full
  screenshots or DOM dumps to a server.
- Screens routinely contain Tier-1 secrets (passwords, OTPs, card numbers,
  government IDs, faces) and Tier-2 identifiers (emails, phones, addresses,
  names).
- Regulated users can't send that; ordinary users shouldn't have to.
- On-device models can't yet do the multi-step reasoning that makes agents
  useful. So the reasoning has to be remote — and the data can't be.

## 3. The insight

An agent is two jobs glued together: **seeing** (what's on the page, where
things are, what kind of thing each field is) and **deciding** (what to do next
to achieve the goal). Seeing is cheap and local-friendly — small models, DOM
heuristics, regex, checksums. Deciding needs a big model.

Split exactly there. Do all seeing on-device, redact on-device, and send the
model a *description* rich enough to decide but stripped of every value it
must never learn. The model gets "there is a password field at `input#password`
and it is filled"; it never gets the password.

Two consequences that make the demo land:

1. **Redaction is on what is sent, not on what the browser can do.** The
   extension is the user's own browser; it is trusted. So when the model says
   "type the saved password into `input#password`", the browser resolves
   `user_saved:password` from a local vault and types the real value. The
   secret never left the machine and never had to.
2. **Every redaction is declared.** The payload carries a manifest — *what
   kind* of thing was removed and *where*, never the value — so the model is
   "redaction-aware": it reasons about a login form it cannot fully see
   instead of hallucinating around a hole.

## 4. How it works (walk the pipeline)

```
content script            service worker               offscreen doc        model provider
─────────────────         ───────────────────          ─────────────        ──────────────
capture DOM snapshot  →   screenshot (captureVisibleTab)
(viewport only,           face detection ────────────→ UltraFace, ONNX
 open shadow roots,       ←──── face boxes ───────────  Runtime Web (WASM)
 iframes as frames)       PII cascade:
                            1 DOM/attribute heuristics (16 rules, near-free, highest precision)
                            2 regex + checksums (Luhn, Verhoeff), context-gated
                            3 [NER — roadmap]
                            4 faces (pixels only)
                          redaction: text → [REDACTED:TYPE] / [EMAIL_1] / g***@***.org
                                     pixels → black box / blur
                                     manifest ← one entry per redaction
                          egress gate: re-scan the finished payload, refuse to send on a hit
                          ─────────────────────────── sanitized payload ──────────────────→   reason
                          ←──────────────────────── action plan (JSON) ───────────────────
                          guardrails: selectors must be ones we sent; Tier-1 fields via value_ref only
                          resolve value_ref from local vault
execute on the real DOM ←  (click / type / …)
```

Things to say while pointing at it:

- **Cheapest, most precise detector first.** `type="password"` is not a guess.
  Regex runs only on what the heuristics did not already claim. Faces cost the
  most and run last, on image regions only. This is why the local pipeline is
  ~66 ms, not seconds.
- **Three tiers, from the PRD.** Tier 1 hard-block (never leaves; `[REDACTED:PASSWORD]`,
  black box; frames and trimmed regions the walk never scanned are declared here
  too). Tier 2 mask-but-keep-shape (`[EMAIL_1]`, `a***@***.org`) so the
  model still knows "this is an email field". Tier 3 structure (labels,
  buttons, headings) passes through — the model needs it to act.
- **Fail closed, twice.** The payload builder re-scans its own output with the
  self-validating patterns and throws rather than ship a leak. The server (or,
  after the serverless move, an independent egress check) does it again with a
  separately written pattern set, so one bug cannot defeat both.
- **The model cannot invent a target.** Every selector in the plan must be one
  the client sent; both sides check. It cannot put a literal into a Tier-1
  field; it must name a `value_ref`. It cannot echo a `[TOKEN]` as a value.
- **Sessions, not identities.** `[EMAIL_1]` means the same thing across turns
  in one session and is regenerated for the next, so tokens never become a
  stable pseudonym.

## 5. Demo script

Setup (before you start talking): server running on :8787, fixtures served on
:8080, extension loaded, vault slots `username`/`password` filled, side panel
open. Have the **Demo view** tab ready — three columns: what was on screen,
what was detected, what was sent.

**Scenario A — credentials (2 min).** Open `bank-login.html`. Say the task:
*"Log me in to this portal."* Click **Ask ATHENA**.
- Point at the detections: password (Tier 1, DOM heuristic), PAN, account
  number, IFSC, card (Luhn-valid), email, phone, name, customer ID.
- Open **View what will be shared**: the request body. Show `input#password`
  → `[REDACTED:PASSWORD]`, the email → `a***@***.org`, the manifest table.
  *"This is the exact byte string that crossed the network."*
- Show the plan: `type input#customer-id value_ref:user_saved:username`,
  `type input#password value_ref:user_saved:password`, `click button#submit`.
  *"The server said WHICH credential to use. It never saw either."*
- Approve. The real form fills and submits. *"Task done; secret never left."*

**Scenario B — faces (1 min).** Open `video-call.html`. Task: *"Find and click
mute."* Show the redacted screenshot: six tiles, six blurred faces, the button
row intact. Say: the blur radius is tuned so the detector itself cannot re-find
the faces (that's a test in the repo, 22 → 0). The plan clicks `button#mute`.

**Scenario C — structured PII (1 min).** Open `kyc-form.html`. Task: *"Which
required fields are still empty?"* Show Aadhaar (Verhoeff-checked), PAN, DOB,
phone, address masked; table cells masked by their `<th>` context; the prose
paragraph with the phone and email caught by regex — and the name and address
in prose **not** caught. Say it out loud: *"That is our known recall gap; the
NER stage that closes it is on the roadmap. We report it, we don't hide it."*

**Close (30 s).** Threshold slider: drag left → more redaction; *"the bias is
deliberate — PRD §9 — over-redact rather than leak."* Then the eval table.

## 6. The numbers (say them with the caveat)

| Metric (PRD §8 targets) | Result | Target |
|---|---|---|
| Tier-1 detection recall | **1.000** | ≥ 0.90 |
| Overall detection precision | **1.000** | ≥ 0.80 |
| Tier-1 redaction precision (IoU ≥ 0.5) | **1.000** | ≥ 0.85 |
| Overall recall | 0.941 (the two prose FNs) | — |
| Local pipeline p50 | ~66 ms (capture 1 · screenshot ~40 · faces ~13 · redaction ~17) | < 300 ms |
| Package | ~15 MB (13.3 MB ONNX runtime + 1.2 MB model) | < 20 MB |
| Tests | 5 browser harnesses + capture harness + 31 server tests | — |

The caveat, verbatim, because a judge will ask: *"These are on three fixture
screens written by the same people who wrote the detectors, scored against
labels we wrote. They measure internal consistency, not generalisation. The
PRD calls for 50 screens; annotating real pages is the next eval milestone. A
qualified 0.85 on real pages will be worth more than this 1.000."*

How the eval works, if asked: ground truth is hand-written by CSS selector
(`eval/corpus/labels/`) and only *measured* into boxes by a script that imports
nothing from the detectors. Detection matching allows containment (node-level
boxes); redaction precision uses strict IoU so over-sized boxes count against us.

## 7. Project breakdown (who owns what)

```
extension/src/
  capture/        dom-snapshot.ts   viewport DOM → RawSnapshot (open shadow roots, iframes as frames, 800-node budget)
                  content-script.ts injected on demand; also hosts the executor
  perception/     runtime.ts        ONNX Runtime Web session, WebGPU→WASM fallback
                  face-detect.ts    UltraFace RFB-320 pre/post + NMS
                  offscreen.ts      inference host (page CSP can't block it)
  pii-detection/  dom-heuristics.ts stage 1 — 17 attribute/context rules
                  patterns.ts       stage 2 — regex, context gates
                  validators.ts     Luhn, Verhoeff
                  detect.ts         the cascade; pure functions (replayable in the eval)
  redaction/      tokens.ts         session tokens, memory only
                  redact-text.ts    masking strategy per tier/type
                  redact-image.ts   black box / blur, edge cap
                  build-request.ts  THE ONLY AgentRequest constructor; re-scans itself
  background/     service-worker.ts orchestration; captures/plans/executes against the captured tab only
                  agent-client.ts   the only fetch
  executor/       execute.ts        acts on the real DOM; re-checks the selector allowlist
  shared/         schema.ts (the contract), resolve-path.ts (the only path resolver), vault.ts
  sidebar/        the user surface (side panel)
  viewer/         the three-column demo view
server/app/       ingress.py (independent re-check) · prompt.py · action_planner.py (guardrails) · providers/
eval/             corpus (labels + measured screens) · predict.mjs (replays the real pipeline) · run_eval.py · latency bench
```

Who to point at for which claim:

| Claim | Evidence |
|---|---|
| Raw data cannot reach the network | `requestPlan()` only accepts the type `build-request.ts` produces; `grep fetch( extension/src` → real calls only in `agent-client.ts` and `perception/runtime.ts` |
| Every redaction is declared | `build-request.ts` pushes a manifest entry for every mask; `test:redaction` checks shape |
| A leak fails loudly | `assertNoRawPii` + server `ingress.py`; `test:redaction`, `test_ingress.py` |
| The model can't invent a selector | `action_planner.py` + `execute.ts`; `test_action_planner.py`, `test:e2e` |
| Secrets never round-trip | `value_ref` only; `test:e2e` asserts no secret out, none back, field still filled |
| Faces are actually gone | `test:scenario-b` re-runs the detector on the redacted image: 22 → 0 |
| Frames can't leak pixels | `test:capture` samples the redacted PNG inside the iframe box: black |

## 8. Honest answers to hard questions

**"Isn't this just regex?"** Stage 2 is regex — with checksums and context
gates, which is what makes it precise. Stage 1 is DOM semantics, which is
higher-precision than any model on form fields. Stage 4 is a CNN. Stage 3 (NER)
is the roadmap. The point isn't any one detector; it's that they run in cost
order on-device, and everything they miss is *visible* in the eval, not hidden.

**"Why not run the whole model on-device?"** Because it can't plan multi-step
tasks well yet at browser-tolerable size. We put the part that's good on-device
on-device, and made the part that isn't safe to outsource.

**"The server still sees the sanitized page. Isn't that data?"** Yes — labels,
layout, roles, and placeholders. PRD §4.2 calls that acceptable structural
leakage: "there is a password field here" is not the password. We say plainly
this is a heuristic pipeline with a trust boundary, not a cryptographic
guarantee.

**"What if the redaction misses something?"** It can: a novel ID format,
a name in prose today. Mitigations: conservative thresholds (over-redact by
default), a second independent check before send, refuse-to-send on a hit,
and an eval that reports misses. Not eliminated — reduced and measured.

**"What if the model is malicious or confused?"** It can only target selectors
we sent, can't supply a secret, can't echo a token, and every execution goes
through user approval. The executor re-checks the allowlist independently of
the server.

**"Can I use it on my own site / with my own model?"** That is exactly what
the current work is (section 9).

## 9. Roadmap — from demo to product

Approved design: `docs/superpowers/specs/2026-09-11-athena-real-product-design.md`.

| # | Phase | Status | What changes for the user |
|---|---|---|---|
| 1 | Any-site capture | **in progress** | Enable ATHENA per site (no more clicking the icon per tab); web components (shadow DOM) detected; iframes masked; customer/member IDs tokenised; big pages handled |
| 2 | Serverless reasoning | next | No server needed. Bring your own key: OpenRouter (default), OpenAI, Ollama/vLLM, Anthropic. The redaction checks move on-device; your server stays as an optional relay |
| 3 | Action grammar v2 | | `select`, `key`, `hover`, `go_back`, `navigate` + `done`/`result`, per-action risk |
| 4 | Agent loop | | Give it a goal; it captures → plans → executes → re-captures until done. Two modes: approve every step, or only sensitive steps (credentials, navigation, anything the model flags) |
| 5 | Encrypted vault | | Passphrase-protected credentials and API keys (PBKDF2 → AES-GCM), unlock once per session |
| 6 | NER | | Names and addresses in prose caught by a local token-classification model — closes the last known recall gap |
| 7 | Ship | | Store listing, icons, privacy policy, real-site eval corpus |

## 10. Glossary

- **Tier 1 / 2 / 3** — hard-block / mask-keep-shape / structure (PRD §4.3).
- **Redaction manifest** — list of what was removed and where, never the value.
- **`value_ref`** — the model names a credential slot (`user_saved:password`); the browser resolves it locally.
- **Egress gate / ingress check** — a second, independently written PII scan on the finished payload.
- **Session token** — `[EMAIL_1]`: stable within a session, regenerated across sessions.
- **Selector allowlist** — the model may only target `dom_summary[].path` values it was sent.
- **activeTab vs host permission** — one-off access on icon click vs persistent per-site enable.
