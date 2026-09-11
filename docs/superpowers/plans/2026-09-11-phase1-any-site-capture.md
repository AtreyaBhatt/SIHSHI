# Phase 1 — Any-site capture: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The extension captures, detects and redacts correctly on real websites — pages with shadow DOM, iframes, service-specific identifiers and thousands of nodes — and can be enabled per site instead of per click.

**Architecture:** The DOM walk (`extension/src/capture/dom-snapshot.ts`) learns to descend into open shadow roots and to report iframes; a single `resolvePath()` in `extension/src/shared/resolve-path.ts` becomes the only way any code turns a snapshot path back into an element. Iframes become Tier-1 `frame` manifest entries (black-boxed pixels), identifiers become Tier-2 `account_id` tokens, oversized pages keep every interactive element under a higher cap and say so on the wire. Page access moves to `optional_host_permissions` granted from the side panel.

**Tech Stack:** TypeScript (strict), esbuild, Manifest V3, headless Chrome harnesses driven over CDP from Node ≥ 22 (`extension/scripts/*.mjs`), Python 3.11 FastAPI server (kept in step, `uv run pytest`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-11-athena-real-product-design.md`, section "Phase 1 — Any-site capture". Read it first.
- Working rules: `CLAUDE.md`. In particular: never mutate the live page during capture/redaction; every redaction gets a manifest entry; ground truth in `eval/corpus/labels` never imports from `extension/src/pii-detection` or `extension/src/redaction`.
- Do not add tiers. New `PiiType` values in this phase: `frame` (Tier 1) and `account_id` (Tier 2). Mirror both in `server/app/schemas.py` and `eval/corpus/annotation.schema.json`.
- All harness commands are run from `extension/`: `npm run typecheck`, `npm run build`, `npm run smoke`, `npm run test:redaction`, `npm run test:faces`, `npm run test:scenario-b`, `npm run test:e2e`, `npm run preview:viewer`. Eval from repo root: `node eval/measure_labels.mjs && node eval/predict.mjs && python3 eval/run_eval.py`. Server: `cd server && uv run pytest -q`.
- Chrome binary: `google-chrome-stable` (override with `ATHENA_CHROME`). The model file `extension/models/version-RFB-320.onnx` and `eval/fixtures/assets/faces-2.jpg` are already present on this machine.
- Commit after every task with a plain message (no trailers, no co-author lines). Do not push.
- Branch: `hopefully_final`.

## File map

| File | Responsibility after this phase |
|---|---|
| `extension/src/shared/resolve-path.ts` | **New.** `resolvePath(path, root)` — the only path→element resolver. Understands ` >>> ` shadow hops. |
| `extension/src/capture/dom-snapshot.ts` | Walk descends into open shadow roots; paths carry ` >>> `; iframes captured as `media:'iframe'`; 800-node budget with interactive-first selection. |
| `extension/src/shared/schema.ts` | `PiiType` += `frame`, `account_id`; `RawDomNode.media` += `'iframe'`; `AgentRequest.truncated`. |
| `extension/src/pii-detection/dom-heuristics.ts` | `dom:account-id` rule. |
| `extension/src/redaction/build-request.ts` | Emits `frame` manifest entries for iframe nodes; passes `truncated` through. |
| `extension/src/executor/execute.ts` | `findOne` uses `resolvePath`. |
| `extension/src/background/service-worker.ts` | Capture works under a host permission; clearer error when neither `activeTab` nor a host permission is present. |
| `extension/src/sidebar/sidebar.ts`, `sidebar.html` | Enable/Disable-on-this-site control. |
| `extension/manifest.json` | `optional_host_permissions`. |
| `extension/scripts/test-capture.mjs` | **New** harness for the shadow/iframe fixture. |
| `extension/scripts/smoke-capture.mjs`, `test-e2e.mjs`, `fixtures.spec.mjs` | Use `resolvePath`; account-id expectations. |
| `eval/fixtures/shadow-iframe.html` | **New** fixture. |
| `eval/measure_labels.mjs` | Resolves label selectors with `resolvePath`. |
| `eval/corpus/labels/*.labels.json`, `eval/corpus/annotation.schema.json` | account_id annotations; enum update. |
| `server/app/schemas.py` | Mirror new types and `truncated`. |
| `README.md`, `HANDOFF.md`, `CLAUDE.md` | Docs. |

---

### Task 1: `resolvePath` and the shadow/iframe fixture

**Files:**
- Create: `extension/src/shared/resolve-path.ts`
- Create: `eval/fixtures/shadow-iframe.html`
- Create: `extension/scripts/test-capture.mjs`
- Modify: `extension/package.json` (add `"test:capture": "node scripts/test-capture.mjs"`)

**Interfaces:**
- Produces: `export const SHADOW_SEP = ' >>> '` and `export function resolvePath(path: string, root?: ParentNode): Element[]` in `extension/src/shared/resolve-path.ts`. Later tasks (2, 6, 7) import exactly these.

- [ ] **Step 1: Write the fixture**

`eval/fixtures/shadow-iframe.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Widget checkout — shadow DOM and iframe</title>
<!--
  Fixture for the any-site capture work. Every value is synthetic.

  Plants the two shapes real apps have that the demo fixtures do not:
    - a web component whose form lives in an OPEN shadow root (the walk must
      descend into it and the path must carry a ` >>> ` hop)
    - an iframe whose contents the DOM walk cannot see but the screenshot can
      (the whole frame must be black-boxed and declared as a `frame` in the
      manifest)
-->
<style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1b1d21; background: #fff; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  #widget { display: block; margin-bottom: 24px; }
  iframe { border: 1px solid #c6ccd4; border-radius: 6px; display: block; }
</style>
</head>
<body>
  <h1>Checkout</h1>
  <div id="widget"></div>
  <iframe id="payment" title="Payment" width="420" height="120"
    srcdoc="<body style='margin:0;font:16px system-ui;padding:16px'>Card on file: <b>4539 1488 0343 6467</b> (exp 09/29)</body>"></iframe>
  <p id="after">Order total: 3 items.</p>
  <script>
    const root = document.getElementById('widget').attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>label{display:block;font-size:13px;margin-bottom:4px}input{display:block;width:300px;padding:8px;margin-bottom:12px;border:1px solid #c6ccd4;border-radius:5px}</style>
      <label for="inner-email">Email</label>
      <input id="inner-email" type="email" value="grace.hopper@example.org" />
      <label for="inner-name">Full name</label>
      <input id="inner-name" type="text" name="fullName" value="Grace Hopper" />
      <button id="inner-go" type="button">Continue</button>
    `;
  </script>
</body>
</html>
```

- [ ] **Step 2: Write `resolvePath`**

`extension/src/shared/resolve-path.ts`:

```ts
/**
 * The only way a snapshot path becomes an element again.
 *
 * Paths are CSS selectors, except that ` >>> ` separates shadow-root hops:
 * `div#widget >>> input#inner-email` means "resolve `div#widget` in the
 * current root, step into its open shadow root, resolve `input#inner-email`
 * there". `querySelector` cannot cross a shadow boundary, so every consumer —
 * executor, harnesses, the corpus measurer — goes through this function.
 *
 * Returns every match of the final segment so callers can insist on exactly one.
 * An ambiguous or missing host on the way returns the host matches (or nothing)
 * so the caller's "must be exactly one" check fails with a useful count.
 */
export const SHADOW_SEP = ' >>> ';

export function resolvePath(path: string, root: ParentNode = document): Element[] {
  const segments = path.split(SHADOW_SEP);
  let scope: ParentNode = root;
  for (let i = 0; i < segments.length; i++) {
    let matches: Element[];
    try {
      matches = Array.from(scope.querySelectorAll(segments[i]!));
    } catch {
      return [];
    }
    if (i === segments.length - 1) return matches;
    if (matches.length !== 1) return matches;
    const shadow = matches[0]!.shadowRoot;
    if (!shadow) return [];
    scope = shadow;
  }
  return [];
}
```

- [ ] **Step 3: Write the harness (it fails until Tasks 2–3 land)**

`extension/scripts/test-capture.mjs`:

```js
/**
 * Any-site capture: shadow DOM and iframes.
 *
 * Loads eval/fixtures/shadow-iframe.html in real Chrome and checks:
 *   - a node inside the open shadow root is captured, with a ` >>> ` path
 *   - every emitted path resolves to exactly one element via resolvePath
 *   - the iframe is captured as media 'iframe' and declared in the manifest
 *     as a Tier-1 `frame` entry
 *   - the redacted screenshot is black over the iframe (the card number the
 *     walk cannot see is nonetheless gone)
 *   - the email inside the shadow root does not survive into the payload
 *
 * Usage:  npm run test:capture
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const CHROME = process.env.ATHENA_CHROME ?? 'google-chrome-stable';
const PORT = Number(process.env.ATHENA_CDP_PORT ?? 9344);
const fixture = resolve('../eval/fixtures/shadow-iframe.html');

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures++; console.error(`  FAIL ${m}`); };

const workdir = await mkdtemp(join(tmpdir(), 'athena-capture-'));
const entry = join(workdir, 'entry.ts');
await writeFile(entry, `
import { captureDomSnapshot } from '${resolve('src/capture/dom-snapshot.ts')}';
import { resolvePath } from '${resolve('src/shared/resolve-path.ts')}';
import { buildAgentRequest } from '${resolve('src/redaction/build-request.ts')}';
import { TokenRegistry } from '${resolve('src/redaction/tokens.ts')}';

export async function run(shotDataUrl) {
  const snapshot = captureDomSnapshot();
  const resolution = snapshot.nodes.map((n) => ({ path: n.path, count: resolvePath(n.path).length }));
  const { request } = await buildAgentRequest({
    snapshot, screenshotDataUrl: shotDataUrl, taskInstruction: 'Continue checkout.',
    tokens: new TokenRegistry('capture-test'), threshold: 0.5,
  });

  // Sample the redacted PNG at the centre of the iframe's box.
  const frame = snapshot.nodes.find((n) => n.path === 'iframe#payment');
  let centre = null;
  if (frame && request.screenshot_redacted) {
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = 'data:image/png;base64,' + request.screenshot_redacted; });
    const scale = img.width / snapshot.viewport.width;
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const [x1, y1, x2, y2] = frame.bbox;
    const px = ctx.getImageData(Math.round(((x1 + x2) / 2) * scale), Math.round(((y1 + y2) / 2) * scale), 1, 1).data;
    centre = [px[0], px[1], px[2]];
  }
  return { nodes: snapshot.nodes, resolution, request, centre, truncated: snapshot.truncated };
}
`);
await build({ entryPoints: [entry], outfile: join(workdir, 'bundle.js'), bundle: true, format: 'iife', globalName: 'ATHENA', target: 'chrome116', logLevel: 'error' });
const bundle = await readFile(join(workdir, 'bundle.js'), 'utf8');

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1280,800',
  '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--user-data-dir=${join(workdir, 'profile')}`, `file://${fixture}`,
], { stdio: 'ignore' });

let socket;
try {
  let pages = [];
  for (let i = 0; i < 60 && pages.length === 0; i++) {
    try { pages = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page'); } catch {}
    if (pages.length === 0) await sleep(250);
  }
  if (pages.length === 0) throw new Error(`No page target on :${PORT}`);
  socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((ok, no) => { socket.onopen = ok; socket.onerror = () => no(new Error('CDP connect failed')); });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const call = (method, params) => { const id = ++nextId; return new Promise((ok) => { pending.set(id, ok); socket.send(JSON.stringify({ id, method, params })); }); };
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails, null, 2));
    return r.result?.result?.value;
  };

  for (let i = 0; i < 40 && (await evaluate('document.readyState')) !== 'complete'; i++) await sleep(200);
  await sleep(400); // let the srcdoc frame paint
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  await evaluate(bundle);
  const r = JSON.parse(await evaluate(`ATHENA.run(${JSON.stringify(`data:image/png;base64,${shot.result.data}`)}).then((x) => JSON.stringify(x))`));
  const byPath = new Map(r.nodes.map((n) => [n.path, n]));
  console.log(`nodes ${r.nodes.length} · manifest ${r.request.redaction_manifest.length}`);

  console.log('\nshadow DOM:');
  const inner = byPath.get('div#widget >>> input#inner-email');
  if (inner) pass('input inside the open shadow root captured as div#widget >>> input#inner-email');
  else fail(`shadow input not captured; paths seen: ${[...byPath.keys()].filter((p) => p.includes('inner')).join(', ') || 'none'}`);
  const bad = r.resolution.filter((x) => x.count !== 1);
  if (bad.length === 0) pass(`all ${r.resolution.length} paths resolve to exactly one element`);
  else fail(`${bad.length} path(s) do not resolve uniquely: ${bad.map((b) => `${b.path} → ${b.count}`).join('; ')}`);
  const payload = JSON.stringify(r.request);
  if (payload.includes('grace.hopper@example.org')) fail('raw email inside the shadow root is in the payload');
  else pass('email inside the shadow root redacted');
  if (payload.includes('Grace Hopper')) fail('raw name inside the shadow root is in the payload');
  else pass('name inside the shadow root redacted');
  if (payload.includes('Continue')) pass('shadow button label kept');
  else fail('shadow button label lost');

  console.log('\niframe:');
  const frame = byPath.get('iframe#payment');
  if (frame?.media === 'iframe' && frame.role === 'frame') pass("iframe captured with media 'iframe' and role 'frame'");
  else fail(`iframe node: ${JSON.stringify(frame)}`);
  const entry = r.request.redaction_manifest.find((e) => e.type === 'frame' && e.dom_path === 'iframe#payment');
  if (entry?.tier === 1 && entry.masking === 'blackbox') pass('manifest declares the frame as a Tier-1 blackbox region');
  else fail(`no frame manifest entry: ${JSON.stringify(r.request.redaction_manifest.map((e) => e.type))}`);
  if (r.centre && r.centre.every((v) => v < 16)) pass(`iframe pixels are black in the redacted screenshot (${r.centre.join(',')})`);
  else fail(`iframe centre pixel is ${JSON.stringify(r.centre)} — the card number inside the frame is visible`);
  if (payload.includes('4539')) fail('card number from inside the iframe is in the payload text');
  else pass('nothing from inside the iframe is in the payload text');
} catch (err) {
  fail(err.message);
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
  await sleep(150);
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 4: Register the script and run it to see it fail**

In `extension/package.json` `scripts`, after `"smoke"`, add `"test:capture": "node scripts/test-capture.mjs",`.

Run: `cd extension && npm run test:capture`
Expected: FAIL — "shadow input not captured", "no frame manifest entry", "iframe centre pixel is …" (the walk does not enter shadow roots or report iframes yet).

- [ ] **Step 5: Commit**

```bash
git add extension/src/shared/resolve-path.ts eval/fixtures/shadow-iframe.html extension/scripts/test-capture.mjs extension/package.json
git commit -m "capture: resolvePath and the shadow/iframe fixture + harness (red)"
```

---

### Task 2: Walk open shadow roots; per-root path uniqueness

**Files:**
- Modify: `extension/src/capture/dom-snapshot.ts`

**Interfaces:**
- Consumes: `SHADOW_SEP` from `../shared/resolve-path`.
- Produces: `RawDomNode.path` may contain ` >>> `. `captureDomSnapshot()` signature unchanged.

- [ ] **Step 1: Replace the selector builders and the walk**

In `extension/src/capture/dom-snapshot.ts`:

Add the import at the top:
```ts
import { SHADOW_SEP } from '../shared/resolve-path';
```

Replace `uniqueIdSelector` and `cssPath` with:

```ts
type Root = Document | ShadowRoot;

function uniqueIdSelector(el: Element, root: Root): string | null {
  const id = el.getAttribute('id');
  if (!id || !isStableId(id)) return null;
  try {
    const sel = `#${CSS.escape(id)}`;
    if (root.querySelectorAll(sel).length === 1) return `${el.tagName.toLowerCase()}${sel}`;
  } catch {
    /* invalid selector — fall through to the structural path */
  }
  return null;
}

/** Path of a shadow host, cached so every node in that tree shares the prefix. */
const hostPrefix = new WeakMap<ShadowRoot, string>();

/**
 * A selector unique within `root`, prefixed with the host's own path and
 * ` >>> ` when `root` is a shadow root. `querySelector` cannot cross shadow
 * boundaries, so the hop is explicit and `resolvePath()` walks it.
 */
function cssPath(el: Element, root: Root): string {
  const prefix = root instanceof ShadowRoot ? (hostPrefix.get(root) ?? '') : '';
  const direct = uniqueIdSelector(el, root);
  if (direct) return prefix + direct;

  const parts: string[] = [];
  let cur: Element | null = el;
  const top = root instanceof Document ? root.documentElement : null;

  while (cur && cur !== top && parts.length < MAX_PATH_SEGMENTS) {
    if (cur !== el) {
      const anchor = uniqueIdSelector(cur, root);
      if (anchor) {
        parts.unshift(anchor);
        return prefix + parts.join(' > ');
      }
    }
    const node: Element = cur;
    const tag = node.tagName.toLowerCase();
    // parentNode, not parentElement: a shadow root's direct children have a
    // parentNode (the root) but no parentElement, and their siblings still count.
    const parent = node.parentNode as ParentNode | null;
    if (!parent || parent === root) {
      const siblings = parent ? Array.from(parent.children).filter((c) => c.tagName === node.tagName) : [];
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    cur = node.parentElement;
  }
  return prefix + parts.join(' > ');
}
```

Replace the body of `captureDomSnapshot` from `const root = document.body ?? document.documentElement;` through the end of the `while (el)` loop with a recursive walk that visits an element, then its open shadow root, then its light-DOM children:

```ts
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let truncated = false;

  const visit = (el: Element, root: Root): void => {
    const tag = el.tagName.toLowerCase();
    const elRole = role(el, tag);
    const interactive = isInteractive(el, tag, elRole);
    const media = MEDIA_TAGS.has(tag) ? (tag as RawDomNode['media']) : null;
    const text = interactive || media ? '' : directText(el);

    // Cheap rejection first: nothing to say about this element at all.
    if (interactive || media || text) {
      const rect = el.getBoundingClientRect();
      const onScreen =
        rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < vh && rect.left < vw;

      if (onScreen) {
        // Only now do we pay for style resolution.
        const style = getComputedStyle(el);
        const shown =
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          parseFloat(style.opacity || '1') > 0;

        if (shown) {
          const inputType = tag === 'input' ? ((el as HTMLInputElement).type?.toLowerCase() ?? 'text') : null;
          const { value, omitted } = readValue(el, tag, inputType);

          nodes.push({
            path: cssPath(el, root),
            tag,
            role: elRole,
            label: accessibleName(el, tag),
            text: text || null,
            context_label: siblingLabel(el),
            value,
            value_omitted: omitted,
            input_type: inputType,
            attrs: {
              id: el.getAttribute('id'),
              name: el.getAttribute('name'),
              autocomplete: el.getAttribute('autocomplete'),
              placeholder: el.getAttribute('placeholder'),
              aria_label: el.getAttribute('aria-label'),
              alt: el.getAttribute('alt'),
              title: el.getAttribute('title'),
              inputmode: el.getAttribute('inputmode'),
              maxlength: el.getAttribute('maxlength'),
            },
            bbox: toBBox(rect),
            interactive,
            media,
          });
        }
      }
    }
  };

  const walk = (parent: Element | ShadowRoot, root: Root): void => {
    for (const child of Array.from(parent.children)) {
      if (truncated) return;
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue; // prunes the whole subtree — the cheapest possible win
      visit(child, root);
      if (nodes.length >= MAX_NODES) {
        truncated = true;
        return;
      }
      // Open shadow roots are part of what the user sees; closed ones are not
      // reachable and are a documented ceiling.
      const shadow = child.shadowRoot;
      if (shadow) {
        hostPrefix.set(shadow, cssPath(child, root) + SHADOW_SEP);
        walk(shadow, shadow);
      }
      walk(child, root);
    }
  };

  const body = document.body ?? document.documentElement;
  visit(body, document);
  walk(body, document);
```

Delete the old `const walker = document.createTreeWalker(...)` block and the `let el: Element | null = root; while (el) { ... }` loop entirely. Keep `MAX_NODES`, `MAX_PATH_SEGMENTS`, `SKIP_TAGS`, the `return { schema_version, ... }` at the end, and every helper (`role`, `accessibleName`, `siblingLabel`, `readValue`, `toBBox`, `isInteractive`, `directText`, `clip`, `isStableId`).

- [ ] **Step 2: Typecheck and run the capture harness**

Run: `cd extension && npm run typecheck && npm run test:capture`
Expected: typecheck clean; "input inside the open shadow root captured …" PASS, "all N paths resolve to exactly one element" PASS, email/name redacted PASS, button label kept PASS. The iframe checks still FAIL (Task 3).

- [ ] **Step 3: Run smoke on the three existing fixtures to prove nothing regressed**

Run: `cd extension && npm run smoke && npm run smoke -- ../eval/fixtures/kyc-form.html && npm run smoke -- ../eval/fixtures/edge-cases.html`
Expected: each prints `OK — every selector resolves uniquely, every bbox is well-formed.` with the same node counts as before (bank-login ≈ 30, kyc ≈ 60, edge-cases 11).

- [ ] **Step 4: Commit**

```bash
git add extension/src/capture/dom-snapshot.ts
git commit -m "capture: walk open shadow roots; paths carry ' >>> ' hops, uniqueness per root"
```

---

### Task 3: Iframes are captured and black-boxed as `frame`

**Files:**
- Modify: `extension/src/shared/schema.ts`
- Modify: `extension/src/capture/dom-snapshot.ts`
- Modify: `extension/src/redaction/build-request.ts`
- Modify: `server/app/schemas.py`
- Modify: `eval/corpus/annotation.schema.json`

**Interfaces:**
- Produces: `PiiType` includes `'frame'` (tier 1); `RawDomNode.media` includes `'iframe'`; manifest entries `{ type: 'frame', tier: 1, masking: 'blackbox', detector: 'capture:iframe', dom_path, bbox }`.

- [ ] **Step 1: Schema**

In `extension/src/shared/schema.ts`:

In `PiiType`, after `| 'face'` add:
```ts
  /** An iframe/embed whose contents the DOM walk cannot see. Not PII in itself — an unscanned region, masked because unscanned pixels are unproven pixels. */
  | 'frame'
```
In `TIER_BY_TYPE`, after `face: 1,` add `frame: 1,`.
Change `media: 'img' | 'video' | 'canvas' | 'svg' | 'picture' | null;` to
```ts
  media: 'img' | 'video' | 'canvas' | 'svg' | 'picture' | 'iframe' | null;
```

In `server/app/schemas.py` `PiiType` literal, after `"face",` add `"frame",`.

In `eval/corpus/annotation.schema.json`, in the `type` enum after `"face",` add `"frame",` (annotators may box a frame as `modality: "pixel"`).

- [ ] **Step 2: Capture**

In `extension/src/capture/dom-snapshot.ts`:

Add after `MEDIA_TAGS`:
```ts
/** Framed documents: their pixels are on screen, their DOM is not ours to walk. */
const FRAME_TAGS = new Set(['iframe', 'frame', 'object', 'embed']);
```
In `IMPLICIT_ROLE` add `iframe: 'frame', frame: 'frame', object: 'frame', embed: 'frame',`.
In `visit`, change the `media` line to:
```ts
    const media: RawDomNode['media'] = FRAME_TAGS.has(tag) ? 'iframe' : MEDIA_TAGS.has(tag) ? (tag as RawDomNode['media']) : null;
```

- [ ] **Step 3: Manifest entry + pixel mask**

In `extension/src/redaction/build-request.ts`, inside the `for (const node of snapshot.nodes)` loop, right after the `value_omitted === 'password'` block and before `domSummary.push(...)`, add:

```ts
    // A frame's contents were never walked, so nothing about them is proven
    // safe. The frame is declared and its pixels are filled; the node itself
    // stays in dom_summary so the model knows a frame is there.
    if (node.media === 'iframe') {
      manifest.push({
        id: tokens.idFor('frame', null, node.path),
        type: 'frame',
        tier: TIER_BY_TYPE.frame,
        bbox: node.bbox,
        dom_path: node.path,
        masking: 'blackbox',
        detector: 'capture:iframe',
        confidence: 1,
      });
    }
```
No other change: the existing `regions` mapping already fills every manifest entry with a bbox, and `redactScreenshot` fills non-blur regions black.

- [ ] **Step 4: Run the capture harness and the server tests**

Run: `cd extension && npm run typecheck && npm run test:capture`
Expected: PASS — all iframe checks green, including "iframe pixels are black".

Run: `cd server && uv run pytest -q`
Expected: `31 passed`.

- [ ] **Step 5: Commit**

```bash
git add extension/src/shared/schema.ts extension/src/capture/dom-snapshot.ts extension/src/redaction/build-request.ts server/app/schemas.py eval/corpus/annotation.schema.json
git commit -m "capture: iframes are captured as frames and black-boxed; 'frame' joins the taxonomy as Tier 1"
```

---

### Task 4: `account_id` (Tier 2)

**Files:**
- Modify: `extension/src/shared/schema.ts`
- Modify: `extension/src/pii-detection/dom-heuristics.ts`
- Modify: `server/app/schemas.py`
- Modify: `eval/corpus/annotation.schema.json`
- Modify: `extension/scripts/fixtures.spec.mjs`
- Modify: `eval/corpus/labels/bank-login-01.labels.json`, `eval/corpus/labels/kyc-form-01.labels.json`

**Interfaces:**
- Produces: `PiiType` includes `'account_id'` (tier 2, masking `token`, tokens `[ACCOUNT_ID_n]` — the token id derives from `type.toUpperCase()` in `tokens.ts`, nothing to add there).

- [ ] **Step 1: Flip the expectations first (red)**

In `extension/scripts/fixtures.spec.mjs`:

bank-login: add `['customer id', 'MB4470193'],` to `mustNotAppear`; add `'account_id'` to `manifestTypes`; add `['customer id field', 'input#customer-id'],` to `redactedFields`; delete the `knownGaps` array from this fixture entirely.

kyc-form: add `['customer reference', 'SU-2019-884210'],` to `mustNotAppear`; add `'account_id'` to `manifestTypes`; add `['customer reference cell', 'td#cust-ref'],` to `redactedFields`; in `knownGaps` delete the `customer reference` entry (keep the two prose entries).

Run: `cd extension && npm run test:redaction`
Expected: FAIL — `customer id — "MB4470193" IS PRESENT`, `account_id missing from the manifest`, and the kyc equivalents.

- [ ] **Step 2: Schema + rule**

`extension/src/shared/schema.ts`: in `PiiType` after `| 'date_of_birth'` add
```ts
  /** A service-specific identifier: customer/member/policy/reference numbers, usernames. Identifying, not secret. */
  | 'account_id'
```
and in `TIER_BY_TYPE` add `account_id: 2,`.

`server/app/schemas.py` `PiiType`: after `"date_of_birth",` add `"account_id",`.
`eval/corpus/annotation.schema.json` type enum: after `"date_of_birth"` add `, "account_id"`.

`extension/src/pii-detection/dom-heuristics.ts`: append to `DOM_RULES`:
```ts
  {
    type: 'account_id',
    detector: 'dom:account-id',
    confidence: 0.85,
    // "account number" also matches here, but bank_account is Tier 1 and
    // `better()` prefers the lower tier, so this only wins where no Tier-1
    // rule fires: customer ids, member numbers, usernames, reference numbers.
    test: (n, c) =>
      /(^|\s)username($|\s)/.test(ac(n)) ||
      /\b(customer|member(ship)?|subscriber|policy|client|user|login|account)[ -_]?(id|number|no|handle)\b|\breference[ -_]?(number|no|id)\b|\bcust(omer)?[ -_]?ref(erence)?\b|\bcrn\b|\buser[ -_]?name\b/.test(c),
  },
```

- [ ] **Step 3: Corpus labels**

`eval/corpus/labels/bank-login-01.labels.json`: replace the `notes` value with `"Every planted value is annotated. The customer ID is a Tier-2 account_id: identifying, not secret."` and append to `items`:
```json
    { "id": "a9", "selector": "input#customer-id", "type": "account_id", "tier": 2, "modality": "text", "value_present": true,
      "notes": "Service-specific identifier. Named only by its label and autocomplete=username." }
```
`eval/corpus/labels/kyc-form-01.labels.json`: replace the `notes` value with `"The four prose items in p#agent-note are annotated at their exact text ranges, which is where this build's node-granular pixel geometry is expected to cost redaction precision."` and append:
```json
    { "id": "b17", "selector": "td#cust-ref", "type": "account_id", "tier": 2, "modality": "text", "value_present": true,
      "notes": "Named only by the adjacent <th>Customer reference</th>." }
```
(Keep valid JSON: add a comma after the previous last item.)

- [ ] **Step 4: Verify**

Run: `cd extension && npm run typecheck && npm run test:redaction && npm run test:capture`
Expected: all PASS; the gap lines for customer id / customer reference are gone.

Run (repo root): `node eval/measure_labels.mjs && node eval/predict.mjs && python3 eval/run_eval.py`
Expected: `3 screen(s) · 31 labelled item(s)`; `account_id 2 0 0 1.000 1.000 1.000`; Tier-1 recall 1.000; the only FNs remain kyc b13/b14 (prose).

Run: `cd server && uv run pytest -q` → `31 passed`.

- [ ] **Step 5: Commit**

```bash
git add extension/src/shared/schema.ts extension/src/pii-detection/dom-heuristics.ts server/app/schemas.py eval/corpus/annotation.schema.json extension/scripts/fixtures.spec.mjs eval/corpus/labels eval/corpus/screens
git commit -m "detect: account_id (Tier 2) for customer/member/reference ids and usernames; corpus annotated"
```

---

### Task 5: Node budget and `truncated` on the wire

**Files:**
- Modify: `extension/src/capture/dom-snapshot.ts`
- Modify: `extension/src/shared/schema.ts`
- Modify: `extension/src/redaction/build-request.ts`
- Modify: `server/app/schemas.py`
- Modify: `extension/scripts/test-capture.mjs`

**Interfaces:**
- Produces: `AgentRequest.truncated: boolean`. `captureDomSnapshot()` collects up to `HARD_WALK_LIMIT` (2500) candidates, then keeps ≤ `MAX_NODES` (800): every `interactive` or `media` node first, then text nodes in document order.

- [ ] **Step 1: Test (red)**

Create `eval/fixtures/long-page.html`:
```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Long page</title>
<style>body{margin:0;font:12px/1.3 system-ui;columns:6;padding:8px} p{margin:0 0 2px} button{display:block;font-size:11px}</style></head>
<body>
<script>
  // 1200 visible text nodes and 60 buttons, the buttons LAST in document order.
  for (let i = 0; i < 1200; i++) { const p = document.createElement('p'); p.textContent = 'Line ' + i; document.body.appendChild(p); }
  for (let i = 0; i < 60; i++) { const b = document.createElement('button'); b.id = 'act-' + i; b.textContent = 'Action ' + i; document.body.appendChild(b); }
</script>
</body></html>
```
Append to `extension/scripts/test-capture.mjs`, inside the `try` after the iframe block, a second navigation:

```js
  console.log('\nnode budget (long-page.html):');
  await call('Page.navigate', { url: `file://${resolve('../eval/fixtures/long-page.html')}` });
  for (let i = 0; i < 40; i++) { await sleep(150); if ((await evaluate('document.readyState')) === 'complete' && (await evaluate('location.href')).includes('long-page')) break; }
  await evaluate(bundle);
  const long = JSON.parse(await evaluate(`ATHENA.run(null).then((x) => JSON.stringify(x))`));
  const buttons = long.nodes.filter((n) => n.tag === 'button').length;
  if (long.truncated) pass(`snapshot reports truncated=true with ${long.nodes.length} nodes`);
  else fail(`expected truncation on a 1260-node page, got ${long.nodes.length} nodes and truncated=${long.truncated}`);
  if (long.nodes.length <= 800) pass('node count within the 800 budget');
  else fail(`${long.nodes.length} nodes exceeds the budget`);
  if (buttons === 60) pass('all 60 buttons kept despite being last in document order');
  else fail(`only ${buttons} of 60 buttons survived the budget`);
  if (long.request.truncated === true) pass('truncated is on the wire');
  else fail('AgentRequest.truncated missing or false');
```
(`ATHENA.run(null)` — the entry already accepts a null screenshot; `buildAgentRequest` handles `screenshotDataUrl: null`.)

Run: `cd extension && npm run test:capture`
Expected: FAIL on "only N of 60 buttons survived" and "AgentRequest.truncated missing".

- [ ] **Step 2: Implement**

`extension/src/capture/dom-snapshot.ts`: change `const MAX_NODES = 400;` to
```ts
/** What is sent. Snapshots that needed trimming are flagged `truncated`. */
const MAX_NODES = 800;
/** What is walked before giving up; bounds the getComputedStyle cost on pathological pages. */
const HARD_WALK_LIMIT = 2500;
```
In `walk`, replace `if (nodes.length >= MAX_NODES) { truncated = true; return; }` with `if (nodes.length >= HARD_WALK_LIMIT) { truncated = true; return; }`.

After the walk (after `walk(body, document);`), before the `return`, add:
```ts
  // Interactive and media nodes are what the agent acts on and what the face
  // detector scans; on an oversized page they must survive the cut even when
  // they sit at the bottom of the document.
  let kept = nodes;
  if (nodes.length > MAX_NODES) {
    truncated = true;
    const priority = nodes.filter((n) => n.interactive || n.media);
    const rest = nodes.filter((n) => !(n.interactive || n.media));
    kept = [...priority, ...rest.slice(0, Math.max(0, MAX_NODES - priority.length))].slice(0, MAX_NODES);
    kept.sort((a, b) => nodes.indexOf(a) - nodes.indexOf(b)); // back to document order
  }
```
and use `nodes: kept,` in the returned object. (Sorting by `indexOf` is O(n²) at n ≤ 2500 — fine, and documented by the comment.)

`extension/src/shared/schema.ts`: in `AgentRequest` add after `prior_actions: AgentAction[];`
```ts
  /** True when the snapshot hit the node budget: the model sees a partial page. */
  truncated: boolean;
```
`extension/src/redaction/build-request.ts`: in the `const request: AgentRequest = {` literal add `truncated: snapshot.truncated,`.
`server/app/schemas.py` `AgentRequest`: add `truncated: bool = False`.

- [ ] **Step 3: Verify**

Run: `cd extension && npm run typecheck && npm run test:capture && npm run test:redaction`
Expected: PASS.
Run: `cd server && uv run pytest -q` → `31 passed`.

- [ ] **Step 4: Commit**

```bash
git add extension/src/capture/dom-snapshot.ts extension/src/shared/schema.ts extension/src/redaction/build-request.ts server/app/schemas.py extension/scripts/test-capture.mjs eval/fixtures/long-page.html
git commit -m "capture: 800-node budget keeps every interactive node; truncated is on the wire"
```

---

### Task 6: Every consumer resolves paths through `resolvePath`

**Files:**
- Modify: `extension/src/executor/execute.ts`
- Modify: `extension/scripts/smoke-capture.mjs`
- Modify: `eval/measure_labels.mjs`

- [ ] **Step 1: Executor**

In `extension/src/executor/execute.ts` add `import { resolvePath } from '../shared/resolve-path';` and replace `findOne`:
```ts
function findOne(selector: string): Element {
  const matches = resolvePath(selector);
  if (matches.length === 0) throw new Error(`No element matches ${selector}`);
  if (matches.length > 1) throw new Error(`${matches.length} elements match ${selector} — refusing to guess`);
  return matches[0]!;
}
```
(`resolvePath` returns `[]` for an invalid selector, so the "not valid CSS" branch collapses into "No element matches".)

- [ ] **Step 2: Smoke**

In `extension/scripts/smoke-capture.mjs`, change the esbuild entry so the bundle exports both symbols: replace `entryPoints: ['src/capture/dom-snapshot.ts'],` with a generated entry:
```js
const entry = join(workdir, 'entry.ts');
await writeFile(entry, `
export { captureDomSnapshot } from '${resolve('src/capture/dom-snapshot.ts')}';
export { resolvePath } from '${resolve('src/shared/resolve-path.ts')}';
`);
```
(add `writeFile` to the `node:fs/promises` import) and `entryPoints: [entry],`. In the in-page report, replace
`try { count = document.querySelectorAll(n.path).length; } catch { count = -2; }` with
`count = ATHENA.resolvePath(n.path).length;`.

- [ ] **Step 3: measure_labels**

In `eval/measure_labels.mjs`: build the resolver once (esbuild borrowed from the extension, exactly as `predict.mjs` does):
```js
import { createRequire } from 'node:module';
const EXT = resolve(HERE, '../extension');
const { build } = createRequire(join(EXT, 'package.json'))('esbuild');
const resolverDir = await mkdtemp(join(tmpdir(), 'athena-resolver-'));
await build({
  stdin: { contents: `export { resolvePath } from '${join(EXT, 'src/shared/resolve-path.ts')}';`, resolveDir: EXT, loader: 'ts' },
  outfile: join(resolverDir, 'resolver.js'), bundle: true, format: 'iife', globalName: 'ATHENA_RESOLVE', target: 'chrome116', logLevel: 'error',
});
const resolver = await readFile(join(resolverDir, 'resolver.js'), 'utf8');
```
After each `Page.navigate` + readiness loop, `await evaluate(resolver);`. In `MEASURE`, replace `const el = document.querySelector(spec.selector);` with
```js
  const found = ATHENA_RESOLVE.resolvePath(spec.selector);
  if (found.length !== 1) return { error: 'selector matched ' + found.length + ' elements: ' + spec.selector };
  const el = found[0];
```
Remove `resolverDir` in the `finally` (`await rm(resolverDir, ...)`). `shared/resolve-path.ts` imports nothing from `pii-detection` or `redaction`, so the corpus README's independence rule still holds — add one sentence to `eval/corpus/README.md` under "Ground truth must never be derived from the detectors": `Selectors may use ` >>> ` to reach into open shadow roots; they are resolved with `extension/src/shared/resolve-path.ts`, which contains no detection logic.`

- [ ] **Step 4: Verify**

Run: `cd extension && npm run typecheck && npm run smoke && npm run smoke -- ../eval/fixtures/shadow-iframe.html && npm run test:e2e`
Expected: smoke OK on both (shadow-iframe shows a ` >>> ` path in a unique-resolution run); e2e PASS (executor unchanged in behaviour).
Run: `node eval/measure_labels.mjs` → `OK`.

- [ ] **Step 5: Commit**

```bash
git add extension/src/executor/execute.ts extension/scripts/smoke-capture.mjs eval/measure_labels.mjs eval/corpus/README.md
git commit -m "capture: executor, smoke and the corpus measurer resolve paths through resolvePath"
```

---

### Task 7: Per-site permissions

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/src/background/service-worker.ts`
- Modify: `extension/src/sidebar/sidebar.html`
- Modify: `extension/src/sidebar/sidebar.ts`

**Interfaces:**
- Produces: `chrome.permissions` is the source of truth. Origin pattern for a URL: `new URL(url).origin + '/*'`.

- [ ] **Step 1: Manifest**

In `extension/manifest.json`, after the `"host_permissions"` array add:
```json
  "optional_host_permissions": [
    "https://*/*",
    "http://*/*"
  ],
```

- [ ] **Step 2: Worker error copy**

In `extension/src/background/service-worker.ts` `runCapture`, replace the `tab.url === undefined` error message with:
```ts
      'ATHENA has no access to this tab. Click the ATHENA toolbar icon on the page (one-off), or enable ATHENA on the site from the panel (persistent).',
```
No other worker change: with a granted host permission, `scripting.executeScript` and `tabs.captureVisibleTab` already work; with `activeTab` they work as before.

- [ ] **Step 3: Panel control**

In `extension/src/sidebar/sidebar.html`, inside the "Current page" card, after the `<div class="row status-line" id="page-status">…</div>` line add:
```html
          <div class="row" style="margin-top:8px;">
            <button id="site-access" class="btn sec sm" type="button" hidden>Enable on this site</button>
            <span class="t3" id="site-access-note"></span>
          </div>
```

In `extension/src/sidebar/sidebar.ts`:

Add after the `let currentPageLabel = …` declarations:
```ts
/** Origin pattern for chrome.permissions; null when the tab has no readable URL. */
let currentOriginPattern: string | null = null;
```
Add a helper next to `updatePill`:
```ts
async function renderSiteAccess(url: string | undefined): Promise<void> {
  const button = $<HTMLButtonElement>('site-access');
  const note = $('site-access-note');
  currentOriginPattern = null;
  if (!url || isRestrictedUrl(url)) { button.hidden = true; note.textContent = ''; return; }
  let origin: string;
  try { origin = new URL(url).origin; } catch { button.hidden = true; note.textContent = ''; return; }
  if (!/^https?:$/.test(new URL(url).protocol)) { button.hidden = true; note.textContent = ''; return; }
  currentOriginPattern = `${origin}/*`;
  const granted = await api.permissions.contains({ origins: [currentOriginPattern] });
  button.hidden = false;
  button.textContent = granted ? 'Disable on this site' : 'Enable on this site';
  note.textContent = granted
    ? `Enabled on ${new URL(url).host} — captures work here without clicking the icon.`
    : 'One-off access only. Enable to keep working here across navigations.';
}
```
In `refreshPageContext`, after the `show(...)` call at the end (the granted path), add `void renderSiteAccess(tab.url);`; in the `!tab`, `tab.url === undefined` and `isRestrictedUrl` branches add `void renderSiteAccess(undefined);` before each `return`.

Add the click handler with the other event handlers:
```ts
$('site-access').addEventListener('click', async () => {
  if (!currentOriginPattern) return;
  const granted = await api.permissions.contains({ origins: [currentOriginPattern] });
  try {
    if (granted) {
      await api.permissions.remove({ origins: [currentOriginPattern] });
      note(`Disabled on ${currentOriginPattern}`, 'info');
    } else {
      // Must run directly from the click: chrome.permissions.request needs a user gesture.
      const ok = await api.permissions.request({ origins: [currentOriginPattern] });
      note(ok ? `Enabled on ${currentOriginPattern}` : 'Permission request declined', ok ? 'ok' : 'warn');
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), true);
  }
  await refreshPageContext();
});
```

- [ ] **Step 4: Build and verify in a real Chrome**

Run: `cd extension && npm run typecheck && npm run build`
Expected: clean; `dist/manifest.json` contains `optional_host_permissions`.

Manual check (do it; it is the acceptance for this task): load `extension/dist` unpacked in Chrome, open `https://example.com`, click the ATHENA icon → panel shows **Enable on this site**; click it → Chrome's permission prompt → Allow → button reads **Disable on this site** and the note says "Enabled on example.com". Reload the page (do NOT click the icon) → **Analyze page safely** captures successfully. Click **Disable on this site** → reload → Analyze fails with the "no access" message until the icon is clicked. Record the outcome in the task report.

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json extension/src/background/service-worker.ts extension/src/sidebar/sidebar.html extension/src/sidebar/sidebar.ts
git commit -m "permissions: per-site enable/disable from the panel via optional_host_permissions"
```

---

### Task 8: Docs, eval regeneration, full harness

**Files:**
- Modify: `README.md`, `HANDOFF.md`, `CLAUDE.md`

- [ ] **Step 1: README**

In "Using it", replace the paragraph beginning `` `activeTab` is granted per tab when you click the icon `` with:
```
Clicking the icon grants one-off access to that tab. **Enable on this site** in the
page card grants ATHENA the site persistently (`optional_host_permissions`), so
captures keep working across reloads and navigations there; **Disable** revokes
it. Nothing is granted on sites you have not enabled.
```
In "Tests", add `npm run test:capture      # shadow DOM paths resolve, iframes are black-boxed, node budget keeps interactive nodes` after the `smoke` line.
In "Limitations", replace item 4 (pixel geometry) with itself plus two new items appended to the list:
```
10. **Closed shadow roots are invisible.** They cannot be told apart from empty
    custom elements, so their pixels are not masked. Open shadow roots are walked.
11. **Frames are masked, not read.** An iframe's contents are black-boxed in the
    screenshot and declared as a `frame`; same-origin frames are not walked.
```
Update the Results block with the numbers from `python3 eval/run_eval.py` (3 screens, 31 items).

- [ ] **Step 2: HANDOFF**

In §4 table, `capture/dom-snapshot.ts` row: append ` Walks open shadow roots (paths carry ` >>> `, resolved only by `shared/resolve-path.ts`); iframes captured as `frame` and black-boxed; 800-node budget keeps every interactive node and sets `truncated`.` In §9 delete gap #3 (customer identifiers) and gap #9 (panel can only inspect the invoked tab), renumbering the rest. Update the Results numbers in §7 as in the README.

- [ ] **Step 3: CLAUDE.md**

Under "PII detection & redaction", append a bullet:
```
- Two types exist beyond PRD §4.3's examples: `frame` (Tier 1 — an iframe whose
  contents were never walked; the region is black-boxed and declared) and
  `account_id` (Tier 2 — customer/member/reference ids, usernames; tokenised).
  Snapshot paths may contain ` >>> ` for open shadow roots; resolve them only
  through `shared/resolve-path.ts`, never with a bare `querySelector`.
```

- [ ] **Step 4: Full harness**

Run from `extension/`: `npm run typecheck && npm run build && npm run smoke && npm run test:capture && npm run test:redaction && npm run test:faces && npm run test:scenario-b && npm run test:e2e && npm run preview:viewer`
Then from the root: `node eval/measure_labels.mjs && node eval/predict.mjs && python3 eval/run_eval.py && node eval/latency_stages.mjs 10 && python3 eval/latency_bench.py`
Then `cd server && uv run pytest -q`.
Expected: every command exits 0; eval targets PASS; `31 passed`. Paste the eval table and latency totals into the task report.

- [ ] **Step 5: Commit**

```bash
git add README.md HANDOFF.md CLAUDE.md eval/corpus/screens
git commit -m "docs: any-site capture — per-site enable, shadow DOM, frames, account_id; numbers regenerated"
```

---

## Self-review

- Spec coverage: permissions (T7), shadow DOM + `resolvePath` everywhere (T1, T2, T6), iframes as `frame` (T3), `account_id` + corpus flips (T4), node budget + `truncated` (T5), tests/acceptance (T1 harness, T5 addition, T8 full run), docs (T8). Closed-shadow ceiling documented (T8).
- Placeholders: none; every code step shows the code.
- Type consistency: `resolvePath(path, root?) → Element[]` and `SHADOW_SEP` used identically in T1/T2/T6; `media: 'iframe'` in T3 matches `RawDomNode['media']`; `TIER_BY_TYPE.frame` used in T3 after being defined there; `truncated` field name identical in T5 across schema/build-request/schemas.py/harness.
