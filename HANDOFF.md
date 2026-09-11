# ATHENA — handoff

State of the repository as of 2026-09-10, for whoever picks this up next.

Read alongside: [`PRD_Privacy_Preserving_Vision_Agent.md`](PRD_Privacy_Preserving_Vision_Agent.md)
(spec and rationale), [`CLAUDE.md`](CLAUDE.md) (working rules), [`README.md`](README.md)
(how to run it).

---

## 1. Status at a glance

| | |
|---|---|
| Milestones | PRD §12 M1–M6 complete |
| Demo scenarios | A (credentials), B (faces), C (structured PII) — all working end to end |
| Code | 4,361 lines of source (extension + server) · 2,547 lines of test/eval harness · 1,261 of fixtures and docs |
| Tests | 28 server (pytest) + 5 browser-driving extension suites — **all green** |
| Eval | All three PRD §8 accuracy targets met, on a corpus of 2 self-authored screens |
| Latency | 71 ms local p50 against a 300 ms budget |
| Package | ~15 MB against a 20 MB budget |
| Not done | Self-hosted VLM never run against real weights; NER detector cut; corpus is 2 screens |

**There is uncommitted work in the tree** — an OpenRouter provider. See §8.

---

## 2. The one rule

**The trust boundary is the network call, not the browser.**

The local agent may read and act on the real, unredacted DOM — it is the user's
own browser. Redaction applies *only* to what is serialized and sent. That is why
the extension can type a real password into a real password field while the
server only ever sees `[REDACTED:PASSWORD]`.

Corollary that has already caught bugs: never redact the live page, and never add
a second `fetch`. If you are about to send a screenshot, DOM dump or extracted
text anywhere, check it came from `redaction/build-request.ts` and carries a
`redaction_manifest`.

---

## 3. How a request flows

```
CONTENT SCRIPT          SERVICE WORKER              OFFSCREEN DOC        SERVER
capture-dom  ─────────→ runCapture
  dom-snapshot.ts         captureVisibleTab
                          detectFaces ───────────→ offscreen.ts
                                                     face-detect.ts
                                                     runtime.ts (ONNX)
                          buildAgentRequest ←──────  faces[]
                            detect.ts (cascade)
                            redact-text.ts
                            redact-image.ts
                            → AgentRequest
                          requestPlan ──────────────────────────────────→ ingress.py
                                                                            (re-check)
                                                                          reasoning.py
                                                                            prompt.py
                                                                            providers/
                                                                          action_planner.py
                          resolveValueRef ←──────────── AgentResponse ←───  (guardrails)
execute  ←───────────── executePlanFlow
  execute.ts
```

---

## 4. Component map

### Extension (`extension/src/`)

| File | Does | Non-obvious detail |
|---|---|---|
| `capture/dom-snapshot.ts` | Serializes visible DOM | Filters cheapest-first (tag → rect → `getComputedStyle`). Text clip is **600 chars for text, 200 for labels** — a payload-size bound, *not* a privacy control. The invariant is "we only send what we scanned". |
| `capture/content-script.ts` | Injected on demand under `activeTab` | Not declared statically — the extension holds no standing page access. Also hosts the executor. |
| `perception/runtime.ts` | ONNX session, EP selection | Checks `navigator.gpu`, requests `['webgpu','wasm']`, falls back. Which wasm artifact ships is the `ATHENA_ORT_EP` build flag. |
| `perception/face-detect.ts` | UltraFace pre/post + NMS | Full-frame 320×240 pass; `regions` adds per-media passes for small faces. Model outputs decoded boxes — no anchor maths. |
| `perception/offscreen.ts` | Hosts inference | **Why an offscreen doc:** a content script inherits the *visited page's* CSP and many sites forbid `wasm-unsafe-eval`; service-worker wasm/WebGPU support is uneven. |
| `pii-detection/dom-heuristics.ts` | Stage 1, 16 rules | Structural tags (`label/dt/th/legend/caption`) are **exempt** — otherwise a rule keyed on "password" redacts the label that identified the field. |
| `pii-detection/patterns.ts` | Stage 2 regex | Only self-validating formats match context-free. Ambiguous types (bank account, OTP, passport, DOB) are gated on node context. |
| `pii-detection/validators.ts` | Luhn + Verhoeff | Luhn alone passes ~10% of random digit runs; the issuer-digit check is what makes card detection precise. |
| `pii-detection/detect.ts` | The cascade | Pure functions over a serialized snapshot — **no DOM access** — so `eval/predict.mjs` replays production logic in Node. |
| `redaction/tokens.ts` | Session tokens | Worker memory only. **Never persist** — a token outliving its session becomes the pseudonym PRD §9.4 exists to deny. |
| `redaction/redact-text.ts` | Masking strategy | Tier 1 → `[REDACTED:TYPE]`; email → partial; other Tier 2 → token. Phone is tokenised, not partially masked (trailing digits are the "•••• 4242" leak). |
| `redaction/redact-image.ts` | Pixel masking | Tier 1 solid fill; faces blur. Blur regions are padded 25% and the radius scales with face size — **tuned against the detector**, not by eye. |
| `redaction/build-request.ts` | **The only AgentRequest constructor** | Fails closed: re-scans the finished payload and throws rather than return one that still matches a pattern. |
| `background/agent-client.ts` | **The only `fetch`** | Its parameter type is the one `build-request.ts` alone produces. |
| `background/service-worker.ts` | Orchestration | Accepts an explicit `tab_id` because the viewer is itself a tab. It is also the only place `setPanelBehavior` is called, which is what binds the toolbar icon to the side panel — MV3 has no manifest key for that. |
| `sidebar/sidebar.ts` | **The user surface** | Replaced the toolbar popup so the approval prompt survives long enough to be approved. Unlike a popup it outlives tab switches and worker suspensions, so page context is re-derived from `chrome.tabs` events and every render comes from worker state. |
| `executor/execute.ts` | Acts on the live DOM | Re-checks selectors against the client's own snapshot — server-side check guards a confused model, this one guards a compromised server. Values arrive pre-resolved; nothing here logs one. |
| `shared/schema.ts` | The contract | `Raw*` (local, real values) vs `AgentRequest` (wire). Conflating them is the bug the project exists to prevent. |
| `shared/vault.ts` | `value_ref` resolution | Demo vault. Chrome exposes no API for the real password manager, so §13 Q2 has only one answer. |
| `viewer/` | The side-by-side demo page | The artifact PRD §10 leans on hardest. |

### Server (`server/app/`)

| File | Does | Non-obvious detail |
|---|---|---|
| `ingress.py` | Re-validates before anything is logged or sent | Findings name path + pattern, **never the value**. `reject` (default) fails closed; `redact` scrubs. |
| `patterns.py` | Server-side detectors | Deliberately an **independent reimplementation**, not shared code — sharing would let one bug defeat both layers. |
| `prompt.py` | Redaction-aware system prompt | A project deliverable. Changing it needs a note in the writeup or the eval numbers stop being comparable. |
| `action_planner.py` | Constrains model output | Selector allowlist (the important one), no literal into a Tier 1 field, no marker echo, shape checks. Violations are dropped and reported, not raised. |
| `providers/` | mock / anthropic / openai-compat / openrouter | **mock is the default** and is not a stub — it plans Scenario A from the sanitized payload alone, proving redaction didn't destroy task accuracy. |

---

## 5. Where each guarantee actually lives

| Property | Enforced by | How to check |
|---|---|---|
| Raw snapshot cannot reach the network | Type of `requestPlan()`'s parameter | Read `agent-client.ts` |
| Only one origin reachable | `host_permissions` (one host) | `grep -rn 'fetch(' extension/src` → 2 lines, both `agent-client.ts` |
| A leak fails loudly | `assertNoRawPii` in `build-request.ts` | `npm run test:redaction` |
| A buggy client is caught anyway | `server/app/ingress.py` | `uv run pytest tests/test_ingress.py` |
| Model cannot invent a target | `action_planner.py` selector allowlist | `uv run pytest tests/test_action_planner.py` |
| Server cannot supply a secret | Tier 1 must use `value_ref` | `npm run test:e2e` |
| Tokens cannot outlive a session | Registry in worker memory | `grep -rn storage extension/src/redaction/` → comments only |
| Faces are actually gone | Re-run detector on redacted image | `npm run test:scenario-b` → 22 → 0 |

---

## 6. Verification inventory

| Command | Proves |
|---|---|
| `npm run smoke` | Every emitted selector resolves to exactly one element; every bbox well-formed |
| `npm run test:redaction` | No planted value survives; structure the server needs does; labels aren't clobbered; manifest well-formed. Fixture-driven (`scripts/fixtures.spec.mjs`), covers Scenarios A and C |
| `npm run test:faces` | Detector runs in a browser and finds faces (25/25 on a group photo) |
| `npm run test:scenario-b` | 22 faces → 0 after blurring, with the mute button still labelled |
| `npm run test:e2e` | Full loop: no secret out, no secret back, field still filled, form submitted |
| `npm run preview:viewer` | The demo view renders with real data → `eval/results/viewer.png` |
| `uv run pytest` | 28 tests: ingress, planner guardrails, endpoint, OpenRouter wiring |

Each harness starts its own Chrome (and server where needed) and cleans up.
`fixtures.spec.mjs` reports **known recall gaps** rather than hiding them, and
says so if one closes.

---

## 7. Measured results

Detection — 2 screens, 24 labelled items, threshold 0.5:

| | precision | recall | F1 |
|---|---|---|---|
| overall | 1.000 | 0.917 | 0.957 |
| tier 1 | 1.000 | 1.000 | 1.000 |
| tier 2 | 1.000 | 0.846 | 0.917 |

Redaction precision (pixel, IoU ≥ 0.5): tier 1 **1.000**, tier 2 0.818, overall 0.909.
All three PRD §8 targets met.

Latency p50/p95 ms (10 runs, mock provider): capture 1.1/1.5 · screenshot 39.5/66.0 ·
perception 14.4/16.8 · redaction 16.5/18.4 · network 4.0/6.1 · execute 0.7/1.0 →
**76.1/105.4**, local portion 71.4. `network` is transport only against the mock;
a real VLM call lands in that row and will dominate. Regenerate with
`node eval/latency_stages.mjs 20 && python3 eval/latency_bench.py`.

> **The single most important caveat in this repository.** Those 1.000s are on two
> fixture screens written by the same author as the detectors, scored against
> ground truth that same author wrote. That measures internal consistency, not
> generalisation. PRD §8 calls for ≥ 50 screens. `run_eval.py` prints this every
> run; keep it in anything shown to judges. A qualified 0.85 on real pages is
> worth more than an unqualified 1.000 on ours.

Ground truth is authored **independently of the detectors**: `corpus/labels/*.labels.json`
is human judgement by CSS selector; `measure_labels.mjs` only resolves selectors to
boxes. Neither imports anything from `pii-detection` or `redaction`. **Do not
change that** — ground truth derived from the detectors returns 1.0 for everything.

---

## 8. Uncommitted work in the tree

An **OpenRouter provider**, not authored by the previous session. Reviewed:

```
M  server/app/providers/__init__.py      + "openrouter" branch
M  server/app/providers/openai_compat.py + _headers() hook (refactor, no behaviour change)
?? server/app/providers/openrouter.py    subclass: own base URL, model, auth, attribution headers
?? server/tests/test_openrouter.py       2 tests, no network
M  README.md                             backend #4 + env-var rows
```

Assessment: **sound and safe to commit.** It subclasses `OpenAICompatProvider`
and reuses the multimodal request and plan parsing; the `_headers()` hook is a
clean seam. Tests pass in isolation and in both orderings (28 total). The
attribution header `X-OpenRouter-Title` is correct — I verified it against
OpenRouter's docs rather than "correcting" it to `X-Title` from memory (both are
accepted).

Three things to know before relying on it:

1. **It has never been run against the live API.** The tests stub `httpx`. The
   same caveat already applies to `openai-compat`.
2. **`response_format: json_schema` passthrough varies by underlying model.**
   `OpenAICompatProvider.plan` falls back to best-effort JSON parsing and returns
   an empty plan on failure, so a model that ignores it degrades to "no actions"
   rather than crashing — but that will look like a broken demo.
3. **It adds a hop to the threat model.** Redaction and ingress still run first,
   so no raw PII reaches it. But the sanitized payload — structural labels,
   redacted screenshot — now transits OpenRouter *and* the model provider behind
   it. PRD §9.3 already says the server is trusted to honour the contract; this
   makes that two parties instead of one. Worth one line in the writeup if
   OpenRouter is used for the demo.

---

## 9. Known gaps and open decisions

| # | Gap | Status |
|---|---|---|
| 1 | **Corpus is 2 self-authored screens** | The single highest-value thing to fix. Harness takes real annotations unchanged. |
| 2 | **Names/addresses in free prose undetected** | Needs the local NER model cut from this build. The only recall gap; visible in the numbers, not hidden. |
| 3 | **Customer identifiers have no taxonomy entry** | `MB4470193` passes through. Adding a `PiiType` is a **product decision** — deliberately not invented. |
| 4 | **Self-hosted VLM untested against real weights** | Interface and implementation exist; nobody has pointed it at Qwen2-VL. |
| 5 | **Pixel geometry is node-granular** | Over-redaction, never under. Costs Tier-2 redaction precision (0.818). Fix = Range geometry in the content script, which moves detection out of pure functions. |
| 6 | **Capture is viewport-only** | Below-the-fold content is never snapshotted, redacted, or sent. |
| 7 | **WebGPU is a build flag, defaulting off** | jsep runtime is 26.5 MB vs 13.3 MB; shipping it exceeds PRD §8's budget for marginal gain on a one-shot 320×240 model. |
| 8 | **Vault is unencrypted** | Chrome exposes no API for the real password manager. Labelled as a demo vault in the options UI. |
| 9 | **The panel can only inspect a tab it was invoked on** | `activeTab` is granted per tab on the toolbar click. Switching tabs does not re-grant it, so the panel marks itself stale and asks the user to invoke it on the new page rather than pretending. Fixing it properly means `optional_host_permissions` and a per-site enable, which is a permission escalation this product should argue for explicitly, not ship quietly. |
| 10 | **The panel is styled to `design/athena-sidebar/`; the options and viewer pages are not** | The panel adopts the design's white/Instrument Sans system. The other two pages still carry the earlier look, so the extension is visually inconsistent until someone decides the design wins everywhere. |

---

## 10. If you are picking this up

Ranked:

1. **Annotate real screens.** Ten screens from pages neither the detectors nor
   their author has seen would change what 40% of the rubric is actually worth.
   Write `eval/corpus/labels/<id>.labels.json`, put the page in `eval/fixtures/`,
   run `measure_labels.mjs && predict.mjs && run_eval.py`.
2. **Commit or discard the OpenRouter work** (§8). It is currently the only
   uncommitted state.
3. **Run one of the non-mock providers against a live endpoint** and see whether
   structured output survives. That is the biggest untested surface.
4. **Decide gap #3** (customer-identifier taxonomy) — a one-line product call
   that closes a visible passthrough.

---

## 11. Gotchas that cost time to find

- **Port 8787 is load-bearing.** It is the only origin in `host_permissions`.
- **The vault must be populated** or Scenario A dies on its last action. The
  executor refuses an unresolvable `value_ref` rather than typing `""`.
- **`file://` fixtures need "Allow access to file URLs"** on the extension, or
  serve them over HTTP.
- **JSON round-trips absence as `null`, not `undefined`.** `action.value !== undefined`
  let null through into an escaper and broke the viewer. Fixed in three places;
  the pattern will recur wherever server JSON meets TypeScript optionals.
- **ORT's default export inlines 26 MB of wasm as base64.** The build uses the
  `onnxruntime-web-use-extern-wasm` export condition to get external artifacts.
- **Benchmarks that reload the page discard the ONNX session cache.** That once
  charged ~100 ms of init to every capture and made preprocessing look like the
  bottleneck. It is 1.3 ms against 13.1 ms of inference.
- **`getComputedStyle` is the expensive call** in the DOM walk. Keep the
  tag → rect → style ordering.
- **Don't add a second `fetch`.** The single-call property is checkable with grep
  and is worth more than the convenience.
