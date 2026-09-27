# Phase 5a — BlindFill tokens, encrypted vault, privacy firewall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The model can move a sensitive value it sees on the page (as an opaque token) or a value from the user's encrypted profile vault (as a slot reference) into a field, with the real value resolved only in the service worker for an approved step; and an independent firewall verifies every outbound payload.

**Architecture:** Spec sections A, B, C of `docs/superpowers/specs/2026-09-28-blindfill-firewall-metrics-design.md`. `TokenRegistry` learns values and serialises to `storage.session`; `replacementFor` emits numbered tokens for resolvable Tier-1 types; the guardrails accept a new `value_token` field; the worker resolves tokens and refs at execute time. `shared/vault.ts` becomes an AES-GCM vault unlocked once per browser session, holding profile slots and the provider API key; the loop gains a `needs_unlock` status. `redaction/firewall.ts` is a second, independent pattern module that force-masks Tier-2 hits and blocks Tier-1 hits, reporting counts for the metrics card (plan 5b).

**Tech Stack:** TypeScript strict, esbuild, Chrome MV3, WebCrypto (`crypto.subtle`, available in the worker and in Node 20 for tests), Node test scripts, headless Chrome via CDP, FastAPI + pydantic + pytest for the server mirror.

## Global Constraints

- Trust boundary is the network call; the only provider `fetch` stays in `background/agent-client.ts`.
- A token or `value_ref` is resolved only in the service worker at execute time for an approved step. The panel and the content script never receive the registry, the vault key, or a plaintext vault.
- Registry values are browser-session scoped: worker memory mirrored to `chrome.storage.session` under `athena:registry:<id>`; never `storage.local`.
- Resolvable Tier-1 types: `aadhaar, pan, card_number, card_expiry, ssn, passport, bank_account, ifsc`. Non-resolvable (fixed `[REDACTED:TYPE]`): `password, otp, cvv, face, frame`.
- Any action carrying `value_ref` or `value_token` is forced `risk: 'sensitive'`.
- Every redaction has a manifest entry; pixels for every Tier-1 entry are blacked out (`redact-image.ts` fills every non-`blur` region).
- Vault: `PBKDF2(passphrase, salt, 600000, SHA-256)` → AES-GCM-256, non-extractable key in worker memory only, relock after 15 minutes without use. Plaintext vault v1 and the API-key cookie are migrated on first unlock, then deleted. `cookies` permission and the openrouter `host_permissions` entry are removed from the manifest.
- Firewall imports nothing from `pii-detection/`. Tier-1 hit blocks (throws `RawPiiLeakError` after attaching the report); Tier-2 hit masks with a registry token and a manifest entry with detector `firewall:<rule>`.
- No log line, error string, outcome, `Run` field, or message to the panel may contain a resolved value, a passphrase, or an API key.
- Ponytail: shortest working diff, no new dependencies, no abstraction with one implementation unless named here.
- Commit messages plain, imperative, no trailers. Never push.
- Harness green at the end of every task: `cd extension && npm run typecheck && npm run build` plus the scripts each task names. Full run at the end of Task 6.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `extension/src/redaction/tokens.ts` | registry learns values, `valueOf`, `toJSON`/`from` | 1 |
| `extension/src/redaction/redact-text.ts` | numbered tokens for resolvable Tier-1 | 1 |
| `extension/src/shared/schema.ts` | `RESOLVABLE_TIER1`, `value_token`, `available_refs` | 1 |
| `extension/src/redaction/build-request.ts` | `available_refs` option → request | 1 |
| `extension/scripts/fixtures.spec.mjs`, `test-reasoning.mjs`, `test-redaction.mjs` | expectations for tokens | 1, 2, 5 |
| `extension/src/background/direct-provider-response.ts` | `value_token` and `available_refs` rules | 2 |
| `server/app/schemas.py`, `action_planner.py`, `prompt.py`, `tests/` | mirror | 2, 4 |
| `extension/src/background/service-worker.ts` | registry mirror, `toExecutable` token resolve, vault messages, firewall wiring | 1, 2, 3, 5 |
| `extension/src/shared/vault.ts` | v2 encrypted vault | 3 |
| `extension/src/shared/messages.ts` | vault messages, `needs_unlock`, firewall report | 3, 5 |
| `extension/src/background/agent/loop.ts` | `needs_unlock` status | 3 |
| `extension/src/background/agent-client.ts` | API key from vault; prompt v3 | 3, 4 |
| `extension/src/shared/provider-settings.ts` | drop cookie storage | 3 |
| `extension/src/sidebar/*`, `extension/src/options/*` | unlock UI, slots via messages | 3 |
| `extension/manifest.json` | permissions | 3 |
| `extension/scripts/test-vault.mjs` (new), `test-provider.mjs` | vault tests, provider test without cookies | 3 |
| `eval/fixtures/blindfill.html` (new), `extension/scripts/test-e2e.mjs`, `package.json` | BlindFill e2e | 4 |
| `extension/src/redaction/firewall.ts` (new) | independent egress scan | 5 |
| `extension/src/pii-detection/detect.ts` | `disabledDetectors` option | 5 |
| `README.md`, `HANDOFF.md`, `PRD_…md`, `docs/pitch.md` | docs | 6 |

---

### Task 1: Registry values, Tier-1 tokens, `available_refs`

**Files:**
- Modify: `extension/src/redaction/tokens.ts`
- Modify: `extension/src/redaction/redact-text.ts:33-37`
- Modify: `extension/src/shared/schema.ts` (`TIER_BY_TYPE` neighbourhood; `AgentAction`; `AgentRequest`)
- Modify: `extension/src/redaction/build-request.ts` (`BuildOptions`, request assembly)
- Modify: `extension/src/background/service-worker.ts` (`buildPayload` passes `available_refs`; registry mirror)
- Modify: `extension/scripts/fixtures.spec.mjs` (marker expectations), `extension/scripts/test-reasoning.mjs`

**Interfaces:**
- Produces (schema.ts):
  ```ts
  export const RESOLVABLE_TIER1: ReadonlySet<PiiType> = new Set<PiiType>(['aadhaar','pan','card_number','card_expiry','ssn','passport','bank_account','ifsc']);
  export interface AgentAction { …; value_token?: string }   // type only; exactly one of value | value_ref | value_token
  export interface AgentRequest { …; available_refs: string[] }  // 'user_saved:<slot>' names, never values
  ```
- Produces (tokens.ts):
  ```ts
  class TokenRegistry {
    readonly session_id: string;
    idFor(type, value, nodePath): string;        // unchanged signature; now also records value
    valueOf(id: string): string | undefined;      // id without brackets, e.g. 'AADHAAR_1'
    toJSON(): RegistryJSON; static from(json: RegistryJSON): TokenRegistry;
  }
  ```
- Produces (build-request.ts): `BuildOptions.availableRefs?: string[]`; request carries `available_refs` (defaults to `[]`).
- Produces (service-worker.ts): `saveRegistry(registry)` / `loadRegistry(id)` mirror helpers under `storage.session['athena:registry:' + id]`.

- [ ] **Step 1: Failing tests**

Append to `extension/scripts/test-reasoning.mjs` before the final `await rm(...)`:

```js
console.log('registry values and tier-1 tokens');
{
  await build({ entryPoints: ['src/redaction/tokens.ts'], outfile: join(temp, 'tokens.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
  await build({ entryPoints: ['src/redaction/redact-text.ts'], outfile: join(temp, 'redact-text.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
  const { TokenRegistry } = await import(`file://${join(temp, 'tokens.mjs')}`);
  const { replacementFor } = await import(`file://${join(temp, 'redact-text.mjs')}`);
  const reg = new TokenRegistry('r1');
  const id = reg.idFor('aadhaar', '2345 6789 0124', 'input#aadhaar');
  check(id === 'AADHAAR_1', `first aadhaar token is AADHAAR_1 (${id})`);
  check(reg.valueOf('AADHAAR_1') === '2345 6789 0124', 'registry resolves the token to the original value');
  check(reg.idFor('aadhaar', '2345-6789-0124', 'td#alt') === 'AADHAAR_1', 'same value with different punctuation gets the same token');
  check(reg.valueOf('PASSWORD_1') === undefined, 'unknown id resolves to undefined');
  const empty = reg.idFor('otp', null, 'input#otp');
  check(reg.valueOf(empty) === undefined, 'a null value records no resolvable value');
  const copy = TokenRegistry.from(JSON.parse(JSON.stringify(reg)));
  check(copy.session_id === 'r1' && copy.valueOf('AADHAAR_1') === '2345 6789 0124' && copy.idFor('aadhaar', '2345 6789 0124', 'x') === 'AADHAAR_1', 'round-trips through JSON with counters intact');
  check(replacementFor('aadhaar', 1, 'AADHAAR_1', '2345 6789 0124') === '[AADHAAR_1]', 'resolvable tier-1 emits a numbered token');
  check(replacementFor('password', 1, 'PASSWORD_1', null) === '[REDACTED:PASSWORD]', 'password keeps the fixed marker');
  check(replacementFor('otp', 1, 'OTP_1', '123456') === '[REDACTED:OTP]', 'otp keeps the fixed marker');
  check(replacementFor('phone', 2, 'PHONE_1', '9845012345') === '[PHONE_1]', 'tier-2 unchanged');
}
```

In `extension/scripts/fixtures.spec.mjs`, `redactedFields` already accept any marker (`MARKER` regex in test-redaction matches both forms), so add to the `bank-login` spec a new key and to test-redaction a check:

```js
    tokenFields: [
      ['PAN field', 'input#pan', /^\[PAN_\d+\]$/],
      ['account number cell', 'dd#account-number', /^\[BANK_ACCOUNT_\d+\]$/],
    ],
    fixedMarkerFields: [
      ['password field', 'input#password', '[REDACTED:PASSWORD]'],
    ],
```

and in `test-redaction.mjs`, next to the `redactedFields` block:

```js
    for (const [name, selector, re] of spec.tokenFields ?? []) {
      const node = request.dom_summary.find((n) => n.path === selector);
      if (node && re.test(node.value ?? '')) pass(`${name} → numbered token ${node.value}`); else fail(`${name}: expected numbered token, got ${JSON.stringify(node?.value)}`);
    }
    for (const [name, selector, marker] of spec.fixedMarkerFields ?? []) {
      const node = request.dom_summary.find((n) => n.path === selector);
      if (node?.value === marker) pass(`${name} → ${marker}`); else fail(`${name}: expected ${marker}, got ${JSON.stringify(node?.value)}`);
    }
```

Add `tokenFields` for `kyc-form`: `['aadhaar field', 'input#aadhaar', /^\[AADHAAR_\d+\]$/]`, `['refund account', 'td#refund-account', /^\[BANK_ACCOUNT_\d+\]$/]`, `['IFSC', 'td#refund-ifsc', /^\[IFSC_\d+\]$/]`.

Run: `cd extension && npm run test:reasoning && npm run test:redaction` → FAIL (no `valueOf`, wrong markers).

- [ ] **Step 2: `tokens.ts`**

```ts
export interface RegistryJSON { session_id: string; counters: [string, number][]; assigned: [string, string][]; values: [string, string][] }

export class TokenRegistry {
  readonly session_id: string;
  private counters = new Map<PiiType, number>();
  private assigned = new Map<string, string>();
  /** id → original value, for local resolution of a typed token. Memory + storage.session only. */
  private values = new Map<string, string>();

  constructor(sessionId: string) { this.session_id = sessionId; }

  idFor(type: PiiType, value: string | null, nodePath: string): string {
    const key = value ? `${type}:${normalize(value)}` : `${type}@${nodePath}`;
    const existing = this.assigned.get(key);
    if (existing) { if (value && !this.values.has(existing)) this.values.set(existing, value); return existing; }
    const next = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, next);
    const id = `${type.toUpperCase()}_${next}`;
    this.assigned.set(key, id);
    if (value) this.values.set(id, value);
    return id;
  }

  valueOf(id: string): string | undefined { return this.values.get(id); }
  get size(): number { return this.assigned.size; }

  toJSON(): RegistryJSON {
    return { session_id: this.session_id, counters: [...this.counters], assigned: [...this.assigned], values: [...this.values] };
  }
  static from(json: RegistryJSON): TokenRegistry {
    const r = new TokenRegistry(json.session_id);
    r.counters = new Map(json.counters as [PiiType, number][]); r.assigned = new Map(json.assigned); r.values = new Map(json.values);
    return r;
  }
}
```

Update the file's header comment: the registry may be mirrored to `chrome.storage.session` (browser-session scoped, memory-backed) and never to `storage.local`; PRD §9.4 still holds because the mirror dies with the browser session.

- [ ] **Step 3: `redact-text.ts` and `schema.ts`**

In `schema.ts` next to `TIER_BY_TYPE` add `RESOLVABLE_TIER1` as in Interfaces. In `redact-text.ts`:

```ts
import { RESOLVABLE_TIER1 } from '../shared/schema';
export function replacementFor(type: PiiType, tier: PiiTier, tokenId: string, original: string | null): string {
  if (tier === 1) return RESOLVABLE_TIER1.has(type) ? `[${tokenId}]` : `[REDACTED:${type.toUpperCase()}]`;
  if (type === 'email' && original) return partialEmail(original);
  return `[${tokenId}]`;
}
```

and `maskingFor`: `if (tier === 1) return RESOLVABLE_TIER1.has(type) ? 'token' : 'blackbox';`. Add a comment in `redact-image.ts` above the `masking !== 'blur'` branch: every non-blur region is filled, so `token` regions of Tier-1 entries are blacked out.

`AgentAction` gains `value_token?: string` (doc: "type: a token from this request's redaction_manifest, e.g. `[AADHAAR_1]`; resolved locally"). `AgentRequest` gains `available_refs: string[]`.

- [ ] **Step 4: `build-request.ts` and worker mirror**

`BuildOptions.availableRefs?: string[]`; the request literal sets `available_refs: options.availableRefs ?? []`. `assertNoRawPii`/firewall must not scan `available_refs` (slot names). In `service-worker.ts`:

```ts
const REGISTRY_KEY = (id: string) => `athena:registry:${id}`;
async function saveRegistry(registry: TokenRegistry): Promise<void> {
  try { await api.storage.session.set({ [REGISTRY_KEY(registry.session_id)]: registry.toJSON() }); } catch { /* memory copy stands */ }
}
async function loadRegistry(id: string): Promise<TokenRegistry | null> {
  try { const stored = (await api.storage.session.get(REGISTRY_KEY(id)))?.[REGISTRY_KEY(id)] as RegistryJSON | undefined; return stored ? TokenRegistry.from(stored) : null; } catch { return null; }
}
async function dropRegistry(id: string): Promise<void> { try { await api.storage.session.remove(REGISTRY_KEY(id)); } catch { /* nothing to drop */ } }
```

`buildPayload` calls `await saveRegistry(registry)` after `buildAgentRequest` and passes `availableRefs: await vaultSlotRefs()` (Task 3 provides `vaultSlotRefs(): Promise<string[]>` returning `user_saved:<slot>` names; until then use the existing `vaultSlots()` mapped to `user_saved:` prefix). `loopDeps.plan`: `if (!runTokens || runTokens.session_id !== runId) runTokens = (await loadRegistry(runId)) ?? new TokenRegistry(runId);`. `resetSession` and the terminal cleanup in `runDrive` call `dropRegistry(id)`.

- [ ] **Step 5: Run**

`cd extension && npm run typecheck && npm run build && npm run test:reasoning && npm run test:redaction && npm run test:e2e && npm run test:e2e:c && cd ../eval && node measure_labels.mjs && node predict.mjs && python3 run_eval.py` — all pass; eval numbers unchanged (scoring is manifest-level).

- [ ] **Step 6: Commit**

```bash
git add extension/src/redaction/tokens.ts extension/src/redaction/redact-text.ts extension/src/redaction/redact-image.ts extension/src/shared/schema.ts extension/src/redaction/build-request.ts extension/src/background/service-worker.ts extension/scripts/fixtures.spec.mjs extension/scripts/test-redaction.mjs extension/scripts/test-reasoning.mjs
git commit -m "tokens: resolvable tier-1 identifiers become numbered tokens; the registry keeps values and survives worker restarts"
```

---

### Task 2: `value_token` guardrail, executor resolution, server mirror

**Files:**
- Modify: `extension/src/background/direct-provider-response.ts` (`constrainAction`)
- Modify: `extension/src/background/service-worker.ts` (`toExecutable`)
- Modify: `extension/src/sidebar/sidebar.ts` (`describe`)
- Modify: `server/app/schemas.py`, `server/app/action_planner.py`, `server/tests/test_action_planner.py`
- Modify: `extension/scripts/test-reasoning.mjs`

**Interfaces:**
- `toExecutable(actions, secretKey, registry: TokenRegistry | null)` — third parameter; unknown token → the action is turned into a failed outcome by `executeOnTab` before the content script runs (throw `new Error('unknown token')` inside `toExecutable`, caught in `executeOnTab` which records `not executed: unknown token` for that action and drops the rest).

- [ ] **Step 1: Failing tests**

Append to `test-reasoning.mjs` (uses the existing `request`, `run`, `base` from the top of the file; extend `request.redaction_manifest` for this block):

```js
console.log('value_token');
{
  const req2 = { ...request, available_refs: ['user_saved:username', 'user_saved:aadhaar'], redaction_manifest: [
    ...request.redaction_manifest,
    { id: 'AADHAAR_1', type: 'aadhaar', tier: 1, bbox: null, dom_path: 'td#alt', masking: 'token', detector: 't', confidence: 1 },
    { id: 'PHONE_1', type: 'phone', tier: 2, bbox: null, dom_path: 'td#ph', masking: 'token', detector: 't', confidence: 1 },
  ], dom_summary: [...request.dom_summary, { path: 'input#aadhaar', role: 'textbox', label: 'Aadhaar', value: null }] };
  const run2 = (plan) => normalizeProviderResponse(openai(plan), false, req2);
  const ok = run2({ ...base, actions: [
    { action: 'type', selector: 'input#aadhaar', value_token: '[AADHAAR_1]' },
    { action: 'type', selector: 'input#user', value_token: '[PHONE_1]', risk: 'routine' },
    { action: 'type', selector: 'input#user', value_ref: 'user_saved:username', risk: 'routine' },
  ] });
  check(ok.actions.length === 3, `three valid token/ref types survive (${ok.guardrail_rejections?.join('; ')})`);
  check(ok.actions.every((a) => a.risk === 'sensitive'), 'value_token and value_ref are forced sensitive');
  check(ok.requires_client_secret === true, 'requires_client_secret covers tokens too');
  const bad = run2({ ...base, actions: [
    { action: 'type', selector: 'input#aadhaar', value_token: '[AADHAAR_9]' },
    { action: 'type', selector: 'input#aadhaar', value_token: '[PASSWORD_1]' },
    { action: 'type', selector: 'input#aadhaar', value_token: 'AADHAAR_1' },
    { action: 'type', selector: 'input#aadhaar', value_token: '[AADHAAR_1]', value: 'x' },
    { action: 'type', selector: 'input#user', value_ref: 'user_saved:nothing' },
    { action: 'click', selector: 'button#go', value_token: '[AADHAAR_1]' },
  ] });
  check(bad.actions.length === 0 && bad.guardrail_rejections.length === 6, `all six invalid token uses rejected (${bad.guardrail_rejections?.length})`);
  check(bad.guardrail_rejections.some((m) => /not a token from this request/.test(m)), 'unknown id names the rule');
  check(bad.guardrail_rejections.some((m) => /slot the user has not stored/.test(m)), 'value_ref outside available_refs names the rule');
  const noRefs = normalizeProviderResponse(openai({ ...base, actions: [{ action: 'type', selector: 'input#user', value_ref: 'user_saved:anything' }] }), false, { ...req2, available_refs: [] });
  check(noRefs.actions.length === 1, 'empty available_refs does not gate value_ref (backwards compatible)');
}
```

Note `request` in this file predates `available_refs`; add `available_refs: []` to it at the top so the type-shape stays honest.

Run → FAIL.

- [ ] **Step 2: Guardrails**

In `constrainAction` (TS): add `value_token` to `ACTION_FIELDS`; add `TOKEN = /^\[[A-Z][A-Z0-9_]*_\d+\]$/`; parameters gain `tokenIds: Map<string, PiiType>` (built from `request.redaction_manifest`: id → type) and `availableRefs: Set<string>`. Rules, in this order after the existing `value`/`value_ref` string checks:

```ts
  if (verb !== 'type' && (value !== undefined || valueRef !== undefined || valueToken !== undefined)) return { rejection: `${tag}: value / value_ref / value_token only apply to type` };
  if (valueToken !== undefined) {
    if (!TOKEN.test(valueToken)) return { rejection: `${tag}: value_token must look like [TYPE_N]` };
    const id = valueToken.slice(1, -1); const type = tokenIds.get(id);
    if (!type || !(RESOLVABLE_TIER1.has(type) || TIER_BY_TYPE[type] === 2)) return { rejection: `${tag}: value_token is not a token from this request` };
  }
  if (valueRef !== undefined && availableRefs.size > 0 && !availableRefs.has(valueRef)) return { rejection: `${tag}: value_ref names a slot the user has not stored` };
  if (verb === 'type') {
    const sources = [value, valueRef, valueToken].filter((v) => v !== undefined).length;
    if (sources !== 1) return { rejection: `${tag}: needs exactly one of value / value_ref / value_token` };
    if (value !== undefined && tier1Paths.has(selector!)) return { rejection: `${tag}: tier 1 fields must use value_ref or value_token` };
  }
```

Risk floor: `valueRef !== undefined || valueToken !== undefined` → `sensitive`. `requires_client_secret: actions.some((a) => a.value_ref || a.value_token)`. Copy `value_token` onto the kept action. Update the existing "needs exactly one of value / value_ref" test expectation string in `test-reasoning.mjs` if it asserts the message.

Python mirror in `schemas.py` (`value_token: str | None = None` on `AgentAction`; `available_refs: list[str] = Field(default_factory=list)` on `AgentRequest`) and `action_planner.py` with the same rules and strings (`TOKEN = re.compile(r"^\[[A-Z][A-Z0-9_]*_\d+\]$")`, `RESOLVABLE_TIER1 = frozenset({...})`, tier lookup from the manifest entry). Tests: three new pytest cases mirroring the TS block (valid token, unknown token, value_ref outside `available_refs`).

- [ ] **Step 3: Executor resolution**

`toExecutable(actions, secretKey, registry)`:

```ts
    } else if (action.value_token) {
      const value = registry?.valueOf(action.value_token.slice(1, -1));
      if (value === undefined) throw new Error(`${action.value_token} is not resolvable in this run`); // opaque token text only
      executable.value = value;
      executable.value_ref = action.value_token; // display label for the audit trail, never the value
      rememberTypedSecret(secretKey, action.selector, value);
    }
```

`executeOnTab` gains a `registry` parameter and wraps `toExecutable` in try/catch: on throw, every page action gets `{ ok: false, error: err.message }` for the first and `NOT_EXECUTED` for the rest (no content-script call). Callers: `executePlanFlow` passes `tokens`; `loopDeps.execute` passes `runTokens`.

Panel `describe()`: when `action.value_token`, render `fills <code>[AADHAAR_1]</code> from this page, resolved on this device, never sent`.

- [ ] **Step 4: Run**

`cd extension && npm run typecheck && npm run build && npm run test:reasoning && npm run test:e2e && cd ../server && uv run pytest -q` → pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/direct-provider-response.ts extension/src/background/service-worker.ts extension/src/sidebar/sidebar.ts extension/scripts/test-reasoning.mjs server/app/schemas.py server/app/action_planner.py server/tests/test_action_planner.py
git commit -m "blindfill: the model may type a token from the request; the worker resolves it locally for an approved step"
```

---

### Task 3: Encrypted vault v2, unlock flow, API key in the vault

**Files:**
- Rewrite: `extension/src/shared/vault.ts`
- Modify: `extension/src/shared/provider-settings.ts` (remove cookie functions; `api_key_present` comes from the vault)
- Modify: `extension/src/background/agent-client.ts` (`requestPlan` reads the key from the vault; `getProviderStatus` reports `locked`)
- Modify: `extension/src/background/service-worker.ts` (vault messages, `vaultSlotRefs`, `VaultLockedError` → `needs_unlock`)
- Modify: `extension/src/background/agent/loop.ts` (`needs_unlock` status)
- Modify: `extension/src/shared/messages.ts`
- Modify: `extension/src/sidebar/sidebar.html`, `sidebar.ts`, `extension/src/options/options.html`, `options.ts`
- Modify: `extension/manifest.json`
- Create: `extension/scripts/test-vault.mjs`; Modify: `extension/scripts/test-provider.mjs`, `extension/package.json`

**Interfaces:**
- `vault.ts` (worker-only module; the panel never imports it):
  ```ts
  export class VaultLockedError extends Error {}
  export interface VaultData { slots: Record<string, string>; provider_api_key?: string }
  export interface VaultStatus { has_vault: boolean; locked: boolean; slots: string[]; api_key_present: boolean; migrated_from_v1: boolean }
  export async function vaultStatus(): Promise<VaultStatus>;
  export async function unlockVault(passphrase: string): Promise<VaultStatus>;   // creates the vault if none; migrates v1 + cookie key
  export function lockVault(): void;
  export async function setSlot(slot: string, value: string): Promise<VaultStatus>;
  export async function deleteSlot(slot: string): Promise<VaultStatus>;
  export async function setProviderApiKey(value: string | null): Promise<VaultStatus>;
  export async function getProviderApiKey(): Promise<string | null>;       // throws VaultLockedError
  export async function resolveValueRef(ref: string): Promise<string>;      // throws VaultLockedError | UnknownCredentialError
  export async function vaultSlotRefs(): Promise<string[]>;                 // [] when locked
  export const VAULT_IDLE_MS = 15 * 60 * 1000;
  ```
  Internals: `storage.local['athena:vault:v2'] = { kdf: 'pbkdf2-sha256-600k', salt: base64, iv: base64, ciphertext: base64 }`; module-level `let key: CryptoKey | null`, `let cache: VaultData | null`, `let lastUsed = 0`; every accessor calls `touch()` which relocks if idle > `VAULT_IDLE_MS`. Encrypt on every write with a fresh 12-byte IV. Wrong passphrase → `crypto.subtle.decrypt` rejects → `throw new Error('Wrong passphrase.')` (no `has_vault` change).
- Messages (panel → worker, all return `VaultStatus`): `athena:vault-status`, `athena:vault-unlock {passphrase}`, `athena:vault-lock`, `athena:vault-set {slot, value}`, `athena:vault-delete {slot}`, `athena:vault-set-api-key {value: string | null}`.
- Loop: `RunStatus` gains `'needs_unlock'`; `LoopDeps.execute` may throw `VaultLockedError`; `executePending` catches it, keeps `pending`, and transitions to `needs_unlock`. `approve()` accepts `needs_unlock` as well as `awaiting_approval`. Worker `run-approve` handler allows both statuses.
- `HealthReport` gains `vault_locked: boolean`.

- [ ] **Step 1: Failing test**

Create `extension/scripts/test-vault.mjs`:

```js
/** Encrypted vault round trips in Node with WebCrypto and a fake chrome.storage. Usage: npm run test:vault */
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'athena-vault-'));
const local = {}; const cookies = new Map();
globalThis.chrome = {
  storage: { local: { get: async (k) => { const keys = Array.isArray(k) ? k : [k]; return Object.fromEntries(keys.filter((x) => x in local).map((x) => [x, local[x]])); }, set: async (v) => Object.assign(local, v), remove: async (k) => { for (const x of [].concat(k)) delete local[x]; } } },
  cookies: { get: async ({ url, name }) => cookies.get(`${new URL(url).origin}:${name}`) ?? null, remove: async ({ url, name }) => { cookies.delete(`${new URL(url).origin}:${name}`); } },
  permissions: { contains: async () => true },
};
await build({ entryPoints: ['src/shared/vault.ts'], outfile: join(temp, 'vault.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
const v = await import(`file://${join(temp, 'vault.mjs')}`);
let failures = 0; const check = (c, m) => { if (c) console.log(`  ok   ${m}`); else { failures++; console.error(`  FAIL ${m}`); } };

let s = await v.vaultStatus();
check(!s.has_vault && s.locked && s.slots.length === 0, 'fresh install: no vault, locked');
await v.unlockVault('correct horse');
s = await v.setSlot('aadhaar', '2345 6789 0124');
check(s.has_vault && !s.locked && s.slots.includes('aadhaar'), 'unlock creates the vault and stores a slot');
check((await v.resolveValueRef('user_saved:aadhaar')) === '2345 6789 0124', 'resolves a slot');
check(JSON.stringify(local).includes('2345 6789 0124') === false, 'storage.local never contains the plaintext');
check(JSON.stringify(local).includes('correct horse') === false, 'storage.local never contains the passphrase');
s = await v.setProviderApiKey('sk-test-123');
check(s.api_key_present && (await v.getProviderApiKey()) === 'sk-test-123', 'API key stored and readable while unlocked');
v.lockVault();
s = await v.vaultStatus();
check(s.locked && s.slots.length === 0 && s.api_key_present === true, 'locked: slot names hidden, key presence still known');
let threw = false; try { await v.resolveValueRef('user_saved:aadhaar'); } catch (e) { threw = e.name === 'VaultLockedError'; }
check(threw, 'resolving while locked throws VaultLockedError');
threw = false; try { await v.unlockVault('wrong'); } catch (e) { threw = /Wrong passphrase/.test(e.message); }
check(threw && (await v.vaultStatus()).has_vault, 'wrong passphrase is refused and the vault is intact');
await v.unlockVault('correct horse');
check((await v.resolveValueRef('user_saved:aadhaar')) === '2345 6789 0124', 'correct passphrase restores access');
check((await v.vaultSlotRefs()).includes('user_saved:aadhaar'), 'slot refs are listed');

console.log('migration');
{
  for (const k of Object.keys(local)) delete local[k];
  v.lockVault();
  local['athena:vault'] = { username: 'demo-user-42' };
  local['athena:provider-base-url'] = 'https://openrouter.ai/api/v1';
  cookies.set('https://openrouter.ai:athena_api_key', { value: 'sk-old' });
  const m = await v.unlockVault('new pass');
  check(m.migrated_from_v1 && m.slots.includes('username') && m.api_key_present, 'v1 slots and the cookie key are imported');
  check(local['athena:vault'] === undefined && !cookies.has('https://openrouter.ai:athena_api_key'), 'plaintext vault and cookie removed');
  check((await v.getProviderApiKey()) === 'sk-old', 'imported key readable');
}

await rm(temp, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
```

Add `"test:vault": "node scripts/test-vault.mjs"`. Run → FAIL (module shape).

- [ ] **Step 2: `vault.ts`**

```ts
import { api } from './browser';

const V2_KEY = 'athena:vault:v2';
const V1_KEY = 'athena:vault';
const REF_PREFIX = 'user_saved:';
const PBKDF2_ITERATIONS = 600_000;
export const VAULT_IDLE_MS = 15 * 60 * 1000;

export class VaultLockedError extends Error { constructor() { super('The vault is locked. Unlock it with your passphrase to continue.'); this.name = 'VaultLockedError'; } }
export class UnknownCredentialError extends Error { constructor(readonly ref: string) { super(`No local credential is stored for "${ref}".`); this.name = 'UnknownCredentialError'; } }

export interface VaultData { slots: Record<string, string>; provider_api_key?: string }
export interface VaultStatus { has_vault: boolean; locked: boolean; slots: string[]; api_key_present: boolean; migrated_from_v1: boolean }
interface StoredVault { kdf: 'pbkdf2-sha256-600k'; salt: string; iv: string; ciphertext: string; api_key_present: boolean }

let key: CryptoKey | null = null;
let cache: VaultData | null = null;
let lastUsed = 0;
let migratedFromV1 = false;

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder(); const dec = new TextDecoder();

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function readStored(): Promise<StoredVault | null> {
  return ((await api.storage.local.get(V2_KEY))?.[V2_KEY] as StoredVault | undefined) ?? null;
}

function touch(): void {
  if (key && Date.now() - lastUsed > VAULT_IDLE_MS) lockVault();
  lastUsed = Date.now();
}

function requireUnlocked(): VaultData {
  touch();
  if (!key || !cache) throw new VaultLockedError();
  return cache;
}

async function persist(salt: Uint8Array): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key!, enc.encode(JSON.stringify(cache)));
  await api.storage.local.set({ [V2_KEY]: { kdf: 'pbkdf2-sha256-600k', salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext), api_key_present: Boolean(cache!.provider_api_key) } satisfies StoredVault });
}
let currentSalt: Uint8Array | null = null;

export async function vaultStatus(): Promise<VaultStatus> {
  touch();
  const stored = await readStored();
  const unlocked = Boolean(key && cache);
  return { has_vault: Boolean(stored), locked: !unlocked, slots: unlocked ? Object.keys(cache!.slots).sort() : [], api_key_present: unlocked ? Boolean(cache!.provider_api_key) : Boolean(stored?.api_key_present), migrated_from_v1: migratedFromV1 };
}

/** Migrates the plaintext v1 vault and the cookie-stored API key, then deletes both. */
async function migrateV1(into: VaultData): Promise<boolean> {
  let migrated = false;
  const v1 = (await api.storage.local.get(V1_KEY))?.[V1_KEY] as Record<string, string> | undefined;
  if (v1 && Object.keys(v1).length) { Object.assign(into.slots, v1); migrated = true; }
  if (v1) await api.storage.local.remove(V1_KEY);
  try {
    const baseUrl = (await api.storage.local.get('athena:provider-base-url'))?.['athena:provider-base-url'] as string | undefined;
    const origin = new URL(baseUrl ?? 'https://openrouter.ai/api/v1').origin;
    const cookie = await api.cookies?.get({ url: `${origin}/__athena_config/`, name: 'athena_api_key' });
    if (cookie?.value) { into.provider_api_key = cookie.value; migrated = true; }
    if (cookie) await api.cookies.remove({ url: `${origin}/__athena_config/`, name: 'athena_api_key' });
  } catch { /* no cookies permission after this release; nothing to migrate */ }
  return migrated;
}

export async function unlockVault(passphrase: string): Promise<VaultStatus> {
  const stored = await readStored();
  if (stored) {
    const salt = unb64(stored.salt);
    const candidate = await deriveKey(passphrase, salt);
    let plain: ArrayBuffer;
    try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(stored.iv) }, candidate, unb64(stored.ciphertext)); }
    catch { throw new Error('Wrong passphrase.'); }
    key = candidate; currentSalt = salt; cache = JSON.parse(dec.decode(plain)) as VaultData; lastUsed = Date.now();
    migratedFromV1 = false;
    return vaultStatus();
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  key = await deriveKey(passphrase, salt); currentSalt = salt; cache = { slots: {} }; lastUsed = Date.now();
  migratedFromV1 = await migrateV1(cache);
  await persist(salt);
  return vaultStatus();
}

export function lockVault(): void { key = null; cache = null; currentSalt = null; }

export async function setSlot(slot: string, value: string): Promise<VaultStatus> { const d = requireUnlocked(); d.slots[slot] = value; await persist(currentSalt!); return vaultStatus(); }
export async function deleteSlot(slot: string): Promise<VaultStatus> { const d = requireUnlocked(); delete d.slots[slot]; await persist(currentSalt!); return vaultStatus(); }
export async function setProviderApiKey(value: string | null): Promise<VaultStatus> { const d = requireUnlocked(); if (value) d.provider_api_key = value; else delete d.provider_api_key; await persist(currentSalt!); return vaultStatus(); }
export async function getProviderApiKey(): Promise<string | null> { return requireUnlocked().provider_api_key ?? null; }
export async function vaultSlotRefs(): Promise<string[]> { touch(); if (!key || !cache) return []; return Object.keys(cache.slots).sort().map((s) => REF_PREFIX + s); }

export async function resolveValueRef(ref: string): Promise<string> {
  if (!ref.startsWith(REF_PREFIX)) throw new UnknownCredentialError(ref);
  const value = requireUnlocked().slots[ref.slice(REF_PREFIX.length)];
  if (value === undefined) throw new UnknownCredentialError(ref);
  return value;
}
```

Header comment: worker-only module; the key is non-extractable and lives in worker memory; a worker restart locks the vault; `storage.local` holds ciphertext only.

- [ ] **Step 3: Provider settings, agent client, manifest**

`provider-settings.ts`: delete `getApiKey/setApiKey/hasApiKey/deleteApiKey`, `cookieDetails`, `API_KEY_COOKIE_NAME`, `COOKIE_PATH`, `COOKIE_LIFETIME_SECONDS`; `readProviderSettings` no longer sets `api_key_present`; `saveProviderSettings` no longer touches the key. `agent-client.ts`: `requestPlan` uses `await getProviderApiKey()` (propagates `VaultLockedError`); `getProviderStatus` returns `{ …, api_key_set: status.api_key_present, vault_locked: status.locked }` from `vaultStatus()`; remove `deleteProviderApiKey` (the panel uses `athena:vault-set-api-key {value:null}`). `manifest.json`: remove `"cookies"` and the `host_permissions` block entirely (`optional_host_permissions` stays; saving a provider URL still requests its origin).

`test-provider.mjs`: remove the cookie fake and the cookie assertions; the API key now comes from `getProviderApiKey`, so stub `chrome.storage.local` as before and, before calling `requestProviderPlan` (which takes the key as an argument and is unchanged), assert `readProviderSettings()` has no `api_key_present` field. Keep the request/guardrail assertions.

- [ ] **Step 4: Worker messages, loop status, panel**

Messages (`messages.ts`): add the six vault messages to `PanelToWorker` with `ResponseFor` → `VaultStatus` (import the type from `../shared/vault` — type-only import is fine in the panel bundle). Worker handlers call the vault functions directly; `vault-unlock` is wrapped so a wrong passphrase returns `fail(new Error('Wrong passphrase.'))`. `athena:check-health` includes `vault_locked`.

`loop.ts`: `RunStatus` adds `'needs_unlock'`. In `executePending`, wrap `deps.execute(...)` in try/catch: if `err?.name === 'VaultLockedError'`, `return transition(run, { status: 'needs_unlock', pending: response }, deps)` (restore `pending`, since it was cleared at the start of `executePending`); rethrow otherwise. `drive`'s while-condition also stops on `'needs_unlock'`; `approve()` accepts `run.status === 'awaiting_approval' || run.status === 'needs_unlock'`. Worker: `run-approve` handler's status check accepts both; `RUN_IN_PROGRESS_STATUSES` and the panel `ACTIVE` set add `'needs_unlock'`. Test in `test-loop.mjs`: fake `execute` throws `Object.assign(new Error('locked'), { name: 'VaultLockedError' })` once → status `needs_unlock` with `pending` kept; a second `approve` with a non-throwing execute → `done`.

Panel (`sidebar.html` / `sidebar.ts`): in Settings, replace the slot table's direct `readVault/writeVault` use with the messages: a passphrase field `#vault-passphrase` + `Unlock` / `Lock` buttons + status line; slot add/remove send `vault-set`/`vault-delete`; the API-key field sends `vault-set-api-key`; while locked, show "Vault locked — unlock to view slot names or plan". In the run card, when `run.status === 'needs_unlock'`, show the passphrase field and an `Unlock and continue` button that sends `vault-unlock` then `run-approve {step: run.step}`. The Ask/Start buttons show a toast "Unlock the vault first" when `HealthReport.vault_locked` is true and the user tries to plan. `options.ts`/`options.html`: same via messages (the options page is an extension page; it may `sendMessage` to the worker).

- [ ] **Step 5: Run**

`cd extension && npm run typecheck && npm run build && npm run test:vault && node scripts/test-provider.mjs && npm run test:loop && npm run test:e2e`. Manual check for the owner is recorded in the report (unlock, add slot, plan, lock, run pauses at `needs_unlock`, unlock resumes).

- [ ] **Step 6: Commit**

```bash
git add extension/src/shared/vault.ts extension/src/shared/provider-settings.ts extension/src/background/agent-client.ts extension/src/background/service-worker.ts extension/src/background/agent/loop.ts extension/src/shared/messages.ts extension/src/sidebar extension/src/options extension/manifest.json extension/scripts/test-vault.mjs extension/scripts/test-provider.mjs extension/scripts/test-loop.mjs extension/package.json
git commit -m "vault: AES-GCM vault for profile slots and the API key, unlocked once per session; a locked vault pauses the run"
```

---

### Task 4: Prompt v3, BlindFill fixture and e2e

**Files:**
- Modify: `extension/src/background/agent-client.ts` (`SYSTEM_PROMPT` rules 4–5, `buildUserMessage` adds `## available_refs`)
- Modify: `server/app/prompt.py` (identical)
- Create: `eval/fixtures/blindfill.html`
- Modify: `extension/scripts/test-e2e.mjs` (stub branch + assertions), `extension/package.json` (`test:e2e:blindfill`)

- [ ] **Step 1: Prompt text**

Replace rules 4 and 5 in both prompts with:

```
4. Sensitive values are shown as tokens such as `[AADHAAR_1]` or `[PHONE_2]`. To move a value you can see on the page into a field, type its token with `value_token` (for example `{"action":"type","selector":"input#aadhaar","value_token":"[AADHAAR_1]"}`). The browser resolves the token locally; you never learn the value.
5. To fill the user's stored profile or credentials, use `value_ref` with one of the names listed under `## available_refs` (for example `user_saved:aadhaar`). Use `value` only for ordinary, non-sensitive text you compose yourself. Never guess a value for a redacted field, and never copy a token or marker into `value`. Set `requires_client_secret` true when your plan contains a `value_ref` or a `value_token`.
```

Rule 6's `type` line becomes `` `type` {selector, value | value_ref | value_token} — replaces the field's content ``. `buildUserMessage`: after `## Goal`, add `## available_refs\n${JSON.stringify(request.available_refs)}` when non-empty (outside the page_data fence; it is the user's data, not the page's). `prompt.py` mirrors it. Update `server/tests/test_prompt.py` if it snapshots headings.

- [ ] **Step 2: Fixture**

`eval/fixtures/blindfill.html`:

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Scholarship portal</title>
<style>body{font:14px system-ui;margin:24px} .card{border:1px solid #ccc;padding:12px;margin-bottom:16px} label{display:block;margin-top:8px}</style></head>
<body>
  <h1>Scholarship application</h1>
  <section class="card" id="profile">
    <h2>Your verified profile</h2>
    <dl>
      <dt>Name</dt><dd id="p-name">Rohan Iyer</dd>
      <dt>Aadhaar</dt><dd id="p-aadhaar">2345 6789 0124</dd>
      <dt>Registered mobile</dt><dd id="p-phone">9845012345</dd>
    </dl>
  </section>
  <form id="apply" action="#" onsubmit="event.preventDefault(); document.getElementById('out').textContent='submitted'">
    <label for="name">Applicant name</label><input id="name" name="name" type="text" autocomplete="name">
    <label for="aadhaar">Aadhaar number</label><input id="aadhaar" name="aadhaar" type="text" inputmode="numeric" maxlength="14">
    <label for="mobile">Mobile</label><input id="mobile" name="mobile" type="tel">
    <label for="dept">Department</label>
    <select id="dept" name="dept"><option value="">Choose</option><option value="cs">Computer Science</option><option value="ee">Electrical</option></select>
    <button type="button" id="continue">Continue</button>
    <button type="submit" id="submit">Submit application</button>
  </form>
  <p id="out"></p>
</body></html>
```

- [ ] **Step 3: Stub and assertions**

In `test-e2e.mjs`, the stub already parses `dom_summary`; also parse `## redaction_manifest` (same regex shape, heading `redaction_manifest`) and `## available_refs`. New branch, chosen when a node path includes `p-aadhaar`:

```js
  const aadhaarToken = manifest.find((e) => e.type === 'aadhaar' && e.dom_path === 'dd#p-aadhaar')?.id;
  const phoneToken = manifest.find((e) => e.type === 'phone' && e.dom_path === 'dd#p-phone')?.id;
  planText = JSON.stringify({ reasoning_summary: 'Copy the verified profile into the form and choose the department.', actions: [
    { action: 'type', selector: 'input#name', value_ref: 'user_saved:name', risk: 'sensitive' },
    aadhaarToken && { action: 'type', selector: 'input#aadhaar', value_token: `[${aadhaarToken}]`, risk: 'sensitive' },
    phoneToken && { action: 'type', selector: 'input#mobile', value_token: `[${phoneToken}]`, risk: 'sensitive' },
    { action: 'select', selector: 'select#dept', option: 'Computer Science', risk: 'routine' },
    { action: 'click', selector: 'button#continue', risk: 'sensitive' },
  ].filter(Boolean), requires_client_secret: true, done: true, result: 'Filled from the verified profile; stopped before submission.' });
```

Harness branch for this fixture (detect by `plan.actions.some((a) => a.value_token)`): the page bundle's `buildPayload` must expose the registry (add to the entry: `export const registry = new TokenRegistry('e2e-session'); …` and use it in `buildAgentRequest`; add `export function resolveToken(t) { return registry.valueOf(t.slice(1, -1)) ?? null; }`). Assertions:

- request body does not contain `2345 6789 0124`, `9845012345`, or `Rohan Iyer` → pass "profile values absent from the request";
- `request.dom_summary` node `dd#p-aadhaar` value matches `/^\[AADHAAR_\d+\]$/` → pass "on-page Aadhaar is a numbered token";
- `request.available_refs` includes `user_saved:name` (the harness passes `availableRefs: ['user_saved:name']` into `buildAgentRequest`) → pass;
- plan contains a `value_token` and `requires_client_secret === true`;
- resolve `value_token` via `ATHENA.resolveToken` and `value_ref` via the harness `VAULT = { 'user_saved:name': 'Rohan Iyer' }`, execute everything except the click; assert `input#aadhaar` value is `2345 6789 0124`, `input#mobile` is `9845012345`, `input#name` is `Rohan Iyer`, `select#dept` is `cs`; then the click; assert `#out` is empty (Continue is `type=button`; nothing submitted).

Script: `"test:e2e:blindfill": "node scripts/test-e2e.mjs ../eval/fixtures/blindfill.html"`.

- [ ] **Step 4: Run**

`cd extension && npm run typecheck && npm run build && npm run test:e2e && npm run test:e2e:c && npm run test:e2e:blindfill && cd ../server && uv run pytest -q`.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/agent-client.ts server/app/prompt.py server/tests eval/fixtures/blindfill.html extension/scripts/test-e2e.mjs extension/package.json
git commit -m "prompt: tokens and stored refs are the way to fill sensitive fields; BlindFill end-to-end on a profile-to-form fixture"
```

---

### Task 5: Privacy firewall

**Files:**
- Create: `extension/src/redaction/firewall.ts`
- Modify: `extension/src/redaction/build-request.ts` (replace `assertNoRawPii` with the firewall; attach report)
- Modify: `extension/src/shared/messages.ts` (`PayloadPreview.firewall: FirewallReport | null`)
- Modify: `extension/src/pii-detection/detect.ts` (`DetectOptions.disabledDetectors?: Set<string>`)
- Modify: `extension/src/background/service-worker.ts` (reads `athena:debug-disabled-detectors`, passes it; attaches report)
- Modify: `extension/src/sidebar/sidebar.html`, `sidebar.ts` (Settings: "Demo: disable a detector" text input with a warning banner; Privacy card shows `firewall masked N · blocked N` when the report is non-empty)
- Modify: `extension/scripts/test-reasoning.mjs`, `extension/scripts/fixtures.spec.mjs`, `extension/scripts/test-redaction.mjs`

**Interfaces:**
```ts
export interface FirewallHit { type: PiiType; rule: string; field: string; action: 'masked' | 'blocked' }
export interface FirewallReport { fields_scanned: number; masked: number; blocked: number; hits: FirewallHit[] }
export function scanRequest(request: AgentRequest, registry: TokenRegistry, snapshotNodesByPath: Map<string, RawDomNode>): FirewallReport;
// mutates request.dom_summary values/labels, request.task_instruction, request.prior_actions[].value (masking) and pushes manifest entries; throws RawPiiLeakError after filling the report when blocked > 0
```

- [ ] **Step 1: Failing tests**

Append to `test-reasoning.mjs`:

```js
console.log('firewall');
{
  await build({ entryPoints: ['src/redaction/firewall.ts'], outfile: join(temp, 'firewall.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
  const { scanRequest, FIREWALL_RULES } = await import(`file://${join(temp, 'firewall.mjs')}`);
  const { TokenRegistry } = await import(`file://${join(temp, 'tokens.mjs')}`);
  const mk = (nodes, task = 'go') => ({ session_id: 's', task_instruction: task, screenshot_redacted: null, dom_summary: nodes, redaction_manifest: [], prior_actions: [], truncated: false, available_refs: ['user_saved:aadhaar'] });
  const nodesByPath = (nodes) => new Map(nodes.map((n) => [n.path, { path: n.path, bbox: [0, 0, 10, 10] }]));

  let req = mk([{ path: 'p#a', role: null, label: null, value: 'Mail us at abcd@gmail.com or call +91 98450 12345' }]);
  let rep = scanRequest(req, new TokenRegistry('s'), nodesByPath(req.dom_summary));
  check(rep.masked === 2 && rep.blocked === 0, `tier-2 email and phone are masked, not blocked (${rep.masked}/${rep.blocked})`);
  check(/\[EMAIL_1\].*\[PHONE_1\]/.test(req.dom_summary[0].value), `values replaced with tokens: ${req.dom_summary[0].value}`);
  check(req.redaction_manifest.length === 2 && req.redaction_manifest.every((e) => e.detector.startsWith('firewall:')), 'one manifest entry per masked hit, detector firewall:*');

  req = mk([{ path: 'p#u', role: null, label: null, value: 'pay priya@okaxis now' }]);
  rep = scanRequest(req, new TokenRegistry('s'), nodesByPath(req.dom_summary));
  check(rep.masked === 1 && rep.hits[0].type === 'account_id' && rep.hits[0].rule === 'upi', 'UPI id masked as account_id');

  req = mk([{ path: 'p#c', role: null, label: null, value: 'card 4539 1488 0343 6467' }]);
  let threw = null; try { scanRequest(req, new TokenRegistry('s'), nodesByPath(req.dom_summary)); } catch (e) { threw = e; }
  check(threw?.name === 'RawPiiLeakError' && !String(threw.message).includes('4539'), 'tier-1 card blocks without quoting the value');

  req = mk([{ path: 'p#z', role: null, label: null, value: 'ref ４５３９１４８８０３４３６４６７' }]);
  threw = null; try { scanRequest(req, new TokenRegistry('s'), nodesByPath(req.dom_summary)); } catch (e) { threw = e; }
  check(threw?.name === 'RawPiiLeakError', 'full-width digits are folded before matching');

  req = mk([{ path: 'p#i', role: null, label: null, value: 'GB29 NWBK 6016 1331 9268 19' }]);
  threw = null; try { scanRequest(req, new TokenRegistry('s'), nodesByPath(req.dom_summary)); } catch (e) { threw = e; }
  check(threw?.name === 'RawPiiLeakError', 'IBAN with valid mod-97 blocks');

  req = mk([{ path: 'p#ok', role: null, label: null, value: 'Order 12345 shipped, [EMAIL_1] notified, GB00 not an iban' }], 'help user_saved:aadhaar');
  rep = scanRequest(req, new TokenRegistry('s'), nodesByPath(req.dom_summary));
  check(rep.masked === 0 && rep.blocked === 0, 'short numbers, existing tokens and slot names do not fire');
  check(FIREWALL_RULES.every((r) => typeof r.name === 'string' && r.regex instanceof RegExp), 'rules table is data');
}
```

In `fixtures.spec.mjs` add to `edge-cases` (or `bank-login`, whichever has the prose email) a `firewallCatches` entry, and in `test-redaction.mjs` a second pass that rebuilds the payload with `disabledDetectors: new Set(['regex:email'])` and asserts the email is still absent and `preview.firewall.masked >= 1` with a `firewall:email` manifest entry. Run → FAIL.

- [ ] **Step 2: `firewall.ts`**

```ts
/**
 * Independent outbound scanner (design spec §C). Deliberately does NOT import
 * pii-detection/*: a bug shared with the detectors would be a bug in both
 * layers. Rules are self-validating where a checksum exists. A Tier-1 hit means
 * the request is not sent; a Tier-2 hit is masked in place with a registry token
 * and declared in the manifest.
 */
import type { AgentRequest, PiiType, RawDomNode, RedactionManifestEntry } from '../shared/schema';
import { TIER_BY_TYPE } from '../shared/schema';
import type { TokenRegistry } from './tokens';
import { RawPiiLeakError } from '../shared/errors';   // moved out of build-request.ts in this task; build-request re-exports it so existing imports keep working

export interface FirewallRule { name: string; type: PiiType; regex: RegExp; validate?: (m: string) => boolean }

const digitsOf = (s: string) => s.replace(/\D/g, '');
const luhn = (s: string) => { const d = digitsOf(s); let sum = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]!; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; } return d.length >= 12 && sum % 10 === 0; };
const VERHOEFF_D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VERHOEFF_P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
const verhoeff = (s: string) => { const d = digitsOf(s); if (d.length !== 12) return false; let c = 0; const rev = [...d].reverse(); for (let i = 0; i < rev.length; i++) c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![+rev[i]!]!]!; return c === 0; };
const mod97 = (s: string) => { const iban = s.replace(/\s+/g, '').toUpperCase(); if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false; const r = iban.slice(4) + iban.slice(0, 4); let rem = 0; for (const ch of r) { const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55); for (const c of v) rem = (rem * 10 + +c) % 97; } return rem === 1; };

export const FIREWALL_RULES: FirewallRule[] = [
  { name: 'email', type: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'upi', type: 'account_id', regex: /\b[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}\b(?![.\w])/g },
  { name: 'card', type: 'card_number', regex: /\b(?:\d[ -]?){12,19}\b/g, validate: luhn },
  { name: 'aadhaar', type: 'aadhaar', regex: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, validate: verhoeff },
  { name: 'pan', type: 'pan', regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { name: 'ifsc', type: 'ifsc', regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  { name: 'iban', type: 'bank_account', regex: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, validate: mod97 },
  { name: 'ssn', type: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'phone-in', type: 'phone', regex: /(?:\+91[ -]?)?\b[6-9]\d{4}[ -]?\d{5}\b/g },
];

const TOKEN_OR_MARKER = /\[(?:REDACTED:[A-Z_]+|[A-Z][A-Z0-9_]*_\d+)\]/g;
/** NFKC folds full-width and other compatibility digits to ASCII; other scripts' digits are mapped by Unicode category. */
const foldDigits = (s: string) => s.normalize('NFKC').replace(/\p{Nd}/gu, (d) => String(Number.parseInt(d, 10) >= 0 ? d.charCodeAt(0) - (d.codePointAt(0)! - (d.codePointAt(0)! % 10) - 0x30 + 0x30) : d)); // implementer: verify on '４' and '५'; fall back to a lookup of the 10-digit ranges if this expression proves wrong
```

(Implementer note: `foldDigits` as written is fragile. Use this instead and delete the one above:
```ts
const foldDigits = (s: string) => s.normalize('NFKC').replace(/\p{Nd}/gu, (d) => { const cp = d.codePointAt(0)!; for (const zero of DIGIT_ZEROS) if (cp >= zero && cp <= zero + 9) return String(cp - zero); return d; });
const DIGIT_ZEROS = [0x0030, 0x0660, 0x06F0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0E50, 0xFF10];
```
covering ASCII, Arabic-Indic, Devanagari through Malayalam, Thai and full-width.)

```ts
export interface FirewallHit { type: PiiType; rule: string; field: string; action: 'masked' | 'blocked' }
export interface FirewallReport { fields_scanned: number; masked: number; blocked: number; hits: FirewallHit[] }

function scanText(text: string): { rule: FirewallRule; match: string; index: number }[] {
  const folded = foldDigits(text);
  const out: { rule: FirewallRule; match: string; index: number }[] = [];
  const shielded = folded.replace(TOKEN_OR_MARKER, (m) => ' '.repeat(m.length)); // existing tokens never re-fire
  for (const rule of FIREWALL_RULES) for (const m of shielded.matchAll(rule.regex)) {
    if (rule.validate && !rule.validate(m[0])) continue;
    out.push({ rule, match: folded.slice(m.index!, m.index! + m[0].length), index: m.index! });
  }
  return out;
}

export function scanRequest(request: AgentRequest, registry: TokenRegistry, nodesByPath: Map<string, Pick<RawDomNode, 'path' | 'bbox'>>): FirewallReport {
  const report: FirewallReport = { fields_scanned: 0, masked: 0, blocked: 0, hits: [] };
  const maskField = (text: string, field: string, path: string | null): string => {
    report.fields_scanned++;
    let out = foldDigits(text);
    const hits = scanText(text).sort((a, b) => b.index - a.index);
    for (const { rule, match } of hits) {
      const tier = TIER_BY_TYPE[rule.type];
      if (tier === 1) { report.blocked++; report.hits.push({ type: rule.type, rule: rule.name, field, action: 'blocked' }); continue; }
      const id = registry.idFor(rule.type, match, path ?? field);
      out = out.split(match).join(`[${id}]`);
      report.masked++; report.hits.push({ type: rule.type, rule: rule.name, field, action: 'masked' });
      if (path) request.redaction_manifest.push({ id, type: rule.type, tier, bbox: nodesByPath.get(path)?.bbox ?? null, dom_path: path, masking: 'token', detector: `firewall:${rule.name}`, confidence: 1 } as RedactionManifestEntry);
    }
    return out;
  };
  request.task_instruction = maskField(request.task_instruction, 'task_instruction', null);
  for (const node of request.dom_summary) {
    if (node.label) node.label = maskField(node.label, `${node.path}.label`, node.path);
    if (node.value) node.value = maskField(node.value, `${node.path}.value`, node.path);
  }
  for (const [i, a] of request.prior_actions.entries()) if (a.value) a.value = maskField(a.value, `prior_actions[${i}].value`, null);
  if (report.blocked > 0) throw new RawPiiLeakError(report.hits.filter((h) => h.action === 'blocked').map((h) => `${h.field} matches firewall:${h.rule}`));
  return report;
}
```

Create `extension/src/shared/errors.ts` holding `RawPiiLeakError` (moved verbatim from `build-request.ts`, which now imports and re-exports it) so `firewall.ts` and `build-request.ts` do not import each other. Note the manifest bbox is the whole node's box (node-granular, over-redaction, as the README already states for pixel geometry). The screenshot is redacted from the manifest AFTER the firewall runs, so the new entries are blacked out: move the firewall call in `buildAgentRequest` to before `redactImage`.

- [ ] **Step 3: Wire it**

`build-request.ts`: delete `assertNoRawPii`; after `domSummary`/`manifest` are assembled and before the screenshot is redacted, `const firewall = scanRequest(requestDraft, tokens, nodesByPath)`; return `firewall` in `BuildResult`. `PayloadPreview.firewall: FirewallReport | null`; `buildPayload` copies it; on `RawPiiLeakError` the preview's `error` is set as today and `firewall` carries the report with `blocked > 0` (attach the report to the error object as `err.report` so `buildPayload` can surface it). `detect.ts`: `DetectOptions.disabledDetectors?: Set<string>`; stage 1 skips rules whose `detector` is in the set, stage 2 skips patterns likewise. Worker reads `storage.local['athena:debug-disabled-detectors']` (string[]) in `buildPayload`. Settings UI: text input `#debug-detectors` (comma-separated detector names, e.g. `regex:email`) with a red banner "Demo only: the named detectors are switched off so the firewall's catch is visible. Clear this before real use." Privacy card: a fourth chip `firewall` reading `masked N · blocked N`, hidden when both are 0.

- [ ] **Step 4: Run**

`cd extension && npm run typecheck && npm run build && npm run test:reasoning && npm run test:redaction && npm run test:e2e && npm run test:e2e:c && npm run test:e2e:blindfill && cd ../eval && node measure_labels.mjs && node predict.mjs && python3 run_eval.py` — pass; eval unchanged (firewall entries only appear when the detectors missed something; on the corpus they should not fire — if they do, the report names the fixture item and that is a detector gap to record, not to hide).

- [ ] **Step 5: Commit**

```bash
git add extension/src/redaction/firewall.ts extension/src/redaction/build-request.ts extension/src/shared/messages.ts extension/src/shared/errors.ts extension/src/pii-detection/detect.ts extension/src/background/service-worker.ts extension/src/sidebar extension/scripts/test-reasoning.mjs extension/scripts/fixtures.spec.mjs extension/scripts/test-redaction.mjs
git commit -m "firewall: an independent outbound scan masks tier-2 leaks and blocks tier-1 leaks, with a demo switch to prove it"
```

---

### Task 6: Docs and full harness

**Files:** `README.md`, `HANDOFF.md`, `PRD_Privacy_Preserving_Vision_Agent.md` (§4.3 paragraph), `docs/pitch.md`, `CLAUDE.md` (one bullet).

- [ ] **Step 1: Docs**
  - PRD §4.3: add "Tier-1 identifiers (Aadhaar, PAN, card, bank, passport, SSN, IFSC) are sent as numbered opaque tokens; the model may ask to type a token back and the browser resolves it locally for an approved step. Passwords, OTPs, CVVs and faces remain non-resolvable markers."
  - README: new section "BlindFill: acting on values the model never sees" (tokens, `value_token`, `available_refs`, approval); "Vault" (passphrase, 15-minute relock, what is inside, migration note); "Privacy firewall" (independent rules, mask vs block, the demo switch); update the test list (`test:vault`, `test:e2e:blindfill`); remove any mention of the API-key cookie.
  - HANDOFF: phase 5a done with commit range; known limits: firewall has no OCR; vault key dies with the worker (user re-enters passphrase after a browser restart); token registry mirror in `storage.session`.
  - CLAUDE.md, under "PII detection & redaction": "Tier-1 identifiers in `RESOLVABLE_TIER1` are tokenised, not fixed-marked; `value_token` is resolved only in the worker."
  - pitch.md: wedge sentence → "The server can understand and act on private workflows without ever receiving the user's identity or secrets."; add BlindFill and the firewall to the feature list; update test counts.

- [ ] **Step 2: Full harness**

`cd extension && npm run typecheck && npm run build && npm run smoke && npm run test:capture && npm run test:redaction && npm run test:faces && npm run test:scenario-b && npm run test:e2e && npm run test:e2e:c && npm run test:e2e:blindfill && npm run test:executor && npm run test:reasoning && npm run test:loop && npm run test:vault && npm run preview:viewer && node scripts/test-provider.mjs`; `cd server && uv run pytest -q`; `cd eval && node measure_labels.mjs && node predict.mjs && python3 run_eval.py`. Record every last line in the report.

- [ ] **Step 3: Commit**

```bash
git add README.md HANDOFF.md PRD_Privacy_Preserving_Vision_Agent.md docs/pitch.md CLAUDE.md
git commit -m "docs: BlindFill tokens, the encrypted vault, and the privacy firewall"
```

---

## Self-review

- **Spec coverage.** §A: T1 (tokens, registry, mirror, `available_refs`), T2 (guardrails, executor, panel), T4 (prompt, e2e). §B: T3 in full incl. migration, manifest, `needs_unlock`, UI. §C: T5 incl. demo switch and report; the metrics card itself is plan 5b, the report is attached now. Deferred to 5b: §D, §E, §F, §G, portal fixture.
- **Placeholders.** The first `foldDigits` draft is explicitly superseded by the second; the implementer deletes the first. No TBDs.
- **Type consistency.** `TokenRegistry.valueOf` (T1) used by `toExecutable` (T2) and `scanRequest` (T5 uses `idFor`); `RESOLVABLE_TIER1` (T1) used by `redact-text` (T1), guardrails (T2), Python mirror (T2); `VaultLockedError` name checked by string in `loop.ts` (T3) because `loop.ts` must not import the vault module; `FirewallReport` (T5) on `PayloadPreview` (T5); `available_refs` (T1) consumed by guardrails (T2), prompt (T4), firewall (T5 excludes it).
