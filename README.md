# ATHENA — Privacy-Preserving Browser-Native Vision Agent

A browser extension and reasoning server that let a cloud VLM understand and act
on a user's screen **without ever receiving the sensitive parts of it**. All
perception and redaction run locally; only sanitized, structured context crosses
the network.

Spec: [`PRD_Privacy_Preserving_Vision_Agent.md`](PRD_Privacy_Preserving_Vision_Agent.md) ·
Agent guidance: [`CLAUDE.md`](CLAUDE.md)

---

## Prerequisites

| | |
|---|---|
| Node | ≥ 22 (the test harnesses use the global `WebSocket` and top-level `await`) |
| Python | ≥ 3.11 |
| [uv](https://docs.astral.sh/uv/) | for the server (a plain venv works too — see below) |
| Chrome | ≥ 116 (`google-chrome-stable`; the harnesses drive it headless) |

---

## Quick start

### 1. Server

```bash
cd server
uv sync
uv run uvicorn main:app --port 8787
```

Port **8787 matters** — it is what the extension's `host_permissions` allows, and
the extension can reach nothing else. Check it came up:

```bash
curl -s localhost:8787/healthz
# {"status":"ok","provider":"mock","ingress_policy":"reject"}
```

It runs with **zero configuration** on a deterministic mock provider: no API key,
no GPU, no connectivity. See [Reasoning backend](#reasoning-backend) to switch.

<details>
<summary>Without uv</summary>

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install 'fastapi>=0.115' 'uvicorn[standard]>=0.32' 'pydantic>=2.9' 'anthropic>=0.40' httpx pytest
uvicorn main:app --port 8787
```
</details>

### 2. Extension

```bash
cd extension
npm install
npm run fetch:model     # UltraFace, 1.2 MB — face detection is skipped without it
npm run build           # -> extension/dist
```

### 3. Load it

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `extension/dist`
3. If you want to demo the local fixture files, open the extension's **Details**
   and enable **Allow access to file URLs**. (Or serve them over HTTP — see
   [Demo scenarios](#demo-scenarios).)

### 4. Store demo credentials

Scenario A types a password the server never sees. The executor resolves
`value_ref` against a local vault, and **refuses rather than typing an empty
string** if the slot is missing — so populate it first.

Extension **Details → Extension options**, then add two slots:

| slot | value |
|---|---|
| `username` | anything, e.g. `demo-user` |
| `password` | anything, e.g. `demo-secret-123` |

> This vault is **not** a password manager. Chrome exposes no API for reading the
> real one, so values sit unencrypted in `chrome.storage.local`. Use throwaway
> test credentials. The options page says the same thing.

---

## Using it

Click the ATHENA toolbar icon on any normal `http(s)` page. The **side panel**
opens beside the page and stays there — including across tab switches, which is
the point: the approval prompt has to survive long enough to approve it.

| | |
|---|---|
| **Ask ATHENA** | captures → detects → redacts locally, sends only the sanitized context, then shows the plan it gets back |
| **Analyze page safely** | the same capture → detect → redact with no network request at all |
| **View what will be shared** | the redaction manifest and the exact request body |
| **Demo view** | the full-page side-by-side — this is the one to show people |
| **Threshold slider** | lower = more redaction. Default 0.5, deliberately conservative |
| **Approve and proceed** | reviews the plan in a modal, then executes it against the live page |
| **New session** | discards the token mapping (`[EMAIL_1]` → value) |

The panel reads top to bottom as the argument: what page this is, what stayed on
the device, the ask box, what local perception found, what would actually be
sent, what the server proposed, and the activity log. The **Settings** tab holds
the server URL and the local vault.

`activeTab` is granted per tab when you click the icon, so the panel can only
inspect a page you have invoked it on. On any other tab it says so rather than
showing a stale title — and when you switch away from a captured page it marks
itself stale instead of implying the capture still describes what you are looking at.

The **demo view** has three columns — what was on screen, what was detected
(Tier 1 red, Tier 2 amber), and the exact bytes that crossed the network beside
the redaction manifest — then the plan the server returned and the outcome of
each action. **Capture & plan** runs the whole loop; **Execute on the live page**
applies the plan.

A rendered example is written to `eval/results/viewer.png` by
`npm run preview:viewer`.

---

## Demo scenarios

Serve the fixtures (avoids the file-URL toggle):

```bash
cd eval/fixtures && python3 -m http.server 8080
```

| Scenario | Page | Task to type |
|---|---|---|
| **A** — credential protection | `localhost:8080/bank-login.html` | `Log me in to this portal.` |
| **B** — faces | `localhost:8080/video-call.html` | `Find and click mute.` |
| **C** — structured PII | `localhost:8080/kyc-form.html` | `Which required fields are still empty?` |

Scenario B needs the test photograph:

```bash
cd extension && npm run fetch:demo-faces
```

It is **not committed** — it is a picture of real people, and real faces do not
belong in this repository. Without it the participant tiles render as
placeholders and the DOM half of the scenario still works.

---

## Reasoning backend

Set on the **server** process. The extension does not care which is running.

```bash
# 1. mock (default) — deterministic, offline, no key. What the tests use.
uv run uvicorn main:app --port 8787

# 2. cloud VLM
ATHENA_PROVIDER=anthropic uv run uvicorn main:app --port 8787

# 3. self-hosted open-weights VLM behind vLLM / SGLang / Ollama
ATHENA_PROVIDER=openai-compat \
ATHENA_VLM_BASE_URL=http://127.0.0.1:8000/v1 \
ATHENA_VLM_MODEL=Qwen/Qwen2-VL-7B-Instruct \
  uv run uvicorn main:app --port 8787
```

`/healthz` reports which one is live, so a demo cannot silently run on the mock.

> Option 3 is implemented against the OpenAI-compatible chat API but **has not
> been run against real Qwen2-VL weights**. Treat it as untested until someone
> points it at a live server.

### Environment variables

| Variable | Default | |
|---|---|---|
| `ATHENA_PROVIDER` | `mock` | `mock` / `anthropic` / `openai-compat` |
| `ATHENA_MODEL` | `claude-opus-5` | cloud model id |
| `ATHENA_VLM_BASE_URL` | `http://127.0.0.1:8000/v1` | self-hosted endpoint |
| `ATHENA_VLM_MODEL` | `Qwen/Qwen2-VL-7B-Instruct` | self-hosted model id |
| `ATHENA_INGRESS_POLICY` | `reject` | `reject` fails closed; `redact` scrubs and continues |
| `ATHENA_LOG_LEVEL` | `INFO` | |
| `ATHENA_ORT_EP` | `wasm` | build flag: `webgpu` ships the 26.5 MB runtime instead of 13.3 MB |

---

## Tests

```bash
cd extension
npm run typecheck
npm run smoke            # selectors resolve uniquely, bboxes well-formed
npm run test:redaction   # no planted value survives; structure does (both form fixtures)
npm run test:faces       # detector runs in a browser and finds faces
npm run test:scenario-b  # 22 faces detected → 0 after blurring
npm run test:e2e         # full loop: no secret out, no secret back, field still filled
npm run preview:viewer   # renders the demo view with real data -> eval/results/viewer.png

cd ../server && uv run pytest    # 26 tests: ingress, planner guardrails, endpoint
```

Each harness starts its own Chrome (and, where needed, its own server) and cleans
up after itself. `test:e2e`, `test:scenario-b` and `preview:viewer` need
`npm run fetch:model`; `test:scenario-b` also needs `fetch:demo-faces`.

## Eval

```bash
node eval/measure_labels.mjs                  # labels -> annotations with measured boxes
node eval/predict.mjs                         # replay the real cascade over the corpus
python3 eval/run_eval.py                      # precision / recall / F1 / IoU

node eval/latency_stages.mjs 20               # 20 timed runs
python3 eval/latency_bench.py                 # waterfall with p50 / p95
```

Adding a screen: write `eval/corpus/labels/<id>.labels.json` naming each
sensitive item by CSS selector, put its page under `eval/fixtures/`, re-run the
three commands above. Hand-annotated screens go straight into
`eval/corpus/screens/` in the same format — see
[`eval/corpus/README.md`](eval/corpus/README.md).

---

## Layout

```
extension/
  src/capture/        DOM snapshot + screenshot (content script)
  src/perception/     UltraFace via ONNX Runtime Web, in an offscreen document
  src/pii-detection/  DOM heuristics → regex/checksums (the cascade)
  src/redaction/      tokens, text masking, pixel compositing, manifest
  src/executor/       acts on the real, unredacted DOM
  src/background/     service worker: orchestration + the only network call
  src/viewer/         the side-by-side demo page
server/app/
  ingress.py          independent PII re-check before anything is logged or sent
  prompt.py           redaction-aware system prompt
  action_planner.py   selector allowlist, no-secret-injection guardrails
  providers/          mock / cloud / self-hosted
eval/                 corpus, scorer, latency bench
```

**The trust boundary is the network call, not the browser.** The local agent may
read and act on the real page — it is the user's own browser. Redaction applies
only to what is serialized and sent, which is why the extension can type a real
password into a real password field while the server only ever sees
`[REDACTED:PASSWORD]`.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| *"Cannot capture a browser-internal page"* | `chrome://`, the Web Store, or a PDF viewer. Open a normal page. |
| *"No access to that tab yet"* in the demo view | `activeTab` lapsed. Open the panel on the page you want, then launch the demo view from there. |
| The panel says *"Panel is stale"* | You switched tabs after capturing. Capture again for the new tab. |
| Nothing happens on a `file://` page | Enable **Allow access to file URLs** in the extension's Details, or serve over HTTP. |
| *"No local credential is stored for user_saved:password"* | Add the vault slots (step 4). |
| The perception card's note reads `faces —` | `npm run fetch:model` was skipped, or the page has no faces. |
| Server unreachable from the extension | It must be on port **8787** — the only origin `host_permissions` allows. |
| `npm run test:*` cannot find Chrome | `ATHENA_CHROME=/path/to/chrome npm run test:e2e` |
| Server rejects with `raw_pii_in_payload` | Working as intended: the client's redaction missed something the server caught. It names the path and pattern, never the value. |

---

## Results

2 screens, 24 labelled items, threshold 0.5:

| | precision | recall | F1 |
|---|---|---|---|
| overall | 1.000 | 0.917 | 0.957 |
| tier 1 | 1.000 | 1.000 | 1.000 |
| tier 2 | 1.000 | 0.846 | 0.917 |

Redaction precision (pixel regions, IoU ≥ 0.5): tier 1 **1.000**, overall 0.909.
All three PRD §8 targets met.

Latency p50/p95 ms — capture 1.1/1.5 · screenshot 39.5/66.0 · perception
14.4/16.8 · redaction 16.5/18.4 · network 4.0/6.1 · execute 0.7/1.0 →
**total 76.1/105.4**, local portion 71.4 ms against a 300 ms budget.

Package ~15 MB (13.3 MB ONNX runtime + 1.2 MB model) against a 20 MB budget.

**Read the detection numbers as an upper bound, not an estimate.** Two fixture
screens written by the same author as the detectors measure internal
consistency, not generalisation. PRD §8 calls for ≥ 50 screens.

---

## Limitations

Stated plainly, because overclaiming here is worse than underclaiming.

1. **Redaction is heuristic, not provably complete.** A PII format outside the
   pattern library passes through. Mitigated by conservative thresholds and the
   server-side re-check; not eliminated.
2. **Names and addresses in free prose are not detected.** Regex cannot bound
   them and the DOM gives no context inside a paragraph. The local NER model that
   would catch them was cut. This is visible in the recall number, not hidden
   behind it.
3. **A service-specific customer identifier has no home in the taxonomy.**
   `MB4470193` passes through. Adding a type is a product decision, so it is
   named rather than quietly invented.
4. **Pixel geometry is node-granular.** A detection spanning part of a paragraph
   is masked with the paragraph's box — over-redaction, never under-redaction.
   Text redaction is exact regardless.
5. **Capture is viewport-only.** Content below the fold is not snapshotted,
   redacted, or sent.
6. **The server is trusted to honour the redaction contract.** Schema validation
   and redaction-aware prompting add friction; they are not a cryptographic
   guarantee. This is a heuristic redaction pipeline, **not** a zero-trust
   system, and should not be described as one.
7. **The credential vault is a demo, not a password manager.** See step 4.
8. **Face blurring covers vision only.** Voice, filenames and other non-visual
   identity leaks on the same page are out of scope.
9. **The eval corpus is 2 self-authored screens.** See above.
