/**
 * Turns hand-authored labels into corpus annotations with measured geometry.
 *
 * The separation matters: `corpus/labels/*.labels.json` says WHAT is sensitive
 * and WHERE by CSS selector — that is the human judgement, written without
 * reference to any detector. This script only measures, resolving each selector
 * (or text range) to a bounding box in the browser and capturing the screenshot.
 *
 * Nothing in the detection pipeline is imported here. If ground truth were
 * derived from the detectors, the eval would be measuring the detectors against
 * themselves and every number would be a 1.0.
 *
 * Output is the documented corpus format (corpus/README.md), so hand-annotated
 * screens from a human annotator drop into the same directory and score
 * identically.
 *
 * Usage:  node eval/measure_labels.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LABELS_DIR = join(HERE, 'corpus/labels');
const SCREENS_DIR = join(HERE, 'corpus/screens');
const CHROME = process.env.ATHENA_CHROME ?? 'google-chrome-stable';
const CDP_PORT = Number(process.env.ATHENA_CDP_PORT ?? 9340);

/** The corpus viewport, fixed so every bbox is comparable across screens. */
const VIEWPORT = { width: 1280, height: 800 };

const MEASURE = `(spec) => {
  const el = document.querySelector(spec.selector);
  if (!el) return { error: 'selector matched nothing: ' + spec.selector };

  if (!spec.text) {
    const r = el.getBoundingClientRect();
    return { bbox: [r.left, r.top, r.right, r.bottom] };
  }

  // A labelled substring inside prose: measure the text range itself, not the
  // paragraph. This is the geometry a human annotator would draw, and it is
  // deliberately tighter than what a node-granular detector can produce.
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const idx = n.nodeValue.replace(/\\s+/g, ' ').indexOf(spec.text);
    const raw = n.nodeValue.indexOf(spec.text.split(/\\s+/)[0]);
    if (idx === -1 && raw === -1) continue;

    // Re-find against the raw node text, tolerating collapsed whitespace.
    const pattern = spec.text.split(/\\s+/).map((w) => w.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')).join('\\\\s+');
    const m = new RegExp(pattern).exec(n.nodeValue);
    if (!m) continue;

    const range = document.createRange();
    range.setStart(n, m.index);
    range.setEnd(n, m.index + m[0].length);
    const rects = [...range.getClientRects()];
    if (rects.length === 0) continue;
    const bbox = [
      Math.min(...rects.map((r) => r.left)),
      Math.min(...rects.map((r) => r.top)),
      Math.max(...rects.map((r) => r.right)),
      Math.max(...rects.map((r) => r.bottom)),
    ];
    return { bbox, lines: rects.length };
  }
  return { error: 'text not found in ' + spec.selector + ': ' + spec.text };
}`;

const profile = await mkdtemp(join(tmpdir(), 'athena-measure-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--user-data-dir=${join(profile, 'p')}`, 'about:blank',
], { stdio: 'ignore' });

let socket;
let problems = 0;

try {
  await mkdir(SCREENS_DIR, { recursive: true });

  let pages = [];
  for (let i = 0; i < 60 && pages.length === 0; i++) {
    try { pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter((t) => t.type === 'page'); } catch {}
    if (pages.length === 0) await sleep(250);
  }
  if (pages.length === 0) throw new Error('No Chrome page target');

  socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((ok, no) => { socket.onopen = ok; socket.onerror = () => no(new Error('CDP connect failed')); });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const call = (method, params) => {
    const id = ++nextId;
    return new Promise((ok) => { pending.set(id, ok); socket.send(JSON.stringify({ id, method, params })); });
  };
  const evaluate = async (expression) => {
    const reply = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails, null, 2));
    return reply.result?.result?.value;
  };

  const files = (await readdir(LABELS_DIR)).filter((f) => f.endsWith('.labels.json')).sort();
  for (const file of files) {
    const spec = JSON.parse(await readFile(join(LABELS_DIR, file), 'utf8'));
    const page = resolve(HERE, spec.page);
    console.log(`\n${spec.screen_id}  <-  ${spec.page}`);

    await call('Page.navigate', { url: `file://${page}` });
    for (let i = 0; i < 50; i++) {
      await sleep(150);
      if ((await evaluate('document.readyState')) === 'complete' && (await evaluate('location.protocol')) === 'file:') break;
    }
    await sleep(350); // let fonts and background images settle before measuring

    const viewport = await evaluate('JSON.stringify({width: innerWidth, height: innerHeight})');
    const annotations = [];
    for (const item of spec.items) {
      const measured = JSON.parse(
        await evaluate(`JSON.stringify((${MEASURE})(${JSON.stringify(item)}))`),
      );
      if (measured.error) {
        console.error(`  FAIL ${item.id}: ${measured.error}`);
        problems++;
        continue;
      }
      const bbox = measured.bbox.map((v) => Math.round(v * 100) / 100);
      const annotation = {
        id: item.id,
        type: item.type,
        tier: item.tier,
        modality: item.modality,
        bbox,
        dom_path: item.selector,
        value_present: item.value_present ?? true,
      };
      if (item.notes) annotation.notes = item.notes;
      if (item.text) {
        annotation.notes = `${annotation.notes ? annotation.notes + ' ' : ''}Measured as a text range inside ${item.selector}${measured.lines > 1 ? ` across ${measured.lines} lines` : ''}.`;
      }
      annotations.push(annotation);
      const w = Math.round(bbox[2] - bbox[0]);
      const h = Math.round(bbox[3] - bbox[1]);
      console.log(`  ok   ${item.id.padEnd(4)} ${item.type.padEnd(14)} T${item.tier}  ${w}x${h} @ ${Math.round(bbox[0])},${Math.round(bbox[1])}`);
    }

    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(SCREENS_DIR, `${spec.screen_id}.png`), Buffer.from(screenshot.result.data, 'base64'));

    const record = {
      screen_id: spec.screen_id,
      source: spec.source,
      page_url: spec.page,
      viewport: { ...JSON.parse(viewport), device_pixel_ratio: 1 },
      annotator: spec.annotator,
      notes: spec.notes,
      annotations,
    };
    await writeFile(join(SCREENS_DIR, `${spec.screen_id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`  wrote corpus/screens/${spec.screen_id}.json (+ .png)`);
  }
} catch (err) {
  console.error(`FAIL ${err.message}`);
  problems++;
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
  await sleep(150);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log(problems === 0 ? '\nOK' : `\nFAIL — ${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
