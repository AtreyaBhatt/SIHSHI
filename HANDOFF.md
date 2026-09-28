# ATHENA — handoff

State of the repository as of 2026-09-28 (phase 5b done), for whoever picks
this up next. Sections 1–11 are the phase 5a snapshot, left as written;
§13 below is phase 5b's own entry, in the same format as §12.

Read alongside: [`PRD_Privacy_Preserving_Vision_Agent.md`](PRD_Privacy_Preserving_Vision_Agent.md)
(spec and rationale), [`CLAUDE.md`](CLAUDE.md) (working rules), [`README.md`](README.md)
(how to run it).

---

## 1. Status at a glance

| | |
|---|---|
| Milestones | PRD §12 M1–M6 complete |
| Demo scenarios | A (credentials), B (faces), C (structured PII), portal (all of the above plus QR/canvas/hidden-text/firewall in one fixture) — all working end to end |
| Tests | 49 server (pytest) + the extension harness (typecheck, build, smoke, and 15+ `test:*`/script commands — capture, redaction, faces, scenario-b, e2e ×4, executor, reasoning, loop, vault, delta, provider, dom-heuristics, preview:viewer) — **all green** as of phase 5b's harness run |
| Eval | All three PRD §8 accuracy targets met, on a corpus of 5 self-authored screens, 51 labelled items (see §13 for phase 5b's numbers) |
| Latency | ~66 ms local p50 against a 300 ms budget (mock provider); DeltaVision's `--loop` mode adds a second, steady-state measurement — see §13 |
| Package | ~15 MB against a 20 MB budget |
| Not done | Self-hosted VLM never run against real weights; NER detector cut; corpus is 5 screens (target ≥ 50); see §13's known limits for what phase 5b left open |
| Design spec phases (`docs/superpowers/specs/2026-09-11-athena-real-product-design.md`) | Phase 3 (action grammar v2: nine verbs, `risk`, `done`/`result`) and Phase 4 (agent loop: two approval modes, step cap, panel Start/Stop/history) **done** — `7b2b25e..HEAD` |
| Phase 5a (BlindFill tokens, encrypted vault, privacy firewall) | **done** — `a00a1b8..397587a`. See §12. |
| Phase 5b (detector additions, hidden text, DeltaVision, metrics card, portal demo) | **done** — `397587a..HEAD`. See §13. |


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
| `capture/dom-snapshot.ts` | Serializes visible DOM | Filters cheapest-first (tag → rect → `getComputedStyle`). Text clip is **600 chars for text, 200 for labels** — a payload-size bound, *not* a privacy control. The invariant is "we only send what we scanned". Walks open shadow roots (paths carry ` >>> `, resolved only by `shared/resolve-path.ts`); iframes captured as `frame` and black-boxed; 800-node budget keeps every interactive node and sets `truncated`. |
| `capture/content-script.ts` | Injected on demand under `activeTab` | Not declared statically — the extension holds no standing page access. Also hosts the executor. |
| `perception/runtime.ts` | ONNX session, EP selection | Checks `navigator.gpu`, requests `['webgpu','wasm']`, falls back. Which wasm artifact ships is the `ATHENA_ORT_EP` build flag. |
| `perception/face-detect.ts` | UltraFace pre/post + NMS | Full-frame 320×240 pass; `regions` adds per-media passes for small faces. Model outputs decoded boxes — no anchor maths. |
| `perception/offscreen.ts` | Hosts inference | **Why an offscreen doc:** a content script inherits the *visited page's* CSP and many sites forbid `wasm-unsafe-eval`; service-worker wasm/WebGPU support is uneven. |
| `pii-detection/dom-heuristics.ts` | Stage 1, 16 rules | Structural tags (`label/dt/th/legend/caption/h1–h6`) and non-controls with no text (buttons, links) are **exempt** — otherwise a rule keyed on "password" redacts the label that identified the field. |
| `pii-detection/patterns.ts` | Stage 2 regex | Only self-validating formats match context-free. Ambiguous types (bank account, OTP, passport, DOB) are gated on node context. |
| `pii-detection/validators.ts` | Luhn + Verhoeff | Luhn alone passes ~10% of random digit runs; the issuer-digit check is what makes card detection precise. |
| `pii-detection/detect.ts` | The cascade | Pure functions over a serialized snapshot — **no DOM access** — so `eval/predict.mjs` replays production logic in Node. |
| `redaction/tokens.ts` | Session tokens | Worker memory, mirrored to `chrome.storage.session` keyed by session id so the panel/worker can reattach after a worker restart mid-run. **Never persisted to `storage.local`** — a token outliving its browser session becomes the pseudonym PRD §9.4 exists to deny; `storage.session` is memory-backed and cleared on browser exit. |
| `redaction/firewall.ts` | Independent second-layer scan on the finished request | Imports nothing from `pii-detection/` on purpose — a bug in one detector layer can't defeat both. Masks every hit (Tier 1 and Tier 2 alike) as a numbered token with its own manifest entry; only blocks (`firewall:residual`) if a match survives up to three masking passes and a fail-closed rescan. No OCR — text only. |
| `background/debug-detectors.ts` | Demo switch: disables named cascade detectors for a session | Proves the firewall is a real second layer, not decorative — a screen still gets masked when the cascade is turned off. `chrome.storage.session` only; the panel shows a red "detectors off" chip whenever it's non-empty. |
| `redaction/redact-text.ts` | Masking strategy | Tier 1 → `[REDACTED:TYPE]`; email → partial; other Tier 2 → token. Phone is tokenised, not partially masked (trailing digits are the "•••• 4242" leak). |
| `redaction/redact-image.ts` | Pixel masking | Tier 1 solid fill; faces blur. Blur regions are padded 25% and the radius scales with face size — **tuned against the detector**, not by eye. |
| `redaction/build-request.ts` | **The only AgentRequest constructor** | Fails closed: re-scans the finished payload and throws rather than return one that still matches a pattern. |
| `background/agent-client.ts` | **The only `fetch`** | Its parameter type is the one `build-request.ts` alone produces. |
| `background/service-worker.ts` | Orchestration | Accepts an explicit `tab_id` because the viewer is itself a tab. It is also the only place `setPanelBehavior` is called, which is what binds the toolbar icon to the side panel — MV3 has no manifest key for that. |
| `sidebar/sidebar.ts` | **The user surface** | Replaced the toolbar popup so the approval prompt survives long enough to be approved. Unlike a popup it outlives tab switches and worker suspensions, so page context is re-derived from `chrome.tabs` events and every render comes from worker state. |
| `executor/execute.ts` | Acts on the live DOM | Re-checks selectors against the client's own snapshot — server-side check guards a confused model, this one guards a compromised server. Values arrive pre-resolved; nothing here logs one. |
| `shared/schema.ts` | The contract | `Raw*` (local, real values) vs `AgentRequest` (wire). Conflating them is the bug the project exists to prevent. |
| `shared/vault.ts` | `value_ref` resolution, encrypted at rest | PBKDF2-SHA256 (600k) → non-extractable AES-GCM-256. Unlock survives worker suspension via a raw-key mirror in `chrome.storage.session` (superseding the earlier "key in worker memory only" design) — see §12. Still a demo vault, not a password manager: Chrome exposes no API for the real one, so §13 Q2 has only one answer. |
| `viewer/` | The side-by-side demo page | The artifact PRD §10 leans on hardest. |

### Server (`server/app/`)

| File | Does | Non-obvious detail |
|---|---|---|
| `ingress.py` | Re-validates before anything is logged or sent | Findings name path + pattern, **never the value**. `reject` (default) fails closed; `redact` scrubs. |
| `patterns.py` | Server-side detectors | Deliberately an **independent reimplementation**, not shared code — sharing would let one bug defeat both layers. |
| `prompt.py` | Redaction-aware system prompt | A project deliverable. Changing it needs a note in the writeup or the eval numbers stop being comparable. |
| `action_planner.py` | Constrains model output | Selector allowlist (the important one), no literal into a Tier 1 field, no marker echo, shape checks. Violations are dropped and reported, not raised. |
| `providers/` | mock / anthropic / openai-compat | **mock is the default** and is not a stub — it plans Scenario A from the sanitized payload alone, proving redaction didn't destroy task accuracy. |

---

## 5. Where each guarantee actually lives

| Property | Enforced by | How to check |
|---|---|---|
| Raw snapshot cannot reach the network | Type of `requestPlan()`'s parameter | Read `agent-client.ts` |
| Egress limited to declared and user-granted origins | `host_permissions` (the reasoning server) plus `optional_host_permissions` the user grants per site | `grep -rn 'fetch(' extension/src` → real calls only in `agent-client.ts` (server) and `perception/runtime.ts` (extension-local model URL) |
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
| `npm run test:capture` | Shadow DOM paths resolve, iframes are black-boxed as `frame`, the 800-node budget keeps every interactive node and sets `truncated` |
| `npm run test:redaction` | No planted value survives; structure the server needs does; labels aren't clobbered; manifest well-formed. Fixture-driven (`scripts/fixtures.spec.mjs`), covers Scenarios A and C |
| `npm run test:faces` | Detector runs in a browser and finds faces (25/25 on a group photo) |
| `npm run test:scenario-b` | 22 faces → 0 after blurring, with the mute button still labelled |
| `npm run test:e2e` | Full loop: no secret out, no secret back, field still filled, form submitted |
| `npm run test:e2e:c` | Scenario C: the model answers without acting. The stub selects empty fields by null value; a real model can now tell empty sensitive fields from filled ones via the null-plus-manifest rule (one line added to both system prompts; detector-level eval numbers unchanged) |
| `npm run test:reasoning` | Guardrails (verbs, value/value_ref/value_token, risk floor, typed-secret masking and egress check), the privacy firewall (mask-then-residual-block, windowed Luhn/Verhoeff, the demo switch), and the plan split, in Node |
| `npm run test:e2e:blindfill` | BlindFill end to end on a profile-to-form fixture: `value_token` resolves an on-page Tier-1 value, `value_ref` resolves a stored profile value gated on `available_refs`, neither ever appears in a request/response body |
| `npm run test:vault` | The encrypted vault: create/unlock split, idle relock enforced on load, session-key restore after a simulated worker restart, lock wins over an in-flight access, v1/cookie migration only after persist succeeds |
| `npm run preview:viewer` | The demo view renders with real data → `eval/results/viewer.png` |
| `uv run pytest` | ingress, planner guardrails, endpoint, provider failure modes |

Each harness starts its own Chrome (and server where needed) and cleans up.
`fixtures.spec.mjs` reports **known recall gaps** rather than hiding them, and
says so if one closes.

---

## 7. Measured results

Detection — 5 screens, 51 labelled items, threshold 0.5 (phase 5b numbers;
see §13 for the corpus additions):

| | precision | recall | F1 |
|---|---|---|---|
| overall | 1.000 | 0.961 | 0.980 |
| tier 1 | 1.000 | 1.000 | 1.000 |
| tier 2 | 1.000 | 0.913 | 0.955 |

Redaction precision (pixel, strict IoU ≥ 0.5): tier 1 **0.929**, tier 2
**0.810**, overall **0.878** — phase 5b is the first time all three are
computed (`run_eval.py` only ever produced tier 1 before). Both false
negatives are the same known gap: names/addresses in free prose.
All three PRD §8 targets met.

Latency p50/p95 ms (10 runs, mock provider): capture 1.0/2.0 · screenshot 39.5/55.4 ·
perception 12.6/16.8 · redaction 13.0/17.6 · network 4.0/6.0 · execute 0.8/1.5 →
**72.3/89.7**, local portion 66.2. `network` is transport only against the mock;
a real VLM call lands in that row and will dominate. Regenerate with
`node eval/latency_stages.mjs 20 && python3 eval/latency_bench.py`.

> **The single most important caveat in this repository.** Those 1.000s are on four
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

None. An OpenRouter provider that a previous session reviewed here was discarded
rather than committed; `providers/` holds mock, anthropic and openai-compat only.

## 9. Known gaps and open decisions

| # | Gap | Status |
|---|---|---|
| 1 | **Corpus is self-authored screens** | The single highest-value thing to fix. Harness takes real annotations unchanged. |
| 2 | **Names/addresses in free prose undetected** | Needs the local NER model cut from this build. The only recall gap; visible in the numbers, not hidden. |
| 3 | **Self-hosted VLM untested against real weights** | Interface and implementation exist; nobody has pointed it at Qwen2-VL. |
| 4 | **Pixel geometry is node-granular** | Over-redaction, never under. Costs Tier-2 redaction precision (0.818). Fix = Range geometry in the content script, which moves detection out of pure functions. |
| 5 | **Capture is viewport-only** | Below-the-fold content is never snapshotted, redacted, or sent. |
| 6 | **WebGPU is a build flag, defaulting off** | jsep runtime is 26.5 MB vs 13.3 MB; shipping it exceeds PRD §8's budget for marginal gain on a one-shot 320×240 model. |
| 7 | **Vault is encrypted but the unlocked key is readable by extension pages** | Resolved in phase 5a: PBKDF2 → AES-GCM-256 at rest. Residual: while unlocked, the raw key mirror in `chrome.storage.session` is readable by any extension page (not a content script). Protects against disk access and other extensions, not a compromised extension page. Chrome still exposes no API for the real password manager. |
| 8 | **The panel is styled to `design/athena-sidebar/`; the options and viewer pages are not** | The panel adopts the design's white/Instrument Sans system. The other two pages still carry the earlier look, so the extension is visually inconsistent until someone decides the design wins everywhere. |
| 9 | **Synthetic events are `isTrusted: false`** | The executor dispatches `MouseEvent`/`KeyboardEvent`/etc. via `dispatchEvent`; a site that gates on `event.isTrusted` (rare, but real) will not respond to them. |
| 10 | **No per-element fingerprint yet** | The executor re-checks a selector against the client's own snapshot, but nothing pins the action to the *specific element instance* the plan was built against — a page that reorders same-selector elements between plan and execute is not detected. |
| 11 | **Step cap only in `storage.local`, no UI control** | `athena:max-steps` (default 25) is set by writing to extension storage directly; the panel control lands with the Settings redesign in Phase 5. |
| 12 | **Token registry mirror lives in `chrome.storage.session`** | Resolved differently than originally planned: the registry is now mirrored to `chrome.storage.session` (keyed by session id) so a worker restart mid-run can reattach to the same token ids, instead of starting fresh. Dropped when its run ends or Reset Session replaces it, and swept on worker start. Still session-scoped and memory-backed — cleared on browser exit, never in `storage.local` (CLAUDE.md's never-persist-across-sessions rule still holds). |
| 13 | **`go_back` is not gated in approve-sensitive mode** | Only `navigate` is always sensitive; `go_back` runs as routine even though it changes the page under approve-sensitive, same as `scroll`/`hover`/etc. |
| 14 | **Typed-secret protection is worker-memory only** | Forced masking of fields the agent typed a credential into, and the credential egress check, are held in worker memory; after a service-worker restart (routine while a run waits for approval) a credential typed into a field no detector flags can be re-captured as plain text. Not addressed by the phase 5a vault work — still open. |
| 15 | **Vault key does not survive a browser restart** | The idle relock (15 min) and the `chrome.storage.session` mirror only cover worker suspension. `storage.session` itself is memory-backed and is cleared on browser exit, extension reload, or an explicit Lock — the user re-enters the passphrase in any of those cases. |
| 16 | **Firewall has no OCR** | The privacy firewall (`redaction/firewall.ts`) scans outbound *text* fields only. A card number rendered only as an image (a screenshot of a card, a canvas-drawn field) is invisible to it, same as to the rest of the text-based cascade. |
| 17 | **Firewall card prefixes don't cover RuPay or Maestro** | Its card-network prefix list is `4; 5[1-5]; 2[2-7]; 3[47]; 6`. A RuPay or Maestro card number that the DOM/regex cascade also misses would pass both layers. The cascade detectors remain the primary line for those. |
| 18 | **Firewall over-masks a measurable fraction of random grouped numbers** | Not a bug, the stated conservative bias: ~3% of random 16-digit 4×4-grouped numbers are falsely masked as a card, ~8% of random 12-digit 4-4-4-grouped numbers as an Aadhaar number. `dom_path`/manifest path strings are never scanned by the firewall. |
| 19 | **Vault slot values of 3 characters or fewer are never echo-masked** | And never trip the credential egress check. |
| 20 | **The credential egress check has a narrow read surface** | It reads `dom_summary` labels and values, the task instruction, and prior-action values; it does not read prior-action error/option/url fields or DOM path strings. |
| 21 | **A token can only be typed into a field a detector classified as the same type** | Fields with labels the DOM rules miss (for example "UID", "WhatsApp", non-English labels), fields resolved to a different single type, split card or Aadhaar inputs, and fields below the fold or inside iframes are refused by the guardrail; the user fills those by hand. |
| 22 | **A same-URL image swap is invisible to DeltaVision** | `src_hash` (phase 5b) digests the image URL, not its bytes. A server-side swap of the image behind an unchanged URL is not seen as a change, so a stale face box from before the swap can be reused. The full-frame face pass still runs every step regardless — this only affects the per-region skip. |
| 23 | **The QR rule is name-based, no decoding** | `dom:qr` matches on id/class/alt/filename (`qr`, `qrcode`, `scan-to-pay`, …). A real QR image with none of those names is missed; a non-QR image with such a name is over-redacted (declared `frame`, black-boxed) for nothing. |
| 24 | **Every canvas over 32×32 px is black-boxed unconditionally** | Closes the "canvas paints text/an id the DOM walk never sees" gap, but cannot distinguish a sensitive canvas from anything else: canvas-based captchas, maps, signature pads, games and charts are black-boxed too, so the agent is blind to them and cannot complete a task that needs one. Black-boxed media (canvas, named QR) gets no region face crop; the full-frame pass still runs. |
| 25 | **Split PIN boxes are undetected** | The OTP rule's context match excludes "PIN" on purpose (it is the standard Indian postal-code term; including it would false-positive every address field). A PIN split across several single-digit boxes is missed unless its own context also names it as an OTP/verification code. |
| 26 | **Non-ASCII digit spans split across sibling elements do not group** | Digit folding (Devanagari, etc. → ASCII) happens inside `detectPii` over one node's already-assembled text; `group_id` assignment at capture time reads each span's raw text and never folds it. A card/Aadhaar/OTP written as adjacent `<span>`s of non-ASCII digits is neither grouped nor detected. |
| 27 | **1×1 screen-reader-only text is over-dropped by the hidden-text rule** | The box-size camouflage rule (< 2×2 px) does not distinguish deliberate camouflage from the standard visually-hidden accessibility pattern; both are dropped and counted in `hidden_dropped`. Accepted as the conservative-by-default trade-off, not silently absorbed. |
| 28 | **The metrics card's "panel JS heap" is the panel's own heap, not the worker's or the offscreen document's** | `performance.memory.usedJSHeapSize` is only ever available to the context that calls it; CPU and GPU usage are not exposed to extensions at all, and the card says so rather than estimating either one. |
| 29 | **Pixel geometry stayed node-granular through phase 5b, and the corpus grew** | Tier-2 redaction precision (0.810, was 0.833 on the smaller phase 5a corpus) reflects the same known limitation (a detection inside a paragraph is masked with the paragraph's box) now measured against more Tier-2 items — not a regression in the masking itself. |
| 30 | **An uncaptured textless overlay can hide and reveal an image without changing any hash** | DeltaVision's local `fx` digest (filter/opacity/visibility/clip-path/transform on a media node and on its filtered or translucent ancestors) catches a blur removed from a photo or its wrapper. An overlay element with no text that is not captured (not interactive, not media) can still cover and then uncover an image without any captured node changing; if nothing is removed from the snapshot either, the region pass is skipped. The always-on full-frame face pass is the only cover for that case. |
| 31 | **Camouflage checks on names look at one element** | An interactive node's own-text name is checked against the node's own style only; a camouflaged child `<span>` inside a visible button still contributes to its name. Label sources hidden with `display:none`/`visibility:hidden` are treated per the same rules (a zero box is withheld; `visibility:hidden` is not a camouflage rule). |

---

## 10. If you are picking this up

Ranked:

1. **Annotate real screens.** Ten screens from pages neither the detectors nor
   their author has seen would change what 40% of the rubric is actually worth.
   Write `eval/corpus/labels/<id>.labels.json`, put the page in `eval/fixtures/`,
   run `measure_labels.mjs && predict.mjs && run_eval.py`.
2. **Run one of the non-mock providers against a live endpoint** and see whether
   structured output survives. That is the biggest untested surface.

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

---

## 12. Phase 5a — BlindFill tokens, encrypted vault, privacy firewall

Range `a00a1b8..HEAD`. Done.

**What shipped:**
- **BlindFill.** On-page Tier-1 values the cascade already found are sent as
  numbered tokens (`[AADHAAR_1]`); the model can type one back via
  `value_token`, resolved locally in the worker against the run's
  `TokenRegistry`. Separately, `value_ref` fills stored profile/credential
  values, gated on a `## available_refs` list the client sends outside the
  redacted page fence — the model cannot invent a ref. Both are forced
  `risk: sensitive`. `npm run test:e2e:blindfill` covers it end to end on a
  profile-to-form fixture.
- **Encrypted vault (v2).** PBKDF2-SHA256 (600k) → non-extractable AES-GCM-256.
  Create/unlock are separate messages; a locked vault pauses a run at
  `needs_unlock` rather than failing it. Unlock survives MV3 worker
  suspension by mirroring the raw derived key into `chrome.storage.session`
  with a last-used time — this **supersedes** the original "key in worker
  memory only" design. The 15-minute idle limit is checked on the next vault
  access (no timer, no `alarms` permission); until then the key stays in the
  browser's session storage. Lock always wins over an access already in
  flight, and an unlock it overtakes fails with "Locked while unlocking".
  The old plaintext v1 vault, and the API-key cookie where Chrome still has
  the old `cookies` permission cached, are migrated in when the vault is
  created and deleted only after the encrypted copy is durably persisted.
  Every `athena:*` runtime message, vault included, is accepted only from
  extension pages, never content scripts (which send none). `npm run test:vault`.
- **Privacy firewall.** An independent second scan (`redaction/firewall.ts`,
  imports nothing from `pii-detection/`) runs on the finished request payload.
  Every hit it finds — Tier 1 included — is masked as a numbered token with
  its own manifest entry, not blocked; masking runs up to three passes so a
  remainder revealed by one pass can itself be masked. Only a match still
  present after a fail-closed rescan blocks, as `firewall:residual`, which
  signals a firewall defect rather than ordinary page content. A
  session-scoped demo switch (`background/debug-detectors.ts`) can disable
  named cascade detectors so a screen is masked by the firewall alone, with a
  visible red "detectors off" chip. Covered by `npm run test:reasoning`
  (firewall block) and unchanged by `npm run test:redaction` /
  `python3 eval/run_eval.py` — the firewall never fires on the corpus in the
  normal pass.

**Known limits (see the Known gaps table, §9, items 15–18, for detail):**
- The firewall has no OCR — text fields only.
- The vault key survives a worker restart but not a browser restart, an
  extension reload, or Lock — `chrome.storage.session` is memory-backed and
  clears then; the user re-enters the passphrase.
- The token registry mirror lives in `chrome.storage.session`, keyed by
  session id — memory-backed, never in `storage.local`. A run's mirror is
  dropped when the run ends (terminal status, Stop, retirement by a new run,
  marked interrupted); the single-step mirror when Reset Session replaces the
  session id (kept under `athena:session-id` so a plan survives a worker
  restart); worker start sweeps any other mirror. The lifecycle helpers live
  in the service worker and have no Node test — they are covered by
  typecheck and review only; a worker-level e2e is the next work (below).
- The design spec's §C rule "a bare 12–19 digit run" was replaced during
  review (H2) by shaped windows: a card window inside a longer run needs a
  card-network prefix and card-like grouping, Aadhaar only matches a whole
  12-digit run. The demo switch only accepts detectors for types the firewall
  covers (email, card, Aadhaar, PAN, IFSC, SSN, phone) — no account ids.
- Deferred from the phase 5b final review: a worker-level e2e with the
  extension loaded (forced detector failure; `ServiceWorker.stopAllWorkers`);
  span-level pixel boxes to recover IoU precision; split PIN boxes;
  non-ASCII digit span grouping; a face is assigned to the first containing
  media box only.
- Split-field members (card/Aadhaar/OTP across sibling boxes) are sent as
  fixed `[REDACTED:TYPE]` markers with per-member ids and no recorded value;
  the guardrail rejects their ids as `value_token`.
- Deferred from the final review: a worker-level BlindFill e2e that
  suspends the worker at approval (`ServiceWorker.stopAllWorkers`); removing
  the redundant `value`/`value_ref` type guard clause that the
  `value_token` one subsumes; attributing a `toExecutable` throw to the
  action that caused it rather than the first page action; RuPay/Maestro
  card prefixes; scanning DOM paths; lowercase IBANs; a bare "Name" label
  is not detected as a name field (phase 5b).
- The firewall's card-network prefixes don't cover RuPay or Maestro; the
  cascade detectors remain the primary line for those.
- Measured false-mask rates on random grouped numbers (the stated
  over-redaction bias, not a bug): ~3% for 16-digit 4×4 card-shaped numbers,
  ~8% for 12-digit 4-4-4 Aadhaar-shaped numbers.

**Say it plainly, not more:** redaction (cascade and firewall alike) is
heuristic, not provably complete. The firewall is a second heuristic layer,
not a formal guarantee — a bug shared between it and the cascade is still
possible in principle, though the two are written independently to make that
less likely. The vault protects against disk access and other extensions
reading `storage.local`/`storage.session`; it does **not** protect against a
compromised extension page, which can read the unlocked key while it is live.

---

## 13. Phase 5b — detector additions, hidden text, DeltaVision, metrics card, portal demo

Range `397587a..8cc0f13`. Done.

**What shipped:**
- **New detectors.** Exact-match bare name labels (`person_name`, Tier 2); UPI
  ids (`account_id`, Tier 2); IBAN validated by mod-97, case-insensitive
  (`bank_account`, Tier 1); non-ASCII (e.g. Devanagari) digit folding, 1:1 in
  length so spans stay valid; card and Aadhaar numbers split across sibling
  `<input>`s, and split OTP boxes, grouped and detected as one item; QR images
  declared `frame` by element name (`qr`, `qrcode`, `scan-to-pay`, …), no
  decoding; every canvas over 32×32 px declared `frame` and black-boxed.
- **Capture-time hidden-text rule** (heuristic). Camouflage checks — font
  under 2 px; box under 2×2 px; effective opacity 0 (multiplied down the
  ancestor chain); a fully transparent text colour; text colour matching the
  effective *solid* background (walk includes `<html>`, tolerance 8/channel),
  confirmed by `elementsFromPoint` at the text's centre — withhold text before
  any detector sees it. Each withheld element is counted once into
  `hidden_dropped` (surfaced to the model and the metrics card as a count
  only). Text over an image or gradient is kept: a `background-image` in the
  ancestor walk, or a non-ancestor `img`/`video`/`canvas`/`svg`/
  `background-image` element under the text's centre, turns the colour rule
  off. Plain text nodes that match are removed. Label sources (`<label for>`,
  wrapping `<label>`, `aria-labelledby` targets, the sibling context label)
  that match contribute nothing. Interactive nodes whose name comes from their
  own visible text stay in the snapshot with `label: null`; interactive and
  media nodes are never removed. See §9 items 27 and 31.
- **DeltaVision** (`extension/src/shared/delta.ts`, pure — no `chrome.*`/DOM).
  PII text detection and the full-frame face pass are unconditional every
  step. The only thing ever skipped is the per-region (crop) face-detector
  pass on an image/svg/etc. media node whose hash is unchanged since the
  previous step — its previously-found face boxes are reused (padded, never
  invented). `<video>`/`<canvas>` are always re-scanned. A media node is
  forced back into the re-scan set on load-state change, on overlap with a
  changed/new node, or when *any* node disappeared since the last step
  (conservative: unknown what it covered). A face-detector call that actually
  fails withholds that step's screenshot and never becomes remembered state —
  text redaction is unaffected. `eval/latency_stages.mjs --loop` demonstrates
  this: three captures of one page, no reload between them, printing
  `perception_ms`/`nodes_changed_pct`/`media_area_reprocessed_pct`/`faces_reused`
  per step (see README.md's Results section — on `application-portal.html`,
  step 1 re-processes 100% of media and finds 25 faces in the group
  photograph `faces-2.jpg`; steps 2–3 reuse all 25 with 0% media
  re-processed). Media nodes carry a local-only `fx` digest of their visual
  effects so removing a blur is a change (§9 item 30 for what it misses).
  Region scans are not sent for media a DOM rule already black-boxes.
- **Metrics card.** A collapsed-by-default panel card, six groups (Privacy,
  Boundary, Performance, Resources, Delta, Benchmark), every number measured
  this run or read from `benchmark.json` (built from `eval/results/*.json`,
  dated). CPU/GPU are not exposed to extensions and the card says so instead
  of estimating; the JS-heap number is the **panel's own heap**
  (`performance.memory.usedJSHeapSize`), not the worker's or the offscreen
  document's — there is no cross-context memory API available here.
- **Portal demo fixture** (`eval/fixtures/application-portal.html` +
  `npm run test:e2e:portal`). One page exercising tokens, stored refs
  (`value_ref`), a real face scan on a profile photo, a QR image, an
  over-32×32 canvas, camouflaged hidden text, and the privacy firewall,
  end to end — no planted profile value (name, card, Aadhaar, email, phone,
  address, account number) ever appears in either request body.
- **Eval.** `run_eval.py` now writes tier-2 and overall redaction precision
  into `eval/results/metrics.json` (previously tier-1 only), so
  `benchmark.json` and the metrics card's Benchmark group carry all three.
  Corpus grew from 4 to 5 screens / 35 to 51 labelled items
  (`edge-cases-01`, `shadow-iframe-01`, `india-pii-01` added).

**Known limits** (detail in the Known gaps table, §9, items 22–31):
- A same-URL image swap (server-side bytes change, URL unchanged) is invisible
  to DeltaVision's `src_hash` — the full-frame face pass still covers it.
- The QR rule is name-based, not a decoder; the canvas rule black-boxes any
  large canvas, sensitive or not — canvas captchas, maps, signature pads,
  games and charts included, so the agent cannot see or use them.
- Split PIN boxes (as opposed to OTP boxes) are undetected by design (the OTP
  context match excludes "PIN" — an Indian postal-code term).
- Non-ASCII digit spans split across sibling elements are not grouped —
  folding happens too late (inside `detectPii`, per already-assembled node
  text) to affect `group_id` assignment at capture time.
- The hidden-text rule over-drops 1×1 screen-reader-only text (the standard
  accessibility pattern), same conservative-by-default trade-off as
  everywhere else in this project — counted, not hidden.
- The metrics card's heap number is scoped to the panel context only; CPU/GPU
  are unavailable to any extension context, not just under-instrumented here.
- Tier-2 redaction precision (0.810) reflects the node-granular pixel-mask
  limitation (§9 item 4/29) measured against a larger, more Tier-2-heavy
  corpus than phase 5a's — not a regression in the masking logic itself.

**Say it plainly, not more:** every new detector, the hidden-text rule, and
DeltaVision's skip logic are heuristics layered on an already-heuristic
pipeline — none of them make a formal completeness claim, and each one's
known miss modes are listed above rather than discovered later by a judge.
