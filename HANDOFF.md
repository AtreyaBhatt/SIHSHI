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
| Tests | 31 server (pytest) + 6 browser-driving extension suites — **all green** |
| Eval | All three PRD §8 accuracy targets met, on a corpus of 4 self-authored screens |
| Latency | 66 ms local p50 against a 300 ms budget |
| Package | ~15 MB against a 20 MB budget |
| Not done | Self-hosted VLM never run against real weights; NER detector cut; corpus is 4 screens |
| Design spec phases (`docs/superpowers/specs/2026-09-11-athena-real-product-design.md`) | Phase 3 (action grammar v2: nine verbs, `risk`, `done`/`result`) and Phase 4 (agent loop: two approval modes, step cap, panel Start/Stop/history) **done** — `7b2b25e..HEAD` |
| Phase 5a (BlindFill tokens, encrypted vault, privacy firewall) | **done** — `a00a1b8..HEAD`. See §12. |


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

Detection — 4 screens, 35 labelled items, threshold 0.5:

| | precision | recall | F1 |
|---|---|---|---|
| overall | 1.000 | 0.943 | 0.971 |
| tier 1 | 1.000 | 1.000 | 1.000 |
| tier 2 | 1.000 | 0.900 | 0.947 |

Redaction precision (pixel, IoU ≥ 0.5): tier 1 **1.000**, tier 2 0.833, overall 0.909.
The tier 2 figure dropped from 0.882 when a prose email was added to the corpus: text redaction is exact, but the pixel mask covers the whole paragraph box (over-redaction, never under-redaction).
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
| 12 | **Token registry mirror lives in `chrome.storage.session`** | Resolved differently than originally planned: the registry is now mirrored to `chrome.storage.session` (keyed by session id) so a worker restart mid-run can reattach to the same token ids, instead of starting fresh. Still session-scoped and memory-backed — cleared on browser exit, never in `storage.local` (CLAUDE.md's never-persist-across-sessions rule still holds). |
| 13 | **`go_back` is not gated in approve-sensitive mode** | Only `navigate` is always sensitive; `go_back` runs as routine even though it changes the page under approve-sensitive, same as `scroll`/`hover`/etc. |
| 14 | **Typed-secret protection is worker-memory only** | Forced masking of fields the agent typed a credential into, and the credential egress check, are held in worker memory; after a service-worker restart (routine while a run waits for approval) a credential typed into a field no detector flags can be re-captured as plain text. Not addressed by the phase 5a vault work — still open. |
| 15 | **Vault key does not survive a browser restart** | The idle relock (15 min) and the `chrome.storage.session` mirror only cover worker suspension. `storage.session` itself is memory-backed and is cleared on browser exit, extension reload, or an explicit Lock — the user re-enters the passphrase in any of those cases. |
| 16 | **Firewall has no OCR** | The privacy firewall (`redaction/firewall.ts`) scans outbound *text* fields only. A card number rendered only as an image (a screenshot of a card, a canvas-drawn field) is invisible to it, same as to the rest of the text-based cascade. |
| 17 | **Firewall card prefixes don't cover RuPay or Maestro** | Its card-network prefix list is `4; 5[1-5]; 2[2-7]; 3[47]; 6`. A RuPay or Maestro card number that the DOM/regex cascade also misses would pass both layers. The cascade detectors remain the primary line for those. |
| 18 | **Firewall over-masks a measurable fraction of random grouped numbers** | Not a bug, the stated conservative bias: ~3% of random 16-digit 4×4-grouped numbers are falsely masked as a card, ~8% of random 12-digit 4-4-4-grouped numbers as an Aadhaar number. `dom_path`/manifest path strings are never scanned by the firewall. |

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
  memory only" design. 15-minute idle relock is enforced on every access
  (not just a timer), and Lock always wins over an access already in flight.
  The old plaintext v1 vault, and the API-key cookie where Chrome still has
  the old `cookies` permission cached, are migrated in and deleted only after
  the encrypted copy is durably persisted. Vault messages are accepted only
  from extension pages, never content scripts. `npm run test:vault`.
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
  session id — memory-backed, never in `storage.local`.
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
