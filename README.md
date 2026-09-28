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
  saw and echoed the token text. The guardrails accept a `value_token` only when the target
  field itself carries a manifest entry of the token's type (an empty Aadhaar
  box for an Aadhaar token), and never for a token the firewall minted.
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

**Limitation.** A token can only be typed into a field a detector classified
as the same type — a missed label, a field resolved to a different type,
split card/Aadhaar inputs, or a field below the fold or inside an iframe is
refused by the guardrail, and the user fills those by hand.

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
- **15-minute idle relock**, checked on the next vault access (there is no
  timer and no `alarms` permission): if there was no `value_ref` resolve,
  API-key read, or vault write in the last 15 minutes, that access locks the
  vault and clears the session-stored key; until then the key stays in the
  browser's session storage. **Lock** in the panel or options page locks it
  immediately and always wins over an access that was already in flight.
- **What's inside:** the named credential slots you add (e.g. `username`,
  `password`) and, optionally, the provider API key — never a page value, a
  redaction token, or a passphrase.
- **Migration note:** when you create the vault after an upgrade, the old plaintext v1
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

- **Independent rules.** Its own email/card/Aadhaar/PAN/IFSC/SSN/UPI/phone/IBAN
  patterns (Luhn-, Verhoeff- and mod-97-checked; a card window inside a longer
  digit run must have a card-like shape, and Aadhaar matches only a whole
  12-digit run) scan exactly these
  outbound fields, regardless of what the cascade already found or missed:
  `task_instruction`, every `dom_summary[].label` and `dom_summary[].value`,
  and every `prior_actions[].value`.
- **Every hit is masked, including Tier 1.** A firewall hit — Tier 1 or
  Tier 2 — is replaced with a numbered opaque token. A hit inside a page node
  (`dom_summary` label/value) also gets a manifest entry
  (`detector: firewall:<rule>`) with that node's box, so its pixels are
  blacked out too; a hit in the task instruction or in `prior_actions` is
  tokenised without a manifest entry (it has no pixels). It does **not** fail
  the request; masking keeps the agent usable while still keeping the raw
  value off the network. A firewall-minted token can never be typed back via
  `value_token` — only tokens the cascade declared can.
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
  covers (email, card number, Aadhaar, PAN, IFSC, SSN, phone) can be switched
  off — no account ids; any other name is rejected. The switch lives in `chrome.storage.session`
  (gone on browser restart) and shows a red **"detectors off: …"** chip on
  the Privacy card whenever it's non-empty.

---

## Detectors added in phase 5b

On top of the phase 5a cascade (DOM heuristics → regex/checksums → faces):

- **Exact-match bare name labels** — a label that is *exactly* `Name`,
  `Applicant Name`, `Father's Name`, etc. (see `eval/corpus/README.md`'s list)
  is `person_name`, Tier 2. `File name` / `Bank name` do not match.
- **UPI ids** (`name@bank`) — Tier 2 `account_id`, lower confidence than email
  so an overlapping email wins.
- **IBAN**, case-insensitive, validated by mod-97 — Tier 1 `bank_account`.
- **Non-ASCII digit folding** — Devanagari and other BMP decimal-digit ranges
  are folded to ASCII 1:1 in length before matching, so spans stay valid
  against the original string. Folding happens on one node's already-assembled
  text; a card/OTP/Aadhaar **split across sibling `<span>`s of non-ASCII
  digits is not grouped or detected** (known gap, see `eval/corpus/README.md`).
- **Card and Aadhaar numbers split across sibling `<input>`s**, and **split OTP
  boxes**, are grouped (`group_id`) and detected as one item. Split PIN boxes
  are **not** — the OTP context match has no `pin` term (postal PIN codes would
  false-positive).
- **QR images**, by element name only (`qr`, `qrcode`, `scan-to-pay`, …) —
  declared as `frame` (Tier 1) and black-boxed. **No decoding**: this is a
  name-based rule, not a QR reader, so a QR image with a different name is
  missed and a non-QR image named `qr-something` is over-redacted.
- **Every canvas larger than 32×32 px** is declared `frame` and black-boxed —
  closes the "canvas can paint text or an id the DOM walk never sees" gap.
  Stated limit: this **over-redacts charts and other non-sensitive canvases**;
  there is no way yet to tell a data visualization from a photographed card.

## Hidden text (capture-time)

Three rules drop text at capture, before any detector runs, and count what
they drop into `hidden_dropped` (surfaced to the model in the prompt and on
the metrics card, as a count only — never as which text):

1. Font size under 2 px.
2. Box under 2×2 px.
3. Text colour matching a **solid** ancestor background (walked up to
   `<body>`, tolerance 8 per RGB channel).

Text sitting over an image or a gradient is **kept** — rule 3 cannot tell
whether it is legible there, so it does not apply, on purpose (better a false
non-drop than blinding the model to a caption on a photo).

**Accepted over-drop:** 1×1 screen-reader-only text (the classic
visually-hidden accessibility pattern) is caught by rule 2 and dropped even
though it is not camouflage in the adversarial sense. This is stated as a
known limit, not silently absorbed — see HANDOFF.md.

## DeltaVision

Between one capture and the next (same session), `shared/delta.ts` decides
what can be skipped:

- **PII text detection always runs on the full snapshot, every step, with no
  exception.** DeltaVision never skips it.
- **The full-frame face pass runs on every step.** Never skipped either.
- **Only the per-region (crop) face pass of an image/svg/etc. media node
  whose hash is unchanged is skipped** — its previously-found face boxes are
  reused (padded) instead of being re-detected.
- `<video>` and `<canvas>` are **always** re-scanned — their pixels change
  under a constant hash.
- A media node is forced back into the re-scan set when: it just finished
  loading (`attrs.loaded` flips), a changed or newly-added node's box
  overlaps it, or *any* node was removed since the last step (conservative —
  something disappeared and it's unknown what it covered).
- A face-detector call that actually fails (not "no screenshot to scan")
  **withholds the screenshot for that step** and never becomes remembered
  state — text redaction is unaffected either way.

**Say the saving honestly:** what's skipped is the per-region face-detector
passes, not the whole perception stage — text detection and the full-frame
face pass are unconditional every step. `eval/latency_stages.mjs --loop`
demonstrates this on three consecutive captures of one page with no reload
between them (see [Results](#results)).

## Metrics card

A collapsed-by-default card in the side panel, six groups, every number
either measured in that run or copied from the bundled eval output
(`benchmark.json`, generated at build time from `eval/results/*.json`) —
nothing on it is hardcoded:

| Group | Rows | What it cannot show |
|---|---|---|
| Privacy | regions detected, redacted tier 1/tier 2, firewall masked/blocked, hidden nodes dropped, payload size | never a value, a label, or a selector's text |
| Boundary | **screenshot sent** — `redacted copy` or `none (withheld or unavailable)` | not a byte count of "what changed", just whether a screenshot left the device this step |
| Performance | capture, screenshot, perception, redaction, firewall, provider (network), execute, settle — each in ms | provider/execute/settle are `—` until that stage of the step actually runs |
| Resources | panel JS heap (`performance.memory.usedJSHeapSize`), CPU/GPU | CPU/GPU are **not exposed to extensions** and the card says so rather than guessing; the heap is the **panel's own**, not the worker's or the offscreen document's |
| Delta | nodes changed, media re-processed, faces reused (from `PayloadPreview.delta`) | — |
| Benchmark | detection tp/fp/fn (overall, tier 1, tier 2), redaction precision (IoU, tier 1 and tier 2), latency p50/p95 by stage, all dated `benchmark.generated_at` | a **snapshot from the last eval run**, not this session's own accuracy — it never changes while you use the extension |

## Portal demo script

`eval/fixtures/application-portal.html` is the one fixture built to carry a
judge through the whole story in one page. Eight moments, each backed by a
specific harness:

| # | Judge sees | Panel / DOM shows | Proven by |
|---|---|---|---|
| 1 | The browser sees the real data locally | Demo view's own-page column: real name, Aadhaar, card, photo, QR, canvas | `npm run test:e2e:portal` (asserts the real DOM values exist before capture) |
| 2 | The privacy view shows tokens | `[AADHAAR_1]`-style tokens and masked values in "View what will be shared" | `test:e2e:portal` — on-page Tier-1 values are tokenised, not just masked |
| 3 | The network inspector shows no raw values | DevTools Network tab on the `/agent/plan` request body | `test:e2e:portal`'s `portalPlantedSecrets` check — none of the fixture's planted name/card/Aadhaar/email/phone/address/account values appear in the request body |
| 4 | The server receives placeholders | Request body's `dom_summary`/`redaction_manifest` — types and tokens, no values | same assertion, plus `qrEntry`/`canvasEntry`/`faceEntry` manifest checks (QR and canvas as `frame`, a face entry present) |
| 5 | The server returns token actions | The plan: `value_ref`/`value_token` actions, never a literal secret | `test:e2e:portal`'s plan-body check (no planted secret in the response either) |
| 6 | The browser resolves locally | The form fills with the real stored profile values after approval | `test:e2e:portal`'s execution phase (typed values match the vault/profile, never the token text) |
| 7 | DeltaVision shows what was re-processed | The Delta card: nodes/media changed this step vs. reused | `npm run test:delta` (the state-machine logic `test:e2e:portal` itself doesn't re-run captures, so the multi-step behavior is Node-tested separately) |
| 8 | The firewall catches a value when a detector is switched off | The Privacy card's red "detectors off: …" chip, and the value still masked | `npm run test:redaction`'s disabled-detector pass — rebuilds the payload with a cascade detector off by name and confirms the firewall still masks that value |

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
npm run test:e2e:portal  # the portal demo fixture end to end: tokens, stored refs, faces, QR, canvas, hidden text and the firewall together
npm run test:executor    # the nine verbs against a live DOM, incl. Enter→requestSubmit and Tab focus
npm run test:reasoning   # guardrails (verbs, value/value_ref/value_token, risk floor, typed-secret masking) and the plan split, incl. the privacy firewall
npm run test:loop        # the agent loop state machine, in Node — no browser
npm run test:vault       # the encrypted vault: create/unlock, idle relock, session-key restore across a worker restart, lock-wins-over-in-flight-access
npm run test:delta       # DeltaVision as a pure state machine, in Node — no browser
npm run preview:viewer   # renders the demo view with real data -> eval/results/viewer.png
node scripts/test-provider.mjs      # provider settings, direct request formats, response guardrails, the dom:qr/dom:canvas media rules
node scripts/test-dom-heuristics.mjs # the DOM/attribute detector rules in isolation, in Node

cd ../server && uv run pytest    # ingress, planner guardrails, endpoint, provider failure modes
```

Each harness starts its own Chrome (and, where needed, its own server) and cleans
up after itself. `test:e2e`, `test:e2e:c`, `test:e2e:blindfill`, `test:e2e:portal`,
`test:scenario-b` and `preview:viewer` need `npm run fetch:model`; `test:scenario-b`
also needs `fetch:demo-faces`; `test:e2e:portal` scans its own fixture photo, no
separate fetch needed. `test:capture` covers `shadow-iframe.html`, `long-page.html`
and `many-controls.html`. `test:loop`, `test:vault`, `test:delta`, `test-provider.mjs`
and `test-dom-heuristics.mjs` run as pure Node, no browser at all.

## Eval

```bash
node eval/measure_labels.mjs                  # labels -> annotations with measured boxes
node eval/predict.mjs                         # replay the real cascade over the corpus
python3 eval/run_eval.py                      # precision / recall / F1 / IoU

node eval/latency_stages.mjs 20               # 20 timed runs
python3 eval/latency_bench.py                 # waterfall with p50 / p95

node eval/latency_stages.mjs --loop           # 3 captures, one page, DeltaVision between them (default fixture: video-call.html)
node eval/latency_stages.mjs --loop application-portal.html  # same, against a fixture that actually has media/faces to skip
```

`--loop` writes its steps under `loop.<fixture>` in `eval/results/latency.json`,
merged in alongside (never overwriting) a plain run's `runs` array. See
[DeltaVision](#deltavision) and [Results](#results) below for what it measures
and what came out of it.

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

5 screens, 51 labelled items, threshold 0.5 (phase 5b: added `edge-cases-01`,
`shadow-iframe-01`, `india-pii-01` on top of the phase 5a `bank-login-01` /
`kyc-form-01`):

| | precision | recall | F1 |
|---|---|---|---|
| overall | 1.000 | 0.961 | 0.980 |
| tier 1 | 1.000 | 1.000 | 1.000 |
| tier 2 | 1.000 | 0.913 | 0.955 |

Redaction precision (pixel regions, strict IoU ≥ 0.5): tier 1 **0.929**, tier 2
**0.810**, overall **0.878** — all three now computed and carried through to
`benchmark.json` (phase 5a only ever computed tier 1). Both misses are the same
known gap: names/addresses in free prose (`kyc-form-01`'s `b13`/`b14`). The two
tier-2 off-target regions dropping precision below 1.0 are the same
node-granular-pixel-mask limitation as before, now with more surface area
(more Tier-2 items in the corpus) to show it on.
All three PRD §8 targets met.

Latency p50/p95 ms (10 timed runs via `node eval/latency_stages.mjs`, mock
provider, as bundled in `eval/results/latency.json`) — capture 1.0/2.1 ·
screenshot 34/59 · perception 12.4/18.6 · redaction 12.1/17.9 · network 4/6 ·
execute 0.8/1.7. Numbers move run to run with headless Chrome's own jitter;
treat them as an order of magnitude, not a fixed budget line.

**DeltaVision loop mode** (`node eval/latency_stages.mjs --loop`, three
captures of one page, no reload between them):

| fixture | step | perception | nodes changed | media re-processed | faces reused |
|---|---|---|---|---|---|
| `video-call.html` (CSS-background tiles, no `<img>`/`<video>` nodes at all) | 1 | ~31 ms | 100% | 0% | 0 |
| | 2 | ~33 ms | 0% | 0% | 0 |
| | 3 | ~37 ms | 0% | 0% | 0 |
| `application-portal.html` (real `<img>` photo + QR + canvas) | 1 | ~111 ms | 100% | 100% | 0 |
| | 2 | ~28 ms | 0% | 0% | 25 |
| | 3 | ~26 ms | 0% | 0% | 25 |

Read plainly: `video-call.html` has no media nodes at all (its tiles are CSS
backgrounds), so it demonstrates the "nothing to reprocess" floor, not
DeltaVision's own skip logic — that's why the brief has you also run it
against `application-portal.html`, whose first step does a full region pass
(finding 25 faces on the profile photo) and whose second and third steps skip
every region pass and reuse all 25 boxes. What's actually skipped is the
per-region face-detector pass, not the whole perception stage — PII text
detection and the full-frame face pass ran on all six steps above; only the
region crops on unchanged images were skipped.

Package ~15 MB (13.3 MB ONNX runtime + 1.2 MB model) against a 20 MB budget.

**Read the detection numbers as an upper bound, not an estimate.** Five fixture
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
11. **The QR rule is name-based, not a decoder.** An element whose id/class/alt/
    filename doesn't mention `qr`/`qrcode`/`scan-to-pay` is missed even if it
    is a QR code; conversely a non-QR image with such a name is over-redacted.
12. **Every canvas over 32×32 px is black-boxed, unconditionally.** This closes
    a real leak (a canvas can paint text the DOM walk never sees) at the cost
    of over-redacting charts and other non-sensitive canvas content — there is
    no way yet to tell them apart.
13. **A same-URL image swap is invisible to DeltaVision.** `src_hash` digests
    the URL, not the bytes; a server-side image swap at an unchanged URL is
    not seen as changed, so a stale face box could be reused. The full-frame
    face pass still runs every step regardless.
14. **1×1 screen-reader-only text is over-dropped** by the hidden-text rule
    (box under 2×2 px) even though it is the standard accessibility pattern,
    not camouflage. Counted in `hidden_dropped`, not silently absorbed.
15. **Non-ASCII digit spans split across sibling elements are not grouped.**
    Folding happens on one node's already-assembled text; a card/Aadhaar/OTP
    written as adjacent `<span>`s of Devanagari (or other non-ASCII) digits is
    not detected. Split PIN boxes (as opposed to OTP boxes) are also undetected
    — the OTP context match deliberately excludes "PIN" (an Indian postal code
    term) to avoid turning every address field into a false OTP match.
16. **A BlindFill token can only be typed into a field of the same detected
    type.** A field the DOM rules mislabel, a field resolved to a different
    type, split card/Aadhaar inputs, or a field below the fold or inside an
    iframe refuses the fill by design; the user fills those by hand.
