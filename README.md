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
`value_ref` against a local encrypted vault, and **refuses rather than typing
an empty string** if the slot is missing — so populate it first.

Extension **Details → Extension options**:

1. **First time**: no vault exists yet. Choose a passphrase (8+ characters),
   confirm it, and press **Create vault**. This derives an AES-GCM-256 key
   from the passphrase (PBKDF2-SHA256, 600k iterations) and encrypts
   everything you add below it.
2. **Add two slots**:

   | slot | value |
   |---|---|
   | `username` | anything, e.g. `demo-user` |
   | `password` | anything, e.g. `demo-secret-123` |

3. On later sessions, **Unlock** with the same passphrase.

> See [Vault](#vault) below for what this actually protects against — it is
> **not** a password manager.

---

## Using it

Click the ATHENA toolbar icon on any normal `http(s)` page. The **side panel**
opens beside the page and stays there — including across tab switches, which is
the point: the approval prompt has to survive long enough to approve it.
Clicking the icon always opens the panel and grants one-off access to that tab;
it never closes the panel. If you navigate to another site after opening the
panel, click the icon again or enable the site persistently.

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

Clicking the icon grants one-off access to that tab. **Enable on this site** in the
page card grants ATHENA the site persistently (`optional_host_permissions`), so
captures keep working across reloads and navigations there; **Disable** revokes
it. Nothing is granted on sites you have not enabled.
**Enable on this site** only appears once the panel can read the tab's URL —
click the icon first on a site you have not enabled.

The permission prompt itself cannot be scripted; the harnesses cover everything up to it.

### Run the agent

Type a goal in the panel and press **Start**. The agent loop repeats capture →
plan → gate → execute → settle, one step at a time, until the model calls
`done` or a limit is hit.

| | |
|---|---|
| **Approve every step** | every planned action is shown for approval before it runs |
| **Approve sensitive only** | pauses for approval on: credentials (any `value_ref`), `navigate`, the Enter key, clicks on buttons and links, typing into any redacted field, and anything the model marks sensitive. Routine typing, selecting and scrolling proceed without a click |
| **Stop** | takes effect after the current action batch finishes; nothing further is planned or executed |
| Step cap | `storage.local` key `athena:max-steps` (default 25); no Settings control yet — set it via the extension's storage directly |

The model's plan is nine verbs plus a `done` signal: `click`, `type`, `select`,
`key`, `hover`, `scroll`, `go_back`, `navigate`, `wait`. Each action carries a
`risk` (`routine` or `sensitive`) that decides whether **Approve sensitive
only** stops for it. A step can instead set `done: true` with a `result`
string and no actions — the model answering a question about the page (for
example, naming which required fields are still empty) without acting at all.
Scenario C in [Demo scenarios](#demo-scenarios) exercises exactly this path.

`focus` and `read` are **not** verbs — an earlier iteration had them; they were
cut in favor of the nine above.

The **demo view** has three columns — what was on screen, what was detected
(Tier 1 red, Tier 2 amber), and the exact bytes that crossed the network beside
the redaction manifest — then the plan the server returned and the outcome of
each action. **Capture & plan** runs the whole loop; **Execute on the live page**
applies the plan.

A rendered example is written to `eval/results/viewer.png` by
`npm run preview:viewer`.

---

## BlindFill: acting on values the model never sees

Two separate mechanisms let the model direct an action against a value it
never received, so it can still fill a form field it can only see as a
placeholder.

- **On-page sensitive values → numbered tokens.** A Tier-1 value the local
  cascade already found on the page (an Aadhaar number, a card number, a bank
  account) is sent as an opaque token, e.g. `[AADHAAR_1]`, not just masked. If
  the model's plan needs to move that value into another field, it types the
  token itself: `{"action":"type","selector":"input#aadhaar","value_token":"[AADHAAR_1]"}`.
  The worker resolves `value_token` locally against the run's `TokenRegistry`
  for that one approved step and types the real value; the model only ever
  saw and echoed the token text.
- **Stored profile/credential values → `value_ref`.** For values that never
  appeared on the page at all (a saved name, the vault's `username`/`password`
  slots), the model names a slot with `value_ref` (e.g. `user_saved:name`).
  It may only use a name the client listed under `## available_refs` in the
  request — a section outside the redacted `<page_data>` fence that names
  *which* refs exist, never their values. A `value_ref` naming anything else
  is rejected by the guardrails, not executed.

Both `value_ref` and `value_token` actions are forced to `risk: sensitive`
regardless of what the model said, so under **Approve sensitive only** every
BlindFill fill still stops for a click before it runs. `npm run
test:e2e:blindfill` exercises the whole path end to end against a
profile-to-form fixture: no profile value or vault secret ever appears in a
request or response body, only the tokens/refs and the plan that resolves
them locally.

---

## Vault

An encrypted local store for the `value_ref` credential slots and the
provider API key — PRD §7.2's indirection layer, so a secret named by the
model is resolved on-device and never crosses the network.

- **Passphrase-protected.** The vault is created with a passphrase (8+
  characters, confirmed) and unlocked with the same passphrase thereafter.
  The AES-GCM-256 key is derived with PBKDF2-SHA256 (600k iterations); only
  ciphertext, salt, IV and a `api_key_present` flag sit in `chrome.storage.local`.
- **Unlock survives the worker going to sleep.** Chrome routinely suspends the
  MV3 service worker. To avoid re-prompting for the passphrase every time that
  happens, the derived key's raw bytes are kept in `chrome.storage.session`
  (memory-backed, cleared on browser exit) so a restarted worker can pick the
  unlocked vault back up. This **supersedes** an earlier "key stays in worker
  memory only" design. The in-memory operational key itself is non-extractable.
  **Residual risk:** while unlocked, the raw key is readable by any extension
  page (not by content scripts, i.e. not by the pages you visit) — this
  protects against disk access and other extensions reading `storage.local`,
  not against a compromised extension page. It is not a cryptographic vault
  and not a password manager.
- **15-minute idle relock**, enforced on every access, not just a timer: no
  `value_ref` resolve, API-key read, or vault write in the last 15 minutes
  locks it again and clears the session-stored key. **Lock** in the panel or
  options page also locks it immediately and always wins over an access that
  was already in flight.
- **What's inside:** the named credential slots you add (e.g. `username`,
  `password`) and, optionally, the provider API key — never a page value, a
  redaction token, or a passphrase.
- **Migration note:** on first unlock after an upgrade, the old plaintext v1
  vault (and, where Chrome still has the old `cookies` permission cached, the
  API key that used to live in a cookie) is imported and then deleted — but
  only after the encrypted copy is safely persisted. If Chrome has already
  dropped the `cookies` permission, the old API-key cookie cannot be read and
  you re-enter the key once in Settings.

---

## Privacy firewall

A second, independent layer that runs on the finished request payload, after
the normal PII cascade and redaction — not instead of it. It is written
without importing anything from `pii-detection/`, on purpose, so a bug in one
does not defeat the other.

- **Independent rules.** Its own email/card/Aadhaar/PAN/IFSC/SSN/UPI/phone
  patterns (Luhn- and Verhoeff-checked, windowed against longer digit runs)
  scan every outbound text field, regardless of what the cascade already
  found or missed.
- **Every hit is masked, including Tier 1.** A firewall hit — Tier 1 or
  Tier 2 — is replaced with a numbered opaque token and given a manifest
  entry (`detector: firewall:<rule>`), the same as any other redaction. It
  does **not** fail the request; masking keeps the agent usable while still
  keeping the raw value off the network.
- **Fail-closed rescan blocks only on a residual match.** After masking (up
  to three passes, since masking one hit can reveal another lurking behind
  it), the firewall rescans its own output. Only if a match still survives
  that rescan does the request block, tagged `firewall:residual` — which
  means the firewall itself has a gap, not that the page contained something
  ordinary.
- **Precision trade-off, measured on random grouped numbers** (report this
  plainly, per CLAUDE.md's bias toward over-redaction): about **3%** of random
  16-digit, 4×4-grouped numbers are falsely masked as a card number, and about
  **8%** of random 12-digit, 4-4-4-grouped numbers are falsely masked as an
  Aadhaar number. Card windows require a card-network prefix (`4`, `51`–`55`,
  `22`–`27`, `34`/`37`, `6`); **RuPay and Maestro prefixes are not covered** by
  the firewall, so the PII-cascade detectors remain the primary line for
  those. DOM paths and manifest `dom_path` strings are not scanned by the
  firewall.
- **Demo switch.** Settings/the Privacy card can disable named cascade
  detectors (by their `dom:*`/`regex:*` name) for a session, so a screen still
  gets masked by the firewall alone — proof the second layer actually works,
  not a way to turn redaction off. Only detectors for a type the firewall also
  covers (email, card number, Aadhaar, PAN, IFSC, SSN, phone, and `account_id`
  for UPI ids) can be switched off; any other name is rejected. The switch lives in `chrome.storage.session`
  (gone on browser restart) and shows a red **"detectors off: …"** chip on
  the Privacy card whenever it's non-empty.

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
| `ATHENA_MODEL_TIMEOUT` | `60` | seconds before a cloud call is abandoned (the client gets an empty plan, not a hang) |
| `ATHENA_VLM_TIMEOUT` | `120` | same, for the self-hosted endpoint |
| `ATHENA_INGRESS_POLICY` | `reject` | `reject` fails closed; `redact` scrubs and continues |
| `ATHENA_LOG_LEVEL` | `INFO` | |
| `ATHENA_ORT_EP` | `wasm` | build flag: `webgpu` ships the 26.5 MB runtime instead of 13.3 MB |

---

## Tests

```bash
cd extension
npm run typecheck
npm run smoke            # selectors resolve uniquely, bboxes well-formed
npm run test:capture      # shadow DOM paths resolve, iframes are black-boxed, node budget keeps interactive nodes
npm run test:redaction   # no planted value survives; structure does (both form fixtures)
npm run test:faces       # detector runs in a browser and finds faces
npm run test:scenario-b  # 22 faces detected → 0 after blurring
npm run test:e2e         # Scenario A end to end: no secret out, no secret back, field still filled
npm run test:e2e:c       # Scenario C end to end: the model answers without acting
npm run test:e2e:blindfill # BlindFill end to end: value_token + value_ref fill a form, no profile/vault value ever leaves the device
npm run test:executor    # the nine verbs against a live DOM, incl. Enter→requestSubmit and Tab focus
npm run test:reasoning   # guardrails (verbs, value/value_ref/value_token, risk floor, typed-secret masking) and the plan split, incl. the privacy firewall
npm run test:loop        # the agent loop state machine, in Node — no browser
npm run test:vault       # the encrypted vault: create/unlock, idle relock, session-key restore across a worker restart, lock-wins-over-in-flight-access
npm run preview:viewer   # renders the demo view with real data -> eval/results/viewer.png

cd ../server && uv run pytest    # ingress, planner guardrails, endpoint, provider failure modes
```

Each harness starts its own Chrome (and, where needed, its own server) and cleans
up after itself. `test:e2e`, `test:e2e:c`, `test:e2e:blindfill`, `test:scenario-b`
and `preview:viewer` need `npm run fetch:model`; `test:scenario-b` also needs
`fetch:demo-faces`. `test:capture` covers `shadow-iframe.html`, `long-page.html`
and `many-controls.html`. `test:loop` and `test:vault` run as pure Node state
machines with no browser at all.

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
  src/redaction/      tokens, text masking, pixel compositing, manifest, privacy firewall
  src/executor/       acts on the real, unredacted DOM
  src/background/     service worker: orchestration + the only network call
  src/shared/         schema, path resolution, encrypted vault
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

4 screens, 35 labelled items, threshold 0.5:

| | precision | recall | F1 |
|---|---|---|---|
| overall | 1.000 | 0.943 | 0.971 |
| tier 1 | 1.000 | 1.000 | 1.000 |
| tier 2 | 1.000 | 0.900 | 0.947 |

Redaction precision (pixel regions, IoU ≥ 0.5): tier 1 **1.000**, tier 2 0.833, overall 0.909.
The tier 2 figure dropped from 0.882 when a prose email was added to the corpus: text redaction is exact, but the pixel mask covers the whole paragraph box (over-redaction, never under-redaction).
All three PRD §8 targets met.

Latency p50/p95 ms — capture 1.0/2.0 · screenshot 39.5/55.4 · perception
12.6/16.8 · redaction 13.0/17.6 · network 4.0/6.0 · execute 0.8/1.5 →
**total 72.3/89.7**, local portion 66.2 ms against a 300 ms budget.

Package ~15 MB (13.3 MB ONNX runtime + 1.2 MB model) against a 20 MB budget.

**Read the detection numbers as an upper bound, not an estimate.** Four fixture
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
3. **Pixel geometry is node-granular.** A detection spanning part of a paragraph
   is masked with the paragraph's box — over-redaction, never under-redaction.
   Text redaction is exact regardless.
4. **Capture is viewport-only.** Content below the fold is not snapshotted,
   redacted, or sent.
5. **The server is trusted to honour the redaction contract.** Schema validation
   and redaction-aware prompting add friction; they are not a cryptographic
   guarantee. This is a heuristic redaction pipeline, **not** a zero-trust
   system, and should not be described as one.
6. **The vault protects against disk access and other extensions, not a
   compromised extension page.** It is encrypted at rest (PBKDF2 → AES-GCM),
   but while unlocked the raw key sits in `chrome.storage.session`, which any
   extension page (not a content script) can read. See [Vault](#vault). It is
   a demo, not a password manager.
7. **Face blurring covers vision only.** Voice, filenames and other non-visual
   identity leaks on the same page are out of scope.
8. **The eval corpus is self-authored screens.** See above.
9. **Closed shadow roots are invisible.** They cannot be told apart from empty
    custom elements, so their pixels are not masked. Open shadow roots are walked.
10. **Frames are masked, not read.** An iframe's contents are black-boxed in the
    screenshot and declared as a `frame`; same-origin frames are not walked.
