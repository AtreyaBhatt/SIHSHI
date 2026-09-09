# PPVA — Privacy-Preserving Browser-Native Vision Agent

A browser extension and reasoning server that let a cloud VLM understand and act
on a user's screen **without ever receiving the sensitive parts of it**. All
perception and redaction run locally; only sanitized, structured context crosses
the network.

Full spec: [`PRD_Privacy_Preserving_Vision_Agent.md`](PRD_Privacy_Preserving_Vision_Agent.md).
Agent guidance: [`CLAUDE.md`](CLAUDE.md).

---

## The claim, and how it is checked

> The agent completes the task, and the credential never existed anywhere outside
> the machine.

That is asserted mechanically rather than argued. `npm run test:e2e` starts the
real server, drives real Chrome over a mock banking portal, and checks all three
halves at once:

```
the request carries no secret:
  ok   user_saved:username value absent
  ok   user_saved:password value absent
  ok   the page's own password value absent

the response carries no secret, only references:
  ok   credentials are named by reference, not supplied
  ok   every selector was one we sent

the fields were actually filled:
  ok   password field holds the locally-resolved credential
  ok   form submitted — page navigated
```

Scenario B makes the visual half checkable the same way — detect faces, blur
them, then **run the detector again on the blurred image**:

```
faces        22 before redaction → 0 after
  ok   mute button present with label "Mute microphone"
```

---

## Architecture

```
BROWSER (trusted)                                    │  SERVER (untrusted)
                                                     │
capture ─→ perception ─→ detection ─→ redaction ─────┼─→ ingress ─→ reasoning ─→ planner
 DOM +      UltraFace     DOM heuristics   tokens,   │   re-check    redaction-   selector
 screenshot  via ONNX     → regex          masks,    │   for PII     aware VLM    allowlist
                          → (NER: cut)     manifest  │                            value_ref
                                                     │
executor ←───────────────────────────────────────────┼──────────────── action plan (JSON)
 acts on the REAL, unredacted DOM                    │
```

**The trust boundary is the network call, not the browser.** The local agent may
read and act on the real page — it is the user's own browser. Redaction applies
only to what is serialized and sent. Consequently the extension can type a real
password into a real password field while the server never learns it exists as
anything but `[REDACTED:PASSWORD]`.

Three tiers (PRD §4.3): Tier 1 hard-block (`[REDACTED:PASSWORD]`, solid black
box), Tier 2 mask but preserve shape (`[PHONE_1]`, `a***@***.org`), Tier 3
structural and passed through untouched — labels, roles, button text, layout.
Tier 3 is what lets the agent still do the job.

### Where the guarantees actually live

| Property | Enforced by |
|---|---|
| A raw snapshot cannot reach the network | `requestPlan()` takes an `AgentRequest`, a type only `redaction/build-request.ts` produces |
| Only one origin is reachable | `host_permissions` names one host; `grep -rn 'fetch(' extension/src` returns two lines, both in `agent-client.ts` |
| A leak fails loudly | `build-request.ts` re-scans the finished payload and throws rather than return one that still matches |
| A buggy client is caught anyway | `server/app/ingress.py`, an *independent* reimplementation — sharing code would let one bug defeat both layers |
| The model cannot invent a target | `action_planner.py` drops any selector not in the `dom_summary` we sent |
| The server cannot supply a secret | Tier 1 fields must use `value_ref`; a literal is rejected |
| Tokens cannot outlive a session | The registry lives in worker memory and is never persisted |

---

## Results

### PII detection — 2 screens, 24 labelled items, threshold 0.5

| | TP | FP | FN | precision | recall | F1 |
|---|---|---|---|---|---|---|
| overall | 22 | 0 | 2 | **1.000** | **0.917** | 0.957 |
| tier 1 | 11 | 0 | 0 | 1.000 | 1.000 | 1.000 |
| tier 2 | 11 | 0 | 2 | 1.000 | 0.846 | 0.917 |

Redaction precision (pixel regions, strict IoU ≥ 0.5): **tier 1 = 1.000**,
tier 2 = 0.818, overall 0.909.

| PRD §8 target | measured | |
|---|---|---|
| Tier-1 detection recall ≥ 0.90 | 1.000 | PASS |
| Overall detection precision ≥ 0.80 | 1.000 | PASS |
| Tier-1 redaction precision ≥ 0.85 | 1.000 | PASS |

**Read these as an upper bound, not an estimate.** Two fixture screens written by
the same author as the detectors measure internal consistency, not
generalisation. PRD §8 calls for ≥ 50 screens; the harness consumes real
annotations unchanged, and the honest next step is annotating pages neither the
detectors nor their author has seen.

Both false negatives are the same documented gap: a person's name and a postal
address in free prose, which need the local NER model cut from this build. Both
off-target pixel regions are the prose email and phone, masked at 489×77
paragraph granularity against ~100×17 ground truth (IoU 0.14) — the
node-granular geometry limitation appearing as a number rather than a caveat.

### Latency — 10 runs, p50 / p95 ms

| stage | p50 | p95 | |
|---|---|---|---|
| capture | 1.1 | 1.5 | DOM walk into a serialized snapshot |
| screenshot | 39.5 | 66.0 | pixels off the tab |
| perception | 14.4 | 16.8 | local face detection (ONNX, WASM SIMD) |
| redaction | 16.5 | 18.4 | masking, manifest, pixel compositing |
| network | 4.0 | 6.1 | round trip (mock provider — transport only) |
| execute | 0.7 | 1.0 | actions applied to the live DOM |
| **total** | **76.1** | **105.4** | local portion 71.4 ms |

Budgets: local pipeline ≤ 300 ms (**71.4**), end-to-end ≤ 3 s (**105 ms** against
the mock). A real VLM call lands in the `network` row and will dominate; the
local stages are what this project controls.

### Resource footprint

| | |
|---|---|
| Package total | **~15 MB** (13.3 MB ONNX Runtime wasm + 1.2 MB model), inside PRD §8's 20 MB |
| Face model | UltraFace RFB-320, MIT, 1.21 MB — 25/25 faces on a 1024×791 group photo |
| Session init | ~236 ms, once per worker lifetime |
| Payload | ~94 KB p50 including the redacted screenshot |

`PPVA_ORT_EP=webgpu npm run build` ships the WebGPU-capable runtime instead
(26.5 MB, over budget). The code requests WebGPU and falls back to WASM either
way; on the default build that fallback is simply always taken.

---

## Running it

```bash
# server — runs with zero configuration on a deterministic mock provider
cd server && uv sync && uv run uvicorn main:app --port 8787

# extension
cd extension && npm install && npm run fetch:model && npm run build
# then chrome://extensions → Developer mode → Load unpacked → extension/dist
```

Open a page, click the PPVA icon, then **Open demo view** for the side-by-side.

For the cloud VLM: `PPVA_PROVIDER=anthropic` (credentials from the environment).
For a self-hosted Qwen2-VL or LLaVA behind vLLM/SGLang/Ollama:
`PPVA_PROVIDER=openai-compat PPVA_VLM_BASE_URL=http://…/v1`.

### Demo fixtures

| Scenario | Fixture | Task |
|---|---|---|
| A — credential protection | `eval/fixtures/bank-login.html` | "Log me in to this portal." |
| B — faces | `eval/fixtures/video-call.html` | "Find and click mute." |
| C — structured PII | `eval/fixtures/kyc-form.html` | "Which required fields are still empty?" |

Scenario B needs `npm run fetch:demo-faces`. That photograph is of real people
and is deliberately **not committed** — real faces do not belong in this
repository. Without it the tiles render as placeholders.

## Tests

```bash
cd extension
npm run smoke            # selectors resolve uniquely, bboxes well-formed
npm run test:redaction   # no planted value survives; structure does (both form fixtures)
npm run test:faces       # detector runs in a browser and finds faces
npm run test:scenario-b  # 22 faces → 0 after blurring
npm run test:e2e         # full loop: no secret out, no secret back, field still filled
npm run preview:viewer   # renders the demo view with real data → eval/results/viewer.png

cd ../server && uv run pytest          # 26 tests: ingress, planner guardrails, endpoint

node eval/measure_labels.mjs && node eval/predict.mjs && python3 eval/run_eval.py
node eval/latency_stages.mjs 20 && python3 eval/latency_bench.py
```

---

## Limitations

Stated plainly, because overclaiming here is worse than underclaiming.

1. **Redaction is heuristic, not provably complete.** A PII format outside the
   pattern library passes through. Mitigated by conservative thresholds and the
   server-side re-check; not eliminated.
2. **Names and addresses in free prose are not detected.** Regex cannot bound
   them and the DOM gives no context inside a paragraph. The local NER model that
   would catch them was cut. This is visible in the recall number above, not
   hidden behind it.
3. **A service-specific customer identifier has no home in the taxonomy.**
   `MB4470193` passes through. Adding a type is a product decision, so it is
   named rather than quietly invented.
4. **Pixel geometry is node-granular.** A detection spanning part of a paragraph
   is masked with the paragraph's box — over-redaction, never under-redaction,
   which is the direction PRD §9 commits to. Text redaction is exact regardless.
5. **Capture is viewport-only.** Content below the fold is not snapshotted,
   redacted, or sent.
6. **The server is trusted to honour the redaction contract.** Schema validation
   and redaction-aware prompting add friction; they are not a cryptographic
   guarantee. This is a heuristic redaction pipeline, **not** a zero-trust
   system, and it should not be described as one.
7. **The credential vault is a demo, not a password manager.** Chrome exposes no
   API for reading the real one, so `value_ref` resolves against unencrypted
   `chrome.storage.local`. The options page says so to the user's face.
8. **Face blurring covers vision only.** Voice, filenames and other non-visual
   identity leaks on the same page are out of scope.
9. **The eval corpus is 2 self-authored screens.** See above.
