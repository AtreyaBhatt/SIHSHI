# ATHENA — from demo to product: design

Date: 2026-09-11. Status: approved by the owner, implementation in phases.

Read with `PRD_Privacy_Preserving_Vision_Agent.md` (rationale, threat model) and
`CLAUDE.md` (working rules). Where this document and the PRD differ, this
document wins for the phases below; the PRD is updated as each phase lands.

## Decisions (owner-confirmed)

| Topic | Decision |
|---|---|
| Users | Individuals, self-run. Extension via Chrome Web Store; no accounts. |
| Reasoning | **Serverless.** The extension calls the model provider directly. Primary provider: OpenAI-compatible base URL + API key + model, default preset OpenRouter. Also: Anthropic native, mock (tests/offline), relay (the existing `/server`, kept, not deleted). |
| Credentials | Encrypted local vault (passphrase → PBKDF2 → AES-GCM). Holds credentials and provider API keys. |
| Iframes / shadow DOM | Iframes masked in the screenshot and declared in the manifest; open shadow roots walked. Closed shadow roots are a documented ceiling. |
| Taxonomy | Add Tier-2 `account_id`; add Tier-1 `frame` (an unscanned region, not PII per se). No new tiers. |
| NER | Ship `distilbert-NER` int8 locally. Package budget ≤ 100 MB. |
| Autonomy | Agent loop with a mode toggle: (1) approve every step, (2) approve only steps with `value_ref`, `risk:'sensitive'`, or `navigate`. Step cap 25, adjustable. |
| Page access | `optional_host_permissions`, granted per site from the panel. `activeTab` kept as the zero-permission fallback. |
| Capture scope | Viewport only; the loop scrolls. |
| Actions | `click, type, select, key, hover, scroll, go_back, navigate, wait`. Response carries `done` + `result`; actions carry `risk`. `navigate` is always sensitive. |
| Browsers | Chrome/Chromium (Chrome, Edge, Brave). Firefox later. |

## Invariants that do not change

- The trust boundary is the network call. Redaction applies only to what is serialised and sent.
- The live page is never mutated except by the executor performing a requested action.
- Every redaction has a manifest entry. Session tokens are never persisted.
- Selectors the model may target are exactly the paths the client sent; the executor re-checks this.
- Secrets never cross the network in either direction; `value_ref` names a local slot.
- Ground truth in `eval/corpus` is authored independently of the detectors.
- Detector order: DOM heuristics → regex → NER → faces. Cheap and precise first.

## Build order

1. Any-site capture
2. Serverless reasoning
3. Action grammar v2
4. Agent loop
5. Encrypted vault (credentials + API keys)
6. NER stage
7. Ship + real-site corpus

Each phase is its own implementation plan, ends with the full harness green
(`typecheck, smoke, test:redaction, test:reasoning, test:faces, test:scenario-b,
test:e2e, preview:viewer, measure → predict → run_eval, latency`), updates the
numbers in README/HANDOFF, and is committed on `hopefully_final`. `/server`
keeps passing `uv run pytest` throughout (its schemas track the wire shape).

---

## Phase 1 — Any-site capture

### Permissions
- `manifest.json`: keep `activeTab`; add `"optional_host_permissions": ["https://*/*", "http://*/*"]`.
- Panel: when the active tab's origin is not granted, show **Enable ATHENA on `host`** (a user gesture inside the panel is sufficient for `chrome.permissions.request({ origins: [origin + '/*'] })`). A **Disable** control calls `permissions.remove`. `permissions.getAll()` is the only source of truth; no parallel list in storage.
- `runCapture` no longer requires `activeTab`: with a host permission, `scripting.executeScript` and `tabs.captureVisibleTab` both work. `activeTab` remains the fallback for a one-off on an un-enabled site.
- Provider origins (phase 2) use the same mechanism.

### Shadow DOM
- `captureDomSnapshot` walks open shadow roots recursively. A node inside a shadow tree gets the path `hostPath >>> innerPath`, where `innerPath` is computed relative to its shadow root (nested: `a >>> b >>> c`).
- `uniqueIdSelector` and `nth-of-type` uniqueness are evaluated against the *current root* (document or shadow root), not the document.
- New `shared/resolve-path.ts`: `resolvePath(path, root = document): Element[]` splits on ` >>> `, runs `querySelectorAll` on each segment inside the current root, and steps into `shadowRoot` between segments. It is the only way any code resolves a snapshot path: executor, `smoke-capture.mjs`, `measure_labels.mjs` (labels may use `>>>`), and the e2e harness all use it.
- Closed shadow roots cannot be distinguished from empty custom elements; their pixels are not masked. Documented in README Limitations.

### Iframes
- `iframe`, `frame`, `object`, `embed` are captured as nodes with `media: 'iframe'` and `role: 'frame'`, `value: null`.
- `build-request.ts` emits, for each such node, a manifest entry `{ type: 'frame', tier: 1, masking: 'blackbox', detector: 'capture:iframe', bbox }` and the screenshot region is filled. `PiiType` gains `frame` (Tier 1) in `schema.ts`, `TIER_BY_TYPE`, and the server's `schemas.py`.
- Same-origin frames are not walked (explicit non-goal for now).

### `account_id`
- `PiiType` gains `account_id` (Tier 2, masking `token`, token prefix `ACCOUNT_ID`). Server `schemas.py` mirrors it.
- DOM rule `dom:account-id`, confidence 0.85, on the context string: `customer/member/subscriber/policy/user/login/client (id|number|no)`, `reference (number|no|id)`, `\bcrn\b`, `account (id|handle)`, `user[ -]?name`, `autocomplete=username`. Regex stage: none (no surface form).
- Corpus: `bank-login-01` gains `a9 input#customer-id account_id T2`; `kyc-form-01` gains `b17 td#cust-ref account_id T2`. `fixtures.spec.mjs`: those two `knownGaps` move to `mustNotAppear` / `redactedFields`.
- Mock provider's username hint continues to match by label; a tokenised `value` does not affect it.

### Node budget
- `MAX_NODES` 400 → 800. On overflow: keep every interactive, media and frame node; fill the remainder with text nodes in document order. `truncated` is added to `AgentRequest` (and `schemas.py`, default `False`) so the model knows the view is partial.

### Tests / acceptance
- `smoke` passes on a fixture with an open shadow root and an iframe (`eval/fixtures/shadow-iframe.html`, new): every path resolves to exactly one element via `resolvePath`, the iframe region is in the manifest as `frame`, and the redacted screenshot has the region blacked out (pixel check).
- `test:redaction` covers the account-id flips; eval numbers regenerate.

---

## Phase 2 — Serverless reasoning

### Layout
```
extension/src/reasoning/
  prompt.ts          SYSTEM_PROMPT (ported verbatim from server/app/prompt.py) + buildUserMessage()
  plan-schema.ts     JSON schema for PlanOutput + validatePlan(unknown): PlanOutput (hand-written, no Zod)
  guardrails.ts      constrain(plan, request) — port of server/app/action_planner.py, same rejection strings
  egress-check.ts    findRawPii(text) — port of server/app/patterns.py. MUST NOT import from pii-detection/.
  plan.ts            requestPlan(request, settings): egress gate → provider.plan → constrain → AgentResponse
  providers/
    types.ts         Provider { name; plan(cleared: EgressCleared): Promise<PlanOutput>; check(): Promise<string> }
    openai-compat.ts base URL + key + model; presets
    anthropic.ts     Messages API, output_config json_schema, refusal handling
    mock.ts          port of server/app/providers/mock.py
    relay.ts         today's POST /agent/plan to an ATHENA server (kept for the owner's server)
```
- `EgressCleared` is a branded object (`{ system, user, image_b64, __cleared: true }`) constructed only in `plan.ts` after `egress-check` passes. Providers accept nothing else, so the type-level property "no raw payload can reach a fetch" survives. `fetch` may appear only under `reasoning/providers/` and `perception/runtime.ts` (extension-local model URL); HANDOFF's grep claim is updated to say so.
- `egress-check` runs on `task_instruction`, every `dom_summary[].label/value`, and `prior_actions[].value`, and throws `RawPiiLeakError` (never quoting the value). It is a second, independent pattern set; `build-request`'s own check stays.

### Providers
- **openai-compat** (primary): `POST {baseUrl}/chat/completions`, `Authorization: Bearer`, image as a `data:image/png;base64` URL, `response_format: { type: 'json_schema', json_schema: { name: 'plan', schema } }`, `temperature: 0`. On HTTP 400 retry once without `response_format`. Strip ``` fences. Validate with `validatePlan`; on failure return an empty plan with the reason. Presets: `openrouter` (`https://openrouter.ai/api/v1`, default; headers `HTTP-Referer` and `X-Title: ATHENA`), `openai` (`https://api.openai.com/v1`), `ollama` (`http://localhost:11434/v1`), `custom`. The default OpenRouter model id must be a vision-capable model that the implementer verifies exists on OpenRouter at implementation time.
- **anthropic**: `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`; `output_config: { format: { type: 'json_schema', schema } }`; default model `claude-opus-5`; `max_tokens` 8000; `stop_reason === 'refusal'` → empty plan with the category. The implementer verifies the structured-output wire shape against the current Claude API docs before writing it.
- **mock**: port of `mock.py`, plus (phase 3) the "no login form → done" behaviour.
- **relay**: unchanged behaviour of today's `agent-client.ts`.
- `check()`: openai-compat `GET {baseUrl}/models`; anthropic `GET /v1/models`; mock ok; relay `/healthz`.
- Errors (network, 4xx/5xx, timeout 60 s) never throw out of `requestPlan`: they become an empty plan whose `reasoning_summary` names the class and status, never a body.

### Settings
- Stored in `storage.local` under `athena:provider`: `{ kind: 'openai-compat'|'anthropic'|'mock'|'relay', preset, base_url, api_key, model, relay_url }`. The API key moves into the vault in phase 5.
- Saving a base URL / relay URL requests `permissions.request({ origins: [origin + '/*'] })`; refusal leaves the setting unsaved with a message. **Test** calls `check()`.
- Panel Settings tab and options page both expose this; the panel's "Reasoning server" card becomes "Reasoning provider".

### Harnesses
- `test:e2e` and `latency_stages.mjs` stop spawning uvicorn; they bundle `reasoning/plan.ts` with the mock provider and run the loop inside the page. The `network` stage of the latency bench becomes the provider call.
- New `scripts/test-reasoning.mjs` (Node, no browser): ports the meaningful pytest cases — egress catches card/email/PAN, never echoes the value, ignores markers, scans `task_instruction` and `prior_actions`; guardrails drop invented selectors, literals into Tier-1, marker echoes, malformed `value_ref`, both/neither value sources; one bad action keeps the plan; mock plans Scenario A from the real fixture payload.
- `preview:viewer` uses the mock in-extension.

### Docs
- README: "Reasoning backend" becomes "Reasoning provider" (BYO key; OpenRouter default; Anthropic; Ollama/vLLM; optional ATHENA relay). CLAUDE.md: server rules re-pointed at `reasoning/` ("runs on-device; `/server` is an optional relay"). PRD §6.2.6–6.2.8 get a footnote. HANDOFF §5 table updated.

---

## Phase 3 — Action grammar v2

### Wire shape
```ts
type ActionVerb = 'click' | 'type' | 'select' | 'key' | 'hover' | 'scroll' | 'go_back' | 'navigate' | 'wait';
type KeyName = 'Enter' | 'Escape' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Backspace' | 'Space';
interface AgentAction {
  action: ActionVerb;
  selector?: string;            // click, type, select, hover, key (optional), scroll (optional)
  value?: string;               // type: literal, non-secret
  value_ref?: string;           // type: user_saved:<slot>
  option?: string;              // select: visible label (case-insensitive) or value
  key?: KeyName;                // key
  direction?: 'up' | 'down';    // scroll (default down)
  url?: string;                 // navigate, http(s) only
  risk: 'routine' | 'sensitive';
}
interface AgentResponse { session_id; reasoning_summary; actions; requires_client_secret; guardrail_rejections?; done: boolean; result: string | null }
interface PriorAction extends AgentAction { outcome: 'ok' | 'failed'; error?: string }  // error: executor text, never a value
```
`focus` and `read` are removed. Server `schemas.py` and `action_planner.py` are updated in step so the relay keeps working.

### Guardrails (client `guardrails.ts`, mirrored in `action_planner.py`)
- Selector allowlist for every action that carries a selector.
- `click/type/select/hover` require a selector; `key`/`scroll` optional; `navigate` requires `url` matching `^https?://` and is forced `risk: 'sensitive'`; `select` requires `option`; `key` must be in `KeyName`; `type` needs exactly one of `value`/`value_ref`; literal into a Tier-1 field dropped; marker echo dropped; `value_ref` must match `^user_saved:[A-Za-z0-9_.-]{1,64}$`.
- `done: true` with a non-empty `actions` is allowed (execute, then finish). `done: true` with empty actions ends the run.

### Executor
- Content script (`executor/execute.ts`): `click`, `type` (clear, then native setter + input/change), `select` (match `<option>` by label then by value; dispatch `input`/`change`), `key` (dispatch keydown/keypress/keyup on the target or `document.activeElement`; for `Enter` on a field inside a form, if not `defaultPrevented`, call `form.requestSubmit()`; `Tab` moves focus to the next focusable element manually), `hover` (pointerover/mouseover/mouseenter/pointermove), `scroll` (selector → `scrollIntoView`, else `scrollBy` 0.8 viewport in `direction`), `wait` (400 ms).
- Worker: `navigate` → `tabs.update(tabId, { url })`; `go_back` → `tabs.goBack(tabId)`. The worker splits a plan at the first tab-level verb: page verbs before it run in the content script, the tab-level verb runs, and anything after it is dropped with a recorded outcome "not executed: page changed" (the next capture re-plans).
- Outcomes carry `error` text from the executor only (selector, count, message) — never a value.

### Prompt
- Rules for each verb; `risk` guidance (anything that submits, pays, sends, deletes, or leaves the site is `sensitive`); `done`/`result` semantics (set `done: true` when the goal is complete or cannot be advanced, and put the answer or reason in `result`; `result` must not speculate about redacted content).

### Tests
- `test:e2e` Scenario A unchanged in spirit (now `key: Enter` or click submit, both accepted). New Scenario C e2e on `kyc-form.html`: mock returns `done: true` with a result naming the empty required fields; harness asserts the result names `PAN` and `OTP` and that nothing was executed.
- `test:reasoning` gains guardrail cases for each new verb.

---

## Phase 4 — Agent loop

### State (worker, `background/agent/loop.ts`)
```ts
interface Run {
  run_id: string; tab_id: number; goal: string; mode: 'approve-all' | 'approve-sensitive';
  step: number; max_steps: number;                       // default 25, setting
  status: 'idle' | 'capturing' | 'planning' | 'awaiting_approval' | 'executing' | 'settling'
        | 'needs_permission' | 'done' | 'failed' | 'stopped';
  history: PriorAction[]; pending: AgentResponse | null; last_preview: PayloadPreview | null;
  result: string | null; error: string | null; needs_origin?: string;
}
```
Written to `storage.session` on every transition; every handler reloads it first (the worker is suspended routinely). One `TokenRegistry` per run (`session_id = run_id`).

### Transitions
`start(goal, tab_id, mode)` → `capturing` → `planning` → if `done` and no actions → `done`; else gate → `awaiting_approval` or `executing` → `settling` → `capturing`, `step++`; `step > max_steps` → `failed('step cap')`. `stop()` from any state → `stopped`. Any thrown error → `failed(message)`. After a navigation, if the new origin is not granted → `needs_permission` with `needs_origin`; the panel's **Enable** button grants and resumes.

Gate: mode 1 always pauses. Mode 2 pauses when any action has `value_ref`, `risk === 'sensitive'`, or `action === 'navigate'`; otherwise executes immediately. Execution stops at the first failed action; the outcomes are appended to `history` either way and the next plan sees them.

### Settle
After execution: wait until `tabs.get(tab_id).status === 'complete'` (poll 100 ms, 10 s max), then inject the content script and await `athena:settle`, which resolves when a `MutationObserver` on `document` has seen no mutations for 500 ms, or after 3 s.

### Panel
Goal textarea, mode toggle (two segments), **Start** / **Stop**, `step n/25`, status line, the current plan card (actions with `risk` badges, **Approve** / **Stop**), the running history (verb · selector · outcome), a result banner on `done`, an error banner on `failed`. "Analyze page safely" stays. The viewer stays single-step.

### Messages
`athena:run-start {goal, mode, tab_id}`, `athena:run-approve`, `athena:run-stop`, `athena:run-get` (returns `Run`), `athena:run-grant-and-resume`. Worker pushes `athena:run-changed` to the panel via `runtime.sendMessage` after each transition; the panel re-renders from `Run` only.

### Tests
- `test:loop` (new, browser + mock): on `bank-login.html`, mode 1: start → awaiting_approval → approve → executed → settle → capturing → mock returns done → `done`; history has the three actions with `ok`. Mode 2 on `kyc-form.html`: run completes with no approval because the mock returns `done` with no actions. A stop mid-run ends in `stopped`.
- Latency bench reports per-step time in a loop of 3 steps.

---

## Phase 5 — Encrypted vault

- `shared/vault.ts` v2 record in `storage.local`: `{ v: 2, kdf: 'PBKDF2-SHA256', iterations: 310000, salt, iv, ciphertext }` (base64). WebCrypto only. Plaintext is `Record<slot, value>`; slots include `username`, `password`, and `api_key:<provider-kind>`.
- Unlock: passphrase → derived AES-GCM-256 key; the raw key bytes are cached in `storage.session` (memory-only) with a timestamp; auto-lock after `vault.lock_after_min` (default 15) of no use; explicit **Lock**. A locked vault makes `resolveValueRef` and provider-key lookup throw `VaultLockedError`; the panel shows an unlock prompt and retries the pending step.
- Migration: on first passphrase set, a v1 plaintext vault is encrypted and the plaintext key deleted. Provider `api_key` from `athena:provider` moves into the vault the same way.
- Prompt-at-execution: if a `value_ref` slot is missing, the panel asks for the value once; a **Save to vault** checkbox (default off) decides persistence.
- Options page and panel: set/change passphrase, unlock, lock, slot list (names + masked length), remove.
- Tests: `test:vault` (Node with WebCrypto): round-trip, wrong passphrase fails, v1 migration, lock/unlock cycle.

---

## Phase 6 — NER

- Model: `distilbert-NER` int8 ONNX via `@huggingface/transformers` token-classification pipeline in the offscreen document, weights shipped under `extension/models/ner/` (fetched by `npm run fetch:ner`, gitignored, documented with checksum in `models/README.md`), `env.allowRemoteModels = false`, `env.localModelPath` = extension URL. If the package would exceed 100 MB, the implementer stops and reports rather than shipping.
- Cascade: after stages 1–2, the worker selects text nodes with ≥ 6 words whose `text` field is not fully claimed, sorts by length, takes the 20 longest, and asks the offscreen doc for spans. `PER` → `person_name`, `LOC` → `address`, `ORG` ignored; confidence = model score; threshold gating as for other detectors; span-level; merged through `resolveOverlaps`. `detectPii(snapshot, { threshold, nerSpans })` stays pure: spans are pre-computed and passed in.
- Redaction: token per entity like other Tier-2 items.
- Eval: `predict.mjs` serves the NER weights and runs the same path; kyc `b13`/`b14` become expected hits; two new prose fixtures with labels (`email-thread.html`, `crm-contact.html`). Latency bench splits `perception` into faces and NER.

---

## Phase 7 — Ship + evidence

- Icons 16/32/48/128 rendered from the design mark; `manifest.icons` and `action.default_icon`.
- Options page and viewer restyled to `design/athena-sidebar/` tokens (Instrument Sans, white system); HANDOFF gap #10 closes.
- `docs/privacy.md` (what leaves the device, to whom, what is stored, how to delete it); `npm run package` → `athena-<version>.zip` of `dist`; store listing text in `docs/store-listing.md`.
- README rewritten around BYO-key setup; Limitations updated (closed shadow roots, same-origin frames not walked, heuristic redaction).
- Real-site corpus: 10–20 pages saved as single HTML files with synthetic values (login pages, checkout, CRM, email, a SPA form) under `eval/fixtures/real/` with labels; eval numbers reported separately from the authored fixtures.

## Out of scope (still)

Firefox; multi-tab orchestration; JavaScript evaluation, file upload, cookies/storage access from the model; cryptographic privacy guarantees; on-device fine-tuning.
